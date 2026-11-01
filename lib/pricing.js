/**
 * Cake Genius - pricing engine (single source of truth).
 *
 * Every price shown in the UI or quoted by the assistant is produced here.
 * The browser never calculates money: it asks POST /api/quote and renders the
 * breakdown it receives. The same function is used by checkout, so the amount
 * saved with an order is always the server-computed amount.
 *
 * Rules (all additive on top of the product base price, which is the price of a
 * 6-inch cake with the default flavor / filling / design and no message):
 *
 *   size      -> multiplier on the base price
 *   flavor    -> flat surcharge
 *   filling   -> flat surcharge
 *   design    -> flat surcharge
 *   message   -> free up to 30 chars, +12 SAR for each started block of 20 extra chars
 *   rush      -> +25% of the cake subtotal when delivery is requested in < 24h
 *   delivery  -> flat fee: 0 pickup, 25 city delivery
 *
 * All money is handled in whole SAR.
 */

export const CURRENCY = 'SAR';

export const SIZES = {
  s6: { id: 's6', multiplier: 1.0, serves: 8, label: { ar: '6 إنش (8 أشخاص)', en: '6" (serves 8)' } },
  s8: { id: 's8', multiplier: 1.35, serves: 14, label: { ar: '8 إنش (14 شخصاً)', en: '8" (serves 14)' } },
  s10: { id: 's10', multiplier: 1.85, serves: 22, label: { ar: '10 إنش (22 شخصاً)', en: '10" (serves 22)' } },
  tier2: { id: 'tier2', multiplier: 2.4, serves: 30, label: { ar: 'طابقان (30 شخصاً)', en: 'Two tiers (serves 30)' } },
};

export const FLAVORS = {
  vanilla: { id: 'vanilla', surcharge: 0, label: { ar: 'فانيلا', en: 'Vanilla' } },
  chocolate: { id: 'chocolate', surcharge: 15, label: { ar: 'شوكولاتة', en: 'Chocolate' } },
  redvelvet: { id: 'redvelvet', surcharge: 25, label: { ar: 'ريد فيلفيت', en: 'Red velvet' } },
  pistachio: { id: 'pistachio', surcharge: 35, label: { ar: 'فستق حلبي', en: 'Pistachio' } },
  mango: { id: 'mango', surcharge: 20, label: { ar: 'مانجو', en: 'Mango' } },
};

export const FILLINGS = {
  cream: { id: 'cream', surcharge: 0, label: { ar: 'كريمة فانيلا', en: 'Vanilla cream' } },
  ganache: { id: 'ganache', surcharge: 20, label: { ar: 'غاناش شوكولاتة', en: 'Chocolate ganache' } },
  fruit: { id: 'fruit', surcharge: 15, label: { ar: 'مربى فواكه', en: 'Fruit compote' } },
  lotus: { id: 'lotus', surcharge: 25, label: { ar: 'لوتس كراميل', en: 'Lotus caramel' } },
};

export const DESIGNS = {
  classic: { id: 'classic', surcharge: 0, label: { ar: 'كلاسيكي بسيط', en: 'Simple classic' } },
  minimal: { id: 'minimal', surcharge: 20, label: { ar: 'حديث مينيمال', en: 'Modern minimal' } },
  floral: { id: 'floral', surcharge: 45, label: { ar: 'زهور طبيعية', en: 'Fresh florals' } },
  themed: { id: 'themed', surcharge: 60, label: { ar: 'ثيم مخصص', en: 'Custom theme' } },
  photo: { id: 'photo', surcharge: 70, label: { ar: 'طبعة صورة قابلة للأكل', en: 'Edible photo print' } },
};

export const DELIVERY = {
  pickup: { id: 'pickup', fee: 0, label: { ar: 'استلام من الفرع', en: 'Pickup' } },
  delivery: { id: 'delivery', fee: 25, label: { ar: 'توصيل داخل المدينة', en: 'City delivery' } },
};

export const MESSAGE_FREE_CHARS = 30;
export const MESSAGE_EXTRA_BLOCK = 20;
export const MESSAGE_EXTRA_FEE = 12;
export const RUSH_HOURS = 24;
export const RUSH_RATE = 0.25;
export const MAX_MESSAGE_CHARS = 120;

export const DEFAULTS = {
  size: 's6',
  flavor: 'vanilla',
  filling: 'cream',
  design: 'classic',
  message: '',
  deliveryMethod: 'pickup',
};

export function messageFee(message) {
  const len = [...String(message || '').trim()].length;
  if (len <= MESSAGE_FREE_CHARS) return 0;
  const extra = len - MESSAGE_FREE_CHARS;
  return Math.ceil(extra / MESSAGE_EXTRA_BLOCK) * MESSAGE_EXTRA_FEE;
}

export function hoursUntil(isoDate, now = new Date()) {
  const t = new Date(isoDate).getTime();
  if (!Number.isFinite(t)) return null;
  return (t - now.getTime()) / 36e5;
}

/**
 * Compute a quote. `product` must be a catalog row: { id, name, basePrice }.
 * Throws PricingError (status 400) on invalid option ids or dates.
 */
export function quote(product, cfg = {}, now = new Date()) {
  if (!product) throw new PricingError('PRODUCT_NOT_FOUND', 'Unknown product');
  const size = SIZES[cfg.size || DEFAULTS.size];
  const flavor = FLAVORS[cfg.flavor || DEFAULTS.flavor];
  const filling = FILLINGS[cfg.filling || DEFAULTS.filling];
  const design = DESIGNS[cfg.design || DEFAULTS.design];
  const method = DELIVERY[cfg.deliveryMethod || DEFAULTS.deliveryMethod];

  if (!size) throw new PricingError('BAD_SIZE', 'Unknown size');
  if (!flavor) throw new PricingError('BAD_FLAVOR', 'Unknown flavor');
  if (!filling) throw new PricingError('BAD_FILLING', 'Unknown filling');
  if (!design) throw new PricingError('BAD_DESIGN', 'Unknown design');
  if (!method) throw new PricingError('BAD_DELIVERY', 'Unknown delivery method');

  const message = String(cfg.message || '').trim();
  if ([...message].length > MAX_MESSAGE_CHARS) {
    throw new PricingError('MESSAGE_TOO_LONG', `Message cannot exceed ${MAX_MESSAGE_CHARS} characters`);
  }

  const base = Math.round(product.basePrice);
  const sizePrice = Math.round(base * size.multiplier);
  const sizeDelta = sizePrice - base;
  const msgFee = messageFee(message);

  const cakeSubtotal = sizePrice + flavor.surcharge + filling.surcharge + design.surcharge + msgFee;

  let rushRequired = false;
  let rushFee = 0;
  const when = cfg.deliveryAt ? hoursUntil(cfg.deliveryAt, now) : null;
  if (when !== null && when < RUSH_HOURS) {
    rushRequired = true;
    rushFee = Math.round(cakeSubtotal * RUSH_RATE);
  }

  const deliveryFee = method.fee;
  const total = cakeSubtotal + rushFee + deliveryFee;

  const breakdown = [
    { key: 'base', label: { ar: 'سعر القاعدة (6 إنش)', en: 'Base price (6")' }, amount: base },
  ];
  if (sizeDelta !== 0) {
    breakdown.push({ key: 'size', label: size.label, amount: sizeDelta });
  }
  if (flavor.surcharge) breakdown.push({ key: 'flavor', label: flavor.label, amount: flavor.surcharge });
  if (filling.surcharge) breakdown.push({ key: 'filling', label: filling.label, amount: filling.surcharge });
  if (design.surcharge) breakdown.push({ key: 'design', label: design.label, amount: design.surcharge });
  if (msgFee) {
    breakdown.push({
      key: 'message',
      label: { ar: 'رسالة أطول من 30 حرفاً', en: 'Message over 30 characters' },
      amount: msgFee,
    });
  }
  if (rushFee) {
    breakdown.push({
      key: 'rush',
      label: { ar: 'تنفيذ مستعجل (أقل من 24 ساعة) +25%', en: 'Rush order (<24h) +25%' },
      amount: rushFee,
    });
  }
  if (deliveryFee) breakdown.push({ key: 'delivery', label: method.label, amount: deliveryFee });

  return {
    currency: CURRENCY,
    productId: product.id,
    productName: product.name,
    config: {
      size: size.id,
      flavor: flavor.id,
      filling: filling.id,
      design: design.id,
      message,
      deliveryMethod: method.id,
      deliveryAt: cfg.deliveryAt || null,
    },
    serves: size.serves,
    cakeSubtotal,
    rushRequired,
    rushFee,
    deliveryFee,
    total,
    breakdown,
    rulesVersion: 'pricing-v1',
  };
}

export class PricingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PricingError';
    this.code = code;
    this.status = 400;
  }
}

export function publicRules() {
  return {
    currency: CURRENCY,
    sizes: Object.values(SIZES),
    flavors: Object.values(FLAVORS),
    fillings: Object.values(FILLINGS),
    designs: Object.values(DESIGNS),
    delivery: Object.values(DELIVERY),
    message: {
      freeChars: MESSAGE_FREE_CHARS,
      extraBlock: MESSAGE_EXTRA_BLOCK,
      extraFee: MESSAGE_EXTRA_FEE,
      maxChars: MAX_MESSAGE_CHARS,
    },
    rush: { hours: RUSH_HOURS, rate: RUSH_RATE },
    rulesVersion: 'pricing-v1',
  };
}

/** Cheapest legal configuration for a product at a given size (message empty, pickup). */
export function baselineTotal(product, size = 's6') {
  return quote(product, { size, deliveryMethod: 'pickup' }).total;
}
