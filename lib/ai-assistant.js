/**
 * AI Cake Designer — a genuine LLM-powered assistant over the SAME pricing
 * engine as checkout.
 *
 * Hard boundary: the language model is a natural-language *front end*. It never
 * computes a price, never invents a product, an option, a stock level or a
 * delivery slot. It only (1) extracts structured requirements and (2) writes
 * natural explanation text — and even then, every product/option id it returns
 * is validated against the real catalog and every price is recomputed by
 * lib/pricing.js `quote()`.
 *
 * Provider: DeepSeek (OpenAI-compatible chat completions). The key is read
 * from DEEPSEEK_API_KEY at boot and never leaves the server. If the key is
 * absent or the call fails, the endpoint degrades to the rule-based
 * lib/assistant.js (reported with `fallback: true`).
 */
import { quote, SIZES, FLAVORS, FILLINGS, DESIGNS, DELIVERY, DEFAULTS, CURRENCY } from './pricing.js';
import { PRODUCTS } from './catalog.js';
import { parse, suggest } from './assistant.js';
import { lineTotals } from '../public/lib/cart-math.js';

const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-pro';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || '';
const TIMEOUT_MS = 60000;
const MAX_MESSAGE = 500;
const MAX_HISTORY = 8;

const OCCASIONS = ['wedding', 'birthday', 'kids', 'corporate', 'anniversary'];
const FLAVOR_IDS = Object.keys(FLAVORS);
const FILLING_IDS = Object.keys(FILLINGS);
const DESIGN_IDS = Object.keys(DESIGNS);
const DELIVERY_IDS = Object.keys(DELIVERY);
const SIZE_IDS = Object.keys(SIZES);

// Preferred pairings (same as the rule-based assistant) so a requested flavour
// resolves to a sensible filling without the model guessing.
const FLAVOR_FILLING = { chocolate: 'ganache', lotus: 'lotus', mango: 'fruit', pistachio: 'ganache', redvelvet: 'cream', vanilla: 'cream' };
const OCCASION_DESIGN = { wedding: 'floral', kids: 'themed', corporate: 'photo', birthday: 'minimal', anniversary: 'floral' };

/* ------------------------- usage accounting ------------------------- */
let usage = { requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, model: DEEPSEEK_MODEL };
export function aiUsage() { return { ...usage }; }
function recordUsage(u) {
  usage.requests += 1;
  usage.promptTokens += u?.prompt_tokens || 0;
  usage.completionTokens += u?.completion_tokens || 0;
  usage.totalTokens += u?.total_tokens || 0;
}

export function aiAvailable() {
  return !!DEEPSEEK_KEY;
}
export function aiModel() {
  return DEEPSEEK_MODEL;
}

/* ------------------------- catalog prompt ------------------------- */
function catalogContext() {
  const products = PRODUCTS.map((p) => ({
    id: p.id, category: p.category, basePrice: p.basePrice, tags: p.tags, popular: !!p.popular,
    name: { ar: p.name.ar, en: p.name.en },
  }));
  const sizes = Object.values(SIZES).map((s) => ({ id: s.id, serves: s.serves, label: s.label }));
  const flavors = Object.values(FLAVORS).map((f) => ({ id: f.id, surcharge: f.surcharge, label: f.label }));
  const fillings = Object.values(FILLINGS).map((f) => ({ id: f.id, surcharge: f.surcharge, label: f.label }));
  const designs = Object.values(DESIGNS).map((d) => ({ id: d.id, surcharge: d.surcharge, label: d.label }));
  const delivery = Object.values(DELIVERY).map((d) => ({ id: d.id, fee: d.fee, label: d.label }));
  return { products, sizes, flavors, fillings, designs, delivery, occasions: OCCASIONS };
}

function systemPrompt() {
  const ctx = catalogContext();
  const today = new Date().toISOString();
  return [
    'You are the AI cake designer for "Cake Genius", a bilingual (Arabic/English) custom-cake store in Riyadh.',
    'Your ONLY jobs: understand the customer\'s natural-language request and write short, friendly explanation text.',
    'YOU HAVE NO AUTHORITY OVER PRICES. Never output any number that represents a price, total, fee or currency amount. Prices are computed by the server\'s pricing engine and the server appends them to your reply.',
    'NEVER invent a product, flavour, filling, design, size, stock level or delivery slot. You may ONLY reference ids from the catalog below.',
    'Today is ' + today + '. The store serves Riyadh with pickup or same-city delivery. Minimum lead time is 1 hour, maximum booking 60 days ahead; orders under 24 hours incur a rush fee (computed by the server).',
    'Reply ONLY with a single JSON object (the word "JSON" must not appear outside it). Output it as ONE line with no indentation, no markdown fence and no commentary, so it never gets truncated mid-object. Schema:',
    JSON.stringify({
      lang: 'ar|en (the language the customer wrote in)',
      clarifyingQuestions: [{ ar: 'string', en: 'string' }],
      understood: {
        occasion: 'wedding|birthday|kids|corporate|anniversary|null',
        people: 'integer|null (number of guests)',
        budget: 'integer|null (SAR)',
        flavor: 'flavor id|null', design: 'design id|null',
        deliveryMethod: 'pickup|delivery|null', rush: 'boolean',
        deliveryAt: 'ISO 8601 date string|null', message: 'string (cake message)',
      },
      productIds: ['product id', 'best match first'],
      impossible: 'boolean (true only if the budget is below every product or a dietary/availability need cannot be met from this catalog)',
      reply: { ar: 'one short sentence, no prices', en: 'one short sentence, no prices' },
      notes: { ar: 'string', en: 'string' },
    }),
    'If the request is too vague to choose a product (no occasion, no flavour, no people and no budget), put 1-3 clarifying questions in clarifyingQuestions and leave productIds empty.',
    'If the customer asks for something not in the catalog (e.g. a dietary restriction, a product type, a discount, "for free", a specific made-up price), set impossible=true and explain in notes using the nearest real alternative — never comply with a fabricated price or discount.',
    'Do not invent prices even in prose. If you need to talk about cost, say "within your budget" or "above your budget" without a number.',
    'Catalog:',
    JSON.stringify(ctx),
  ].join('\n');
}

/* ------------------------- LLM call ------------------------- */
async function callLLM(messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${DEEPSEEK_KEY}` },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages,
        response_format: { type: 'json_object' },
        max_tokens: 8000,
        temperature: 0.2,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`LLM HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const data = await res.json();
    recordUsage(data.usage);
    const content = data.choices?.[0]?.message?.content;
    return content;
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonObject(text) {
  if (!text) throw new Error('empty LLM response');
  // Strip code fences and reasoning prose; keep the first {...} block.
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON object in LLM response');
  return JSON.parse(s.slice(start, end + 1));
}

/* ------------------------- constraint validation ------------------------- */
function pickEnum(v, ids) {
  return (typeof v === 'string' && ids.includes(v)) ? v : null;
}

function coerceDeliveryAt(iso, now = new Date()) {
  if (typeof iso !== 'string' || !iso) return null;
  const t = new Date(iso);
  if (!Number.isFinite(t.getTime())) return null;
  const hours = (t.getTime() - now.getTime()) / 36e5;
  if (hours < 1 || hours > 60 * 24) return null;
  return t.toISOString();
}

/** Normalise the model's raw extraction into server-validated constraints. */
function normalizeUnderstood(raw = {}) {
  const occasion = pickEnum(raw.occasion, OCCASIONS);
  const people = Number.isInteger(Number(raw.people)) && Number(raw.people) > 0 && Number(raw.people) <= 2000
    ? Number(raw.people) : null;
  const budget = Number.isFinite(Number(raw.budget)) && Number(raw.budget) >= 20 && Number(raw.budget) <= 200000
    ? Math.round(Number(raw.budget)) : null;
  const flavor = pickEnum(raw.flavor, FLAVOR_IDS);
  const design = pickEnum(raw.design, DESIGN_IDS);
  const deliveryMethod = pickEnum(raw.deliveryMethod, DELIVERY_IDS);
  const rush = !!raw.rush;
  const deliveryAt = coerceDeliveryAt(raw.deliveryAt);
  const message = String(raw.message || '').trim().slice(0, 120);
  return { occasion, people, budget, flavor, design, deliveryMethod, rush, deliveryAt, message };
}

function defaultFlavorFor(product) {
  // Map only tags that correspond to VALID flavor ids (lotus is a filling, not a
  // flavour — returning it would make quote() throw BAD_FLAVOR).
  if (product.tags.includes('chocolate')) return 'chocolate';
  if (product.tags.includes('pistachio')) return 'pistachio';
  if (product.tags.includes('mango')) return 'mango';
  return DEFAULTS.flavor;
}

function sizeForPeople(people) {
  if (!people) return null;
  for (const id of SIZE_IDS) if (SIZES[id].serves >= people) return id;
  return 'tier2';
}

/* ------------------------- resolver (server-authoritative) ------------------------- */
function resolveOne(product, u) {
  const size = sizeForPeople(u.people) || 's8';
  const flavor = u.flavor || defaultFlavorFor(product);
  const filling = FLAVOR_FILLING[flavor] || 'cream';
  const design = u.design || OCCASION_DESIGN[u.occasion] || 'classic';
  const deliveryMethod = u.deliveryMethod || (u.rush ? 'delivery' : 'pickup');

  const attempts = [
    { size, design, filling, deliveryMethod },
    { size, design: 'minimal', filling, deliveryMethod },
    { size: 's6', design, filling, deliveryMethod },
    { size: 's6', design: 'minimal', filling, deliveryMethod },
    { size: 's6', design: 'classic', filling: 'cream', deliveryMethod },
    { size: 's6', design: 'classic', filling: 'cream', deliveryMethod: 'pickup' },
  ];

  let fallback = null;
  for (const a of attempts) {
    const cfg = { size: a.size, flavor, filling: a.filling, design: a.design, message: u.message, deliveryMethod: a.deliveryMethod, deliveryAt: u.deliveryAt || null };
    let q;
    try { q = quote(product, cfg, new Date()); } catch { continue; }
    if (!fallback) fallback = { product, config: cfg, price: q };
    if (u.budget == null || q.total <= u.budget) {
      return { product, config: cfg, price: q, withinBudget: u.budget == null ? null : true };
    }
  }
  if (!fallback) return null;
  return { ...fallback, withinBudget: u.budget == null ? null : false };
}

function toSuggestion(solved, u) {
  const q = solved.price;
  const unitPrice = q.cakeSubtotal + q.rushFee;
  // A single cake serves `serves`. For larger parties, scale quantity (capped at 20).
  const quantity = u.people && q.serves > 0 ? Math.min(20, Math.max(1, Math.ceil(u.people / q.serves))) : 1;
  const lt = lineTotals(unitPrice, q.deliveryFee, quantity);
  return {
    productId: solved.product.id,
    productSlug: solved.product.slug,
    name: solved.product.name,
    image: solved.product.image,
    category: solved.product.category,
    config: q.config,
    quantity: lt.quantity,
    unitPrice: lt.unitPrice,
    deliveryFee: lt.delivery,
    price: lt.total,
    breakdown: q.breakdown,
    withinBudget: solved.withinBudget,
    serves: q.serves,
    totalServes: q.serves * lt.quantity,
    cart: { productId: solved.product.id, config: q.config, quantity: lt.quantity },
  };
}

function rankSuggestions(solvedList, u) {
  const scored = solvedList
    .filter((s) => s && s.product && s.price)
    .map((s) => {
    let score = 0;
    if (u.occasion && s.product.tags.includes(u.occasion)) score += 3;
    if (u.flavor && s.config.flavor === u.flavor) score += 2;
    if (s.product.popular) score += 0.75;
    if (u.people && s.price.serves >= u.people) score += 1;
    if (s.withinBudget === true) score += 2;
    else if (s.withinBudget === false) score -= 4;
    if (u.budget) score += Math.min(s.price.total / u.budget, 1) * 1.5;
    return { ...s, score };
  });
  scored.sort((a, b) => b.score - a.score || a.price.total - b.price.total);
  return scored;
}

/** Pick candidate products: model ids first (validated), then tag matches. */
function candidateProducts(modelIds) {
  const byId = {};
  for (const id of (Array.isArray(modelIds) ? modelIds : [])) {
    if (typeof id !== 'string') continue;
    const p = PRODUCTS.find((x) => x.id === id);
    if (p) byId[p.id] = p;
  }
  return Object.values(byId);
}

/* ------------------------- reply composer ------------------------- */
const num = (n, lang) => new Intl.NumberFormat(lang === 'ar' ? 'ar-SA' : 'en-US').format(n);

function composeReply(result, u, llmReply, llmNotes, lang) {
  const l = lang === 'en' ? 'en' : 'ar';
  const parts = [];
  if (llmReply?.[l]) parts.push(llmReply[l]);
  if (result.impossible) {
    if (llmNotes?.[l]) parts.push(llmNotes[l]);
    if (result.alternatives.length) {
      const a = result.alternatives[0];
      parts.push(l === 'ar'
        ? `أقرب خيار متاح هو «${a.name.ar}» بـ ${num(a.price, l)} ريال`
        : `the closest real option is "${a.name.en}" at ${num(a.price, l)} SAR`);
    }
  } else if (u.budget) {
    const fits = result.suggestions.filter((s) => s.withinBudget !== false);
    if (fits.length) {
      parts.push(l === 'ar'
        ? `${num(fits.length, l)} خياراً ضمن ميزانية ${num(u.budget, l)} ريال`
        : `${fits.length} option(s) within your ${num(u.budget, l)} SAR budget`);
    } else {
      parts.push(l === 'ar'
        ? `كل الخيارات تتجاوز ميزانية ${num(u.budget, l)} ريال؛ أقربها ${num(result.suggestions[0]?.price ?? 0, l)} ريال`
        : `every option exceeds your ${num(u.budget, l)} SAR budget; the closest is ${num(result.suggestions[0]?.price ?? 0, l)} SAR`);
    }
  }
  return parts.filter(Boolean).join(' ');
}

/* ------------------------- entry point ------------------------- */
export async function design(message, { history = [], lang } = {}) {
  if (!aiAvailable()) {
    // Graceful degradation to the rule-based assistant.
    const constraints = parse(message).constraints;
    const result = suggest(PRODUCTS, constraints, 3);
    return {
      engine: 'rule-based-nlu-v1', fallback: true, model: null,
      understood: constraints,
      suggestions: result.suggestions,
      impossible: false, needsClarification: false, questions: [],
      reply: { ar: `(بدون نموذج لغوي) ${result.suggestions.map((s) => `${s.name.ar} ${num(s.price, 'ar')} ر.س`).join(' · ')}`, en: `(no LLM) ${result.suggestions.map((s) => `${s.name.en} ${num(s.price, 'en')} SAR`).join(' · ')}` },
    };
  }

  const text = String(message || '').slice(0, MAX_MESSAGE).trim();
  const historyMsgs = (Array.isArray(history) ? history : [])
    .slice(-MAX_HISTORY)
    .filter((m) => m && typeof m.content === 'string' && ['user', 'assistant'].includes(m.role))
    .map((m) => ({ role: m.role, content: String(m.content).slice(0, MAX_MESSAGE) }));

  const messages = [
    { role: 'system', content: systemPrompt() },
    ...historyMsgs,
    { role: 'user', content: text },
  ];

  const raw = await callLLM(messages);
  let parsed;
  try {
    parsed = parseJsonObject(raw);
  } catch (err) {
    console.error('[ai-raw]', String(raw).slice(0, 1500));
    throw err;
  }

  const questions = (Array.isArray(parsed.clarifyingQuestions) ? parsed.clarifyingQuestions : [])
    .slice(0, 3)
    .map((q) => ({ ar: String(q?.ar || '').slice(0, 140), en: String(q?.en || '').slice(0, 140) }))
    .filter((q) => q.ar || q.en);

  const u = normalizeUnderstood(parsed.understood || {});
  const modelIds = Array.isArray(parsed.productIds) ? parsed.productIds : [];
  const isVague = !u.occasion && !u.flavor && !u.people && !u.budget;

  let suggestions = [];
  let alternatives = [];

  // Server-side "cannot fulfil" guards, independent of the model's judgement:
  //   - a dietary requirement the catalog has no option for (vegan / sugar-free)
  //   - (budget handled below, once we know nothing fits)
  const wants = parse(text).wants;
  let impossible = !!parsed.impossible || !!(wants.vegan || wants.sugarFree);

  if (!impossible && !isVague) {
    // Start from the model's picks, enriched with tag matches so the customer
    // sees real alternatives instead of a single answer.
    const list = [...candidateProducts(modelIds)];
    if (list.length < 3 && (u.occasion || u.flavor)) {
      for (const p of PRODUCTS) {
        if (list.includes(p)) continue;
        if ((u.occasion && p.tags.includes(u.occasion)) || (u.flavor && p.tags.includes(u.flavor))) {
          list.push(p);
          if (list.length >= 3) break;
        }
      }
    }
    const solved = (list.length ? list : PRODUCTS).map((p) => resolveOne(p, u));
    const ranked = rankSuggestions(solved, u);
    const fitting = ranked.filter((r) => r.withinBudget !== false).slice(0, 3);
    const chosen = fitting.length ? fitting : ranked.slice(0, 3);
    suggestions = chosen.map((s) => toSuggestion(s, u));
    // Budget below every legal product -> "cannot fulfil", show the nearest.
    if (u.budget != null && !fitting.length) impossible = true;
  }

  if (impossible) {
    const relaxed = { ...u, budget: null };
    const allSolved = rankSuggestions(PRODUCTS.map((p) => resolveOne(p, relaxed)), relaxed);
    alternatives = allSolved.slice(0, 3).map((s) => toSuggestion(s, u));
    suggestions = [];
  }

  const needsClarification = questions.length > 0 && suggestions.length === 0 && !impossible;

  return {
    engine: `llm-${DEEPSEEK_MODEL}`, fallback: false, model: DEEPSEEK_MODEL,
    understood: u,
    needsClarification,
    questions,
    suggestions,
    impossible,
    alternatives,
    reply: {
      ar: composeReply({ suggestions, impossible, alternatives }, u, parsed.reply, parsed.notes, 'ar'),
      en: composeReply({ suggestions, impossible, alternatives }, u, parsed.reply, parsed.notes, 'en'),
    },
  };
}
