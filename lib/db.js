/**
 * SQLite persistence layer (node:sqlite, built into Node 22 - no npm deps).
 *
 * The file path comes from DB_PATH so the same code runs locally and on a host
 * that mounts a persistent volume. WAL is enabled and every write is committed
 * synchronously before the HTTP response is sent, so a killed process cannot
 * lose an acknowledged order.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { PRODUCTS } from './catalog.js';

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'cake.db');

let db;

export function openDb(dbPath = DB_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate();
  seedProducts();
  return db;
}

export function getDb() {
  if (!db) openDb();
  return db;
}

export function dbPath() {
  return DB_PATH;
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id          TEXT PRIMARY KEY,
      slug        TEXT NOT NULL UNIQUE,
      name_ar     TEXT NOT NULL,
      name_en     TEXT NOT NULL,
      desc_ar     TEXT NOT NULL,
      desc_en     TEXT NOT NULL,
      category    TEXT NOT NULL,
      base_price  INTEGER NOT NULL,
      image       TEXT NOT NULL,
      tags        TEXT NOT NULL,
      popular     INTEGER NOT NULL DEFAULT 0,
      active      INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS customers (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      phone       TEXT NOT NULL UNIQUE,
      email       TEXT,
      orders      INTEGER NOT NULL DEFAULT 0,
      spent       INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id            TEXT PRIMARY KEY,
      code          TEXT NOT NULL UNIQUE,
      customer_id   TEXT NOT NULL REFERENCES customers(id),
      customer_name TEXT NOT NULL,
      customer_phone TEXT NOT NULL,
      customer_email TEXT,
      notes         TEXT,
      currency      TEXT NOT NULL,
      subtotal      INTEGER NOT NULL,
      rush_fee      INTEGER NOT NULL,
      delivery_fee  INTEGER NOT NULL,
      total         INTEGER NOT NULL,
      status        TEXT NOT NULL,
      payment_method TEXT NOT NULL,
      delivery_at   TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id            TEXT PRIMARY KEY,
      order_id      TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      product_id    TEXT NOT NULL,
      name_ar       TEXT NOT NULL,
      name_en       TEXT NOT NULL,
      config_json   TEXT NOT NULL,
      quantity      INTEGER NOT NULL,
      unit_price    INTEGER NOT NULL,
      line_total    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS order_events (
      id         TEXT PRIMARY KEY,
      order_id   TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      status     TEXT NOT NULL,
      actor      TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS admin_users (
      id         TEXT PRIMARY KEY,
      username   TEXT NOT NULL UNIQUE,
      pass_hash  TEXT NOT NULL,
      salt       TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_events_order ON order_events(order_id);
  `);
}

function seedProducts() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM products').get().n;
  if (count > 0) return;
  const insert = db.prepare(`
    INSERT INTO products (id, slug, name_ar, name_en, desc_ar, desc_en, category, base_price, image, tags, popular, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);
  for (const p of PRODUCTS) {
    insert.run(
      p.id, p.slug, p.name.ar, p.name.en, p.desc.ar, p.desc.en,
      p.category, p.basePrice, p.image, p.tags.join(','), p.popular,
    );
  }
}

export function rowToProduct(r) {
  return {
    id: r.id,
    slug: r.slug,
    name: { ar: r.name_ar, en: r.name_en },
    desc: { ar: r.desc_ar, en: r.desc_en },
    category: r.category,
    basePrice: r.base_price,
    image: r.image,
    tags: r.tags ? r.tags.split(',') : [],
    popular: !!r.popular,
  };
}

export function listProducts({ category } = {}) {
  const d = getDb();
  const rows = category && category !== 'all'
    ? d.prepare('SELECT * FROM products WHERE active = 1 AND category = ? ORDER BY popular DESC, base_price ASC').all(category)
    : d.prepare('SELECT * FROM products WHERE active = 1 ORDER BY popular DESC, base_price ASC').all();
  return rows.map(rowToProduct);
}

export function getProduct(id) {
  const r = getDb().prepare('SELECT * FROM products WHERE id = ? AND active = 1').get(id);
  return r ? rowToProduct(r) : null;
}

export function updateProduct(id, { basePrice, active }) {
  const d = getDb();
  if (typeof basePrice === 'number') {
    d.prepare('UPDATE products SET base_price = ? WHERE id = ?').run(basePrice, id);
  }
  if (typeof active === 'boolean') {
    d.prepare('UPDATE products SET active = ? WHERE id = ?').run(active ? 1 : 0, id);
  }
  return getProductRow(id);
}

function getProductRow(id) {
  const r = getDb().prepare('SELECT * FROM products WHERE id = ?').get(id);
  return r ? rowToProduct(r) : null;
}

export function nextOrderCode() {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM orders").get();
  const seq = String(row.n + 1001).padStart(4, '0');
  return `CG-${seq}`;
}

/** Insert order + items + customer rollup atomically. Returns the stored order. */
export function createOrder({ customer, items, totals, status = 'pending', paymentMethod = 'demo', deliveryAt = null, notes = '' }) {
  const d = getDb();
  const now = new Date().toISOString();
  const orderId = 'ord_' + crypto.randomUUID();
  const code = nextOrderCode();

  d.exec('BEGIN IMMEDIATE');
  try {
    let cust = d.prepare('SELECT * FROM customers WHERE phone = ?').get(customer.phone);
    if (!cust) {
      cust = {
        id: 'cus_' + crypto.randomUUID(),
        name: customer.name,
        phone: customer.phone,
        email: customer.email || null,
        orders: 0,
        spent: 0,
        created_at: now,
      };
      d.prepare('INSERT INTO customers (id, name, phone, email, orders, spent, created_at) VALUES (?, ?, ?, ?, 0, 0, ?)')
        .run(cust.id, cust.name, cust.phone, cust.email, now);
    }
    d.prepare('UPDATE customers SET orders = orders + 1, spent = spent + ?, name = ?, email = COALESCE(?, email) WHERE id = ?')
      .run(totals.total, customer.name, customer.email || null, cust.id);

    const subtotal = items.reduce((s, it) => s + it.unitPrice * it.quantity, 0);
    d.prepare(`
      INSERT INTO orders (id, code, customer_id, customer_name, customer_phone, customer_email, notes, currency,
        subtotal, rush_fee, delivery_fee, total, status, payment_method, delivery_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orderId, code, cust.id, customer.name, customer.phone, customer.email || null, notes || '',
      totals.currency, subtotal, totals.rushFee, totals.deliveryFee, totals.total, status, paymentMethod,
      deliveryAt, now, now,
    );

    const insertItem = d.prepare(`
      INSERT INTO order_items (id, order_id, product_id, name_ar, name_en, config_json, quantity, unit_price, line_total)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const it of items) {
      insertItem.run(
        'itm_' + crypto.randomUUID(), orderId, it.productId, it.name.ar, it.name.en,
        JSON.stringify(it.config), it.quantity, it.unitPrice, it.unitPrice * it.quantity,
      );
    }
    d.prepare('INSERT INTO order_events (id, order_id, status, actor, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('evt_' + crypto.randomUUID(), orderId, status, 'system', now);

    d.exec('COMMIT');
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
  return getOrder(orderId);
}

function hydrateOrder(row) {
  if (!row) return null;
  const d = getDb();
  const items = d.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY rowid').all(row.id).map((i) => ({
    id: i.id,
    productId: i.product_id,
    name: { ar: i.name_ar, en: i.name_en },
    config: JSON.parse(i.config_json),
    quantity: i.quantity,
    unitPrice: i.unit_price,
    lineTotal: i.line_total,
  }));
  const events = d.prepare('SELECT * FROM order_events WHERE order_id = ? ORDER BY created_at ASC').all(row.id)
    .map((e) => ({ status: e.status, actor: e.actor, at: e.created_at }));
  return {
    id: row.id,
    code: row.code,
    customer: { name: row.customer_name, phone: row.customer_phone, email: row.customer_email, id: row.customer_id },
    notes: row.notes,
    currency: row.currency,
    subtotal: row.subtotal,
    rushFee: row.rush_fee,
    deliveryFee: row.delivery_fee,
    total: row.total,
    status: row.status,
    paymentMethod: row.payment_method,
    deliveryAt: row.delivery_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items,
    events,
  };
}

export function getOrder(idOrCode) {
  const d = getDb();
  const row = d.prepare('SELECT * FROM orders WHERE id = ? OR code = ?').get(idOrCode, idOrCode);
  return hydrateOrder(row);
}

export function listOrders({ status, limit = 100 } = {}) {
  const d = getDb();
  const rows = status && status !== 'all'
    ? d.prepare('SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit)
    : d.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT ?').all(limit);
  return rows.map(hydrateOrder);
}

export function setOrderStatus(id, status, actor = 'admin') {
  const d = getDb();
  const now = new Date().toISOString();
  const row = d.prepare('SELECT id FROM orders WHERE id = ? OR code = ?').get(id, id);
  if (!row) return null;
  d.prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?').run(status, now, row.id);
  d.prepare('INSERT INTO order_events (id, order_id, status, actor, created_at) VALUES (?, ?, ?, ?, ?)')
    .run('evt_' + crypto.randomUUID(), row.id, status, actor, now);
  return getOrder(row.id);
}

export function listCustomers() {
  return getDb().prepare('SELECT * FROM customers ORDER BY spent DESC, created_at DESC').all()
    .map((c) => ({ id: c.id, name: c.name, phone: c.phone, email: c.email, orders: c.orders, spent: c.spent, createdAt: c.created_at }));
}

export function revenueSummary() {
  const d = getDb();
  const paidStatuses = "('pending','confirmed','baking','ready','delivered')";
  const totals = d.prepare(`SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS revenue FROM orders WHERE status IN ${paidStatuses}`).get();
  const byStatus = d.prepare('SELECT status, COUNT(*) AS n, COALESCE(SUM(total),0) AS amount FROM orders GROUP BY status').all();
  const byDay = d.prepare(`SELECT substr(created_at,1,10) AS day, COUNT(*) AS n, COALESCE(SUM(total),0) AS amount
    FROM orders WHERE status IN ${paidStatuses} GROUP BY day ORDER BY day DESC LIMIT 14`).all();
  const topProducts = d.prepare(`SELECT name_en, name_ar, SUM(quantity) AS qty, SUM(line_total) AS amount
    FROM order_items GROUP BY product_id ORDER BY qty DESC LIMIT 5`).all();
  const customers = d.prepare('SELECT COUNT(*) AS n FROM customers').get().n;
  return {
    currency: 'SAR',
    orders: totals.orders,
    revenue: totals.revenue,
    avgOrder: totals.orders ? Math.round(totals.revenue / totals.orders) : 0,
    customers,
    byStatus: Object.fromEntries(byStatus.map((s) => [s.status, { count: s.n, amount: s.amount }])),
    byDay: byDay.reverse(),
    topProducts: topProducts.map((p) => ({ name: { ar: p.name_ar, en: p.name_en }, qty: p.qty, amount: p.amount })),
  };
}

/* ---------------- admin auth ---------------- */

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

export function ensureAdmin(username = process.env.ADMIN_USER || 'admin', password = process.env.ADMIN_PASSWORD || 'cake-admin-2026') {
  const d = getDb();
  const existing = d.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  if (!existing) {
    d.prepare('INSERT INTO admin_users (id, username, pass_hash, salt, created_at) VALUES (?, ?, ?, ?, ?)')
      .run('adm_' + crypto.randomUUID(), username, hash, salt, new Date().toISOString());
    return { created: true, username };
  }
  // Keep the stored hash in sync with the configured password (env is source of truth).
  d.prepare('UPDATE admin_users SET pass_hash = ?, salt = ? WHERE id = ?').run(hash, salt, existing.id);
  return { created: false, username };
}

export function verifyAdmin(username, password) {
  const row = getDb().prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
  if (!row) {
    // Constant-ish work for unknown users to avoid a trivial timing oracle.
    hashPassword(password, 'f'.repeat(32));
    return null;
  }
  const candidate = Buffer.from(hashPassword(password, row.salt), 'hex');
  const stored = Buffer.from(row.pass_hash, 'hex');
  if (candidate.length !== stored.length || !crypto.timingSafeEqual(candidate, stored)) return null;
  return { id: row.id, username: row.username };
}

export function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + 8 * 3600 * 1000);
  getDb().prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, now.toISOString(), expires.toISOString());
  return { token, expiresAt: expires.toISOString() };
}

export function getSession(token) {
  if (!token) return null;
  const row = getDb().prepare('SELECT s.*, u.username FROM sessions s JOIN admin_users u ON u.id = s.user_id WHERE s.token = ?').get(token);
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    getDb().prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return { userId: row.user_id, username: row.username, expiresAt: row.expires_at };
}

export function destroySession(token) {
  if (!token) return;
  getDb().prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function purgeExpiredSessions() {
  getDb().prepare('DELETE FROM sessions WHERE expires_at < ?').run(new Date().toISOString());
}
