#!/usr/bin/env node
/**
 * One-shot SQLite -> PostgreSQL data migration for Cake Genius 1.2.
 *
 *   node tools/migrate-sqlite-to-pg.mjs --sqlite ./data/cake.db --pg "$DATABASE_URL" [--dry-run]
 *
 * - creates/updates the Postgres schema with the same migrations the app uses
 * - copies rows table by table in FK order, idempotently (ON CONFLICT DO NOTHING)
 * - compares every table's row count and fails loudly on a mismatch
 * - continues order codes from the highest migrated code
 * - never copies sessions (auth tokens stay on the old host; admins re-login)
 *
 * Safe to run twice: the second run is a no-op and still verifies counts.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { createPostgresDriver } from '../lib/storage/postgres.js';
import { migrate } from '../lib/storage/schema.js';

const args = process.argv.slice(2);
const opt = (name, dflt = null) => {
  const i = args.indexOf(name);
  return i > -1 ? args[i + 1] : dflt;
};
const sqlitePath = opt('--sqlite', process.env.DB_PATH || 'data/cake.db');
const pgUrl = opt('--pg', process.env.DATABASE_URL);
const dryRun = args.includes('--dry-run');

if (!pgUrl) {
  console.error('Missing --pg <postgres url> (or DATABASE_URL). No external database is created by this tool.');
  process.exit(2);
}
if (!fs.existsSync(sqlitePath)) {
  console.error(`SQLite database not found: ${sqlitePath}`);
  process.exit(2);
}

const TABLES = [
  'products', 'customers', 'admin_users', 'orders', 'order_items', 'order_events',
  'settings', 'delivery_slots', 'notification_outbox',
];

const src = new DatabaseSync(sqlitePath, { readOnly: true });
const pg = await createPostgresDriver(pgUrl);

async function tableExists(name, which) {
  if (which === 'sqlite') {
    return !!src.prepare("SELECT 1 AS x FROM sqlite_master WHERE type='table' AND name = ?").get(name);
  }
  const r = await pg.query("SELECT 1 AS x FROM information_schema.tables WHERE table_schema='public' AND table_name = ?", [name]);
  return r.rows.length > 0;
}

async function pgCount(name) {
  const r = await pg.query(`SELECT COUNT(*) AS n FROM ${name}`);
  return Number(r.rows[0].n);
}

try {
  const plans = [];
  for (const t of TABLES) {
    const hasSrc = await tableExists(t, 'sqlite');
    const rows = hasSrc ? src.prepare(`SELECT * FROM ${t}`).all() : [];
    plans.push({ table: t, rows });
  }

  console.log(`${dryRun ? 'DRY RUN — ' : ''}source: ${sqlitePath}`);
  for (const p of plans) console.log(`  ${p.table.padEnd(22)} ${String(p.rows.length).padStart(6)} rows`);

  if (dryRun) {
    console.log('\nNo writes performed (--dry-run).');
    process.exit(0);
  }

  await migrate(pg);
  console.log('\nPostgres schema is at the current migration.');

  for (const { table, rows } of plans) {
    if (!rows.length) continue;
    if (!(await tableExists(table, 'pg'))) {
      console.log(`  skip ${table}: not part of the 1.2 schema on the target`);
      continue;
    }
    const cols = Object.keys(rows[0]);
    const placeholders = cols.map(() => '?').join(', ');
    const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`;
    let inserted = 0;
    for (const row of rows) {
      const values = cols.map((c) => (row[c] === undefined ? null : row[c]));
      const res = await pg.query(sql, values);
      inserted += res.rowCount;
    }
    console.log(`  ${table.padEnd(22)} copied ${inserted}/${rows.length}`);
  }

  /* order codes continue from history */
  const maxRow = await pg.query("SELECT MAX(CAST(substr(code, 4) AS INTEGER)) AS m FROM orders");
  const maxCode = Number(maxRow.rows[0]?.m || 0);
  if (maxCode > 1000) {
    await pg.query("UPDATE counters SET value = ? WHERE name = 'order_code' AND value < ?", [maxCode, maxCode]);
    console.log(`  counter order_code     advanced to ${maxCode}`);
  }

  /* verify */
  let ok = true;
  console.log('\nverification (source -> target):');
  for (const { table, rows } of plans) {
    if (!(await tableExists(table, 'pg'))) continue;
    const target = await pgCount(table);
    const match = target >= rows.length;
    if (!match) ok = false;
    console.log(`  ${table.padEnd(22)} ${String(rows.length).padStart(6)} -> ${String(target).padStart(6)} ${match ? 'OK' : 'MISMATCH'}`);
  }

  const srcOrders = src.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS s FROM orders').get();
  const dstOrders = (await pg.query('SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS s FROM orders')).rows[0];
  const moneyOk = Number(srcOrders.n) === 0 || Number(dstOrders.s) === Number(srcOrders.s);
  console.log(`  orders total sum       ${Number(srcOrders.s)} -> ${Number(dstOrders.s)} ${moneyOk ? 'OK' : 'MISMATCH'}`);
  if (!moneyOk) ok = false;

  await pg.close();
  src.close();
  if (!ok) {
    console.error('\nMIGRATION FAILED: counts do not match. Nothing was deleted on either side.');
    process.exit(1);
  }
  console.log('\nMIGRATION OK. Point DATABASE_URL at this database and restart the app.');
} catch (err) {
  console.error('\nMIGRATION ERROR:', err.message);
  await pg.close().catch(() => {});
  try { src.close(); } catch { /* already closed */ }
  process.exit(1);
}
