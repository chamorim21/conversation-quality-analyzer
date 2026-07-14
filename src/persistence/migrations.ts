import type { Database } from 'better-sqlite3';

/**
 * Schema for the append-only audit trail (R8). Every statement is idempotent
 * (`IF NOT EXISTS`) so {@link runMigrations} can run on every boot without
 * guarding on a version. The model is hybrid: stable columns that `/metrics`
 * will aggregate over, plus JSON text columns for the parts whose shape depends
 * on the rubric (conversations, rendered prompt, raw response, result).
 */
const MIGRATIONS: string[] = [
  `CREATE TABLE IF NOT EXISTS evaluations (
    id TEXT PRIMARY KEY,
    session_id TEXT,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL,
    rubric_id TEXT NOT NULL,
    rubric_version INTEGER NOT NULL,
    prompt_version TEXT NOT NULL,
    model TEXT NOT NULL,
    tokens_in INTEGER NOT NULL,
    tokens_out INTEGER NOT NULL,
    cost_usd REAL NOT NULL,
    latency_ms INTEGER NOT NULL,
    retries INTEGER NOT NULL,
    truncated INTEGER NOT NULL,
    error_message TEXT,
    correlation_id TEXT NOT NULL,
    original_conversation TEXT NOT NULL,
    masked_conversation TEXT NOT NULL,
    rendered_prompt TEXT,
    raw_llm_response TEXT,
    result TEXT
  )`,
];

/**
 * Runs the migrations idempotently inside a single transaction. Safe to call on
 * every startup; a rubric change never migrates existing rows (audit is
 * append-only and each row carries the rubric@version that produced it).
 */
export function runMigrations(db: Database): void {
  const migrate = db.transaction(() => {
    for (const statement of MIGRATIONS) {
      db.exec(statement);
    }
  });
  migrate();
}
