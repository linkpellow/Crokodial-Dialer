/* Real native renderer and shell, disposable profile, isolated provider/API fixtures.
 * These checks do not establish production/provider delivery. No real user session is read. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { hideNativeWindows } = require('./fixtures/hide-native-windows.cjs');

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-assistant-workflows-'));
  const app = await electron.launch({ executablePath: process.env.CROKODIAL_APP_EXECUTABLE || require('electron'), args: [path.resolve('.'), '--workspace=assistant'], env: { ...process.env, CROKODIAL_USER_DATA_DIR: profile, CROKODIAL_RENDERER_URL: '' } });
  let page;
  try {
    await hideNativeWindows(app);
    page = await app.firstWindow(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const capture = async name => { fs.mkdirSync('artifacts/native-assistant-workflows', { recursive: true }); await page.screenshot({ path: `artifacts/native-assistant-workflows/${name}.png`, animations: 'disabled', timeout: 5000 }); };
    await app.evaluate(({ ipcMain, session }) => {
      // No provider network request may escape this fixture process.
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
      const now = Date.now(), hash = 'a'.repeat(64);
      global.fixture = {
        requests: [], opened: [], connected: false, historyConnected: false,
        workspaceConnected: false, workspaceCapabilities: [], workspaceGrants: [],
        contactsConnected: false, contactsCapabilities: [], contactsGrants: [],
        calendarConnected: false, calendlyConnected: false,
        conversationKey: 'main:11:9:sandbox', sessionId: 'fixture-main-session', historyReads: [], messages: [], drafts: [], followUps: [], artifacts: [], tasks: [], grants: [], screenshots: [],
        businessActions: [], failNextMessage: false, messageReceipts: new Map(), uploads: [], reads: [],
      };
      const f = global.fixture, action = (id, summary) => ({ id, agentId: 7, kind: 'message.email', state: 'pending', summary, result: null, createdAt: now, expiresAt: now + 3600000 });
      const reply = (data, status = 200) => ({ ok: status < 400, status, statusText: 'Isolated fixture', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(status < 400 ? { success: true, data } : { success: false, error: { code: 'FIXTURE', message: data } }) });
      const activity = () => [
        ...f.drafts.map(x => ({ kind: 'email', title: x.subject, detail: x.email, status: x.status, entityId: x.id, id: `email:${x.id}`, createdAt: x.createdAt, updatedAt: x.updatedAt })),
        ...f.followUps.map(x => ({ kind: 'followup', title: x.subject, detail: x.email, status: x.status, entityId: x.id, id: `followup:${x.id}`, createdAt: x.createdAt, updatedAt: x.updatedAt })),
        ...f.screenshots.map(x => ({ kind: 'screenshot', title: x.filename, detail: 'Review screenshot', status: x.state, entityId: x.id, id: `screenshot:${x.id}`, createdAt: x.createdAt, updatedAt: x.updatedAt })),
        ...f.artifacts.map(x => ({ kind: 'artifact', title: x.artifact.title, detail: 'Saved document', status: 'saved', entityId: x.artifact.id, id: `artifact:${x.artifact.id}`, createdAt: x.artifact.createdAt, updatedAt: x.artifact.updatedAt })),
        ...f.tasks.map(x => ({ kind: 'background', title: x.objective, detail: 'Bounded task', status: x.status, entityId: x.id, id: `background:${x.id}`, createdAt: x.createdAt, updatedAt: x.updatedAt })),
      ];
      ipcMain.removeHandler('api-fetch');
      ipcMain.handle('api-fetch', async (_event, payload) => {
        const url = new URL(payload.url), p = url.pathname, method = payload.method || 'GET', b = payload.body ? JSON.parse(payload.body) : {};
        f.requests.push({ path: p, method, body: b });
        if (p === '/api/auth/me') return reply({ id: 11, name: 'Synthetic Workspace owner', email: 'owner@example.test', tenant_id: 9 });
        if (p === '/api/ai-agents') return reply([{ id: 7, name: 'Personal Assistant', role: 'personal_assistant' }]);
        if (p === '/api/insurance-plans') return reply({ plans: [] });
        if (p === '/api/dialer/voice-session') return reply('Calling disabled in isolated fixture', 403);
        if (p === '/api/phone-numbers' || p === '/api/appointments') return reply([]);
        if (p === '/api/auth/google/mail/status') return reply({ configured: true, connected: f.connected, historyConnected: f.historyConnected, connectUrl: '/api/auth/google/mail/connect', historyConnectUrl: '/api/auth/google/mail/history/connect' });
        if (p === '/api/auth/google/mail/desktop/connect') return reply({ authorizationUrl: `${url.origin}/api/auth/google/mail/desktop/authorize?ticket=fixture-once-ticket`, expiresAt: new Date(Date.now() + 60000).toISOString() });
        if (p === '/api/auth/google/workspace/status') return reply({ provider: 'google_workspace', configured: true, connected: f.workspaceConnected, email: f.workspaceConnected ? 'workspace@example.test' : null, generation: f.workspaceConnected ? 'workspace-1' : null, capabilities: f.workspaceCapabilities, missingCapabilities: ['drive_read', 'sheets_read', 'sheets_write'].filter(item => !f.workspaceCapabilities.includes(item)) });
        if (p === '/api/auth/google/workspace/desktop/connect') return reply({ authorizationUrl: `${url.origin}/api/auth/google/workspace/desktop/authorize?ticket=fixture-workspace-ticket`, expiresAt: new Date(Date.now() + 60000).toISOString(), capabilities: b.capabilities, oauthScopes: ['drive.metadata.readonly', 'spreadsheets'] });
        if (p === '/api/ai-agents/7/google-workspace/grants') return reply({ grants: f.workspaceGrants });
        if (p.includes('/google-workspace/grants/')) {
          const grant = f.workspaceGrants.find(item => p.includes(item.id)); if (!grant) return reply('No Workspace grant', 404);
          if (b.revision !== grant.revision || b.payloadDigest !== grant.payloadDigest) return reply('Grant mismatch', 409);
          if (p.endsWith('/decision')) grant.state = b.decision === 'approve' ? 'approved' : 'rejected';
          if (p.endsWith('/execute')) { grant.state = 'succeeded'; grant.message = 'Fixture Sheet row appended once.'; grant.result = { updatedRange: 'Sales!A2:C2', updatedRows: 1 }; }
          return reply({ grant });
        }
        if (p === '/api/auth/google/contacts/status') return reply({ provider: 'google_contacts', configured: true, connected: f.contactsConnected, email: f.contactsConnected ? 'contacts@example.test' : null, generation: f.contactsConnected ? 'contacts-1' : null, capabilities: f.contactsCapabilities, missingCapabilities: ['contacts_read', 'contacts_write'].filter(item => !f.contactsCapabilities.includes(item)) });
        if (p === '/api/auth/google/contacts/desktop/connect') return reply({ authorizationUrl: `${url.origin}/api/auth/google/contacts/desktop/authorize?ticket=fixture-contacts-ticket`, expiresAt: new Date(Date.now() + 60000).toISOString(), capabilities: b.capabilities, oauthScopes: b.capabilities.includes('contacts_write') ? ['contacts'] : ['contacts.readonly'] });
        if (p === '/api/ai-agents/7/google-contacts/grants') return reply({ grants: f.contactsGrants });
        if (p.includes('/google-contacts/grants/')) {
          const grant = f.contactsGrants.find(item => p.includes(item.id)); if (!grant) return reply('No Contacts grant', 404);
          if (b.revision !== grant.revision || b.payloadDigest !== grant.payloadDigest) return reply('Grant mismatch', 409);
          if (p.endsWith('/decision')) grant.state = b.decision === 'approve' ? 'approved' : 'rejected';
          if (p.endsWith('/execute')) { grant.state = 'succeeded'; grant.message = grant.tool === 'contacts.google.search' ? 'Fixture search completed.' : 'Fixture Google contact updated once.'; grant.result = grant.tool === 'contacts.google.search' ? { contacts: [{ resourceName: 'people/fixture', name: 'Synthetic Google Contact', email: 'person@example.test' }] } : { resourceName: 'people/fixture', updated: true }; }
          return reply({ grant });
        }
        if (p === '/api/auth/google/calendar/desktop/connect') return reply({ provider: 'google', authorizationUrl: `${url.origin}/api/auth/google/calendar/desktop/authorize?ticket=fixture-calendar-ticket`, expiresAt: new Date(Date.now() + 60000).toISOString(), oauthScopes: ['calendar.readonly'] });
        if (p === '/api/calendly/oauth/desktop/connect') return reply({ provider: 'calendly', authorizationUrl: `${url.origin}/api/calendly/oauth/desktop/authorize?ticket=fixture-calendly-ticket`, expiresAt: new Date(Date.now() + 60000).toISOString(), oauthScopes: ['default'] });
        if (p === '/api/ai-agents/7/business/scheduling/status') return reply({ calendly: { connected: f.calendlyConnected, syncEnabled: f.calendlyConnected, accountEmail: f.calendlyConnected ? 'calendly@example.test' : null, desktopConnect: { method: 'POST', path: '/api/calendly/oauth/desktop/connect' } }, google: { connected: f.calendarConnected, syncEnabled: f.calendarConnected, accountEmail: f.calendarConnected ? 'calendar@example.test' : null, desktopConnect: { method: 'POST', path: '/api/auth/google/calendar/desktop/connect' } } });
        if (p === '/api/ai-agents/7/business/scheduling/event-types') return reply({ eventTypes: [{ uri: 'https://api.calendly.com/event_types/fixture', name: 'Synthetic consultation', duration: 30, active: true }] });
        if (p === '/api/ai-agents/7/business/scheduling/availability') return reply({ slots: [{ startsAt: '2030-10-20T14:00:00.000Z', endsAt: '2030-10-20T14:30:00.000Z', timezone: url.searchParams.get('timezone') }], timezone: url.searchParams.get('timezone'), source: 'calendly' });
        if (p === '/api/ai-agents/7/business/scheduling/booking-links') {
          const item = { ...action(`business-action-${f.businessActions.length + 1}`, `Create one-use booking link for ${b.eventTypeUri}`), kind: 'calendar.booking_link' };
          f.businessActions.push(item); return reply({ action: item });
        }
        if (p === '/api/ai-agents/7/business/contacts' && method === 'GET') return reply({ contacts: [{ id: 42, name: 'Fixture Client', phone: '2694621403', email: 'fixture@example.test', city: 'Kalamazoo', state: 'MI', clientStatus: 'lead', updatedAt: new Date(now).toISOString() }] });
        if (p === '/api/ai-agents/7/business/contacts/duplicates') return reply({ candidates: [{ key: 'email:fixture@example.test', reasons: ['email'], contacts: [{ id: 42, name: 'Fixture Client', phone: '2694621403', email: 'fixture@example.test', city: 'Kalamazoo', state: 'MI', clientStatus: 'lead', updatedAt: new Date(now).toISOString() }, { id: 43, name: 'Fixture Client Copy', phone: null, email: 'fixture@example.test', city: null, state: null, clientStatus: 'lead', updatedAt: new Date(now).toISOString() }] }] });
        if (p === '/api/ai-agents/7/business/contacts/actions') {
          const item = { ...action(`business-action-${f.businessActions.length + 1}`, b.operation === 'create' ? `Create ${b.contact.firstName} ${b.contact.lastName} at ${b.contact.phone}` : `Update contact #${b.contactId}: ${JSON.stringify(b.patch)}`), kind: b.operation === 'create' ? 'contact.create' : 'contact.update' };
          f.businessActions.push(item); return reply({ action: item });
        }
        if (p === '/api/ai-agents/7/business/reports/sales') return reply({ report: { source: 'crokodial_crm', scope: 'tenant', start: url.searchParams.get('start'), end: url.searchParams.get('end'), newClientRecords: 7, distinctClientContacts: 6, activeClientRecords: 18, appointments: { total: 5, scheduled: 1, confirmed: 1, completed: 2, noShow: 1, cancelled: 0 }, daily: [{ date: '2030-10-01', clientRecords: 2 }], averageClientRecordsPerActiveDay: 2, longestDailyStreak: 3, premiumAvailable: false, observedAt: now } });
        if (/^\/api\/ai-agents\/7\/actions\/[^/]+\/decision$/.test(p)) {
          const item = f.businessActions.find(candidate => p.includes(candidate.id)); if (!item) return reply('No business action', 404);
          item.state = b.decision === 'approve' ? 'succeeded' : 'rejected'; item.result = { message: b.decision === 'approve' ? 'Fixture action completed once.' : 'Fixture action rejected.' }; return reply({ action: item });
        }
        if (p.endsWith('/intelligence/status')) return reply({ environment: 'sandbox', memoryMode: 'persistent', memoryEnabled: true, planningEnabled: true });
        if (p.endsWith('/conversation/session')) return reply({ sessionId: f.sessionId, conversationKey: f.conversationKey, memoryMode: 'persistent' });
        if (p.includes('/conversation/session/') && method === 'GET') {
          const before = Number(url.searchParams.get('before')) || Number.POSITIVE_INFINITY, eligible = f.messages.filter(message => message.sequence < before), messages = eligible.slice(-200);
          f.historyReads.push({ sessionId: p.split('/').at(-1), before: Number.isFinite(before) ? before : null });
          return f.failHistory ? reply('Synthetic history unavailable', 503) : reply({ sessionId: f.sessionId, conversationKey: f.conversationKey, messages, hasMore: eligible.length > messages.length, ...(eligible.length > messages.length ? { nextBefore: messages[0].sequence } : {}) });
        }
        if (p.endsWith('/conversation/activity')) return reply({ items: activity() });
        if (p.endsWith('/execution/events')) return reply({ events: [{ sequence: 1, requestId: url.searchParams.get('requestId'), state: 'running', reason: 'Preparing fixture response', channel: 'text', createdAt: now }] });
        if (p.endsWith('/conversation/message')) {
          const answer = b.message === 'Successful post with unavailable history' ? 'Accepted despite history refresh failure.'
            : b.message === 'Render safe assistant formatting' ? '# Fixture heading\n\n- **Reviewed** result\n- `bounded` tool\n\n| Field | Value |\n| --- | --- |\n| Source | CRM |\n\n<script>window.fixtureInjected=true</script> [unsafe](https://example.test)'
              : 'Saved native conversation reply.';
          if (!f.messageReceipts.has(b.requestId)) {
            const sequence = f.messages.reduce((highest, message) => Math.max(highest, message.sequence), 0);
            f.messages.push({ id: `${b.requestId}:user`, role: 'user', content: b.message, createdAt: Date.now(), requestId: b.requestId, sequence: sequence + 1 }, { id: `${b.requestId}:assistant`, role: 'assistant', content: answer, createdAt: Date.now() + 1, requestId: b.requestId, sequence: sequence + 2 });
            f.messageReceipts.set(b.requestId, true);
          }
          await new Promise(resolve => setTimeout(resolve, 150));
          if (f.failNextMessage) { f.failNextMessage = false; return reply('Synthetic uncertain transport outcome', 503); }
          return reply({ success: true, message: answer });
        }
        if (p.endsWith('/tools/contacts')) return reply({ contacts: [{ id: 21, name: 'Synthetic Client' }] });
        if (p.endsWith('/email-drafts/threads')) return reply({ threads: [{ threadId: 'linked-fixture-thread' }] });
        const emailBase = '/api/ai-agents/7/email-drafts';
        if (p === `${emailBase}/templates` && method === 'GET') return reply({ templates: [] });
        if (p === emailBase && method === 'GET') return reply({ drafts: f.drafts, capability: { available: f.connected, reason: f.connected ? 'Gmail is ready' : 'Connect Gmail' } });
        if (p === emailBase && method === 'POST') {
          if (f.delayEmailSave) await new Promise(resolve => setTimeout(resolve, 700));
          const id = f.drafts.length ? '12121212-1212-4212-8212-121212121212' : '11111111-1111-4111-8111-111111111111', contactId = b.content.contactId ?? null;
          const to = b.content.to?.map(item => item.email ? { ...item, source: 'owner_provided' } : { email: 'client@example.test', contactId: item.contactId, source: 'contact' }) ?? (contactId ? [{ email: 'client@example.test', contactId, source: 'contact' }] : []);
          const draft = { ...b.content, id, contactId, email: to[0]?.email ?? 'client@example.test', recipients: { to, cc: [], bcc: [] }, revision: 1, contentHash: hash, status: 'draft', action: null, mailbox: { provider: 'gmail', generation: 'mailbox-1', sender: 'owner@example.test' }, createdAt: now, updatedAt: Date.now(), attachments: b.content.attachments.map(a => ({ ...a, sha256: hash, byteSize: Buffer.from(a.base64, 'base64').length })) };
          f.drafts.push(draft); return reply(draft);
        }
        if (p.startsWith(`${emailBase}/`)) {
          const draft = f.drafts.find(x => p.includes(x.id)); if (!draft) return reply('No fixture draft', 404);
          if (p.endsWith('/review')) { if (b.expectedRevision !== draft.revision || b.contentHash !== draft.contentHash) return reply('Revision mismatch', 409); draft.action = action('email-action', `Send ${draft.subject}`); }
          else if (p.endsWith('/decision')) { if (b.expectedRevision !== draft.revision || b.contentHash !== draft.contentHash) return reply('Revision mismatch', 409); draft.action.state = b.decision === 'approve' ? 'submitted' : 'rejected'; draft.action.result = { message: b.decision === 'approve' ? 'Submitted to fixture Gmail; delivery unconfirmed.' : 'Rejected.' }; if (b.decision === 'approve') draft.status = 'submitted'; }
          else if (method === 'PUT') { if (b.expectedRevision !== draft.revision) return reply('Revision mismatch', 409); Object.assign(draft, b.content, { revision: draft.revision + 1, contentHash: 'b'.repeat(64), action: null, updatedAt: Date.now(), attachments: b.content.attachments.map(a => ({ ...a, sha256: hash, byteSize: Buffer.from(a.base64, 'base64').length })) }); }
          return reply(draft);
        }
        const followBase = '/api/ai-agents/7/conditional-followups';
        if (p === followBase && method === 'GET') return reply({ followUps: f.followUps, exclusions: [] });
        if (p === followBase && method === 'POST') { const draft = f.drafts.find(x => x.id === b.draftId); const item = { ...b, id: '22222222-2222-4222-8222-222222222222', revision: b.expectedRevision, subject: draft.subject, email: draft.email, contactId: draft.contactId, status: 'pending', reason: null, approvedAt: null, approvalExpiresAt: now + 3600000, providerMessageId: null, createdAt: now, updatedAt: Date.now() }; f.followUps.push(item); return reply({ followUp: item }); }
        if (p.startsWith(`${followBase}/`)) { const item = f.followUps.find(x => p.includes(x.id)); if (!item) return reply('No fixture follow-up', 404); item.status = ({ approve: 'scheduled', pause: 'paused', resume: 'scheduled', cancel: 'canceled' })[p.split('/').pop()] || item.status; return reply({ followUp: item }); }
        const artifactsBase = '/api/ai-agents/7/artifacts';
        if (p === artifactsBase && method === 'GET') return reply({ artifacts: f.artifacts.map(x => x.artifact) });
        if (p === artifactsBase && method === 'POST') { const version = { version: 1, html: b.html, source: b.source, byteSize: Buffer.byteLength(b.html), sha256: hash, request: null, validation: 'unverified', createdAt: now }; const detail = { artifact: { id: '33333333-3333-4333-8333-333333333333', title: b.title, currentVersion: 1, createdAt: now, updatedAt: Date.now() }, version, versions: [version] }; f.artifacts.push(detail); return reply(detail); }
        if (p.startsWith(`${artifactsBase}/`)) return reply(f.artifacts.find(x => p.includes(x.artifact.id)));
        const screenshotBase = '/api/ai-agents/7/screenshot-records';
        if (p === `${screenshotBase}/clients`) return reply({ clients: [{ id: 21, name: 'Synthetic Client', email: 'client@example.test', phone: null }] });
        if (p.startsWith(`${screenshotBase}/`)) {
          const record = f.screenshots.find(x => p.includes(x.id)); if (!record) return reply('No fixture record', 404);
          if (p.endsWith('/preview')) { record.fields = b.fields; record.preview = { digest: hash, client: { id: 21, name: 'Synthetic Client', email: 'client@example.test', phone: null }, fields: b.fields, changes: [{ field: 'memberId', current: 'OLD-123', proposed: b.fields.memberId, conflict: true, existingValues: ['OLD-123'] }] }; }
          if (p.endsWith('/apply')) { if (b.previewDigest !== hash || b.resolutions.memberId !== 'replace') return reply('Exact preview and resolution required', 409); record.state = 'applied'; record.receipt = { clientId: 21, clientName: 'Synthetic Client', appliedAt: Date.now(), changedFields: ['memberId'], keptFields: [], values: record.fields, sourceSha256: hash, destination: 'crokodial_crm' }; }
          return reply(record);
        }
        const backgroundBase = '/api/ai-agents/7/background';
        if (p === backgroundBase && method === 'GET') return reply({ tasks: f.tasks, notifications: [] });
        if (p === backgroundBase && method === 'POST') { const task = { ...b, id: `44444444-4444-4444-8444-${String(f.tasks.length + 1).padStart(12, '0')}`, agentId: 7, contactId: null, status: 'active', runCount: 0, spentMicros: 0, committedMicros: 0, nextDueAt: b.trigger.kind === 'once' ? b.trigger.at : now + 60000, latestRun: null, createdAt: now + f.tasks.length, updatedAt: Date.now() }; f.tasks.push(task); return reply({ task }); }
        if (p.startsWith(`${backgroundBase}/`)) { const task = f.tasks.find(x => p.includes(x.id)); if (!task) return reply('No fixture task', 404); task.status = ({ pause: 'paused', resume: 'active', cancel: 'canceled' })[p.split('/').pop()] || task.status; return reply({ task, runs: [] }); }
        if (p.endsWith('/tools') && method === 'GET') return reply({ capabilities: [{ id: 'calendar.google.read', name: 'Calendar', available: true, reason: 'Fixture connected calendar' }, { id: 'crm.notes.append', name: 'Contact notes', available: true, reason: 'Approval required' }], grants: f.grants });
        if (p.endsWith('/tools/requests')) { const grant = { id: '55555555-5555-4555-8555-555555555555', agentId: 7, tool: b.tool, revision: 1, payloadDigest: hash, args: b.args, destination: 'Fixture calendar', state: 'pending', expiresAt: now + 3600000, createdAt: now, message: null, result: null }; f.grants.push(grant); return reply({ kind: 'grant', grant }); }
        if (p.includes('/tools/grants/')) { const grant = f.grants[0]; if (b.payloadDigest !== grant.payloadDigest || b.revision !== 1) return reply('Grant mismatch', 409); if (p.endsWith('/decision')) grant.state = b.decision === 'approve' ? 'approved' : 'rejected'; if (p.endsWith('/execute')) { grant.state = 'succeeded'; grant.result = { observedAt: Date.now(), events: [{ id: 'event1', title: 'Synthetic appointment', start: '2026-10-19T10:00:00Z', end: '2026-10-19T11:00:00Z', allDay: false }], truncated: false }; } return reply({ grant }); }
        if (p.endsWith('/qualification')) return reply({ routingEnabled: false, routingMode: 'cloud', task: 'assistant', channel: 'text', limits: { maximumTurnChargeMicros: 10000 }, profiles: [], localDevices: [] });
        return reply(`Unhandled isolated route: ${method} ${p}`, 404);
      });
      ipcMain.removeHandler('open-external'); ipcMain.handle('open-external', (_event, url) => { f.opened.push(url); });
      for (const name of ['assistant-screenshot-upload', 'assistant-screenshot-read']) ipcMain.removeHandler(name);
      ipcMain.handle('assistant-screenshot-upload', (_event, payload) => {
        f.uploads.push({ ...payload, token: undefined });
        const record = { id: '66666666-6666-4666-8666-666666666666', filename: payload.filename, state: 'review', text: 'Fixture policy NEW-123', extractionError: null, fields: { memberId: 'NEW-123' }, identity: { name: 'Synthetic Client' }, preview: null, receipt: null, clientName: null, createdAt: now, updatedAt: now };
        f.screenshots.push(record); return reply(record);
      });
      ipcMain.handle('assistant-screenshot-read', (_event, payload) => { f.reads.push(payload.recordId); return { ok: true, status: 200, statusText: 'Fixture', headers: {}, contentType: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=' }; });
    });
    await page.evaluate(() => { localStorage.setItem('crokodial_auth_token', 'isolated-native-workflow-token'); localStorage.setItem('crokodial_auth_user', JSON.stringify({ id: 11, name: 'Synthetic Workspace owner', tenant_id: 9 })); });
    await page.reload();
    assert.equal(await page.getByRole('tab', { name: 'Assistant', exact: true }).getAttribute('aria-selected'), 'true', 'Explicit workspace launch opens the Personal Assistant first');
    await page.getByRole('tab', { name: 'Assistant', exact: true }).click();
    await page.getByRole('button', { name: 'Connect Gmail', exact: true }).waitFor();
    assert.deepEqual((await app.evaluate(() => global.fixture.requests)).find(request => request.path.endsWith('/conversation/session') && request.method === 'POST').body, {}, 'The native client asks the server for its canonical main conversation');
    assert.equal(await page.getByRole('button', { name: 'New conversation', exact: true }).count(), 0);
    const shortcut = name => page.getByRole('button', { name, exact: true });
    const back = async () => { await shortcut('Back to conversation').click(); };
    const work = name => page.getByRole('region', { name, exact: true });
    console.log('Native fixture: Google Workspace connection and exact Sheet write');
    let workspaceCard = page.getByRole('article', { name: 'Google Workspace connection and actions', exact: true });
    await workspaceCard.getByRole('button', { name: 'Connect Google Workspace', exact: true }).click();
    await workspaceCard.getByRole('status').filter({ hasText: 'Finish Google consent' }).waitFor();
    let latestOpened = await app.evaluate(() => global.fixture.opened.at(-1));
    assert.equal(new URL(latestOpened).pathname, '/api/auth/google/workspace/desktop/authorize');
    assert.equal(new URL(latestOpened).searchParams.has('token'), false);
    assert.deepEqual((await app.evaluate(() => global.fixture.requests.filter(request => request.path === '/api/auth/google/workspace/desktop/connect').at(-1).body.capabilities)), ['drive_read', 'sheets_read'], 'The first Workspace consent is read-only');
    await app.evaluate(() => {
      global.fixture.workspaceConnected = true; global.fixture.workspaceCapabilities = ['drive_read', 'sheets_read'];
    });
    await workspaceCard.getByRole('button', { name: 'Check connection', exact: true }).click();
    await workspaceCard.getByRole('button', { name: 'Enable reviewed Sheet writes', exact: true }).click();
    await workspaceCard.getByRole('status').filter({ hasText: 'Finish Google consent' }).waitFor();
    latestOpened = await app.evaluate(() => global.fixture.opened.at(-1));
    assert.equal(new URL(latestOpened).pathname, '/api/auth/google/workspace/desktop/authorize');
    assert.deepEqual((await app.evaluate(() => global.fixture.requests.filter(request => request.path === '/api/auth/google/workspace/desktop/connect').at(-1).body.capabilities)), ['drive_read', 'sheets_read', 'sheets_write'], 'Sheet write access requires a separate explicit upgrade');
    await app.evaluate(() => {
      global.fixture.workspaceCapabilities = ['drive_read', 'sheets_read', 'sheets_write'];
      global.fixture.workspaceGrants.push({ id: '77777777-7777-4777-8777-777777777777', tool: 'sheets.google.append', revision: 1, payloadDigest: 'a'.repeat(64), destination: 'Sales!A:C', args: { spreadsheetId: 'fixture-sheet', range: 'Sales!A:C', values: [['Synthetic', 'Reviewed', 1]] }, state: 'pending', createdAt: Date.now(), expiresAt: Date.now() + 3600000, result: null, message: null });
    });
    await workspaceCard.getByRole('button', { name: 'Check connection', exact: true }).click();
    const workspaceReview = page.getByRole('region', { name: 'Google Workspace action review', exact: true });
    await workspaceReview.getByRole('button', { name: 'Approve exact Sheet write', exact: true }).click();
    await workspaceReview.getByRole('button', { name: 'Execute approved write once', exact: true }).click();
    assert.equal(await app.evaluate(() => global.fixture.workspaceGrants[0].state), 'succeeded');
    const workspaceWrites = await app.evaluate(() => global.fixture.requests.filter(request => request.path.includes('/google-workspace/grants/77777777-7777-4777-8777-777777777777/')));
    assert.deepEqual(workspaceWrites.map(request => request.path.split('/').at(-1)), ['decision', 'execute']);
    console.log('Native fixture: Google Contacts least-scope connection, automatic read and exact write');
    let contactsCard = page.getByRole('article', { name: 'Google Contacts connection and actions', exact: true });
    await contactsCard.getByRole('button', { name: 'Connect Google Contacts', exact: true }).click();
    await contactsCard.getByRole('status').filter({ hasText: 'Finish Google consent' }).waitFor();
    latestOpened = await app.evaluate(() => global.fixture.opened.at(-1));
    assert.equal(new URL(latestOpened).pathname, '/api/auth/google/contacts/desktop/authorize');
    assert.equal(new URL(latestOpened).searchParams.has('token'), false);
    await app.evaluate(() => {
      global.fixture.contactsConnected = true; global.fixture.contactsCapabilities = ['contacts_read'];
      global.fixture.contactsGrants.push({ id: '88888888-8888-4888-8888-888888888881', tool: 'contacts.google.search', revision: 1, payloadDigest: 'a'.repeat(64), destination: 'Google Contacts', args: { query: 'Synthetic' }, state: 'approved', createdAt: Date.now(), expiresAt: Date.now() + 3600000, result: null, message: null });
    });
    await contactsCard.getByRole('button', { name: 'Check connection', exact: true }).click();
    await contactsCard.getByRole('button', { name: 'Enable reviewed contact changes', exact: true }).waitFor();
    await page.waitForTimeout(100);
    assert.equal(await app.evaluate(() => global.fixture.contactsGrants[0].state), 'succeeded', 'Consent-approved Contacts reads execute without a separate write approval');
    await contactsCard.getByRole('button', { name: 'Enable reviewed contact changes', exact: true }).click();
    await contactsCard.getByRole('status').filter({ hasText: 'Finish Google consent' }).waitFor();
    latestOpened = await app.evaluate(() => global.fixture.opened.at(-1));
    assert.equal(new URL(latestOpened).pathname, '/api/auth/google/contacts/desktop/authorize');
    await app.evaluate(() => {
      global.fixture.contactsCapabilities = ['contacts_read', 'contacts_write'];
      global.fixture.contactsGrants.push({ id: '88888888-8888-4888-8888-888888888882', tool: 'contacts.google.update', revision: 1, payloadDigest: 'a'.repeat(64), destination: 'people/fixture', args: { resourceName: 'people/fixture', patch: { email: 'corrected@example.test' } }, state: 'pending', createdAt: Date.now(), expiresAt: Date.now() + 3600000, result: null, message: null });
    });
    await contactsCard.getByRole('button', { name: 'Check connection', exact: true }).click();
    const contactsReview = page.getByRole('region', { name: 'Google Contacts action review', exact: true });
    await contactsReview.getByRole('button', { name: 'Approve exact Google contact change', exact: true }).click();
    await contactsReview.getByRole('button', { name: 'Execute approved change once', exact: true }).click();
    assert.equal(await app.evaluate(() => global.fixture.contactsGrants[1].state), 'succeeded');
    console.log('Native fixture: Gmail connection');
    await capture('gmail-connect');
    await shortcut('Email').click();
    assert.equal(await page.getByRole('region', { name: 'Email workflow' }).count(), 0);
    await shortcut('Connect Gmail').click();
    await page.getByText('Finish Google consent in your browser, then return here. Your original request stays saved in this conversation.').waitFor();
    const opened = await app.evaluate(() => global.fixture.opened);
    assert.equal(new URL(opened.at(-1)).pathname, '/api/auth/google/mail/desktop/authorize');
    assert.equal(new URL(opened.at(-1)).searchParams.has('token'), false);
    await app.evaluate(() => { global.fixture.connected = true; global.fixture.historyConnected = true; });
    await page.getByRole('article', { name: 'Gmail connection', exact: true }).getByRole('button', { name: 'Check connection', exact: true }).click();
    await page.getByRole('region', { name: 'Email workflow', exact: true }).waitFor();
    console.log('Native fixture: Unsaved editor protection');
    await page.getByLabel('Email text', { exact: true }).fill('Temporary unsaved draft');
    assert.equal(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }), true, 'Unsaved email must block native close');
    await shortcut('Screenshot').click();
    const discard = page.getByRole('alertdialog', { name: 'Unsaved workspace changes' });
    await discard.waitFor(); await discard.getByRole('button', { name: 'Keep editing' }).click();
    assert.equal(await page.getByLabel('Email text', { exact: true }).inputValue(), 'Temporary unsaved draft');
    assert.equal(await shortcut('New conversation').count(), 0, 'The permanent main conversation has no reset or new-session control');
    assert.equal(await app.evaluate(() => global.fixture.requests.some(x => x.method === 'DELETE' && x.path.includes('/conversation/session/'))), false, 'Workspace navigation must not delete the main conversation');
    await shortcut('Assistant capabilities').click(); await shortcut('Assistant capabilities').click();
    assert.equal(await page.getByLabel('Email text', { exact: true }).inputValue(), 'Temporary unsaved draft', 'Settings toggle keeps the editor mounted');
    await shortcut('New email').click();
    const internalDiscard = page.getByRole('alertdialog', { name: 'Unsaved editor changes' });
    await internalDiscard.waitFor(); await internalDiscard.getByRole('button', { name: 'Keep editing' }).click();
    assert.equal(await page.getByLabel('Email text', { exact: true }).inputValue(), 'Temporary unsaved draft');
    await shortcut('Screenshot').click(); await discard.getByRole('button', { name: 'Discard edits and continue' }).click();
    await page.getByLabel('Screenshot file').waitFor(); await shortcut('Email').click();
    assert.equal(await page.getByLabel('Email text', { exact: true }).inputValue(), '');
    console.log('Native fixture: Email editor');
    await page.getByLabel('Find saved contact', { exact: true }).fill('Synthetic');
    await shortcut('Find recipient').click();
    await page.getByLabel('Email recipient', { exact: true }).selectOption('21');
    await shortcut('Load linked reply threads').click();
    await page.getByLabel('Reply thread', { exact: true }).selectOption('linked-fixture-thread');
    await page.getByLabel('Email subject', { exact: true }).fill('Native email review');
    await page.getByLabel('Email text', { exact: true }).fill('Original fixture text.');
    await page.getByText('Formatting and templates', { exact: true }).click();
    await page.getByLabel('Email HTML', { exact: true }).fill('<h1>Reviewed native email</h1>');
    await page.getByLabel('Email attachments', { exact: true }).setInputFiles({ name: 'fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic attachment') });
    await page.getByText('fixture.txt', { exact: true }).waitFor();
    await app.evaluate(() => { global.fixture.delayEmailSave = true; });
    await shortcut('Save email draft').click();
    await shortcut('Screenshot').click();
    await page.getByText('Wait for the current workspace operation to finish before leaving this editor.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('region', { name: 'Email workflow', exact: true }).count(), 1, 'In-flight save must keep its editor mounted');
    await shortcut('Review exact email').waitFor();
    await app.evaluate(() => { global.fixture.delayEmailSave = false; });
    await page.getByLabel('Email text', { exact: true }).fill('Revised fixture text.');
    assert.equal(await shortcut('Review exact email').count(), 0, 'Unsaved edits cannot be approved');
    await shortcut('Save email revision').click();
    await shortcut('Review exact email').click();
    await shortcut('Approve and submit email').waitFor();
    assert.equal(await page.locator('iframe[title="Email preview"]').getAttribute('sandbox'), '');
    // Schedule this saved reply before exercising immediate submission of its exact revision.
    console.log('Native fixture: Conditional follow-up');
    await app.evaluate(() => {
      const draft = global.fixture.drafts[0];
      draft.recipients.cc = [{ email: 'support@example.test', source: 'support_contact', supportContact: { planId: 'fixture-plan', id: 'support' } }];
      draft.recipients.bcc = [{ email: 'audit@example.test', source: 'owner_provided' }];
    });
    await back(); await shortcut('Follow-up').click();
    await page.getByLabel('Saved email draft', { exact: true }).selectOption('11111111-1111-4111-8111-111111111111');
    await page.getByLabel('Exact email recipients').getByText('support@example.test', { exact: false }).waitFor();
    await page.getByLabel('Exact email recipients').getByText('audit@example.test', { exact: false }).waitFor();
    await page.getByLabel('Exact email recipients').getByText('configured plan support', { exact: false }).waitFor();
    await page.getByLabel(/^Send at/).fill('2030-10-19T10:00');
    await shortcut('Prepare scheduled email review').click();
    const approveFollow = shortcut('Approve this exact scheduled email');
    await approveFollow.waitFor();
    // Explicit exact preview is retained from draft selection and matches the saved hash.
    await approveFollow.click(); await shortcut('Pause follow-up').click(); await shortcut('Resume follow-up').click(); await shortcut('Cancel follow-up').click();
    await page.getByText(/Canceled — unsent/).waitFor();
    await back();
    await page.getByRole('article', { name: 'email activity' }).getByRole('button', { name: 'Review email' }).click();
    await shortcut('Approve and submit email').click();
    await page.getByRole('status').filter({ hasText: 'Submitted to fixture Gmail' }).waitFor();
    assert.equal(await shortcut('Approve and submit email').count(), 0, 'Submitted messages cannot be resubmitted');
    const decisions = await app.evaluate(() => global.fixture.requests.filter(x => x.path.endsWith('/email-drafts/11111111-1111-4111-8111-111111111111/decision')));
    assert.equal(decisions.length, 1); assert.equal(decisions[0].body.expectedRevision, 2); assert.equal(decisions[0].body.contentHash, 'b'.repeat(64));
    assert.equal(await app.evaluate(() => global.fixture.drafts[0].attachments[0].base64), Buffer.from('Synthetic attachment').toString('base64'));
    console.log('Native fixture: Direct recipient without CRM contact');
    await shortcut('New email').click();
    await page.getByLabel('Exact email recipient', { exact: true }).fill('vendor@example.test');
    await page.getByLabel('Email subject', { exact: true }).fill('Direct vendor request');
    await page.getByLabel('Email text', { exact: true }).fill('Please review the attached plan requirements.');
    await shortcut('Save email draft').click(); await shortcut('Review exact email').click(); await shortcut('Approve and submit email').click();
    await page.getByRole('status').filter({ hasText: 'Submitted to fixture Gmail' }).waitFor();
    const directCreate = await app.evaluate(() => global.fixture.requests.filter(x => x.path === '/api/ai-agents/7/email-drafts' && x.method === 'POST').at(-1));
    assert.equal('contactId' in directCreate.body.content, false); assert.deepEqual(directCreate.body.content.to, [{ email: 'vendor@example.test' }]);
    assert.equal(await app.evaluate(() => global.fixture.drafts.at(-1).contactId), null);
    console.log('Native fixture: Screenshot review');
    await back(); await shortcut('Screenshot').click();
    await page.getByLabel('Screenshot file').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=', 'base64') });
    await shortcut('Extract screenshot').click(); await page.getByLabel('Member / policy ID', { exact: true }).waitFor();
    await page.getByLabel('Find existing client', { exact: true }).fill('Synthetic'); await shortcut('Search clients').click();
    await page.getByLabel('Select client record').selectOption('21'); await shortcut('Review CRM changes').click();
    assert.equal(await shortcut('Apply reviewed CRM update').isDisabled(), true);
    await page.getByLabel('Resolve Member / policy ID').selectOption('replace');
    await page.getByRole('checkbox', { name: 'I checked the screenshot, selected client and field values.' }).check();
    await shortcut('Apply reviewed CRM update').click(); await page.getByText('CRM update verified:', { exact: true }).waitFor();
    await capture('screenshot-receipt');
    assert.equal(await app.evaluate(() => global.fixture.uploads.length), 1); assert.equal(await app.evaluate(() => global.fixture.reads.length), 1);
    console.log('Native fixture: Artifact sandbox');
    await back(); await shortcut('Artifact').click(); await shortcut('Use counter template').click(); await shortcut('Save artifact').click();
    await page.getByText('Interaction unverified', { exact: true }).waitFor(); assert.equal(await page.locator('iframe[title="Artifact preview"]').count(), 0);
    await shortcut('Run preview').click(); const frame = page.frameLocator('iframe[title="Artifact preview"]');
    await frame.getByRole('button', { name: 'Increment', exact: true }).click(); assert.equal(await frame.locator('#count').innerText(), '1');
    assert.equal(await page.locator('iframe[title="Artifact preview"]').getAttribute('sandbox'), 'allow-scripts');
    await capture('artifact-preview');
    const child = await (await page.locator('iframe[title="Artifact preview"]').elementHandle()).contentFrame();
    assert.ok(child, 'Artifact has a separate renderer frame');
    assert.equal(await child.evaluate(() => typeof window.dialer), 'undefined', 'Artifact cannot see native bridge');
    assert.equal(await child.evaluate(() => { try { localStorage.getItem('crokodial_auth_token'); return false; } catch { return true; } }), true);
    console.log('Native fixture: Background task');
    await shortcut('Stop preview').click(); await back(); await shortcut('Task').click();
    await page.getByLabel('Task objective').fill('Prepare a synthetic fixture briefing');
    await page.getByLabel(/^Run at/).fill('2030-10-19T10:00'); await shortcut('Save background task').click();
    await shortcut('Pause future runs').click(); await shortcut('Resume').click(); await shortcut('Cancel task').click();
    assert.equal(await app.evaluate(() => global.fixture.tasks[0].status), 'canceled');
    await page.getByLabel('Task objective').fill('Monitor the synthetic inbox on a recurring interval');
    await page.getByLabel('Trigger').selectOption('interval');
    await page.getByLabel('Repeat every (minutes)').fill('15');
    await page.getByLabel('Maximum runs').fill('8');
    await shortcut('Save background task').click();
    assert.deepEqual(await app.evaluate(() => ({ trigger: global.fixture.tasks[1].trigger, maxRuns: global.fixture.tasks[1].maxRuns, policy: global.fixture.tasks[1].notificationPolicy })), { trigger: { kind: 'interval', everyMinutes: 15 }, maxRuns: 8, policy: 'meaningful' });
    await page.getByText(/Every 15 minutes/).waitFor();
    await page.getByText('Monitor the synthetic inbox on a recurring interval', { exact: true }).locator('..').getByRole('button', { name: 'Cancel task', exact: true }).click();
    assert.equal(await app.evaluate(() => global.fixture.tasks[1].status), 'canceled');
    console.log('Native fixture: Scheduling connections, booking, CRM contacts and report');
    await back(); await shortcut('Business').click();
    const business = work('Scheduling, contacts and reports');
    await business.getByRole('button', { name: 'Connect Google Calendar', exact: true }).click();
    await business.getByRole('status').filter({ hasText: 'Finish Google Calendar consent' }).waitFor();
    latestOpened = await app.evaluate(() => global.fixture.opened.at(-1));
    assert.equal(new URL(latestOpened).pathname, '/api/auth/google/calendar/desktop/authorize');
    assert.equal(new URL(latestOpened).searchParams.has('token'), false);
    await business.getByRole('button', { name: 'Connect Calendly', exact: true }).click();
    await business.getByRole('status').filter({ hasText: 'Finish Calendly consent' }).waitFor();
    latestOpened = await app.evaluate(() => global.fixture.opened.at(-1));
    assert.equal(new URL(latestOpened).pathname, '/api/calendly/oauth/desktop/authorize');
    assert.equal(new URL(latestOpened).searchParams.has('token'), false);
    await app.evaluate(() => { global.fixture.calendarConnected = true; global.fixture.calendlyConnected = true; });
    await business.getByRole('button', { name: 'Check connections', exact: true }).click();
    await business.getByText(/Calendly: connected as calendly@example.test/).waitFor();
    await business.getByRole('button', { name: 'Check live availability', exact: true }).click();
    await business.getByText(/Oct 20, 2030/).waitFor();
    await business.getByRole('button', { name: 'Prepare one-use booking link', exact: true }).click();
    let exactAction = business.getByRole('region', { name: 'Exact action review', exact: true });
    await exactAction.getByRole('button', { name: 'Approve exact action', exact: true }).click();
    await exactAction.getByRole('status').filter({ hasText: 'Fixture action completed once.' }).waitFor();
    await business.getByText('Contacts', { exact: true }).click();
    await business.getByLabel('Search contacts', { exact: true }).fill('Fixture');
    await business.getByRole('button', { name: 'Search', exact: true }).click();
    await business.getByRole('button', { name: 'Fixture Client', exact: true }).click();
    const updateForm = business.locator('form').filter({ hasText: 'Prepare changes to Fixture Client' });
    await updateForm.getByLabel('Email', { exact: true }).fill('corrected@example.test');
    await updateForm.getByRole('button', { name: 'Review exact contact update', exact: true }).click();
    exactAction = business.getByRole('region', { name: 'Exact action review', exact: true });
    await exactAction.getByRole('button', { name: 'Approve exact action', exact: true }).click();
    const createForm = business.locator('form').filter({ hasText: 'Create a contact' });
    await createForm.getByLabel('Phone', { exact: true }).fill('2694621403');
    await createForm.getByLabel('First name', { exact: true }).fill('Synthetic');
    await createForm.getByLabel('Last name', { exact: true }).fill('Owner');
    await createForm.getByRole('button', { name: 'Review exact new contact', exact: true }).click();
    await business.getByRole('region', { name: 'Exact action review', exact: true }).getByRole('button', { name: 'Approve exact action', exact: true }).click();
    await business.getByRole('button', { name: 'Review possible duplicates', exact: true }).click();
    await business.getByText(/email match/).waitFor();
    await business.getByText('Sales report', { exact: true }).click();
    await business.getByRole('button', { name: 'Generate report', exact: true }).click();
    await business.getByText(/7 new client records/).waitFor();
    assert.deepEqual(await app.evaluate(() => global.fixture.businessActions.map(item => [item.kind, item.state])), [['calendar.booking_link', 'succeeded'], ['contact.update', 'succeeded'], ['contact.create', 'succeeded']]);
    console.log('Native fixture: Approved tools');
    await back(); await shortcut('Assistant capabilities').click();
    await page.getByLabel('Calendar range start').fill('2030-10-19T10:00'); await page.getByLabel('Calendar range end').fill('2030-10-20T10:00');
    await shortcut('Review calendar request').click(); await shortcut('Approve exact read').click();
    await page.getByText(/Synthetic appointment/).waitFor();
    await page.getByText('Compute and measured model evidence', { exact: true }).click(); await page.getByText(/Hybrid execution is disabled/).waitFor();
    await shortcut('Assistant capabilities').click();
    console.log('Native fixture: Safe rich assistant formatting');
    await page.getByLabel('Message your assistant').fill('Render safe assistant formatting'); await shortcut('Send message').click();
    const markdownTurn = page.getByRole('article').filter({ hasText: 'Fixture heading' });
    await markdownTurn.getByRole('heading', { name: 'Fixture heading', exact: true }).waitFor();
    assert.equal(await markdownTurn.locator('strong').filter({ hasText: 'Reviewed' }).count(), 1);
    assert.equal(await markdownTurn.locator('code').filter({ hasText: 'bounded' }).count(), 1);
    assert.equal(await markdownTurn.getByRole('table').count(), 1);
    assert.equal(await markdownTurn.getByRole('link').count(), 0, 'Assistant text cannot create arbitrary clickable links');
    assert.equal(await page.evaluate(() => window.fixtureInjected), undefined, 'Assistant HTML is rendered as text, never executed');
    await markdownTurn.getByText(/<script>window\.fixtureInjected=true<\/script>/).waitFor();
    console.log('Native fixture: Persistence and uncertain retry');
    await page.getByLabel('Message your assistant').fill('Search WhatsApp for persisted-fixture-term'); await shortcut('Send message').click();
    await page.getByRole('article', { name: 'Local WhatsApp read-only request for saved message', exact: true }).waitFor();
    await app.evaluate(() => { global.fixture.failNextMessage = true; });
    await page.getByLabel('Message your assistant').fill('Persist this native conversation across restart'); await shortcut('Send message').click();
    await page.getByRole('alert').filter({ hasText: 'Synthetic uncertain transport outcome' }).waitFor();
    await shortcut('Send message').click();
    await page.getByRole('alert').filter({ hasText: 'Synthetic uncertain transport outcome' }).waitFor({ state: 'hidden' });
    const receipts = await app.evaluate(() => global.fixture.requests.filter(x => x.path.endsWith('/conversation/message') && x.body.message === 'Persist this native conversation across restart'));
    assert.equal(receipts.length, 2); assert.equal(receipts[0].body.requestId, receipts[1].body.requestId);
    const persistedRequestId = receipts[0].body.requestId;
    assert.equal(await app.evaluate((_electron, requestId) => global.fixture.messages.filter(message => message.requestId === requestId && message.role === 'assistant').length, persistedRequestId), 1, 'An uncertain retry must create one server-owned assistant reply for its stable request id');
    await page.getByText('Saved native conversation reply.', { exact: true }).last().waitFor();
    await app.evaluate(() => { global.fixture.failHistory = true; });
    await page.getByLabel('Message your assistant').fill('Successful post with unavailable history'); await shortcut('Send message').click();
    await page.getByText('Accepted despite history refresh failure.', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Message your assistant').inputValue(), '', 'Accepted message must not be offered for resend when only GET history failed');
    await shortcut('Reload saved work').waitFor();
    const acceptedPosts = await app.evaluate(() => global.fixture.requests.filter(x => x.path.endsWith('/conversation/message')).length);
    await app.evaluate(() => { global.fixture.failHistory = false; }); await shortcut('Reload saved work').click();
    await shortcut('Reload saved work').waitFor({ state: 'hidden' });
    assert.equal(await page.getByText('Accepted despite history refresh failure.', { exact: true }).count(), 1, 'Local accepted turn and server transcript merge once');
    assert.equal(await app.evaluate(() => global.fixture.requests.filter(x => x.path.endsWith('/conversation/message')).length), acceptedPosts, 'History recovery must never resubmit a POST');
    await page.reload(); await page.getByRole('tab', { name: 'Assistant', exact: true }).click();
    await page.getByText('Saved native conversation reply.', { exact: true }).last().waitFor();
    await page.getByText('Persist this native conversation across restart', { exact: true }).waitFor();
    await page.getByRole('article', { name: 'Local WhatsApp read-only request for saved message', exact: true }).waitFor();
    const mainConversationEvidence = await app.evaluate(() => ({
      sessionPosts: global.fixture.requests.filter(x => x.path.endsWith('/conversation/session') && x.method === 'POST'),
      messagePosts: global.fixture.requests.filter(x => x.path.endsWith('/conversation/message')),
      historyReads: global.fixture.historyReads,
      deleted: global.fixture.requests.some(x => x.method === 'DELETE' && x.path.includes('/conversation/session/')),
      sessionId: global.fixture.sessionId,
      conversationKey: global.fixture.conversationKey,
    }));
    assert.equal(mainConversationEvidence.conversationKey, 'main:11:9:sandbox');
    assert.ok(mainConversationEvidence.sessionPosts.length >= 2, 'Renderer restart reopens the server-owned main conversation');
    assert.ok(mainConversationEvidence.sessionPosts.every(request => JSON.stringify(request.body) === '{}'), 'No client-generated chat key creates parallel sessions');
    assert.ok(mainConversationEvidence.messagePosts.every(request => request.body.sessionId === mainConversationEvidence.sessionId));
    assert.ok(mainConversationEvidence.historyReads.length >= 2 && mainConversationEvidence.historyReads.every(read => read.sessionId === mainConversationEvidence.sessionId), 'Reload restores the same main-chat history');
    assert.equal(mainConversationEvidence.deleted, false);
    assert.equal(await page.getByRole('button', { name: 'New conversation', exact: true }).count(), 0);
    assert.equal(await page.getByRole('article', { name: 'email activity' }).count(), 2);
    assert.equal(await app.evaluate(() => global.fixture.requests.some(x => x.path.includes('/test/'))), false, 'No preview/test assistant route substitutes for owner workflows');
    const window = await app.browserWindow(page);
    fs.mkdirSync('artifacts/native-assistant-workflows', { recursive: true });
    for (const width of [320, 360, 600]) {
      await window.evaluate((w, width) => w.setSize(width, Math.round(width * 2.16)), width);
      await page.getByRole('article', { name: 'email activity' }).first().getByRole('button', { name: 'Review email' }).click();
      await page.getByRole('region', { name: 'Email workflow', exact: true }).waitFor();
      const emailReview = page.getByRole('region', { name: 'Email review', exact: true });
      const overflow = await emailReview.evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth }));
      assert.ok(overflow.scroll <= overflow.client + 1, `${width}px native review must not overflow (${JSON.stringify(overflow)})`);
      await emailReview.scrollIntoViewIfNeeded();
      await capture(`email-${width}`); await back();
    }
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(w => w.isVisible() || w.isFocusable())), false);
    assert.deepEqual(errors, []);
    console.log('PASS native Personal Assistant: one permanent canonical main chat with durable reload/no reset/DELETE; one-use Gmail, Google Workspace, Google Contacts, Google Calendar and Calendly browser handoffs with no bearer in URLs; exact-reviewed Sheet/contact/booking actions; consent-approved bounded Contacts read; live-availability UI; CRM search/update/create/dedupe and tenant report; once and recurring background tasks; safe Markdown without HTML execution or arbitrary links; exact email/follow-up workflows; screenshot conflict receipt; artifact sandbox; approved calendar read; uncertain-request dedup; and narrow-window layout. All provider/API responses are isolated fixtures; no real communications, provider writes, contacts or CRM records were touched.');
  } catch (error) {
    console.error('Native fixture diagnostics:', await page?.locator('.assistant-workspace').innerText().catch(() => '(unavailable)'), await app.evaluate(() => global.fixture?.requests.slice(-8).map(x => ({path:x.path,method:x.method}))));
    throw error;
  } finally { await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {}); await app.close(); fs.rmSync(profile, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
