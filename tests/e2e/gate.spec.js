import { test, expect } from '@playwright/test';

/**
 * Cake Genius 1.3 gate spec (browser, rendered DOM only).
 *
 * Source of truth lives in the app repo at tests/e2e/gate.spec.js; the gate runs
 * the copy in the lab so Playwright resolves its own config.
 *
 * 1.3 replaces the free datetime field with a capacity-aware slot picker driven
 * by GET /api/slots. This spec proves, in the browser:
 *   - the picker renders in Arabic (legend, labels, weekday, Arabic-Indic digits)
 *     and the old #dateInput is gone;
 *   - picking an open window changes what /api/quote is asked to price;
 *   - the order created through the picker lands on the admin day board for the
 *     exact day AND window chosen (2 cakes => "2/<perWindow>" on that chip);
 *   - a FULL window (capacity forced to 1 through the admin API, then booked) is
 *     a real disabled radio: it cannot be selected and it says "مكتمل";
 *   - the 1.2 admin surface (day board, WhatsApp preview, settings, product
 *     creation) still works.
 *
 * The spec restores capacity and cancels its own order so it is repeatable
 * against a database file that survives between runs.
 */

const ADMIN_PASS = process.env.CAKE_ADMIN_PASSWORD || 'gate-pass';
const SHOP_OFFSET_MIN = 180; // Asia/Riyadh, no DST

const AR_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9', '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

function toArabicDigits(value) {
  return String(value).replace(/[0-9]/g, (d) => ARABIC_DIGITS[Number(d)]);
}

function money(text) {
  const normalized = String(text || '').replace(/[٠-٩۰-۹]/g, (d) => AR_DIGITS[d] || d);
  const digits = normalized.replace(/[^\d.-]/g, '');
  return digits ? Number(digits) : NaN;
}

/** Riyadh wall clock -> UTC instant. 11:00 on 2026-11-05 => 08:00Z. */
function windowStartIso(dateKey, hhmm) {
  const [y, m, d] = String(dateKey).split('-').map(Number);
  const [hh, mm] = String(hhmm).split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - SHOP_OFFSET_MIN * 60000).toISOString();
}

const iso = (value) => new Date(value).toISOString();
const hoursFromNow = (value) => (new Date(value).getTime() - Date.now()) / 36e5;

async function openCustomiser(page) {
  await page.waitForSelector('#productGrid button[data-id]', { timeout: 15_000 });
  await page.locator('#productGrid button[data-id]').first().click();
  await expect(page.locator('#customFields .slots-picker')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#customFields #dateInput')).toHaveCount(0);
}

test('1.3: pick a delivery window, order, and operate it from the admin dashboard', async ({ page }) => {
  test.setTimeout(90_000);

  const errors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // /api/admin/me answering 401 before login is the intended session probe.
    const url = m.location()?.url || '';
    if (m.text().includes('401') && url.includes('/api/admin/me')) return;
    errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  // Every quote request the customiser makes, normalised to the instant it priced.
  const quoteInstants = [];
  page.on('request', (req) => {
    if (req.method() !== 'POST' || !req.url().includes('/api/quote')) return;
    try {
      const body = JSON.parse(req.postData() || '{}');
      if (body?.config?.deliveryAt) quoteInstants.push(iso(body.config.deliveryAt));
    } catch { /* not our payload */ }
  });
  const expectQuoteFor = (instant) => expect.poll(
    () => quoteInstants.filter((value) => value === instant).length,
    { timeout: 15_000, message: `no /api/quote request carried deliveryAt ${instant}` },
  ).toBeGreaterThan(0);

  /* ---------------- the API contract the picker renders ---------------- */
  const slotsRes = await page.request.get('/api/slots?days=21');
  expect(slotsRes.status(), '/api/slots must answer').toBe(200);
  const slots = await slotsRes.json();
  expect(Array.isArray(slots.days), 'days must be an array').toBeTruthy();
  expect(slots.days.length).toBe(21);

  const allWindows = slots.days.flatMap((day) => (day.windows || []).map((w) => ({ ...w, date: day.date })));
  expect(allWindows.length, 'the shop must expose its delivery windows').toBeGreaterThan(0);
  for (const w of allWindows) {
    expect(w.disabled, `disabled must mirror reason on ${w.date}/${w.id}`).toBe(w.reason !== null);
    expect([null, 'CLOSED', 'FULL', 'LEAD_TIME']).toContain(w.reason);
  }
  expect(typeof slots.days[0].leadHours).toBe('number');
  if (slots.nextAvailable !== null) {
    const na = slots.nextAvailable;
    const day = slots.days.find((d) => d.date === na.date);
    expect(day, 'nextAvailable.date must be one of the returned days').toBeTruthy();
    const win = day.windows.find((w) => w.id === na.windowId);
    expect(win && win.disabled === false, 'nextAvailable must point at an open window').toBeTruthy();
    expect(iso(windowStartIso(na.date, win.start))).toBeTruthy();
  }

  /* A day late enough that lead time can never invalidate it, with two windows
     that have never been booked, so the FULL scenario below is deterministic. */
  const target = [...slots.days].reverse().find((day) => day.windows.length >= 2
    && day.windows.every((w) => w.disabled === false && Number(w.booked) === 0));
  expect(target, 'a virgin day with two open windows must exist').toBeTruthy();
  const chosenWindow = target.windows[1];
  const chosenInstant = iso(windowStartIso(target.date, chosenWindow.start));

  /* ---------------- storefront: Arabic picker + real window choice ---------------- */
  await page.goto('/');
  await expect(page).toHaveTitle(/Cake Genius/i);
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await openCustomiser(page);

  // Arabic-first labels, and Arabic-Indic digits on the times the customer reads.
  await expect(page.locator('#customFields .slots-picker legend')).toHaveText('موعد التسليم');
  await expect(page.locator('#customFields .slots-day-label').nth(0)).toHaveText('تاريخ التسليم');
  await expect(page.locator('#customFields .slots-day-label').nth(1)).toHaveText('فترة التسليم');
  const firstDayOption = (await page.locator('#customFields .slots-day-select option').first().textContent()) || '';
  expect(firstDayOption, `day label should carry an Arabic weekday: ${firstDayOption}`)
    .toMatch(/الأحد|الاثنين|الثلاثاء|الأربعاء|الخميس|الجمعة|السبت/);
  expect(firstDayOption, `day label should use Arabic-Indic digits: ${firstDayOption}`).toMatch(/[٠-٩]/);
  const firstChipTime = (await page.locator('#customFields .slots-windows .slots-time').first().textContent()) || '';
  expect(firstChipTime, `window time should use Arabic-Indic digits: ${firstChipTime}`).toMatch(/[٠-٩]/);

  // Select the target day, then a window that is NOT the auto-selected first one.
  const daySelect = page.locator('#customFields .slots-day-select');
  await daySelect.selectOption(target.date);
  await expect(page.locator('#customFields .slots-windows .slots-chip')).toHaveCount(target.windows.length);

  const chipFor = (window) => page.locator('#customFields .slots-windows .slots-chip')
    .filter({ hasText: toArabicDigits(window.label) });
  const chosenChip = chipFor(chosenWindow);
  await expect(chosenChip).toHaveCount(1);
  await chosenChip.click();

  await expect(page.locator('#customFields .slots-windows .slots-chip.is-selected')).toHaveCount(1);
  await expect(chosenChip).toHaveClass(/is-selected/);
  await expect(page.locator('#customFields .slots-status')).toContainText('الفترة المختارة');
  await expect(page.locator('#customFields .slots-status')).toContainText(toArabicDigits(chosenWindow.label));

  // The window the customer picked is the instant pricing is asked to price.
  await expectQuoteFor(chosenInstant);
  await expect.poll(async () => Number(await page.locator('#quoteBox').getAttribute('data-total')), { timeout: 15_000 })
    .toBeGreaterThan(0);

  /* ---------------- the quote follows the slot, not just the cake ---------------- */
  const earliestOpenDay = slots.days.find((day) => day.windows.some((w) => w.disabled === false));
  const earliestOpenWindow = earliestOpenDay && earliestOpenDay.windows.find((w) => w.disabled === false);
  expect(earliestOpenWindow, 'at least one open window must exist').toBeTruthy();
  const nearInstant = iso(windowStartIso(earliestOpenDay.date, earliestOpenWindow.start));
  const farTotal = Number(await page.locator('#quoteBox').getAttribute('data-total'));

  if (nearInstant !== chosenInstant) {
    await daySelect.selectOption(earliestOpenDay.date);
    await expect.poll(async () => Number(await page.locator('#quoteBox').getAttribute('data-total')), { timeout: 15_000 })
      .toBeGreaterThan(0);
    await expectQuoteFor(nearInstant);

    // A slot inside 24h carries the rush surcharge; the far slot must not.
    if (hoursFromNow(nearInstant) < 24) {
      await expect(page.locator('#quoteLines')).toContainText('مستعجل');
      const nearTotal = Number(await page.locator('#quoteBox').getAttribute('data-total'));
      expect(nearTotal, 'the near slot (rush) must price above the far slot').toBeGreaterThan(farTotal);
    }
  }

  // Back to the chosen day/window for the order itself.
  await daySelect.selectOption(target.date);
  await chipFor(chosenWindow).click();
  await expectQuoteFor(chosenInstant);
  await expect(page.locator('#quoteLines')).not.toContainText('مستعجل');

  const qty = page.locator('#qtyInput');
  await qty.fill('2');
  await qty.dispatchEvent('input');
  await qty.dispatchEvent('change');
  await expect(page.locator('#quoteBox')).toHaveAttribute('data-qty', '2');

  const unit = money(await page.locator('#quoteUnit').textContent());
  expect(unit).toBeGreaterThan(0);

  await page.locator('#addToCartBtn').click();
  await page.waitForSelector('.cart-line', { timeout: 10_000 });
  await page.locator('#checkoutBtn').click();
  await page.waitForSelector('#checkoutForm', { timeout: 10_000 });
  await page.fill('#cName', 'عميل البوابة');
  await page.fill('#cPhone', '0555777001');
  await page.locator('#placeOrderBtn').click();

  await page.waitForSelector('.order-code', { timeout: 20_000 });
  const code = (await page.locator('.order-code').textContent()).trim();
  expect(code).toMatch(/^CG-\d{4}$/);
  expect(money(await page.locator('#serverTotal').textContent())).toBeGreaterThan(0);

  /* ---------------- admin: the order is on the day AND in the window chosen ---------------- */
  await page.goto('/admin');
  await page.fill('#username', 'admin');
  await page.fill('#password', ADMIN_PASS);
  await page.locator('#loginBtn').click();
  await expect(page.locator('#dashView')).toBeVisible({ timeout: 15_000 });

  const settingsRes = await page.request.get('/api/admin/settings');
  expect(settingsRes.status()).toBe(200);
  const settings = (await settingsRes.json()).settings;
  const perWindow = Number(settings['capacity.perWindow']);
  expect(perWindow).toBeGreaterThanOrEqual(2);

  expect(await page.locator('#ordersBody').textContent()).toContain(code);

  await page.fill('#dayDate', target.date);
  await page.locator('#dayDate').dispatchEvent('change');
  await page.waitForSelector('#dayBody [data-notify]', { timeout: 15_000 });
  expect(await page.locator('#dayBody').textContent()).toContain(code);
  expect(await page.locator('#daySlots .slot-chip').count()).toBeGreaterThanOrEqual(3);

  // Slot accuracy is visible: two cakes booked on the chosen window, not just the day.
  const slotsText = (await page.locator('#daySlots').textContent()) || '';
  expect(slotsText, `day board should show 2/${perWindow} in the chosen window; got ${slotsText.replace(/\s+/g, ' ')}`)
    .toContain(`2/${perWindow}`);

  // WhatsApp preview: rendered text + wa.me link, and it says nothing was sent.
  const orderRow = page.locator('#dayBody tr', { hasText: code });
  await orderRow.locator('[data-notify]').click();
  await expect(page.locator('#notifyModal')).toHaveClass(/is-open/);
  expect(await page.locator('#notifyBody').textContent()).toContain(code);
  expect((await page.locator('#notifyLink').getAttribute('href')) || '').toContain('https://wa.me/');
  await expect(page.locator('#notifyChannel')).toContainText('غير مفعّلة');
  await page.locator('#notifyClose').click();

  await expect(page.locator('#setDaily')).toHaveValue(/\d+/);

  // 1.2 regression: create a product from the dashboard.
  const slug = `gate-cake-${Date.now().toString().slice(-6)}`;
  await page.locator('#newProductBtn').click();
  await expect(page.locator('#productModal')).toHaveClass(/is-open/);
  await page.fill('#pSlug', slug);
  await page.fill('#pCategory', 'classic');
  await page.fill('#pNameAr', 'كيكة البوابة');
  await page.fill('#pNameEn', 'Gate cake');
  await page.fill('#pPrice', '275');
  await page.fill('#pDescAr', 'منتج أنشأته البوابة');
  await page.fill('#pDescEn', 'Product created by the gate');
  await page.locator('#productForm button[type="submit"]').click();
  await expect(page.locator('#productModal')).not.toHaveClass(/is-open/, { timeout: 15_000 });
  expect(await page.locator('#productsBody').textContent()).toContain(slug);

  /* ---------------- FULL window: capacity 1, already booked => disabled ---------------- */
  const patch = await page.request.patch('/api/admin/settings', { data: { 'capacity.perWindow': 1 } });
  expect(patch.status()).toBe(200);
  expect(Number((await patch.json()).settings['capacity.perWindow'])).toBe(1);

  await page.goto('/');
  await openCustomiser(page);
  await page.locator('#customFields .slots-day-select').selectOption(target.date);
  await expect(page.locator('#customFields .slots-windows .slots-chip')).toHaveCount(target.windows.length);

  const fullChip = chipFor(chosenWindow);
  await expect(fullChip).toHaveCount(1);
  await expect(fullChip, 'the booked window must now be FULL').toHaveClass(/is-disabled/);
  await expect(fullChip).toHaveAttribute('aria-disabled', 'true');
  await expect(fullChip.locator('.slots-meta')).toHaveText('مكتمل');

  const radioId = await fullChip.getAttribute('for');
  expect(radioId, 'the chip must point at its radio').toBeTruthy();
  const fullRadio = page.locator(`#customFields #${radioId}`);
  await expect(fullRadio).toBeDisabled();
  await fullChip.click({ force: true });
  await expect(fullRadio).not.toBeChecked();
  expect(await fullChip.evaluate((el) => el.classList.contains('is-selected'))).toBe(false);

  // The picker keeps working: exactly one other window is selected and enabled.
  const selectedChips = page.locator('#customFields .slots-windows .slots-chip.is-selected');
  await expect(selectedChips).toHaveCount(1);
  await expect(selectedChips).not.toHaveClass(/is-disabled/);

  // Every disabled chip explains itself in Arabic, never with a raw enum.
  const disabledReasons = await page.locator('#customFields .slots-chip.is-disabled .slots-meta').allTextContents();
  expect(disabledReasons.length).toBeGreaterThan(0);
  for (const reason of disabledReasons) {
    expect(['مكتمل', 'مغلق', 'انتهى الوقت']).toContain(reason.trim());
  }

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `horizontal overflow of ${overflow}px`).toBeLessThanOrEqual(1);

  /* ---------------- restore capacity + release the gate's own booking ---------------- */
  const restore = await page.request.patch('/api/admin/settings', { data: { 'capacity.perWindow': perWindow } });
  expect(restore.status()).toBe(200);

  const dayData = await (await page.request.get(`/api/admin/day?date=${encodeURIComponent(target.date)}`)).json();
  const row = (dayData.orders || []).find((o) => o.code === code);
  expect(row, 'the gate order must be findable to release its capacity').toBeTruthy();
  const cancel = await page.request.patch(`/api/admin/orders/${row.id}`, { data: { status: 'cancelled' } });
  expect(cancel.status()).toBe(200);

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});

/**
 * QA-1.3-01 regression: with /api/slots down the fallback field shows a
 * prefilled delivery time and must store exactly that instant. It was a fixme
 * while the defect was open; the field now commits its value and the server
 * refuses a delivery order without one, so the test runs for real.
 */
test('1.3 [QA-1.3-01]: a delivery order placed while /api/slots is down keeps the time it shows', async ({ page }) => {
  await page.route('**/api/slots*', (route) => route.abort('failed'));
  await page.goto('/');
  await page.waitForSelector('#productGrid button[data-id]', { timeout: 15_000 });
  await page.locator('#productGrid button[data-id]').first().click();
  await page.waitForSelector('#customFields .slots-fallback #dateInput', { timeout: 20_000 });
  await page.locator('#customFields button.opt[data-opt="delivery"]').click();
  await page.waitForSelector('#customFields .slots-fallback #dateInput', { timeout: 20_000 });

  const shown = await page.locator('#dateInput').inputValue();
  expect(shown, 'the fallback field is prefilled').not.toBe('');

  await page.locator('#addToCartBtn').click();
  await page.waitForSelector('.cart-line', { timeout: 10_000 });
  await page.locator('#checkoutBtn').click();
  await page.waitForSelector('#checkoutForm', { timeout: 10_000 });
  await page.fill('#cName', 'عميل الفشل');
  await page.fill('#cPhone', '0555800001');
  await page.locator('#placeOrderBtn').click();
  await page.waitForSelector('.order-code', { timeout: 20_000 });
  const code = (await page.locator('.order-code').textContent()).trim();

  const lookup = await page.request.post('/api/orders/lookup', { data: { code, phone: '0555800001' } });
  const order = (await lookup.json()).order;
  expect(iso(order.deliveryAt), 'the stored instant must be the one the customer read').toBe(iso(shown));
});
