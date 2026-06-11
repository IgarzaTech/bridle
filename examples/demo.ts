/**
 * Demo de @igarzatech/bridle — el arco de 2 minutos.
 *
 * Un agente con presupuesto ajustado (alcanza para UN pago) intenta dos pagos:
 *   - Pago #1: pasa (reserve → pago → commit).
 *   - Pago #2: excede el presupuesto → Bridle lo BLOQUEA (BudgetExceededError) y el
 *     pago NUNCA se ejecuta. Ese contraste es el punto.
 *
 * Usa SOLO la API pública del paquete (import desde @igarzatech/bridle y /x402),
 * exactamente como lo haría un dev externo.
 *
 *   BRIDLE_DEMO_MODE=mock  (default) — payFn simulado, cero setup.
 *   BRIDLE_DEMO_MODE=tempo          — transferWithMemo REAL en Tempo testnet.
 */
import {
  BridleGuard,
  InMemoryStorage,
  BudgetExceededError,
} from '@igarzatech/bridle';
import { withBudget } from '@igarzatech/bridle/x402';

const MODE = process.env.BRIDLE_DEMO_MODE ?? 'mock';
const CURRENCY = 'PATH_USD';
const PAYMENT = '1.00'; // cada pago cuesta 1.00
const BUDGET = '1.00'; // presupuesto: alcanza EXACTO para uno

interface PayResult {
  txHash: string;
  explorer?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Bridle — demo: el presupuesto que bloquea de verdad');
  console.log(`  Modo: ${MODE}   |   Presupuesto: ${BUDGET} ${CURRENCY}/ventana`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const storage = new InMemoryStorage();
  // Solo presupuesto: el guard NO necesita signatureVerifier (es opcional; solo lo
  // exigen las features de identidad/anti-DoS, fuera del foco de este demo).
  const guard = new BridleGuard({ storage, config: {} });

  // Selecciona el rail de pago según el modo. En `tempo` el agente ES el signer.
  let agentAddress: string;
  let payFn: () => Promise<PayResult>;

  if (MODE === 'tempo') {
    const { createTempoPayer } = await import('./tempo-pay');
    const payer = createTempoPayer({ amount: PAYMENT });
    agentAddress = payer.signerAddress;
    payFn = () => payer.pay();
    console.log(`Agente (signer on-chain): ${agentAddress}\n`);
  } else {
    agentAddress = '0xa11ce00000000000000000000000000000000001';
    payFn = async () => {
      await delay(250); // simula la latencia del rail
      return { txHash: `0xMOCK${Date.now().toString(16)}` };
    };
    console.log(`Agente (demo): ${agentAddress}\n`);
  }

  // Política de presupuesto del agente (write API del paquete).
  await storage.upsertBudget({
    agentAddress,
    currency: CURRENCY,
    windowDurationSeconds: 86_400,
    maxAmountPerWindow: BUDGET,
    maxAmountPerTx: null,
    unlimited: false,
  });

  // ── Pago #1 — debe PASAR ──────────────────────────────────────────────────
  console.log(`▶ Pago #1: ${PAYMENT} ${CURRENCY} …`);
  try {
    const r = await withBudget(
      guard,
      { reservationId: 'pay-1', agentAddress, amount: PAYMENT, currency: CURRENCY },
      payFn,
    );
    console.log(`  ✅ OK — reservado, pagado y confirmado. txHash: ${r.txHash}`);
    if (r.explorer) console.log(`     explorer: ${r.explorer}`);
  } catch (err) {
    console.log(`  ⚠ inesperado: el pago #1 no debería fallar — ${String(err)}`);
    process.exitCode = 1;
    return;
  }

  console.log('');

  // ── Pago #2 — debe ser BLOQUEADO ──────────────────────────────────────────
  console.log(`▶ Pago #2: ${PAYMENT} ${CURRENCY} (el presupuesto ya se agotó) …`);
  let blocked = false;
  try {
    await withBudget(
      guard,
      { reservationId: 'pay-2', agentAddress, amount: PAYMENT, currency: CURRENCY },
      payFn, // Bridle NUNCA llega a llamar esto: deniega antes de pagar.
    );
    console.log('  ❌ inesperado: el pago #2 NO fue bloqueado.');
    process.exitCode = 1;
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      blocked = true;
      console.log('  🛑 BLOQUEADO por Bridle — el pago NUNCA se ejecutó.');
      console.log(`     BudgetExceededError (retryAfterSeconds=${err.retryAfterSeconds}).`);
    } else {
      throw err;
    }
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log(
    blocked
      ? '  Resultado: 1 pago pasó, 1 fue bloqueado. El guardrail funciona. ✅'
      : '  Resultado: algo salió mal. ❌',
  );
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main().catch((err: unknown) => {
  console.error('demo falló:', err);
  process.exitCode = 1;
});
