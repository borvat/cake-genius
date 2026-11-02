import { test, expect } from '@playwright/test';

/**
 * Cake Genius 1.2 gate spec (browser, rendered DOM only).
 * Source of truth lives in the app repo at tests/e2e/gate.spec.js; the gate runs
 * the copy in the lab so Playwright resolves its own config.
 *
 * Covers what 1.2 added end to end: capacity-aware delivery date, checkout,
 * admin login, the day board, the WhatsApp preview (never sent), and creating a
 * product from the dashboard.
 */

const ADMIN_PASS = process.env.CAKE_ADMIN_PASSWORD || 'gate-pass';

const AR_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9', '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9' };
function money(text) {
  const normalized = String(text || '').replace(/[٠-٩۰-۹]/g, (d) => AR_DIGITS[d] || d);
  const digits = normalized.replace(/[^\d.-]/g, '');
  return digits ? Number(digits) : NaN;
}

function tomorrowAtNoon() {
  const d = new Date(Date.now() + 864e5);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    input: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T12:00`,
    day: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
  };
}

test('1.2: order with a chosen day, then operate it from the admin dashboard', async ({ page }) => {
  const errors = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // /api/admin/me answering 401 before login is the intended session probe,
    // not a page fault. Everything else still counts.
    const url = m.location()?.url || '';
    if (m.text().includes('401') && url.includes('/api/admin/me')) return;
    errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));

  const when = tomorrowAtNoon();

  /* ---------------- storefront: customise, price, checkout ---------------- */
  await page.goto('/');
  await expect(page).toHaveTitle(/Cake Genius/i);

  await page.waitForSelector('#productGrid button[data-id]', { timeout: 15_000 });
  await page.locator('#productGrid button[data-id]').first().click();
  await page.waitForSelector('#quoteTotal', { timeout: 10_000 });

  await page.fill('#dateInput', when.input);
  await page.locator('#dateInput').dispatchEvent('change');

  const qty = page.locator('#qtyInput');
  await qty.fill('2');
  await qty.dispatchEvent('input');
  await qty.dispatchEvent('change');
  await page.waitForFunction(() => document.querySelector('#quoteBox')?.dataset.qty === '2', { timeout: 10_000 });

  const unit = money(await page.locator('#quoteTotal').textContent());
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

  const serverTotal = money(await page.locator('#serverTotal').textContent());
  expect(serverTotal).toBeGreaterThan(0);

  /* ---------------- admin: login, see the order, operate the day ---------------- */
  await page.goto('/admin');
  await page.fill('#username', 'admin');
  await page.fill('#password', ADMIN_PASS);
  await page.locator('#loginBtn').click();
  await expect(page.locator('#dashView')).toBeVisible({ timeout: 15_000 });

  const ordersText = await page.locator('#ordersBody').textContent();
  expect(ordersText, 'the order created in the browser must appear in the dashboard').toContain(code);

  // day board: select the delivery date and find the row
  await page.fill('#dayDate', when.day);
  await page.locator('#dayDate').dispatchEvent('change');
  await page.waitForSelector('#dayBody [data-notify]', { timeout: 15_000 });
  const dayText = await page.locator('#dayBody').textContent();
  expect(dayText).toContain(code);
  expect(await page.locator('#daySlots .slot-chip').count()).toBeGreaterThanOrEqual(3);

  // WhatsApp preview: rendered text + wa.me link, and it says nothing was sent
  await page.locator('#dayBody [data-notify]').first().click();
  await expect(page.locator('#notifyModal')).toHaveClass(/is-open/);
  const preview = await page.locator('#notifyBody').textContent();
  expect(preview).toContain(code);
  const href = await page.locator('#notifyLink').getAttribute('href');
  expect(href || '').toContain('https://wa.me/');
  await expect(page.locator('#notifyChannel')).toContainText('غير مفعّلة');
  await page.locator('#notifyClose').click();

  // settings panel is present and editable
  await expect(page.locator('#setDaily')).toHaveValue(/\d+/);

  // create a product from the dashboard
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

  const productsText = await page.locator('#productsBody').textContent();
  expect(productsText).toContain('كيكة البوابة');
  expect(productsText).toContain(slug);

  // no page-level horizontal overflow in RTL
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `horizontal overflow of ${overflow}px`).toBeLessThanOrEqual(1);

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});
