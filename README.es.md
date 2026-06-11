[English](./README.md) | **Español**

[![CI](https://github.com/IgarzaTech/bridle/actions/workflows/ci.yml/badge.svg)](https://github.com/IgarzaTech/bridle/actions/workflows/ci.yml)

# @igarzatech/bridle

**El presupuesto que bloquea de verdad.** Guardrail de gasto por agente para pagos
agénticos — framework-agnóstico, storage-pluggable, listo para x402.

Bridle se sienta delante de un intento de pago: **reserva** el presupuesto antes de
pagar, **confirma** al liquidar y **libera** si el pago falla o expira. Bajo
concurrencia real, garantiza que un agente nunca se pase de su límite (validado con un
test de concurrencia contra Postgres real que corre en CI).

- Licencia: **Apache-2.0**
- Node: **20.x**
- Sin custodia, sin mover fondos: Bridle solo cuenta y decide.

---

## Quickstart (2 minutos)

> **¿Quieres verlo correr?** [`examples/`](./examples) tiene un demo de 2 minutos — un
> presupuesto que deja pasar un pago y bloquea el siguiente — en modo `mock` (cero setup) o
> contra la testnet real de Tempo.

```bash
pnpm add @igarzatech/bridle pg
```

```ts
import { BridleGuard } from '@igarzatech/bridle';
import { PostgresStorageAdapter } from '@igarzatech/bridle/postgres';
import { withBudget } from '@igarzatech/bridle/x402';
import { Pool } from 'pg';

// 1. Storage: tú traes el Pool de Postgres (Bridle no lo crea).
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const storage = new PostgresStorageAdapter(pool, { tablePrefix: 'bridle_' });
await storage.migrate(); // crea agent_budgets / budget_ledger / used_nonces

// 2. Guard: fail-safe — sin política ni default, DENIEGA (nunca permite a ciegas).
//    El `signatureVerifier` es OPCIONAL: solo lo necesitas para identidad/anti-DoS
//    (verifyAndConsumeNonce). Para el presupuesto puro no pasas verifier.
const guard = new BridleGuard({
  storage,
  config: {
    // presupuesto por defecto para agentes sin fila propia: $1.00 por día
    defaultBudget: { maxAmountPerWindow: '1.00', windowDurationSeconds: 86_400 },
  },
});

// 3. Envuelve la llamada de pago. El primer dólar pasa…
const agentAddress = '0xabc...';
async function pay(reservationId: string): Promise<string> {
  return withBudget(
    guard,
    { reservationId, agentAddress, amount: '1.00', currency: 'USDC' },
    async () => {
      // aquí va TU pago real (x402 / MPP / Tempo / lo que sea). Bridle no lo conoce.
      return 'paid';
    },
  );
}

await pay('r1'); // ✅ reserva, paga, commit
await pay('r2'); // ❌ throw BudgetExceededError — el presupuesto BLOQUEA de verdad
```

Eso es todo: el segundo pago se rechaza con `BudgetExceededError` (HTTP 429 si usas el
adapter Express) porque el agente ya gastó su dólar de la ventana.

---

## Conceptos

### Storage y el contrato de concurrencia (lee esto)

`BridleStorage` abstrae la persistencia. Su pieza no negociable es **`withAgentLock`**:
serializa las reservas por `(agente, moneda)`. **Sin esa serialización, el guardrail NO
bloquea** — dos reservas concurrentes leerían el mismo total y ambas pasarían
(overcommit). El adapter Postgres lo implementa con `pg_advisory_xact_lock`, que
serializa incluso cuando el agente no tiene fila de presupuesto.

Si implementas tu propio adapter de Storage, **debe cumplir la misma garantía de
concurrencia** — el test de concurrencia del repo (corre en CI contra Postgres real)
muestra qué significa. No es opcional: es la garantía central.

### Escribir políticas por agente

Bridle es **dueño del schema** de `agent_budgets`, así que ofrece la API de escritura —
no escribas SQL crudo contra la tabla interna:

```ts
await storage.upsertBudget({
  agentAddress: '0xabc...',
  currency: 'USDC',
  windowDurationSeconds: 86_400,
  maxAmountPerWindow: '50.00',
  maxAmountPerTx: '5.00', // o null
  unlimited: false,       // opt-in explícito para "sin límite"
});
```

Sin política propia y sin `defaultBudget`, el guard **deniega** (fail-safe).

### Ciclo de vida de una reserva

`reserved → committed` (pago liquidó) **o** `reserved → released` (falló/expiró). Un
gasto confirmado nunca se revierte. Cada `reservationId` es único: reusarlo lanza
`ReservationConflictError` (no se sobrescribe en silencio).

> **Caveat de finalidad — elige bien el TTL.** Si una reserva expira y se libera
> (`released`), pero el pago liquida **más tarde**, el `commit` re-registra el gasto
> (`released → committed`) — es lo correcto: el gasto fue real. Pero entre el release y
> ese commit tardío, otra reserva pudo haber ocupado ese hueco, así que **la ventana
> puede pasar el límite transitoriamente**. Para evitarlo, configura el **TTL de la
> reserva mayor que el peor caso de finalidad del settlement** de tu rail (que la reserva
> no expire antes de que el pago pueda liquidar).

### Expiración — TÚ debes llamar `expire()`

Bridle **no arranca ningún scheduler**. Si nadie libera las reservas no redimidas, se
acumulan y bloquean al agente legítimo. Llama `guard.expire()` periódicamente desde tu
cron/worker, o usa el helper opt-in:

```ts
const stop = guard.startExpirySweeper(60_000); // cada 60s; opt-in, no implícito
// …
stop(); // cuando cierres el proceso
```

### Identidad / anti-DoS (opcional)

El presupuesto se trackea contra una `agentAddress` declarada. Por sí solo, eso significa
que un atacante podría agotar el presupuesto de una víctima con solo declarar la address de
la víctima — así que autentica la identidad (verifica una firma) antes de reservar. Esta
feature **requiere** que pases un `signatureVerifier` al construir el guard (si no,
`verifyAndConsumeNonce` lanza `ConfigurationError`):

```ts
import { BridleGuard, Secp256k1SignatureVerifier } from '@igarzatech/bridle';

const guard = new BridleGuard({
  storage,
  signatureVerifier: new Secp256k1SignatureVerifier(), // explícito: habilita identidad
  config: { /* … */ },
});

await guard.verifyAndConsumeNonce({
  agentAddress,
  nonce,                 // único por intento
  nonceTimestamp,        // unix seconds
  signature,             // firma EIP-191 de `bridle-identity:<addr>:<nonce>:<ts>`
});
```

Orden de verificación: **firma → frescura → anti-replay**. El `Secp256k1SignatureVerifier`
por defecto valida firmas EOA estándar (MetaMask/viem/ethers) out-of-the-box. ¿Otro esquema
de firma? Implementa la interfaz `SignatureVerifier` y pásalo en su lugar.

### Adapter Express (nice-to-have)

```ts
import { bridleExpressErrorHandler } from '@igarzatech/bridle/x402';
app.use(bridleExpressErrorHandler); // mapea los errores de Bridle a HTTP (429/403/409/…)
```

---

## Decimales

El MVP fija **6 decimales** (stablecoins USD: pathUSD, USDC). Los montos cruzan la API
como **string** (`"100.00"`) y se computan internamente como `bigint` exacto — sin
floats. Decimales por moneda configurables es post-MVP.

---

## Estado

`0.1.0` — MVP. API pública versionada con semver.
