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
  openDb, getProduct, getProductForAdmin, listProducts, createProduct, updateProduct,
  createOrder, getOrder, listOrders, setOrderStatus, listCustomers, revenueSummary,
  ensureAdmin, verifyAdmin, createSession, getSession, destroySession, purgeExpiredSessions,
  dbPath, dbInfo, getSettings, setSettings, listAvailability, adminDay, outboxForOrder,
} from './lib/db.js';
import { quote, publicRules, PricingError, CURRENCY } from './lib/pricing.js';
import { parse, suggest, buildReply } from './lib/assistant.js';
import {
  design, aiAvailable, aiModel, aiUsage, aiGuardConfig,
  checkAiRateLimit, acquireAiSlot, releaseAiSlot,
} from './lib/ai-assistant.js';
import { renderOrderMessages, channelStatus, whatsappLink } from './lib/notify.js';
import { csvBuffer } from './lib/csv.js';
import { CATEGORIES, ORDER_STATUSES } from './lib/catalog.js';
import { parseTrustedProxies, resolveClientIp } from './lib/client-ip.js';
import { lineTotals, isValidQty } from './public/lib/cart-math.js';
import { shopDate } from './lib/capacity.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const IS_PROD = process.env.NODE_ENV === 'production' || !!process.env.RENDER;
// Render injects the deployed commit; prefer it over a manually pinned value so
// /api/health always reports the code that is actually running.
const COMMIT = process.env.RENDER_GIT_COMMIT || process.env.APP_COMMIT || 'dev';
const VERSION = process.env.APP_VERSION || JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;

const HAS_DATABASE_URL = !!process.env.DATABASE_URL;
const READ_ONLY = process.env.READ_ONLY === '1';

await openDb();
const adminInfo = READ_ONLY
  ? { created: false, username: process.env.ADMIN_USER || 'admin' }
  : await ensureAdmin();
if (!process.env.ADMIN_PASSWORD && IS_PROD && !READ_ONLY) {
  console.warn('[security] ADMIN_PASSWORD is not set while running in production: the documented development default is in use. Set a deployment-specific secret.');
}
await purgeExpiredSessions();
const STORE = dbInfo();

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
    "img-src 'self' data: https:",
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

function sendAttachment(res, buffer, filename, contentType) {
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': contentType,
    'Content-Length': buffer.length,
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Cache-Control': 'no-store',
  });
  res.end(buffer);
}

const CATEGORY_IDS = CATEGORIES.filter((c) => c.id !== 'all').map((c) => c.id);

/**
 * Validate a product create/update. Returns { value } or { error }.
 * Image is either a local /img/ path or an absolute https URL: a product can
 * never point at javascript:, data: or a protocol-relative host.
 */
function parseProductInput(body = {}, { partial = false } = {}) {
  const out = {};
  const fail = (m) => ({ error: m });
  const text = (v, min, max) => {
    const s = String(v ?? '').trim();
    if (s.length < min || s.length > max) return null;
    if (/[<>]/.test(s)) return null;
    return s;
  };

  if (!partial || body.slug !== undefined) {
    const slug = String(body.slug ?? '').trim().toLowerCase();
    if (!/^[a-z0-9-]{3,40}$/.test(slug)) return fail('slug must be 3-40 characters: a-z, 0-9 or -');
    out.slug = slug;
  }
  const fields = [
    ['nameAr', 2, 80], ['nameEn', 2, 80], ['descAr', 2, 400], ['descEn', 2, 400],
  ];
  for (const [key, min, max] of fields) {
    if (partial && body[key] === undefined) continue;
    const v = text(body[key], min, max);
    if (!v) return fail(`${key} must be ${min}-${max} characters without < or >`);
    out[key] = v;
  }
  if (!partial || body.category !== undefined) {
    if (!CATEGORY_IDS.includes(body.category)) return fail(`category must be one of: ${CATEGORY_IDS.join(', ')}`);
    out.category = body.category;
  }
  if (!partial || body.basePrice !== undefined) {
    const v = Number(body.basePrice);
    if (!Number.isFinite(v) || v < 20 || v > 5000) return fail('basePrice must be between 20 and 5000');
    out.basePrice = Math.round(v);
  }
  if (body.image !== undefined) {
    const img = String(body.image).trim();
    if (!(/^\/img\/[A-Za-z0-9._/-]+$/.test(img) || /^https:\/\/[^\s"'<>]+$/.test(img))) {
      return fail('image must be a /img/... path or an https:// URL');
    }
    out.image = img;
  } else if (!partial) {
    out.image = '/img/celebrate.svg';
  }
  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || body.tags.length > 8) return fail('tags must be an array of at most 8 strings');
    const tags = body.tags.map((t) => String(t).trim()).filter(Boolean);
    if (tags.some((t) => t.length > 20 || /[<>,]/.test(t))) return fail('each tag must be 1-20 characters without < > ,');
    out.tags = tags;
  }
  for (const key of ['popular', 'active']) {
    if (body[key] !== undefined) out[key] = !!body[key];
  }
  if (!partial) {
    if (out.tags === undefined) out.tags = [];
    if (out.active === undefined) out.active = true;
  }
  return { value: out };
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

// Trusted reverse proxies (exact IP or CIDR). X-Forwarded-For is trusted ONLY when the
// direct peer matches one of these — never on NODE_ENV=production alone (an exposed app
// would then trust attacker-supplied headers). Render operators must list Render's proxy
// IPs here; see README §7.
const TRUSTED_PROXIES = parseTrustedProxies(process.env.TRUSTED_PROXIES);

function clientIp(req) {
  return resolveClientIp(req.socket.remoteAddress, req.headers['x-forwarded-for'], TRUSTED_PROXIES);
}

/* ---------------- auth guard ---------------- */

async function requireAdmin(req, res) {
  const token = parseCookies(req).cg_session;
  const session = await getSession(token);
  if (!session) {
    send(res, 401, { error: 'UNAUTHORIZED', message: 'Authentication required' });
    return null;
  }
  return session;
}

/* ---------------- static ---------------- */

function escAttr(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Social + search metadata, generated from live catalog and settings instead of
 * being hardcoded: prices an admin changes appear in JSON-LD immediately.
 */
function buildSeo({ base, settings, products }) {
  const shopName = settings.shop.nameAr || settings.shop.name;
  const title = `${shopName} | كيك مخصص بتسعير لحظي`;
  const description = 'كيك مخصص يُصنع على مقاسك: اختر الحجم والنكهة والحشوة والتصميم، شاهد السعر قبل الطلب، واختر موعد التسليم.';
  const image = `${base}/img/og-image.png`;
  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'Bakery',
        '@id': `${base}/#bakery`,
        name: settings.shop.name,
        alternateName: settings.shop.nameAr,
        url: `${base}/`,
        image,
        ...(settings.shop.phone ? { telephone: settings.shop.phone } : {}),
        priceRange: 'SAR 145-1200',
        servesCuisine: 'Cake',
        currenciesAccepted: 'SAR',
        paymentAccepted: 'Cash, Card',
        address: {
          '@type': 'PostalAddress',
          addressLocality: settings.shop.city || 'الرياض',
          addressCountry: 'SA',
        },
      },
      {
        '@type': 'ItemList',
        name: 'Cake menu',
        itemListElement: products.slice(0, 12).map((p, i) => ({
          '@type': 'ListItem',
          position: i + 1,
          item: {
            '@type': 'Product',
            name: p.name.ar,
            alternateName: p.name.en,
            image: p.image.startsWith('http') ? p.image : `${base}${p.image}`,
            description: p.desc.ar,
            offers: {
              '@type': 'Offer',
              price: p.basePrice,
              priceCurrency: 'SAR',
              availability: 'https://schema.org/InStock',
              url: `${base}/`,
            },
          },
        })),
      },
    ],
  };
  const tags = [
    `<link rel="canonical" href="${escAttr(base)}/" />`,
    '<meta property="og:type" content="website" />',
    `<meta property="og:site_name" content="${escAttr(settings.shop.name)}" />`,
    `<meta property="og:title" content="${escAttr(title)}" />`,
    `<meta property="og:description" content="${escAttr(description)}" />`,
    `<meta property="og:image" content="${escAttr(image)}" />`,
    '<meta property="og:image:width" content="1200" />',
    '<meta property="og:image:height" content="630" />',
    `<meta property="og:url" content="${escAttr(base)}/" />`,
    '<meta property="og:locale" content="ar_SA" />',
    '<meta property="og:locale:alternate" content="en_US" />',
    '<meta name="twitter:card" content="summary_large_image" />',
    `<meta name="twitter:title" content="${escAttr(title)}" />`,
    `<meta name="twitter:description" content="${escAttr(description)}" />`,
    `<meta name="twitter:image" content="${escAttr(image)}" />`,
    `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`,
  ].join('\n  ');
  return { tags, canonical: `${base}/`, image };
}

function baseUrl(req) {
  const host = req.headers.host || 'localhost';
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  return (process.env.PUBLIC_URL || `${proto}://${host}`).replace(/\/+$/, '');
}

async function serveIndex(req, res) {
  const html = await fs.promises.readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  const base = baseUrl(req);
  const [settings, products] = await Promise.all([getSettings(), listProducts({})]);
  const { tags } = buildSeo({ base, settings, products });
  const body = Buffer.from(html.replace('<!--SEO-->', tags), 'utf8');
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function sendXml(res, status, xml) {
  const payload = Buffer.from(xml, 'utf8');
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/xml; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'public, max-age=600',
  });
  res.end(payload);
}

async function serveSitemap(req, res) {
  const base = baseUrl(req);
  const products = await listProducts({});
  const urls = [
    { loc: `${base}/`, priority: '1.0' },
    ...products.map((p) => ({ loc: `${base}/?cake=${encodeURIComponent(p.slug)}`, priority: '0.7' })),
  ];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u.loc.replace(/&/g, '&amp;')}</loc><changefreq>weekly</changefreq><priority>${u.priority}</priority></url>`).join('\n')}
</urlset>`;
  return sendXml(res, 200, xml);
}

function serveStatic(req, res, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath.split('?')[0]);
  } catch {
    return sendText(res, 400, 'Bad request');
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel === '/admin' || rel === '/admin/') rel = '/admin.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      // A missing asset (has an extension) is a real 404, not an HTML page —
      // otherwise a broken <script>/<link> reference is silently masked by a 200.
      if (path.extname(rel) !== '') return sendText(res, 404, 'Not found');
      // SPA fallback for extension-less unknown paths only
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

async function aiFallbackPayload(message, lang) {
  const constraints = parse(message).constraints;
  const result = suggest(await listProducts({}), constraints, 3);
  const reply = buildReply(result.suggestions, constraints, lang || 'ar');
  return {
    reply, understood: constraints, suggestions: result.suggestions,
    engine: 'rule-based-nlu-v1', fallback: true, model: null,
    needsClarification: false, questions: [], impossible: false, alternatives: [],
    note: 'AI engine unavailable; fell back to the rule-based assistant.',
  };
}

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
      ordersStored: (await listOrders({ limit: 1000 })).length,
      db: STORE.driver === 'postgres' ? STORE.target : path.basename(dbPath()),
      storage: { driver: STORE.driver, readOnly: STORE.readOnly, persistent: STORE.persistent },
      ai: { available: aiAvailable(), model: aiModel(), requests: aiUsage().requests, totalTokens: aiUsage().totalTokens },
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    });
  }

  if (p === '/api/config' && method === 'GET') {
    const settings = await getSettings();
    return send(res, 200, {
      currency: CURRENCY,
      rules: publicRules(),
      categories: CATEGORIES,
      statuses: ORDER_STATUSES,
      shop: settings.shop,
      capacity: {
        daily: settings.capacity.daily,
        perWindow: settings.capacity.perWindow,
        leadHours: settings.capacity.leadHours,
        maxDays: settings.capacity.maxDays,
        windows: settings.capacity.windowList.map((w) => ({ id: w.id, start: w.start, end: w.end, label: w.label })),
      },
      assistant: {
        ...(aiAvailable()
          ? { engine: `llm-${aiModel()}`, externalProvider: true, model: aiModel(), available: true }
          : { engine: 'rule-based-nlu-v1', externalProvider: false, available: false }),
        guard: aiGuardConfig(),
      },
    });
  }

  if (p === '/api/slots' && method === 'GET') {
    const days = Math.max(1, Math.min(60, Number(url.searchParams.get('days')) || 14));
    const startDate = url.searchParams.get('from') || null;
    if (startDate && !/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
      return send(res, 400, { error: 'BAD_DATE', message: 'from must be YYYY-MM-DD' });
    }
    const availability = await listAvailability({ days, startDate });
    // The earliest window a customer can still book, in display order, so the
    // picker can jump straight to it instead of re-deriving it from the days.
    let nextAvailable = null;
    for (const day of availability) {
      const open = (day.windows || []).find((w) => w.disabled === false);
      if (!open) continue;
      nextAvailable = {
        date: day.date, windowId: open.id, start: open.start, label: open.label, remaining: open.remaining,
      };
      break;
    }
    return send(res, 200, { days: availability, nextAvailable });
  }

  if (p === '/api/products' && method === 'GET') {
    const category = url.searchParams.get('category') || 'all';
    return send(res, 200, { products: await listProducts({ category }), categories: CATEGORIES });
  }

  if (p.startsWith('/api/products/') && method === 'GET') {
    const id = p.split('/')[3];
    const product = await getProduct(id);
    if (!product) return send(res, 404, { error: 'NOT_FOUND', message: 'Product not found' });
    return send(res, 200, { product });
  }

  if (p === '/api/quote' && method === 'POST') {
    const body = await readJsonBody(req);
    const product = await getProduct(body.productId);
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
    const result = suggest(await listProducts({}), constraints, 3);
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

  if (p === '/api/assistant/ai' && method === 'POST') {
    const body = await readJsonBody(req);
    const message = String(body.message || '').slice(0, 500).trim();
    if (message.length < 2) return send(res, 400, { error: 'EMPTY_MESSAGE', message: 'Please describe what you need' });

    // No LLM configured -> rule-based fallback without touching any quota.
    if (!aiAvailable()) return send(res, 200, aiFallbackPayload(message, body.lang));

    // Consumption protection: per-IP rate limit (trusted client IP) then a global
    // concurrency slot. A clear 429 + Retry-After when either guard trips.
    const ip = clientIp(req);
    const limit = checkAiRateLimit(ip);
    if (!limit.allowed) {
      res.setHeader('Retry-After', String(limit.retryAfterSeconds));
      return send(res, 429, { error: 'RATE_LIMITED', message: 'Too many AI requests. Try again later.', retryAfterSeconds: limit.retryAfterSeconds });
    }
    if (!acquireAiSlot()) {
      res.setHeader('Retry-After', '1');
      return send(res, 429, { error: 'AI_BUSY', message: 'The AI assistant is busy. Try again in a moment.' });
    }
    try {
      const result = await design(message, { history: body.history, lang: body.lang });
      return send(res, 200, {
        ...result,
        note: result.fallback
          ? 'No model connection configured; using the rule-based assistant.'
          : 'Prices are computed by the server-side pricing engine, never by the model.',
      });
    } catch (err) {
      console.error('[ai]', err.message);
      // Model failure -> degrade to the rule-based assistant, never a 500 to the customer.
      return send(res, 200, await aiFallbackPayload(message, body.lang));
    } finally {
      releaseAiSlot();
    }
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
      const product = await getProduct(line.productId);
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
      cakesSubtotal += q.cakeSubtotal * lt.quantity;
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

    // Stored money columns are disjoint: subtotal (cakes) + rush + delivery = total.
    const subtotal = cakesSubtotal;
    const total = subtotal + rushFee + deliveryFee;
    if (total <= 0) return send(res, 400, { error: 'BAD_TOTAL', message: 'Invalid order total' });

    try {
      const order = await createOrder({
        customer: { name, phone, email: email || null },
        items: priced,
        totals: { currency: CURRENCY, subtotal, rushFee, deliveryFee, total },
        status: 'pending',
        paymentMethod: 'demo',
        deliveryAt,
        notes: String(body.notes || '').slice(0, 400),
      });
      return send(res, 201, { order });
    } catch (err) {
      if (err.code === 'DAY_FULL' || err.code === 'SLOT_FULL') {
        return send(res, 409, { error: err.code, message: err.message });
      }
      if (err.status === 400) {
        return send(res, 400, { error: err.code || 'BAD_REQUEST', message: err.message });
      }
      // Any storage failure lands here. The customer gets a refusal, never a
      // confirmation: nothing was committed, so nothing may look accepted.
      console.error('[orders] persistence failure:', err);
      return send(res, 503, {
        error: 'PERSISTENCE_FAILED',
        message: 'We could not save your order, so it was not accepted. Nothing was recorded or charged. Please try again.',
      });
    }
  }

  if (p === '/api/orders/lookup' && method === 'POST') {
    const body = await readJsonBody(req);
    const phone = validPhone(body.phone);
    const code = String(body.code || '').trim().toUpperCase();
    if (!phone || !code) return send(res, 400, { error: 'BAD_LOOKUP', message: 'Code and phone are required' });
    const order = await getOrder(code);
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
    const user = await verifyAdmin(String(body.username || ''), String(body.password || ''));
    if (!user) {
      noteLoginFailure(ip);
      return send(res, 401, { error: 'INVALID_CREDENTIALS', message: 'Wrong username or password' });
    }
    clearLoginFailures(ip);
    const session = await createSession(user.id);
    const secure = (req.headers['x-forwarded-proto'] || '').includes('https');
    res.setHeader('Set-Cookie', `cg_session=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${8 * 3600}${secure ? '; Secure' : ''}`);
    return send(res, 200, { ok: true, user: { username: user.username }, expiresAt: session.expiresAt });
  }

  if (p === '/api/admin/logout' && method === 'POST') {
    await destroySession(parseCookies(req).cg_session);
    res.setHeader('Set-Cookie', 'cg_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
    return send(res, 200, { ok: true });
  }

  if (p === '/api/admin/me' && method === 'GET') {
    const session = await requireAdmin(req, res);
    if (!session) return;
    return send(res, 200, { user: { username: session.username }, expiresAt: session.expiresAt });
  }

  if (p === '/api/admin/ai-usage' && method === 'GET') {
    const session = await requireAdmin(req, res);
    if (!session) return;
    return send(res, 200, { available: aiAvailable(), model: aiModel(), usage: aiUsage() });
  }

  if (p === '/api/admin/stats' && method === 'GET') {
    const session = await requireAdmin(req, res);
    if (!session) return;
    return send(res, 200, { stats: await revenueSummary(), statuses: ORDER_STATUSES });
  }

  if (p === '/api/admin/orders' && method === 'GET') {
    const session = await requireAdmin(req, res);
    if (!session) return;
    const status = url.searchParams.get('status') || 'all';
    if (status !== 'all' && !ORDER_STATUSES.includes(status)) {
      return send(res, 400, { error: 'BAD_STATUS', message: 'Unknown status filter' });
    }
    return send(res, 200, { orders: await listOrders({ status }) });
  }

  if (p === '/api/admin/orders.csv' && method === 'GET') {
    const session = await requireAdmin(req, res);
    if (!session) return;
    const status = url.searchParams.get('status') || 'all';
    const from = url.searchParams.get('from') || null;
    const to = url.searchParams.get('to') || null;
    const orders = await listOrders({ status, from, to, limit: 1000 });
    const buffer = csvBuffer([
      { label: 'code', value: (o) => o.code },
      { label: 'created_at', value: (o) => o.createdAt },
      { label: 'delivery_at', value: (o) => o.deliveryAt || '' },
      { label: 'slot_date', value: (o) => o.slot?.date || '' },
      { label: 'slot_window', value: (o) => o.slot?.window || '' },
      { label: 'status', value: (o) => o.status },
      { label: 'customer_name', value: (o) => o.customer.name },
      { label: 'customer_phone', value: (o) => o.customer.phone },
      { label: 'customer_email', value: (o) => o.customer.email || '' },
      { label: 'items', value: (o) => o.items.map((i) => `${i.name.ar} x${i.quantity}`).join(' | ') },
      { label: 'subtotal', value: (o) => o.subtotal },
      { label: 'rush_fee', value: (o) => o.rushFee },
      { label: 'delivery_fee', value: (o) => o.deliveryFee },
      { label: 'total', value: (o) => o.total },
      { label: 'currency', value: (o) => o.currency },
    ], orders);
    return sendAttachment(res, buffer, `cake-genius-orders-${shopDate(new Date())}.csv`, 'text/csv; charset=utf-8');
  }

  if (p.startsWith('/api/admin/orders/') && method === 'PATCH') {
    const session = await requireAdmin(req, res);
    if (!session) return;
    const id = p.split('/')[4];
    const body = await readJsonBody(req);
    if (!ORDER_STATUSES.includes(body.status)) {
      return send(res, 400, { error: 'BAD_STATUS', message: 'Unknown status' });
    }
    const order = await setOrderStatus(id, body.status, session.username);
    if (!order) return send(res, 404, { error: 'NOT_FOUND', message: 'Order not found' });
    return send(res, 200, { order });
  }

  /** Render the WhatsApp messages for an order. Never sends: preview only. */
  if (/^\/api\/admin\/orders\/[^/]+\/notify-preview$/.test(p) && method === 'POST') {
    const session = await requireAdmin(req, res);
    if (!session) return;
    const id = p.split('/')[4];
    const order = await getOrder(id);
    if (!order) return send(res, 404, { error: 'NOT_FOUND', message: 'Order not found' });
    const settings = await getSettings();
    const messages = renderOrderMessages(order, settings);
    return send(res, 200, {
      order: { id: order.id, code: order.code },
      channel: channelStatus(),
      messages,
      links: {
        customer: messages.customer?.to ? whatsappLink(messages.customer.to, messages.customer.body) : null,
        owner: messages.owner?.to ? whatsappLink(messages.owner.to, messages.owner.body) : null,
      },
    });
  }

  if (p === '/api/admin/customers' && method === 'GET') {
    const session = await requireAdmin(req, res);
    if (!session) return;
    return send(res, 200, { customers: await listCustomers() });
  }

  if (p === '/api/admin/products' && method === 'GET') {
    const session = await requireAdmin(req, res);
    if (!session) return;
    return send(res, 200, { products: await listProducts({ includeInactive: true }) });
  }

  if (p === '/api/admin/products' && method === 'POST') {
    const session = await requireAdmin(req, res);
    if (!session) return;
    const body = await readJsonBody(req);
    const parsed = parseProductInput(body, { partial: false });
    if (parsed.error) return send(res, 400, { error: 'BAD_PRODUCT', message: parsed.error });
    const product = await createProduct(parsed.value);
    return send(res, 201, { product });
  }

  if (p.startsWith('/api/admin/products/') && method === 'PATCH') {
    const session = await requireAdmin(req, res);
    if (!session) return;
    const id = p.split('/')[4];
    const body = await readJsonBody(req);
    const parsed = parseProductInput(body, { partial: true });
    if (parsed.error) return send(res, 400, { error: 'BAD_PRODUCT', message: parsed.error });
    if (!(await getProductForAdmin(id))) return send(res, 404, { error: 'NOT_FOUND', message: 'Product not found' });
    const product = await updateProduct(id, parsed.value);
    return send(res, 200, { product });
  }

  if (p === '/api/admin/settings' && method === 'GET') {
    const session = await requireAdmin(req, res);
    if (!session) return;
    const settings = await getSettings();
    return send(res, 200, { settings: { ...settings.raw, notify: channelStatus() } });
  }

  if (p === '/api/admin/settings' && method === 'PATCH') {
    const session = await requireAdmin(req, res);
    if (!session) return;
    const body = await readJsonBody(req);
    const settings = await setSettings(body);
    return send(res, 200, { settings: settings.raw });
  }

  if (p === '/api/admin/slots' && method === 'GET') {
    const session = await requireAdmin(req, res);
    if (!session) return;
    const days = Math.max(1, Math.min(60, Number(url.searchParams.get('days')) || 14));
    return send(res, 200, { days: await listAvailability({ days }) });
  }

  if (p === '/api/admin/day' && method === 'GET') {
    const session = await requireAdmin(req, res);
    if (!session) return;
    const date = url.searchParams.get('date') || shopDate(new Date());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return send(res, 400, { error: 'BAD_DATE', message: 'date must be YYYY-MM-DD' });
    }
    return send(res, 200, await adminDay(date));
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
    if (url.pathname === '/robots.txt') {
      const base = baseUrl(req);
      return sendText(res, 200, `User-agent: *\nAllow: /\nDisallow: /admin\nSitemap: ${base}/sitemap.xml\n`);
    }
    if (url.pathname === '/sitemap.xml') {
      return await serveSitemap(req, res);
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return await serveIndex(req, res);
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

server.listen(PORT, HOST, async () => {
  console.log(`Cake Genius listening on http://${HOST}:${PORT}`);
  console.log(`build: v${VERSION} @ ${COMMIT}`);
  console.log(`DB: ${dbPath()}  admin user: ${adminInfo.username} (${adminInfo.created ? 'created' : 'synced'})`);
  console.log(`orders on disk at startup: ${(await listOrders({ limit: 1000 })).length}`);
});

const shutdown = (sig) => {
  console.log(`[shutdown] ${sig}`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
