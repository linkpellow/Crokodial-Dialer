const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { _electron: electron } = require('playwright');

test('user adds and removes exact WhatsApp JIDs and urgency keywords before starting a read-only monitor', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crokodial-monitor-ui-'));
  const entry = path.join(directory, 'fixture.tsx');
  fs.writeFileSync(entry, `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { NativeMacConnectors } from ${JSON.stringify(path.resolve('src/renderer/components/assistant-workspace/NativeMacConnectors.tsx'))};
    import { NativeWorkStateProvider } from ${JSON.stringify(path.resolve('src/renderer/components/assistant-workspace/nativeWorkState.tsx'))};
    const calls: Array<{ operation: string; value?: unknown }> = [];
    const workStates: Array<{ dirty: boolean; busy: boolean }> = [];
    let listener: ((state: unknown) => void) | undefined;
    const stopped = { running: false };
    const status = { platform: 'macos', contacts: { state: 'available', detail: 'Synthetic' }, messagesHistory: { state: 'available', detail: 'Synthetic' }, messagesSend: { state: 'available', detail: 'Synthetic' }, whatsapp: { state: 'available', detail: 'Synthetic read only' }, smsDraft: { state: 'available', detail: 'Synthetic' } };
    localStorage.setItem('crokodial_auth_user', JSON.stringify({ id: 9, tenant_id: 7 }));
    localStorage.setItem('crokodial_auth_token', 'TEST-token');
    (window as any).fixture = { calls, workStates };
    (window as any).dialer = { macConnectors: {
      status: async () => status,
      requestAccess: async () => status,
      searchContacts: async () => ({ contacts: [] }), previewContactDuplicates: async () => ({ groups: [], truncated: false }),
      prepareContactChange: async () => { throw new Error('not used'); }, executeContactChange: async () => { throw new Error('not used'); },
      listMessageThreads: async () => ({ threads: [] }), readMessageThread: async () => { throw new Error('not used'); },
      prepareMessageSend: async () => { throw new Error('not used'); }, executeMessageSend: async () => { throw new Error('not used'); },
      restoreReviewedWrite: async () => ({ state: 'none', nextRevision: 1 }), listReviewedWrites: async () => ({ records: [], truncated: false }), reconcileReviewedWrite: async () => { throw new Error('not used'); },
      searchWhatsApp: async (query: string) => {
        calls.push({ operation: 'searchWhatsApp', value: query });
        return { readOnly: true, observations: [
          { id: 'wa-a', threadId: 'row-a', threadJid: '120363000000001@g.us', threadTitle: 'Same Sales Team', sender: 'Synthetic A', text: 'same renewal text', fromMe: false, sentAt: '2030-01-01T00:00:00Z' },
          { id: 'wa-b', threadId: 'row-b', threadJid: '120363000000002@g.us', threadTitle: 'Same Sales Team', sender: 'Synthetic B', text: 'same renewal text', fromMe: false, sentAt: '2030-01-01T00:01:00Z' },
        ] };
      },
      prepareSmsDraft: async () => { throw new Error('not used'); }, openSmsDraft: async () => { throw new Error('not used'); },
      monitorState: async () => stopped,
      resumeMonitor: async () => stopped,
      startMonitor: async (payload: any) => {
        calls.push({ operation: 'startMonitor', value: payload.configuration });
        const state = { running: true, configuration: payload.configuration, snapshot: { observedAt: 1, messageThreads: [], whatsappObservations: [], urgencyHints: [], errors: [] } };
        listener?.(); return state;
      },
      stopMonitor: async () => stopped,
      refreshMonitor: async () => stopped,
      onMonitorState: (callback: () => void) => { listener = callback; return () => { listener = undefined; }; },
    }};
    createRoot(document.getElementById('root')!).render(
      <NativeWorkStateProvider onStateChange={state => workStates.push(state)}>
        <NativeMacConnectors agentId={3} sessionId="synthetic-session" conversationKey="main:owner:permanent"/>
      </NativeWorkStateProvider>
    );
  `);
  buildSync({ entryPoints: [entry], bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [path.resolve('node_modules')], outfile: path.join(directory, 'fixture.js') });
  fs.writeFileSync(path.join(directory, 'index.html'), '<!doctype html><html><body><div id="root"></div><script src="fixture.js"></script></body></html>');
  fs.writeFileSync(path.join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(async()=>{const window=new BrowserWindow({show:false,webPreferences:{contextIsolation:false,nodeIntegration:false}});await window.loadFile(${JSON.stringify(path.join(directory, 'index.html'))});});`);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.join(directory, 'main.cjs')] });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => window.fixture.workStates.at(-1)?.dirty === false && window.fixture.workStates.at(-1)?.busy === false);
    const whatsapp = page.getByRole('article', { name: 'WhatsApp read-only search' });
    await whatsapp.getByLabel('Search local messages').fill('same renewal');
    await whatsapp.getByRole('button', { name: 'Search WhatsApp' }).click();
    const choices = whatsapp.getByRole('button', { name: 'Add this exact conversation' });
    await assert.doesNotReject(() => choices.nth(1).waitFor());
    assert.equal(await choices.count(), 2, 'same display names remain two explicit stable identities');
    await choices.nth(0).click();
    await page.waitForFunction(() => window.fixture.workStates.at(-1)?.dirty === true);
    await whatsapp.getByRole('button', { name: 'Add this exact conversation' }).click();

    const monitor = page.getByRole('article', { name: 'Local read monitor settings' });
    const selected = monitor.getByRole('group', { name: 'Selected WhatsApp monitor conversations' });
    await selected.getByText('120363000000001@g.us').waitFor();
    await selected.getByText('120363000000002@g.us').waitFor();
    await selected.getByRole('button', { name: 'Remove Same Sales Team (120363000000001@g.us)' }).click();
    await whatsapp.getByRole('button', { name: 'Add this exact conversation' }).click();
    const keywordGroup = monitor.getByRole('group', { name: 'Urgency keywords' });
    await keywordGroup.getByRole('button', { name: 'Remove urgency keyword asap' }).click();
    await keywordGroup.getByLabel('Add urgency keyword').fill('VIP escalation');
    await keywordGroup.getByRole('button', { name: 'Add keyword' }).click();
    await monitor.getByLabel('Watch recent Messages threads').uncheck();
    await monitor.getByRole('button', { name: 'Start monitor' }).click();
    await monitor.getByText(/WhatsApp \(2\):.*120363000000002@g\.us.*120363000000001@g\.us/).waitFor();
    await page.waitForFunction(() => window.fixture.workStates.at(-1)?.dirty === false && window.fixture.workStates.at(-1)?.busy === false);

    const calls = await page.evaluate(() => window.fixture.calls);
    const keywords = ['urgent', 'immediately', 'emergency', 'time sensitive', 'deadline', 'overdue', 'cancel today', 'need help', 'needs help', 'vip escalation'];
    assert.deepEqual(calls, [
      { operation: 'searchWhatsApp', value: 'same renewal' },
      { operation: 'startMonitor', value: { messages: false, whatsappConversations: [
        { jid: '120363000000002@g.us', label: 'Same Sales Team' },
        { jid: '120363000000001@g.us', label: 'Same Sales Team' },
      ], keywords, intervalMinutes: 5 } },
    ]);
    assert.equal(calls.some(call => /send|write|execute/i.test(call.operation)), false);
    assert.equal(JSON.stringify(calls).includes('whatsappQuery'), false);
    const workStates = await page.evaluate(() => window.fixture.workStates);
    assert.ok(workStates.some(state => state.dirty), 'editing monitor settings must block silent discard');
    assert.ok(workStates.some(state => state.busy), 'starting the monitor must report pending work');
    assert.deepEqual(workStates.at(-1), { dirty: false, busy: false }, 'a confirmed start saves the edited monitor settings');
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
