/**
 * Settings: flat key/value rows with typed defaults.
 *
 * Only keys in ALLOWED can be written, and each has a coercer, so an admin
 * request cannot inject arbitrary rows or put a string where a number belongs.
 */
import { parseWindows } from './capacity.js';

export const DEFAULTS = {
  'shop.name': 'Cake Genius',
  'shop.nameAr': 'كيك جينيوس',
  'shop.phone': '',
  'shop.url': '',
  'shop.city': 'الرياض',
  'capacity.daily': 12,
  'capacity.perWindow': 6,
  'capacity.leadHours': 4,
  'capacity.maxDays': 60,
  'capacity.closedDays': '',
  'capacity.windows': '11:00-14:00,16:00-19:00',
  'notify.ownerPhone': '',
};

const num = (min, max) => (v) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) return { error: `must be a number between ${min} and ${max}` };
  return { value: String(Math.round(n)) };
};
const str = (max) => (v) => {
  const s = String(v ?? '').trim();
  if (s.length > max) return { error: `must be at most ${max} characters` };
  return { value: s };
};
const phone = (v) => {
  const s = String(v ?? '').trim();
  if (s === '') return { value: '' };
  if (!/^\+?[0-9]{9,15}$/.test(s.replace(/[\s-]/g, ''))) return { error: 'must be a phone number with 9-15 digits' };
  return { value: s.replace(/[\s-]/g, '') };
};
const windows = (v) => {
  const list = parseWindows(v);
  if (!list.length) return { error: 'must look like 11:00-14:00,16:00-19:00' };
  return { value: list.map((w) => `${w.start}-${w.end}`).join(',') };
};
const closedDays = (v) => {
  const parts = String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const bad = parts.filter((p) => !/^[0-6]$/.test(p));
  if (bad.length) return { error: 'must be a comma list of weekdays 0-6' };
  return { value: parts.join(',') };
};

export const ALLOWED = {
  'shop.name': str(60),
  'shop.nameAr': str(60),
  'shop.phone': phone,
  'shop.url': str(200),
  'shop.city': str(60),
  'notify.ownerPhone': phone,
  'capacity.daily': num(1, 500),
  'capacity.perWindow': num(1, 500),
  'capacity.leadHours': num(0, 720),
  'capacity.maxDays': num(1, 365),
  'capacity.closedDays': closedDays,
  'capacity.windows': windows,
};

/** Merge stored rows over the defaults and cast to the right types. */
export function resolveSettings(rows = []) {
  const flat = { ...DEFAULTS };
  for (const r of rows) {
    if (r.key in DEFAULTS) flat[r.key] = r.value;
  }
  return {
    shop: {
      name: flat['shop.name'],
      nameAr: flat['shop.nameAr'],
      phone: flat['shop.phone'],
      url: flat['shop.url'],
      city: flat['shop.city'],
    },
    capacity: {
      daily: Number(flat['capacity.daily']),
      perWindow: Number(flat['capacity.perWindow']),
      leadHours: Number(flat['capacity.leadHours']),
      maxDays: Number(flat['capacity.maxDays']),
      closedDays: flat['capacity.closedDays'],
      windows: flat['capacity.windows'],
      windowList: parseWindows(flat['capacity.windows']),
    },
    notify: {
      ownerPhone: flat['notify.ownerPhone'] || flat['shop.phone'],
    },
    raw: flat,
  };
}

/** Validate a patch; returns { updates: [[key, value]], errors: [..] } */
export function validateSettingsPatch(body = {}) {
  const updates = [];
  const errors = [];
  for (const [key, raw] of Object.entries(body)) {
    const c = ALLOWED[key];
    if (!c) { errors.push(`${key}: unknown setting`); continue; }
    const out = c(raw);
    if (out.error) errors.push(`${key}: ${out.error}`);
    else updates.push([key, out.value]);
  }
  return { updates, errors };
}
