/**
 * Cart / line arithmetic — single source of truth shared by the browser and the
 * server (server.js imports this same file). Keeping one implementation is what
 * makes "312 x 2 = 624" impossible to disagree on between the customiser, the
 * cart, checkout, the API response and the stored order.
 *
 * Rules encoded here (see README §2):
 *   line cake total = unit cake price (including rush) x quantity
 *   line delivery   = delivery fee per line, NOT multiplied by quantity
 *   cart total      = sum(line cakes) + sum(line delivery)
 */

export const MAX_QTY = 20;
export const MIN_QTY = 1;

/** Coerce anything the UI or an HTTP body may carry into an integer 1..20. */
export function clampQty(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < MIN_QTY) return MIN_QTY;
  return Math.min(MAX_QTY, n);
}

/** True only for a genuine integer in range (used by the server to reject, not clamp). */
export function isValidQty(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= MIN_QTY && n <= MAX_QTY;
}

/**
 * Per-line money. `unitCakePrice` includes rush; `lineDeliveryFee` is charged once
 * per line regardless of quantity.
 */
export function lineTotals(unitCakePrice, lineDeliveryFee, quantity) {
  const q = clampQty(quantity);
  const unit = Math.round(Number(unitCakePrice) || 0);
  const delivery = Math.round(Number(lineDeliveryFee) || 0);
  const cakes = unit * q;
  return { quantity: q, unitPrice: unit, delivery, cakes, total: cakes + delivery };
}

/** Whole-cart money from lines shaped { unitPrice, deliveryFee, quantity }. */
export function cartTotals(lines) {
  let cakes = 0;
  let delivery = 0;
  let count = 0;
  for (const line of lines || []) {
    const t = lineTotals(line.unitPrice, line.deliveryFee, line.quantity);
    cakes += t.cakes;
    delivery += t.delivery;
    count += t.quantity;
  }
  return { cakes, delivery, total: cakes + delivery, count };
}
