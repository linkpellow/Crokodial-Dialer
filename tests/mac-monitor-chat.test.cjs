const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { _electron: electron } = require('playwright');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crokodial-monitor-chat-'));
buildSync({ entryPoints: ['src/renderer/services/macMonitorChatRequest.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(directory, 'parser.cjs') });
const { parseMacMonitorChatRequest } = require(path.join(directory, 'parser.cjs'));

test('local monitor intent is explicit, bounded, and does not capture Gmail monitoring', () => {
  assert.deepEqual(parseMacMonitorChatRequest('Monitor Apple Messages for keywords urgent and deadline every 7 minutes'), {
    kind: 'monitor.manage', operation: 'start', messages: true, whatsapp: false, whatsappQuery: '', keywords: ['urgent', 'deadline'], intervalMinutes: 7,
  });
  assert.deepEqual(parseMacMonitorChatRequest('Watch WhatsApp conversation with Fixture Client using keywords "urgent" and "asap"'), {
    kind: 'monitor.manage', operation: 'start', messages: false, whatsapp: true, whatsappQuery: 'Fixture Client', keywords: ['urgent', 'asap'], intervalMinutes: 5,
  });
  assert.equal(parseMacMonitorChatRequest('Monitor Gmail for urgent messages'), null);
  assert.equal(parseMacMonitorChatRequest('Tell me what monitoring means'), null);
  assert.equal(parseMacMonitorChatRequest('Monitor Apple Messages every 31 minutes'), null);
});

test('local monitor stop and status remain explicit chat controls', () => {
  assert.equal(parseMacMonitorChatRequest('Stop the Apple Messages monitor').operation, 'stop');
  assert.equal(parseMacMonitorChatRequest('Show local Mac monitor status').operation, 'status');
});

test('the permanent Personal Assistant conversation mounts the reconstructed monitor card', () => {
  const source = fs.readFileSync('src/renderer/components/PersonalAssistant.tsx', 'utf8');
  assert.match(source, /<InlineMacMonitorCard turnId=\{entry\.turn\.id\}/);
  const card = fs.readFileSync('src/renderer/components/InlineMacMonitorCard.tsx', 'utf8');
  assert.match(card, /Start this read-only monitor/);
  assert.match(card, /Stop and clear this local monitor/);
  assert.match(card, /Stable JID:/);
  assert.doesNotMatch(card, /sendMessage|executeMessageSend/);
});

test('inline monitor edits and pending start block discard until saved, then unmount clears the turn state', async () => {
  const fixtureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'crokodial-inline-monitor-state-'));
  const entry = path.join(fixtureDirectory, 'fixture.tsx');
  fs.writeFileSync(entry, `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { InlineMacMonitorCard } from ${JSON.stringify(path.resolve('src/renderer/components/InlineMacMonitorCard.tsx'))};
    const pending: Array<{ turnId: string; dirty: boolean; busy: boolean }> = [];
    const calls: unknown[] = [];
    const stopped = { running: false };
    let listener: (() => void) | undefined;
    localStorage.setItem('crokodial_auth_user', JSON.stringify({ id: 9, tenant_id: 7 }));
    localStorage.setItem('crokodial_auth_token', 'TEST-token');
    (window as any).dialer = { macConnectors: {
      monitorState: async () => stopped,
      resumeMonitor: async () => stopped,
      startMonitor: async (payload: any) => {
        calls.push(payload.configuration);
        await new Promise(resolve => setTimeout(resolve, 40));
        return { running: true, configuration: payload.configuration,
          snapshot: { observedAt: 1, messageThreads: [], whatsappObservations: [], urgencyHints: [], errors: [] } };
      },
      stopMonitor: async () => stopped,
      refreshMonitor: async () => stopped,
      onMonitorState: (callback: () => void) => { listener = callback; return () => { listener = undefined; }; },
    }};
    const root = createRoot(document.getElementById('root')!);
    (window as any).fixture = { pending, calls, unmount: () => root.unmount() };
    root.render(<InlineMacMonitorCard turnId="saved-monitor-turn" persisted={true}
      text="Monitor Apple Messages for keyword urgent every 7 minutes" agentId={3} sessionId="synthetic-session"
      onPendingStateChange={(turnId, state) => pending.push({ turnId, ...state })}/>);
  `);
  buildSync({ entryPoints: [entry], bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
    nodePaths: [path.resolve('node_modules')], outfile: path.join(fixtureDirectory, 'fixture.js') });
  fs.writeFileSync(path.join(fixtureDirectory, 'index.html'), '<!doctype html><html><body><div id="root"></div><script src="fixture.js"></script></body></html>');
  fs.writeFileSync(path.join(fixtureDirectory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(async()=>{const window=new BrowserWindow({show:false,webPreferences:{contextIsolation:false,nodeIntegration:false}});await window.loadFile(${JSON.stringify(path.join(fixtureDirectory, 'index.html'))});});`);

  const app = await electron.launch({ executablePath: require('electron'), args: [path.join(fixtureDirectory, 'main.cjs')] });
  try {
    const page = await app.firstWindow();
    const card = page.getByRole('article', { name: 'Local read monitor request for saved message' });
    await card.getByRole('button', { name: 'Start this read-only monitor' }).waitFor();
    await page.waitForFunction(() => window.fixture.pending.at(-1)?.dirty === false && window.fixture.pending.at(-1)?.busy === false);

    await card.getByLabel('Check every (minutes)').fill('9');
    await page.waitForFunction(() => window.fixture.pending.at(-1)?.dirty === true);
    await card.getByRole('button', { name: 'Start this read-only monitor' }).click();
    await page.waitForFunction(() => window.fixture.pending.some(state => state.busy === true));
    await page.waitForFunction(() => window.fixture.pending.at(-1)?.dirty === false && window.fixture.pending.at(-1)?.busy === false);

    assert.deepEqual(await page.evaluate(() => window.fixture.calls), [{
      messages: true, whatsappConversations: [], keywords: ['urgent'], intervalMinutes: 9,
    }]);
    await card.getByLabel('Watch recent Apple Messages threads').uncheck();
    await page.waitForFunction(() => window.fixture.pending.at(-1)?.dirty === true);
    await page.evaluate(() => window.fixture.unmount());
    await page.waitForFunction(() => window.fixture.pending.at(-1)?.dirty === false && window.fixture.pending.at(-1)?.busy === false);
    const states = await page.evaluate(() => window.fixture.pending);
    assert.ok(states.some(state => state.dirty), 'an unsaved inline edit must block silent discard');
    assert.ok(states.some(state => state.busy), 'an in-flight monitor start must report pending work');
    assert.deepEqual(states.at(-1), { turnId: 'saved-monitor-turn', dirty: false, busy: false });
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(fixtureDirectory, { recursive: true, force: true });
  }
});
