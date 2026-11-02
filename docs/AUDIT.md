# Cake Genius — Independent Audit Report

**Auditor:** Independent Senior Software Engineer (Hermes Agent)
**Baseline:** `100ca3e7652196dbf2e5058e9ce6f7545ee3ce53` (branch `main`)
**Date:** 2026-11-02
**Scope:** full repository, read-only, without relying on prior agent acceptance reports.

---

## 1. Method

- Read every source file: `server.js`, `lib/{pricing,assistant,db,catalog}.js`,
  `public/lib/cart-math.js`, `public/{index.html,app.js,admin.html,admin.js}`,
  `tests/{acceptance,cart-math.test}.mjs`, `tools/gen-images.mjs`.
- Reproduced the test suite from scratch on a clean SQLite file (no reliance on
  pasted results): **19 unit + 77 acceptance checks, all passing**.
- Traced every privileged route, every money computation, and the whole
  catalog → quote → cart → order → admin pipeline.

## 2. Reproducible baseline evidence

```
node tests/cart-math.test.mjs   -> 19 passed, 0 failed
node tests/acceptance.mjs       -> 77 passed, 0 failed   (BASE_URL=http://127.0.0.1:3130, fresh DB)
```

The pricing engine and the checkout path are verified correct by independent
recomputation in the tests: unit×qty + per-line delivery is exact, client-sent
`unitPrice`/`lineTotal`/`total` are ignored and recomputed server-side, and the
assistant's suggestion price is asserted equal to `/api/quote` for the same config.

## 3. Findings by severity

| # | Severity | Category | Area | Finding |
|---|----------|----------|------|---------|
| A1 | medium | Security | Auth | Login rate limiter keys on `clientIp()`, which trusts the first `X-Forwarded-For` value unconditionally (`server.js:196-200`). A direct attacker can rotate the header to get a fresh 6-attempt budget per request, defeating brute-force throttling. |
| A2 | low | Correctness | DB | `nextOrderCode()` (`lib/db.js:185-189`) derives the code from `COUNT(*) + 1001` **outside** the `BEGIN IMMEDIATE` transaction. Safe in the single-process synchronous path today, but it collides under any multi-process/cluster deployment, and the `UNIQUE` constraint then surfaces as a 500 to the customer. |
| A3 | low | Robustness | HTTP | `serveStatic` runs `decodeURIComponent(urlPath)` (`server.js:217`) before any try/catch; a malformed percent-sequence (`/api/%zz`) throws `URIError` → 500 instead of a 400/404. |
| A4 | low | Correctness | HTTP | The SPA fallback returns `index.html` with **200** for any unknown non-API path, including missing assets (`/nope.css`) and typos (`/adimn`). A broken asset reference is silently masked by an HTML 200. |
| A5 | low | Consistency | Validation | `validPhone` accepts up to 18 digits (`PHONE_RE {9,18}`, `server.js:136`) while the README and UI state 9–15. Server-side vs documented contract drift. |
| A6 | low | Data model | Orders | `orders.subtotal` includes rush fee while `orders.rush_fee` is stored separately, so `subtotal + rush_fee + delivery_fee ≠ total` (`subtotal + delivery_fee = total`). No user-facing bug (all consumers read it consistently), but the column is easy to misread. |
| A7 | low | Product logic | Assistant | `sizeFor()` caps at `tier2` (serves 30); a request for >30 guests returns a cake that under-serves. The solver never surfaces this shortfall. |
| A8 | low | Docs | README | README §5 still says "48 فحصاً" but the suite is now 77 acceptance checks; §3/§9 correctly state the assistant is rule-based (no LLM), which is the gap this work closes. |
| A9 | info | Security | HTTP | CSRF on admin routes is mitigated only by `SameSite=Strict` (adequate for a demo, no token). No `Secure` flag when not behind TLS (conditional code exists). |
| A10 | info | Robustness | HTTP | `readJsonBody` calls `req.destroy()` on an oversized body, so the 413 may not be delivered cleanly (socket already torn down). |
| A11 | info | Validation | Orders | `isValidQty([2])` is `true` (array coerces via `Number`), an incidental loosening that still stays within 1–20. |

**No critical or high severity defects were found.** The baseline is genuinely
well-engineered: pricing is single-sourced in `lib/pricing.js`, checkout
re-prices on the server, admin routes are session-guarded, password storage is
scrypt + `timingSafeEqual`, cookies are HttpOnly + SameSite=Strict, and the
quantity/price regression (BUG-001) is covered by both unit and black-box tests.

## 4. The core gap this work addresses

The assistant is **not an LLM** — `lib/assistant.js` is a deterministic keyword
extractor, and `/api/config` honestly reports `assistant.engine: rule-based-nlu-v1`.
It cannot hold a conversation, ask clarifying questions, or explain alternatives;
it only recognises a fixed vocabulary. Phase 2 replaces this with a genuine
LLM-powered designer while keeping **all pricing in the server's engine**.
