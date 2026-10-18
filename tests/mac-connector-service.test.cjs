const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crokodial-mac-service-'));
buildSync({ entryPoints: ['src/renderer/services/macConnectorService.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(directory, 'service.cjs') });
const { macConnectorService } = require(path.join(directory, 'service.cjs'));
after(() => fs.rmSync(directory, { recursive: true, force: true }));
let calls;
beforeEach(() => {
  calls = [];
  global.localStorage = { getItem: key => key === 'crokodial_auth_user' ? JSON.stringify({ id: 9, tenant_id: 7 }) : key === 'crokodial_auth_token' ? 'TEST-token' : null };
  global.window = { dialer: { macConnectors: new Proxy({}, { get: (_target, operation) => async (...args) => { calls.push({ operation, args }); return { operation, args }; } }) } };
});

test('renderer service binds execution to only the opaque reviewed identity and digest', async () => {
  const origin = { conversationKey: 'main:owner:permanent', agentId: 3, sessionId: 'active-session', turnId: 'saved-turn', requestId: 'saved-request', turnText: 'Fixture turn', revision: 1 };
  const authority = { bearerToken: 'TEST-token', agentId: 3, sessionId: 'active-session' };
  const context = { tenantId: 7, userId: 9, conversationKey: 'main:owner:permanent', environment: 'production', lineage: 'c'.repeat(64), agentId: 3, turnId: 'saved-turn', requestId: 'saved-request', turnDigest: 'b'.repeat(64), revision: 1 };
  const review = { id: 'review-id', kind: 'contact.update', digest: 'a'.repeat(64), context, payload: { operation: 'update', contactId: 'contact-id', changes: { firstName: 'Fixture' } }, summary: 'Fixture', createdAt: 1, expiresAt: 2 };
  await macConnectorService.executeContactChange(review, origin);
  assert.deepEqual(calls[0], { operation: 'executeContactChange', args: [{ id: 'review-id', kind: 'contact.update', digest: 'a'.repeat(64), context, authority }] });
  calls = [];
  await macConnectorService.executeMessageSend({ ...review, kind: 'messages.send' }, origin);
  assert.deepEqual(calls[0], { operation: 'executeMessageSend', args: [{ id: 'review-id', kind: 'messages.send', digest: 'a'.repeat(64), context, authority }] });
  calls = [];
  await macConnectorService.reconcileReviewedWrite({ state: 'unknown', message: 'Fixture', reviewId: 'review-id',
    kind: 'messages.send', digest: 'a'.repeat(64), context }, 'not_applied', origin);
  assert.deepEqual(calls[0], { operation: 'reconcileReviewedWrite', args: [{ id: 'review-id', digest: 'a'.repeat(64), context,
    resolution: 'not_applied', authority }] });
  assert.equal('bearerToken' in context, false, 'the transient token is never persisted in the durable context');
});

test('renderer exposes distinct read, review and execute operations without a generic invoke', async () => {
  await macConnectorService.searchContacts('Fixture');
  await macConnectorService.prepareMessageSend('thread-id', 'Exact text', { conversationKey: 'main:owner:permanent', agentId: 3, sessionId: 'active-session', turnId: 'saved-turn', requestId: 'saved-request', turnText: 'Text Fixture saying Exact text', revision: 1 });
  await macConnectorService.prepareSmsDraft('+15550000100', 'Draft text');
  assert.deepEqual(calls, [
    { operation: 'searchContacts', args: ['Fixture'] },
    { operation: 'prepareMessageSend', args: [{ threadId: 'thread-id', text: 'Exact text', context: { tenantId: 7, userId: 9, conversationKey: 'main:owner:permanent', agentId: 3, turnId: 'saved-turn', requestId: 'saved-request', turnDigest: 'd8cb6ffe0ca6c081d8c083cf3ea70cc87ffdc086b2a215f3dd4f7ac7b075be24', revision: 1 }, authority: { bearerToken: 'TEST-token', agentId: 3, sessionId: 'active-session' } }] },
    { operation: 'prepareSmsDraft', args: [{ phone: '+15550000100', text: 'Draft text' }] },
  ]);
  assert.equal('invoke' in window.dialer.macConnectors, false);
});

test('durable receipt inbox uses canonical owner conversation and restores an exact saved context without a synthetic origin', async () => {
  const context = { tenantId: 7, userId: 9, conversationKey: 'main:owner:permanent', environment: 'production', lineage: 'c'.repeat(64), agentId: 3, turnId: 'saved-turn', requestId: 'saved-request', turnDigest: 'b'.repeat(64), revision: 1 };
  const current = { agentId: 3, sessionId: 'active-session' }, authority = { bearerToken: 'TEST-token', ...current };
  await macConnectorService.listReviewedWrites(current);
  await macConnectorService.listReviewedWrites(current, `1800000000000:${'1'.repeat(8)}-${'1'.repeat(4)}-${'1'.repeat(4)}-${'1'.repeat(4)}-${'1'.repeat(12)}`);
  await macConnectorService.restoreReviewedWriteContext(context, 'messages.send', current);
  assert.deepEqual(calls, [
    { operation: 'listReviewedWrites', args: [{ authority }] },
    { operation: 'listReviewedWrites', args: [{ authority, cursor: '1800000000000:11111111-1111-1111-1111-111111111111' }] },
    { operation: 'restoreReviewedWrite', args: [{ kind: 'messages.send', context, authority }] },
  ]);
});

test('missing native bridge fails closed before an operation', async () => {
  global.window = { dialer: {} };
  assert.throws(() => macConnectorService.status(), /unavailable/);
});
