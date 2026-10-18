const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { buildSync } = require('esbuild');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-session-recovery-'));
buildSync({ stdin: { contents: `export * from './src/renderer/services/sessionRecovery'; export * from './src/renderer/services/dialerApiService';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: path.join(directory, 'session.cjs'), define: { 'import.meta.env.VITE_API_BASE': '"https://fixture.invalid"' } });
const { startSessionRecovery, SessionConnectionError, checkAuth, authenticatedFetch } = require(path.join(directory, 'session.cjs'));
after(() => fs.rmSync(directory, { recursive: true, force: true }));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const response = (status, data = {}) => ({ status, statusText: 'Test', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) });
function fixture(fetch) {
  const values = new Map([['crokodial_auth_token', 'test-token'], ['crokodial_auth_user', JSON.stringify({ id: 11, name: 'Synthetic owner' })]]);
  global.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  global.window = { dialer: { apiFetch: fetch }, dispatchEvent() {} };
  return values;
}

test('transient auth failure reconnects automatically without clearing the saved identity', async () => {
  let requests = 0;
  const values = fixture(async () => ++requests === 1 ? response(0) : response(200, { id: 11, name: 'Synthetic owner' }));
  const restored = [], failures = [];
  const recovery = startSessionRecovery({ check: checkAuth, restored: value => restored.push(value), failed: (_, retry) => failures.push(retry), retryDelays: [1] });
  await sleep(30); recovery.cancel();
  assert.equal(requests, 2); assert.deepEqual(restored, [true]); assert.deepEqual(failures, [true]);
  assert.equal(values.get('crokodial_auth_token'), 'test-token');
});
test('outages have a bounded retry budget and an online/focus retry can recover later', async () => {
  let requests = 0, available = false;
  fixture(async () => { requests++; return available ? response(200, { id: 11 }) : response(503); });
  const restored = [], failures = [];
  const recovery = startSessionRecovery({ check: checkAuth, restored: value => restored.push(value), failed: (_, retry) => failures.push(retry), retryDelays: [1, 1] });
  await sleep(30);
  assert.equal(requests, 3); assert.deepEqual(failures, [true, true, false]);
  available = true; recovery.retry(); recovery.retry(); await sleep(10); recovery.cancel();
  assert.equal(requests, 4); assert.deepEqual(restored, [true]);
});
test('an invalid session clears identity once and does not retry', async () => {
  let requests = 0;
  const values = fixture(async () => { requests++; return response(401); });
  const restored = [];
  const recovery = startSessionRecovery({ check: checkAuth, restored: value => restored.push(value), failed: () => assert.fail('401 is not a transport error'), retryDelays: [1] });
  await sleep(10); recovery.retry(); await sleep(10); recovery.cancel();
  assert.equal(requests, 1); assert.deepEqual(restored, [false]); assert.equal(values.has('crokodial_auth_token'), false);
});
test('canceling recovery protects a replacement session from a late 401', async () => {
  let release;
  const values = fixture(() => new Promise(resolve => { release = resolve; }));
  const recovery = startSessionRecovery({ check: checkAuth, restored: () => assert.fail('canceled result'), failed: () => assert.fail('canceled failure') });
  recovery.cancel(); values.set('crokodial_auth_token', 'replacement-session');
  release(response(401)); await sleep(10);
  assert.equal(values.get('crokodial_auth_token'), 'replacement-session');
});
test('configuration failures do not keep retrying when focus or connectivity changes', async () => {
  let requests = 0;
  fixture(async () => { requests++; return { ...response(0), statusText: 'Request is outside the configured Crokodial API.' }; });
  const failures = [];
  const recovery = startSessionRecovery({ check: checkAuth, restored: () => assert.fail('invalid configuration'), failed: (error, retry) => failures.push([error.retryable, retry]), retryDelays: [1] });
  await sleep(10); recovery.retry(); await sleep(10); recovery.cancel();
  assert.equal(requests, 1); assert.deepEqual(failures, [[false, false]]);
});
test('canceling a scheduled retry stops the timer and action requests are never retried', async () => {
  let requests = 0;
  fixture(async () => { requests++; return response(0); });
  const recovery = startSessionRecovery({ check: checkAuth, restored: () => assert.fail('offline'), failed: () => {}, retryDelays: [30] });
  await sleep(5); recovery.cancel(); await sleep(40); assert.equal(requests, 1);
  await assert.rejects(authenticatedFetch('https://fixture.invalid/api/ai-agents/7/test/message', { method: 'POST' }), SessionConnectionError);
  await sleep(10); assert.equal(requests, 2);
});
