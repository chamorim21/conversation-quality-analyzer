import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from './migrations.js';

/**
 * Opens the SQLite database in WAL mode (better concurrency for the append-only
 * audit trail) and runs the migrations before returning. Fail-fast: any problem
 * opening the file or migrating throws at boot rather than on the first request.
 * A `:memory:` path is honored as-is (used by tests); a file path has its parent
 * directory created if missing.
 */
export function openDatabase(path: string): Database.Database {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}
