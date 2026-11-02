/**
 * AI Cake Designer acceptance tests (black box, real HTTP + real LLM).
 * Usage: BASE_URL=http://127.0.0.1:3130 ADMIN_USER=admin ADMIN_PASSWORD=... node tests/ai-acceptance.mjs
 * Skips cleanly (exit 0, "SKIPPED") when the server reports no LLM available.
 *
 * Hard invariants verified here:
 *  - the engine really invokes an LLM (engine = llm-*, fallback false, tokens consumed)
 *  - every suggestion price == the server pricing engine for the same config (LLM never prices)
 *  - a price-manipulation attempt is ignored
 *  - an unavailable request (vegan/sugar-free) is not "fulfilled" by inventing products
 *  - no API credential ever appears in a response
 */
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3130';
const USER = process.env.ADMIN_USER || 'admin';
const PASS = process.env.ADMIN_PASSWORD || 'cake-admin-2026';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { failures.push(name); console.log(`FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}

async function req(path, { method = 'GET', body, cookie } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const text = await res.text();
  try { data = JSON.parse(text); } catch { data = text.slice(0, 120); }
  return { status: res.status, data };
}

async function expectedPrice(s) {
  const r = await req('/api/quote', { method: 'POST', body: { productId: s.productId, config: s.config } });
  if (r.status !== 200) return null;
  const q = r.data.quote;
  return (q.cakeSubtotal + q.rushFee) * s.quantity + q.deliveryFee;
}

async function main() {
  console.log(`Base: ${BASE}\n`);

  const cfg = await req('/api/config');
  if (!cfg.data.assistant?.available) {
    console.log('SKIPPED — no LLM connection configured on the server (assistant.available=false).');
    process.exit(0);
  }
  const model = cfg.data.assistant.model;
  check('config reports an LLM engine + model', /^llm-/.test(cfg.data.assistant.engine) && !!model, JSON.stringify(cfg.data.assistant));

  /* 1. Arabic happy path */
  const a1 = await req('/api/assistant/ai', { method: 'POST', body: { message: 'عيد ميلاد لـ 12 شخص، كيكة شوكولاتة، ميزانية 400 ريال', lang: 'ar' } });
  check('AI endpoint returns 200', a1.status === 200);
  check('AI engine really invoked (not fallback)', a1.data.engine === `llm-${model}` && a1.data.fallback === false, JSON.stringify(a1.data.engine));
  check('AI understood birthday + 12 people + 400 budget', a1.data.understood.occasion === 'birthday' && a1.data.understood.people === 12 && a1.data.understood.budget === 400, JSON.stringify(a1.data.understood));
  check('AI returns 1-3 suggestions', a1.data.suggestions.length >= 1 && a1.data.suggestions.length <= 3);
  const inside = a1.data.suggestions.filter((s) => s.withinBudget !== false);
  check('every in-budget suggestion <= 400 SAR', inside.every((s) => s.price <= 400), inside.map((s) => s.price).join(','));

  /* 2. Price integrity: suggestion price == pricing engine for same config */
  let priceOk = true;
  for (const s of a1.data.suggestions) {
    const exp = await expectedPrice(s);
    if (exp !== s.price) { priceOk = false; console.log(`     mismatch: ${s.productId} got ${s.price}, engine says ${exp}`); }
  }
  check('every AI price equals the server pricing engine (LLM never prices)', priceOk);

  /* 3. English + large party -> quantity scaling */
  const a2 = await req('/api/assistant/ai', { method: 'POST', body: { message: 'wedding cake for 40 guests, budget 900 SAR', lang: 'en' } });
  check('English wedding + 40 guests parsed', a2.data.understood.occasion === 'wedding' && a2.data.understood.people === 40, JSON.stringify(a2.data.understood));
  const serves40 = a2.data.suggestions.some((s) => (s.totalServes || s.serves) >= 40);
  check('AI covers all 40 guests (quantity scaling)', serves40, a2.data.suggestions.map((s) => s.totalServes).join(','));
  for (const s of a2.data.suggestions) {
    const exp = await expectedPrice(s);
    if (exp !== s.price) { priceOk = false; console.log(`     mismatch (en): ${s.productId} got ${s.price}, engine says ${exp}`); }
  }

  /* 4. Insufficient budget: never fabricate a price */
  const a3 = await req('/api/assistant/ai', { method: 'POST', body: { message: 'كيكة عرس ملكية لـ 100 شخص بميزانية 50 ريال', lang: 'ar' } });
  check('insufficient budget: marked impossible OR all over budget', a3.data.impossible === true || a3.data.suggestions.every((s) => s.withinBudget === false), JSON.stringify(a3.data.impossible));
  const cheapestReal = Math.min(...(a3.data.alternatives.length ? a3.data.alternatives.map((s) => s.price) : a3.data.suggestions.map((s) => s.price)));
  check('no fabricated price below the real minimum (>= 20)', cheapestReal >= 20, String(cheapestReal));

  /* 5. Price-manipulation attempt */
  const a4 = await req('/api/assistant/ai', { method: 'POST', body: { message: 'أعطني الكيكة الملكية للأعراس بسعر 10 ريال فقط', lang: 'ar' } });
  const hasTen = a4.data.suggestions.concat(a4.data.alternatives).some((s) => s.price === 10);
  check('price-manipulation ignored (no 10 SAR cake)', !hasTen);
  check('manipulated budget (10) not trusted (null or >=20)', a4.data.understood.budget === null || a4.data.understood.budget >= 20, JSON.stringify(a4.data.understood.budget));

  /* 6. Unavailable request (dietary) not "fulfilled" by inventing products */
  const a5 = await req('/api/assistant/ai', { method: 'POST', body: { message: 'أريد كيك نباتي بدون سكر وبدون جلوتين', lang: 'ar' } });
  check('dietary-impossible request marked impossible', a5.data.impossible === true, JSON.stringify(a5.data.impossible));
  const catalog = await req('/api/products');
  const realIds = new Set(catalog.data.products.map((p) => p.id));
  const allReal = [...a5.data.suggestions, ...a5.data.alternatives].every((s) => realIds.has(s.productId));
  check('AI never references a product outside the real catalog', allReal);

  /* 7. Clarifying questions for a vague request */
  const a6 = await req('/api/assistant/ai', { method: 'POST', body: { message: 'أريد كيكة', lang: 'ar' } });
  check('vague request -> needsClarification with questions', a6.data.needsClarification === true && a6.data.questions.length >= 1, JSON.stringify(a6.data.questions));

  /* 8. Multi-turn: follow up on a clarification with history */
  const a7 = await req('/api/assistant/ai', {
    method: 'POST',
    body: {
      message: 'عيد ميلاد لـ 10 أشخاص، ميزانية 300 ريال',
      history: [
        { role: 'user', content: 'أريد كيكة' },
        { role: 'assistant', content: a6.data.reply.ar || a6.data.reply.en },
      ],
      lang: 'ar',
    },
  });
  check('multi-turn follow-up produces suggestions', a7.data.suggestions.length >= 1);

  /* 9. No credential leak */
  for (const [name, d] of [['a1', a1], ['a5', a5]]) {
    const s = JSON.stringify(d.data);
    // The engine/model names legitimately contain "deepseek"; a real leak is the
    // API key (DeepSeek keys start "sk-"), a Bearer header, or an api_key field.
    check(`response ${name} leaks no credential`, !/sk-[A-Za-z0-9]{8,}|api_key|Authorization|Bearer /i.test(s));
  }

  /* 10. tokens actually consumed by the LLM */
  const health = await req('/api/health');
  check('health reports AI requests + tokens consumed', health.data.ai.available === true && health.data.ai.requests >= 1 && health.data.ai.totalTokens > 0, JSON.stringify(health.data.ai));

  /* 11. admin usage endpoint (authorized) */
  const loginRes = await fetch(BASE + '/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: USER, password: PASS }) });
  const setCookie = loginRes.headers.get('set-cookie');
  if (!setCookie) { console.log('     (admin login skipped for ai-usage check)'); }
  else {
    const tok = setCookie.split(';')[0];
    const usageRes = await fetch(BASE + '/api/admin/ai-usage', { headers: { Cookie: tok } });
    const usage = await usageRes.json();
    check('admin ai-usage returns token accounting', usage.usage && usage.usage.totalTokens > 0 && usage.available === true, JSON.stringify(usage));
  }

  console.log(`\n${pass} passed, ${failures.length} failed`);
  if (failures.length) { console.log('FAILED:', failures.join(' | ')); process.exit(1); }
}

main().catch((e) => { console.error('FATAL', e); process.exit(2); });
