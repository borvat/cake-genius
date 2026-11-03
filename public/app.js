/* Cake Genius storefront (vanilla ES modules, no build step). */
import { cartTotals as computeCartTotals, lineTotals, clampQty } from './lib/cart-math.js';
import { mountSlotsPicker, pickDefaultWindow } from './slots-picker.js?v=1.3.0';

const state = {
  lang: localStorage.getItem('cg_lang') || 'ar',
  config: null,
  products: [],
  filter: 'all',
  cart: JSON.parse(localStorage.getItem('cg_cart') || '[]'),
  custom: null, // { product, config, quote }
  history: [], // AI assistant multi-turn conversation
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const I18N = {
  ar: {
    skip: 'تجاوز إلى القائمة', brandTag: 'حلويات مصممة بالطلب', navMenu: 'القائمة', navAssistant: 'المساعد الذكي',
    navPricing: 'كيف يُحسب السعر', navAdmin: 'لوحة الإدارة', cart: 'السلة', eyebrow: 'مخبوز طازج في الرياض',
    heroTitle: 'كيكة تُصنع على <em>مقاس مناسبتك</em>، بسعر تعرفه قبل الطلب.',
    heroLead: 'اختر الحجم والنكهة والحشوة والتصميم، وشاهد السعر يتغير لحظياً بقواعد واضحة. أو قل لنا ميزانيتك ومناسبتك ويقترح المساعد الخيار المناسب.',
    ctaBrowse: 'تصفح الكيك', ctaAssistant: 'اسأل المساعد', statProducts: 'منتج في القائمة', statSizes: 'أحجام قابلة للتخصيص',
    statMin: 'أقل مدة تحضير', heroBadge: 'فستق وورد — الأكثر طلباً', assistantTitle: 'المساعد الذكي',
    assistantSub: 'اكتب طلبك بلغتك: المناسبة، عدد الأشخاص، النكهة، وميزانيتك. الأسعار تأتي من محرك التسعير نفسه، لا تقديرات.',
    assistantPlaceholder: 'مثال: عيد ميلاد لـ 12 شخص، شوكولاتة، ميزانية 400 ريال', assistantSend: 'اقترح لي',
    catalogTitle: 'قائمة الكيك', catalogSub: 'كل سعر يبدأ من نسخة 6 إنش بالخيارات الافتراضية، ويُعاد حسابه عند التخصيص.',
    pricingTitle: 'كيف يُحسب السعر', pricingSub: 'لا اجتهاد ولا أسعار مخفية: القواعد التالية مطبّقة على الخادم وتظهر لك في كل فاتورة.',
    footerNote: 'Cake Genius — نسخة تجريبية. لا تُحصّل أي مبالغ ولا تُرسل رسائل للعملاء.', checkout: 'إتمام الطلب',
    total: 'الإجمالي', unitPrice: 'سعر الوحدة', unitBreakdown: 'تفاصيل سعر الوحدة', lineTotal: 'إجمالي السطر', cakesCount: 'الكمية {n}', quoteNote: 'السعر محسوب على الخادم ويُعاد التحقق منه عند إتمام الطلب.', addToCart: 'أضف إلى السلة',
    totalMismatch: 'اختلف الإجمالي المعروض عن إجمالي الخادم — المعتمد هو إجمالي الخادم.',
    currency: 'ر.س', loading: 'جارٍ التحميل…', from: 'يبدأ من', customize: 'خصصها', emptyFilters: 'لا يوجد منتج في هذه الفئة.',
    size: 'الحجم', flavor: 'النكهة', filling: 'الحشوة', design: 'التصميم', message: 'الرسالة على الكيك',
    messageHint: 'حتى 30 حرفاً مجاناً، وبعدها 12 ر.س لكل 20 حرفاً.', messagePlaceholder: 'مثال: كل عام وأنت بخير يا سارة',
    delivery: 'طريقة التسليم', deliveryAt: 'موعد التسليم', qty: 'الكمية', addToCartOk: 'أُضيفت إلى السلة',
    slotsLoading: 'جارٍ تحميل المواعيد…', slotsError: 'تعذّر تحميل المواعيد المتاحة.',
    slotsNone: 'لا توجد مواعيد تسليم متاحة حالياً.', slotsFallback: 'أدخل الموعد يدوياً وسنؤكده مع المخبز قبل التحضير.',
    cartEmpty: 'سلتك فارغة. اختر كيكة وابدأ التخصيص.', subtotal: 'قيمة الكيك', deliveryFee: 'التوصيل', rushFee: 'مستعجل',
    remove: 'إزالة', checkoutTitle: 'إتمام الطلب', customerName: 'الاسم', customerPhone: 'رقم الجوال', customerEmail: 'البريد (اختياري)',
    notes: 'ملاحظات للمخبز (اختياري)', payNote: 'دفع تجريبي — لن يتم تحصيل أي مبلغ. لا تُدخل بيانات بطاقة حقيقية.',
    placeOrder: 'تأكيد الطلب (تجريبي)', orderSuccess: 'تم استلام طلبك', orderSuccessSub: 'احتفظ برقم الطلب لمتابعة الحالة في الفرع.',
    continueShopping: 'متابعة التسوق', required: 'هذا الحقل مطلوب', badPhone: 'رقم الجوال يجب أن يكون 9 أرقام على الأقل.',
    badEmail: 'صيغة البريد غير صحيحة.', errGeneric: 'حدث خطأ، حاول مرة أخرى.', emptyCartErr: 'السلة فارغة.',
    sending: 'جارٍ الإرسال…', thinking: 'جارٍ التحليل…', suggestion: 'اقتراح', viewDeal: 'خصص هذا الاقتراح',
    rulesSize: 'الحجم (معامل على سعر القاعدة)', rulesFlavor: 'النكهة', rulesFilling: 'الحشوة', rulesDesign: 'التصميم',
    rulesFees: 'رسوم إضافية', rulesDelivery: 'التسليم', free: 'مجاني', base: 'سعر القاعدة (6 إنش)',
    chatTry: ['عيد ميلاد لـ 12 شخص، شوكولاتة، ميزانية 400', 'عرس بميزانية 900 ريال', 'كيك أطفال لـ 20 شخص', 'هدية للشركة بـ 500 ريال'],
    adminNote: 'المساعد يفهم طلبك بنموذج لغوي (DeepSeek)، وكل الأسعار تُحسب على الخادم من محرك التسعير. النموذج لا يخترع أي سعر.',
    aiAddToCart: 'أضف إلى السلة', aiQuestionsTitle: 'لأقترح لك بدقة، أحتاج توضيحاً:', aiAlternative: 'خيار بديل',
    aiFallbackNote: 'المساعد يعمل بقواعد محلية (بدون نموذج لغوي).',
  },
  en: {
    skip: 'Skip to catalog', brandTag: 'Cakes made to order', navMenu: 'Menu', navAssistant: 'Smart assistant',
    navPricing: 'How pricing works', navAdmin: 'Admin', cart: 'Cart', eyebrow: 'Baked fresh in Riyadh',
    heroTitle: 'A cake built to <em>your occasion</em>, at a price you see before ordering.',
    heroLead: 'Choose size, flavour, filling and design and watch the price update live from explicit rules. Or tell us your budget and occasion and let the assistant propose the best match.',
    ctaBrowse: 'Browse cakes', ctaAssistant: 'Ask the assistant', statProducts: 'products on the menu', statSizes: 'customisable sizes',
    statMin: 'minimum lead time', heroBadge: 'Pistachio & rose — best seller', assistantTitle: 'Smart assistant',
    assistantSub: 'Describe your request in plain language: occasion, servings, flavour, budget. Prices come from the same engine as checkout — never estimates.',
    assistantPlaceholder: 'e.g. birthday for 12 people, chocolate, budget 400 SAR', assistantSend: 'Suggest',
    catalogTitle: 'The menu', catalogSub: 'Every price starts from the 6" default configuration and is recomputed when you customise.',
    pricingTitle: 'How the price is built', pricingSub: 'No hidden numbers: these rules run on the server and are shown on every quote.',
    footerNote: 'Cake Genius — demo build. No money is collected and no customer messages are sent.', checkout: 'Checkout',
    total: 'Total', unitPrice: 'Unit price', unitBreakdown: 'Unit price breakdown', lineTotal: 'Line total', cakesCount: 'qty {n}', quoteNote: 'Computed server-side and re-verified when the order is placed.', addToCart: 'Add to cart',
    totalMismatch: 'The displayed total differed from the server total — the server total is authoritative.',
    currency: 'SAR', loading: 'Loading…', from: 'from', customize: 'Customise', emptyFilters: 'No products in this category.',
    size: 'Size', flavor: 'Flavour', filling: 'Filling', design: 'Design', message: 'Message on the cake',
    messageHint: 'Free up to 30 characters, then 12 SAR for each 20 characters.', messagePlaceholder: 'e.g. Happy birthday Sara',
    delivery: 'Fulfilment', deliveryAt: 'Delivery time', qty: 'Quantity', addToCartOk: 'Added to cart',
    slotsLoading: 'Loading available times…', slotsError: 'Could not load the available times.',
    slotsNone: 'No delivery slots are available right now.', slotsFallback: 'Enter a time manually and we will confirm it with the bakery before baking.',
    cartEmpty: 'Your cart is empty. Pick a cake and start customising.', subtotal: 'Cakes', deliveryFee: 'Delivery', rushFee: 'Rush',
    remove: 'Remove', checkoutTitle: 'Checkout', customerName: 'Name', customerPhone: 'Mobile number', customerEmail: 'Email (optional)',
    notes: 'Notes for the bakery (optional)', payNote: 'Demo payment — no money is collected. Never enter real card data.',
    placeOrder: 'Place demo order', orderSuccess: 'Order received', orderSuccessSub: 'Keep the order code to follow up in store.',
    continueShopping: 'Continue shopping', required: 'This field is required', badPhone: 'Mobile number needs at least 9 digits.',
    badEmail: 'That email looks invalid.', errGeneric: 'Something went wrong, try again.', emptyCartErr: 'Your cart is empty.',
    sending: 'Sending…', thinking: 'Thinking…', suggestion: 'suggestion', viewDeal: 'Customise this pick',
    rulesSize: 'Size (multiplier on base)', rulesFlavor: 'Flavour', rulesFilling: 'Filling', rulesDesign: 'Design',
    rulesFees: 'Extra fees', rulesDelivery: 'Fulfilment', free: 'Free', base: 'Base price (6")',
    chatTry: ['Birthday for 12, chocolate, budget 400', 'Wedding with a 900 SAR budget', 'Kids cake for 20 people', 'Corporate gift for 500'],
    adminNote: 'The assistant uses a language model (DeepSeek) to understand your request; every price is computed server-side by the pricing engine. The model never invents a price.',
    aiAddToCart: 'Add to cart', aiQuestionsTitle: 'To suggest precisely, I need to clarify:', aiAlternative: 'Alternative',
    aiFallbackNote: 'Assistant running in rule-based mode (no LLM).',
  },
};

const OCCASION_AR = { birthday: 'عيد ميلاد', wedding: 'زواج', kids: 'أطفال', corporate: 'شركات', anniversary: 'ذكرى سنوية' };

const t = (key) => I18N[state.lang][key] ?? key;
const money = (n) => `${new Intl.NumberFormat(state.lang === 'ar' ? 'ar-SA' : 'en-US').format(n)} ${t('currency')}`;
const label = (obj) => (obj && obj.label ? obj.label[state.lang] : '');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'is-visible' + (kind ? ` is-${kind}` : '');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { el.className = ''; }, 3200);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    credentials: 'same-origin',
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    const err = new Error((data && (data.message || data.error)) || `HTTP ${res.status}`);
    err.status = res.status;
    err.code = data && data.error;
    throw err;
  }
  return data;
}

/* ---------------- language ---------------- */

function applyLang() {
  const html = document.documentElement;
  html.lang = state.lang;
  html.dir = state.lang === 'ar' ? 'rtl' : 'ltr';
  $('#langToggle').textContent = state.lang === 'ar' ? 'EN' : 'ع';
  document.title = state.lang === 'ar' ? 'Cake Genius — كيك جينيوس' : 'Cake Genius — custom cakes';
  $$('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  $$('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.dataset.i18nHtml); });
  $$('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  localStorage.setItem('cg_lang', state.lang);
}

/* ---------------- catalog ---------------- */

function renderFilters() {
  const box = $('#filters');
  box.innerHTML = '';
  for (const cat of state.config.categories) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'filter' + (state.filter === cat.id ? ' is-active' : '');
    b.textContent = label(cat);
    b.addEventListener('click', () => { state.filter = cat.id; renderFilters(); renderGrid(); });
    box.append(b);
  }
}

function renderGrid() {
  const grid = $('#productGrid');
  const items = state.products.filter((p) => state.filter === 'all' || p.category === state.filter);
  grid.innerHTML = '';
  if (!items.length) {
    grid.innerHTML = `<p class="empty">${escapeHtml(t('emptyFilters'))}</p>`;
    return;
  }
  for (const p of items) {
    const card = document.createElement('article');
    card.className = 'card';
    card.innerHTML = `
      <div class="card-media">
        <img src="${escapeHtml(p.image)}" alt="${escapeHtml(p.name[state.lang])}" loading="lazy" width="800" height="600" />
        ${p.popular ? `<span class="tag popular">${state.lang === 'ar' ? 'الأكثر طلباً' : 'Best seller'}</span>` : ''}
        <span class="tag" style="inset-block-start:auto;inset-block-end:12px">${escapeHtml(label(state.config.categories.find((c) => c.id === p.category)) || p.category)}</span>
      </div>
      <div class="card-body">
        <h3>${escapeHtml(p.name[state.lang])}</h3>
        <p>${escapeHtml(p.desc[state.lang])}</p>
        <div class="card-foot">
          <span class="price-tag">${money(p.basePrice)}<br><small>${escapeHtml(t('from'))} · 6"</small></span>
          <button class="btn btn-sm btn-accent" type="button" data-id="${escapeHtml(p.id)}">${escapeHtml(t('customize'))}</button>
        </div>
      </div>`;
    card.querySelector('button[data-id]').addEventListener('click', () => openCustomizer(p));
    grid.append(card);
  }
  $('#statProducts').textContent = String(state.products.length);
}

function renderRules() {
  const r = state.config.rules;
  const grid = $('#rulesGrid');
  const rows = (pairs) => pairs.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('');
  const pct = (m) => `×${m}`;
  grid.innerHTML = `
    <div class="rule-card"><h3>${escapeHtml(t('rulesSize'))}</h3><dl>${rows(r.sizes.map((s) => [label(s), `${pct(s.multiplier)} · ${s.serves} ${state.lang === 'ar' ? 'شخصاً' : 'serves'}`]))}</dl></div>
    <div class="rule-card"><h3>${escapeHtml(t('rulesFlavor'))} / ${escapeHtml(t('rulesFilling'))}</h3><dl>${rows([
      ...r.flavors.map((f) => [label(f), f.surcharge ? `+${f.surcharge}` : t('free')]),
      ...r.fillings.map((f) => [label(f), f.surcharge ? `+${f.surcharge}` : t('free')]),
    ])}</dl></div>
    <div class="rule-card"><h3>${escapeHtml(t('rulesDesign'))}</h3><dl>${rows(r.designs.map((d) => [label(d), d.surcharge ? `+${d.surcharge}` : t('free')]))}</dl></div>
    <div class="rule-card"><h3>${escapeHtml(t('rulesFees'))}</h3><dl>${rows([
      [t('message'), `${r.message.freeChars} ${state.lang === 'ar' ? 'حرفاً مجاناً' : 'chars free'}, +${r.message.extraFee}/${r.message.extraBlock}`],
      [state.lang === 'ar' ? 'مستعجل < 24 ساعة' : 'Rush < 24h', `+${Math.round(r.rush.rate * 100)}%`],
      ...r.delivery.map((d) => [label(d), d.fee ? `+${d.fee}` : t('free')]),
    ])}</dl></div>`;
}

/* ---------------- customizer ---------------- */

function defaultConfig() {
  return { size: 's8', flavor: 'vanilla', filling: 'cream', design: 'classic', message: '', deliveryMethod: 'pickup', deliveryAt: '' };
}

function isoLocalPlus(days) {
  const d = new Date(Date.now() + days * 864e5);
  d.setHours(14, 0, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderCustomFields() {
  const r = state.config.rules;
  const c = state.custom;
  const box = $('#customFields');
  box.innerHTML = '';

  const group = (titleKey, options, key, priceFn) => {
    const wrap = document.createElement('div');
    wrap.className = 'field';
    wrap.innerHTML = `<span class="field-label">${escapeHtml(t(titleKey))}</span>`;
    const row = document.createElement('div');
    row.className = 'options';
    for (const opt of options) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'opt' + (c.config[key] === opt.id ? ' is-active' : '');
      b.dataset.opt = opt.id;
      const extra = priceFn(opt);
      b.innerHTML = `${escapeHtml(label(opt))}${extra ? `<small>${escapeHtml(extra)}</small>` : ''}`;
      b.addEventListener('click', () => {
        c.config[key] = opt.id;
        renderCustomFields();
        refreshQuote();
      });
      row.append(b);
    }
    wrap.append(row);
    box.append(wrap);
  };

  group('size', r.sizes, 'size', (o) => `${Math.round(c.product.basePrice * o.multiplier)} ${t('currency')}`);
  group('flavor', r.flavors, 'flavor', (o) => (o.surcharge ? `+${o.surcharge}` : ''));
  group('filling', r.fillings, 'filling', (o) => (o.surcharge ? `+${o.surcharge}` : ''));
  group('design', r.designs, 'design', (o) => (o.surcharge ? `+${o.surcharge}` : ''));
  group('delivery', r.delivery, 'deliveryMethod', (o) => (o.fee ? `+${o.fee}` : t('free')));

  const msgField = document.createElement('div');
  msgField.className = 'field';
  msgField.innerHTML = `
    <label for="msgInput">${escapeHtml(t('message'))} <span style="font-weight:400">(${escapeHtml(t('messageHint'))})</span></label>
    <input id="msgInput" type="text" maxlength="${r.message.maxChars}" placeholder="${escapeHtml(t('messagePlaceholder'))}" value="${escapeHtml(c.config.message)}" />`;
  msgField.querySelector('#msgInput').addEventListener('input', (e) => {
    c.config.message = e.target.value;
    clearTimeout(renderCustomFields._t);
    refreshQuote();
  });
  box.append(msgField);

  const slotField = document.createElement('div');
  slotField.className = 'field slots-field';
  box.append(slotField);
  mountDeliveryField(slotField);

  const qtyField = document.createElement('div');
  qtyField.className = 'field';
  qtyField.innerHTML = `
    <span class="field-label">${escapeHtml(t('qty'))}</span>
    <div class="stepper" role="group" aria-label="${escapeHtml(t('qty'))}">
      <button type="button" class="step-btn" data-step="-1" aria-label="minus">−</button>
      <input id="qtyInput" type="number" inputmode="numeric" min="1" max="20" step="1" value="${c.qty}" />
      <button type="button" class="step-btn" data-step="1" aria-label="plus">+</button>
    </div>`;
  const qtyInput = qtyField.querySelector('#qtyInput');
  const applyQty = (value, force) => {
    c.qty = clampQty(value);
    if (force) qtyInput.value = String(c.qty);
    renderQuotePanel(); // pure arithmetic on the server quote: no network, instant
  };
  qtyInput.addEventListener('input', () => {
    const v = Number(qtyInput.value);
    // While typing, only accept a complete value in range so "12" is typeable.
    if (Number.isInteger(v) && v >= 1 && v <= 20) applyQty(v, false);
  });
  qtyInput.addEventListener('change', () => applyQty(qtyInput.value, true));
  qtyInput.addEventListener('blur', () => applyQty(qtyInput.value, true));
  qtyField.querySelectorAll('[data-step]').forEach((btn) => {
    btn.addEventListener('click', () => applyQty(clampQty(c.qty) + Number(btn.dataset.step), true));
  });
  box.append(qtyField);
}

/* ---------------- delivery slots ---------------- */

const SLOT_QUERY = '/api/slots?days=21';
let slotsPromise = null;
let slotMountSeq = 0;

/** One request per session: the promise is shared, never polled. */
function fetchSlots() {
  if (!slotsPromise) {
    slotsPromise = api(SLOT_QUERY).catch((err) => { slotsPromise = null; throw err; });
  }
  return slotsPromise;
}

/** ISO instant -> value for a datetime-local input (browser local time). */
function localInputValue(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Last-resort free datetime field: the customer is never blocked on /api/slots. */
function renderDateFallback(container, c, message) {
  container.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.className = 'slots-fallback';
  wrap.innerHTML = `
    <p class="slots-note" role="status">${escapeHtml(message)}</p>
    <label for="dateInput">${escapeHtml(t('deliveryAt'))}</label>
    <input id="dateInput" type="datetime-local" value="${escapeHtml(localInputValue(c.config.deliveryAt) || isoLocalPlus(2))}" min="${escapeHtml(isoLocalPlus(0).slice(0, 16))}" />
    <p class="hint">${escapeHtml(t('slotsFallback'))}</p>`;
  container.append(wrap);
  const input = wrap.querySelector('#dateInput');
  const commit = () => {
    const picked = new Date(input.value);
    if (!Number.isFinite(picked.getTime())) { c.config.deliveryAt = ''; return; }
    c.config.deliveryAt = picked.toISOString();
  };
  // Commit what the field already shows: a visible date the customer never
  // touched must still be the date that gets stored (QA-1.3-01).
  commit();
  refreshQuote();
  input.addEventListener('change', () => {
    commit();
    refreshQuote();
  });
}

async function mountDeliveryField(container) {
  const c = state.custom;
  if (!c) return;
  const seq = ++slotMountSeq;
  container.innerHTML = `<p class="slots-status" role="status"><span class="spinner dark"></span> ${escapeHtml(t('slotsLoading'))}</p>`;
  let data = null;
  try { data = await fetchSlots(); } catch { data = null; }
  if (seq !== slotMountSeq || state.custom !== c) return;
  const days = data && Array.isArray(data.days) ? data.days : [];
  const def = days.length ? pickDefaultWindow(days, (data && data.nextAvailable) || null) : null;
  if (!def) {
    renderDateFallback(container, c, data ? t('slotsNone') : t('slotsError'));
    return;
  }
  container.innerHTML = '';
  mountSlotsPicker(container, {
    days,
    lang: state.lang,
    value: c.config.deliveryAt || null,
    onChange: ({ iso }) => {
      c.config.deliveryAt = iso;
      refreshQuote();
    },
  });
}

async function refreshQuote() {
  const c = state.custom;
  if (!c) return;
  const errBox = $('#customError');
  errBox.classList.remove('is-visible');
  $('#quoteLines').innerHTML = `<div><span class="skeleton" style="display:inline-block;width:120px;height:12px"></span></div>`;
  try {
    const payload = { productId: c.product.id, config: { ...c.config, deliveryAt: c.config.deliveryAt ? new Date(c.config.deliveryAt).toISOString() : null } };
    const { quote } = await api('/api/quote', { method: 'POST', body: payload });
    if (state.custom !== c) return;
    c.quote = quote;
    renderQuotePanel();
  } catch (err) {
    $('#quoteLines').innerHTML = '';
    $('#quoteUnit').textContent = '—';
    $('#quoteMath').innerHTML = '';
    $('#quoteTotal').textContent = '—';
    errBox.textContent = err.message || t('errGeneric');
    errBox.classList.add('is-visible');
  }
}

/**
 * Renders the money panel from the server quote + the chosen quantity.
 * The unit price never changes with quantity; the line total does. Both are shown
 * explicitly so "312 x 2" can never look like "312".
 */
function renderQuotePanel() {
  const c = state.custom;
  if (!c || !c.quote) return;
  const q = c.quote;
  const lt = lineTotals(q.cakeSubtotal + q.rushFee, q.deliveryFee, c.qty);
  $('#quoteUnit').textContent = money(lt.unitPrice);
  $('#quoteLines').innerHTML = q.breakdown
    .map((b) => `<div><span>${escapeHtml(label(b) || b.key)}</span><span>${money(b.amount)}</span></div>`)
    .join('');
  const rows = [
    `<div class="qmath"><span>${escapeHtml(t('unitPrice'))}</span><span>${money(lt.unitPrice)}</span></div>`,
    `<div class="qmath"><span>${escapeHtml(t('qty'))} × ${lt.quantity}</span><span>${money(lt.cakes)}</span></div>`,
  ];
  if (lt.delivery) rows.push(`<div class="qmath"><span>${escapeHtml(t('deliveryFee'))}</span><span>${money(lt.delivery)}</span></div>`);
  $('#quoteMath').innerHTML = rows.join('');
  $('#quoteTotalLabel').textContent = lt.quantity > 1 ? `${t('lineTotal')} (${t('cakesCount').replace('{n}', lt.quantity)})` : t('total');
  $('#quoteTotal').textContent = money(lt.total);
  $('#quoteBox').dataset.unit = String(lt.unitPrice);
  $('#quoteBox').dataset.qty = String(lt.quantity);
  $('#quoteBox').dataset.total = String(lt.total);
}

function openCustomizer(product, preset) {
  state.custom = {
    product,
    config: { ...defaultConfig(), ...(preset || {}) },
    qty: 1,
    quote: null,
  };
  $('#customTitle').textContent = product.name[state.lang];
  $('#customDesc').textContent = product.desc[state.lang];
  $('#customImage').src = product.image;
  $('#customImage').alt = product.name[state.lang];
  renderCustomFields();
  refreshQuote();
  $('#customModal').classList.add('is-open');
}

function closeCustomizer() {
  $('#customModal').classList.remove('is-open');
  state.custom = null;
}

/* ---------------- cart ---------------- */

function cartCount() {
  return state.cart.reduce((s, l) => s + l.quantity, 0);
}

function cartTotals() {
  return computeCartTotals(state.cart);
}

function saveCart() {
  localStorage.setItem('cg_cart', JSON.stringify(state.cart));
  $('#cartCount').textContent = String(cartCount());
}

function addLine(line) {
  const key = JSON.stringify({ p: line.productId, c: line.config });
  const existing = state.cart.find((l) => JSON.stringify({ p: l.productId, c: l.config }) === key);
  if (existing) existing.quantity += line.quantity;
  else state.cart.push(line);
  saveCart();
  renderCart();
}

function renderCart() {
  const body = $('#cartBody');
  const summary = $('#cartSummary');
  body.innerHTML = '';
  if (!state.cart.length) {
    body.innerHTML = `<p class="empty">${escapeHtml(t('cartEmpty'))}</p>`;
    summary.innerHTML = '';
    $('#checkoutBtn').disabled = true;
    $('#cartCount').textContent = '0';
    return;
  }
  $('#checkoutBtn').disabled = false;
  state.cart.forEach((line, idx) => {
    const r = state.config.rules;
    const sz = r.sizes.find((s) => s.id === line.config.size);
    const fl = r.flavors.find((s) => s.id === line.config.flavor);
    const dg = r.designs.find((s) => s.id === line.config.design);
    const el = document.createElement('div');
    el.className = 'cart-line';
    const lt = lineTotals(line.unitPrice, line.deliveryFee, line.quantity);
    el.innerHTML = `
      <img src="${escapeHtml(line.image)}" alt="" width="68" height="68" />
      <div class="info">
        <div class="name">${escapeHtml(line.name[state.lang])}</div>
        <div class="meta">${escapeHtml(label(sz))} · ${escapeHtml(label(fl))} · ${escapeHtml(label(dg))}</div>
        ${line.config.message ? `<div class="meta">“${escapeHtml(line.config.message)}”</div>` : ''}
        <div class="meta">${line.config.deliveryAt ? new Date(line.config.deliveryAt).toLocaleString(state.lang === 'ar' ? 'ar-SA' : 'en-GB') : ''}</div>
        <div class="qty">
          <button type="button" data-act="dec" aria-label="minus">−</button>
          <span class="qty-val" data-qty>${lt.quantity}</span>
          <button type="button" data-act="inc" aria-label="plus">+</button>
          <span class="line-math" data-math>${money(lt.unitPrice)} × ${lt.quantity}</span>
          <span class="line-total" data-line-total>${money(lt.cakes)}</span>
        </div>
        ${lt.delivery ? `<div class="meta line-delivery">${escapeHtml(t('deliveryFee'))}: ${money(lt.delivery)}</div>` : ''}
      </div>`;
    el.querySelector('[data-act="dec"]').addEventListener('click', () => {
      line.quantity = clampQty(line.quantity - 1);
      saveCart(); renderCart();
    });
    el.querySelector('[data-act="inc"]').addEventListener('click', () => {
      line.quantity = clampQty(line.quantity + 1);
      saveCart(); renderCart();
    });
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'icon-btn';
    rm.textContent = '🗑';
    rm.title = t('remove');
    rm.addEventListener('click', () => {
      state.cart.splice(idx, 1);
      saveCart(); renderCart();
    });
    el.append(rm);
    body.append(el);
  });

  const tt = cartTotals();
  summary.innerHTML = `
    <div><span>${escapeHtml(t('subtotal'))}</span><span>${money(tt.cakes)}</span></div>
    <div><span>${escapeHtml(t('deliveryFee'))}</span><span>${money(tt.delivery)}</span></div>
    <div class="grand"><span>${escapeHtml(t('total'))}</span><span>${money(tt.total)}</span></div>`;
}

function openCart() {
  $('#cartDrawer').classList.add('is-open');
  $('#overlay').classList.add('is-open');
  $('#cartDrawer').setAttribute('aria-hidden', 'false');
  $('#cartDrawer').removeAttribute('inert');
}

function closeCart() {
  $('#cartDrawer').classList.remove('is-open');
  $('#overlay').classList.remove('is-open');
  $('#cartDrawer').setAttribute('aria-hidden', 'true');
  $('#cartDrawer').setAttribute('inert', '');
}

/* ---------------- checkout ---------------- */

function openCheckout() {
  if (!state.cart.length) { toast(t('emptyCartErr'), 'error'); return; }
  closeCart();
  const tt = cartTotals();
  const lines = state.cart.map((line) => {
    const lt = lineTotals(line.unitPrice, line.deliveryFee, line.quantity);
    return `<div class="co-line"><span>${escapeHtml(line.name[state.lang])} — ${money(lt.unitPrice)} × ${lt.quantity}</span><span>${money(lt.cakes)}</span></div>`;
  }).join('');
  const pane = $('#checkoutPane');
  pane.innerHTML = `
    <h2>${escapeHtml(t('checkoutTitle'))}</h2>
    <p class="muted">${escapeHtml(t('payNote'))}</p>
    <form id="checkoutForm" novalidate>
      <div class="field"><label for="cName">${escapeHtml(t('customerName'))}</label><input id="cName" name="name" type="text" required minlength="2" maxlength="60" autocomplete="name" /></div>
      <div class="row-2">
        <div class="field"><label for="cPhone">${escapeHtml(t('customerPhone'))}</label><input id="cPhone" name="phone" type="tel" required inputmode="tel" autocomplete="tel" placeholder="05xxxxxxxx" /></div>
        <div class="field"><label for="cEmail">${escapeHtml(t('customerEmail'))}</label><input id="cEmail" name="email" type="email" autocomplete="email" /></div>
      </div>
      <div class="field"><label for="cNotes">${escapeHtml(t('notes'))}</label><textarea id="cNotes" name="notes" rows="2" maxlength="400"></textarea></div>
      <div class="quote-box">
        <div class="co-lines">${lines}</div>
        <div class="quote-lines">
          <div><span>${escapeHtml(t('subtotal'))}</span><span>${money(tt.cakes)}</span></div>
          <div><span>${escapeHtml(t('deliveryFee'))}</span><span>${money(tt.delivery)}</span></div>
        </div>
        <div class="quote-total"><span>${escapeHtml(t('total'))}</span><span id="checkoutTotal">${money(tt.total)}</span></div>
        <p class="quote-note">${escapeHtml(t('quoteNote'))}</p>
      </div>
      <div class="alert alert-error" id="checkoutError"></div>
      <button class="btn btn-accent btn-block" id="placeOrderBtn" type="submit">${escapeHtml(t('placeOrder'))}</button>
    </form>`;
  $('#checkoutModal').classList.add('is-open');
  $('#checkoutForm').addEventListener('submit', submitOrder);
}

async function submitOrder(e) {
  e.preventDefault();
  const errBox = $('#checkoutError');
  const btn = $('#placeOrderBtn');
  errBox.classList.remove('is-visible');
  const name = $('#cName').value.trim();
  const phone = $('#cPhone').value.trim();
  const email = $('#cEmail').value.trim();
  const notes = $('#cNotes').value.trim();

  if (name.length < 2) return showErr(errBox, t('required'));
  if (phone.replace(/\D/g, '').length < 9) return showErr(errBox, t('badPhone'));
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return showErr(errBox, t('badEmail'));

  const deliveryAt = state.cart.map((l) => l.config.deliveryAt).filter(Boolean).sort()[0] || null;
  const items = state.cart.map((l) => ({
    productId: l.productId,
    config: l.config,
    quantity: clampQty(l.quantity),
  }));
  const clientTotal = cartTotals().total;

  btn.disabled = true;
  const original = btn.textContent;
  btn.innerHTML = `<span class="spinner"></span> ${escapeHtml(t('sending'))}`;
  try {
    const data = await api('/api/orders', { method: 'POST', body: { customer: { name, phone, email: email || null }, items, notes, deliveryAt } });
    state.cart = [];
    saveCart();
    renderCart();
    renderSuccess(data.order, clientTotal);
  } catch (err) {
    showErr(errBox, err.message || t('errGeneric'));
    btn.disabled = false;
    btn.textContent = original;
  }
}

function showErr(box, msg) {
  box.textContent = msg;
  box.classList.add('is-visible');
}

function renderSuccess(order, clientTotal) {
  const pane = $('#checkoutPane');
  const money2 = (n) => money(n);
  const itemsHtml = order.items.map((it) => `
    <div class="co-line">
      <span>${escapeHtml(it.name[state.lang])} — ${money2(it.unitPrice)} × ${it.quantity}</span>
      <span>${money2(it.lineTotal)}</span>
    </div>`).join('');
  const mismatch = typeof clientTotal === 'number' && clientTotal !== order.total;
  pane.innerHTML = `
    <div class="success-card">
      <div class="success-mark">✓</div>
      <h2>${escapeHtml(t('orderSuccess'))}</h2>
      <p class="muted">${escapeHtml(t('orderSuccessSub'))}</p>
      <div class="order-code">${escapeHtml(order.code)}</div>
      <div style="text-align:start;margin-block:16px">
        <div class="co-lines">${itemsHtml}</div>
        <div class="quote-lines">
          <div><span>${escapeHtml(t('subtotal'))}</span><span>${money2(order.subtotal)}</span></div>
          <div><span>${escapeHtml(t('deliveryFee'))}</span><span>${money2(order.deliveryFee)}</span></div>
        </div>
        <div class="quote-total"><span>${escapeHtml(t('total'))}</span><span id="serverTotal">${money2(order.total)}</span></div>
        ${mismatch ? `<div class="alert alert-error is-visible">${escapeHtml(t('totalMismatch'))} (${money2(clientTotal)} ≠ ${money2(order.total)})</div>` : ''}
        <div style="font-size:12.5px;color:var(--ink-soft);margin-block-start:8px">
          ${escapeHtml(order.customer.name)} · ${escapeHtml(order.customer.phone)} · ${escapeHtml(order.status)}
        </div>
      </div>
      <button class="btn btn-ghost btn-block" id="continueBtn" type="button">${escapeHtml(t('continueShopping'))}</button>
    </div>`;
  $('#continueBtn').addEventListener('click', () => {
    $('#checkoutModal').classList.remove('is-open');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

/* ---------------- assistant ---------------- */

function renderChips() {
  const box = $('#assistantChips');
  box.innerHTML = '';
  for (const text of t('chatTry')) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.type = 'button';
    b.textContent = text;
    b.addEventListener('click', () => {
      $('#assistantInput').value = text;
      runAssistant(text);
    });
    box.append(b);
  }
}

function descOf(s) {
  const r = state.config.rules;
  const parts = [
    label(r.sizes.find((x) => x.id === s.config.size)),
    label(r.flavors.find((x) => x.id === s.config.flavor)),
    label(r.designs.find((x) => x.id === s.config.design)),
  ].filter(Boolean);
  if (s.serves) parts.push(`${s.serves} ${state.lang === 'ar' ? 'شخصاً' : 'serves'}`);
  return parts.join(' · ');
}

function renderAiCard(s, alternative = false) {
  const card = document.createElement('div');
  card.className = 'ar-card' + (alternative ? ' alt' : '');
  const qtyBadge = s.quantity > 1 ? `<span class="ai-qty">×${s.quantity}</span>` : '';
  card.innerHTML = `
    <img src="${escapeHtml(s.image)}" alt="" width="62" height="62" />
    <div style="flex:1;min-width:0">
      <div class="t">${escapeHtml(s.name[state.lang])} ${qtyBadge}</div>
      <div class="r">${alternative ? escapeHtml(t('aiAlternative')) : escapeHtml(descOf(s))}</div>
      <div class="price">${money(s.price)}</div>
    </div>
    <div class="ai-actions">
      <button class="btn btn-sm btn-accent ai-add" type="button">${escapeHtml(t('aiAddToCart'))}</button>
      <button class="btn btn-sm btn-ghost ai-custom" type="button">${escapeHtml(t('viewDeal'))}</button>
    </div>`;
  card.querySelector('.ai-add').addEventListener('click', () => {
    addLine({
      productId: s.productId, name: s.name, image: s.image,
      config: s.config, unitPrice: s.unitPrice, deliveryFee: s.deliveryFee, quantity: s.quantity,
    });
    toast(`${t('addToCartOk')} — ${money(s.unitPrice)} × ${s.quantity} = ${money(s.price)}`, 'ok');
    openCart();
  });
  card.querySelector('.ai-custom').addEventListener('click', () => {
    const product = state.products.find((p) => p.id === s.productId);
    if (product) openCustomizer(product, s.config);
  });
  return card;
}

async function runAssistant(message, followUp = false) {
  const replyEl = $('#assistantReply');
  const resultsEl = $('#assistantResults');
  const btn = $('#assistantSubmit');
  replyEl.textContent = t('thinking');
  resultsEl.innerHTML = '';
  btn.disabled = true;
  try {
    if (!followUp) state.history.push({ role: 'user', content: message });
    const data = await api('/api/assistant/ai', {
      method: 'POST',
      body: { message, history: state.history.slice(0, -1), lang: state.lang },
    });
    state.history.push({ role: 'assistant', content: (data.reply && data.reply[state.lang]) || '' });

    replyEl.textContent = data.reply[state.lang] || '';

    if (data.needsClarification && data.questions.length) {
      const q = document.createElement('div');
      q.className = 'ai-questions';
      q.innerHTML = `<p>${escapeHtml(t('aiQuestionsTitle'))}</p>`;
      for (const question of data.questions) {
        const qtext = question[state.lang] || question.ar || question.en || '';
        if (!qtext) continue;
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip ai-q';
        chip.textContent = qtext;
        chip.addEventListener('click', () => {
          $('#assistantInput').value = qtext;
          runAssistant(qtext, true);
        });
        q.append(chip);
      }
      resultsEl.append(q);
    }

    for (const s of data.suggestions) resultsEl.append(renderAiCard(s));
    for (const a of data.alternatives) resultsEl.append(renderAiCard(a, true));

    $('#engineNote').textContent = data.fallback
      ? t('aiFallbackNote')
      : `${data.engine} · ${data.note}`;
  } catch (err) {
    replyEl.textContent = err.message || t('errGeneric');
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- boot ---------------- */

async function boot() {
  applyLang();
  const grid = $('#productGrid');
  grid.innerHTML = Array.from({ length: 6 }, () => `<div class="card"><div class="card-media skeleton"></div><div class="card-body"><div class="skeleton" style="height:16px;width:70%"></div><div class="skeleton" style="height:12px"></div></div></div>`).join('');
  try {
    const [cfg, prod] = await Promise.all([api('/api/config'), api('/api/products')]);
    state.config = cfg;
    state.products = prod.products;
    renderFilters();
    renderGrid();
    renderRules();
    renderChips();
    saveCart();
    renderCart();
    $('#engineNote').textContent = t('adminNote');
    const health = await api('/api/health');
    $('#buildInfo').textContent = `v${health.version} · ${String(health.commit).slice(0, 7)}`;
  } catch (err) {
    grid.innerHTML = `<div class="alert alert-error is-visible">${escapeHtml(t('errGeneric'))} — ${escapeHtml(err.message)}</div>`;
  }

  $('#langToggle').addEventListener('click', () => {
    state.lang = state.lang === 'ar' ? 'en' : 'ar';
    applyLang();
    renderFilters(); renderGrid(); renderRules(); renderChips(); renderCart(); saveCart();
    if (state.custom) {
      $('#customTitle').textContent = state.custom.product.name[state.lang];
      $('#customDesc').textContent = state.custom.product.desc[state.lang];
      renderCustomFields();
      if (state.custom.quote) refreshQuote();
    }
  });

  $('#cartBtn').addEventListener('click', openCart);
  $('#cartClose').addEventListener('click', closeCart);
  $('#overlay').addEventListener('click', closeCart);
  $('#customClose').addEventListener('click', closeCustomizer);
  $('#customModal').addEventListener('click', (e) => { if (e.target.id === 'customModal') closeCustomizer(); });
  $('#checkoutModal').addEventListener('click', (e) => { if (e.target.id === 'checkoutModal') $('#checkoutModal').classList.remove('is-open'); });
  $('#checkoutClose').addEventListener('click', () => $('#checkoutModal').classList.remove('is-open'));
  $('#checkoutBtn').addEventListener('click', openCheckout);

  $('#addToCartBtn').addEventListener('click', () => {
    const c = state.custom;
    if (!c || !c.quote) { toast(t('errGeneric'), 'error'); return; }
    // Read the live input so a click without a blur can never add the stale quantity.
    const qtyInput = document.querySelector('#qtyInput');
    const quantity = clampQty(qtyInput ? qtyInput.value : c.qty);
    const lt = lineTotals(c.quote.cakeSubtotal + c.quote.rushFee, c.quote.deliveryFee, quantity);
    addLine({
      productId: c.product.id,
      name: c.product.name,
      image: c.product.image,
      config: { ...c.quote.config },
      unitPrice: lt.unitPrice,
      deliveryFee: lt.delivery,
      quantity: lt.quantity,
    });
    closeCustomizer();
    toast(`${t('addToCartOk')} — ${money(lt.unitPrice)} × ${lt.quantity} = ${money(lt.cakes)}`, 'ok');
    openCart();
  });

  $('#assistantForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const msg = $('#assistantInput').value.trim();
    if (msg.length < 2) { toast(t('required'), 'error'); return; }
    runAssistant(msg);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeCustomizer();
      closeCart();
      $('#checkoutModal').classList.remove('is-open');
    }
  });
}

boot();
