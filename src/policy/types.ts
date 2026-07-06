/**
 * Tipos del Policy Engine de Bridle (feature 0006).
 *
 * Un `PolicySet` es un objeto **declarativo** (datos, no código): JSON-serializable,
 * versionado (`schemaVersion`) y con reglas de tipos CERRADOS. No es un DSL — la
 * expresividad extra es post-MVP (ver spec 0006, Out of scope).
 *
 * Convención de montos (igual que el resto de Bridle, spec 0004 AC-12): dentro de las
 * reglas los montos viajan como **decimal string** (ej. "50.00"), NUNCA `number`. El
 * cómputo interno se hace en `bigint` escalado (ver `amount.ts`).
 */

/** Versión del schema del `PolicySet`. Fija para el MVP. */
export const POLICY_SCHEMA_VERSION = 1;

/**
 * Contexto del gasto que el host adjunta a una reserva. Todo OPCIONAL: sin contexto
 * y sin políticas el comportamiento es idéntico a 0004 (retrocompatibilidad, AC-8).
 *
 * **Fail-safe (AC-7b):** si una política activa referencia un campo que el contexto
 * NO trae (ej. allowlist de recipients pero `recipient` ausente), la decisión es
 * **deny** con error tipado — nunca se ignora la regla por falta de datos.
 */
export interface SpendContext {
  /** A quién se paga (ej. address, merchant id). String libre del host. */
  recipient?: string;
  /** Clasificación del gasto (ej. "cloud", "data"). String libre del host. */
  category?: string;
  /** Metadata arbitraria del host; Bridle no la interpreta (reservado, no evaluado). */
  tags?: Readonly<Record<string, string>>;
}

/**
 * Regla de recipients: allowlist y/o denylist. Semántica fija (AC-4):
 *  - `deny` gana siempre (recipient en `deny` → deny, aunque esté en `allow`).
 *  - Si `allow` está presente (no vacío), un recipient NO listado → deny.
 *  - La comparación es case-insensitive (normalizada a lowercase).
 */
export interface RecipientRule {
  type: 'recipient';
  /** Id estable de la regla (aparece en la `PolicyDecision` para trazabilidad). */
  id: string;
  /** Recipients permitidos. Si presente y no vacío, lo no listado → deny. */
  allow?: ReadonlyArray<string>;
  /** Recipients denegados. Gana siempre sobre `allow`. */
  deny?: ReadonlyArray<string>;
}

/**
 * Regla por categoría: allow/deny de categorías + límite de monto por ventana
 * **por categoría** (independiente del límite global) + per-tx por categoría.
 *
 * El límite por categoría es propio de ESA categoría: gasto en la categoría A no
 * consume el cupo de B; ambos consumen el presupuesto global (0004) al final.
 */
export interface CategoryRule {
  type: 'category';
  /** Id estable de la regla. */
  id: string;
  /** La categoría a la que aplica (case-insensitive). */
  category: string;
  /** Si false, la categoría está denegada de plano (deny). Default true. */
  allow?: boolean;
  /** Límite de gasto por ventana para esta categoría (decimal string). */
  maxAmountPerWindow?: string;
  /** Ventana de este límite en segundos. Requerido si hay `maxAmountPerWindow`. */
  windowDurationSeconds?: number;
  /** Máximo por transacción para esta categoría (decimal string). */
  maxAmountPerTx?: string;
}

/**
 * Regla temporal: franja horaria/días permitidos con TZ **explícita** (IANA o
 * "UTC"). Nunca zona implícita del servidor (AC-6).
 *
 * Fuera de la franja → deny; dentro → allow. Soporta cruce de medianoche
 * (`startMinute > endMinute` → la franja envuelve al día siguiente).
 */
export interface TimeWindowRule {
  type: 'timeWindow';
  /** Id estable de la regla. */
  id: string;
  /** Zona horaria IANA (ej. "America/New_York") o "UTC". Obligatoria. */
  timezone: string;
  /** Minuto de inicio del día [0..1440). Ej. 9*60 = 540 para las 09:00. */
  startMinute: number;
  /** Minuto de fin del día [0..1440]. Si < startMinute, la franja cruza medianoche. */
  endMinute: number;
  /**
   * Días de la semana permitidos (0=domingo..6=sábado), en la TZ de la regla. Si se
   * omite, aplica todos los días. La comparación se hace sobre el instante evaluado.
   */
  daysOfWeek?: ReadonlyArray<number>;
}

/** Unión cerrada de reglas del MVP. `schemaVersion` habilita extensiones sin breaking. */
export type PolicyRule = RecipientRule | CategoryRule | TimeWindowRule;

/**
 * Conjunto de políticas declarativas de un agente. JSON-serializable y versionado.
 * El orden del array NO afecta la decisión (semántica fija, AC-4).
 */
export interface PolicySet {
  schemaVersion: typeof POLICY_SCHEMA_VERSION;
  rules: ReadonlyArray<PolicyRule>;
}

/**
 * Códigos de razón de una decisión de política. Estables para el host (auditoría).
 */
export type PolicyReasonCode =
  | 'allow'
  | 'recipient_not_allowed'
  | 'recipient_denied'
  | 'category_denied'
  | 'category_limit_exceeded'
  | 'category_per_tx_exceeded'
  | 'outside_time_window'
  | 'missing_context_field'
  | 'invalid_policy';

/**
 * Decisión tipada y auditable de la evaluación de políticas. Toda decisión (allow y
 * deny) lleva `reasonCode` y el `ruleId` de la regla causante (null si fue un allow
 * global sin regla específica que decidiera).
 */
export interface PolicyDecision {
  /** true → continúa al chequeo de presupuesto; false → deny (no reserva). */
  allowed: boolean;
  reasonCode: PolicyReasonCode;
  /** Id de la regla que decidió, o null (allow por ausencia de regla que denegara). */
  ruleId: string | null;
  /** Mensaje humano opcional para logs. */
  message?: string;
}

/**
 * Sink de auditoría inyectable: recibe TODA decisión (allow y deny) con su
 * `reasonCode` + regla causante. Interfaz síncrona sin efectos por defecto (el
 * default no arranca timers ni I/O — mismo criterio anti-sorpresa que el guard).
 */
export interface PolicyAuditSink {
  record(event: PolicyAuditEvent): void;
}

/** Evento emitido al sink de auditoría por cada evaluación. */
export interface PolicyAuditEvent {
  agentAddress: string;
  currency: string;
  reservationId: string;
  decision: PolicyDecision;
  /** Instante de la evaluación (el reloj inyectado en el guard). */
  at: Date;
}

/** Sink por defecto: no hace nada (sin efectos colaterales ni timers). */
export const noopAuditSink: PolicyAuditSink = {
  record(): void {
    // intencionalmente vacío: Bridle no impone infraestructura de logging.
  },
};
