/**
 * Unit tests for the shared cart arithmetic (public/lib/cart-math.js) — the module
 * both the browser and server.js import. This is the regression net for BUG-001
 * (a quantity of 2 must never produce the price of 1).
 */
import { lineTotals, cartTotals, clampQty, isValidQty, MAX_QTY } from '../public/lib/cart-math.js';

let pass = 0;
const failures = [];

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`PASS  ${name}`); }
  else { failures.push(name); console.log(`FAIL  ${name} -> got ${a}, expected ${e}`); }
}

/* the reproduction case: unit 312, qty 1 and 2 */
eq('qty 1 of a 312 cake: cakes 312, total 312', lineTotals(312, 0, 1), { quantity: 1, unitPrice: 312, delivery: 0, cakes: 312, total: 312 });
eq('qty 2 of a 312 cake: cakes 624, total 624', lineTotals(312, 0, 2), { quantity: 2, unitPrice: 312, delivery: 0, cakes: 624, total: 624 });
eq('qty 3 of a 312 cake: cakes 936', lineTotals(312, 0, 3).cakes, 936);

/* delivery is per line, not per cake */
eq('delivery is charged once for qty 2', lineTotals(312, 25, 2), { quantity: 2, unitPrice: 312, delivery: 25, cakes: 624, total: 649 });
eq('delivery is charged once for qty 3', lineTotals(312, 25, 3).total, 961);

/* string quantities coming from an input field or JSON body */
eq('quantity "2" behaves like 2', lineTotals(312, 25, '2').cakes, 624);

/* clamping (UI) and strict validation (server) */
eq('clampQty(0) -> 1', clampQty(0), 1);
eq('clampQty(99) -> 20', clampQty(99), MAX_QTY);
eq('clampQty("abc") -> 1', clampQty('abc'), 1);
eq('clampQty(2.7) -> 2', clampQty(2.7), 2);
eq('isValidQty(2) true', isValidQty(2), true);
eq('isValidQty("2") true', isValidQty('2'), true);
eq('isValidQty(2.5) false', isValidQty(2.5), false);
eq('isValidQty(0) false', isValidQty(0), false);
eq('isValidQty(21) false', isValidQty(21), false);
eq('isValidQty(null) false', isValidQty(null), false);

/* cart level */
const cart = [
  { unitPrice: 312, deliveryFee: 25, quantity: 2 }, // 624 + 25
  { unitPrice: 120, deliveryFee: 0, quantity: 1 },  // 120 + 0
];
eq('cart sums cakes, delivery and count', cartTotals(cart), { cakes: 744, delivery: 25, total: 769, count: 3 });
eq('empty cart is zero', cartTotals([]), { cakes: 0, delivery: 0, total: 0, count: 0 });
eq('cart ignores a line quantity of 0 by clamping', cartTotals([{ unitPrice: 100, deliveryFee: 0, quantity: 0 }]).total, 100);

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log('FAILED:', failures.join(' | '));
  process.exit(1);
}
