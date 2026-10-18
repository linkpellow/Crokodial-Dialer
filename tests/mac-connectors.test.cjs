const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MacConnectorAuthorityError, createMacConnectors, createDefaultMacConnectorDependencies, createFileMacConnectorWriteStorage } = require('../dist/main/macConnectors');

let now, idSequence, calls, contacts, thread, messages, whatsapp, authority, dependencies, connectors;
const uuid = index => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
const contact = (id, overrides = {}) => ({ id, name: `Synthetic ${id}`, firstName: 'Synthetic', lastName: id, organization: '', emails: [], phones: [], ...overrides });
const requestId = slot => `99999999-9999-4999-8999-${createHash('sha256').update(slot).digest('hex').slice(0, 12)}`;
const writeContext = (slot, revision = 1, agentId = 11) => ({ tenantId: 7, userId: 9, conversationKey: 'main:owner:permanent', agentId, turnId: `saved-turn-${slot}`, requestId: requestId(slot), turnDigest: 'a'.repeat(64), revision });
const authorityRequest = (agentId = 11, sessionId = `session-${agentId}`) => ({ bearerToken: `TEST-token-${agentId}`, agentId, sessionId });
const prepared = (payload, agentId = payload.context?.agentId ?? 11) => ({ ...payload, authority: authorityRequest(agentId) });
const binding = (review, agentId = review.context?.agentId ?? 11) => ({ id: review.id, kind: review.kind, digest: review.digest, context: review.context, authority: authorityRequest(agentId) });
const authorizedRead = (payload, agentId = 11) => ({ ...payload, authority: authorityRequest(agentId) });

beforeEach(() => {
  now = 1_800_000_000_000;
  idSequence = 1;
  calls = { contactAccess: 0, create: [], update: [], messagesAccess: 0, sent: [], opened: [] };
  contacts = [
    contact('contact-a', { emails: ['same@example.test'] }),
    contact('contact-b', { emails: ['same@example.test'], phones: ['+1 (555) 000-0100'] }),
    contact('contact-c', { phones: ['+1 555 000 0100'] }),
    contact('contact-d', { emails: ['unique@example.test'] }),
  ];
  thread = { id: 'iMessage;+;fixture-thread', title: 'Fixture thread', participants: ['+15550000100'], service: 'iMessage', lastMessage: 'Fixture hello', lastMessageAt: '2026-10-18T04:00:00Z' };
  messages = [{ id: 'message-1', text: 'Fixture hello', sender: '+15550000100', fromMe: false, sentAt: '2026-10-18T04:00:00Z' }];
  whatsapp = [{ id: 'wa-1', threadId: 'wa-thread', threadJid: '120363000000001@g.us', threadTitle: 'Fixture WhatsApp', sender: 'fixture@example.test', text: 'Fixture observation', fromMe: false, sentAt: '2026-10-18T03:00:00Z' }];
  authority = { version: 1, userId: 9, tenantId: 7, environment: 'production', conversationKey: 'main:owner:permanent', lineage: 'c'.repeat(64) };
  const serverClaims = new Map();
  calls.serverClaims = serverClaims;
  dependencies = {
    platform: 'darwin',
    contacts: {
      requestAccess: async () => { calls.contactAccess++; },
      search: async query => contacts.filter(row => JSON.stringify(row).toLowerCase().includes(query.toLowerCase())),
      listAll: async () => contacts,
      create: async value => { calls.create.push(value); return contact('contact-created', { name: `${value.firstName} ${value.lastName}`.trim(), ...value }); },
      update: async (contactId, changes) => { calls.update.push({ contactId, changes }); return { ...contacts.find(row => row.id === contactId), ...changes }; },
    },
    messages: {
      historyStatus: async () => 'available',
      requestAutomationAccess: async () => { calls.messagesAccess++; },
      listThreads: async query => !query || thread.title.toLowerCase().includes(query.toLowerCase()) ? [thread] : [],
      readThread: async threadId => { assert.equal(threadId, thread.id); return { thread, messages }; },
      sendExistingThread: async (threadId, text) => { calls.sent.push({ threadId, text }); },
    },
    whatsapp: {
      status: async () => 'available',
      search: async query => whatsapp.filter(row => row.text.toLowerCase().includes(query.toLowerCase())),
      readConversation: async jid => ({ conversation: { jid, label: 'Fixture WhatsApp' }, observations: whatsapp.filter(row => row.threadJid === jid) }),
    },
    authority: {
      verify: async () => ({ ...authority }),
      claim: async (_request, claim) => {
        const previous = serverClaims.get(claim.reviewId);
        if (previous && JSON.stringify(previous.claim) !== JSON.stringify(claim)) throw new Error('Fixture claim conflict');
        if (previous && previous.state !== 'executing') throw new Error('Fixture claim already terminal');
        serverClaims.set(claim.reviewId, previous ?? { claim: structuredClone(claim), state: 'executing' });
        return { reviewId: claim.reviewId, state: 'executing' };
      },
      assert: async (_request, reviewId, claimToken) => {
        const saved = serverClaims.get(reviewId);
        if (!saved || saved.claim.claimToken !== claimToken || saved.state !== 'executing') throw new Error('Fixture claim inactive');
        return { reviewId, state: 'executing' };
      },
      finalize: async (_request, reviewId, claimToken, state, message) => {
        const saved = serverClaims.get(reviewId);
        if (!saved || saved.claim.claimToken !== claimToken || saved.state !== 'executing') throw new Error('Fixture claim inactive');
        Object.assign(saved, { state, message });
        return { reviewId, state, message };
      },
      reconcile: async (_request, claim, resolution) => {
        const saved = serverClaims.get(claim.reviewId);
        if (saved && JSON.stringify(saved.claim) !== JSON.stringify(claim)) throw new Error('Fixture claim conflict');
        if (saved?.state === 'succeeded' || saved?.state === 'failed') return { reviewId: claim.reviewId, state: saved.state, message: saved.message };
        const reconciled = { claim: structuredClone(claim), state: 'reconciled', resolution };
        serverClaims.set(claim.reviewId, reconciled);
        return { reviewId: claim.reviewId, state: 'reconciled', resolution };
      },
    },
    openExternal: async url => { calls.opened.push(url); },
    now: () => now,
    randomId: () => uuid(idSequence++),
  };
  connectors = createMacConnectors(dependencies);
});

test('reports explicit permission state and never prompts or reads Contacts during status', async () => {
  const status = await connectors.status();
  assert.equal(status.platform, 'macos');
  assert.equal(status.contacts.state, 'unknown');
  assert.equal(status.messagesHistory.state, 'available');
  assert.equal(status.messagesSend.state, 'unknown');
  assert.equal(status.whatsapp.state, 'available');
  assert.equal(calls.contactAccess, 0);
  await assert.rejects(connectors.searchContacts('Synthetic'), /Check Contacts/);
  await connectors.requestAccess('contacts');
  assert.equal(calls.contactAccess, 1);
  assert.equal((await connectors.status()).contacts.state, 'available');
});

test('Contacts search and transitive duplicate preview are bounded and read only', async () => {
  await connectors.requestAccess('contacts');
  assert.equal((await connectors.searchContacts('same@example')).contacts.length, 2);
  const preview = await connectors.previewContactDuplicates();
  assert.equal(preview.groups.length, 1);
  assert.deepEqual(preview.groups[0].contacts.map(row => row.id).sort(), ['contact-a', 'contact-b', 'contact-c']);
  assert.equal(calls.create.length, 0);
  assert.equal(calls.update.length, 0);
});

test('contact creation and update require an exact one-use review binding', async () => {
  await connectors.requestAccess('contacts');
  const createReview = await connectors.prepareContactMutation(prepared({ context: writeContext('contact-create'), change: { operation: 'create', contact: { firstName: 'Fixture', lastName: 'Owner', emails: ['OWNER@EXAMPLE.TEST'], phones: ['+1 (555) 000-0100'] } } }));
  assert.equal(createReview.kind, 'contact.create');
  assert.equal(calls.create.length, 0);
  await assert.rejects(connectors.executeContactMutation({ ...binding(createReview), digest: '0'.repeat(64) }), /changed/);
  assert.equal(calls.create.length, 0);
  const created = await connectors.executeContactMutation(binding(createReview));
  assert.equal(created.state, 'succeeded');
  assert.deepEqual(calls.create[0].emails, ['owner@example.test']);
  await assert.rejects(connectors.executeContactMutation(binding(createReview)), /saved receipt|cannot be replayed/);
  assert.equal(calls.create.length, 1);

  const updateReview = await connectors.prepareContactMutation(prepared({ context: writeContext('contact-update'), change: { operation: 'update', contactId: 'contact-d', changes: { organization: 'Fixture Org', addEmails: ['added@example.test'] } } }));
  assert.equal((await connectors.executeContactMutation(binding(updateReview))).state, 'succeeded');
  assert.deepEqual(calls.update, [{ contactId: 'contact-d', changes: { organization: 'Fixture Org', addEmails: ['added@example.test'] } }]);
});

test('uncertain Contacts outcomes are consumed and cannot be replayed', async () => {
  dependencies.contacts.create = async value => { calls.create.push(value); throw new Error('Fixture response lost'); };
  connectors = createMacConnectors(dependencies);
  await connectors.requestAccess('contacts');
  const review = await connectors.prepareContactMutation(prepared({ context: writeContext('contact-unknown'), change: { operation: 'create', contact: { firstName: 'Fixture', lastName: 'Unknown' } } }));
  assert.equal((await connectors.executeContactMutation(binding(review))).state, 'unknown');
  await assert.rejects(connectors.executeContactMutation(binding(review)), /saved receipt|cannot be replayed/);
  assert.equal(calls.create.length, 1);
});

test('Messages reads existing threads and sends only the exact reviewed text to the bound thread', async () => {
  assert.deepEqual((await connectors.listMessageThreads('Fixture')).threads.map(row => row.id), [thread.id]);
  assert.equal((await connectors.readMessageThread(thread.id)).messages[0].text, 'Fixture hello');
  await assert.rejects(connectors.prepareMessageSend(prepared({ threadId: thread.id, text: 'Reviewed fixture reply' })), /Check Messages/);
  await connectors.requestAccess('messages');
  const review = await connectors.prepareMessageSend(prepared({ context: writeContext('message-submit'), threadId: thread.id, text: 'Reviewed fixture reply' }));
  assert.equal(calls.sent.length, 0);
  const receipt = await connectors.executeMessageSend(binding(review));
  assert.equal(receipt.state, 'submitted');
  assert.deepEqual(calls.sent, [{ threadId: thread.id, text: 'Reviewed fixture reply' }]);
  await assert.rejects(connectors.executeMessageSend(binding(review)), /saved receipt|cannot be replayed/);
});

test('Messages rejects a changed participant binding and never sends', async () => {
  await connectors.requestAccess('messages');
  const review = await connectors.prepareMessageSend(prepared({ context: writeContext('message-change'), threadId: thread.id, text: 'Do not send after change' }));
  thread = { ...thread, participants: ['+15550000999'] };
  const receipt = await connectors.executeMessageSend(binding(review));
  assert.equal(receipt.state, 'rejected');
  assert.equal(calls.sent.length, 0);
});

test('concurrent execution claims the durable review before awaited thread revalidation and sends exactly once', async () => {
  await connectors.requestAccess('messages');
  const review = await connectors.prepareMessageSend(prepared({ context: writeContext('message-concurrent'), threadId: thread.id, text: 'Exactly once under concurrency' }));
  let releaseRead;
  dependencies.messages.readThread = async threadId => {
    assert.equal(threadId, thread.id);
    await new Promise(resolve => { releaseRead = resolve; });
    return { thread, messages };
  };
  const winner = connectors.executeMessageSend(binding(review));
  while (!releaseRead) await Promise.resolve();
  await assert.rejects(connectors.executeMessageSend(binding(review)), /saved receipt|cannot be replayed/);
  assert.equal(calls.sent.length, 0);
  releaseRead();
  assert.equal((await winner).state, 'submitted');
  assert.equal(calls.sent.length, 1);
  assert.equal((await connectors.restoreReviewedWrite(authorizedRead({ context: writeContext('message-concurrent'), kind: 'messages.send' }))).state, 'submitted');
});

test('concurrent executions that both await server authority still claim once and send once', async () => {
  await connectors.requestAccess('messages');
  const review = await connectors.prepareMessageSend(prepared({ context: writeContext('authority-concurrent'), threadId: thread.id, text: 'Exactly once after authority' }));
  const releases = [];
  dependencies.authority.verify = async () => new Promise(resolve => releases.push(() => resolve({ ...authority })));
  const attempts = [connectors.executeMessageSend(binding(review)), connectors.executeMessageSend(binding(review))];
  while (releases.length < 2) await Promise.resolve();
  releases.forEach(release => release());
  const results = await Promise.allSettled(attempts);
  assert.equal(results.filter(result => result.status === 'fulfilled' && result.value.state === 'submitted').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected' && /saved receipt|cannot be replayed/.test(String(result.reason))).length, 1);
  assert.deepEqual(calls.sent, [{ threadId: thread.id, text: 'Exactly once after authority' }]);
});

test('server claim is durable before the final provider assertion and never releases on elapsed time', async () => {
  await connectors.requestAccess('messages');
  const review = await connectors.prepareMessageSend(prepared({ context: writeContext('provider-boundary'), threadId: thread.id, text: 'One fenced provider call' }));
  const originalAssert = dependencies.authority.assert;
  let reachedBoundary;
  const atBoundary = new Promise(resolve => { reachedBoundary = resolve; });
  let releaseBoundary;
  const paused = new Promise(resolve => { releaseBoundary = resolve; });
  dependencies.authority.assert = async (...args) => {
    reachedBoundary();
    await paused;
    return originalAssert(...args);
  };
  const execution = connectors.executeMessageSend(binding(review));
  await atBoundary;
  assert.equal(calls.serverClaims.size, 1, 'server claim exists before provider assertion resumes');
  assert.equal([...calls.serverClaims.values()][0].state, 'executing');
  assert.equal(calls.sent.length, 0);
  now += 24 * 60 * 60 * 1000;
  await assert.rejects(connectors.executeMessageSend(binding(review)), /saved receipt|cannot be replayed/);
  assert.equal([...calls.serverClaims.values()][0].state, 'executing', 'elapsed time never releases the server fence');
  assert.equal(calls.sent.length, 0);
  releaseBoundary();
  assert.equal((await execution).state, 'submitted');
  assert.equal(calls.sent.length, 1);
  assert.equal([...calls.serverClaims.values()][0].state, 'succeeded');
});

test('authorization lineage rotation rejects a prepared write before provider access', async () => {
  await connectors.requestAccess('messages');
  const context = writeContext('lineage-rotation');
  const review = await connectors.prepareMessageSend(prepared({ context, threadId: thread.id, text: 'Never submit after rotation' }));
  authority = { ...authority, lineage: 'd'.repeat(64) };
  const receipt = await connectors.executeMessageSend(binding(review));
  assert.equal(receipt.state, 'rejected');
  assert.match(receipt.message, /authorization lineage changed/i);
  assert.equal(calls.sent.length, 0);
  assert.equal((await connectors.restoreReviewedWrite(authorizedRead({ context, kind: 'messages.send' }))).state, 'rejected');
  await assert.rejects(connectors.executeMessageSend(binding(review)), /saved receipt|cannot be replayed/);
});

test('definitive server revocation closes pending review while transient validation leaves it pending', async () => {
  await connectors.requestAccess('contacts');
  const revokedContext = writeContext('authority-revoked');
  const revoked = await connectors.prepareContactMutation(prepared({ context: revokedContext, change: { operation: 'create', contact: { firstName: 'Revoked', lastName: 'Fixture' } } }));
  dependencies.authority.verify = async () => { throw new MacConnectorAuthorityError('Fixture token revoked', true); };
  const rejected = await connectors.executeContactMutation(binding(revoked));
  assert.equal(rejected.state, 'rejected');
  assert.equal(calls.create.length, 0);
  dependencies.authority.verify = async () => ({ ...authority });
  assert.equal((await connectors.restoreReviewedWrite(authorizedRead({ context: revokedContext, kind: 'contact.create' }))).state, 'rejected');

  dependencies.authority.verify = async () => ({ ...authority });
  const transientContext = writeContext('authority-transient');
  const transient = await connectors.prepareContactMutation(prepared({ context: transientContext, change: { operation: 'create', contact: { firstName: 'Transient', lastName: 'Fixture' } } }));
  dependencies.authority.verify = async () => { throw new MacConnectorAuthorityError('Fixture network unavailable'); };
  await assert.rejects(connectors.executeContactMutation(binding(transient)), /network unavailable/);
  assert.equal(calls.create.length, 0);
  dependencies.authority.verify = async () => ({ ...authority });
  assert.equal((await connectors.restoreReviewedWrite(authorizedRead({ context: transientContext, kind: 'contact.create' }))).state, 'pending');
});

test('current owner can tombstone a pre-claim crash after authorization lineage rotation', async () => {
  await connectors.requestAccess('contacts');
  const context = writeContext('claim-rejected-before-save');
  const review = await connectors.prepareContactMutation(prepared({ context, change: { operation: 'create', contact: { firstName: 'No', lastName: 'Provider Call' } } }));
  dependencies.authority.claim = async () => { throw new MacConnectorAuthorityError('Fixture stale JWT rejected', true); };
  const uncertain = await connectors.executeContactMutation(binding(review));
  assert.equal(uncertain.state, 'unknown');
  assert.equal(calls.create.length, 0);
  assert.equal(calls.serverClaims.size, 0);

  authority = { ...authority, lineage: 'd'.repeat(64) };
  const restored = await connectors.restoreReviewedWrite(authorizedRead({ context, kind: 'contact.create' }));
  const reconciled = await connectors.reconcileReviewedWrite({ id: restored.receipt.reviewId, digest: restored.receipt.digest,
    context: restored.receipt.context, resolution: 'not_applied', authority: authorityRequest() });
  assert.equal(reconciled.state, 'reconciled');
  assert.equal(reconciled.nextRevision, 2);
  assert.equal(calls.serverClaims.size, 1, 'reconciliation saves a server tombstone that blocks a late claim');
  assert.equal(calls.create.length, 0);
});

test('an uncertain Messages response produces an unknown receipt and is never replayed', async () => {
  dependencies.messages.sendExistingThread = async (threadId, text) => { calls.sent.push({ threadId, text }); throw new Error('Fixture response lost'); };
  connectors = createMacConnectors(dependencies);
  await connectors.requestAccess('messages');
  const review = await connectors.prepareMessageSend(prepared({ context: writeContext('message-unknown'), threadId: thread.id, text: 'Maybe submitted' }));
  assert.equal((await connectors.executeMessageSend(binding(review))).state, 'unknown');
  await assert.rejects(connectors.executeMessageSend(binding(review)), /saved receipt|cannot be replayed/);
  assert.equal(calls.sent.length, 1);
});

test('a lost finalization response restores the durable server success without replaying the provider', async () => {
  let saved;
  const storage = { load: () => saved && structuredClone(saved), save: value => { saved = structuredClone(value); } };
  const originalFinalize = dependencies.authority.finalize;
  dependencies.authority.finalize = async (...args) => { await originalFinalize(...args); throw new Error('Fixture final receipt response lost'); };
  const first = createMacConnectors(dependencies, storage);
  await first.requestAccess('messages');
  const context = writeContext('final-receipt-lost');
  const review = await first.prepareMessageSend(prepared({ context, threadId: thread.id, text: 'Recover server success once' }));
  const uncertain = await first.executeMessageSend(binding(review));
  assert.equal(uncertain.state, 'unknown');
  assert.equal(calls.sent.length, 1);
  assert.equal([...calls.serverClaims.values()][0].state, 'succeeded');

  dependencies.authority.finalize = originalFinalize;
  const restarted = createMacConnectors(dependencies, storage);
  const restored = await restarted.restoreReviewedWrite(authorizedRead({ context, kind: 'messages.send' }));
  assert.equal(restored.state, 'unknown');
  const recovered = await restarted.reconcileReviewedWrite({ id: restored.receipt.reviewId, digest: restored.receipt.digest,
    context: restored.receipt.context, resolution: 'applied', authority: authorityRequest() });
  assert.equal(recovered.state, 'submitted');
  assert.match(recovered.receipt.message, /Messages accepted/i);
  assert.equal(calls.sent.length, 1, 'reconciliation reads the server receipt and never repeats the provider mutation');
});

test('a crash in executing state restores unknown and blocks an exact duplicate until explicit reconciliation and revision', async () => {
  let saved;
  const storage = { load: () => saved && structuredClone(saved), save: value => { saved = structuredClone(value); } };
  dependencies.messages.sendExistingThread = async (threadId, text) => {
    calls.sent.push({ threadId, text });
    await new Promise(() => {});
  };
  const first = createMacConnectors(dependencies, storage);
  await first.requestAccess('messages');
  const context = writeContext('restart-unknown');
  const review = await first.prepareMessageSend(prepared({ context, threadId: thread.id, text: 'Crash-window fixture' }));
  const unresolvedExecution = first.executeMessageSend(binding(review));
  while (saved.records[0].state !== 'executing' || calls.sent.length !== 1) await Promise.resolve();
  assert.equal(calls.sent.length, 1);

  const restarted = createMacConnectors(dependencies, storage);
  await restarted.requestAccess('messages');
  const crashInbox = await restarted.listReviewedWrites(authorizedRead({}));
  assert.equal(crashInbox.records.length, 1);
  assert.equal(crashInbox.records[0].state, 'unknown');
  assert.equal(crashInbox.records[0].kind, 'messages.send');
  assert.equal(crashInbox.records[0].context.agentId, 11, 'the original assistant remains provenance only');
  assert.equal(crashInbox.records[0].payload.text, 'Crash-window fixture');
  const restored = await restarted.restoreReviewedWrite(authorizedRead({ context, kind: 'messages.send' }));
  assert.equal(restored.state, 'unknown');
  assert.match(restored.receipt.message, /restarted|cannot prove/i);
  await assert.rejects(restarted.prepareMessageSend(prepared({ context: writeContext('new-turn-after-crash'), threadId: thread.id, text: 'Crash-window fixture' })), /unresolved outcome/);
  assert.equal(calls.sent.length, 1, 'restart and duplicate preparation must not send again');

  const reconciled = await restarted.reconcileReviewedWrite({ id: restored.receipt.reviewId, digest: restored.receipt.digest,
    context: restored.receipt.context, resolution: 'not_applied', authority: authorityRequest() });
  assert.equal(reconciled.state, 'reconciled');
  assert.equal(reconciled.nextRevision, 2);
  const revised = await restarted.prepareMessageSend(prepared({ context: writeContext('restart-unknown', 2), threadId: thread.id, text: 'Crash-window fixture' }));
  assert.equal(revised.state, 'pending');
  assert.equal(calls.sent.length, 1, 'a revised review remains preparation only');
  void unresolvedExecution;
});

test('pending receipt inbox survives restart and executes once under a replacement assistant authority', async () => {
  let saved;
  const storage = { load: () => saved && structuredClone(saved), save: value => { saved = structuredClone(value); } };
  const first = createMacConnectors(dependencies, storage);
  await first.requestAccess('messages');
  const context = writeContext('inbox-pending-restart', 1, 11);
  const review = await first.prepareMessageSend(prepared({ context, threadId: thread.id, text: 'Pending inbox fixture' }));
  assert.equal(calls.sent.length, 0);

  const replacement = createMacConnectors(dependencies, storage);
  const inbox = await replacement.listReviewedWrites(authorizedRead({}, 22));
  assert.equal(inbox.truncated, false);
  assert.equal(inbox.records.length, 1);
  assert.equal(inbox.records[0].state, 'pending');
  assert.equal(inbox.records[0].review.id, review.id);
  assert.equal(inbox.records[0].context.agentId, 11);
  assert.equal(inbox.records[0].context.requestId, context.requestId);
  assert.equal(inbox.records[0].payload.text, 'Pending inbox fixture');
  await assert.rejects(replacement.restoreReviewedWrite(authorizedRead({ context: { ...context, userId: 99 }, kind: 'messages.send' }, 22)), /does not belong to the active owner/i);
  assert.equal(calls.sent.length, 0, 'listing a durable pending review never executes it');

  await replacement.requestAccess('messages');
  const receipt = await replacement.executeMessageSend(binding(inbox.records[0].review, 22));
  assert.equal(receipt.state, 'submitted');
  assert.deepEqual(calls.sent, [{ threadId: thread.id, text: 'Pending inbox fixture' }]);
  await assert.rejects(replacement.executeMessageSend(binding(inbox.records[0].review, 22)), /saved receipt|cannot be replayed/);
  assert.equal(calls.sent.length, 1);
});

test('receipt inbox pagination reaches an older unresolved write with stable idempotent restoration', async () => {
  let saved;
  const storage = { load: () => saved && structuredClone(saved), save: value => { saved = structuredClone(value); } };
  dependencies.messages.sendExistingThread = async (threadId, text) => { calls.sent.push({ threadId, text }); throw new Error('Fixture response lost'); };
  const first = createMacConnectors(dependencies, storage);
  await first.requestAccess('messages');
  const unknownContext = writeContext('inbox-page-two-unknown');
  const unknownReview = await first.prepareMessageSend(prepared({ context: unknownContext, threadId: thread.id, text: 'Older unresolved inbox fixture' }));
  assert.equal((await first.executeMessageSend(binding(unknownReview))).state, 'unknown');
  await first.requestAccess('contacts');
  for (let index = 0; index < 100; index++) {
    await first.prepareContactMutation(prepared({ context: writeContext(`newer-inbox-${index}`),
      change: { operation: 'create', contact: { firstName: 'Pending', lastName: String(index) } } }));
  }

  const replacement = createMacConnectors(dependencies, storage);
  const firstPage = await replacement.listReviewedWrites(authorizedRead({}, 22));
  assert.equal(firstPage.records.length, 100);
  assert.equal(typeof firstPage.nextCursor, 'string');
  assert.equal(firstPage.records.some(record => record.state === 'unknown'), false);
  const secondPage = await replacement.listReviewedWrites(authorizedRead({ cursor: firstPage.nextCursor }, 22));
  assert.equal(secondPage.records.length, 1);
  assert.equal(secondPage.nextCursor, undefined);
  assert.equal(secondPage.records[0].state, 'unknown');
  assert.equal(secondPage.records[0].payload.text, 'Older unresolved inbox fixture');
  const restoredOnce = await replacement.restoreReviewedWrite(authorizedRead({ context: secondPage.records[0].context, kind: secondPage.records[0].kind }, 22));
  const restoredAgain = await replacement.restoreReviewedWrite(authorizedRead({ context: secondPage.records[0].context, kind: secondPage.records[0].kind }, 22));
  assert.equal(restoredOnce.state, 'unknown');
  assert.deepEqual(restoredAgain, restoredOnce, 'exact receipt restoration stays idempotent after pagination');
  assert.equal(calls.sent.length, 1, 'listing pages and restoring never retries the unresolved provider write');
});

test('submitted receipts restore for the same owner and saved turn but never cross owner bindings', async () => {
  let saved;
  const storage = { load: () => saved && structuredClone(saved), save: value => { saved = structuredClone(value); } };
  const first = createMacConnectors(dependencies, storage);
  await first.requestAccess('messages');
  const context = writeContext('durable-submitted');
  const review = await first.prepareMessageSend(prepared({ context, threadId: thread.id, text: 'Durable submitted fixture' }));
  assert.equal((await first.executeMessageSend(binding(review))).state, 'submitted');

  const restarted = createMacConnectors(dependencies, storage);
  const restored = await restarted.restoreReviewedWrite(authorizedRead({ context, kind: 'messages.send' }));
  assert.equal(restored.state, 'submitted');
  assert.equal(restored.receipt.digest, review.digest);
  authority = { ...authority, environment: 'sandbox' };
  assert.deepEqual(await restarted.listReviewedWrites(authorizedRead({})), { records: [], truncated: false },
    'production receipts stay hidden from the same owner in sandbox');
  assert.deepEqual(await restarted.restoreReviewedWrite(authorizedRead({ context, kind: 'messages.send' })),
    { state: 'none', nextRevision: 1 }, 'a predictable production request cannot be restored in sandbox');
  authority = { ...authority, environment: 'production' };
  await assert.rejects(restarted.restoreReviewedWrite(authorizedRead({ context: { ...context, userId: 99 }, kind: 'messages.send' })), /does not belong to the active owner/i);
  authority = { ...authority, userId: 99, tenantId: 8, conversationKey: 'main:other-owner' };
  assert.deepEqual(await restarted.listReviewedWrites(authorizedRead({ userId: 9, tenantId: 7, conversationKey: 'main:owner:permanent' })),
    { records: [], truncated: false }, 'renderer-supplied predictable owner IDs cannot enumerate another login\'s ledger');
  await assert.rejects(restarted.restoreReviewedWrite(authorizedRead({ context, kind: 'messages.send' })), /does not belong to the active owner/i);
  authority = { ...authority, userId: 9, tenantId: 7, conversationKey: 'main:owner:permanent' };
  await restarted.requestAccess('messages');
  await assert.rejects(restarted.executeMessageSend({ ...binding(review), context: { ...context, userId: 99 } }), /does not belong/);
  assert.equal(calls.sent.length, 1);
});

test('replacement Personal Assistant restores the prior agent submitted receipt without replay', async () => {
  let saved;
  const storage = { load: () => saved && structuredClone(saved), save: value => { saved = structuredClone(value); } };
  const first = createMacConnectors(dependencies, storage);
  await first.requestAccess('messages');
  const original = writeContext('agent-replaced-submitted', 1, 11);
  const review = await first.prepareMessageSend(prepared({ context: original, threadId: thread.id, text: 'Replacement-safe fixture' }));
  assert.equal((await first.executeMessageSend(binding(review))).state, 'submitted');

  const replacement = createMacConnectors(dependencies, storage);
  const restored = await replacement.restoreReviewedWrite(authorizedRead({ context: writeContext('agent-replaced-submitted', 1, 22), kind: 'messages.send' }, 22));
  assert.equal(restored.state, 'submitted');
  await replacement.requestAccess('messages');
  await assert.rejects(replacement.executeMessageSend({ ...binding(review), context: writeContext('agent-replaced-submitted', 1, 22) }), /saved receipt|cannot be replayed/);
  assert.equal(calls.sent.length, 1);
});

test('replacement Personal Assistant restores unresolved prior-agent outcome and blocks duplicate payload', async () => {
  let saved;
  const storage = { load: () => saved && structuredClone(saved), save: value => { saved = structuredClone(value); } };
  dependencies.messages.sendExistingThread = async (threadId, text) => { calls.sent.push({ threadId, text }); throw new Error('Fixture response lost'); };
  const first = createMacConnectors(dependencies, storage);
  await first.requestAccess('messages');
  const review = await first.prepareMessageSend(prepared({ context: writeContext('agent-replaced-unknown', 1, 11), threadId: thread.id, text: 'Unresolved replacement fixture' }));
  assert.equal((await first.executeMessageSend(binding(review))).state, 'unknown');

  const replacement = createMacConnectors(dependencies, storage);
  await replacement.requestAccess('messages');
  const inbox = await replacement.listReviewedWrites(authorizedRead({}, 22));
  assert.equal(inbox.records.length, 1);
  assert.equal(inbox.records[0].state, 'unknown');
  assert.equal(inbox.records[0].context.agentId, 11);
  assert.equal(inbox.records[0].payload.text, 'Unresolved replacement fixture');
  assert.equal(calls.sent.length, 1, 'restoring an unresolved inbox never retries it');
  const restored = await replacement.restoreReviewedWrite(authorizedRead({ context: writeContext('agent-replaced-unknown', 1, 22), kind: 'messages.send' }, 22));
  assert.equal(restored.state, 'unknown');
  await assert.rejects(replacement.prepareMessageSend(prepared({ context: writeContext('agent-replaced-new-turn', 1, 22), threadId: thread.id, text: 'Unresolved replacement fixture' }, 22)), /unresolved outcome/);
  assert.equal(calls.sent.length, 1);
  const reconciled = await replacement.reconcileReviewedWrite({ id: inbox.records[0].receipt.reviewId, digest: inbox.records[0].receipt.digest,
    context: inbox.records[0].receipt.context, resolution: 'not_applied', authority: authorityRequest(22) });
  assert.equal(reconciled.state, 'reconciled');
  assert.equal(reconciled.nextRevision, 2);
  assert.equal((await replacement.listReviewedWrites(authorizedRead({}, 22))).records[0].state, 'reconciled');
  assert.equal(calls.sent.length, 1, 'reconciliation records an observation and never sends');
});

test('terminal receipts rotate to encrypted archive storage and restore after restart', async () => {
  let saved;
  const archives = new Map();
  const storage = {
    load: () => saved && structuredClone(saved),
    save: value => { saved = structuredClone(value); },
    loadArchive: key => archives.has(key) ? structuredClone(archives.get(key)) : undefined,
    saveArchive: (key, value) => { archives.set(key, structuredClone(value)); },
  };
  const first = createMacConnectors(dependencies, storage);
  await first.requestAccess('contacts');
  for (let index = 0; index < 1_001; index++) {
    const review = await first.prepareContactMutation(prepared({ context: writeContext(`archive-${index}`), change: { operation: 'create', contact: { firstName: 'Archive', lastName: String(index) } } }));
    assert.equal((await first.executeContactMutation(binding(review))).state, 'succeeded');
  }
  assert.ok(saved.records.length < 1_000, 'terminal rotation frees active receipt capacity');
  assert.ok(archives.size > 0, 'rotated receipts are persisted outside the active ledger');

  const restarted = createMacConnectors(dependencies, storage);
  const restored = await restarted.restoreReviewedWrite(authorizedRead({ context: writeContext('archive-0'), kind: 'contact.create' }));
  assert.equal(restored.state, 'succeeded');
  await restarted.requestAccess('contacts');
  await assert.rejects(restarted.prepareContactMutation(prepared({ context: writeContext('archive-0'), change: { operation: 'create', contact: { firstName: 'Archive', lastName: '0' } } })), /saved write receipt|Restore it/);
  assert.equal(calls.create.length, 1_001);
});

test('WhatsApp is a bounded read-only observation surface', async () => {
  const result = await connectors.searchWhatsApp('observation');
  assert.equal(result.readOnly, true);
  assert.equal(result.observations[0].threadTitle, 'Fixture WhatsApp');
  assert.equal(result.observations[0].threadJid, '120363000000001@g.us');
  const exact = await connectors.readWhatsAppConversation('120363000000001@g.us');
  assert.equal(exact.readOnly, true);
  assert.deepEqual(exact.conversation, { jid: '120363000000001@g.us', label: 'Fixture WhatsApp' });
  assert.deepEqual(exact.observations.map(row => row.threadJid), ['120363000000001@g.us']);
  assert.equal(Object.keys(connectors).some(key => /whatsapp.*(?:send|write|update)/i.test(key)), false);
  await assert.rejects(connectors.searchWhatsApp('x'), /two characters/);
});

test('new SMS handoff opens only a recipient-only sms: URL after exact review', async () => {
  const review = await connectors.prepareSmsDraft({ phone: '+1 (555) 000-0100', text: 'Fixture draft body' });
  assert.equal(calls.opened.length, 0);
  assert.equal(review.payload.text, 'Fixture draft body');
  const receipt = await connectors.openSmsDraft({ id: review.id, digest: review.digest });
  assert.equal(receipt.state, 'opened');
  assert.deepEqual(calls.opened, ['sms:+15550000100']);
  assert.equal(calls.opened[0].includes('Fixture'), false);
  await assert.rejects(connectors.openSmsDraft({ id: review.id, digest: review.digest }), /already used/);
  await assert.rejects(connectors.prepareSmsDraft({ phone: 'sms:+1555?body=bad', text: 'x' }), /Phone is invalid/);
});

test('expired reviews fail closed without invoking an external action', async () => {
  const review = await connectors.prepareSmsDraft({ phone: '5550000100', text: 'Expired fixture' });
  now += 10 * 60 * 1000;
  await assert.rejects(connectors.openSmsDraft({ id: review.id, digest: review.digest }), /expired/);
  assert.equal(calls.opened.length, 0);
});

test('non-Mac systems expose unsupported status and execute no adapters', async () => {
  dependencies.platform = 'linux';
  connectors = createMacConnectors(dependencies);
  assert.equal((await connectors.status()).contacts.state, 'unsupported');
  await assert.rejects(connectors.requestAccess('contacts'), /macOS only/);
  assert.equal(calls.contactAccess, 0);
});

test('default adapters use fixed executables, fixed database paths and hex-encoded SQL values', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crokodial-mac-connectors-'));
  try {
    const db = path.join(directory, 'Library', 'Messages', 'chat.db');
    fs.mkdirSync(path.dirname(db), { recursive: true }); fs.writeFileSync(db, 'fixture');
    const invocations = [];
    const fakeExec = (file, args, options, callback) => {
      invocations.push({ file, args, options });
      if (file === '/usr/bin/osascript') callback(null, '{"ok":true,"count":0}\n', '');
      else callback(null, args.at(-1).startsWith('SELECT 1 AS ok') ? '[{"ok":1}]\n' : '[]\n', '');
    };
    const defaults = createDefaultMacConnectorDependencies({ execFile: fakeExec, homeDir: directory, platform: 'darwin' });
    assert.equal(await defaults.messages.historyStatus(), 'available');
    const injection = "x'; DROP TABLE message; --";
    await defaults.messages.listThreads(injection);
    const sqlite = invocations.findLast(item => item.file === '/usr/bin/sqlite3');
    assert.equal(sqlite.args[0], '-readonly');
    assert.equal(sqlite.args[2], db);
    assert.equal(sqlite.args.at(-1).includes(injection), false);
    assert.match(sqlite.args.at(-1), new RegExp(Buffer.from(injection.toLowerCase()).toString('hex')));
    await defaults.contacts.requestAccess();
    const automation = invocations.findLast(item => item.file === '/usr/bin/osascript');
    assert.deepEqual(automation.args.slice(0, 3), ['-l', 'JavaScript', '-e']);
    assert.equal(automation.options.shell, undefined);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('durable receipt file is encrypted, mode 0600, and fsyncs data before and directory after rename', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crokodial-mac-write-ledger-'));
  const target = path.join(directory, 'profile', 'receipts.secure');
  const events = [];
  const originalFsync = fs.fsyncSync, originalRename = fs.renameSync;
  fs.fsyncSync = descriptor => { events.push(['fsync', descriptor]); return originalFsync(descriptor); };
  fs.renameSync = (from, to) => { events.push(['rename', from, to]); return originalRename(from, to); };
  try {
    const codec = {
      encode: value => Buffer.from(value).toString('base64').split('').reverse().join(''),
      decode: value => Buffer.from(value.split('').reverse().join(''), 'base64').toString('utf8'),
    };
    const storage = createFileMacConnectorWriteStorage(target, codec);
    storage.save({ version: 1, profileId: uuid(900), records: [] });
    const renameIndex = events.findIndex(event => event[0] === 'rename');
    assert.ok(renameIndex > 0 && events.slice(0, renameIndex).some(event => event[0] === 'fsync'), 'temp data is fsynced before rename');
    assert.ok(events.slice(renameIndex + 1).some(event => event[0] === 'fsync'), 'parent directory is fsynced after rename');
    assert.equal(fs.statSync(target).mode & 0o777, 0o600);
    assert.doesNotMatch(fs.readFileSync(target, 'utf8'), /profileId|records/);
    assert.deepEqual(storage.load(), { version: 1, profileId: uuid(900), records: [] });
    const archiveKey = 'e'.repeat(64), archive = { version: 1, profileId: uuid(900), records: [] };
    storage.saveArchive(archiveKey, archive);
    const archivePath = path.join(`${target}.archive`, `${archiveKey}.secure`);
    assert.equal(fs.statSync(archivePath).mode & 0o777, 0o600);
    assert.doesNotMatch(fs.readFileSync(archivePath, 'utf8'), /profileId|records/);
    assert.deepEqual(storage.loadArchive(archiveKey), archive);
  } finally {
    fs.fsyncSync = originalFsync; fs.renameSync = originalRename;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('preload exposes narrow operations and no generic shell, SQL, path or script primitive', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/preload/preload.ts'), 'utf8');
  const block = source.match(/macConnectors:\s*\{([\s\S]*?)\n\s*\},/)[1];
  assert.doesNotMatch(block, /\b(?:exec|shell|sql|script|path|file)\b/i);
  for (const operation of ['status', 'requestAccess', 'searchContacts', 'previewContactDuplicates', 'prepareContactChange', 'executeContactChange', 'listMessageThreads', 'readMessageThread', 'prepareMessageSend', 'executeMessageSend', 'restoreReviewedWrite', 'listReviewedWrites', 'reconcileReviewedWrite', 'searchWhatsApp', 'prepareSmsDraft', 'openSmsDraft', 'monitorState', 'resumeMonitor', 'startMonitor', 'stopMonitor', 'refreshMonitor', 'onMonitorState']) assert.match(block, new RegExp(`\\b${operation}\\b`));
});
