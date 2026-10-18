const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { _electron: electron } = require('playwright');

test('hidden native fixture performs local reads and one-use reviews without real side effects', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crokodial-mac-chat-native-'));
  const entry = path.join(directory, 'fixture.tsx');
  fs.writeFileSync(entry, `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { InlineMacRequestCard } from ${JSON.stringify(path.resolve('src/renderer/components/InlineMacRequestCard.tsx'))};
    const calls: Array<{ operation: string; args: unknown[] }> = [];
    const thread = { id: 'fixture-thread', title: 'Fixture Person', participants: ['+12694621403'], service: 'iMessage', lastMessage: 'Prior fixture message', lastMessageAt: '2030-10-18T03:00:00Z', lastMessageFromMe: false };
    const message = { id: 'fixture-message', text: 'Prior fixture message', sender: '+12694621403', fromMe: false, sentAt: '2030-10-18T03:00:00Z' };
    const availableStatus = { platform: 'macos', contacts: { state: 'available', detail: 'Fixture Contacts available.' }, messagesHistory: { state: 'available', detail: 'Fixture Messages history available.' }, messagesSend: { state: 'available', detail: 'Fixture Messages send review available.' }, whatsapp: { state: 'available', detail: 'Fixture WhatsApp read-only available.' }, smsDraft: { state: 'available', detail: 'Fixture SMS handoff available.' } };
    const review = (kind: string, payload: unknown) => ({ id: kind === 'messages.send' ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222', kind, digest: 'a'.repeat(64), summary: kind === 'messages.send' ? 'Submit one fixture message' : 'Open an unsent fixture draft', payload, createdAt: Date.now(), expiresAt: Date.now() + 60_000 });
    const record = (operation: string, ...args: unknown[]) => calls.push({ operation, args });
    (window as any).fixture = { calls };
    localStorage.setItem('crokodial_auth_user', JSON.stringify({ id: 9, tenant_id: 7 }));
    localStorage.setItem('crokodial_auth_token', 'TEST-token');
    (window as any).dialer = { macConnectors: {
      status: async () => { record('status'); return availableStatus; },
      requestAccess: async (connector: string) => { record('requestAccess', connector); return availableStatus; },
      searchContacts: async (query: string) => { record('searchContacts', query); return { contacts: [{ id: 'contact-1', name: 'Fixture Person', firstName: 'Fixture', lastName: 'Person', organization: '', emails: [], phones: ['+1 (269) 462-1403'] }] }; },
      previewContactDuplicates: async () => ({ groups: [], truncated: false }),
      prepareContactChange: async () => { throw new Error('not used'); }, executeContactChange: async () => { throw new Error('not used'); },
      listMessageThreads: async (query: string) => { record('listMessageThreads', query); return { threads: [thread] }; },
      readMessageThread: async (id: string) => { record('readMessageThread', id); return { thread, messages: [message] }; },
      prepareMessageSend: async (input: any) => { record('prepareMessageSend', input); return { ...review('messages.send', { thread, text: input.text }), context: input.context, state: 'pending' }; },
      executeMessageSend: async (binding: any) => { record('executeMessageSend', binding); return { state: 'submitted', message: 'Fixture accepted once; delivery unconfirmed.', reviewId: binding.id }; },
      restoreReviewedWrite: async () => ({ state: 'none', nextRevision: 1 }),
      listReviewedWrites: async () => ({ records: [], truncated: false }),
      reconcileReviewedWrite: async () => { throw new Error('not used'); },
      searchWhatsApp: async (query: string) => { record('searchWhatsApp', query); return { readOnly: true, observations: [{ id: 'wa-1', threadId: 'wa-thread', threadJid: '120363000000001@g.us', threadTitle: 'Fixture WhatsApp', sender: 'Fixture', text: 'Renewal fixture', fromMe: false, sentAt: '2030-10-18T02:00:00Z' }] }; },
      prepareSmsDraft: async (input: any) => { record('prepareSmsDraft', input); return review('sms.compose', input); },
      openSmsDraft: async (binding: any) => { record('openSmsDraft', binding); return { state: 'opened', message: 'Fixture system compose opened unsent.', reviewId: binding.id }; },
    }};
    createRoot(document.getElementById('root')!).render(<main>
      <InlineMacRequestCard turnId="saved-message" requestId="saved-request" persisted={true} agentId={3} sessionId="active-session" conversationKey="main:owner:permanent" text="Text Fixture Person saying Exact fixture reply!"/>
      <InlineMacRequestCard turnId="saved-contact" text="Who is +1 (269) 462-1403?"/>
      <InlineMacRequestCard turnId="saved-whatsapp" text="Search WhatsApp for renewal"/>
      <InlineMacRequestCard turnId="saved-sms" text="Open an unsent SMS draft to 2694621403 saying Exact SMS fixture."/>
    </main>);
  `);
  buildSync({ entryPoints: [entry], bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [path.resolve('node_modules')], outfile: path.join(directory, 'fixture.js') });
  fs.writeFileSync(path.join(directory, 'index.html'), '<!doctype html><html><body><div id="root"></div><script src="fixture.js"></script></body></html>');
  fs.writeFileSync(path.join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(async()=>{const window=new BrowserWindow({show:false,webPreferences:{contextIsolation:false,nodeIntegration:false}});await window.loadFile(${JSON.stringify(path.join(directory, 'index.html'))});});`);

  const app = await electron.launch({ executablePath: require('electron'), args: [path.join(directory, 'main.cjs')] });
  try {
    const page = await app.firstWindow();
    const savedMessage = page.getByRole('article', { name: 'Reviewed Messages request for saved message' });
    await savedMessage.waitFor();
    assert.deepEqual(await page.evaluate(() => window.fixture.calls), [], 'Reconstructing historical cards must perform zero local connector operations');
    await savedMessage.getByRole('button', { name: 'Find existing Messages thread' }).click();
    await savedMessage.getByText('Untrusted local evidence: verify thread participants and message content before acting.').waitFor();
    await savedMessage.getByRole('button', { name: 'Inspect thread before review' }).click();
    await savedMessage.getByText('Untrusted local evidence: confirm these participants before any send.').waitFor();
    await savedMessage.getByRole('button', { name: 'Check Messages send access' }).click();
    await savedMessage.getByRole('button', { name: 'Review exact send to this thread' }).click();
    assert.equal((await page.evaluate(() => window.fixture.calls.filter(call => call.operation === 'executeMessageSend').length)), 0, 'Preparing a review must not send');
    await savedMessage.getByRole('button', { name: 'Submit this exact message once' }).click();
    await savedMessage.getByText('Fixture accepted once; delivery unconfirmed.').waitFor();
    assert.equal((await page.evaluate(() => window.fixture.calls.filter(call => call.operation === 'executeMessageSend').length)), 1);
    assert.equal(await savedMessage.getByRole('button', { name: 'Submit this exact message once' }).count(), 0, 'Consumed review cannot be replayed');

    const savedContact = page.getByRole('article', { name: 'Local Contacts request for saved message' });
    await savedContact.getByRole('button', { name: 'Check Contacts access' }).click();
    await savedContact.getByRole('button', { name: 'Match number in Contacts' }).click();
    await savedContact.getByText('Untrusted local evidence: verify contact names and numbers before using them.').waitFor();
    assert.match(await savedContact.innerText(), /Fixture Person[\s\S]*269.*462.*1403/);

    const savedWhatsApp = page.getByRole('article', { name: 'Local WhatsApp read-only request for saved message' });
    await savedWhatsApp.getByRole('button', { name: 'Search local WhatsApp read-only' }).click();
    await savedWhatsApp.getByText('Untrusted local evidence: verify conversation identity and content before relying on it.').waitFor();

    const savedSms = page.getByRole('article', { name: 'Unsent SMS compose request for saved message' });
    await savedSms.getByRole('button', { name: 'Review recipient-only compose handoff' }).click();
    assert.equal((await page.evaluate(() => window.fixture.calls.filter(call => call.operation === 'openSmsDraft').length)), 0, 'Preparing an SMS handoff must not open anything');
    await savedSms.getByRole('button', { name: 'Open recipient-only unsent compose' }).click();
    await savedSms.getByText('Fixture system compose opened unsent.').waitFor();
    assert.equal((await page.evaluate(() => window.fixture.calls.filter(call => call.operation === 'openSmsDraft').length)), 1);

    const calls = await page.evaluate(() => window.fixture.calls);
    assert.deepEqual(calls.map(call => call.operation), ['listMessageThreads', 'readMessageThread', 'requestAccess', 'prepareMessageSend', 'executeMessageSend', 'requestAccess', 'searchContacts', 'searchWhatsApp', 'prepareSmsDraft', 'openSmsDraft']);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
