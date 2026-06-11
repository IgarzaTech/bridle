# Demo de Bridle — el presupuesto que bloquea de verdad

Demo ejecutable de [`@nexopay/bridle`](../README.md). Un agente con presupuesto ajustado
intenta **dos pagos**: el primero pasa, el segundo se **bloquea** porque excede el
presupuesto — y el pago **nunca se ejecuta**. Ese contraste es el punto.

> Es un artefacto de referencia: **no se publica a npm** (no está en el `files` del
> paquete). Importa Bridle por su API pública, igual que lo haría un dev externo.

## Correr (modo mock — cero setup)

```bash
pnpm install            # desde la raíz del monorepo
pnpm --filter @nexopay/bridle build   # construye el paquete que el demo importa
pnpm --filter @nexopay/bridle-example demo
```

`BRIDLE_DEMO_MODE=mock` (default): el pago es simulado (un `await` + un txHash falso).
Corre al instante, sin red ni claves.

## Correr (modo tempo — testnet real)

Envía un `transferWithMemo` de pathUSD de verdad en Tempo testnet (Moderato, chainId
42431). Necesitas una cuenta fondeada con pathUSD de prueba.

1. **Fondea una wallet** (faucet de Tempo, vía `cast`):
   ```bash
   # genera un signer de prueba
   cast wallet new
   # fondéalo con pathUSD de testnet
   cast rpc tempo_fundAddress <TU_ADDRESS> --rpc-url https://rpc.moderato.tempo.xyz
   ```
2. **Exporta el entorno** y corre:
   ```bash
   export BRIDLE_DEMO_MODE=tempo
   export TEMPO_RPC_URL=https://rpc.moderato.tempo.xyz
   export TEMPO_TEST_PRIVATE_KEY=0x...   # la clave del signer fondeado
   export TEMPO_TEST_RECIPIENT=0x...     # quién recibe el pago de prueba
   pnpm --filter @nexopay/bridle-example demo
   ```

El pago #1 imprime el **txHash real** + un link al explorer
(`https://explore.testnet.tempo.xyz/tx/<txHash>`). El pago #2 se bloquea **sin** tocar la
cadena (Bridle deniega antes de pagar).

> La identidad / anti-DoS (firma + nonce) NO entra en este demo para mantener el foco en
> el bloqueo de presupuesto. Es opcional y se documenta en el [README del paquete](../README.md).

---

## Guion de grabación (2 min)

**0:00 — Encuadre (15s).** "Esto es Bridle: un guardrail de presupuesto por agente. La
promesa es simple — cuando un agente se queda sin presupuesto, el pago **no ocurre**. No
'se registra y avisamos': no ocurre. Lo vemos en vivo."

**0:15 — Setup (20s).** Muestra el código: presupuesto `1.00`, dos pagos de `1.00`.
"Presupuesto para exactamente un pago. Envuelvo mi llamada de pago con `withBudget` — esa
es toda la integración."

**0:35 — Corre el demo (40s).** `pnpm --filter @nexopay/bridle-example demo` (modo tempo).
- Pago #1 → **OK**: señala el txHash y abre el link al explorer. "Pago real, on-chain,
  confirmado. Bridle reservó, dejó pagar, y marcó el gasto."
- Pago #2 → **🛑 BLOQUEADO**. "Segundo pago: excede el presupuesto. Bridle lanza
  `BudgetExceededError` **antes** de tocar la cadena. Mira el explorer — no hay segunda
  transacción. El dinero nunca se movió."

**1:15 — El por qué (30s).** "Este demo corre con el storage **in-memory** (cero setup, para
que lo veas en segundos). La garantía bajo concurrencia —si 20 pagos llegan a la vez,
exactamente uno pasa, nunca dos— la da el **adapter de Postgres** con un advisory lock, y está
validada por el **test de concurrencia contra Postgres real** que viene en el paquete. No te
fíes de este video para eso: corre ese test."

**1:45 — Cierre (15s).** "Framework-agnóstico, storage-pluggable, Apache-2.0.
`pnpm add @nexopay/bridle`. El guardrail que de verdad bloquea."
