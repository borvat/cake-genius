/**
 * Repository contract, run against BOTH engines with the same assertions.
 *
 *   node tests/storage.test.mjs                          # SQLite
 *   TEST_PG_URL=postgres://... node tests/storage.test.mjs   # PostgreSQL
 *
 * It proves the things 1.2 must not regress: money columns add up, order codes
 * never collide, capacity cannot be oversold, a failed write leaves nothing
 * behind, and a cancelled order returns its capacity.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const USING_PG = !!process.env.TEST_PG_URL;
const TMP = path.join(os.tmpdir(), `cg-storage-${process.pid}-${Date.now()}.db`);

if (USING_PG) {
  process.env.DATABASE_URL = process.env.TEST_PG_URL;
  process.env.DB_PATH = '';
} else {
  delete process.env.DATABASE_URL;
  process.env.DB_PATH = TMP;
}
process.env.READ_ONLY = '0';

let pass = 0;
const failures = [];
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`PASS  ${name}`); }
  else { failures.push(name); console.log(`FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(name, a === e, `got ${a}, expected ${e}`);
}

/* fresh database */
if (USING_PG) {
  const pg = (await import('pg')).default;
  const c = new pg.Client({ connectionString: process.env.TEST_PG_URL, options: '-c client_encoding=UTF8' });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE');
  await c.query('CREATE SCHEMA public');
  await c.end();
} else {
  for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.unlinkSync(f); } catch { /* none */ } }
}

const db = await import('../lib/db.js');
const { getStorage, resetStorage, closeStorage, PersistenceError } = await import('../lib/storage/driver.js');
const { shopDate, addDays } = await import('../lib/capacity.js');

await db.openDb();
const target = USING_PG ? 'postgres' : 'sqlite';
console.log(`\n=== repository contract on ${target} ===\n`);

/* ---------------------------------------------------------------- schema */
const products = await db.listProducts({});
check('catalog seeded (10 products)', products.length === 10, String(products.length));
check('storage reports the right driver', db.dbInfo().driver === target, db.dbInfo().driver);

/* -------------------------------------------------------------- settings */
const defaults = await db.getSettings();
eq('default daily capacity is 12', defaults.capacity.daily, 12);

let rejected = null;
try { await db.setSettings({ 'capacity.daily': 0 }); } catch (e) { rejected = e; }
check('settings reject an out-of-range capacity', rejected?.code === 'BAD_SETTINGS', rejected?.message);
rejected = null;
try { await db.setSettings({ 'evil.key': 'x' }); } catch (e) { rejected = e; }
check('settings reject unknown keys', rejected?.code === 'BAD_SETTINGS');

await db.setSettings({
  'capacity.daily': 2,
  'capacity.perWindow': 1,
  'capacity.leadHours': 0,
  'capacity.windows': '11:00-14:00,16:00-19:00',
});
const tuned = await db.getSettings();
check('settings persist and re-read', tuned.capacity.daily === 2 && tuned.capacity.perWindow === 1, JSON.stringify(tuned.capacity));

/* -------------------------------------------------------------- products */
const created = await db.createProduct({
  slug: 'contract-cake', category: 'classic', basePrice: 210, image: '/img/celebrate.svg',
  nameAr: 'كيكة العقد', nameEn: 'Contract cake', descAr: 'وصف العقد', descEn: 'Contract description',
});
check('admin can create a product', created?.id === 'p-contract-cake', created?.id);
check('new product is visible to the public', !!(await db.getProduct('p-contract-cake')));
await db.updateProduct('p-contract-cake', { active: false, basePrice: 220 });
check('deactivated product disappears from the public catalog', (await db.getProduct('p-contract-cake')) === null);
check('deactivated product stays visible to the admin (can be re-enabled)', !!(await db.getProductForAdmin('p-contract-cake')));
await db.updateProduct('p-contract-cake', { active: true });
check('reactivated product returns to the public catalog', !!(await db.getProduct('p-contract-cake')));

rejected = null;
try { await db.createProduct({ slug: 'contract-cake', category: 'classic', basePrice: 1, nameAr: 'x', nameEn: 'x', descAr: 'x', descEn: 'x' }); } catch (e) { rejected = e; }
check('duplicate slug is refused', rejected?.code === 'PRODUCT_EXISTS', rejected?.message);

/* ---------------------------------------------------------------- orders */
const date1 = addDays(shopDate(new Date()), 3);
const at = (d, hh) => `${d}T${String(hh).padStart(2, '0')}:00:00.000Z`; // hh is UTC; +3 = Riyadh
const cust = (n) => ({ name: 'عميل العقد', phone: `0555${String(n).padStart(6, '0')}` });
const line = (qty) => ({
  productId: 'p-lotus',
  name: { ar: 'لوتس', en: 'Lotus' },
  config: { size: 's8' },
  quantity: qty,
  unitPrice: 300,
});

const order1 = await db.createOrder({
  customer: cust(1), items: [line(1)], deliveryAt: at(date1, 9),
  totals: { currency: 'SAR', subtotal: 300, rushFee: 25, deliveryFee: 25, total: 350 },
});
check('order stored with a code', /^CG-\d{4}$/.test(order1.code), order1.code);
check('money columns are disjoint and add up', order1.subtotal + order1.rushFee + order1.deliveryFee === order1.total,
  `${order1.subtotal}+${order1.rushFee}+${order1.deliveryFee} vs ${order1.total}`);
check('order remembers its shop-calendar slot', order1.slot?.date === date1 && order1.slot?.window === 'w1', JSON.stringify(order1.slot));

/* capacity: window 1 now has 1/1 */
let dayFull = null;
try {
  await db.createOrder({ customer: cust(2), items: [line(1)], deliveryAt: at(date1, 9), totals: { currency: 'SAR', subtotal: 300, rushFee: 0, deliveryFee: 0, total: 300 } });
} catch (e) { dayFull = e; }
check('second order in a full window is refused with SLOT_FULL', dayFull?.code === 'SLOT_FULL', dayFull?.code);

/* window 2 is free, day cap is 2 */
const order2 = await db.createOrder({ customer: cust(3), items: [line(1)], deliveryAt: at(date1, 14), totals: { currency: 'SAR', subtotal: 300, rushFee: 0, deliveryFee: 0, total: 300 } });
check('a different window on the same day is accepted', !!order2.code);

let overDay = null;
try {
  await db.createOrder({ customer: cust(4), items: [line(1)], deliveryAt: at(date1, 14), totals: { currency: 'SAR', subtotal: 300, rushFee: 0, deliveryFee: 0, total: 300 } });
} catch (e) { overDay = e; }
check('third cake on a 2-cake day is refused with DAY_FULL', overDay?.code === 'DAY_FULL', overDay?.code);

/* order codes never collide and never go backwards */
const first = Number(order1.code.slice(3));
const second = Number(order2.code.slice(3));
check('order codes increment', second === first + 1, `${order1.code} -> ${order2.code}`);

/* cancellation returns capacity */
await db.setOrderStatus(order1.id, 'cancelled', 'test');
const afterCancel = await db.adminDay(date1);
check('cancelled order releases its capacity', afterCancel.availability.dayBooked === 1, String(afterCancel.availability.dayBooked));
check('cancel is recorded as an event', afterCancel.orders.find((o) => o.id === order1.id)?.events.some((e) => e.status === 'cancelled'));

/* -------------------------------------------------------- failed writes */
const store = getStorage();
const before = (await db.listOrders({ limit: 100 })).length;
// Real storage failure: the target table disappears mid-flight. The insert
// throws after the counter and customer writes, so this also proves rollback.
await store.query('ALTER TABLE orders RENAME TO orders_fault');
let persisted = null;
try {
  await db.createOrder({ customer: cust(9), items: [line(1)], deliveryAt: at(addDays(date1, 1), 9), totals: { currency: 'SAR', subtotal: 300, rushFee: 0, deliveryFee: 0, total: 300 } });
} catch (e) { persisted = e; }
await store.query('ALTER TABLE orders_fault RENAME TO orders');
check('a storage failure rejects the order', !!persisted, persisted?.message);
check('a failed write left no order behind', (await db.listOrders({ limit: 100 })).length === before);
const { rows: counterBefore } = await getStorage().query("SELECT value FROM counters WHERE name = 'order_code'");
check('a rolled-back order does not burn an order code', Number(counterBefore[0].value) === Number(order2.code.slice(3)), `counter ${counterBefore[0].value} after ${order2.code}`);
const next = await db.createOrder({ customer: cust(10), items: [line(1)], deliveryAt: at(addDays(date1, 1), 9), totals: { currency: 'SAR', subtotal: 300, rushFee: 0, deliveryFee: 0, total: 300 } });
const { rows: counterAfter } = await getStorage().query("SELECT value FROM counters WHERE name = 'order_code'");
check('the next successful order takes the released code', Number(next.code.slice(3)) === Number(counterAfter[0].value), `${next.code} counter ${counterAfter[0].value}`);

/* --------------------------------------------------------- concurrency */
await db.setSettings({ 'capacity.daily': 5, 'capacity.perWindow': 1 });
const raceDate = addDays(date1, 2);
const attempt = (n) => db.createOrder({
  customer: cust(20 + n), items: [line(1)], deliveryAt: at(raceDate, 9),
  totals: { currency: 'SAR', subtotal: 300, rushFee: 0, deliveryFee: 0, total: 300 },
}).then((o) => ({ ok: true, o })).catch((e) => ({ ok: false, code: e.code }));
const race = await Promise.all([attempt(1), attempt(2), attempt(3)]);
check('exactly one of three concurrent orders wins the last slot', race.filter((r) => r.ok).length === 1, JSON.stringify(race.map((r) => r.ok || r.code)));
check('the losers are refused with SLOT_FULL', race.filter((r) => !r.ok).every((r) => r.code === 'SLOT_FULL'));

/* -------------------------------------------------------------- read-only */
await closeStorage();
resetStorage();
process.env.READ_ONLY = '1';
await db.openDb();
let roError = null;
try {
  await db.createOrder({ customer: cust(99), items: [line(1)], deliveryAt: at(addDays(date1, 1), 9), totals: { currency: 'SAR', subtotal: 300, rushFee: 0, deliveryFee: 0, total: 300 } });
} catch (e) { roError = e; }
check('READ_ONLY refuses writes with PERSISTENCE_UNAVAILABLE', roError instanceof PersistenceError && roError.status === 503, roError?.message);
const roCount = (await db.listOrders({ limit: 100 })).length;
check('READ_ONLY still reads', roCount > 0, String(roCount));
await closeStorage();
process.env.READ_ONLY = '0';
resetStorage();

console.log(`\n${pass} passed, ${failures.length} failed  (${target})`);
if (!USING_PG) {
  for (const f of [TMP, `${TMP}-wal`, `${TMP}-shm`]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
}
if (failures.length) {
  console.log('FAILED:', failures.join(' | '));
  process.exit(1);
}
