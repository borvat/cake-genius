#!/usr/bin/env node
/**
 * Cake Genius 1.3 — dependency-free demo smoke.
 *
 * Starts the real server (node server.js) on a free loopback port against a
 * throwaway SQLite file under os.tmpdir(), then proves, in order:
 *   1. /api/health comes up;
 *   2. /api/slots carries the 1.3 contract (disabled, reason, leadHours,
 *      nextAvailable) and nextAvailable is null or a bookable window;
 *   3. a booking into that window returns 201 and is readable by code+phone;
 *   4. a second booking into the now-full window returns 409 SLOT_FULL.
 *
 * How the window is forced full: the script logs in as admin and PATCHes
 * /api/admin/settings with capacity.perWindow = 1 (capacity.daily = 50) before
 * reading /api/slots. One deterministic admin call instead of six blind
 * bookings, and it also exercises the admin capacity path the demo relies on.
 *
 * Every assertion prints PASS or FAIL with its label; the last line is
 * "DEMO CHECK: PASS" or "DEMO CHECK: FAIL". Exit code is 0 only on PASS.
 *
 * Usage: node scripts/demo-check.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { SHOP_TZ_OFFSET_MIN } from '../lib/capacity.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const ADMIN_PASSWORD = 'gate-pass';
const CUSTOMER = { name: 'عميل العرض التجريبي', phone: '0555900101' };
const CUSTOMER_2 = { name: 'عميل التاكيد', phone: '0555900102' };
const PRODUCT_ID = 'p-lotus';
const CAKE_CONFIG = {
  size: 's8',
  flavor: 'vanilla',
  filling: 'cream',
  design: 'classic',
  deliveryMethod: 'delivery',
};

let passed = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`PASS  ${name}`);
    return true;
  }
  failures.push(name);
  console.log(`FAIL  ${name}${detail ? ' -> ' + detail : ''}`);
  return false;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Ask the OS for a free loopback port, then release it for the child. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

/** Shop-local HH:MM on a YYYY-MM-DD date -> UTC ISO instant the server accepts. */
function deliveryAtFor(dateKey, start) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  const [hh, mm] = String(start || '').split(':').map(Number);
  if (!y || !m || !d || !Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  const utcMs = Date.UTC(y, m - 1, d, hh, mm) - SHOP_TZ_OFFSET_MIN * 60000;
  return new Date(utcMs).toISOString();
}

function orderBody(deliveryAt, customer = CUSTOMER) {
  return {
    customer: { name: customer.name, phone: customer.phone },
    items: [{ productId: PRODUCT_ID, config: { ...CAKE_CONFIG }, quantity: 1 }],
    deliveryAt,
  };
}

/** Validate nextAvailable without assuming more than the documented shape. */
function inspectNextAvailable(body, days) {
  if (!Object.hasOwn(body, 'nextAvailable')) {
    return { present: false, ok: false, detail: 'nextAvailable key missing' };
  }
  const na = body.nextAvailable;
  if (na === null) {
    return { present: true, ok: true, detail: 'nextAvailable is null' };
  }
  if (typeof na !== 'object') {
    return { present: true, ok: false, detail: `nextAvailable is ${typeof na}` };
  }
  const problems = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(na.date || ''))) problems.push(`date=${na.date}`);
  if (typeof na.windowId !== 'string' || !na.windowId) problems.push(`windowId=${na.windowId}`);
  if (!Number.isFinite(Number(na.remaining)) || Number(na.remaining) < 1) problems.push(`remaining=${na.remaining}`);
  const found = problems.length ? null : findWindow(days, na.windowId);
  if (problems.length === 0 && !found) problems.push(`windowId ${na.windowId} is not in the returned days`);
  if (found && found.window.disabled === true) problems.push(`windowId ${na.windowId} is disabled`);
  if (found && Number(found.window.remaining) < 1) problems.push(`windowId ${na.windowId} has remaining=${found.window.remaining}`);
  return { present: true, ok: problems.length === 0, detail: problems.join(', '), value: na, found };
}

function findWindow(days, windowId) {
  for (const day of days || []) {
    for (const w of day.windows || []) {
      if (w.id === windowId) return { day, window: w };
    }
  }
  return null;
}

/** Fallback target: first window with room that also clears leadHours. */
function firstBookable(days, leadHours) {
  const cutoff = Date.now() + Number(leadHours) * 36e5;
  for (const day of days || []) {
    for (const w of day.windows || []) {
      if (w.disabled || Number(w.remaining) <= 0) continue;
      const at = deliveryAtFor(day.date, w.start);
      if (!at || new Date(at).getTime() < cutoff) continue;
      return { date: day.date, windowId: w.id, start: w.start, label: w.label, remaining: w.remaining, deliveryAt: at };
    }
  }
  return null;
}

async function main() {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-demo-'));
  const dbPath = path.join(tmpDir, 'demo.db');

  let child = null;
  let stderr = '';
  let health = null;
  let stopped = false;

  async function api(pathname, { method = 'GET', body, cookie } = {}) {
    const res = await fetch(base + pathname, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5000),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* not JSON */
    }
    return { status: res.status, data, headers: res.headers };
  }

  try {
    child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        DB_PATH: dbPath,
        ADMIN_PASSWORD,
        PUBLIC_URL: base,
        NODE_ENV: 'test',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.resume();
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    console.log(`demo server: ${base}  db: ${path.basename(tmpDir)}/demo.db`);

    const deadline = Date.now() + 20000;
    let lastErr = 'not attempted';
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) });
        if (res.ok) {
          health = await res.json();
          break;
        }
        lastErr = `status ${res.status}`;
      } catch (err) {
        lastErr = err.message;
      }
      await sleep(250);
    }

    check(
      'health: /api/health answers within 20s',
      !!health?.ok,
      health ? '' : `${lastErr}${stderr ? ' | stderr: ' + stderr.trim().slice(-400) : ''}`,
    );

    if (!health) {
      for (const name of [
        'slots: GET /api/slots returns days',
        'slots contract: every window carries a boolean disabled',
        'slots contract: every window carries a reason',
        'slots contract: root exposes numeric leadHours',
        'slots contract: root exposes nextAvailable',
        'slots: nextAvailable is null or a bookable window',
        'admin: login returns a session cookie',
        'admin: capacity forced to 1 cake per window',
        'slots: a bookable target window exists',
        'booking: POST /api/orders returns 201',
        'lookup: the order is readable with the same code',
        'slots: the booked window reports remaining 0',
        'booking: a second order into the full window is 409 SLOT_FULL',
      ]) {
        check(name, false, 'not attempted: server never became healthy');
      }
      return;
    }

    check('health: reports the sqlite driver', health.storage?.driver === 'sqlite', JSON.stringify(health.storage));

    /* ---------- admin capacity: 1 cake per window ---------- */
    const login = await api('/api/admin/login', {
      method: 'POST',
      body: { username: 'admin', password: ADMIN_PASSWORD },
    });
    const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
    check('admin: login returns a session cookie', login.status === 200 && cookie.startsWith('cg_session='), `${login.status} ${JSON.stringify(login.data)}`);

    let tuned = false;
    if (cookie) {
      const patch = await api('/api/admin/settings', {
        method: 'PATCH',
        cookie,
        body: { 'capacity.perWindow': 1, 'capacity.daily': 50 },
      });
      tuned = patch.status === 200 && Number(patch.data?.settings?.['capacity.perWindow']) === 1;
      check('admin: capacity forced to 1 cake per window', tuned, `${patch.status} ${JSON.stringify(patch.data?.settings?.['capacity.perWindow'])}`);
    } else {
      check('admin: capacity forced to 1 cake per window', false, 'no session cookie');
    }

    /* ---------- slots contract ---------- */
    const slots = await api('/api/slots?days=14');
    const days = slots.data?.days || [];
    check('slots: GET /api/slots returns days', slots.status === 200 && days.length > 0, `${slots.status} ${JSON.stringify(slots.data?.error || '')}`);

    const windows = days.flatMap((d) => (d.windows || []).map((w) => ({ ...w, date: d.date })));
    check(
      'slots contract: every window carries a boolean disabled',
      windows.length > 0 && windows.every((w) => typeof w.disabled === 'boolean'),
      windows.length ? windows.filter((w) => typeof w.disabled !== 'boolean').slice(0, 2).map((w) => `${w.id}:${typeof w.disabled}`).join(', ') : 'no windows returned',
    );

    const reasonShape = windows.length > 0 && windows.every((w) => Object.hasOwn(w, 'reason') && (w.reason === null || typeof w.reason === 'string'));
    const disabledWithoutReason = windows.filter((w) => w.disabled === true && !w.reason);
    check(
      'slots contract: every window carries a reason',
      reasonShape && disabledWithoutReason.length === 0,
      reasonShape ? `disabled windows without reason: ${disabledWithoutReason.map((w) => w.id).slice(0, 3).join(', ')}` : `missing reason on: ${windows.filter((w) => !Object.hasOwn(w, 'reason')).slice(0, 2).map((w) => w.id).join(', ')}`,
    );

    check('slots contract: root exposes numeric leadHours', typeof slots.data?.leadHours === 'number', `leadHours=${JSON.stringify(slots.data?.leadHours)}`);

    const next = inspectNextAvailable(slots.data || {}, days);
    check('slots contract: root exposes nextAvailable', next.present, next.detail || 'nextAvailable key missing');
    check('slots: nextAvailable is null or a bookable window', next.ok, next.detail);

    /* ---------- resolve the booking target ---------- */
    const leadHours = Number.isFinite(Number(slots.data?.leadHours)) ? Number(slots.data.leadHours) : 4;
    let target = null;
    let targetFrom = '';
    if (next.ok && next.value && next.found) {
      const at = deliveryAtFor(next.found.day.date, next.found.window.start);
      if (at) {
        target = { date: next.found.day.date, windowId: next.value.windowId, start: next.found.window.start, label: next.found.window.label, remaining: next.found.window.remaining, deliveryAt: at };
        targetFrom = 'nextAvailable';
      }
    }
    if (!target) {
      target = firstBookable(days, leadHours);
      targetFrom = target ? 'first bookable window (nextAvailable unusable)' : '';
    }
    check(
      'slots: a bookable target window exists',
      !!target,
      target ? `${target.date} ${target.windowId} ${target.start} remaining=${target.remaining} via ${targetFrom}` : 'no window with remaining > 0 clears leadHours',
    );

    /* ---------- booking ---------- */
    let code = null;
    if (target) {
      const created = await api('/api/orders', { method: 'POST', body: orderBody(target.deliveryAt) });
      code = created.data?.order?.code || null;
      check(
        `booking: POST /api/orders into ${target.date} ${target.windowId} returns 201`,
        created.status === 201 && !!code,
        `${created.status} ${JSON.stringify(created.data)}`,
      );

      const lookup = code
        ? await api('/api/orders/lookup', { method: 'POST', body: { code, phone: CUSTOMER.phone } })
        : { status: 0, data: null };
      check(
        'lookup: the order is readable with the same code',
        lookup.status === 200 && lookup.data?.order?.code === code,
        `${lookup.status} ${JSON.stringify(lookup.data?.error || lookup.data?.order?.code || '')}`,
      );

      /* ---------- second booking into the full window ---------- */
      const after = await api(`/api/slots?days=14&from=${target.date}`);
      const afterWindow = findWindow(after.data?.days || [], target.windowId);
      const remaining = afterWindow ? Number(afterWindow.window.remaining) : null;
      check(
        'slots: the booked window reports remaining 0',
        remaining === 0,
        `remaining=${remaining} (capacity forced to 1: ${tuned})`,
      );

      const second = await api('/api/orders', { method: 'POST', body: orderBody(target.deliveryAt, CUSTOMER_2) });
      check(
        'booking: a second order into the full window is 409 SLOT_FULL',
        second.status === 409 && second.data?.error === 'SLOT_FULL',
        `${second.status} ${JSON.stringify(second.data)}`,
      );
    } else {
      for (const name of [
        'booking: POST /api/orders returns 201',
        'lookup: the order is readable with the same code',
        'slots: the booked window reports remaining 0',
        'booking: a second order into the full window is 409 SLOT_FULL',
      ]) {
        check(name, false, 'not attempted: no bookable window');
      }
    }
  } catch (err) {
    check('demo check completed without an unhandled error', false, err.stack || err.message);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await Promise.race([once(child, 'exit'), sleep(3000)]);
    }
    let leftover = false;
    if (child) {
      stopped = child.exitCode !== null || child.signalCode !== null || child.killed;
      if (!stopped) leftover = true;
    }
    try {
      await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) });
      leftover = true;
    } catch {
      /* port closed, as expected */
    }
    check('teardown: demo server stopped and the port is closed', stopped && !leftover, leftover ? 'a process still answers on the demo port' : 'server process still running');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

await main();

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) console.log(`FAILED: ${failures.join(' | ')}`);
console.log(failures.length ? 'DEMO CHECK: FAIL' : 'DEMO CHECK: PASS');
process.exit(failures.length ? 1 : 0);
