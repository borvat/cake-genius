/**
 * SQLite driver (node:sqlite, built into Node 22).
 *
 * Async interface so the repository code is identical for SQLite and Postgres:
 *   query(sql, params) -> { rows, rowCount }
 *   transaction(fn)    -> fn(tx) where tx has the same query shape
 *
 * Writes are committed synchronously before the promise resolves, so an
 * acknowledged order is on disk. `readOnly` opens the file read-only and makes
 * every write fail loudly instead of silently succeeding.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

function normalizeParams(params) {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p;
  });
}

export function createSqliteDriver(dbPath, { readOnly = false } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath, { readOnly });
  if (!readOnly) {
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 5000;');
  }

  const isReadStatement = (sql) => /^\s*(select|with|pragma)\b/i.test(sql);
  const hasReturning = (sql) => /\breturning\b/i.test(sql);

  async function query(sql, params = []) {
    const stmt = db.prepare(sql);
    const args = normalizeParams(params);
    if (isReadStatement(sql) || hasReturning(sql)) {
      const rows = stmt.all(...args);
      return { rows, rowCount: rows.length };
    }
    const info = stmt.run(...args);
    return { rows: [], rowCount: Number(info.changes ?? 0) };
  }

  // DatabaseSync is synchronous but the repository is async, so two HTTP
  // requests can interleave between awaits. Without a queue the second
  // BEGIN would fire on the same connection and throw. Transactions are
  // serialised here, which also matches SQLite's single-writer model.
  let chain = Promise.resolve();
  function transaction(fn) {
    const run = chain.then(async () => {
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = await fn({ query, dialect: 'sqlite' });
        db.exec('COMMIT');
        return out;
      } catch (err) {
        try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
        throw err;
      }
    });
    chain = run.catch(() => {});
    return run;
  }

  return {
    dialect: 'sqlite',
    readOnly,
    target: dbPath,
    query,
    transaction,
    async close() { try { db.close(); } catch { /* ignore */ } },
  };
}
