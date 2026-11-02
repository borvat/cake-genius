/**
 * Unit tests for the AI consumption guard (lib/ai-assistant.js): rate limit,
 * concurrency semaphore, and token cap config. No network, no LLM, deterministic.
 */
import {
  aiGuardConfig, checkAiRateLimit, acquireAiSlot, releaseAiSlot, aiConcurrencyFull,
} from '../lib/ai-assistant.js';

let pass = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { failures.push(name); console.log(`FAIL  ${name}${detail ? '  -> ' + detail : ''}`); }
}

const cfg = aiGuardConfig();
check('guard config exposes rate / concurrency / token caps',
  cfg.rate.max > 0 && cfg.concurrency.max > 0 && cfg.tokens.maxOutputPerRequest > 0,
  JSON.stringify(cfg));

const max = cfg.rate.max;
for (let i = 0; i < max; i++) {
  if (!checkAiRateLimit('10.0.0.1').allowed) { check(`request ${i + 1} of ${max} allowed`, false); break; }
}
const blocked = checkAiRateLimit('10.0.0.1');
check(`request ${max + 1} from the same IP is rate-limited`, blocked.allowed === false && blocked.retryAfterSeconds >= 1, JSON.stringify(blocked));
check('a different IP is unaffected by another IP\'s limit', checkAiRateLimit('10.0.0.2').allowed === true);

// concurrency semaphore
const conc = cfg.concurrency.max;
const held = [];
for (let i = 0; i < conc; i++) held.push(acquireAiSlot());
check(`acquires up to ${conc} concurrent slots`, held.every(Boolean));
check(`slot ${conc + 1} is refused while saturated`, acquireAiSlot() === false);
releaseAiSlot();
check('releasing a slot frees capacity', acquireAiSlot() === true);
while (aiConcurrencyFull()) releaseAiSlot();

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) { console.log('FAILED:', failures.join(' | ')); process.exit(1); }
