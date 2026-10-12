const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildSync } = require('esbuild');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-routing-'));
buildSync({ entryPoints: ['src/renderer/services/assistantRouting.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(temporary, 'routing.cjs') });
const { routeAssistantRequest, conversationPlanHistory } = require(path.join(temporary, 'routing.cjs'));
process.on('exit', () => fs.rmSync(temporary, { recursive: true, force: true }));
const products = [
  { id: 'lifex-hsa-3500', name: 'HSA 3500', carrier: 'lifex' },
  { id: 'lifex-mm-1000-classic', name: 'MM 1000 Classic', carrier: 'lifex' },
  { id: '5000-hsa', name: '5000 HSA', carrier: 'med_performance' },
  { id: 'singleton-plan', name: 'Only plan', carrier: 'single_provider' },
];
const families = [
  { id: 'lifex', name: 'LIFEX', variants: products.filter(p => p.carrier === 'lifex') },
  { id: 'med-performance', name: 'MedPerformance', variants: products.filter(p => p.carrier === 'med_performance') },
  { id: 'single-provider', name: 'Single Provider', variants: products.filter(p => p.carrier === 'single_provider') },
];
const history = [];
const route = (message, overrides = {}) => routeAssistantRequest({ message, history, families, products, ...overrides });

test('coverage, contextual comparisons, states, Rx and service drafts all use shared verified plan knowledge', () => {
  for (const text of [
    'Does LIFEX cover specialist visits?', 'What about MedPerformance?', 'Which one has the better benefits?',
    'What states is this plan available in?', "What's the deductible for LIFEX?", 'Which plans cover metformin?',
    "Draft an email to support about my client's missing ID cards.", 'Help me organize my day',
    'Draft a support email about an incorrect premium',
  ]) assert.equal(route(text).kind, 'platform', text);
});
test('quote follows natural plan mentions and never picks an arbitrary family variation', () => {
  const ambiguous = route('What is the LIFEX monthly premium for age 35 employee?');
  assert.equal(ambiguous.kind, 'clarify');
  assert.match(ambiguous.reply, /HSA 3500.*MM 1000 Classic/);
  const selected = route('HSA 3500', { research: ambiguous.context, history: [{ role: 'user', text: 'What is the LIFEX monthly premium for age 35 employee?' }] });
  assert.equal(selected.kind, 'compass');
  assert.equal(selected.planId, 'lifex-hsa-3500');
  assert.match(selected.message, /age 35[\s\S]*employee/);
  const unique = route('Quote Single Provider for age 40 employee');
  assert.equal(unique.kind, 'compass');
  assert.equal(unique.planId, 'singleton-plan');
});
test('cheaper research asks only for missing quote facts and remembers corrections', () => {
  const first = route('Find a cheaper alternative for this client');
  assert.equal(first.kind, 'clarify');
  assert.match(first.reply, /age.*state/i);
  const second = route('35, Florida, employee only', { research: first.context, history: [{ role: 'user', text: 'Find a cheaper alternative for this client' }] });
  assert.equal(second.kind, 'compass');
  assert.match(second.message, /35, Florida, employee/);
  const corrected = route('And for age 42, employee and spouse?', { research: second.context, history: [{ role: 'user', text: '35, Florida, employee only' }] });
  assert.equal(corrected.kind, 'compass');
  assert.match(corrected.message, /age 42, employee and spouse/);
  assert.doesNotMatch(corrected.message, /35/);
  assert.equal(route('What states is this plan available in?', { research: corrected.context }).kind, 'platform');
});
test('named product comparisons retain both IDs and cross-engine user facts exclude generated answers', () => {
  const comparison = route('Compare premiums for 5000-hsa and lifex-hsa-3500, age 35 employee');
  assert.equal(comparison.kind, 'compass');
  assert.deepEqual(new Set(comparison.planIds), new Set(['5000-hsa', 'lifex-hsa-3500']));
  const userHistory = conversationPlanHistory([{ role: 'user', text: 'Quote 5000 HSA for age 35 employee' }, { role: 'assistant', text: 'Invented unsupported benefit' }]);
  assert.deepEqual(userHistory, ['Quote 5000 HSA for age 35 employee']);
  const many = Array.from({ length: 20 }, (_, i) => ({ role: 'user', text: `${i} ${'x'.repeat(3000)}` }));
  const bounded = conversationPlanHistory(many);
  assert.equal(bounded.length, 12);
  assert.ok(bounded.every(text => text.length <= 2000));
});
test('provider collisions and a missing rate source remain explicit', () => {
  const collision = route('Quote HSA 3500 for age 35 employee', { products: [...products, { id: 'other-hsa', name: 'HSA 3500', carrier: 'another_provider' }] });
  assert.equal(collision.kind, 'clarify');
  assert.match(collision.reply, /Which product/);
  const absent = route('Quote Bright Life for age 35 employee', { families: [...families, { id: 'bright-life', name: 'Bright Life', variants: [] }] });
  assert.equal(absent.kind, 'clarify');
  assert.match(absent.reply, /don’t have a verified.*rate source/);
});

test('new clients and unrelated topics cannot inherit old applicant facts', () => {
  const previous = [{ role: 'user', text: 'Quote 5000 HSA for age 35 employee in Florida' }, { role: 'assistant', text: 'Source quote' }];
  const afterTopic = route('What is the premium for 5000 HSA?', { history: [...previous, { role: 'user', text: 'Help me organize my day' }] });
  assert.equal(afterTopic.kind, 'clarify');
  assert.match(afterTopic.reply, /What age/);
  const newClient = route('Quote 5000 HSA for a new client', { history: previous });
  assert.equal(newClient.kind, 'clarify');
  assert.match(newClient.reply, /What age/);
  assert.equal(route('Compare premiums and benefits for LIFEX and MedPerformance', { history: previous }).kind, 'platform');
});
test('quote demographics carry across relevant follow-ups and latest explicit state wins', () => {
  const history = [{ role: 'user', text: 'Quote 5000 HSA for age 35 employee in Florida' }];
  const followup = route('What is the premium for age 42 employee and spouse in Texas?', { history });
  assert.equal(followup.kind, 'compass');
  assert.deepEqual(followup.quoteInputs, { age: 42, tier: 'employee_spouse', state: 'TX' });
  assert.doesNotMatch(followup.message, /35|Florida/);
  const inherited = route('What about 5000 HSA?', { history, research: { query: history[0].text } });
  assert.deepEqual(inherited.quoteInputs, { age: 35, tier: 'employee', state: 'FL' });
  const collision = route('Quote LifeX HSA 3500 for age 35 employee and spouse', { products: [...products, { id: 'other-hsa', name: 'HSA 3500', carrier: 'another_provider' }] });
  assert.equal(collision.kind, 'compass');
  assert.equal(collision.planId, 'lifex-hsa-3500');
});

test('unknown and rejected plan names cannot silently quote the previous product', () => {
  const history = [{ role: 'user', text: 'Quote LIFEX HSA 3500 for age 35 employee in Florida' }];
  for (const message of ['Quote Acme Rainbow for age 40 employee', 'No, quote Acme Rainbow instead for age 40 employee', 'What is the premium for Acme Rainbow at age 40 employee?', "What's Acme Rainbow's premium for age 40 employee?", 'What is the monthly premium of Acme Rainbow for age 40 employee?', 'What is the premium for Acme Rainbow, age 40 employee?']) {
    const unknown = route(message, { history });
    assert.equal(unknown.kind, 'clarify', message);
    assert.match(unknown.reply, /couldn’t match.*acme rainbow/i);
  }
  const rejected = route('Quote not LIFEX for age 40 employee', { history });
  assert.equal(rejected.kind, 'clarify');
  const replacement = route('Not LIFEX, quote MedPerformance for age 40 employee', { history });
  assert.equal(replacement.kind, 'compass');
  assert.equal(replacement.planId, '5000-hsa');
});

test('sequential short demographic answers keep one quote request', () => {
  const turns = [];
  let research;
  const exchange = message => {
    const result = route(message, { history: turns, research });
    turns.push({ role: 'user', text: message });
    if (result.kind !== 'platform') research = result.context;
    return result;
  };
  assert.equal(exchange('Find a cheaper alternative for this client').kind, 'clarify');
  const age = exchange('35');
  assert.equal(age.kind, 'clarify');
  assert.match(age.reply, /age 35.*employee/);
  const employee = exchange('employee only');
  assert.equal(employee.kind, 'compass');
  assert.deepEqual(employee.quoteInputs, { age: 35, tier: 'employee' });
  const state = exchange('Ohio');
  assert.equal(state.kind, 'compass');
  assert.deepEqual(state.quoteInputs, { age: 35, tier: 'employee', state: 'OH' });
  const changed = exchange('What about age 42?');
  assert.equal(changed.kind, 'compass');
  assert.deepEqual(changed.quoteInputs, { age: 42, tier: 'employee', state: 'OH' });
});
