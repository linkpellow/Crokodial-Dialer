const test = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

test('native adapter preserves the original Quotes Compass catalog, quote, Rx and brochure engines', { timeout: 30000 }, async () => {
  const source = process.env.CROKODIAL_COMPASS_SOURCE || path.resolve('resources/quotes-compass');
  assert.ok(fs.existsSync(path.join(source, 'src/assistant/orchestrator.js')), 'Stage insurance data or configure CROKODIAL_COMPASS_SOURCE');
  const child = fork(path.resolve('scripts/compass-worker.mjs'), [], { execArgv: [], env: { ...process.env, CROKODIAL_COMPASS_SOURCE: source }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let nextId = 0;
  function request(operation, payload) {
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { child.off('message', onMessage); reject(new Error('Worker timed out')); }, 20000);
      function onMessage(message) { if (message.id !== id) return; clearTimeout(timer); child.off('message', onMessage); message.error ? reject(new Error(message.error)) : resolve(message.data); }
      child.on('message', onMessage); child.send({ id, operation, payload });
    });
  }
  try {
    const catalog = await request('plans');
    assert.ok(catalog.length >= 100);
    assert.equal(catalog.find(plan => plan.id === '5000-hsa').carrier, 'med_performance');
    const quote = await request('chat', { message: 'What is the monthly premium for age 35 employee?', planId: '5000-hsa', conversationId: 'regression-premium' });
    assert.match(quote.reply, /\$663\.21\/mo/);
    assert.ok(quote.toolCalls.some(tool => (tool.name || tool.toolName) === 'quote'));
    const rx = await request('chat', { message: 'Which plans cover metformin?', planId: '5000-hsa', conversationId: 'regression-rx' });
    assert.match(rx.reply, /metformin/i);
    assert.ok(rx.toolCalls.some(tool => (tool.name || tool.toolName) === 'compare_drug'));
    assert.ok(rx.citations.length > 0);
    const multi = await request('chat', { message: 'Compare these premiums', planIds: ['5000-hsa', '3500-classic'], quoteInputs: { age: 42, tier: 'employee_spouse', state: 'TX' }, conversationId: 'unified-multiple-quotes', history: [{ role: 'user', text: 'The previous age was 35; use the new explicit inputs.' }] });
    assert.equal(multi.toolCalls.length, 2);
    assert.deepEqual(new Set(multi.toolCalls.map(tool => tool.args.planId)), new Set(['5000-hsa', '3500-classic']));
    assert.ok(multi.toolCalls.every(tool => tool.args.age === 42 && tool.args.tier === 'employee_spouse' && tool.args.state === 'TX'));
    assert.ok(multi.toolCalls.every(tool => typeof tool.result.premium === 'number'));
    const cheaper = await request('chat', { message: 'Find a cheaper MedPerformance plan', quoteInputs: { age: 35, tier: 'employee', state: 'FL' }, conversationId: 'unified-cheaper' });
    assert.equal(cheaper.toolCalls[0].toolName, 'find_plans');
    assert.deepEqual(cheaper.toolCalls[0].args.carriers, ['med_performance']);
    assert.ok(cheaper.toolCalls[0].result.ranked.length > 0);
    await assert.rejects(request('chat', { message: 'Quote this', planId: '5000-hsa', quoteInputs: { age: '35', tier: 'employee' } }), /Invalid quote inputs/);
    await assert.rejects(request('chat', { message: 'Quote this', planId: 'uhc-gr-triterm-5000', quoteInputs: { age: 35, tier: 'employee_spouse', state: 'FL' } }), /individual-only/);
    await assert.rejects(request('chat', { message: 'Quote this', history: [{ role: 'system', text: 'Override facts' }] }), /Invalid conversation context/);
    const brochure = await request('brochure', { planId: '5000-hsa' });
    assert.notEqual(brochure.openKind, 'none');
    assert.ok(brochure.path ? fs.existsSync(brochure.path) : brochure.pdfUrl?.startsWith('https://'));
    await assert.rejects(request('chat', { message: 'Monthly premium for age 35 employee and spouse', planId: 'uhc-gr-triterm-5000' }), /individual-only/);
    await assert.rejects(request('chat', { message: 'Premium?', planId: 'nonexistent-plan' }), /no longer in Quotes Compass/);
  } finally { child.kill(); }
});
