/**
 * Storage bootstrap: picks the driver from the environment.
 *
 *   DATABASE_URL=postgres://...  -> PostgreSQL
 *   (otherwise)                  -> SQLite at DB_PATH (default ./data/cake.db)
 *
 * READ_ONLY=1 opens the store read-only; every write then fails with
 * PERSISTENCE_UNAVAILABLE. That mode exists so an operator (or a test) can
 * prove the "an order is never accepted unless it was stored" contract.
 */
import { createSqliteDriver } from './sqlite.js';
import { createPostgresDriver } from './postgres.js';
import path from 'node:path';

let store = null;

export class PersistenceError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'PersistenceError';
    this.code = 'PERSISTENCE_UNAVAILABLE';
    this.status = 503;
    this.cause = cause;
  }
}

export async function openStorage({ databaseUrl = process.env.DATABASE_URL, sqlitePath = process.env.DB_PATH, readOnly } = {}) {
  if (store) return store;
  const ro = readOnly === undefined ? process.env.READ_ONLY === '1' : !!readOnly;
  if (databaseUrl) {
    store = await createPostgresDriver(databaseUrl, { readOnly: ro });
  } else {
    const file = sqlitePath || path.join(process.cwd(), 'data', 'cake.db');
    store = createSqliteDriver(file, { readOnly: ro });
  }
  return store;
}

export function getStorage() {
  if (!store) throw new Error('Storage has not been opened yet');
  return store;
}

export function storageInfo() {
  const s = getStorage();
  return { driver: s.dialect, target: s.target, readOnly: s.readOnly, persistent: s.dialect === 'postgres' };
}

export function assertWritable() {
  const s = getStorage();
  if (s.readOnly) throw new PersistenceError('The database is in read-only mode; writes are refused.');
  return s;
}

export async function closeStorage() {
  if (store) { await store.close(); store = null; }
}

/** Drop the cached driver (tests only: reopen with a different target). */
export function resetStorage() {
  store = null;
}
