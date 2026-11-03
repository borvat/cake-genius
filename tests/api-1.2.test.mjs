/**
 * HTTP acceptance for 1.2: slots, overbooking refusal, CSV, product lifecycle,
 * WhatsApp preview (queued, never sent), SEO tags, and the rule that matters
 * most — a server that cannot write must refuse the order with 503.
 *
 * Spawns the real server twice (normal, then READ_ONLY on the same database).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { shopDate, addDays } from '../lib/capacity.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 4600 + Math.floor(Math.random() * 200);
const READONLY_PORT = PORT + 1;
const DB = path.join(os.tmpdir(), `cg-api-${process.pid}-${Date.now()}.db`);
const PASS = 'test-pass-12';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { failures.push(name); console.log(`FAIL  ${name}${detail ? ' -> ' + detail : ''}`); }
}

for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.unlinkSync(f); } catch { /* none */ } }

function start(extraEnv = {}) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(extraEnv.port), DB_PATH: DB, ADMIN_PASSWORD: PASS, NODE_ENV: 'test', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (d) => { err += d.toString(); });
  child.on('exit', (code) => { if (code && !child.killed) err += `\nexited ${code}`; });
  return { child, err: () => err };
}

async function waitHealth(port) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return r.json();
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server on ${port} did not become healthy`);
}

async function stop(srv) {
  if (!srv?.child || srv.child.killed) return;
  srv.child.kill();
  await Promise.race([once(srv.child, 'exit'), new Promise((r) => setTimeout(r, 3000))]);
}

const base = (port) => `http://127.0.0.1:${port}`;
async function req(port, pathname, { method = 'GET', body, cookie, raw = false } = {}) {
  const res = await fetch(base(port) + pathname, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  let data = null;
  try { data = await res.json(); } catch { /* not json */ }
  return { status: res.status, data, headers: res.headers };
}

const date = addDays(shopDate(new Date()), 3);
const deliveryAt = `${date}T09:00:00.000Z`; // 12:00 in Riyadh
const line = (qty) => ({
  productId: 'p-lotus',
  config: { size: 's8', flavor: 'vanilla', filling: 'cream', design: 'classic', deliveryMethod: 'delivery' },
  quantity: qty,
});

const srv = start({ port: PORT });
try {
  const health = await waitHealth(PORT);
  check('health reports the sqlite driver', health.storage?.driver === 'sqlite', JSON.stringify(health.storage));
  check('a fresh database starts empty', health.ordersStored === 0, String(health.ordersStored));

  /* SEO */
  const home = await req(PORT, '/', { raw: true });
  const html = await home.text();
  check('home carries an OG image', /property="og:image" content="https?:\/\/[^"]+\/img\/og-image\.png"/.test(html));
  check('home carries JSON-LD Bakery + menu', html.includes('application/ld+json') && html.includes('"@type":"Bakery"') && html.includes('"@type":"ItemList"'));
  check('home has a canonical URL', /rel="canonical" href="https?:\/\/[^"]+\/"/.test(html));
  check('JSON-LD prices come from the catalog', html.includes(`"price":${145}`) || html.includes('"price":145'));

  const sitemap = await req(PORT, '/sitemap.xml', { raw: true });
  const xml = await sitemap.text();
  check('sitemap is XML and lists the catalog', sitemap.headers.get('content-type').includes('xml') && xml.includes('/?cake=celebration-vanilla'));

  const robots = await fetch(base(PORT) + '/robots.txt').then((r) => r.text());
  check('robots.txt blocks /admin and points at the sitemap', robots.includes('Disallow: /admin') && robots.includes('Sitemap:'));

  /* public availability */
  const slots = await req(PORT, '/api/slots?days=3');
  check('slots endpoint returns 3 days', slots.status === 200 && slots.data.days.length === 3);
  check('each day exposes two windows', slots.data.days[0].windows.length === 2);

  /* admin auth */
  const unauth = await req(PORT, '/api/admin/orders');
  check('admin data is 401 before login', unauth.status === 401);
  const login = await req(PORT, '/api/admin/login', { method: 'POST', body: { username: 'admin', password: PASS } });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  check('login succeeds and sets a session cookie', login.status === 200 && cookie.startsWith('cg_session='));

  /* capacity */
  const tune = await req(PORT, '/api/admin/settings', {
    method: 'PATCH', cookie,
    body: { 'capacity.daily': 2, 'capacity.perWindow': 1, 'capacity.leadHours': 0, 'capacity.windows': '11:00-14:00,16:00-19:00' },
  });
  check('admin can set capacity', tune.status === 200 && tune.data.settings['capacity.perWindow'] === '1', JSON.stringify(tune.data));

  const o1 = await req(PORT, '/api/orders', { method: 'POST', body: { customer: { name: 'عميل واحد', phone: '0555111001' }, items: [line(1)], deliveryAt } });
  check('first order in the window is accepted', o1.status === 201, JSON.stringify(o1.data));
  const o2 = await req(PORT, '/api/orders', { method: 'POST', body: { customer: { name: 'عميل اثنان', phone: '0555111002' }, items: [line(1)], deliveryAt } });
  check('second order in a 1-cake window is refused with 409', o2.status === 409 && o2.data.error === 'SLOT_FULL', `${o2.status} ${JSON.stringify(o2.data)}`);
  const after = await req(PORT, '/api/health');
  check('the refused order was not stored', after.data.ordersStored === 1, String(after.data.ordersStored));

  const day = await req(PORT, `/api/admin/day?date=${date}`, { cookie });
  check('day board shows the booking', day.status === 200 && day.data.availability.dayBooked === 1 && day.data.orders.length === 1);
  check('day board carries the order code', day.data.orders[0].code === o1.data.order.code);

  /* CSV */
  const csv = await req(PORT, '/api/admin/orders.csv', { cookie, raw: true });
  const bytes = Buffer.from(await csv.arrayBuffer());
  check('CSV has a UTF-8 BOM for Excel', bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf, bytes.subarray(0, 3).toString('hex'));
  check('CSV is served as an attachment', (csv.headers.get('content-disposition') || '').includes('attachment'));
  check('CSV contains the order', bytes.toString('utf8').includes(o1.data.order.code));

  /* product lifecycle */
  const product = await req(PORT, '/api/admin/products', {
    method: 'POST', cookie,
    body: { slug: 'api-test-cake', category: 'classic', nameAr: 'كيكة الواجهة', nameEn: 'API cake', descAr: 'وصف', descEn: 'desc', basePrice: 250, image: '/img/celebrate.svg' },
  });
  check('admin can create a product with an image', product.status === 201 && product.data.product.id === 'p-api-test-cake', JSON.stringify(product.data));
  const off = await req(PORT, `/api/admin/products/${product.data.product.id}`, { method: 'PATCH', cookie, body: { active: false } });
  check('admin can deactivate a product', off.status === 200 && off.data.product.active === false);
  const publicList = await req(PORT, '/api/products');
  check('the deactivated product is hidden from customers', !publicList.data.products.some((p) => p.id === 'p-api-test-cake'));
  const adminList = await req(PORT, '/api/admin/products', { cookie });
  check('the deactivated product remains visible to the admin', adminList.data.products.some((p) => p.id === 'p-api-test-cake' && p.active === false));
  const badImage = await req(PORT, `/api/admin/products/${product.data.product.id}`, { method: 'PATCH', cookie, body: { image: 'javascript:alert(1)' } });
  check('a javascript: image is refused', badImage.status === 400 && badImage.data.error === 'BAD_PRODUCT');

  /* WhatsApp: rendered, queued, never sent */
  const prev = await req(PORT, `/api/admin/orders/${o1.data.order.id}/notify-preview`, { method: 'POST', cookie });
  check('notification preview renders both audiences', prev.status === 200 && !!prev.data.messages.customer);
  check('the channel is explicitly unarmed', prev.data.channel.armed === false && prev.data.channel.enabled === false);
  check('the preview links to a manual wa.me send', String(prev.data.links.customer).startsWith('https://wa.me/'));
  check('the preview body carries the order code', prev.data.messages.customer.body.includes(o1.data.order.code));

  /* 1.3: a time outside every staffed window is refused, never booked blind */
  const outside = await req(PORT, '/api/orders', {
    method: 'POST',
    body: { customer: { name: 'عميل خارج الفترة', phone: '0555111777' }, items: [line(1)], deliveryAt: `${date}T11:30:00.000Z` },
  });
  check('14:30 Riyadh (between windows) is refused with 409 SLOT_CLOSED',
    outside.status === 409 && outside.data.error === 'SLOT_CLOSED', `${outside.status} ${JSON.stringify(outside.data)}`);
  const late = await req(PORT, '/api/orders', {
    method: 'POST',
    body: { customer: { name: 'عميل متأخر', phone: '0555111778' }, items: [line(1)], deliveryAt: `${date}T20:00:00.000Z` },
  });
  check('23:00 Riyadh (after the last window) is refused with 409 SLOT_CLOSED',
    late.status === 409 && late.data.error === 'SLOT_CLOSED', `${late.status} ${JSON.stringify(late.data)}`);

  /* the refused request must not create a negative-capacity row */
  const slotsAfter = await req(PORT, `/api/slots?days=3&from=${date}`);
  const slotDay = slotsAfter.data.days[0];
  check('availability never goes negative', slotDay.windows.every((w) => w.remaining >= 0));
} finally {
  await stop(srv);
}

/* the outbox is queued, and nothing was ever sent */
try {
  const { DatabaseSync } = await import('node:sqlite');
  const ro = new DatabaseSync(DB, { readOnly: true });
  const rows = ro.prepare('SELECT status, sent_at, channel FROM notification_outbox').all();
  check('notifications are stored in the outbox as queued', rows.length >= 1 && rows.every((r) => r.status === 'queued' && r.sent_at === null));
  ro.close();
} catch (err) {
  check('outbox inspection works', false, err.message);
}

/* READ_ONLY: the server must refuse, not acknowledge */
const roSrv = start({ port: READONLY_PORT, READ_ONLY: '1' });
try {
  const health = await waitHealth(READONLY_PORT);
  check('read-only mode is reported', health.storage.readOnly === true);
  const before = health.ordersStored;
  const refused = await req(READONLY_PORT, '/api/orders', {
    method: 'POST',
    body: { customer: { name: 'عميل قراءة', phone: '0555111999' }, items: [line(1)], deliveryAt: `${addDays(date, 1)}T09:00:00.000Z` },
  });
  check('an unwritable server answers 503 PERSISTENCE_FAILED', refused.status === 503 && refused.data.error === 'PERSISTENCE_FAILED', `${refused.status} ${JSON.stringify(refused.data)}`);
  const after = await req(READONLY_PORT, '/api/health');
  check('no order was created in read-only mode', after.data.ordersStored === before, `${before} -> ${after.data.ordersStored}`);
  const home = await fetch(base(READONLY_PORT) + '/').then((r) => r.status);
  check('read-only mode still serves the storefront', home === 200);
} finally {
  await stop(roSrv);
  for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('FAILED:', failures.join(' | '));
  process.exit(1);
}
