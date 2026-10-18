const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { _electron: electron } = require('playwright');

test('hidden native main chat performs reviewed Calendar CRUD without a real provider write', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crokodial-calendar-chat-native-'));
  const entry = path.join(directory, 'fixture.tsx');
  fs.writeFileSync(entry, `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { InlineGoogleCalendarCard } from ${JSON.stringify(path.resolve('src/renderer/components/InlineGoogleCalendarCard.tsx'))};
    const requests: any[] = [], grants: any[] = [], pending: any[] = [];
    const capabilities = ['read','create','update','delete'].map(operation => ({ id: 'calendar.google.' + operation, available: true, reason: 'Fixture Calendar connected.' }));
    const event = { id: 'fixture_event_123', title: 'Fixture review', start: '2030-10-20T14:00:00.000Z', end: '2030-10-20T15:00:00.000Z', startTimeZone: null, endTimeZone: null, allDay: false, status: 'confirmed', description: 'Fixture description', location: 'Fixture room', attendeeEmails: ['owner@example.test'], revision: 'fixture-etag', updated: '2030-10-19T12:00:00.000Z' };
    (window as any).fixture = { requests, grants, pending };
    localStorage.setItem('crokodial_auth_user', JSON.stringify({ id: 11, tenant_id: 9 }));
    localStorage.setItem('crokodial_auth_token', 'TEST-token');
    (window as any).fetch = async (input: string, init: RequestInit = {}) => {
      const url = new URL(String(input)), method = init.method || 'GET', body = init.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ path: url.pathname, method, body });
      let data: any;
      if (url.pathname.endsWith('/tools') && method === 'GET') data = { capabilities, grants };
      else if (url.pathname.endsWith('/tools/requests')) {
        const args = ['calendar.google.update','calendar.google.delete'].includes(body.tool) && !body.args.expectedRevision
          ? { ...body.args, expectedRevision: event.revision } : body.args;
        const grant = { id: '00000000-0000-4000-8000-' + String(grants.length + 1).padStart(12, '0'), requestKey: body.requestId, tool: body.tool, revision: 1,
          payloadDigest: String(grants.length + 1).repeat(64).slice(0,64), destination: 'Google Calendar: fixture@example.test', args,
          targetSnapshot: ['calendar.google.update','calendar.google.delete'].includes(body.tool) ? event : null,
          state: 'pending', createdAt: Date.now(), expiresAt: Date.now() + 60000, result: null, message: null };
        grants.unshift(grant); data = { kind: 'grant', grant };
      } else if (url.pathname.endsWith('/decision')) {
        const grant = grants.find(item => url.pathname.includes(item.id)); grant.state = body.decision === 'approve' ? 'approved' : 'rejected'; data = { grant };
      } else if (url.pathname.endsWith('/execute')) {
        const grant = grants.find(item => url.pathname.includes(item.id)); grant.state = 'succeeded'; grant.message = 'Fixture exact Calendar request completed.';
        grant.result = grant.tool === 'calendar.google.read' ? { observedAt: Date.now(), events: [event], total: 1, truncated: false }
          : grant.tool === 'calendar.google.delete' ? { operation: 'delete', submittedAt: Date.now(), eventId: grant.args.eventId, event: null, reconciled: false }
            : { operation: grant.tool.endsWith('create') ? 'create' : 'update', submittedAt: Date.now(), eventId: event.id,
                event: { ...event, title: grant.args.event.title }, reconciled: false };
        data = { grant };
      } else return new Response(JSON.stringify({ error: { message: 'Unexpected fixture route ' + url.pathname } }), { status: 404, headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const root = createRoot(document.getElementById('root')!);
    (window as any).fixture.unmount = () => root.unmount();
    const onPendingStateChange = (turnId: string, state: any) => pending.push({ turnId, ...state });
    root.render(<main>
      <InlineGoogleCalendarCard turnId="calendar-create" requestId="11111111-1111-4111-8111-111111111111" persisted={true} agentId={7} text={'Create a Google Calendar event titled "Fixture review"'} onPendingStateChange={onPendingStateChange}/>
      <InlineGoogleCalendarCard turnId="calendar-read" requestId="22222222-2222-4222-8222-222222222222" persisted={true} agentId={7} text="Show my Google Calendar" onPendingStateChange={onPendingStateChange}/>
    </main>);
  `);
  buildSync({ entryPoints: [entry], bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', nodePaths: [path.resolve('node_modules')], define: { 'import.meta.env.VITE_API_BASE': '"https://fixture.invalid"' }, outfile: path.join(directory, 'fixture.js') });
  fs.writeFileSync(path.join(directory, 'index.html'), '<!doctype html><html><body><div id="root"></div><script src="fixture.js"></script></body></html>');
  fs.writeFileSync(path.join(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(async()=>{const window=new BrowserWindow({show:false,webPreferences:{contextIsolation:false,nodeIntegration:false}});await window.loadFile(${JSON.stringify(path.join(directory, 'index.html'))});});`);

  const app = await electron.launch({ executablePath: require('electron'), args: [path.join(directory, 'main.cjs')] });
  try {
    const page = await app.firstWindow();
    const cards = page.getByRole('article', { name: 'Google Calendar request for saved message' });
    await cards.nth(1).getByRole('button', { name: 'Review exact date range' }).waitFor();
    assert.equal(await page.evaluate(() => window.fixture.requests.filter(item => item.path.endsWith('/execute')).length), 0);
    assert.deepEqual(await page.evaluate(() => ['calendar-create', 'calendar-read'].map(turnId =>
      window.fixture.pending.filter(item => item.turnId === turnId).at(-1))), [
      { turnId: 'calendar-create', dirty: false, busy: false },
      { turnId: 'calendar-read', dirty: false, busy: false },
    ], 'saved Calendar defaults must not block app close as unsaved work');

    const create = cards.nth(0);
    await create.getByLabel('Inline Calendar start').fill('2030-10-20T10:00');
    await page.waitForFunction(() => window.fixture.pending.filter(item => item.turnId === 'calendar-create').at(-1)?.dirty === true);
    await create.getByLabel('Inline Calendar end').fill('2030-10-20T11:00');
    await create.getByLabel('Calendar guest notifications').selectOption('all');
    await create.getByRole('button', { name: 'Review exact event creation' }).click();
    await page.waitForFunction(() => {
      const state = window.fixture.pending.filter(item => item.turnId === 'calendar-create').at(-1);
      return state?.dirty === false && state?.busy === false;
    });
    assert.equal(await page.evaluate(() => window.fixture.requests.filter(item => item.path.endsWith('/execute')).length), 0, 'preparing a grant must never call the provider path');
    await create.getByRole('button', { name: 'Approve exact calendar change' }).click();
    await create.getByText('Fixture exact Calendar request completed.').waitFor();

    const read = cards.nth(1);
    await read.getByLabel('Inline Calendar start').fill('2030-10-20T00:00');
    await read.getByLabel('Inline Calendar end').fill('2030-10-21T00:00');
    await read.getByRole('button', { name: 'Review exact date range' }).click();
    await read.getByRole('button', { name: 'Approve and read' }).click();
    await read.getByText(/Fixture review/).waitFor();

    await read.getByRole('button', { name: 'Prepare exact update' }).click();
    await read.getByLabel('Calendar event title').fill('Revised fixture review');
    await read.getByLabel('Calendar guest notifications').selectOption('externalOnly');
    await read.getByRole('button', { name: 'Review exact event update' }).click();
    await read.getByRole('button', { name: 'Approve exact calendar change' }).click();
    await read.getByText('Fixture exact Calendar request completed.').last().waitFor();

    await read.getByRole('button', { name: 'Prepare exact deletion' }).first().click();
    await read.getByLabel('Calendar guest notifications').selectOption('all');
    await read.getByRole('button', { name: 'Review exact deletion' }).click();
    await read.getByRole('button', { name: 'Approve exact calendar change' }).click();
    await page.waitForFunction(() => window.fixture.requests.filter(item => item.path.endsWith('/execute')).length === 4);

    const prepared = await page.evaluate(() => window.fixture.requests.filter(item => item.path.endsWith('/tools/requests')).map(item => item.body));
    assert.deepEqual(prepared.map(item => item.tool), ['calendar.google.create', 'calendar.google.read', 'calendar.google.update', 'calendar.google.delete']);
    assert.equal(prepared[0].args.event.title, 'Fixture review');
    assert.equal(prepared[0].args.event.sendUpdates, 'all');
    assert.equal(prepared[2].args.eventId, 'fixture_event_123');
    assert.equal(prepared[2].args.expectedRevision, 'fixture-etag');
    assert.equal(prepared[2].args.event.title, 'Revised fixture review');
    assert.equal(prepared[2].args.event.sendUpdates, 'externalOnly');
    assert.equal(prepared[3].args.eventId, 'fixture_event_123');
    assert.equal(prepared[3].args.expectedRevision, 'fixture-etag');
    assert.equal(prepared[3].args.sendUpdates, 'all');
    assert.equal(await page.evaluate(() => window.fixture.requests.filter(item => item.path.endsWith('/execute')).length), 4);
    await page.evaluate(() => window.fixture.unmount());
    assert.deepEqual(await page.evaluate(() => ['calendar-create', 'calendar-read'].map(turnId =>
      window.fixture.pending.filter(item => item.turnId === turnId).at(-1))), [
      { turnId: 'calendar-create', dirty: false, busy: false },
      { turnId: 'calendar-read', dirty: false, busy: false },
    ], 'unmount must clear every inline pending-work entry');
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
