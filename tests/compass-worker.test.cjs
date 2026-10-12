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
    const brochure = await request('brochure', { planId: '5000-hsa' });
    assert.notEqual(brochure.openKind, 'none');
    assert.ok(brochure.path ? fs.existsSync(brochure.path) : brochure.pdfUrl?.startsWith('https://'));
    await assert.rejects(request('chat', { message: 'Monthly premium for age 35 employee and spouse', planId: 'uhc-gr-triterm-5000' }), /individual-only/);
    await assert.rejects(request('chat', { message: 'Premium?', planId: 'nonexistent-plan' }), /no longer in Quotes Compass/);
  } finally { child.kill(); }
});
