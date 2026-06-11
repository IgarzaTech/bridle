import { BridleGuard, canonicalIdentityMessage } from '../guard';
import { InMemoryStorage } from '../in-memory-storage';
import { Secp256k1SignatureVerifier } from '../secp256k1-verifier';
import type { SignatureVerifier } from '../signature-verifier';
import type { AgentBudgetRecord, BridleConfig, IdentityProof } from '../types';
import {
  AmountExceedsPerTxLimitError,
  BudgetExceededError,
  BudgetPolicyNotConfiguredError,
  ConfigurationError,
  IdentityMismatchError,
  InvalidAmountError,
  NonceAlreadyUsedError,
  NonceTooOldError,
  ReservationConflictError,
} from '../errors';
import { addressFromPrivateKey, signEip191, testPrivateKey } from './signing-helpers';

const AGENT = '0x1111111111111111111111111111111111111111';
const CUR = 'USDC';

const dummyVerifier: SignatureVerifier = { recover: () => Promise.resolve('0x0') };

function budget(overrides: Partial<AgentBudgetRecord> = {}): AgentBudgetRecord {
  return {
    agentAddress: AGENT,
    currency: CUR,
    windowDurationSeconds: 3600,
    maxAmountPerWindow: '1.00',
    maxAmountPerTx: null,
    unlimited: false,
    ...overrides,
  };
}

function makeGuard(
  storage: InMemoryStorage,
  config: BridleConfig = {},
  verifier: SignatureVerifier = dummyVerifier,
): BridleGuard {
  return new BridleGuard({ storage, signatureVerifier: verifier, config });
}

describe('BridleGuard.checkAndReserve (AC-4, AC-10)', () => {
  it('ciclo feliz: reserva → commit, refleja gasto en la ventana', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget({ maxAmountPerWindow: '5.00' }));
    const g = makeGuard(s);

    await g.checkAndReserve({ reservationId: 'r1', agentAddress: AGENT, amount: '2.00', currency: CUR });
    expect(s.getLedgerEntry('r1')?.status).toBe('reserved');

    await g.commit('r1');
    expect(s.getLedgerEntry('r1')?.status).toBe('committed');
  });

  it('DENY por exceder la ventana → BudgetExceededError con retryAfterSeconds', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget({ maxAmountPerWindow: '1.00', windowDurationSeconds: 3600 }));
    const g = makeGuard(s);

    await g.checkAndReserve({ reservationId: 'r1', agentAddress: AGENT, amount: '1.00', currency: CUR });
    await expect(
      g.checkAndReserve({ reservationId: 'r2', agentAddress: AGENT, amount: '0.01', currency: CUR }),
    ).rejects.toMatchObject({ code: 'budget_exceeded', retryAfterSeconds: 3600 });
  });

  it('DENY por exceder maxAmountPerTx', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget({ maxAmountPerWindow: '100.00', maxAmountPerTx: '5.00' }));
    const g = makeGuard(s);
    await expect(
      g.checkAndReserve({ reservationId: 'r1', agentAddress: AGENT, amount: '5.01', currency: CUR }),
    ).rejects.toBeInstanceOf(AmountExceedsPerTxLimitError);
  });

  it('fail-safe: sin política ni default budget → BudgetPolicyNotConfiguredError', async () => {
    const s = new InMemoryStorage();
    const g = makeGuard(s, {}); // sin defaultBudget
    await expect(
      g.checkAndReserve({ reservationId: 'r1', agentAddress: AGENT, amount: '0.01', currency: CUR }),
    ).rejects.toBeInstanceOf(BudgetPolicyNotConfiguredError);
  });

  it('unlimited → ALLOW sin crear entrada en el ledger', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget({ unlimited: true }));
    const g = makeGuard(s);
    await g.checkAndReserve({ reservationId: 'r1', agentAddress: AGENT, amount: '999999.00', currency: CUR });
    expect(s.getLedgerEntry('r1')).toBeUndefined();
  });

  it('default budget aplica a un agente sin fila propia', async () => {
    const s = new InMemoryStorage();
    const g = makeGuard(s, { defaultBudget: { maxAmountPerWindow: '1.00', windowDurationSeconds: 3600 } });
    await g.checkAndReserve({ reservationId: 'r1', agentAddress: AGENT, amount: '1.00', currency: CUR });
    await expect(
      g.checkAndReserve({ reservationId: 'r2', agentAddress: AGENT, amount: '0.01', currency: CUR }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('release libera la reserva: la ventana posterior no la cuenta', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget({ maxAmountPerWindow: '1.00' }));
    const g = makeGuard(s);

    await g.checkAndReserve({ reservationId: 'r1', agentAddress: AGENT, amount: '1.00', currency: CUR });
    await g.release('r1');
    // r1 liberada → hay espacio de nuevo
    await g.checkAndReserve({ reservationId: 'r2', agentAddress: AGENT, amount: '1.00', currency: CUR });
    expect(s.getLedgerEntry('r2')?.status).toBe('reserved');
  });

  it('monto inválido → InvalidAmountError', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget());
    const g = makeGuard(s);
    await expect(
      g.checkAndReserve({ reservationId: 'r1', agentAddress: AGENT, amount: '0.1234567', currency: CUR }),
    ).rejects.toBeInstanceOf(InvalidAmountError);
  });

  it('reservationId duplicado → ReservationConflictError (no sobrescribe en silencio)', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget({ maxAmountPerWindow: '100.00' }));
    const g = makeGuard(s);
    await g.checkAndReserve({ reservationId: 'dup', agentAddress: AGENT, amount: '1.00', currency: CUR });
    await expect(
      g.checkAndReserve({ reservationId: 'dup', agentAddress: AGENT, amount: '1.00', currency: CUR }),
    ).rejects.toBeInstanceOf(ReservationConflictError);
  });
});

describe('BridleGuard — máquina de estados del ledger (AC-7 paridad)', () => {
  it('carrera commit-vs-release: release primero, commit después → committed', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget());
    const g = makeGuard(s);
    await g.checkAndReserve({ reservationId: 'r1', agentAddress: AGENT, amount: '0.50', currency: CUR });
    await g.release('r1');
    await g.commit('r1'); // released → committed (el gasto es real)
    expect(s.getLedgerEntry('r1')?.status).toBe('committed');
  });

  it('caveat finalidad: released→committed cuenta como GASTO REAL en la ventana', async () => {
    // Comportamiento intencional: si el settlement liquida tarde (tras el release de
    // expiración), el commit re-registra el gasto. Por eso el TTL de la reserva debe
    // superar el peor caso de finalidad — si no, este commit tardío puede empujar la
    // ventana por encima del límite transitoriamente. Aquí fijamos que el gasto cuenta.
    const s = new InMemoryStorage();
    s.setBudget(budget({ maxAmountPerWindow: '1.00' }));
    const g = makeGuard(s);

    await g.checkAndReserve({ reservationId: 'r1', agentAddress: AGENT, amount: '1.00', currency: CUR });
    await g.release('r1');     // liberada (p.ej. expiró)
    await g.commit('r1');      // pero el pago liquidó tarde → vuelve a ser gasto real

    // El gasto cuenta: una nueva reserva por encima del límite se deniega.
    await expect(
      g.checkAndReserve({ reservationId: 'r2', agentAddress: AGENT, amount: '0.01', currency: CUR }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('commit en entry committed → no-op', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget());
    const g = makeGuard(s);
    await g.checkAndReserve({ reservationId: 'r1', agentAddress: AGENT, amount: '0.50', currency: CUR });
    await g.commit('r1');
    await g.commit('r1');
    expect(s.getLedgerEntry('r1')?.status).toBe('committed');
  });

  it('release en entry committed → no-op (no se revierte un gasto real)', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget());
    const g = makeGuard(s);
    await g.checkAndReserve({ reservationId: 'r1', agentAddress: AGENT, amount: '0.50', currency: CUR });
    await g.commit('r1');
    await g.release('r1');
    expect(s.getLedgerEntry('r1')?.status).toBe('committed');
  });
});

describe('BridleGuard.verifyAndConsumeNonce (AC-5 identidad / anti-DoS)', () => {
  const verifier = new Secp256k1SignatureVerifier();
  const pk = testPrivateKey(42);
  const agentAddress = addressFromPrivateKey(pk);

  function proof(overrides: Partial<IdentityProof> = {}): IdentityProof {
    const nonceTimestamp = Math.floor(Date.now() / 1000);
    const nonce = `nonce-${Math.random().toString(36).slice(2)}`;
    const base = { agentAddress, nonce, nonceTimestamp };
    const merged = { ...base, ...overrides };
    const message = canonicalIdentityMessage(merged.agentAddress, merged.nonce, merged.nonceTimestamp);
    return { ...merged, signature: overrides.signature ?? signEip191(pk, message) };
  }

  it('ciclo feliz: firma válida + nonce fresco → consume', async () => {
    const s = new InMemoryStorage();
    const g = makeGuard(s, {}, verifier);
    await expect(g.verifyAndConsumeNonce(proof())).resolves.toBeUndefined();
  });

  it('firma de otra clave → IdentityMismatchError', async () => {
    const s = new InMemoryStorage();
    const g = makeGuard(s, {}, verifier);
    const otherPk = testPrivateKey(99);
    const p = proof();
    const message = canonicalIdentityMessage(p.agentAddress, p.nonce, p.nonceTimestamp);
    p.signature = signEip191(otherPk, message); // firmado por otro
    await expect(g.verifyAndConsumeNonce(p)).rejects.toBeInstanceOf(IdentityMismatchError);
  });

  it('timestamp viejo (con firma válida) → NonceTooOldError', async () => {
    const s = new InMemoryStorage();
    const g = makeGuard(s, { nonceMaxAgeSeconds: 300 }, verifier);
    const old = Math.floor(Date.now() / 1000) - 1000;
    await expect(g.verifyAndConsumeNonce(proof({ nonceTimestamp: old }))).rejects.toBeInstanceOf(
      NonceTooOldError,
    );
  });

  it('nonce reusado → NonceAlreadyUsedError', async () => {
    const s = new InMemoryStorage();
    const g = makeGuard(s, {}, verifier);
    const p = proof();
    await g.verifyAndConsumeNonce(p);
    await expect(g.verifyAndConsumeNonce(p)).rejects.toBeInstanceOf(NonceAlreadyUsedError);
  });

  it('orden: firma inválida + timestamp viejo → IdentityMismatch (firma se evalúa primero)', async () => {
    const s = new InMemoryStorage();
    const g = makeGuard(s, { nonceMaxAgeSeconds: 300 }, verifier);
    const old = Math.floor(Date.now() / 1000) - 1000;
    const otherPk = testPrivateKey(99);
    const p = proof({ nonceTimestamp: old });
    const message = canonicalIdentityMessage(p.agentAddress, p.nonce, p.nonceTimestamp);
    p.signature = signEip191(otherPk, message); // firma inválida + timestamp viejo
    await expect(g.verifyAndConsumeNonce(p)).rejects.toBeInstanceOf(IdentityMismatchError);
  });
});

describe('BridleGuard — signatureVerifier opcional', () => {
  // El verifier es opcional: el caso "solo presupuesto" no lo necesita.
  function guardWithoutVerifier(storage: InMemoryStorage, config: BridleConfig = {}): BridleGuard {
    return new BridleGuard({ storage, config });
  }

  it('construir el guard SIN verifier no lanza', () => {
    const s = new InMemoryStorage();
    expect(() => guardWithoutVerifier(s)).not.toThrow();
  });

  it('las ops de presupuesto funcionan SIN verifier (reserve → commit → deny)', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget({ maxAmountPerWindow: '1.00' }));
    const g = guardWithoutVerifier(s);

    await g.checkAndReserve({ reservationId: 'r1', agentAddress: AGENT, amount: '1.00', currency: CUR });
    await g.commit('r1');
    expect(s.getLedgerEntry('r1')?.status).toBe('committed');

    // el presupuesto sigue bloqueando aunque no haya verifier
    await expect(
      g.checkAndReserve({ reservationId: 'r2', agentAddress: AGENT, amount: '0.01', currency: CUR }),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('verifyAndConsumeNonce SIN verifier → ConfigurationError tipado', async () => {
    const s = new InMemoryStorage();
    const g = guardWithoutVerifier(s);
    const proof: IdentityProof = {
      agentAddress: AGENT,
      nonce: 'n1',
      nonceTimestamp: Math.floor(Date.now() / 1000),
      signature: '0xdeadbeef',
    };
    await expect(g.verifyAndConsumeNonce(proof)).rejects.toBeInstanceOf(ConfigurationError);
    await expect(g.verifyAndConsumeNonce(proof)).rejects.toMatchObject({
      code: 'configuration_required',
    });
  });
});

describe('BridleGuard.expire + sweeper (AC-8 contrato de expiración)', () => {
  it('expire() libera reservas expiradas y poda nonces', async () => {
    const s = new InMemoryStorage();
    s.setBudget(budget({ maxAmountPerWindow: '100.00' }));
    const g = makeGuard(s);

    const past = new Date(Date.now() - 10_000);
    await g.checkAndReserve(
      { reservationId: 'r1', agentAddress: AGENT, amount: '1.00', currency: CUR, reservationTtlSeconds: 1 },
      past,
    );
    // En `past + 1s` la reserva ya expiró; ahora (now) la barre.
    const result = await g.expire(new Date());
    expect(result.releasedReservations).toBe(1);
    expect(s.getLedgerEntry('r1')?.status).toBe('released');
  });

  it('construir el guard NO crea timers; startExpirySweeper sí, y stop lo limpia', () => {
    const setSpy = jest.spyOn(global, 'setInterval');
    const clearSpy = jest.spyOn(global, 'clearInterval');
    try {
      const s = new InMemoryStorage();
      const g = makeGuard(s);
      expect(setSpy).not.toHaveBeenCalled(); // el constructor no arranca nada

      const stop = g.startExpirySweeper(1000);
      expect(setSpy).toHaveBeenCalledTimes(1);
      stop();
      expect(clearSpy).toHaveBeenCalledTimes(1);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });
});
