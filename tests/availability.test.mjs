/**
 * Lead-time aware availability: the wrapper that stops /api/slots offering a
 * window that POST /api/orders would refuse with DELIVERY_TOO_SOON.
 *
 * Pure functions only — every instant is fixed, the real clock is never read.
 * Riyadh is UTC+3 with no DST, so 08:00Z = 11:00 shop time.
 */
import { parseWindows, dayAvailability, applyLeadTime } from '../lib/capacity.js';

let pass = 0;
const failures = [];
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`PASS  ${name}`); }
  else { failures.push(name); console.log(`FAIL  ${name} -> got ${a}, expected ${e}`); }
}
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`); } else { failures.push(name); console.log(`FAIL  ${name} ${detail}`); }
}

const windows = parseWindows('11:00-14:00,16:00-19:00');

/** One calendar day from stored rows, exactly as lib/db.js builds it. */
function buildDay(date, { rows = [], closedDays = '', dayCapacity = 10, perWindowCapacity = 4 } = {}) {
  return dayAvailability({
    date, windows, dayCapacity, perWindowCapacity, rows, closedDays,
    minDate: '2026-11-01', maxDate: '2027-01-01',
  });
}

const reasons = (day) => day.windows.map((w) => w.reason);
const disabled = (day) => day.windows.map((w) => w.disabled);

/* ---------------------------------------------- (a) a window already started */
{
  // 09:00Z = 12:00 in Riyadh: the 11:00 window opened an hour ago.
  const day = buildDay('2026-11-03');
  const out = applyLeadTime(day, { now: '2026-11-03T09:00:00Z', leadHours: 0 });
  eq('(a) a window that already started is disabled', disabled(out), [true, false]);
  eq('(a) its reason is LEAD_TIME', out.windows[0].reason, 'LEAD_TIME');
  eq('(a) the started window keeps its capacity numbers', [out.windows[0].id, out.windows[0].remaining], ['w1', 4]);
}

/* ------------------------- (b) inside the lead-time buffer, not yet started */
{
  // 04:00Z = 07:00 in Riyadh, lead time 4h -> cutoff 11:00 shop time.
  const day = buildDay('2026-11-03');
  const out = applyLeadTime(day, { now: '2026-11-03T04:00:00Z', leadHours: 4 });
  ok('(b) the 11:00 window has not started at 07:00', Date.parse('2026-11-03T11:00:00+03:00') > Date.parse('2026-11-03T04:00:00Z'));
  eq('(b) a window inside the buffer is LEAD_TIME', out.windows[0].reason, 'LEAD_TIME');
  ok('(b) and therefore disabled', out.windows[0].disabled === true);
  eq('(b) the buffer cutoff is inclusive (start == now + leadHours)', applyLeadTime(day, { now: '2026-11-03T04:00:00Z', leadHours: 4 }).windows[0].reason, 'LEAD_TIME');
  eq('(b) one minute of slack opens the window again', applyLeadTime(day, { now: '2026-11-03T03:59:00Z', leadHours: 4 }).windows[0].reason, null);
}

/* ------------------------------------ (c) a later window stays bookable today */
{
  const day = buildDay('2026-11-03');
  const out = applyLeadTime(day, { now: '2026-11-03T04:00:00Z', leadHours: 4 });
  eq('(c) the later window keeps a null reason', out.windows[1].reason, null);
  eq('(c) the later window stays enabled', out.windows[1].disabled, false);
  ok('(c) an open window has disabled false and reason null', out.windows[1].disabled === false && out.windows[1].reason === null);
}

/* ------------------------------------------- (d) FULL beats an open day */
{
  const day = buildDay('2026-11-03', { rows: [{ window_id: 'w1', capacity: 2, booked: 2 }] });
  ok('(d) the day itself still has room', day.remaining > 0 && day.closed === false, `remaining=${day.remaining}`);
  const out = applyLeadTime(day, { now: '2026-11-03T04:00:00Z', leadHours: 0 });
  eq('(d) a full window is FULL even when the day is open', out.windows[0].reason, 'FULL');
  eq('(d) the other window is untouched', [out.windows[1].reason, out.windows[1].disabled], [null, false]);
  eq('(d) reasons follow FULL before LEAD_TIME', applyLeadTime(day, { now: '2026-11-03T20:00:00Z', leadHours: 4 }).windows[0].reason, 'FULL');
}

/* --------------------------------------------- (e) CLOSED beats everything */
{
  // 2026-11-03 is a Tuesday (weekday 2).
  const day = buildDay('2026-11-03', { closedDays: '2' });
  ok('(e) the fixture day is closed', day.closed === true);
  const out = applyLeadTime(day, { now: '2026-11-01T00:00:00Z', leadHours: 0 });
  eq('(e) every window on a closed day is CLOSED', reasons(out), ['CLOSED', 'CLOSED']);
  eq('(e) every window on a closed day is disabled', disabled(out), [true, true]);
  ok('(e) a closed day is not bookable', out.bookable === false && out.earliest === null);
}

/* ------------------------------------------------ (f) bookable and earliest */
{
  const day = buildDay('2026-11-03', { rows: [{ window_id: 'w1', capacity: 2, booked: 2 }] });
  const out = applyLeadTime(day, { now: '2026-11-03T04:00:00Z', leadHours: 0 });
  eq('(f) bookable is true while one window is open', out.bookable, true);
  eq('(f) earliest is the first open window', out.earliest, { windowId: 'w2', start: '16:00' });
  eq('(f) the lead time is echoed back as a number', out.leadHours, 0);

  const later = applyLeadTime(day, { now: '2026-11-03T04:00:00Z', leadHours: 4 });
  eq('(f) bookable picks the first open window, not the first window', later.earliest, { windowId: 'w2', start: '16:00' });

  // 20:00 Riyadh: both windows are gone for today (the bug this fixes).
  const night = applyLeadTime(buildDay('2026-11-03'), { now: '2026-11-03T17:00:00Z', leadHours: 4 });
  eq('(f) after close of the last window nothing is bookable', [night.bookable, night.earliest], [false, null]);
  eq('(f) and both windows say LEAD_TIME', reasons(night), ['LEAD_TIME', 'LEAD_TIME']);
}

/* --------------------------------------------- (g) the input is not mutated */
{
  const day = buildDay('2026-11-03');
  const before = JSON.stringify(day);
  const out = applyLeadTime(day, { now: '2026-11-03T09:00:00Z', leadHours: 4 });
  eq('(g) the input day is unchanged', JSON.stringify(day), before);
  ok('(g) a new day object is returned', out !== day);
  ok('(g) a new windows array is returned', out.windows !== day.windows);
  ok('(g) input windows never learn about reasons', !('reason' in day.windows[0]) && day.windows[0].disabled === false);
  ok('(g) output windows carry a reason field', 'reason' in out.windows[0]);
}

/* ------------------------- (h) leadHours 0 leaves a future window open */
{
  const out = applyLeadTime(buildDay('2026-11-03'), { now: '2026-11-03T04:00:00Z', leadHours: 0 });
  eq('(h) with no lead time the 11:00 window is open', [out.windows[0].reason, out.windows[0].disabled], [null, false]);
  eq('(h) earliest points at it', out.earliest, { windowId: 'w1', start: '11:00' });

  const future = applyLeadTime(buildDay('2026-11-05'), { now: '2026-11-03T17:00:00Z', leadHours: 4 });
  eq('(h) a future day is bookable with a 4h lead time', [future.bookable, reasons(future)], [true, [null, null]]);
}

/* ---------------------------------------------------------------- edges */
{
  // A day with no room left must not advertise free windows: reserving would
  // fail with DAY_FULL even though the window has seats.
  const fullDay = buildDay('2026-11-03', { rows: [{ window_id: 'day', capacity: 4, booked: 4 }] });
  const out = applyLeadTime(fullDay, { now: '2026-11-03T04:00:00Z', leadHours: 0 });
  eq('a day with no capacity marks its windows FULL', reasons(out), ['FULL', 'FULL']);
  eq('a day with no capacity is not bookable', [out.bookable, out.earliest], [false, null]);
}
{
  const junk = { date: 'not-a-date', closed: false, remaining: 5, windows: [{ id: 'w1', start: '11:00', remaining: 2, disabled: false }] };
  eq('an unparseable date leaves the day untouched', applyLeadTime(junk, { now: '2026-11-03T09:00:00Z', leadHours: 4 }), junk);
}
{
  const empty = applyLeadTime(buildDay('2026-11-03'), { now: '2026-11-03T04:00:00Z' });
  eq('a call with no options still returns leadHours 0', empty.leadHours, 0);
  eq('the shape of the day is preserved', Object.keys(empty), ['date', 'weekday', 'closed', 'dayCapacity', 'dayBooked', 'remaining', 'windows', 'leadHours', 'bookable', 'earliest']);
  eq('the shape of a window is preserved', Object.keys(empty.windows[0]), ['id', 'start', 'end', 'label', 'capacity', 'booked', 'remaining', 'disabled', 'reason']);
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('FAILED:', failures.join(' | '));
  process.exit(1);
}
