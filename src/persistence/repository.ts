import type { Database, Statement } from 'better-sqlite3';

/**
 * One row of the audit trail (R8). Written on both success and failure. The JSON
 * fields hold rubric-dependent shapes; `result`/`rawLlmResponse` are null on a
 * failed evaluation, and `renderedPrompt` is present whenever a prompt was built.
 */
export interface EvaluationRecord {
  id: string;
  sessionId?: string;
  createdAt: string;
  status: 'success' | 'error';
  rubricId: string;
  rubricVersion: number;
  promptVersion: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
  retries: number;
  truncated: boolean;
  errorMessage: string | null;
  correlationId: string;
  originalConversation: unknown;
  maskedConversation: unknown;
  renderedPrompt: unknown | null;
  rawLlmResponse: unknown | null;
  result: unknown | null;
}

export interface EvaluationRepository {
  /** Inserts one audit row. Throws (propagating a SQLite error) on write
   * failure — the caller keeps auditing on the critical path. */
  save(record: EvaluationRecord): void;
  /** Reads one row back, JSON columns parsed. Mainly for tests today. */
  findById(id: string): EvaluationRecord | undefined;
}

/** Shape of a raw `evaluations` row as SQLite returns it (JSON still text,
 * booleans as 0/1). */
interface EvaluationRow {
  id: string;
  session_id: string | null;
  created_at: string;
  status: string;
  rubric_id: string;
  rubric_version: number;
  prompt_version: string;
  model: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  latency_ms: number;
  retries: number;
  truncated: number;
  error_message: string | null;
  correlation_id: string;
  original_conversation: string;
  masked_conversation: string;
  rendered_prompt: string | null;
  raw_llm_response: string | null;
  result: string | null;
}

const INSERT_SQL = `INSERT INTO evaluations (
  id, session_id, created_at, status, rubric_id, rubric_version, prompt_version,
  model, tokens_in, tokens_out, cost_usd, latency_ms, retries, truncated,
  error_message, correlation_id, original_conversation, masked_conversation,
  rendered_prompt, raw_llm_response, result
) VALUES (
  @id, @session_id, @created_at, @status, @rubric_id, @rubric_version, @prompt_version,
  @model, @tokens_in, @tokens_out, @cost_usd, @latency_ms, @retries, @truncated,
  @error_message, @correlation_id, @original_conversation, @masked_conversation,
  @rendered_prompt, @raw_llm_response, @result
)`;

function toJson(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

function fromJson(text: string | null): unknown {
  return text === null ? null : JSON.parse(text);
}

function rowToRecord(row: EvaluationRow): EvaluationRecord {
  return {
    id: row.id,
    ...(row.session_id !== null ? { sessionId: row.session_id } : {}),
    createdAt: row.created_at,
    status: row.status as EvaluationRecord['status'],
    rubricId: row.rubric_id,
    rubricVersion: row.rubric_version,
    promptVersion: row.prompt_version,
    model: row.model,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    costUsd: row.cost_usd,
    latencyMs: row.latency_ms,
    retries: row.retries,
    truncated: row.truncated === 1,
    errorMessage: row.error_message,
    correlationId: row.correlation_id,
    originalConversation: fromJson(row.original_conversation),
    maskedConversation: fromJson(row.masked_conversation),
    renderedPrompt: fromJson(row.rendered_prompt),
    rawLlmResponse: fromJson(row.raw_llm_response),
    result: fromJson(row.result),
  };
}

/**
 * SQLite-backed {@link EvaluationRepository}. Statements are prepared once and
 * reused. Boolean/JSON fields are serialized on write and parsed on read so
 * callers work with domain values, not storage encodings.
 */
export function createEvaluationRepository(db: Database): EvaluationRepository {
  const insertStmt: Statement = db.prepare(INSERT_SQL);
  const findStmt: Statement = db.prepare('SELECT * FROM evaluations WHERE id = ?');

  return {
    save(record) {
      insertStmt.run({
        id: record.id,
        session_id: record.sessionId ?? null,
        created_at: record.createdAt,
        status: record.status,
        rubric_id: record.rubricId,
        rubric_version: record.rubricVersion,
        prompt_version: record.promptVersion,
        model: record.model,
        tokens_in: record.tokensIn,
        tokens_out: record.tokensOut,
        cost_usd: record.costUsd,
        latency_ms: record.latencyMs,
        retries: record.retries,
        truncated: record.truncated ? 1 : 0,
        error_message: record.errorMessage,
        correlation_id: record.correlationId,
        original_conversation: toJson(record.originalConversation),
        masked_conversation: toJson(record.maskedConversation),
        rendered_prompt: toJson(record.renderedPrompt),
        raw_llm_response: toJson(record.rawLlmResponse),
        result: toJson(record.result),
      });
    },

    findById(id) {
      const row = findStmt.get(id) as EvaluationRow | undefined;
      return row ? rowToRecord(row) : undefined;
    },
  };
}
