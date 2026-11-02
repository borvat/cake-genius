/**
 * Repository layer: one async API over SQLite or PostgreSQL.
 *
 * The SQL is written once against `?` placeholders and portable types. The
 * driver rewrites placeholders for Postgres and owns the transaction boundary.
 *
 * Invariants kept from 1.1 (and now enforced on both engines):
 *  - an order is only acknowledged after COMMIT; any failure throws, the HTTP
 *    layer answers 503 and no order exists
 *  - the order code comes from a counter row updated inside the transaction, so
 *    concurrent writers cannot collide (SQLite serialises writers, Postgres
 *    locks the counter row)
 *  - capacity is reserved with a conditional UPDATE, so two orders cannot claim
 *    the last slot: the loser gets rowCount 0 and a 409
 */
import crypto from 'node:crypto';
import { PRODUCTS, ORDER_STATUSES } from './catalog.js';
import { getStorage, openStorage, assertWritable, storageInfo } from './storage/driver.js';
import { migrate } from './storage/schema.js';
import { resolveSettings, validateSettingsPatch } from './settings.js';
import {
  shopDate, shopTime, windowForTime, addDays, dayAvailability, slotError, DAY_WINDOW,
} from './capacity.js';
import { renderOrderMessages } from './notify.js';

/* ------------------------------------------------------------------ boot */

export async function openDb() {
  const store = await openStorage();
  if (!store.readOnly) {
    await migrate(store);
    await seedProducts();
    // A legacy 1.1 database has orders but no counter row. Continue from its
    // highest code instead of restarting at 1001 and colliding with history.
    const { rows } = await store.query("SELECT MAX(CAST(substr(code, 4) AS INTEGER)) AS m FROM orders");
    const maxCode = Number(rows[0]?.m || 0);
    if (maxCode > 1000) {
      await store.query("UPDATE counters SET value = ? WHERE name = 'order_code' AND value < ?", [maxCode, maxCode]);
    }
  }
  return store;
}

export function dbInfo() {
  return storageInfo();
}

export function dbPath() {
  return getStorage().target;
}

async function seedProducts() {
  const count = Number((await getStorage().query('SELECT COUNT(*) AS n FROM products')).rows[0].n);
  if (count > 0) return;
  for (const p of PRODUCTS) {
    await getStorage().query(
      `INSERT INTO products (id, slug, name_ar, name_en, desc_ar, desc_en, category, base_price, image, tags, popular, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1) ON CONFLICT (id) DO NOTHING`,
      [p.id, p.slug, p.name.ar, p.name.en, p.desc.ar, p.desc.en, p.category, p.basePrice, p.image, p.tags.join(','), p.popular],
    );
  }
}

/* -------------------------------------------------------------- products */

export function rowToProduct(r) {
  return {
    id: r.id,
    slug: r.slug,
    name: { ar: r.name_ar, en: r.name_en },
    desc: { ar: r.desc_ar, en: r.desc_en },
    category: r.category,
    basePrice: Number(r.base_price),
    image: r.image,
    tags: r.tags ? String(r.tags).split(',').filter(Boolean) : [],
    popular: !!r.popular,
    active: r.active === undefined ? true : !!r.active,
  };
}

export async function listProducts({ category, includeInactive = false } = {}) {
  const s = getStorage();
  const where = [];
  const params = [];
  if (!includeInactive) where.push('active = 1');
  if (category && category !== 'all') { where.push('category = ?'); params.push(category); }
  const sql = `SELECT * FROM products${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY popular DESC, base_price ASC`;
  return (await s.query(sql, params)).rows.map(rowToProduct);
}

/** Public lookup: inactive products are not orderable. */
export async function getProduct(id) {
  const { rows } = await getStorage().query('SELECT * FROM products WHERE id = ? AND active = 1', [id]);
  return rows[0] ? rowToProduct(rows[0]) : null;
}

/** Admin lookup: includes inactive products, so they can be re-enabled. */
export async function getProductForAdmin(id) {
  const { rows } = await getStorage().query('SELECT * FROM products WHERE id = ?', [id]);
  return rows[0] ? rowToProduct(rows[0]) : null;
}

export async function createProduct(input) {
  assertWritable();
  const name = input.name || { ar: input.nameAr, en: input.nameEn };
  const desc = input.desc || { ar: input.descAr, en: input.descEn };
  const id = input.id && /^[a-z0-9-]{3,40}$/.test(input.id)
    ? input.id
    : `p-${String(input.slug || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30)}`;
  const exists = await getStorage().query('SELECT 1 AS x FROM products WHERE id = ? OR slug = ?', [id, input.slug]);
  if (exists.rows.length) throw Object.assign(new Error('A product with that id or slug already exists'), { status: 409, code: 'PRODUCT_EXISTS' });
  await getStorage().query(
    `INSERT INTO products (id, slug, name_ar, name_en, desc_ar, desc_en, category, base_price, image, tags, popular, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.slug, name.ar, name.en, desc.ar, desc.en, input.category,
      input.basePrice, input.image, (input.tags || []).join(','), input.popular ? 1 : 0, input.active === false ? 0 : 1],
  );
  return getProductForAdmin(id);
}

export async function updateProduct(id, patch = {}) {
  assertWritable();
  const sets = [];
  const params = [];
  const map = {
    basePrice: 'base_price', nameAr: 'name_ar', nameEn: 'name_en', descAr: 'desc_ar', descEn: 'desc_en',
    category: 'category', image: 'image', popular: 'popular', active: 'active',
  };
  for (const [key, col] of Object.entries(map)) {
    if (patch[key] === undefined) continue;
    sets.push(`${col} = ?`);
    if (key === 'popular' || key === 'active') params.push(patch[key] ? 1 : 0);
    else params.push(patch[key]);
  }
  if (patch.tags !== undefined) { sets.push('tags = ?'); params.push((patch.tags || []).join(',')); }
  if (!sets.length) return getProductForAdmin(id);
  params.push(id);
  const res = await getStorage().query(`UPDATE products SET ${sets.join(', ')} WHERE id = ?`, params);
  if (res.rowCount === 0) return null;
  return getProductForAdmin(id);
}

/* -------------------------------------------------------------- settings */

export async function getSettings() {
  const { rows } = await getStorage().query('SELECT key, value FROM settings');
  return resolveSettings(rows);
}

export async function setSettings(body) {
  assertWritable();
  const { updates, errors } = validateSettingsPatch(body);
  if (errors.length) throw Object.assign(new Error(errors.join('; ')), { status: 400, code: 'BAD_SETTINGS' });
  const now = new Date().toISOString();
  await getStorage().transaction(async (tx) => {
    for (const [key, value] of updates) {
      await tx.query(
        `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [key, value, now],
      );
    }
    const today = shopDate(new Date());
    const daily = updates.find(([k]) => k === 'capacity.daily');
    const per = updates.find(([k]) => k === 'capacity.perWindow');
    if (daily) {
      await tx.query(`UPDATE delivery_slots SET capacity = ? WHERE slot_date >= ? AND window_id = '${DAY_WINDOW}'`, [Number(daily[1]), today]);
    }
    if (per) {
      await tx.query(`UPDATE delivery_slots SET capacity = ? WHERE slot_date >= ? AND window_id <> '${DAY_WINDOW}'`, [Number(per[1]), today]);
    }
  });
  return getSettings();
}

/* --------------------------------------------------------------- capacity */

async function ensureSlotRows(q, date, windows, daily, perWindow) {
  await q.query(
    `INSERT INTO delivery_slots (slot_date, window_id, capacity, booked) VALUES (?, ?, ?, 0)
     ON CONFLICT (slot_date, window_id) DO NOTHING`,
    [date, DAY_WINDOW, daily],
  );
  for (const w of windows) {
    await q.query(
      `INSERT INTO delivery_slots (slot_date, window_id, capacity, booked) VALUES (?, ?, ?, 0)
       ON CONFLICT (slot_date, window_id) DO NOTHING`,
      [date, w.id, perWindow],
    );
  }
}

/** Reserve qty cakes on a day (and on its window when the time falls in one). */
async function reserveSlot(tx, slot, qty, settings) {
  const { daily, perWindow, windowList } = settings.capacity;
  await ensureSlotRows(tx, slot.date, windowList, daily, perWindow);
  const day = await tx.query(
    'UPDATE delivery_slots SET booked = booked + ? WHERE slot_date = ? AND window_id = ? AND booked + ? <= capacity',
    [qty, slot.date, DAY_WINDOW, qty],
  );
  if (day.rowCount === 0) throw slotError('DAY_FULL', 'That day is fully booked');
  if (slot.window) {
    const win = await tx.query(
      'UPDATE delivery_slots SET booked = booked + ? WHERE slot_date = ? AND window_id = ? AND booked + ? <= capacity',
      [qty, slot.date, slot.window, qty],
    );
    if (win.rowCount === 0) throw slotError('SLOT_FULL', 'That delivery window is fully booked');
  }
}

async function releaseSlot(tx, order) {
  if (!order.slot_date) return;
  for (const windowId of [DAY_WINDOW, order.slot_window].filter(Boolean)) {
    await tx.query(
      `UPDATE delivery_slots SET booked = CASE WHEN booked >= ? THEN booked - ? ELSE 0 END
       WHERE slot_date = ? AND window_id = ?`,
      [order.qty_total, order.qty_total, order.slot_date, windowId],
    );
  }
}

export async function listAvailability({ days = 14, startDate = null } = {}) {
  const settings = await getSettings();
  const s = getStorage();
  const first = startDate || shopDate(new Date());
  const n = Math.max(1, Math.min(60, Number(days) || 14));
  const last = addDays(first, n - 1);

  if (!s.readOnly) {
    await s.transaction(async (tx) => {
      for (let i = 0; i < n; i += 1) {
        await ensureSlotRows(tx, addDays(first, i), settings.capacity.windowList, settings.capacity.daily, settings.capacity.perWindow);
      }
    });
  }

  const { rows } = await s.query(
    'SELECT slot_date, window_id, capacity, booked FROM delivery_slots WHERE slot_date >= ? AND slot_date <= ?',
    [first, last],
  );
  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.slot_date)) byDate.set(r.slot_date, []);
    byDate.get(r.slot_date).push(r);
  }

  const today = shopDate(new Date());
  const maxDate = addDays(today, settings.capacity.maxDays);
  return Array.from({ length: n }, (_, i) => {
    const date = addDays(first, i);
    return dayAvailability({
      date,
      windows: settings.capacity.windowList,
      dayCapacity: settings.capacity.daily,
      perWindowCapacity: settings.capacity.perWindow,
      rows: byDate.get(date) || [],
      closedDays: settings.capacity.closedDays,
      minDate: today,
      maxDate,
    });
  });
}

/** Validate a requested delivery datetime against lead time; map it to a slot. */
export async function resolveDeliverySlot(deliveryAt, settings) {
  if (!deliveryAt) return null;
  const hours = (new Date(deliveryAt).getTime() - Date.now()) / 36e5;
  if (hours < settings.capacity.leadHours) {
    throw Object.assign(new Error(`Delivery must be at least ${settings.capacity.leadHours} hours from now`), { status: 400, code: 'DELIVERY_TOO_SOON' });
  }
  const date = shopDate(deliveryAt);
  const time = shopTime(deliveryAt);
  const window = windowForTime(time, settings.capacity.windowList);
  return { date, time, window: window ? window.id : null };
}

/* ----------------------------------------------------------------- orders */

async function nextOrderCode(tx) {
  if (tx.dialect === 'postgres') {
    const { rows } = await tx.query("UPDATE counters SET value = value + 1 WHERE name = 'order_code' RETURNING value");
    return `CG-${String(Number(rows[0].value)).padStart(4, '0')}`;
  }
  await tx.query("UPDATE counters SET value = value + 1 WHERE name = 'order_code'");
  const { rows } = await tx.query("SELECT value FROM counters WHERE name = 'order_code'");
  return `CG-${String(Number(rows[0].value)).padStart(4, '0')}`;
}

function queueNotifications(tx, order, settings, now) {
  const rendered = renderOrderMessages(order, settings);
  const rows = [];
  if (rendered.customer?.to) rows.push(rendered.customer);
  if (rendered.owner?.to) rows.push(rendered.owner);
  for (const msg of rows) {
    tx.query(
      `INSERT INTO notification_outbox (id, order_id, channel, audience, recipient, template, body, status, created_at)
       VALUES (?, ?, 'whatsapp', ?, ?, ?, ?, 'queued', ?)`,
      [`ntf_${crypto.randomUUID()}`, order.id, msg.template === 'new_order_alert' ? 'owner' : 'customer', msg.to, msg.template, msg.body, now],
    );
  }
  return rows.length;
}

/**
 * Insert order + items + customer rollup + capacity reservation + notification
 * outbox inside ONE transaction. Returns the stored order, or throws.
 */
export async function createOrder({
  customer, items, totals, status = 'pending', paymentMethod = 'demo', deliveryAt = null, notes = '',
}) {
  const s = assertWritable();
  const settings = await getSettings();
  const slot = await resolveDeliverySlot(deliveryAt, settings);
  const qtyTotal = items.reduce((n, it) => n + Number(it.quantity), 0);
  const now = new Date().toISOString();
  const orderId = `ord_${crypto.randomUUID()}`;

  await s.transaction(async (tx) => {
    const code = await nextOrderCode(tx);
    let cust = (await tx.query('SELECT * FROM customers WHERE phone = ?', [customer.phone])).rows[0];
    if (!cust) {
      cust = { id: `cus_${crypto.randomUUID()}` };
      await tx.query(
        'INSERT INTO customers (id, name, phone, email, orders, spent, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)',
        [cust.id, customer.name, customer.phone, customer.email || null, now],
      );
    }
    await tx.query(
      'UPDATE customers SET orders = orders + 1, spent = spent + ?, name = ?, email = COALESCE(?, email) WHERE id = ?',
      [totals.total, customer.name, customer.email || null, cust.id],
    );

    await tx.query(
      `INSERT INTO orders (id, code, customer_id, customer_name, customer_phone, customer_email, notes, currency,
        subtotal, rush_fee, delivery_fee, total, status, payment_method, delivery_at, slot_date, slot_window, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [orderId, code, cust.id, customer.name, customer.phone, customer.email || null, notes || '',
        totals.currency, totals.subtotal, totals.rushFee, totals.deliveryFee, totals.total, status, paymentMethod,
        deliveryAt, slot?.date || null, slot?.window || null, now, now],
    );

    for (const [i, it] of items.entries()) {
      await tx.query(
        `INSERT INTO order_items (id, order_id, product_id, name_ar, name_en, config_json, quantity, unit_price, line_total, line_no)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [`itm_${crypto.randomUUID()}`, orderId, it.productId, it.name.ar, it.name.en,
          JSON.stringify(it.config), it.quantity, it.unitPrice, it.unitPrice * it.quantity, i],
      );
    }
    await tx.query(
      'INSERT INTO order_events (id, order_id, status, actor, created_at) VALUES (?, ?, ?, ?, ?)',
      [`evt_${crypto.randomUUID()}`, orderId, status, 'system', now],
    );

    // Last step: a failed reservation rolls the whole order back. There is no
    // path in which a full slot leaves a stored order behind.
    if (slot) await reserveSlot(tx, slot, qtyTotal, settings);

    queueNotifications(tx, {
      id: orderId, code, customer, items, total: totals.total, currency: totals.currency, deliveryAt,
    }, settings, now);
  });

  return getOrder(orderId);
}

function hydrateOrderRow(row, items, events) {
  return {
    id: row.id,
    code: row.code,
    customer: { name: row.customer_name, phone: row.customer_phone, email: row.customer_email, id: row.customer_id },
    notes: row.notes,
    currency: row.currency,
    subtotal: Number(row.subtotal),
    rushFee: Number(row.rush_fee),
    deliveryFee: Number(row.delivery_fee),
    total: Number(row.total),
    status: row.status,
    paymentMethod: row.payment_method,
    deliveryAt: row.delivery_at,
    slot: row.slot_date ? { date: row.slot_date, window: row.slot_window } : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items: items.map((i) => ({
      id: i.id,
      productId: i.product_id,
      name: { ar: i.name_ar, en: i.name_en },
      config: typeof i.config_json === 'string' ? JSON.parse(i.config_json) : i.config_json,
      quantity: Number(i.quantity),
      unitPrice: Number(i.unit_price),
      lineTotal: Number(i.line_total),
    })),
    events: events.map((e) => ({ status: e.status, actor: e.actor, at: e.created_at })),
  };
}

async function hydrate(q, row) {
  if (!row) return null;
  const items = (await q.query('SELECT * FROM order_items WHERE order_id = ? ORDER BY line_no ASC, id ASC', [row.id])).rows;
  const events = (await q.query('SELECT * FROM order_events WHERE order_id = ? ORDER BY created_at ASC, id ASC', [row.id])).rows;
  return hydrateOrderRow(row, items, events);
}

export async function getOrder(idOrCode) {
  const s = getStorage();
  const { rows } = await s.query('SELECT * FROM orders WHERE id = ? OR code = ?', [idOrCode, idOrCode]);
  return hydrate(s, rows[0]);
}

export async function listOrders({ status, limit = 100, from = null, to = null } = {}) {
  const s = getStorage();
  const where = [];
  const params = [];
  if (status && status !== 'all') { where.push('status = ?'); params.push(status); }
  if (from) { where.push('substr(created_at,1,10) >= ?'); params.push(from); }
  if (to) { where.push('substr(created_at,1,10) <= ?'); params.push(to); }
  const sql = `SELECT * FROM orders${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, code DESC LIMIT ?`;
  params.push(Math.max(1, Math.min(1000, Number(limit) || 100)));
  const rows = (await s.query(sql, params)).rows;
  return Promise.all(rows.map((r) => hydrate(s, r)));
}

export async function setOrderStatus(id, status, actor = 'admin') {
  const s = assertWritable();
  if (!ORDER_STATUSES.includes(status)) {
    throw Object.assign(new Error('Unknown status'), { status: 400, code: 'BAD_STATUS' });
  }
  const now = new Date().toISOString();
  const { rows } = await s.query('SELECT * FROM orders WHERE id = ? OR code = ?', [id, id]);
  const row = rows[0];
  if (!row) return null;

  await s.transaction(async (tx) => {
    if (status === 'cancelled' && row.status !== 'cancelled' && !row.capacity_released) {
      const { rows: qty } = await tx.query('SELECT COALESCE(SUM(quantity),0) AS n FROM order_items WHERE order_id = ?', [row.id]);
      await releaseSlot(tx, { ...row, qty_total: Number(qty[0].n) });
      await tx.query('UPDATE orders SET capacity_released = 1 WHERE id = ?', [row.id]);
    }
    await tx.query('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?', [status, now, row.id]);
    await tx.query(
      'INSERT INTO order_events (id, order_id, status, actor, created_at) VALUES (?, ?, ?, ?, ?)',
      [`evt_${crypto.randomUUID()}`, row.id, status, actor, now],
    );
  });
  return getOrder(row.id);
}

export async function listCustomers() {
  const { rows } = await getStorage().query('SELECT * FROM customers ORDER BY spent DESC, created_at DESC');
  return rows.map((c) => ({
    id: c.id, name: c.name, phone: c.phone, email: c.email,
    orders: Number(c.orders), spent: Number(c.spent), createdAt: c.created_at,
  }));
}

export async function revenueSummary() {
  const s = getStorage();
  const paid = "('pending','confirmed','baking','ready','delivered')";
  const totals = (await s.query(`SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS revenue FROM orders WHERE status IN ${paid}`)).rows[0];
  const byStatus = (await s.query('SELECT status, COUNT(*) AS n, COALESCE(SUM(total),0) AS amount FROM orders GROUP BY status')).rows;
  const byDay = (await s.query(`SELECT substr(created_at,1,10) AS day, COUNT(*) AS n, COALESCE(SUM(total),0) AS amount
    FROM orders WHERE status IN ${paid} GROUP BY substr(created_at,1,10) ORDER BY day DESC LIMIT 14`)).rows;
  const topProducts = (await s.query(`SELECT product_id, name_en, name_ar, SUM(quantity) AS qty, SUM(line_total) AS amount
    FROM order_items GROUP BY product_id, name_en, name_ar ORDER BY qty DESC LIMIT 5`)).rows;
  const customers = Number((await s.query('SELECT COUNT(*) AS n FROM customers')).rows[0].n);
  const orders = Number(totals.orders);
  const revenue = Number(totals.revenue);
  return {
    currency: 'SAR',
    orders,
    revenue,
    avgOrder: orders ? Math.round(revenue / orders) : 0,
    customers,
    byStatus: Object.fromEntries(byStatus.map((x) => [x.status, { count: Number(x.n), amount: Number(x.amount) }])),
    byDay: byDay.map((d) => ({ day: d.day, n: Number(d.n), amount: Number(d.amount) })).reverse(),
    topProducts: topProducts.map((p) => ({ name: { ar: p.name_ar, en: p.name_en }, qty: Number(p.qty), amount: Number(p.amount) })),
  };
}

/** Orders for one shop-calendar day, with that day's capacity picture. */
export async function adminDay(date) {
  const s = getStorage();
  const [availability] = await listAvailability({ days: 1, startDate: date });
  const rows = (await s.query('SELECT * FROM orders WHERE slot_date = ? ORDER BY delivery_at ASC, code ASC', [date])).rows;
  const orders = await Promise.all(rows.map((r) => hydrate(s, r)));
  return { date, availability, orders };
}

export async function outboxForOrder(orderId) {
  const { rows } = await getStorage().query('SELECT * FROM notification_outbox WHERE order_id = ? ORDER BY created_at ASC', [orderId]);
  return rows.map((r) => ({
    id: r.id, channel: r.channel, audience: r.audience, recipient: r.recipient,
    template: r.template, body: r.body, status: r.status, createdAt: r.created_at, sentAt: r.sent_at,
  }));
}

/* ------------------------------------------------------------------- auth */

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

export async function ensureAdmin(username = process.env.ADMIN_USER || 'admin', password = process.env.ADMIN_PASSWORD || 'cake-admin-2026') {
  const s = assertWritable();
  const existing = (await s.query('SELECT * FROM admin_users WHERE username = ?', [username])).rows[0];
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  if (!existing) {
    await s.query('INSERT INTO admin_users (id, username, pass_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)',
      [`adm_${crypto.randomUUID()}`, username, hash, salt, new Date().toISOString()]);
    return { created: true, username };
  }
  await s.query('UPDATE admin_users SET pass_hash = ?, salt = ? WHERE id = ?', [hash, salt, existing.id]);
  return { created: false, username };
}

export async function verifyAdmin(username, password) {
  const row = (await getStorage().query('SELECT * FROM admin_users WHERE username = ?', [username])).rows[0];
  if (!row) {
    hashPassword(password, 'f'.repeat(32));
    return null;
  }
  const candidate = Buffer.from(hashPassword(password, row.salt), 'hex');
  const stored = Buffer.from(row.pass_hash, 'hex');
  if (candidate.length !== stored.length || !crypto.timingSafeEqual(candidate, stored)) return null;
  return { id: row.id, username: row.username };
}

export async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + 8 * 3600 * 1000);
  await assertWritable().query('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    [token, userId, now.toISOString(), expires.toISOString()]);
  return { token, expiresAt: expires.toISOString() };
}

export async function getSession(token) {
  if (!token) return null;
  const { rows } = await getStorage().query(
    'SELECT s.*, u.username FROM sessions s JOIN admin_users u ON u.id = s.user_id WHERE s.token = ?', [token],
  );
  const row = rows[0];
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    if (!getStorage().readOnly) {
      await getStorage().query('DELETE FROM sessions WHERE token = ?', [token]);
    }
    return null;
  }
  return { userId: row.user_id, username: row.username, expiresAt: row.expires_at };
}

export async function destroySession(token) {
  if (!token) return;
  await getStorage().query('DELETE FROM sessions WHERE token = ?', [token]);
}

export async function purgeExpiredSessions() {
  if (getStorage().readOnly) return;
  await getStorage().query('DELETE FROM sessions WHERE expires_at < ?', [new Date().toISOString()]);
}
