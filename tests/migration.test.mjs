/**
 * Migration from a real 1.1 database (schema v1, orders but no counters) to 1.2.
 * Proves that existing data survives, the new tables appear, and order codes
 * continue after the highest stored code instead of colliding with history.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MIGRATIONS } from '../lib/storage/schema.js';

const FILE = path.join(os.tmpdir(), `cg-migrate-${process.pid}-${Date.now()}.db`);
for (const f of [FILE, `${FILE}-wal`, `${FILE}-shm`]) { try { fs.unlinkSync(f); } catch { /* none */ } }

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { failures.push(name); console.log(`FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

/* ---- build a 1.1-era database: v1 tables, an order, no counters ---- */
const legacy = new DatabaseSync(FILE);
legacy.exec('PRAGMA journal_mode = WAL;');
for (const stmt of MIGRATIONS[0].statements) legacy.exec(stmt);
legacy.exec(`INSERT INTO products (id, slug, name_ar, name_en, desc_ar, desc_en, category, base_price, image, tags, popular, active)
  VALUES ('p-legacy','legacy-cake','كيكة قديمة','Legacy cake','وصف','desc','classic',150,'/img/celebrate.svg','legacy',0,1)`);
legacy.exec(`INSERT INTO customers (id, name, phone, email, orders, spent, created_at)
  VALUES ('cus_legacy','عميل قديم','0555121212',NULL,1,675,'2026-10-01T10:00:00.000Z')`);
legacy.exec(`INSERT INTO orders (id, code, customer_id, customer_name, customer_phone, customer_email, notes, currency,
  subtotal, rush_fee, delivery_fee, total, status, payment_method, delivery_at, created_at, updated_at)
  VALUES ('ord_legacy','CG-1017','cus_legacy','عميل قديم','0555121212',NULL,'','SAR',650,0,25,675,'delivered','demo',
  '2026-10-01T12:00:00.000Z','2026-10-01T10:00:00.000Z','2026-10-01T12:00:00.000Z')`);
legacy.exec(`INSERT INTO order_items (id, order_id, product_id, name_ar, name_en, config_json, quantity, unit_price, line_total)
  VALUES ('itm_legacy','ord_legacy','p-legacy','كيكة قديمة','Legacy cake','{"size":"s6"}',1,650,650)`);
legacy.exec(`INSERT INTO order_events (id, order_id, status, actor, created_at)
  VALUES ('evt_legacy','ord_legacy','delivered','admin','2026-10-01T12:00:00.000Z')`);
legacy.close();

/* ---- open it with 1.2 ---- */
process.env.DB_PATH = FILE;
delete process.env.DATABASE_URL;
process.env.READ_ONLY = '0';
const db = await import('../lib/db.js');
const { closeStorage } = await import('../lib/storage/driver.js');
await db.openDb();

const legacyOrder = await db.getOrder('CG-1017');
check('the legacy order still reads back', legacyOrder?.code === 'CG-1017' && legacyOrder.total === 675, JSON.stringify(legacyOrder?.total));
check('its line items survived', legacyOrder.items.length === 1 && legacyOrder.items[0].unitPrice === 650);
check('its events survived', legacyOrder.events.some((e) => e.status === 'delivered'));
check('new orders have no slot (legacy rows are untouched)', legacyOrder.slot === null);

const store = (await import('../lib/storage/driver.js')).getStorage();
const versions = (await store.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) => Number(r.version));
check('both migrations are recorded', versions.join(',') === '1,2', versions.join(','));
const slots = await store.query('SELECT COUNT(*) AS n FROM delivery_slots');
check('the capacity table exists', Number(slots.rows[0].n) >= 0);
check('settings resolve to defaults over an old database', (await db.getSettings()).capacity.daily === 12);

check('the legacy product was not duplicated by seeding', (await db.listProducts({ includeInactive: true })).length === 1, String((await db.listProducts({ includeInactive: true })).length));

await db.setSettings({ 'capacity.leadHours': 0 });
const next = await db.createOrder({
  customer: { name: 'عميل جديد', phone: '0555999888' },
  items: [{ productId: 'p-legacy', name: { ar: 'كيكة', en: 'Cake' }, config: {}, quantity: 1, unitPrice: 150 }],
  totals: { currency: 'SAR', subtotal: 150, rushFee: 0, deliveryFee: 0, total: 150 },
  deliveryAt: null,
});
check('order codes continue after the legacy maximum (CG-1017 -> CG-1018)', next.code === 'CG-1018', next.code);
check('the new order is readable with the new slot fields', next.slot === null);

await closeStorage();
for (const f of [FILE, `${FILE}-wal`, `${FILE}-shm`]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('FAILED:', failures.join(' | '));
  process.exit(1);
}
