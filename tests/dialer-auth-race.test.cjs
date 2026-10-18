const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { buildSync } = require('esbuild');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-auth-race-'));
buildSync({ entryPoints: ['src/renderer/services/dialerApiService.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(directory, 'api.cjs'), define: { 'import.meta.env.VITE_API_BASE': '"https://fixture.invalid"' } });
const { authenticatedFetch, UNAUTHORIZED_EVENT, REQUIRES_TENANT_EVENT } = require(path.join(directory, 'api.cjs'));
after(() => fs.rmSync(directory, { recursive: true, force: true }));

const tokenKey = 'crokodial_auth_token', userKey = 'crokodial_auth_user';
const owner = { id: 11, tenant_id: 9, name: 'TEST owner' };
const serialized = status => ({ status, statusText: 'Test', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: { code: 'UNAUTHORIZED' } }) });
function fixture(apiFetch) {
  const values = new Map([[tokenKey, 'TEST original token'], [userKey, JSON.stringify(owner)]]);
  const events = [];
  global.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  global.window = { ...(apiFetch ? { dialer: { apiFetch } } : {}), dispatchEvent: event => events.push({ type: event.type, detail: event.detail }) };
  return { values, events };
}

for (const change of ['replacement account', 'rotated token', 'changed tenant']) {
  test(`late native 401 cannot clear a ${change}`, async () => {
    let release;
    const { values, events } = fixture((_url, options) => {
      assert.equal(options.headers.Authorization, 'Bearer TEST original token');
      return new Promise(resolve => { release = resolve; });
    });
    const pending = authenticatedFetch('https://fixture.invalid/api/ai-agents/7/workspace/activity');
    if (change !== 'changed tenant') values.set(tokenKey, 'TEST replacement token');
    values.set(userKey, JSON.stringify(change === 'replacement account' ? { ...owner, id: 12 } : change === 'changed tenant' ? { ...owner, tenant_id: 10 } : owner));
    const expected = [...values];
    release(serialized(401));
    assert.equal((await pending).status, 401);
    assert.deepEqual([...values], expected);
    assert.deepEqual(events, []);
  });
}

test('a current native 401 still clears the invalid identity and notifies the app', async () => {
  const { values, events } = fixture(async () => serialized(401));
  assert.equal((await authenticatedFetch('https://fixture.invalid/api/auth/me')).status, 401);
  assert.equal(values.size, 0);
  assert.deepEqual(events.map(event => event.type), [UNAUTHORIZED_EVENT]);
});

async function delayedTenantError(changeSession) {
  let release;
  const body = new ReadableStream({ start(controller) { release = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: { code: 'REQUIRES_TENANT', message: 'TEST organization required' } }))); controller.close(); }; } });
  const { values, events } = fixture();
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(body, { status: 403, headers: { 'Content-Type': 'application/json' } });
  try {
    const response = await authenticatedFetch('https://fixture.invalid/api/auth/me');
    assert.equal(response.status, 403);
    if (changeSession) {
      values.set(tokenKey, 'TEST replacement token');
      values.set(userKey, JSON.stringify({ ...owner, id: 12 }));
    }
    const expected = [...values];
    release();
    await response.json();
    // The cloned response is parsed asynchronously after authenticatedFetch returns.
    for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setImmediate(resolve));
    return { values, events, expected };
  } finally { global.fetch = originalFetch; }
}

test('tenant 403 parsed after replacement sign-in cannot clear the new identity or emit onboarding events', async () => {
  const { values, events, expected } = await delayedTenantError(true);
  assert.deepEqual([...values], expected);
  assert.deepEqual(events, []);
});

test('a current tenant 403 still clears the invalid identity and emits the tenant explanation', async () => {
  const { values, events } = await delayedTenantError(false);
  assert.equal(values.size, 0);
  assert.deepEqual(events, [{ type: UNAUTHORIZED_EVENT, detail: null }, { type: REQUIRES_TENANT_EVENT, detail: { message: 'TEST organization required' } }]);
});
