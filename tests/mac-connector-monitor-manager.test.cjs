const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crokodial-renderer-monitor-manager-'));
buildSync({ entryPoints: ['src/renderer/services/macConnectorMonitorManager.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(directory, 'manager.cjs') });
const manager = require(path.join(directory, 'manager.cjs'));
after(() => fs.rmSync(directory, { recursive: true, force: true }));

let calls, eventListener, nativeState;
const bridge = {
  monitorState: async payload => { calls.push(['state', payload]); return nativeState; },
  resumeMonitor: async payload => { calls.push(['resume', payload]); return nativeState; },
  startMonitor: async payload => { calls.push(['start', payload]); nativeState = { running: true, configuration: payload.configuration, snapshot: { observedAt: 1, messageThreads: [], whatsappObservations: [], urgencyHints: [], errors: [] } }; eventListener?.(); return nativeState; },
  stopMonitor: async payload => { calls.push(['stop', payload]); nativeState = { running: false }; eventListener?.(); return nativeState; },
  refreshMonitor: async payload => { calls.push(['refresh', payload]); return nativeState; },
  onMonitorState: callback => { calls.push(['subscribe']); eventListener = callback; return () => { eventListener = undefined; }; },
};

beforeEach(async () => {
  calls = []; nativeState = { running: false };
  global.localStorage = { getItem: key => key === 'crokodial_auth_token' ? 'TEST-token' : null, removeItem: () => {} };
  global.window = { dialer: { macConnectors: bridge } };
  await manager.stopMacMonitor({ agentId: 3, sessionId: 'active-session' }).catch(() => {});
  await new Promise(resolve => setImmediate(resolve)); calls = [];
});

test('renderer manager delegates lifecycle to narrow main-process IPC and relays bounded states', async () => {
  const authority = { agentId: 3, sessionId: 'active-session' }, transient = { bearerToken: 'TEST-token', ...authority };
  const states = [], unsubscribe = manager.subscribeMacMonitor(authority, value => states.push(value));
  await manager.resumeSavedMacMonitor(authority);
  const whatsappConversation = { jid: '120363000000001@g.us', label: 'Synthetic Sales Team' };
  await manager.startMacMonitor({ messages: true, whatsappConversation, intervalMinutes: 1 }, authority);
  assert.equal(manager.macMonitorState().running, true);
  assert.deepEqual(calls.filter(item => item[0] !== 'subscribe'), [
    ['state', { authority: transient }],
    ['resume', { authority: transient }],
    ['start', { configuration: { messages: true, whatsappConversation, intervalMinutes: 1 }, authority: transient }],
    ['state', { authority: transient }],
  ]);
  nativeState = { running: true, configuration: { messages: true, intervalMinutes: 1 }, snapshot: { observedAt: 2, messageThreads: Array(75).fill({}), whatsappObservations: Array(125).fill({}), urgencyHints: Array(25).fill({}), errors: [] } };
  eventListener();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.macMonitorState().snapshot.messageThreads.length, 50);
  assert.equal(manager.macMonitorState().snapshot.whatsappObservations.length, 100);
  assert.equal(manager.macMonitorState().snapshot.urgencyHints.length, 20);
  await manager.refreshMacMonitor(authority);
  await manager.stopMacMonitor(authority, false);
  assert.deepEqual(calls.filter(item => item[0] !== 'state').slice(-2),
    [['refresh', { authority: transient }], ['stop', { clearSaved: false, authority: transient }]]);
  assert.ok(states.some(value => value.snapshot));
  unsubscribe();
});

test('renderer rejects invalid configurations before invoking main and has no read or send primitive', async () => {
  const authority = { agentId: 3, sessionId: 'active-session' };
  await assert.rejects(manager.startMacMonitor({ messages: false, intervalMinutes: 5 }, authority), /exact WhatsApp/);
  await assert.rejects(manager.startMacMonitor({ messages: true, intervalMinutes: 31 }, authority), /Select Messages/);
  await assert.rejects(manager.startMacMonitor({ messages: false, whatsappQuery: 'sales', intervalMinutes: 5 }, authority), /exact WhatsApp/);
  await assert.rejects(manager.startMacMonitor({ messages: false, whatsappConversation: { jid: '', label: 'Sales' }, intervalMinutes: 5 }, authority), /exact WhatsApp/);
  assert.equal(calls.some(item => item[0] === 'start'), false);
  for (const forbidden of ['listMessageThreads', 'searchWhatsApp', 'send', 'write', 'execute']) assert.equal(forbidden in bridge, false);
});

test('renderer clears unbound legacy monitor settings without adopting or reading them', async () => {
  const removed = [];
  global.localStorage = {
    getItem: key => key === 'crokodial_auth_token' ? 'TEST-token'
      : key === 'crokodial.mac-read-monitor.v1' ? JSON.stringify({ messages: true, intervalMinutes: 1 }) : null,
    removeItem: key => removed.push(key),
  };
  const result = await manager.resumeSavedMacMonitor({ agentId: 3, sessionId: 'active-session' });
  assert.equal(result.running, false);
  assert.match(result.error, /Unbound saved monitor settings were cleared/);
  assert.deepEqual(removed, ['crokodial.mac-read-monitor.v1']);
  assert.equal(calls.some(item => item[0] === 'start'), false, 'unbound settings never become another owner\'s monitor');
});

test('a late prior-account state response cannot overwrite the current account monitor state', async () => {
  const originalState = bridge.monitorState, pending = [];
  bridge.monitorState = payload => new Promise(resolve => pending.push({ payload, resolve }));
  try {
    global.localStorage = { getItem: key => key === 'crokodial_auth_token' ? 'TEST-owner-a' : null, removeItem: () => {} };
    const ownerAStates = [], unsubscribeA = manager.subscribeMacMonitor({ agentId: 3, sessionId: 'owner-a-session' }, value => ownerAStates.push(value));
    global.localStorage = { getItem: key => key === 'crokodial_auth_token' ? 'TEST-owner-b' : null, removeItem: () => {} };
    const ownerBStates = [], unsubscribeB = manager.subscribeMacMonitor({ agentId: 4, sessionId: 'owner-b-session' }, value => ownerBStates.push(value));
    assert.equal(pending.length, 2);
    pending[1].resolve({ running: true, configuration: { messages: true, intervalMinutes: 1 },
      snapshot: { observedAt: 2, messageThreads: [{ id: 'owner-b' }], whatsappObservations: [], urgencyHints: [], errors: [] } });
    await new Promise(resolve => setImmediate(resolve));
    pending[0].resolve({ running: true, configuration: { messages: true, intervalMinutes: 1 },
      snapshot: { observedAt: 1, messageThreads: [{ id: 'owner-a-private' }], whatsappObservations: [], urgencyHints: [], errors: [] } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(manager.macMonitorState().snapshot.messageThreads[0].id, 'owner-b');
    assert.equal(JSON.stringify(ownerBStates).includes('owner-a-private'), false);
    unsubscribeA(); unsubscribeB();
  } finally { bridge.monitorState = originalState; }
});
