/**
 * Shop calendar + delivery-slot rules. Pure functions, no I/O, so the maths is
 * unit-testable and identical on the server and in tests.
 *
 * The shop runs on Asia/Riyadh time (UTC+3, no DST). Every date key is a
 * calendar day in that zone, never the server's local zone.
 */
export const SHOP_TZ_OFFSET_MIN = 180;
export const DAY_WINDOW = 'day';

export function shopDate(input = new Date()) {
  const t = input instanceof Date ? input : new Date(input);
  if (!Number.isFinite(t.getTime())) return null;
  return new Date(t.getTime() + SHOP_TZ_OFFSET_MIN * 60000).toISOString().slice(0, 10);
}

export function shopTime(input = new Date()) {
  const t = input instanceof Date ? input : new Date(input);
  if (!Number.isFinite(t.getTime())) return null;
  return new Date(t.getTime() + SHOP_TZ_OFFSET_MIN * 60000).toISOString().slice(11, 16);
}

/** "11:00-14:00,16:00-19:00" -> [{id,start,end,label}] (ids are stable: w1, w2...) */
export function parseWindows(spec) {
  return String(spec || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((range, i) => {
      const m = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(range);
      if (!m) return null;
      return {
        id: `w${i + 1}`,
        start: m[1].padStart(5, '0'),
        end: m[2].padStart(5, '0'),
        label: `${m[1].padStart(5, '0')} - ${m[2].padStart(5, '0')}`,
      };
    })
    .filter(Boolean);
}

export function windowForTime(time, windows) {
  const t = String(time || '').slice(0, 5);
  for (const w of windows) {
    if (t >= w.start && t < w.end) return w;
  }
  return null;
}

export function addDays(dateKey, n) {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function weekday(dateKey) {
  return new Date(`${dateKey}T00:00:00Z`).getUTCDay(); // 0 = Sunday
}

export function parseClosedDays(spec) {
  return String(spec || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
}

/**
 * Build one day of availability from stored rows.
 * rows: [{window_id, capacity, booked}]
 */
export function dayAvailability({ date, windows, dayCapacity, perWindowCapacity, rows, closedDays = [], minDate = null, maxDate = null }) {
  const isClosed = parseClosedDays(closedDays).includes(weekday(date)) || (minDate && date < minDate) || (maxDate && date > maxDate);
  const byWindow = new Map(rows.map((r) => [r.window_id, r]));
  const dayRow = byWindow.get(DAY_WINDOW) || { capacity: dayCapacity, booked: 0 };
  const dayBooked = Number(dayRow.booked || 0);
  const dayCap = Number(dayRow.capacity || dayCapacity);
  const dayRemaining = Math.max(0, dayCap - dayBooked);

  const list = windows.map((w) => {
    const row = byWindow.get(w.id) || { capacity: perWindowCapacity, booked: 0 };
    const capacity = Number(row.capacity || perWindowCapacity);
    const booked = Number(row.booked || 0);
    return {
      id: w.id,
      start: w.start,
      end: w.end,
      label: w.label,
      capacity,
      booked,
      remaining: Math.max(0, capacity - booked),
      disabled: isClosed || booked >= capacity || dayRemaining <= 0,
    };
  });

  return {
    date,
    weekday: weekday(date),
    closed: !!isClosed,
    dayCapacity: dayCap,
    dayBooked,
    remaining: dayRemaining,
    windows: list,
  };
}

export function slotError(code, message) {
  return Object.assign(new Error(message), { code, status: 409 });
}

/**
 * Layer lead time and the wall clock over one day of availability.
 *
 * dayAvailability() is a pure snapshot of the calendar; it cannot know what
 * time it is, so it happily offers a window that started hours ago and the
 * order is then refused with DELIVERY_TOO_SOON. This wrapper answers the
 * customer's real question: which windows can I still book, and why not?
 *
 * Every window gains `reason` (CLOSED | FULL | LEAD_TIME | null) and a
 * corrected `disabled`; the day gains leadHours, bookable and earliest.
 * The input day is never mutated — a new object is returned.
 *
 * `now` is injected so the rule is testable; `start` stays shop-local 'HH:MM'.
 */
export function applyLeadTime(day, { now = new Date(), leadHours = 0 } = {}) {
  if (!day || typeof day !== 'object') return day;
  const date = day.date;
  // A date key we cannot anchor to a shop-time instant leaves the day as given.
  if (!Number.isFinite(Date.parse(`${date}T00:00:00+03:00`))) return day;

  const clock = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const nowMs = Number.isFinite(clock) ? clock : Date.now();
  const lead = Number(leadHours);
  const hours = Number.isFinite(lead) && lead > 0 ? lead : 0;
  const cutoff = nowMs + hours * 3600e3;

  const closed = !!day.closed;
  // A day with no room left cannot honour any window, even one with its own
  // free seats: reporting those as open is what produces a 409 at checkout.
  const dayFull = Number(day.remaining) <= 0;

  const windows = (Array.isArray(day.windows) ? day.windows : []).map((w) => {
    let reason = null;
    if (closed) {
      reason = 'CLOSED';
    } else if (dayFull || Number(w.remaining) <= 0) {
      reason = 'FULL';
    } else {
      const startsAt = Date.parse(`${date}T${w.start}:00+03:00`);
      if (Number.isFinite(startsAt) && startsAt <= cutoff) reason = 'LEAD_TIME';
    }
    return { ...w, reason, disabled: reason !== null };
  });

  const first = windows.find((w) => w.reason === null) || null;
  return {
    ...day,
    leadHours: hours,
    windows,
    bookable: !closed && first !== null,
    earliest: first ? { windowId: first.id, start: first.start } : null,
  };
}
