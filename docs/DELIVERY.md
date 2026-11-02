# Cake Genius — Delivery Report (DeepSeek Pro Engineering Challenge)

**Branch:** `feature/ai-cake-designer` (isolated, not `main`)
**Baseline:** `100ca3e7652196dbf2e5058e9ce6f7545ee3ce53`
**Commits:**
- `2fc2dfa` — docs: independent audit report (Phase 1)
- `1fd891f` — feat: AI Cake Designer + audit fixes

---

## 1. Verdict

**READY (engineering)** — the AI Cake Designer genuinely invokes an LLM and every price
it returns is verified against the server pricing engine. **Not merged, not deployed.**
Branch `feature/ai-cake-designer` is pushed and **PR #1 is open for review** (base `main`,
head `feature/ai-cake-designer`); `main` (the original Flash work) is untouched.

Independent review verdict on PR #1: **CHANGES REQUESTED** (P0/P1) — addressed in the
same branch, see §8.

---

## 2. Independent audit (Phase 1)

Full report: [`docs/AUDIT.md`](AUDIT.md). **No critical or high defects found** in the
baseline — pricing is single-sourced, checkout re-prices server-side, admin routes are
session-guarded, scrypt + `timingSafeEqual`, HttpOnly/SameSite cookies. The one real gap:
the assistant was a deterministic keyword extractor, not an LLM.

Defects discovered (severity → disposition):

| # | Severity | Finding | Disposition |
|---|----------|---------|-------------|
| A1 | medium | `clientIp()` trusted `X-Forwarded-For` unconditionally → login rate-limit bypass | **FIXED** |
| A2 | low | `nextOrderCode()` = `COUNT(*)+1001` outside the transaction → collision in multi-process | **FIXED** |
| A3 | low | malformed percent-encoding → `URIError` → 500 | **FIXED** |
| A4 | low | missing asset served HTML 200 (SPA fallback) instead of 404 | **FIXED** |
| A5 | low | phone regex accepts 18 digits vs documented 9–15 | documented (not changed) |
| A6 | low | `orders.subtotal` includes rush while `rush_fee` stored separately | documented (not changed) |
| A7 | low | >30 guests under-served by rule-based solver | **FIXED** in AI path (quantity scaling) |
| A8–A11 | low/info | README count drift; CSRF relies on SameSite; oversized-body 413; `isValidQty([2])` | documented (not changed) |

---

## 3. AI Cake Designer (Phase 2)

`lib/ai-assistant.js` + `POST /api/assistant/ai` + `public/app.js` UI.

- **Model:** `deepseek-v4-pro` (DeepSeek API), key read from `DEEPSEEK_API_KEY` at boot,
  never returned to the client, never committed.
- **Hard boundary:** the model only extracts structured requirements and writes prose.
  It never prices, never invents products/options/stock/delivery. The server validates
  every id against the catalog and computes every price with `pricing.js quote()`.
- **Capabilities:** Arabic + English; clarifying questions; multi-turn via `history`;
  budget respect; "cannot fulfil" (dietary/budget) → real nearest alternatives, never a
  fabricated price; quantity scaling for >30 guests; a valid, server-priced cart config
  per suggestion (one-click add-to-cart).
- **Resilience:** no key or model failure → automatic fallback to the rule-based
  assistant with `fallback: true` (never a 500 to the customer).

---

## 4. Before / after (same scenarios)

| Scenario | Before (baseline) | After |
|---|---|---|
| "عيد ميلاد لـ 12 شخص، شوكولاتة، ميزانية 400" | rule-based, keyword parse | LLM extracts + server prices, 3 suggestions ≤ 400 |
| "wedding cake for 40 guests, 900 SAR" | **under-serves (30 max)** | quantity ×2 → covers 40 |
| "كيكة عرس ملكية لـ 100 شخص بـ 50 ريال" | over-budget picks | `impossible` + nearest alternatives |
| "بسعر 10 ريال فقط" | n/a | price manipulation ignored (no 10-SAR cake) |
| "كيك نباتي بدون سكر" | unrecognised | `impossible: true`, real alternatives |
| "أريد كيكة" | generic picks | clarifying questions |
| Assistant engine | `rule-based-nlu-v1` | `llm-deepseek-v4-pro` (fallback false) |

---

## 5. Test results

Reproduced from a clean SQLite file, real HTTP, real LLM:

| Suite | Result |
|---|---|
| `tests/cart-math.test.mjs` (unit) | **19 passed, 0 failed** |
| `tests/ai-guard.test.mjs` (unit: rate limit + concurrency) | **6 passed, 0 failed** |
| `tests/acceptance.mjs` (API, no key needed) | **77 passed, 0 failed** |
| `tests/ai-acceptance.mjs` (LLM) | **22 passed, 0 failed** |
| `tests/ai-fallback.mjs` (model-failure fallback + 429 + forged-XFF) | **16 passed, 0 failed** |

Key assertions (all passing): every AI price == `/api/quote` recompute for the same
config; manipulated price ignored; dietary request marked impossible with real
catalog-only products; vague request → questions; multi-turn → suggestions; no credential
in any response; LLM token usage actually consumed.

Security fixes verified live: `GET /nope.css → 404`, `GET /%zz → 400`, login rate limit
holds through 7 attempts with rotating `X-Forwarded-For` (7th → 429).

**Browser E2E (real Chrome, RTL):** page loads `dir=rtl`; typed an Arabic request; 3 AI
cards rendered; engine note `llm-deepseek-v4-pro`; price `372 SAR` matches the engine
(235 base ×1.35 s8 + 15 chocolate + 20 ganache + 20 minimal); add-to-cart worked
(cart count 1, line total 372, delivery 0); **0 console errors**; language toggle EN.

---

## 6. API token usage & cost

Representative run (6 scenarios, `deepseek-v4-pro`):

| Metric | Value |
|---|---|
| Requests | 6 |
| Prompt tokens | 11,226 |
| Completion tokens | 8,561 |
| **Total tokens** | **19,787** |

Cost (DeepSeek V4-Pro, off-peak, USD per 1M): input cache-miss $0.66, output $1.98.

- Input: 11,226 × $0.66/1e6 = **$0.00741**
- Output: 8,561 × $1.98/1e6 = **$0.01695**
- **Upper bound ≈ $0.024** (~2.4¢) for 6 requests.

Real cost is lower: the catalog system prompt is identical across requests, so DeepSeek's
automatic prompt caching bills the repeated input at the cache-hit rate ($0.022/1M, a 30×
reduction). This is an upper bound because the aggregator counts prompt tokens without a
cache hit/miss split.

---

## 7. Remaining risks & limitations

- **Not merged, not deployed** — PR #1 open, awaiting independent review approval.
- **Model latency/cost:** `deepseek-v4-pro` is a reasoning model; per-request latency is
  several seconds. A cheaper `deepseek-flash` fallback could be wired for high-traffic use.
- **Prompt-cache cost is an estimate** (upper bound reported; exact split not aggregated).
- **Rate limiting** keys on the trusted client IP: `socket.remoteAddress` outside a proxy,
  and the rightmost `X-Forwarded-For` hop behind a trusted proxy (`IS_PROD` or
  `TRUSTED_PROXIES`). Left-side header spoofing cannot shift the bucket.
- **No stock/availability model exists** in the app at all, so the AI cannot (and is
  instructed not to) claim any — consistent with the mandate.
- Demo checkout (`payment_method: demo`) and Render free-tier data volatility are
  unchanged (README §10).

---

## 8. Review feedback (PR #1) — addressed

**P0 — AI API cost protection.** `POST /api/assistant/ai` now enforces, before any model
call: a per-IP fixed-window rate limit (`AI_RATE_WINDOW_MS`/`AI_RATE_MAX`, default
20/min), a global concurrency semaphore (`AI_MAX_CONCURRENT`, default 4), and a hard
per-request output-token cap (`MAX_OUTPUT_TOKENS` = 8000). Violations return a clear
`429` + `Retry-After`. The limiter keys on the **trusted** client IP (see P1), never on a
raw `X-Forwarded-For`. Guard config is exposed at `/api/config` (`assistant.guard`).

**P1 — Trust proxy.** `clientIp()` now trusts `X-Forwarded-For` only behind a trusted
reverse proxy — the production flag (`IS_PROD`) or an explicit `TRUSTED_PROXIES`
allowlist matched against the direct peer. It takes the **rightmost** hop (appended by the
trusted proxy), so a client prepending forged hops on the left cannot shift the identity.
Outside a proxy the peer socket is authoritative. Covered by `tests/ai-fallback.mjs`
(model-failure fallback, active `429`, and a 7-attempt forged/repeated `X-Forwarded-For`
login test that still hits `429`).

**P1 — AI acceptance.** Without an LLM, `tests/ai-acceptance.mjs` now prints
`SKIPPED (BLOCKED) — AI behaviour UNVERIFIED` and exits 0 (never a false pass). Two new
suites prove the guards: `tests/ai-guard.test.mjs` (rate limit + concurrency, unit) and
`tests/ai-fallback.mjs` (model failure → safe rule-based fallback with `fallback: true`,
plus an active `429 RATE_LIMITED` with `Retry-After`).

**P1 — Delivery evidence.** This report now reflects reality: branch pushed, PR #1 open,
not merged, not deployed (verified `mergedAt: null`).
