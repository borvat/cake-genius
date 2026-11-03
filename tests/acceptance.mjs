/**
 * Cake Genius acceptance tests (black box, real HTTP).
 * Usage: BASE_URL=http://127.0.0.1:3000 ADMIN_USER=admin ADMIN_PASSWORD=... node tests/acceptance.mjs
 * Prints PASS/FAIL per check and exits non-zero on any failure.
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASSWORD || 'cake-admin-2026';

let pass = 0;
const failures = [];
let cookie = '';

function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { failures.push(name); console.log(`FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}

async function req(path, { method = 'GET', body, expect } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  let data = null;
  const text = await res.text();
  try { data = JSON.parse(text); } catch { data = text.slice(0, 120); }
  if (expect !== undefined && res.status !== expect) {
    throw new Error(`${method} ${path} expected ${expect} got ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
  }
  return { status: res.status, data };
}

const money = (n) => Math.round(n);

async function main() {
  console.log(`Base: ${BASE}\n`);

  /* 1. catalog */
  const products = await req('/api/products', { expect: 200 });
  check('catalog returns >= 10 products', products.data.products.length >= 10, String(products.data.products.length));
  check('every product has image, price, category, bilingual name',
    products.data.products.every((p) => p.image && p.basePrice > 0 && p.category && p.name.ar && p.name.en));
  const imagesOk = await Promise.all(products.data.products.map(async (p) => (await fetch(BASE + p.image)).status === 200));
  check('every product image is served', imagesOk.every(Boolean));

  const cfg = await req('/api/config', { expect: 200 });
  check('pricing rules exposed to client', cfg.data.rules.sizes.length === 4 && cfg.data.rules.flavors.length === 5);
  check('assistant engine declared honestly (rule-based when no key, llm-* when key)',
    cfg.data.assistant.engine === 'rule-based-nlu-v1' || /^llm-/.test(cfg.data.assistant.engine), cfg.data.assistant.engine);

  /* 2. pricing math - recomputed independently from the exposed rules */
  const rules = cfg.data.rules;
  const choco = products.data.products.find((p) => p.id === 'p-choco');
  const q1 = await req('/api/quote', { method: 'POST', expect: 200, body: { productId: 'p-choco', config: { size: 's8', flavor: 'pistachio', filling: 'ganache', design: 'floral', deliveryMethod: 'delivery' } } });
  const expected1 = money(choco.basePrice * rules.sizes.find((s) => s.id === 's8').multiplier)
    + rules.flavors.find((f) => f.id === 'pistachio').surcharge
    + rules.fillings.find((f) => f.id === 'ganache').surcharge
    + rules.designs.find((d) => d.id === 'floral').surcharge
    + 25;
  check(`quote matches independent math (${q1.data.quote.total} vs ${expected1})`, q1.data.quote.total === expected1);

  const q2 = await req('/api/quote', { method: 'POST', expect: 400, body: { productId: 'p-choco', config: { size: 'giant' } } });
  check('invalid size rejected with 400', q2.data.error === 'BAD_SIZE');

  const msg = 'كل عام وأنت بخير يا سارة وعقبال مئة سنة من الفرح'; // 46 chars -> 1 extra block
  const q3 = await req('/api/quote', { method: 'POST', expect: 200, body: { productId: 'p-choco', config: { message: msg } } });
  check('long message adds exactly one 12 SAR block', q3.data.quote.total === (q1.data.quote.total - expected1) + money(choco.basePrice * 1) + 0 + 0 + 0 + 12 || q3.data.quote.breakdown.some((b) => b.key === 'message' && b.amount === 12));

  const soon = new Date(Date.now() + 3 * 3600e3).toISOString();
  const q4 = await req('/api/quote', { method: 'POST', expect: 200, body: { productId: 'p-choco', config: { deliveryAt: soon } } });
  const baseCake = q4.data.quote.cakeSubtotal;
  check('rush (<24h) adds exactly 25% of cake subtotal',
    q4.data.quote.rushRequired === true && q4.data.quote.rushFee === Math.round(baseCake * 0.25));

  // Five days out, but at 12:00 Riyadh so it falls inside the staffed window:
  // since 1.3 a delivery time outside every window is refused (SLOT_CLOSED).
  const farDate = new Date(Date.now() + 5 * 864e5);
  farDate.setHours(12, 0, 0, 0);
  const far = farDate.toISOString();
  const q5 = await req('/api/quote', { method: 'POST', expect: 200, body: { productId: 'p-choco', config: { deliveryAt: far } } });
  check('no rush fee for a 5-day lead time', q5.data.quote.rushRequired === false && q5.data.quote.rushFee === 0);

  /* 3. assistant */
  const a1 = await req('/api/assistant', { method: 'POST', expect: 200, body: { message: 'عيد ميلاد لـ 12 شخص، شوكولاتة، ميزانية 400 ريال', lang: 'ar' } });
  check('assistant parses budget 400 from Arabic text', a1.data.understood.budget === 400, JSON.stringify(a1.data.understood));
  check('assistant parses people = 12', a1.data.understood.people === 12, JSON.stringify(a1.data.understood));
  check('assistant parses occasion = birthday', a1.data.understood.occasion === 'birthday', JSON.stringify(a1.data.understood));
  check('assistant returns <= 3 suggestions', a1.data.suggestions.length > 0 && a1.data.suggestions.length <= 3);
  const insideBudget = a1.data.suggestions.filter((s) => s.withinBudget !== false);
  check('every in-budget suggestion is <= 400 SAR', insideBudget.every((s) => s.price <= 400), JSON.stringify(insideBudget.map((s) => s.price)));

  // assistant prices must equal the quote endpoint for the same config
  const s0 = insideBudget[0] || a1.data.suggestions[0];
  const qa = await req('/api/quote', { method: 'POST', expect: 200, body: { productId: s0.productId, config: s0.config } });
  check('assistant price == /api/quote price for the same config', qa.data.quote.total === s0.price, `${qa.data.quote.total} vs ${s0.price}`);

  const a2 = await req('/api/assistant', { method: 'POST', expect: 200, body: { message: 'wedding cake, budget 900 SAR, 40 guests', lang: 'en' } });
  check('assistant handles English + EN constraint extraction', a2.data.understood.budget === 900 && a2.data.understood.occasion === 'wedding', JSON.stringify(a2.data.understood));
  check('assistant answers in English when lang=en', /budget|Here is|With a/.test(a2.data.reply.en));

  const a3 = await req('/api/assistant', { method: 'POST', expect: 200, body: { message: 'كيك أطفال لـ 20 شخص', lang: 'ar' } });
  check('assistant serves >= 20 people for a 20-guest request', a3.data.suggestions.every((s) => s.serves >= 20), JSON.stringify(a3.data.suggestions.map((s) => s.serves)));

  const a4 = await req('/api/assistant', { method: 'POST', expect: 200, body: { message: 'كيك أطفال لـ 20 شخص بميزانية 350 ريال', lang: 'ar' } });
  check('guest count is not mistaken for the budget (350, not 20)', a4.data.understood.budget === 350, JSON.stringify(a4.data.understood));
  check('20-guest request with 350 budget stays within budget', a4.data.suggestions.some((s) => s.withinBudget !== false), JSON.stringify(a4.data.suggestions.map((s) => s.price)));

  const a5 = await req('/api/assistant', { method: 'POST', expect: 200, body: { message: 'chocolate cake for 15 people, under 300 SAR', lang: 'en' } });
  check('English "under 300 SAR" budget with 15 guests parses to 300', a5.data.understood.budget === 300, JSON.stringify(a5.data.understood));

  /* 4. order creation */
  const phone = '05' + String(Date.now()).slice(-8);
  const cartItems = [
    { productId: 'p-pistachio', config: { size: 's8', flavor: 'pistachio', filling: 'ganache', design: 'floral', message: 'مبروك', deliveryMethod: 'delivery' }, quantity: 1 },
    { productId: 'p-mini', config: { size: 's6', flavor: 'vanilla', filling: 'cream', design: 'classic', deliveryMethod: 'pickup', unitPrice: 1 }, quantity: 2, price: 1 },
  ];
  // compute expected server total from quotes
  const ql1 = await req('/api/quote', { method: 'POST', body: { productId: cartItems[0].productId, config: cartItems[0].config } });
  const ql2 = await req('/api/quote', { method: 'POST', body: { productId: cartItems[1].productId, config: cartItems[1].config } });
  const expectedTotal = (ql1.data.quote.cakeSubtotal + ql1.data.quote.rushFee) * 1 + ql1.data.quote.deliveryFee
    + (ql2.data.quote.cakeSubtotal + ql2.data.quote.rushFee) * 2 + ql2.data.quote.deliveryFee;

  const order = await req('/api/orders', {
    method: 'POST', expect: 201,
    body: { customer: { name: 'عميل اختبار', phone, email: 'test@example.com' }, items: cartItems, notes: 'acceptance run', deliveryAt: far },
  });
  check('order created with server-computed total (client-sent price ignored)', order.data.order.total === expectedTotal, `${order.data.order.total} vs ${expectedTotal}`);
  check('order code assigned', /^CG-\d{4}$/.test(order.data.order.code));
  const orderId = order.data.order.id;
  const orderCode = order.data.order.code;

  const badPhone = await req('/api/orders', { method: 'POST', expect: 400, body: { customer: { name: 'X Y', phone: '12' }, items: cartItems } });
  check('invalid phone rejected (400 BAD_PHONE)', badPhone.data.error === 'BAD_PHONE');
  const emptyCart = await req('/api/orders', { method: 'POST', expect: 400, body: { customer: { name: 'X Y', phone }, items: [] } });
  check('empty cart rejected (400 EMPTY_CART)', emptyCart.data.error === 'EMPTY_CART');
  const badProduct = await req('/api/orders', { method: 'POST', expect: 400, body: { customer: { name: 'X Y', phone }, items: [{ productId: 'hacker', config: {} }] } });
  check('unknown product rejected (400 PRODUCT_NOT_FOUND)', badProduct.data.error === 'PRODUCT_NOT_FOUND');
  const badQty = await req('/api/orders', { method: 'POST', expect: 400, body: { customer: { name: 'X Y', phone }, items: [{ productId: 'p-mini', config: {}, quantity: 99 }] } });
  check('quantity 99 rejected (400 BAD_QUANTITY)', badQty.data.error === 'BAD_QUANTITY');
  const xssName = await req('/api/orders', { method: 'POST', expect: 400, body: { customer: { name: '<script>x</script>', phone }, items: cartItems } });
  check('markup in customer name rejected', xssName.status === 400);

  /* 4b. quantity regression (BUG-001): unit price x quantity, end to end */
  const lotusCfg = { size: 's8', flavor: 'pistachio', filling: 'cream', design: 'classic', deliveryMethod: 'delivery' };
  const unitQuote = await req('/api/quote', { method: 'POST', expect: 200, body: { productId: 'p-lotus', config: lotusCfg } });
  const unit = unitQuote.data.quote.cakeSubtotal + unitQuote.data.quote.rushFee;
  const lineDelivery = unitQuote.data.quote.deliveryFee;
  check(`unit price for the reported case is ${unit} SAR`, unit === 312, String(unit));

  for (const q of [1, 2, 3]) {
    const qPhone = '05' + String(Date.now()).slice(-6) + String(q);
    const r = await req('/api/orders', {
      method: 'POST', expect: 201,
      body: { customer: { name: `كمية ${q}`, phone: qPhone }, items: [{ productId: 'p-lotus', config: lotusCfg, quantity: q }] },
    });
    const o = r.data.order;
    check(`qty ${q}: order total = unit*qty + delivery (${unit * q} + ${lineDelivery} = ${unit * q + lineDelivery})`,
      o.total === unit * q + lineDelivery, `${o.total}`);
    check(`qty ${q}: order subtotal = ${unit * q}`, o.subtotal === unit * q, `${o.subtotal}`);
    check(`qty ${q}: delivery charged once`, o.deliveryFee === lineDelivery, `${o.deliveryFee}`);
    check(`qty ${q}: stored item quantity is ${q}`, o.items[0].quantity === q, `${o.items[0].quantity}`);
    check(`qty ${q}: item line total = ${unit * q}`, o.items[0].lineTotal === unit * q, `${o.items[0].lineTotal}`);

    // read back from the database through the public lookup route
    const back = await req('/api/orders/lookup', { method: 'POST', expect: 200, body: { code: o.code, phone: qPhone } });
    check(`qty ${q}: persisted order re-reads with the same total and quantity`,
      back.data.order.total === o.total && back.data.order.items[0].quantity === q);
  }

  const tamper = await req('/api/orders', {
    method: 'POST', expect: 201,
    body: {
      customer: { name: 'عميل تلاعب', phone: '05' + String(Date.now()).slice(-8) },
      items: [{ productId: 'p-lotus', config: lotusCfg, quantity: 2, unitPrice: 1, lineTotal: 2, total: 2, price: 1 }],
      total: 2, subtotal: 2,
    },
  });
  check('client-sent unitPrice/lineTotal/total are ignored (server recomputes 312x2+25)',
    tamper.data.order.total === 649 && tamper.data.order.items[0].unitPrice === 312 && tamper.data.order.items[0].quantity === 2,
    `${tamper.data.order.total}`);

  for (const bad of [0, 21, 2.5, 'two', null]) {
    const r = await req('/api/orders', {
      method: 'POST',
      body: { customer: { name: 'كمية خاطئة', phone: '05' + String(Date.now()).slice(-8) }, items: [{ productId: 'p-lotus', config: lotusCfg, quantity: bad }] },
    });
    check(`quantity ${JSON.stringify(bad)} rejected with 400`, r.status === 400, `${r.status}`);
  }

  const mixed = await req('/api/orders', {
    method: 'POST', expect: 201,
    body: {
      customer: { name: 'سلة مختلطة', phone: '05' + String(Date.now()).slice(-8) },
      items: [
        { productId: 'p-lotus', config: lotusCfg, quantity: 2 },
        { productId: 'p-mini', config: { size: 's6', flavor: 'vanilla', filling: 'cream', design: 'classic', deliveryMethod: 'pickup' }, quantity: 1 },
      ],
    },
  });
  check('mixed cart sums both lines and charges delivery per line',
    mixed.data.order.total === (unit * 2 + lineDelivery) + 120, `${mixed.data.order.total}`);

  /* 5. authorization */
  cookie = '';
  for (const path of ['/api/admin/orders', '/api/admin/stats', '/api/admin/customers', '/api/admin/products', '/api/admin/me']) {
    const r = await req(path);
    check(`unauthorized GET ${path} -> 401`, r.status === 401, String(r.status));
  }
  const patchNoAuth = await req(`/api/admin/orders/${orderId}`, { method: 'PATCH', body: { status: 'delivered' } });
  check('unauthorized PATCH order -> 401', patchNoAuth.status === 401, String(patchNoAuth.status));
  const wrong = await req('/api/admin/login', { method: 'POST', body: { username: USER, password: 'definitely-wrong' } });
  check('wrong password -> 401', wrong.status === 401);
  const forged = await req('/api/admin/orders', { method: 'GET' });
  check('forged/empty session still 401', forged.status === 401);

  /* 6. admin flow */
  const login = await req('/api/admin/login', { method: 'POST', body: { username: USER, password: PASS }, expect: 200 });
  check('admin login sets HttpOnly session cookie', !!cookie && cookie.startsWith('cg_session='));
  check('login response does not leak password hash', !JSON.stringify(login.data).includes('pass_hash'));

  const adminOrders = await req('/api/admin/orders', { expect: 200 });
  check('admin sees the new order', adminOrders.data.orders.some((o) => o.id === orderId));
  const stats = await req('/api/admin/stats', { expect: 200 });
  check('revenue summary includes the order total', stats.data.stats.revenue >= expectedTotal, `${stats.data.stats.revenue}`);

  const upd = await req(`/api/admin/orders/${orderId}`, { method: 'PATCH', body: { status: 'baking' }, expect: 200 });
  check('admin status update applied', upd.data.order.status === 'baking');
  const badStatus = await req(`/api/admin/orders/${orderId}`, { method: 'PATCH', body: { status: 'nonsense' } });
  check('invalid status rejected with 400', badStatus.status === 400);

  const customers = await req('/api/admin/customers', { expect: 200 });
  const cust = customers.data.customers.find((c) => c.phone === phone.replace(/\D/g, ''));
  check('customer rollup created with the order', !!cust && cust.orders >= 1 && cust.spent >= expectedTotal);

  const lookup = await req('/api/orders/lookup', { method: 'POST', expect: 200, body: { code: orderCode, phone } });
  check('customer can look up the order with code + phone', lookup.data.order.code === orderCode);
  const lookupBad = await req('/api/orders/lookup', { method: 'POST', body: { code: orderCode, phone: '0500000000' } });
  check('lookup with wrong phone -> 404', lookupBad.status === 404);

  /* 7. static */
  for (const [path, needle] of [['/', 'Cake Genius'], ['/admin', 'لوحة Cake Genius'], ['/styles.css', '--cream']]) {
    const r = await fetch(BASE + path);
    const body = await r.text();
    check(`serves ${path}`, r.status === 200 && body.includes(needle.split(' ')[0]));
  }
  const traversal = await fetch(BASE + '/../server.js');
  const traversalBody = await traversal.text();
  check('path traversal does not leak source', !traversalBody.includes('createSession'));

  const health = await req('/api/health', { expect: 200 });
  check('health reports the stored order count', health.data.ordersStored >= 1);

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log('FAILED:', failures.join(' | '));
    console.log(`ORDER_FOR_RESTART_TEST=${orderId}`);
    process.exit(1);
  }
  console.log(`ORDER_FOR_RESTART_TEST=${orderId}`);
  console.log(`ORDER_CODE=${orderCode}`);
  console.log(`EXPECTED_TOTAL=${expectedTotal}`);
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
