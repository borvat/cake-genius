/**
 * Trusted-proxy client-IP resolution (no side effects, pure — unit-testable).
 *
 * The rule: X-Forwarded-For is trusted ONLY when the direct peer socket belongs to a
 * configured trusted proxy. NODE_ENV=production alone is NOT proof of a proxy — an
 * exposed app in production would otherwise trust attacker-supplied headers. Trust is
 * a function of peer identity (an explicit IP/CIDR allowlist), never of the environment.
 */

export function ipToInt(ip) {
  if (typeof ip !== 'string') return null;
  const norm = ip.replace(/^::ffff:/, '');
  const p = norm.split('.');
  if (p.length !== 4) return null;
  const o = p.map(Number);
  if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
}

/** Parse a comma-separated TRUSTED_PROXIES list of exact IPs or CIDRs. */
export function parseTrustedProxies(list) {
  const out = [];
  for (const raw of String(list || '').split(',')) {
    const s = raw.trim();
    if (!s) continue;
    const m = /^(\d{1,3}(?:\.\d{1,3}){3})(?:\/(\d{1,2}))?$/.exec(s);
    if (!m) continue;
    const net = ipToInt(m[1]);
    if (net === null) continue;
    const bits = m[2] ? Math.min(32, Math.max(0, Number(m[2]))) : 32;
    out.push({ net, bits });
  }
  return out;
}

export function isTrustedProxy(ip, trusted) {
  const n = ipToInt(ip);
  if (n === null) return false;
  return trusted.some((c) => {
    const mask = c.bits === 0 ? 0 : (~0 << (32 - c.bits)) >>> 0;
    return (n & mask) === (c.net & mask);
  });
}

/**
 * Resolve the real client IP from the peer socket and the X-Forwarded-For header.
 * The header is trusted only when `peer` is a trusted proxy. The chain is walked
 * right-to-left, skipping trusted proxies, so the first untrusted hop is the client.
 * This is correct across a chain of proxies and resistant to a client prepending
 * forged hops on the left.
 */
export function resolveClientIp(peer, xff, trusted) {
  const p = String(peer || '').replace(/^::ffff:/, '') || 'unknown';
  if (!isTrustedProxy(p, trusted)) return p;
  if (typeof xff !== 'string' || !xff.length) return p;
  const hops = xff.split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!isTrustedProxy(hops[i], trusted)) return hops[i];
  }
  return hops[0] || p;
}
