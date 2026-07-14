import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import type { Database } from 'better-sqlite3';
import { openDatabase } from '../../src/persistence/db.js';
import {
  createEvaluationRepository,
  type EvaluationRecord,
  type EvaluationRepository,
} from '../../src/persistence/repository.js';

let dir: string;
let db: Database;
let repo: EvaluationRepository;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cqa-db-'));
  db = openDatabase(join(dir, 'test.db'));
  repo = createEvaluationRepository(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function successRecord(overrides: Partial<EvaluationRecord> = {}): EvaluationRecord {
  return {
    id: 'eval-1',
    sessionId: 'S_1',
    createdAt: '2026-07-14T00:00:00.000Z',
    status: 'success',
    rubricId: 'default',
    rubricVersion: 1,
    promptVersion: 'v1',
    model: 'gpt-4o-mini',
    tokensIn: 100,
    tokensOut: 20,
    costUsd: 0.00095,
    latencyMs: 1234,
    retries: 0,
    truncated: false,
    errorMessage: null,
    correlationId: 'corr-1',
    originalConversation: { sessionId: 'S_1', messages: [{ role: 'customer', content: 'oi' }] },
    maskedConversation: { sessionId: 'S_1', messages: [{ role: 'customer', content: 'oi' }] },
    renderedPrompt: { system: 'sys', user: 'usr' },
    rawLlmResponse: { dimensions: {}, flags: {}, summary: 's' },
    result: { dimensions: [], flags: [], overallScore: 4, summary: 's' },
    ...overrides,
  };
}

describe('createEvaluationRepository', () => {
  it('round-trips every field of a success record', () => {
    const record = successRecord();
    repo.save(record);
    expect(repo.findById('eval-1')).toEqual(record);
  });

  it('persists a failure record with null result/raw and an error message', () => {
    const record = successRecord({
      id: 'eval-err',
      status: 'error',
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
      errorMessage: 'LLM request failed after 3 attempt(s)',
      renderedPrompt: { system: 'sys', user: 'usr' },
      rawLlmResponse: null,
      result: null,
    });
    repo.save(record);

    const found = repo.findById('eval-err');
    expect(found?.status).toBe('error');
    expect(found?.errorMessage).toContain('LLM request failed');
    expect(found?.result).toBeNull();
    expect(found?.rawLlmResponse).toBeNull();
  });

  it('preserves the truncated boolean and omits sessionId when absent', () => {
    const record = successRecord({ id: 'eval-2', truncated: true });
    delete (record as { sessionId?: string }).sessionId;
    repo.save(record);

    const found = repo.findById('eval-2');
    expect(found?.truncated).toBe(true);
    expect(found?.sessionId).toBeUndefined();
  });

  it('returns undefined for an unknown id', () => {
    expect(repo.findById('missing')).toBeUndefined();
  });

  it('rejects a duplicate id (append-only primary key)', () => {
    repo.save(successRecord());
    expect(() => repo.save(successRecord())).toThrow();
  });
});

describe('migrations', () => {
  it('are idempotent across reopens of the same database file', () => {
    // The db in beforeEach already ran migrations once; reopening the same file
    // runs them again and must not throw or lose data.
    const record = successRecord({ id: 'eval-keep' });
    repo.save(record);
    db.close();

    const reopened = openDatabase(join(dir, 'test.db'));
    const reopenedRepo = createEvaluationRepository(reopened);
    expect(reopenedRepo.findById('eval-keep')?.id).toBe('eval-keep');
    reopened.close();
    // reassign so afterEach closes a live handle
    db = openDatabase(join(dir, 'test.db'));
  });
});
