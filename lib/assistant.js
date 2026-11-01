/**
 * Cake Genius "smart assistant".
 *
 * IMPORTANT / honest design note: this build has no access to an external LLM
 * API from the server, so the assistant is a deterministic natural-language
 * understanding layer (AR + EN keyword/entity extraction) driving the same
 * pricing engine as checkout. It never invents a price: every number it returns
 * comes from lib/pricing.js `quote()`.
 *
 * Pipeline: parse(text) -> constraints -> solver picks size/flavour/design per
 * product -> quote() gives the real price -> rank by constraint fit.
 */
import { quote, SIZES, DEFAULTS } from './pricing.js';

const AR_DIGITS = { '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9' };

function normalize(text) {
  return String(text || '')
    .replace(/[٠-٩]/g, (d) => AR_DIGITS[d])
    .replace(/[\u061c\u200e\u200f]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const OCCASIONS = {
  wedding: ['عرس', 'زواج', 'خطوبه', 'زفاف', 'wedding', 'bride', 'engagement'],
  birthday: ['عيد ميلاد', 'ميلاد', 'عيدميلاد', 'birthday', 'bday', 'born'],
  kids: ['اطفال', 'طفل', 'ولد', 'بنت', 'kids', 'kid', 'child', 'children'],
  corporate: ['شركه', 'شركات', 'مكتب', 'عمل', 'corporate', 'office', 'company', 'staff'],
  anniversary: ['ذكري', 'سنويه', 'anniversary'],
};

const FLAVOR_WORDS = {
  chocolate: ['شوكولاته', 'شكولاته', 'chocolate', 'choco'],
  pistachio: ['فستق', 'pistachio'],
  mango: ['مانجو', 'مانجا', 'mango'],
  redvelvet: ['ريد فيلفيت', 'red velvet', 'redvelvet'],
  lotus: ['لوتس', 'lotus', 'biscoff'],
  vanilla: ['فانيلا', 'vanilla'],
};

const BUDGET_WORDS = ['ميزانيه', 'ميزانيتي', 'ميزانيتنا', 'budget', 'budjet'];
const PEOPLE_UNITS = ['شخص', 'اشخاص', 'ضيوف', 'افراد', 'شخصا', 'قطعه', 'قطع', 'person', 'people', 'guest', 'pax', 'adult', 'kid', 'child'];

/** Numbers that could be money: skips counts of people/pieces that follow a digit. */
function parseMoneyCandidates(text) {
  const out = [];
  const re = /(\d[\d,]{1,5})\s*([^\s]{0,12})?/g;
  let m;
  while ((m = re.exec(text))) {
    const value = Number(m[1].replace(/,/g, ''));
    const trailing = normalize(m[2] || '');
    if (PEOPLE_UNITS.some((u) => trailing.startsWith(normalize(u)))) continue;
    if (Number.isFinite(value) && value >= 20 && value <= 20000) {
      out.push({ value, index: m.index, end: m.index + m[0].length, trailing });
    }
  }
  return out;
}

export function parse(text) {
  const raw = String(text || '');
  const t = normalize(raw);
  const result = { raw, text: t, lang: /[\u0600-\u06ff]/.test(raw) ? 'ar' : 'en', constraints: {} };

  // Budget resolution order:
  //  1. a number that follows a budget word ("ميزانية 350") within a short window
  //  2. a number carrying a currency word ("350 ريال", "350 SAR")
  //  3. the number closest to a budget/limit word
  //  4. the largest money-like number in the sentence
  const nums = parseMoneyCandidates(t);
  const budgetIdx = BUDGET_WORDS.map((w) => t.indexOf(w)).filter((i) => i >= 0);
  const limitIdx = [t.indexOf('تحت'), t.indexOf('اقل من'), t.indexOf('under'), t.indexOf('within')].filter((i) => i >= 0);
  const anchors = [...budgetIdx, ...limitIdx];

  let budget = null;
  if (nums.length) {
    const afterBudget = nums.filter((n) => budgetIdx.some((b) => n.index > b && n.index - b <= 14));
    const withCurrency = nums.filter((n) => /^(ريال|ر\.س|sar|sr|درهم|aed|\$)/.test(n.trailing));
    if (afterBudget.length) {
      budget = afterBudget[0].value;
    } else if (withCurrency.length) {
      budget = withCurrency[withCurrency.length - 1].value;
    } else if (anchors.length) {
      let best = null;
      for (const n of nums) {
        const d = Math.min(...anchors.map((a) => Math.abs(n.index - a)));
        if (!best || d < best.d) best = { ...n, d };
      }
      budget = best.value;
    } else {
      budget = nums.reduce((a, b) => (b.value > a.value ? b : a)).value;
    }
  }
  if (/ميزانيه مفتوحه|open budget|no budget/.test(t)) budget = null;
  result.constraints.budget = budget;

  // people / servings
  const peopleRe = /(\d{1,3})\s*(?:اشخاص|اشخاص|شخص|ضيوف|افراد|شخصا|persons?|people|guests?|pax|adults?|kids?)/;
  const people = t.match(peopleRe);
  result.constraints.people = people ? Number(people[1]) : null;

  // occasion
  result.constraints.occasion = null;
  for (const [key, words] of Object.entries(OCCASIONS)) {
    if (words.some((w) => t.includes(normalize(w)))) { result.constraints.occasion = key; break; }
  }

  // flavour
  result.constraints.flavor = null;
  for (const [key, words] of Object.entries(FLAVOR_WORDS)) {
    if (words.some((w) => t.includes(normalize(w)))) { result.constraints.flavor = key; break; }
  }

  // urgency
  result.constraints.rush = /بكرا|غدا|اليوم|بسرعه|مستعجل|today|tomorrow|urgent|asap|tonight/.test(t);

  // design hints
  if (/صوره|صورتي|photo|picture/.test(t)) result.constraints.design = 'photo';
  else if (/ورد|زهور|flowers?|roses?/.test(t)) result.constraints.design = 'floral';
  else if (/مينيمال|بسيط|minimal|simple/.test(t)) result.constraints.design = 'minimal';
  else if (/ثيم|شخصيه|themed|custom design/.test(t)) result.constraints.design = 'themed';

  result.wants = {
    vegan: /vegan|نباتي/.test(t),
    sugarFree: /sugar.?free|بدون سكر/.test(t),
  };
  return result;
}

const OCCASION_DESIGN = { wedding: 'floral', kids: 'themed', corporate: 'photo', birthday: 'minimal', anniversary: 'floral' };
const FLAVOR_FILLING = { chocolate: 'ganache', lotus: 'lotus', mango: 'fruit', pistachio: 'ganache', redvelvet: 'cream', vanilla: 'cream' };

function sizeFor(people, budget, product) {
  const order = ['s6', 's8', 's10', 'tier2'];
  if (people) {
    for (const id of order) {
      if (SIZES[id].serves >= people) return id;
    }
    return 'tier2';
  }
  if (budget) {
    // largest size that still leaves room for a decent design within budget
    for (let i = order.length - 1; i >= 0; i--) {
      const id = order[i];
      const test = quote(product, { size: id, design: 'classic' }, new Date());
      if (test.total <= budget) return id;
    }
    return 's6';
  }
  return 's8';
}

/**
 * Build one concrete, priced configuration for a product under the constraints.
 * Returns null when no configuration fits the budget at all.
 */
export function solveForProduct(product, constraints) {
  const budget = constraints.budget;
  const size = sizeFor(constraints.people, budget, product);
  const flavor = constraints.flavor && ['vanilla', 'chocolate', 'redvelvet', 'pistachio', 'mango'].includes(constraints.flavor)
    ? constraints.flavor
    : (product.tags.includes('chocolate') ? 'chocolate' : product.tags.includes('pistachio') ? 'pistachio' : DEFAULTS.flavor);
  const filling = FLAVOR_FILLING[flavor] || 'cream';
  const preferredDesign = constraints.design || OCCASION_DESIGN[constraints.occasion] || 'classic';

  const attempts = [
    { design: preferredDesign, size },
    { design: preferredDesign, size: 's6' },
    { design: 'minimal', size },
    { design: 'classic', size },
    { design: 'classic', size: 's6' },
  ];

  let fallback = null;
  for (const attempt of attempts) {
    const cfg = {
      size: attempt.size,
      flavor,
      filling: attempt.design === 'classic' ? 'cream' : filling,
      design: attempt.design,
      message: '',
      deliveryMethod: constraints.rush ? 'delivery' : 'pickup',
    };
    let q;
    try {
      q = quote(product, cfg, new Date());
    } catch {
      continue;
    }
    if (!fallback) fallback = { product, config: cfg, price: q };
    if (budget == null || q.total <= budget) {
      return { product, config: cfg, price: q, withinBudget: budget == null ? null : true };
    }
  }
  if (fallback && budget != null) {
    return { ...fallback, withinBudget: false };
  }
  return null;
}

export function suggest(products, constraints, limit = 3) {
  const candidates = [];
  for (const p of products) {
    const solved = solveForProduct(p, constraints);
    if (!solved) continue;
    let score = 0;
    if (constraints.occasion && p.tags.includes(constraints.occasion)) score += 3;
    if (constraints.flavor && (p.tags.includes(constraints.flavor) || solved.config.flavor === constraints.flavor)) score += 2;
    if (p.popular) score += 0.75;
    if (constraints.people && solved.price.serves >= constraints.people) score += 1;
    if (solved.withinBudget === true) score += 2;
    else if (solved.withinBudget === false) score -= 4;
    if (constraints.budget) {
      const usage = solved.price.total / constraints.budget;
      score += Math.min(usage, 1) * 1.5;
    }
    candidates.push({ ...solved, score: Math.round(score * 100) / 100 });
  }
  candidates.sort((a, b) => b.score - a.score || a.price.total - b.price.total);

  const fitting = candidates.filter((c) => c.withinBudget !== false).slice(0, limit);
  const chosen = fitting.length ? fitting : candidates.slice(0, limit);
  return {
    constraints,
    suggestions: chosen.map((c) => ({
      productId: c.product.id,
      productSlug: c.product.slug,
      name: c.product.name,
      image: c.product.image,
      category: c.product.category,
      config: c.config,
      price: c.price.total,
      breakdown: c.price.breakdown,
      withinBudget: c.withinBudget,
      serves: c.price.serves,
      score: c.score,
      reason: reasonFor(c, constraints),
    })),
    cheapestSeen: candidates.length ? Math.min(...candidates.map((c) => c.price.total)) : null,
  };
}

function reasonFor(c, k) {
  const bits = [];
  if (k.occasion) bits.push({ ar: `مناسب لمناسبة ${occasionLabel(k.occasion, 'ar')}`, en: `fits a ${occasionLabel(k.occasion, 'en')}` });
  if (k.people) bits.push({ ar: `يكفي ${c.price.serves} شخصاً`, en: `serves ${c.price.serves}` });
  if (k.flavor) bits.push({ ar: `بنكهة ${flavorLabel(k.flavor, 'ar')}`, en: `${flavorLabel(k.flavor, 'en')} flavour` });
  if (c.withinBudget) bits.push({ ar: 'داخل ميزانيتك', en: 'inside your budget' });
  return {
    ar: bits.map((b) => b.ar).join('، ') || 'خيار متوازن',
    en: bits.map((b) => b.en).join(', ') || 'a balanced pick',
  };
}

function occasionLabel(id, lang) {
  return {
    wedding: { ar: 'الزواج', en: 'wedding' },
    birthday: { ar: 'عيد الميلاد', en: 'birthday' },
    kids: { ar: 'الأطفال', en: 'kids party' },
    corporate: { ar: 'الشركات', en: 'corporate order' },
    anniversary: { ar: 'الذكرى السنوية', en: 'anniversary' },
  }[id]?.[lang] || id;
}

function flavorLabel(id, lang) {
  return {
    vanilla: { ar: 'فانيلا', en: 'vanilla' },
    chocolate: { ar: 'شوكولاتة', en: 'chocolate' },
    redvelvet: { ar: 'ريد فيلفيت', en: 'red velvet' },
    pistachio: { ar: 'فستق', en: 'pistachio' },
    mango: { ar: 'مانجو', en: 'mango' },
    lotus: { ar: 'لوتس', en: 'lotus' },
  }[id]?.[lang] || id;
}

export function buildReply(suggestions, constraints, lang = 'ar') {
  const ar = [];
  const en = [];
  const num = (n) => new Intl.NumberFormat('ar-SA').format(n);
  const count = (n) => {
    if (n === 1) return 'خيار واحد';
    if (n === 2) return 'خيارين';
    if (n <= 10) return `${num(n)} خيارات`;
    return `${num(n)} خياراً`;
  };
  if (!suggestions.length) {
    return {
      ar: 'ما لقيت خياراً مطابقاً. جرّب ميزانية أعلى قليلاً أو حدّد المناسبة.',
      en: 'No match found. Try a slightly higher budget or name the occasion.',
    };
  }
  const top = suggestions[0];
  if (constraints.budget) {
    ar.push(`لقيت لك ${count(suggestions.length)} ضمن ميزانية ${num(constraints.budget)} ريال`);
    en.push(`I found ${suggestions.length} option(s) within your ${constraints.budget} SAR budget`);
  } else {
    ar.push(`اخترت لك ${count(suggestions.length)} على حسب طلبك`);
    en.push(`Here are ${suggestions.length} option(s) based on your request`);
  }
  if (constraints.occasion) {
    ar.push(`لمناسبة ${occasionLabel(constraints.occasion, 'ar')}`);
    en.push(`for a ${occasionLabel(constraints.occasion, 'en')}`);
  }
  if (top.withinBudget === false && constraints.budget) {
    ar.push('كلها تتجاوز الميزانية قليلاً، وأقربها الخيار الأول');
    en.push('all of them slightly exceed the budget; the first one is the closest');
  }
  return { ar: ar.join('، ') + '.', en: en.join(', ') + '.' };
}
