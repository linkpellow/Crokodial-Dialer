const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crokodial-main-monitor-'));
buildSync({ entryPoints: ['src/main/macConnectorMonitor.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(directory, 'monitor.cjs') });
const { createAuthorizedMacConnectorMonitor, createMacConnectorMonitor, createFileMacMonitorStorage } = require(path.join(directory, 'monitor.cjs'));
after(() => fs.rmSync(directory, { recursive: true, force: true }));

const selected = { jid: '120363000000001@g.us', label: 'Synthetic Sales Team' };
const selectedTwo = { jid: '120363000000002@g.us', label: 'Synthetic Service Team' };
const defaultKeywords = ['urgent', 'asap', 'immediately', 'emergency', 'time sensitive', 'deadline', 'overdue', 'cancel today', 'need help', 'needs help'];
const thread = (id, text, fromMe = false) => ({ id, title: `Thread ${id}`, participants: [], service: 'iMessage', lastMessage: text, lastMessageAt: '2030-01-01T00:00:00.000Z', lastMessageFromMe: fromMe });
const observation = (id, text, fromMe = false, jid = selected.jid, title = selected.label) => ({
  id, threadId: `database-row-${jid}-${id}`, threadJid: jid, threadTitle: title,
  sender: 'fixture@example.test', text, fromMe, sentAt: '2030-01-01T00:00:00.000Z',
});
const memoryStorage = () => {
  let saved;
  return {
    storage: { load: () => saved && structuredClone(saved), save: value => { saved = structuredClone(value); }, clear: () => { saved = undefined; } },
    saved: () => saved && structuredClone(saved),
  };
};
const exactReader = (getRows, calls = []) => ({
  listMessageThreads: async query => { calls.push(['messages', query]); return { threads: [] }; },
  readWhatsAppConversation: async jid => {
    calls.push(['whatsapp', jid]);
    return { conversation: { jid, label: selected.label }, observations: getRows() };
  },
});

test('main-process monitor persists exact WhatsApp JIDs and keywords, stays alive without a renderer and resumes after restart', async () => {
  const calls = [], listeners = [], scheduled = [], memory = memoryStorage();
  let messages = [thread('1', 'URGENT: client needs help'), ...Array.from({ length: 74 }, (_, index) => thread(`extra-${index}`, `${index}`))];
  let whatsapp = [observation('1', 'ASAP please review'), observation('2', 'urgent outgoing', true), ...Array.from({ length: 123 }, (_, index) => observation(`extra-${index}`, `${index}`))];
  const readers = {
    listMessageThreads: async query => { calls.push(['messages', query]); return { threads: messages }; },
    readWhatsAppConversation: async jid => { calls.push(['whatsapp', jid]); return { conversation: { jid, label: selected.label }, observations: whatsapp }; },
  };
  const clock = { now: () => 1234, schedule: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; }, cancel: () => {} };
  const monitor = createMacConnectorMonitor({ readers, storage: memory.storage, clock });
  const unsubscribe = monitor.subscribe(value => listeners.push(value));
  const configuration = { messages: true, whatsappConversations: [selected], keywords: defaultKeywords, intervalMinutes: 1 };
  const started = await monitor.start(configuration);
  assert.deepEqual(calls, [['messages', ''], ['whatsapp', selected.jid]]);
  assert.deepEqual(memory.saved(), configuration);
  assert.equal(started.snapshot.messageThreads.length, 50);
  assert.equal(started.snapshot.whatsappObservations.length, 100);
  assert.deepEqual(started.snapshot.urgencyHints.map(item => [item.source, item.keywords]), [['messages', ['urgent', 'needs help']], ['whatsapp', ['asap']]]);
  assert.equal(scheduled[0].delay, 60_000);
  unsubscribe();
  messages = [thread('new', 'Immediate deadline'), ...messages];
  await monitor.refresh();
  assert.equal(monitor.getState().running, true);
  assert.deepEqual(monitor.getState().snapshot.urgencyHints[0].keywords, ['deadline']);
  assert.equal(Object.keys(monitor).some(key => /send|write|execute|mutate/i.test(key)), false);
  monitor.shutdown();

  const resumed = createMacConnectorMonitor({ readers, storage: memory.storage, clock });
  await resumed.resume();
  assert.equal(resumed.getState().running, true);
  assert.deepEqual(resumed.getState().configuration, configuration);
  assert.deepEqual(resumed.getState().snapshot.urgencyHints, [], 'resume baselines existing messages');
  assert.deepEqual(calls.at(-1), ['whatsapp', selected.jid], 'restart preserves and reuses the exact stable JID');
  messages = [thread('after-resume', 'urgent after restart'), ...messages];
  await resumed.refresh();
  assert.deepEqual(resumed.getState().snapshot.urgencyHints.map(item => item.threadId), ['after-resume']);
  resumed.stop();
  assert.equal(memory.saved(), undefined);
});

test('monitor reads multiple explicitly selected stable JIDs and uses only the configured urgency keywords', async () => {
  const calls = [], memory = memoryStorage();
  const rows = new Map([
    [selected.jid, [observation('selected-one', 'VIP escalation required', false, selected.jid, selected.label)]],
    [selectedTwo.jid, [observation('selected-two', 'urgent using an unselected default', false, selectedTwo.jid, selectedTwo.label)]],
  ]);
  const monitor = createMacConnectorMonitor({
    readers: {
      listMessageThreads: async () => ({ threads: [] }),
      readWhatsAppConversation: async jid => {
        calls.push(jid);
        const target = jid === selected.jid ? selected : selectedTwo;
        return { conversation: target, observations: rows.get(jid) ?? [] };
      },
    },
    storage: memory.storage,
    clock: { now: () => 1, schedule: () => 1, cancel: () => {} },
  });
  const configuration = { messages: false, whatsappConversations: [selected, selectedTwo], keywords: ['vip escalation'], intervalMinutes: 5 };
  await monitor.start(configuration);
  assert.deepEqual(calls, [selected.jid, selectedTwo.jid]);
  assert.deepEqual(monitor.getState().snapshot.whatsappObservations.map(row => row.threadJid), [selected.jid, selectedTwo.jid]);
  assert.deepEqual(monitor.getState().snapshot.urgencyHints.map(item => [item.threadId, item.keywords]), [[selected.jid, ['vip escalation']]]);
  assert.deepEqual(memory.saved(), configuration);
  await assert.rejects(monitor.start({ ...configuration, whatsappConversations: Array.from({ length: 21 }, (_, index) => ({ jid: `jid-${index}`, label: `Label ${index}` })) }), /at most 20/);
  await assert.rejects(monitor.start({ ...configuration, whatsappConversations: [selected, selected], keywords: ['vip escalation'] }), /only once/);
  await assert.rejects(monitor.start({ ...configuration, keywords: [] }), /1 to 20/);
});

test('same names and matching message text in another WhatsApp thread never cross the selected JID boundary', async () => {
  const otherJid = '120363000000002@g.us';
  let rows = [
    observation('selected', 'same renewal text urgent', false, selected.jid, 'Duplicate display name'),
    observation('other', 'same renewal text urgent', false, otherJid, 'Duplicate display name'),
  ];
  const calls = [], memory = memoryStorage();
  const monitor = createMacConnectorMonitor({
    readers: exactReader(() => rows, calls), storage: memory.storage,
    clock: { now: () => 1, schedule: () => 1, cancel: () => {} },
  });
  await monitor.start({ messages: false, whatsappConversations: [{ ...selected, label: 'Duplicate display name' }], keywords: ['urgent'], intervalMinutes: 5 });
  assert.deepEqual(calls, [['whatsapp', selected.jid]], 'the free-text label and message body are never used as the read key');
  assert.deepEqual(monitor.getState().snapshot.whatsappObservations, []);
  assert.ok(monitor.getState().snapshot.errors.some(item => /different thread/.test(item.message)));

  rows = [observation('selected', 'same renewal text urgent', false, selected.jid, 'Duplicate display name')];
  await monitor.refresh();
  assert.deepEqual(monitor.getState().snapshot.whatsappObservations.map(row => row.threadJid), [selected.jid]);
  assert.equal(monitor.getState().snapshot.whatsappObservations.some(row => row.threadJid === otherJid), false);
});

test('missing or changed WhatsApp identities fail closed while a label change on the same JID remains bound', async () => {
  let mode = 'missing';
  const readers = {
    listMessageThreads: async () => ({ threads: [] }),
    readWhatsAppConversation: async jid => {
      if (mode === 'missing') throw new Error('The selected WhatsApp conversation is no longer available. Select it again.');
      if (mode === 'changed') return { conversation: { jid: 'changed@g.us', label: 'Replacement' }, observations: [observation('changed', 'urgent', false, 'changed@g.us', 'Replacement')] };
      return { conversation: { jid, label: 'Renamed conversation' }, observations: [observation('renamed', 'urgent', false, jid, 'Renamed conversation')] };
    },
  };
  const monitor = createMacConnectorMonitor({ readers, storage: memoryStorage().storage, clock: { now: () => 1, schedule: () => 1, cancel: () => {} } });
  await monitor.start({ messages: false, whatsappConversations: [selected], keywords: ['urgent'], intervalMinutes: 5 });
  assert.deepEqual(monitor.getState().snapshot.whatsappObservations, []);
  assert.match(monitor.getState().snapshot.errors[0].message, /no longer available/);
  mode = 'changed'; await monitor.refresh();
  assert.deepEqual(monitor.getState().snapshot.whatsappObservations, []);
  assert.match(monitor.getState().snapshot.errors[0].message, /identity changed/);
  mode = 'renamed'; await monitor.refresh();
  assert.deepEqual(monitor.getState().snapshot.whatsappObservations.map(row => [row.threadJid, row.threadTitle]), [[selected.jid, 'Renamed conversation']]);
  assert.match(monitor.getState().snapshot.errors[0].message, /label changed.*stable JID still matches/i);
  assert.deepEqual(monitor.getState().configuration.whatsappConversations, [selected], 'the reviewed label remains in the durable configuration');
});

test('monitor stays quiet for unchanged observations and hints only inbound-like keyword matches', async () => {
  const states = [], memory = memoryStorage();
  let rows = [thread('outgoing', 'urgent', true), thread('neutral', 'hello', false)];
  let wa = [observation('outgoing', 'emergency', true), observation('incoming', 'time sensitive request', false)];
  const monitor = createMacConnectorMonitor({
    readers: { listMessageThreads: async () => ({ threads: rows }), readWhatsAppConversation: async jid => ({ conversation: { jid, label: selected.label }, observations: wa }) },
    storage: memory.storage,
    clock: { now: () => 1, schedule: () => 1, cancel: () => {} },
  });
  monitor.subscribe(state => states.push(state));
  await monitor.start({ messages: true, whatsappConversations: [selected], keywords: defaultKeywords, intervalMinutes: 5 });
  assert.equal(monitor.getState().snapshot.urgencyHints[0].source, 'whatsapp');
  const count = states.length;
  await monitor.refresh();
  assert.equal(states.length, count + 1, 'one empty snapshot clears the prior urgency hint');
  assert.deepEqual(monitor.getState().snapshot.urgencyHints, []);
  const clearedCount = states.length;
  await monitor.refresh();
  assert.equal(states.length, clearedCount, 'later unchanged reads stay quiet');
  rows = [thread('incoming-new', 'Need HELP now', false), ...rows]; wa = [...wa];
  await monitor.refresh();
  assert.deepEqual(monitor.getState().snapshot.urgencyHints.map(item => item.source), ['messages']);
});

test('monitor settings are encrypted and atomic; legacy query monitors fail closed without reading WhatsApp', async () => {
  const target = path.join(directory, 'profile', 'monitor.secure');
  const codec = {
    encode: plaintext => `cipher:${Buffer.from(plaintext).toString('base64')}`,
    decode: stored => Buffer.from(stored.slice('cipher:'.length), 'base64').toString('utf8'),
  };
  const file = createFileMacMonitorStorage(target, codec);
  const configuration = { messages: true, whatsappConversations: [selected], keywords: defaultKeywords, intervalMinutes: 5 };
  file.save(configuration);
  assert.deepEqual(file.load(), configuration);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  assert.doesNotMatch(fs.readFileSync(target, 'utf8'), /Synthetic Sales Team|120363/);

  const legacySingle = { messages: false, whatsappConversation: selected, intervalMinutes: 6 };
  file.save(legacySingle);
  const singleConversation = createMacConnectorMonitor({ readers: exactReader(() => []), storage: file,
    clock: { now: () => 1, schedule: () => 1, cancel: () => {} } });
  const migrated = await singleConversation.resume();
  assert.deepEqual(migrated.configuration, { messages: false, whatsappConversations: [selected], keywords: defaultKeywords, intervalMinutes: 6 });
  assert.deepEqual(file.load(), migrated.configuration, 'the former one-conversation shape is rewritten in the current encrypted schema');
  assert.doesNotMatch(fs.readFileSync(target, 'utf8'), /whatsappConversation|Synthetic Sales Team|120363/);
  singleConversation.shutdown();

  fs.writeFileSync(target, JSON.stringify({ messages: true, intervalMinutes: 7 }), { mode: 0o600 });
  const messagesOnly = createMacConnectorMonitor({ readers: exactReader(() => []), storage: file, clock: { now: () => 1, schedule: () => 1, cancel: () => {} } });
  assert.equal((await messagesOnly.resume()).running, true);
  assert.match(fs.readFileSync(target, 'utf8'), /^cipher:/, 'valid legacy Messages-only settings migrate to encrypted storage');
  messagesOnly.shutdown();

  const legacy = { messages: false, whatsappQuery: 'duplicate display name', intervalMinutes: 5 };
  fs.writeFileSync(target, JSON.stringify(legacy), { mode: 0o600 });
  let whatsappReads = 0;
  const legacyMonitor = createMacConnectorMonitor({
    readers: { listMessageThreads: async () => ({ threads: [] }), readWhatsAppConversation: async () => { whatsappReads++; return { conversation: selected, observations: [] }; } },
    storage: file,
  });
  const result = await legacyMonitor.resume();
  assert.equal(result.running, false);
  assert.match(result.error, /cannot be resumed safely/);
  assert.equal(whatsappReads, 0);
  assert.match(fs.readFileSync(target, 'utf8'), /^cipher:/, 'ambiguous legacy state is sealed before it remains stopped');
  assert.deepEqual(file.load(), legacy, 'legacy state stays fail-closed across restarts until explicit reconfiguration');
  file.clear();
  assert.equal(fs.existsSync(target), false);
});

test('authorized monitor binds encrypted settings and snapshots to the verified owner conversation', async () => {
  const memory = memoryStorage(), reads = [], signals = [];
  const ownerA = { version: 1, userId: 9, tenantId: 7, environment: 'production', conversationKey: 'main:owner-a', lineage: 'a'.repeat(64) };
  const ownerB = { ...ownerA, userId: 10, conversationKey: 'main:owner-b', lineage: 'b'.repeat(64) };
  const requestA = { bearerToken: 'TEST-a', agentId: 3, sessionId: 'session-a' };
  const replacementA = { bearerToken: 'TEST-a', agentId: 4, sessionId: 'session-replacement' };
  const requestB = { bearerToken: 'TEST-b', agentId: 5, sessionId: 'session-b' };
  const monitor = createAuthorizedMacConnectorMonitor({
    readers: {
      listMessageThreads: async () => { reads.push('messages'); return { threads: [thread('owner-a', 'private fixture')] }; },
      readWhatsAppConversation: async jid => ({ conversation: { jid, label: selected.label }, observations: [] }),
    },
    storage: memory.storage,
    verify: async request => request.bearerToken === 'TEST-a' ? ownerA : request.bearerToken === 'TEST-b' ? ownerB : Promise.reject(new Error('stale token')),
    clock: { now: () => 1, schedule: () => 1, cancel: () => {} },
  });
  monitor.subscribe((...args) => signals.push(args));
  const started = await monitor.start({ messages: true, intervalMinutes: 5 }, requestA);
  assert.equal(started.snapshot.messageThreads[0].lastMessage, 'private fixture');
  assert.deepEqual(memory.saved().owner, { userId: 9, tenantId: 7, environment: 'production', conversationKey: 'main:owner-a' });
  assert.equal(JSON.stringify(memory.saved()).includes('TEST-a'), false, 'bearer is never persisted');
  assert.equal(JSON.stringify(memory.saved()).includes('private fixture'), false, 'snapshots are never persisted');

  assert.deepEqual(await monitor.state(requestB), { running: false }, 'a different owner receives no prior state or snapshot');
  assert.deepEqual(await monitor.resume(requestB), { running: false }, 'predicting another owner conversation cannot resume its settings');
  assert.equal(reads.length, 1, 'cross-owner inspection performs no local provider read');

  assert.equal((await monitor.resume(replacementA)).running, true, 'replacement assistant for the same permanent owner conversation resumes safely');
  assert.equal(reads.length, 2);
  assert.ok(signals.length > 0);
  assert.ok(signals.every(args => args.length === 0), 'subscriptions expose only a data-free change signal');
  monitor.shutdown();
});
