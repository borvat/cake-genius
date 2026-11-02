#!/usr/bin/env node
/**
 * Cake Genius server - zero runtime dependencies (Node core only).
 *
 * Responsibilities:
 *  - static file serving from ./public
 *  - JSON API (catalog, quote, assistant, orders, admin)
 *  - server-side validation + authorization on every privileged route
 *  - server-side re-pricing of every cart line (client prices are never trusted)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  openDb, getProduct, listProducts, createOrder, getOrder, listOrders, setOrderStatus,
  listCustomers, revenueSummary, ensureAdmin, verifyAdmin, createSession, getSession,
  destroySession, purgeExpiredSessions, updateProduct, dbPath,
} from './lib/db.js';
import { quote, publicRules, PricingError, CURRENCY } from './lib/pricing.js';
import { parse, suggest, buildReply } from './lib/assistant.js';
import { CATEGORIES, ORDER_STATUSES } from './lib/catalog.js';
import { lineTotals, isValidQty } from './public/lib/cart-math.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RENDER;
// Render injects the deployed commit; prefer it over a manually pinned value so
// /api/health always reports the code that is actually running.
const COMMIT = process.env.RENDER_GIT_COMMIT || process.env.APP_COMMIT || 'dev';
const VERSION = process.env.APP_VERSION || JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

openDb();
const adminInfo = ensureAdmin();
if (!process.env.ADMIN_PASSWORD && IS_PROD) {
  console.warn('[security] ADMIN_PASSWORD is not set while running in production: the documented development default is in use. Set a deployment-specific secret.');
}
purgeExpiredSessions();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'geolocation=(), camera=(), microphone=()',
  'Content-Security-Policy': [
    "default-src 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "connect-src 'self'",
    "font-src 'self' data:",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; '),
};

function send(res, status, body, headers = {}) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function sendText(res, status, text, headers = {}) {
  const payload = Buffer.from(text, 'utf8');
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': payload.length,
    ...headers,
  });
  res.end(payload);
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readJsonBody(req, limit = 128 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Payload too large'), { status: 413, code: 'PAYLOAD_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { status: 400, code: 'BAD_JSON' }));
      }
    });
    req.on('error', reject);
  });
}

/* ---------------- validation helpers ---------------- */

const PHONE_RE = /^\+?[0-9\s-]{9,18}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,20}$/;

function validName(name) {
  const s = String(name || '').trim();
  if (s.length < 2 || s.length > 60) return null;
  if (/[\u0000-\u001f<>]/.test(s)) return null;
  return s;
}

function validPhone(phone) {
  const s = String(phone || '').trim();
  if (!PHONE_RE.test(s)) return null;
  return s.replace(/[\s-]/g, '');
}

function validEmail(email) {
  if (!email) return null;
  const s = String(email).trim();
  return EMAIL_RE.test(s) && s.length <= 160 ? s : undefined;
}

function validDeliveryAt(value) {
  if (!value) return null;
  const t = new Date(value);
  if (!Number.isFinite(t.getTime())) throw badRequest('BAD_DELIVERY_DATE', 'Invalid delivery date');
  const hours = (t.getTime() - Date.now()) / 36e5;
  if (hours < 1) throw badRequest('DELIVERY_TOO_SOON', 'Delivery must be at least 1 hour from now');
  if (hours > 60 * 24) throw badRequest('DELIVERY_TOO_FAR', 'Delivery cannot be more than 60 days ahead');
  return t.toISOString();
}

function badRequest(code, message) {
  return Object.assign(new Error(message), { status: 400, code });
}

/* ---------------- login rate limiting ---------------- */

const loginAttempts = new Map();
function loginBlocked(ip) {
  const rec = loginAttempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.first > 10 * 60 * 1000) {
    loginAttempts.delete(ip);
    return false;
  }
  return rec.count >= 6;
}
function noteLoginFailure(ip) {
  const rec = loginAttempts.get(ip);
  if (!rec || Date.now() - rec.first > 10 * 60 * 1000) {
    loginAttempts.set(ip, { count: 1, first: Date.now() });
  } else {
    rec.count += 1;
  }
}
function clearLoginFailures(ip) {
  loginAttempts.delete(ip);
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}

/* ---------------- auth guard ---------------- */

function requireAdmin(req, res) {
  const token = parseCookies(req).cg_session;
  const session = getSession(token);
  if (!session) {
    send(res, 401, { error: 'UNAUTHORIZED', message: 'Authentication required' });
    return null;
  }
  return session;
}

/* ---------------- static ---------------- */

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel === '/admin' || rel === '/admin/') rel = '/admin.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // SPA fallback for unknown non-API paths
      const index = path.join(PUBLIC_DIR, 'index.html');
      fs.readFile(index, (e2, buf) => {
        if (e2) return sendText(res, 404, 'Not found');
        res.writeHead(200, {
          ...SECURITY_HEADERS,
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Length': buf.length,
          'Cache-Control': 'no-cache',
        });
        res.end(buf);
      });
      return;
    }
    const etag = `W/"${stat.size}-${Math.floor(stat.mtimeMs)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ...SECURITY_HEADERS, ETag: etag });
      res.end();
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      ETag: etag,
      'Last-Modified': new Date(stat.mtimeMs).toUTCString(),
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

/* ---------------- API ---------------- */

async function handleApi(req, res, url) {
  const p = url.pathname;
  const method = req.method;

  if (p === '/api/health' && method === 'GET') {
    return send(res, 200, {
      ok: true,
      service: 'cake-genius',
      version: VERSION,
      commit: COMMIT.slice(0, 40),
      uptimeSeconds: Math.round(process.uptime()),
      ordersStored: listOrders({ limit: 1000 }).length,
      db: path.basename(dbPath()),
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    });
  }

  if (p === '/api/config' && method === 'GET') {
    return send(res, 200, {
      currency: CURRENCY,
      rules: publicRules(),
      categories: CATEGORIES,
      statuses: ORDER_STATUSES,
      assistant: { engine: 'rule-based-nlu-v1', externalProvider: false },
    });
  }

  if (p === '/api/products' && method === 'GET') {
    const category = url.searchParams.get('category') || 'all';
    return send(res, 200, { products: listProducts({ category }), categories: CATEGORIES });
  }

  if (p.startsWith('/api/products/') && method === 'GET') {
    const id = p.split('/')[3];
    const product = getProduct(id);
    if (!product) return send(res, 404, { error: 'NOT_FOUND', message: 'Product not found' });
    return send(res, 200, { product });
  }

  if (p === '/api/quote' && method === 'POST') {
    const body = await readJsonBody(req);
    const product = getProduct(body.productId);
    if (!product) return send(res, 404, { error: 'PRODUCT_NOT_FOUND', message: 'Unknown product' });
    try {
      const deliveryAt = validDeliveryAt(body.config?.deliveryAt);
      const q = quote(product, { ...body.config, deliveryAt });
      return send(res, 200, { quote: q });
    } catch (err) {
      if (err instanceof PricingError || err.status === 400) {
        return send(res, 400, { error: err.code || 'BAD_REQUEST', message: err.message });
      }
      throw err;
    }
  }

  if (p === '/api/assistant' && method === 'POST') {
    const body = await readJsonBody(req);
    const message = String(body.message || '').slice(0, 500).trim();
    if (message.length < 2) return send(res, 400, { error: 'EMPTY_MESSAGE', message: 'Please describe what you need' });
    const constraints = parse(message).constraints;
    const result = suggest(listProducts({}), constraints, 3);
    const reply = buildReply(result.suggestions, constraints, body.lang || 'ar');
    return send(res, 200, {
      reply,
      understood: constraints,
      suggestions: result.suggestions,
      cheapestSeen: result.cheapestSeen,
      engine: 'rule-based-nlu-v1',
      note: 'Prices are computed by the same server-side pricing engine used at checkout.',
    });
  }

  if (p === '/api/orders' && method === 'POST') {
    const body = await readJsonBody(req);
    const name = validName(body.customer?.name);
    const phone = validPhone(body.customer?.phone);
    const email = validEmail(body.customer?.email);
    if (!name) return send(res, 400, { error: 'BAD_NAME', message: 'Name must be 2-60 characters' });
    if (!phone) return send(res, 400, { error: 'BAD_PHONE', message: 'Phone must contain 9-15 digits' });
    if (email === undefined) return send(res, 400, { error: 'BAD_EMAIL', message: 'Invalid email address' });

    const cart = Array.isArray(body.items) ? body.items : [];
    if (!cart.length) return send(res, 400, { error: 'EMPTY_CART', message: 'Cart is empty' });
    if (cart.length > 10) return send(res, 400, { error: 'CART_TOO_LARGE', message: 'Maximum 10 lines per order' });

    const deliveryAt = validDeliveryAt(body.deliveryAt);
    const priced = [];
    let rushFee = 0;
    let deliveryFee = 0;
    let cakesSubtotal = 0;

    for (const line of cart) {
      const product = getProduct(line.productId);
      if (!product) return send(res, 400, { error: 'PRODUCT_NOT_FOUND', message: `Unknown product ${line.productId}` });
      // Quantity is validated, never trusted: only a true integer 1..20 is accepted.
      if (!isValidQty(line.quantity === undefined ? 1 : line.quantity)) {
        return send(res, 400, { error: 'BAD_QUANTITY', message: 'Quantity must be an integer between 1 and 20' });
      }
      const quantity = Number(line.quantity === undefined ? 1 : line.quantity);
      let q;
      try {
        q = quote(product, { ...line.config, deliveryAt });
      } catch (err) {
        return send(res, 400, { error: err.code || 'BAD_CONFIG', message: err.message });
      }
      // Server-side line math: unit price comes from the pricing engine, quantity
      // from the validated request. Any unitPrice/total sent by the browser is ignored.
      const lt = lineTotals(q.cakeSubtotal + q.rushFee, q.deliveryFee, quantity);
      rushFee += q.rushFee * lt.quantity;
      deliveryFee += lt.delivery;
      cakesSubtotal += lt.cakes;
      priced.push({
        productId: product.id,
        name: product.name,
        config: q.config,
        quantity: lt.quantity,
        unitPrice: lt.unitPrice,
        lineTotal: lt.total,
        breakdown: q.breakdown,
      });
    }

    const subtotal = cakesSubtotal;
    const total = subtotal + deliveryFee;
    if (total <= 0) return send(res, 400, { error: 'BAD_TOTAL', message: 'Invalid order total' });

    const order = createOrder({
      customer: { name, phone, email: email || null },
      items: priced,
      totals: { currency: CURRENCY, rushFee, deliveryFee, total },
      status: 'pending',
      paymentMethod: 'demo',
      deliveryAt,
      notes: String(body.notes || '').slice(0, 400),
    });
    return send(res, 201, { order });
  }

  if (p === '/api/orders/lookup' && method === 'POST') {
    const body = await readJsonBody(req);
    const phone = validPhone(body.phone);
    const code = String(body.code || '').trim().toUpperCase();
    if (!phone || !code) return send(res, 400, { error: 'BAD_LOOKUP', message: 'Code and phone are required' });
    const order = getOrder(code);
    if (!order || order.customer.phone !== phone) {
      return send(res, 404, { error: 'NOT_FOUND', message: 'No order matches that code and phone' });
    }
    return send(res, 200, { order });
  }

  /* ---------- admin ---------- */

  if (p === '/api/admin/login' && method === 'POST') {
    const ip = clientIp(req);
    if (loginBlocked(ip)) {
      return send(res, 429, { error: 'RATE_LIMITED', message: 'Too many attempts. Try again in 10 minutes.' });
    }
    const body = await readJsonBody(req);
    const user = verifyAdmin(String(body.username || ''), String(body.password || ''));
    if (!user) {
      noteLoginFailure(ip);
      return send(res, 401, { error: 'INVALID_CREDENTIALS', message: 'Wrong username or password' });
    }
    clearLoginFailures(ip);
    const session = createSession(user.id);
    const secure = (req.headers['x-forwarded-proto'] || '').includes('https');
    res.setHeader('Set-Cookie', `cg_session=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${8 * 3600}${secure ? '; Secure' : ''}`);
    return send(res, 200, { ok: true, user: { username: user.username }, expiresAt: session.expiresAt });
  }

  if (p === '/api/admin/logout' && method === 'POST') {
    destroySession(parseCookies(req).cg_session);
    res.setHeader('Set-Cookie', 'cg_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return send(res, 200, { ok: true });
  }

  if (p === '/api/admin/me' && method === 'GET') {
    const session = requireAdmin(req, res);
    if (!session) return;
    return send(res, 200, { user: { username: session.username }, expiresAt: session.expiresAt });
  }

  if (p === '/api/admin/stats' && method === 'GET') {
    const session = requireAdmin(req, res);
    if (!session) return;
    return send(res, 200, { stats: revenueSummary(), statuses: ORDER_STATUSES });
  }

  if (p === '/api/admin/orders' && method === 'GET') {
    const session = requireAdmin(req, res);
    if (!session) return;
    const status = url.searchParams.get('status') || 'all';
    if (status !== 'all' && !ORDER_STATUSES.includes(status)) {
      return send(res, 400, { error: 'BAD_STATUS', message: 'Unknown status filter' });
    }
    return send(res, 200, { orders: listOrders({ status }) });
  }

  if (p.startsWith('/api/admin/orders/') && method === 'PATCH') {
    const session = requireAdmin(req, res);
    if (!session) return;
    const id = p.split('/')[4];
    const body = await readJsonBody(req);
    if (!ORDER_STATUSES.includes(body.status)) {
      return send(res, 400, { error: 'BAD_STATUS', message: 'Unknown status' });
    }
    const order = setOrderStatus(id, body.status, session.username);
    if (!order) return send(res, 404, { error: 'NOT_FOUND', message: 'Order not found' });
    return send(res, 200, { order });
  }

  if (p === '/api/admin/customers' && method === 'GET') {
    const session = requireAdmin(req, res);
    if (!session) return;
    return send(res, 200, { customers: listCustomers() });
  }

  if (p === '/api/admin/products' && method === 'GET') {
    const session = requireAdmin(req, res);
    if (!session) return;
    return send(res, 200, { products: listProducts({}) });
  }

  if (p.startsWith('/api/admin/products/') && method === 'PATCH') {
    const session = requireAdmin(req, res);
    if (!session) return;
    const id = p.split('/')[4];
    const body = await readJsonBody(req);
    const patch = {};
    if (body.basePrice !== undefined) {
      const v = Number(body.basePrice);
      if (!Number.isFinite(v) || v < 20 || v > 5000) {
        return send(res, 400, { error: 'BAD_PRICE', message: 'Base price must be between 20 and 5000' });
      }
      patch.basePrice = Math.round(v);
    }
    if (body.active !== undefined) patch.active = !!body.active;
    if (!getProduct(id)) return send(res, 404, { error: 'NOT_FOUND', message: 'Product not found' });
    const product = updateProduct(id, patch);
    return send(res, 200, { product });
  }

  return send(res, 404, { error: 'NOT_FOUND', message: 'Unknown endpoint' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendText(res, 405, 'Method not allowed');
    }
    serveStatic(req, res, url.pathname);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('[error]', err);
    if (!res.headersSent) {
      send(res, status, {
        error: err.code || 'INTERNAL_ERROR',
        message: status >= 500 ? 'Something went wrong on our side' : err.message,
      });
    } else {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Cake Genius listening on http://${HOST}:${PORT}`);
  console.log(`build: v${VERSION} @ ${COMMIT}`);
  console.log(`DB: ${dbPath()}  admin user: ${adminInfo.username} (${adminInfo.created ? 'created' : 'synced'})`);
  console.log(`orders on disk at startup: ${listOrders({ limit: 1000 }).length}`);
});

const shutdown = (sig) => {
  console.log(`[shutdown] ${sig}`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
