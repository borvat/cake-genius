/**
 * Pure-function tests for the delivery slot picker (public/slots-picker.js).
 * No framework, no DOM: the module must be importable by plain Node.
 */
import {
  windowStartIso, buildDayOptions, labelForReason, pickDefaultWindow, shopDateKey,
} from '../public/slots-picker.js';

let pass = 0;
const failures = [];
function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`PASS  ${name}`); }
  else { failures.push(name); console.log(`FAIL  ${name} -> got ${a}, expected ${e}`); }
}
function ok(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { failures.push(name); console.log(`FAIL  ${name} ${detail}`); }
}

/* ---------- windowStartIso: Riyadh wall clock -> UTC instant ---------- */

eq('11:00 Riyadh on 2026-11-05 is 08:00Z', windowStartIso('2026-11-05', '11:00'), '2026-11-05T08:00:00.000Z');
eq('16:00 Riyadh on 2026-11-05 is 13:00Z', windowStartIso('2026-11-05', '16:00'), '2026-11-05T13:00:00.000Z');
eq('22:00 Riyadh stays on the same UTC day', windowStartIso('2026-11-05', '22:00'), '2026-11-05T19:00:00.000Z');
eq('00:00 Riyadh rolls back to the previous UTC day', windowStartIso('2026-01-01', '00:00'), '2025-12-31T21:00:00.000Z');
eq('the result is a canonical ISO string', windowStartIso('2026-11-05', '11:00'), new Date('2026-11-05T11:00:00+03:00').toISOString());

eq('missing arguments return null', windowStartIso(undefined, '11:00'), null);
eq('a null date returns null', windowStartIso(null, '11:00'), null);
eq('a non-string date returns null', windowStartIso(20261105, '11:00'), null);
eq('a swapped argument order returns null', windowStartIso('11:00', '2026-11-05'), null);
eq('a time without padding returns null', windowStartIso('2026-11-05', '9:00'), null);
eq('hour 24 returns null', windowStartIso('2026-11-05', '24:00'), null);
eq('minute 60 returns null', windowStartIso('2026-11-05', '11:60'), null);
eq('a rolled-over date returns null', windowStartIso('2026-02-30', '11:00'), null);
eq('month 13 returns null', windowStartIso('2026-13-01', '11:00'), null);
eq('a time with seconds returns null', windowStartIso('2026-11-05', '11:00:00'), null);

eq('shopDateKey reads the Riyadh day, not UTC', shopDateKey('2026-11-05T22:00:00.000Z'), '2026-11-06');
eq('shopDateKey returns null for junk', shopDateKey('not-a-date'), null);

/* ---------- labelForReason: all cases, both languages ---------- */

eq('CLOSED (ar)', labelForReason('CLOSED', 'ar'), 'مغلق');
eq('CLOSED (en)', labelForReason('CLOSED', 'en'), 'Closed');
eq('FULL (ar)', labelForReason('FULL', 'ar'), 'مكتمل');
eq('FULL (en)', labelForReason('FULL', 'en'), 'Full');
eq('LEAD_TIME (ar)', labelForReason('LEAD_TIME', 'ar'), 'انتهى الوقت');
eq('LEAD_TIME (en)', labelForReason('LEAD_TIME', 'en'), 'Too late');
eq('null reason has no label (ar)', labelForReason(null, 'ar'), '');
eq('null reason has no label (en)', labelForReason(null, 'en'), '');
eq('unknown reason has no label', labelForReason('SOMETHING_ELSE', 'en'), '');
eq('an unknown language falls back to Arabic', labelForReason('FULL', 'fr'), 'مكتمل');

/* ---------- buildDayOptions ---------- */

const win = (id, start, end, extra = {}) => ({
  id, start, end, label: `${start} - ${end}`,
  capacity: 4, booked: 0, remaining: 4, disabled: false, reason: null, ...extra,
});

const days = [
  {
    date: '2026-11-05', weekday: 4, closed: false, dayCapacity: 10, dayBooked: 4, remaining: 6,
    windows: [win('w1', '11:00', '14:00', { remaining: 3, booked: 1 }), win('w2', '16:00', '19:00', { remaining: 0, booked: 4, disabled: true, reason: 'FULL' })],
  },
  {
    date: '2026-11-06', weekday: 5, closed: true, dayCapacity: 10, dayBooked: 0, remaining: 0,
    windows: [win('w1', '11:00', '14:00', { remaining: 0, disabled: true, reason: 'CLOSED' })],
  },
  {
    date: '2026-11-07', weekday: 6, closed: false, dayCapacity: 10, dayBooked: 10, remaining: 0,
    windows: [win('w1', '11:00', '14:00', { remaining: 0, booked: 4, disabled: true, reason: 'LEAD_TIME' })],
  },
];

const arOpts = buildDayOptions(days, { lang: 'ar' });
const enOpts = buildDayOptions(days, { lang: 'en' });

eq('one option per day', arOpts.length, 3);
eq('option value is the day key', arOpts[0].value, '2026-11-05');
eq('an open day is selectable', arOpts[0].disabled, false);
eq('remaining rides along', arOpts[0].remaining, 6);
eq('a closed day is disabled', arOpts[1].disabled, true);
eq('a day whose windows are all blocked is disabled', arOpts[2].disabled, true);

ok('Arabic label uses the Arabic weekday', arOpts[0].label.includes('الخميس'), arOpts[0].label);
ok('Arabic label uses the Arabic month', arOpts[0].label.includes('نوفمبر'), arOpts[0].label);
ok('Arabic label uses Arabic-Indic digits', arOpts[0].label.includes('٥'), arOpts[0].label);
ok('Arabic label has no Latin digits', !/[0-9]/.test(arOpts[0].label), arOpts[0].label);
ok('Arabic label is not English', !/Thursday/.test(arOpts[0].label), arOpts[0].label);

eq('English label is readable', enOpts[0].label, 'Thursday 5 November');
ok('English label stays Latin', !/[\u0600-\u06FF]/.test(enOpts[0].label), enOpts[0].label);

eq('today is called out (ar)', buildDayOptions(days, { lang: 'ar', today: '2026-11-05' })[0].label, 'اليوم · الخميس ٥ نوفمبر');
eq('tomorrow is called out (en)', buildDayOptions(days, { lang: 'en', today: '2026-11-04' })[0].label, 'Tomorrow · Thursday 5 November');
eq('today wins over tomorrow', buildDayOptions(days, { lang: 'en', today: '2026-11-05' })[0].label.startsWith('Today'), true);
eq('an unrelated today adds no prefix', buildDayOptions(days, { lang: 'en', today: '2026-10-01' })[0].label, 'Thursday 5 November');

eq('no days -> no options', buildDayOptions(null, { lang: 'ar' }), []);
eq('an empty list -> no options', buildDayOptions([], { lang: 'en' }), []);
eq('a malformed day is skipped', buildDayOptions([{ date: 'x' }, null], { lang: 'en' }).length, 0);

/* ---------- pickDefaultWindow ---------- */

const openDays = [
  { date: '2026-11-05', closed: false, remaining: 6, windows: [win('w1', '11:00', '14:00'), win('w2', '16:00', '19:00', { remaining: 0, disabled: true, reason: 'FULL' })] },
  { date: '2026-11-06', closed: false, remaining: 4, windows: [win('w1', '11:00', '14:00')] },
];

eq('nextAvailable is preferred',
  pickDefaultWindow(openDays, { date: '2026-11-06', windowId: 'w1', start: '11:00' }),
  { date: '2026-11-06', windowId: 'w1' });

eq('a disabled nextAvailable is ignored',
  pickDefaultWindow(openDays, { date: '2026-11-05', windowId: 'w2' }),
  { date: '2026-11-05', windowId: 'w1' });

eq('a nextAvailable for an unknown day is ignored',
  pickDefaultWindow(openDays, { date: '2026-12-24', windowId: 'w1' }),
  { date: '2026-11-05', windowId: 'w1' });

eq('no nextAvailable -> first open window of the first open day',
  pickDefaultWindow(openDays, null),
  { date: '2026-11-05', windowId: 'w1' });

eq('missing nextAvailable argument still picks a default',
  pickDefaultWindow(openDays),
  { date: '2026-11-05', windowId: 'w1' });

eq('every day disabled -> null', pickDefaultWindow([
  { date: '2026-11-05', closed: true, remaining: 0, windows: [] },
  { date: '2026-11-06', closed: false, remaining: 0, windows: [win('w1', '11:00', '14:00', { remaining: 0, disabled: true, reason: 'FULL' })] },
], { date: '2026-11-06', windowId: 'w1' }), null);

eq('an empty list -> null', pickDefaultWindow([], null), null);
eq('null days -> null', pickDefaultWindow(null, null), null);

/* ---------- result ---------- */

console.log('');
if (failures.length) {
  console.log(`FAILED ${failures.length} of ${pass + failures.length} checks`);
  for (const name of failures) console.log(`  - ${name}`);
  process.exit(1);
}
console.log(`PASSED all ${pass} checks`);
