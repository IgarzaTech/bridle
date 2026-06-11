/**
 * DDL del adapter Postgres. Las tres tablas llevan un **prefijo configurable**
 * (y/o schema) para poder convivir con las tablas del host en el mismo Postgres
 * sin chocar — clave para el aislamiento en CI durante la ventana de duplicación
 * 0004→0005 (ver spec 0004, AC-3 / AC-9).
 *
 * Montos guardados como `BIGINT` escalado a 6 decimales (entero exacto). El SUM en
 * SQL es entero, sin floats.
 */
export interface SchemaNaming {
  /** Prefijo de tabla (ej. "bridle_" o "bridle_test_"). Default "". */
  tablePrefix?: string;
  /** Schema de Postgres (ej. "bridle"). Default: search_path por defecto. */
  schema?: string;
}

export function qualifiedTable(name: string, naming: SchemaNaming): string {
  const prefix = naming.tablePrefix ?? '';
  const schema = naming.schema ? `"${naming.schema}".` : '';
  return `${schema}"${prefix}${name}"`;
}

export function createSchemaSql(naming: SchemaNaming): string {
  const budgets = qualifiedTable('agent_budgets', naming);
  const ledger = qualifiedTable('budget_ledger', naming);
  const nonces = qualifiedTable('used_nonces', naming);
  const idxWindow = `"${naming.tablePrefix ?? ''}idx_budget_ledger_window"`;
  const schemaStmt = naming.schema ? `CREATE SCHEMA IF NOT EXISTS "${naming.schema}";\n` : '';

  return `
${schemaStmt}CREATE TABLE IF NOT EXISTS ${budgets} (
  agent_address varchar(42) NOT NULL,
  currency varchar(16) NOT NULL,
  window_duration_seconds integer NOT NULL,
  max_amount_per_window bigint NOT NULL,
  max_amount_per_tx bigint,
  unlimited boolean NOT NULL DEFAULT false,
  PRIMARY KEY (agent_address, currency)
);
CREATE TABLE IF NOT EXISTS ${ledger} (
  reservation_id varchar(128) PRIMARY KEY,
  agent_address varchar(42) NOT NULL,
  currency varchar(16) NOT NULL,
  amount_scaled bigint NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'reserved',
  window_start timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS ${idxWindow}
  ON ${ledger} (agent_address, currency, window_start);
CREATE TABLE IF NOT EXISTS ${nonces} (
  nonce varchar(128) PRIMARY KEY,
  agent_address varchar(42) NOT NULL,
  expires_at timestamptz NOT NULL
);
`;
}

export function dropSchemaSql(naming: SchemaNaming): string {
  return `
DROP TABLE IF EXISTS ${qualifiedTable('used_nonces', naming)};
DROP TABLE IF EXISTS ${qualifiedTable('budget_ledger', naming)};
DROP TABLE IF EXISTS ${qualifiedTable('agent_budgets', naming)};
`;
}
