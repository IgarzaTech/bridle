/**
 * Policy Engine de Bridle (feature 0006). Reglas declarativas de gasto evaluadas en
 * el mismo punto de enforcement que el presupuesto (dentro de `withAgentLock`).
 */
export * from './types';
export * from './validate';
export {
  evaluatePolicySet,
  type EvaluateDeps,
  type CategorySpendReader,
} from './engine';
