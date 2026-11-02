/**
 * Unit tests for trusted-proxy client-IP resolution (lib/client-ip.js).
 * Proves: header ignored without a trusted peer; forged left hop ignored; correct
 * extraction across a chain of trusted proxies; CIDR matching; IPv4-mapped IPv6.
 */
import { ipToInt, parseTrustedProxies, isTrustedProxy, resolveClientIp } from '../lib/client-ip.js';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { failures.push(name); console.log(`FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}

const single = parseTrustedProxies('10.0.0.5');
const chain = parseTrustedProxies('10.0.0.5, 10.0.0.6');
const cidr = parseTrustedProxies('10.1.0.0/16');

check('untrusted peer ignores XFF entirely (returns peer)', resolveClientIp('203.0.113.7', '1.2.3.4', single) === '203.0.113.7');
check('trusted peer + clean XFF -> client', resolveClientIp('10.0.0.5', '203.0.113.9', single) === '203.0.113.9');
check('forged left hop is ignored (rightmost non-trusted wins)', resolveClientIp('10.0.0.5', '1.2.3.4, 203.0.113.9', single) === '203.0.113.9');
check('chain of trusted proxies: "client, proxy1" -> client', resolveClientIp('10.0.0.6', '203.0.113.9, 10.0.0.5', chain) === '203.0.113.9');
check('all hops trusted -> leftmost hop', resolveClientIp('10.0.0.6', '10.0.0.5, 10.0.0.6', chain) === '10.0.0.5');
check('CIDR matches an in-range peer', isTrustedProxy('10.1.2.3', cidr) === true);
check('CIDR does not match an out-of-range peer', isTrustedProxy('10.2.2.3', cidr) === false);
check('IPv4-mapped IPv6 peer (::ffff:) is normalised and trusted', resolveClientIp('::ffff:10.0.0.5', '203.0.113.9', single) === '203.0.113.9');
check('trusted peer + no XFF -> peer', resolveClientIp('10.0.0.5', undefined, single) === '10.0.0.5');
check('ipToInt rejects garbage', ipToInt('not-an-ip') === null && ipToInt('999.1.1.1') === null);

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('FAILED:', failures.join(' | ')); process.exit(1); }
