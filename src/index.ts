/**
 * `@nexopay/bridle` — guardrail de presupuesto por agente para pagos agénticos.
 *
 * Punto de entrada del core (framework-agnóstico). Los adapters viven en
 * subpaths: `@nexopay/bridle/postgres` (storage) y `@nexopay/bridle/x402` (hook).
 */

export * from './types';
export * from './errors';
export * from './storage';
export * from './signature-verifier';
export * from './amount';
export * from './guard';
export { Secp256k1SignatureVerifier } from './secp256k1-verifier';
export { InMemoryStorage } from './in-memory-storage';
