/**
 * AI resilience tests (black box, real HTTP, NO real model):
 *  - model failure -> safe fallback to the rule-based assistant (200, never 500)
 *  - consumption protection is active -> 429 RATE_LIMITED with Retry-After
 * Spawns its own server with an unreachable DeepSeek base URL and a low rate cap.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const REPO = process.argv[2] || '.';
const PORT = process.env.AI_FALLBACK_PORT || '3141';
const DB = process.env.AI_FALLBACK_DB || 'C:/Users/Zulik/AppData/Local/hermes/cache/scratch/cg-fallback.db';

const env = {
  ...process.env,
  PORT,
  DB_PATH: DB,
  ADMIN_PASSWORD: 'test-admin-123',
  // NODE_ENV=production is deliberately set: it proves that production alone does NOT
  // grant X-Forwarded-For trust (no TRUSTED_PROXIES configured here), so forged headers
  // cannot bypass login or AI consumption limits.
  NODE_ENV: 'production',
  DEEPSEEK_API_KEY: 'sk-test-invalid-key',
  DEEPSEEK_BASE_URL: 'http://127.0.0.1:9', // unreachable -> immediate ECONNREFUSED
  AI_RATE_MAX: '2',
  AI_RATE_WINDOW_MS: '60000',
};

for (const f of [DB, DB + '-wal', DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch {} }

const server = spawn('node', ['server.js'], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { failures.push(name); console.log(`FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}

async function post(path, body) {
  // Every AI request carries a forged X-Forwarded-For to prove it cannot shift the
  // rate-limit bucket even under NODE_ENV=production (no trusted proxy configured).
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.99' },
    body: JSON.stringify(body),
  });
  let data = null; const text = await res.text();
  try { data = JSON.parse(text); } catch { data = text.slice(0, 120); }
  return { status: res.status, data, retryAfter: res.headers.get('retry-after') };
}

try {
  // wait for boot
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/api/health`); up = r.ok; } catch {}
    if (!up) await new Promise((r) => setTimeout(r, 250));
  }
  if (!up) { console.log('SERVER FAILED TO START\n' + log.slice(-2000)); process.exit(2); }

  const cfg = await (await fetch(`http://127.0.0.1:${PORT}/api/config`)).json();
  check('server sees a key (available=true) so the LLM path is exercised', cfg.assistant.available === true, JSON.stringify(cfg.assistant));
  check('guard config is exposed with rate.max=2', cfg.assistant.guard?.rate?.max === 2, JSON.stringify(cfg.assistant.guard));

  // 1. model failure -> safe fallback (200, fallback true, never 500)
  const r1 = await post('/api/assistant/ai', { message: 'كيكة عيد ميلاد لـ 10 أشخاص', lang: 'ar' });
  check('model failure falls back safely (200, not 500)', r1.status === 200, String(r1.status));
  check('fallback flagged and engine is rule-based', r1.data.fallback === true && r1.data.engine === 'rule-based-nlu-v1', JSON.stringify(r1.data.engine));
  check('fallback still returns suggestions', r1.data.suggestions.length >= 1);

  // 2. second request within the cap also allowed
  const r2 = await post('/api/assistant/ai', { message: 'wedding cake for 30 guests', lang: 'en' });
  check('second request within cap allowed', r2.status === 200, String(r2.status));

  // 3. third request trips the rate limit -> 429 + Retry-After
  const r3 = await post('/api/assistant/ai', { message: 'كيكة أطفال', lang: 'ar' });
  check('third request returns 429 RATE_LIMITED', r3.status === 429 && r3.data.error === 'RATE_LIMITED', `${r3.status} ${JSON.stringify(r3.data)}`);
  check('429 carries a Retry-After header', Number(r3.retryAfter) >= 1, String(r3.retryAfter));
  check('429 response leaks no credential', !/sk-[A-Za-z0-9]{8,}|api_key|Authorization|Bearer /i.test(JSON.stringify(r3.data)));

  // 4. forged / repeated X-Forwarded-For cannot defeat login rate limiting: the spawned
  //    server is non-production, so clientIp() ignores XFF and keys on the peer socket.
  let lastStatus = 0;
  for (let i = 1; i <= 7; i++) {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.0.0.${i}, 10.0.0.${i + 100}` },
      body: JSON.stringify({ username: 'admin', password: 'definitely-wrong' }),
    });
    lastStatus = res.status;
    if (i <= 6) check(`forged XFF login attempt ${i} -> 401`, res.status === 401, String(res.status));
  }
  check('7th forged-XFF login attempt -> 429 (header rotation cannot bypass the limit)', lastStatus === 429, String(lastStatus));

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log('FAILED:', failures.join(' | ')); process.exitCode = 1; }
} catch (e) {
  console.error('FATAL', e);
  process.exitCode = 2;
} finally {
  server.kill();
}
