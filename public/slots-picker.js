/**
 * Cake Genius — capacity-aware delivery slot picker (1.3).
 *
 * Framework-free ESM. Everything except mountSlotsPicker() is a pure function,
 * so Node can import this file with no DOM at import time. Dates are Riyadh
 * calendar days (UTC+3, no DST) — never the browser's local zone.
 */

const SHOP_OFFSET_MIN = 180;

/* Explicit names: Intl month/weekday output differs per ICU build and would
   silently switch digits/locale in some browsers. */
const WEEKDAYS = {
  ar: ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'],
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
};

const MONTHS = {
  ar: ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
};

const REASONS = {
  CLOSED: { ar: 'مغلق', en: 'Closed' },
  FULL: { ar: 'مكتمل', en: 'Full' },
  LEAD_TIME: { ar: 'انتهى الوقت', en: 'Too late' },
};

const UI = {
  ar: {
    legend: 'موعد التسليم',
    dateLabel: 'تاريخ التسليم',
    windowLabel: 'فترة التسليم',
    remaining: '{n} متاح',
    selected: 'الفترة المختارة',
    today: 'اليوم',
    tomorrow: 'غداً',
    noWindows: 'لا فترات تسليم متاحة في هذا اليوم.',
    noDays: 'لا توجد أيام متاحة للتسليم.',
  },
  en: {
    legend: 'Delivery time',
    dateLabel: 'Delivery date',
    windowLabel: 'Delivery window',
    remaining: '{n} left',
    selected: 'Selected window',
    today: 'Today',
    tomorrow: 'Tomorrow',
    noWindows: 'No delivery windows on this day.',
    noDays: 'No delivery days are available.',
  },
};

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const asLang = (lang) => (lang === 'en' ? 'en' : 'ar');

/** 123 -> '١٢٣' for Arabic, unchanged for English. */
function localiseDigits(value, lang) {
  const s = String(value);
  return asLang(lang) === 'ar' ? s.replace(/[0-9]/g, (d) => AR_DIGITS[Number(d)]) : s;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Calendar day key (YYYY-MM-DD) in Riyadh time for a Date / ISO string.
 * Returns null for unusable input.
 */
export function shopDateKey(input) {
  const t = input instanceof Date ? input : new Date(input);
  if (!Number.isFinite(t.getTime())) return null;
  return new Date(t.getTime() + SHOP_OFFSET_MIN * 60000).toISOString().slice(0, 10);
}

/** Wall-clock HH:MM in Riyadh time for a Date / ISO string, or null. */
function shopTimeKey(input) {
  const t = input instanceof Date ? input : new Date(input);
  if (!Number.isFinite(t.getTime())) return null;
  return new Date(t.getTime() + SHOP_OFFSET_MIN * 60000).toISOString().slice(11, 16);
}

/**
 * UTC ISO instant for a Riyadh wall-clock window start.
 * windowStartIso('2026-11-05', '11:00') -> '2026-11-05T08:00:00.000Z'
 * Returns null for anything that is not a real date + HH:MM pair.
 */
export function windowStartIso(date, start) {
  if (typeof date !== 'string' || typeof start !== 'string') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(start)) return null;
  const hh = Number(start.slice(0, 2));
  const mm = Number(start.slice(3, 5));
  if (hh > 23 || mm > 59) return null;
  const at = new Date(`${date}T${start}:00+03:00`);
  if (!Number.isFinite(at.getTime())) return null;
  // Reject rolled-over dates such as 2026-02-30.
  if (shopDateKey(at) !== date || shopTimeKey(at) !== start) return null;
  return at.toISOString();
}

function addDaysKey(dateKey, n) {
  const d = new Date(`${dateKey}T00:00:00Z`);
  if (!Number.isFinite(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function isWindowOpen(w) {
  if (!w || typeof w !== 'object') return false;
  if (w.disabled === true) return false;
  if (w.reason) return false;
  if (Number.isFinite(w.remaining) && w.remaining <= 0) return false;
  return true;
}

function dayRemaining(day) {
  if (Number.isFinite(day.remaining)) return day.remaining;
  const windows = Array.isArray(day.windows) ? day.windows : [];
  return windows.reduce((sum, w) => sum + (Number.isFinite(w && w.remaining) ? w.remaining : 0), 0);
}

function dayDisabled(day) {
  if (!day || typeof day !== 'object') return true;
  if (day.closed === true || day.bookable === false) return true;
  const windows = Array.isArray(day.windows) ? day.windows : [];
  if (!windows.length) return true;
  if (dayRemaining(day) <= 0) return true;
  return !windows.some(isWindowOpen);
}

/**
 * buildDayOptions(days, { lang, today })
 * -> [{ value, label, disabled, remaining }] in the same order as `days`.
 * `today` is a Riyadh YYYY-MM-DD key used only for the Today/Tomorrow prefix.
 */
export function buildDayOptions(days, { lang = 'ar', today = null } = {}) {
  if (!Array.isArray(days)) return [];
  const L = asLang(lang);
  const tomorrow = typeof today === 'string' ? addDaysKey(today, 1) : null;
  const opts = [];
  for (const day of days) {
    if (!day || typeof day.date !== 'string') continue;
    const parts = day.date.split('-').map(Number);
    if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n))) continue;
    const [y, m, d] = parts;
    if (m < 1 || m > 12 || d < 1 || d > 31) continue;
    const weekdayIdx = Number.isInteger(day.weekday) ? day.weekday : new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    const weekdayName = WEEKDAYS[L][weekdayIdx] || '';
    const monthName = MONTHS[L][m - 1];
    const bits = [];
    if (today && day.date === today) bits.push(UI[L].today);
    else if (tomorrow && day.date === tomorrow) bits.push(UI[L].tomorrow);
    bits.push(`${weekdayName} ${localiseDigits(`${d} ${monthName}`, L)}`);
    opts.push({
      value: day.date,
      label: bits.filter(Boolean).join(' · '),
      disabled: dayDisabled(day),
      remaining: Math.max(0, dayRemaining(day)),
    });
  }
  return opts;
}

/** CLOSED / FULL / LEAD_TIME -> short label; anything else -> ''. */
export function labelForReason(reason, lang) {
  const entry = REASONS[reason];
  if (!entry) return '';
  return entry[asLang(lang)];
}

/**
 * pickDefaultWindow(days, nextAvailable) -> { date, windowId } | null
 * Prefers the server's nextAvailable when that window is still open, else the
 * first open window of the first open day.
 */
export function pickDefaultWindow(days, nextAvailable) {
  const list = Array.isArray(days) ? days : [];
  const dayFor = (date) => list.find((d) => d && d.date === date) || null;

  if (nextAvailable && typeof nextAvailable.date === 'string' && nextAvailable.windowId) {
    const day = dayFor(nextAvailable.date);
    const win = day && (Array.isArray(day.windows) ? day.windows : []).find((w) => w && w.id === nextAvailable.windowId);
    if (win && isWindowOpen(win)) return { date: nextAvailable.date, windowId: win.id };
  }

  for (const day of list) {
    if (!day || typeof day.date !== 'string') continue;
    if (day.closed === true || day.bookable === false) continue;
    const win = (Array.isArray(day.windows) ? day.windows : []).find(isWindowOpen);
    if (win) return { date: day.date, windowId: win.id };
  }
  return null;
}

/* ------------------------------------------------------------------ DOM UI */

let uid = 0;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * mountSlotsPicker(root, { days, lang, value, onChange })
 * Renders a fieldset (legend "Delivery time"), a day <select> and a radio-chip
 * row of windows. Disabled chips are real disabled radios, expose
 * aria-disabled and their reason, and can never be chosen.
 * `value` accepts an ISO instant or { date, windowId }.
 * Returns { update(days, lang) }.
 */
export function mountSlotsPicker(root, { days = [], lang = 'ar', value = null, onChange = () => {} } = {}) {
  if (!root || typeof root.appendChild !== 'function') return { update() {} };

  let L = asLang(lang);
  let ui = UI[L];
  let list = Array.isArray(days) ? days : [];
  let selectedDate = null;
  let selectedWindow = null;
  let lastEmitted = null;

  const name = `cg-slot-${++uid}`;

  const fieldset = el('fieldset', 'slots-picker');
  const legend = el('legend', '', ui.legend);
  fieldset.append(legend);

  const dayWrap = el('div', 'slots-day');
  const dayLabel = el('label', 'slots-day-label', ui.dateLabel);
  const select = el('select', 'slots-day-select');
  const selectId = `${name}-day`;
  dayLabel.htmlFor = selectId;
  select.id = selectId;
  dayWrap.append(dayLabel, select);

  const winWrap = el('div', 'slots-windows-wrap');
  const winLabel = el('span', 'slots-day-label', ui.windowLabel);
  const winLabelId = `${name}-win`;
  winLabel.id = winLabelId;
  const grid = el('div', 'slots-windows');
  grid.setAttribute('role', 'radiogroup');
  grid.setAttribute('aria-labelledby', winLabelId);
  winWrap.append(winLabel, grid);

  const status = el('p', 'slots-status slots-status-selected');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');

  fieldset.append(dayWrap, winWrap, status);
  root.append(fieldset);

  const dayFor = (date) => list.find((d) => d && d.date === date) || null;

  function syncChecked(windowId) {
    for (const radio of grid.querySelectorAll('.slot-radio')) {
      const on = radio.value === windowId && !radio.disabled;
      radio.checked = on;
      if (radio.nextElementSibling) radio.nextElementSibling.classList.toggle('is-selected', on);
    }
  }

  function emit(windowId) {
    const day = dayFor(selectedDate);
    const win = day && (Array.isArray(day.windows) ? day.windows : []).find((w) => w && w.id === windowId);
    if (!win) return;
    const iso = windowStartIso(selectedDate, win.start);
    if (!iso) return;
    selectedWindow = win.id;
    syncChecked(win.id);
    status.textContent = `${ui.selected}: ${localiseDigits(win.label || `${win.start} - ${win.end}`, L)}`;
    if (iso === lastEmitted) return;
    lastEmitted = iso;
    onChange({ date: selectedDate, windowId: win.id, iso });
  }

  function chooseFirstOpen() {
    const day = dayFor(selectedDate);
    if (!day) return false;
    const win = (Array.isArray(day.windows) ? day.windows : []).find(isWindowOpen);
    if (!win) return false;
    emit(win.id);
    return true;
  }

  function renderWindows() {
    grid.innerHTML = '';
    status.textContent = '';
    if (!selectedDate) {
      status.textContent = ui.noDays;
      return;
    }
    const day = dayFor(selectedDate);
    if (!day) {
      status.textContent = ui.noWindows;
      return;
    }
    const closedDay = day.closed === true;
    for (const w of Array.isArray(day.windows) ? day.windows : []) {
      if (!w || !w.id || !w.start) continue;
      const open = isWindowOpen(w);
      const id = `${name}-${w.id}`;
      const cell = el('div', 'slot-cell');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.className = 'slot-radio';
      radio.name = name;
      radio.id = id;
      radio.value = w.id;
      radio.checked = selectedWindow === w.id && open;
      if (!open) {
        radio.disabled = true;
        radio.setAttribute('aria-disabled', 'true');
      }
      const chip = el('label', 'slot-chip');
      chip.htmlFor = id;
      if (!open) {
        chip.classList.add('is-disabled');
        chip.setAttribute('aria-disabled', 'true');
      }
      if (selectedWindow === w.id && open) chip.classList.add('is-selected');
      const timeText = localiseDigits(w.label || `${w.start} - ${w.end}`, L);
      chip.append(el('span', 'slot-time', timeText));

      const reason = !open ? (w.reason || (closedDay ? 'CLOSED' : 'FULL')) : null;
      let metaText = '';
      if (reason) metaText = labelForReason(reason, L);
      else if (Number.isFinite(w.remaining)) metaText = ui.remaining.replace('{n}', localiseDigits(w.remaining, L));
      if (metaText) chip.append(el('span', 'slot-meta', metaText));
      radio.setAttribute('aria-label', [timeText, metaText].filter(Boolean).join(' — '));

      radio.addEventListener('change', () => {
        if (!open) return;
        emit(w.id);
      });
      cell.append(radio, chip);
      grid.append(cell);
    }
  }

  function renderDayOptions() {
    const opts = buildDayOptions(list, { lang: L, today: shopDateKey(new Date()) });
    select.innerHTML = '';
    for (const opt of opts) {
      const option = document.createElement('option');
      option.value = opt.value;
      option.textContent = opt.label;
      option.disabled = opt.disabled;
      select.append(option);
    }
    if (!opts.length) {
      status.textContent = ui.noDays;
      return;
    }
    const stillValid = opts.some((o) => o.value === selectedDate && !o.disabled);
    if (!stillValid) {
      const first = opts.find((o) => !o.disabled);
      selectedDate = first ? first.value : null;
      selectedWindow = null;
    }
    if (selectedDate) select.value = selectedDate;
  }

  function resolveInitialValue() {
    if (!value) return false;
    let iso = null;
    let date = null;
    let windowId = null;
    if (typeof value === 'string') {
      iso = value;
    } else if (typeof value === 'object') {
      if (typeof value.date === 'string' && value.windowId) {
        date = value.date;
        windowId = value.windowId;
      } else if (typeof value.iso === 'string') {
        iso = value.iso;
      }
    }
    if (iso) date = shopDateKey(iso);
    if (!date) return false;
    const day = dayFor(date);
    if (!day) return false;
    const time = iso ? shopTimeKey(iso) : null;
    const windows = Array.isArray(day.windows) ? day.windows : [];
    const win = windowId
      ? windows.find((w) => w && w.id === windowId)
      : windows.find((w) => w && typeof w.start === 'string' && typeof w.end === 'string' && time && time >= w.start && time < w.end);
    if (!win || !isWindowOpen(win)) return false;
    selectedDate = date;
    selectedWindow = win.id;
    return true;
  }

  function render() {
    legend.textContent = ui.legend;
    dayLabel.textContent = ui.dateLabel;
    winLabel.textContent = ui.windowLabel;
    renderDayOptions();
    renderWindows();
    if (!selectedWindow && selectedDate) chooseFirstOpen();
  }

  function update(nextDays, nextLang) {
    list = Array.isArray(nextDays) ? nextDays : [];
    if (nextLang) {
      L = asLang(nextLang);
      ui = UI[L];
    }
    const day = dayFor(selectedDate);
    const win = day && (Array.isArray(day.windows) ? day.windows : []).find((w) => w && w.id === selectedWindow);
    if (!win || !isWindowOpen(win)) selectedWindow = null;
    render();
  }

  select.addEventListener('change', () => {
    selectedDate = select.value;
    selectedWindow = null;
    renderWindows();
    if (!selectedWindow) chooseFirstOpen();
  });

  const hadValue = resolveInitialValue();
  render();
  // Emit the default choice so the caller's config never stays empty.
  if (hadValue) {
    const day = dayFor(selectedDate);
    const win = day && (Array.isArray(day.windows) ? day.windows : []).find((w) => w && w.id === selectedWindow);
    if (win) emit(win.id);
  }

  return { update };
}
