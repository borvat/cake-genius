/**
 * Pure capacity/calendar rules: shop timezone, windows, closed days, clamps.
 * No database, no network — if these are wrong, overbooking maths is wrong.
 */
import {
  shopDate, shopTime, parseWindows, windowForTime, addDays, weekday,
  dayAvailability, parseClosedDays,
} from '../lib/capacity.js';

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

/* shop timezone is UTC+3, never the server's zone */
eq('22:30 UTC is already the next day in Riyadh', shopDate('2026-11-02T22:30:00Z'), '2026-11-03');
eq('20:59 UTC is still the same day in Riyadh', shopDate('2026-11-02T20:59:00Z'), '2026-11-02');
eq('shop clock reads +3', shopTime('2026-11-02T09:15:00Z'), '12:15');

/* windows */
const windows = parseWindows('11:00-14:00, 16:00-19:00');
eq('two windows parsed', windows.length, 2);
eq('window ids are stable', windows.map((w) => w.id), ['w1', 'w2']);
eq('labels are normalised', windows[0].label, '11:00 - 14:00');
eq('a 12:00 delivery belongs to the first window', windowForTime('12:00', windows)?.id, 'w1');
eq('11:00 is the inclusive start', windowForTime('11:00', windows)?.id, 'w1');
eq('14:00 is the exclusive end', windowForTime('14:00', windows), null);
eq('17:30 belongs to the evening window', windowForTime('17:30', windows)?.id, 'w2');
eq('09:00 is outside every window', windowForTime('09:00', windows), null);
eq('a malformed spec yields no windows', parseWindows('noon-late').length, 0);

/* dates */
eq('addDays crosses a month boundary', addDays('2026-01-31', 1), '2026-02-01');
eq('addDays crosses a year boundary', addDays('2026-12-31', 1), '2027-01-01');
eq('weekday of 2026-11-02 is Monday (1)', weekday('2026-11-02'), 1);

/* closed days */
eq('closed days parse and drop junk', parseClosedDays('5, 7, x'), [5]);
const closed = dayAvailability({
  date: '2026-11-06', windows, dayCapacity: 10, perWindowCapacity: 4, rows: [], closedDays: '5',
});
ok('a closed weekday is marked closed', closed.closed === true);
ok('every window is disabled when the day is closed', closed.windows.every((w) => w.disabled));

/* availability arithmetic */
const rows = [
  { window_id: 'day', capacity: 5, booked: 4 },
  { window_id: 'w1', capacity: 2, booked: 2 },
  { window_id: 'w2', capacity: 2, booked: 1 },
];
const day = dayAvailability({
  date: '2026-11-03', windows, dayCapacity: 5, perWindowCapacity: 2, rows, closedDays: '', minDate: '2026-11-01', maxDate: '2027-01-01',
});
eq('day remaining = capacity - booked', day.remaining, 1);
eq('full window has 0 remaining', day.windows[0].remaining, 0);
eq('full window is disabled', day.windows[0].disabled, true);
eq('window with room stays enabled', day.windows[1].disabled, false);
eq('unbooked day falls back to the default capacity', dayAvailability({ date: '2026-11-04', windows, dayCapacity: 7, perWindowCapacity: 3, rows: [] }).remaining, 7);

/* past and too-far dates */
const past = dayAvailability({ date: '2026-10-01', windows, dayCapacity: 5, perWindowCapacity: 2, rows: [], minDate: '2026-11-01' });
ok('a past date is not orderable', past.closed === true);
const future = dayAvailability({ date: '2027-02-01', windows, dayCapacity: 5, perWindowCapacity: 2, rows: [], maxDate: '2026-12-31' });
ok('a date beyond the booking horizon is not orderable', future.closed === true);

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('FAILED:', failures.join(' | '));
  process.exit(1);
}
