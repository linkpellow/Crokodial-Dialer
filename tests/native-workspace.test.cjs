const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron: electron } = require('playwright');
const { hideNativeWindows } = require('./fixtures/hide-native-windows.cjs');

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'crokodial-workspace-test-'));
  const app = await electron.launch({ executablePath: process.env.CROKODIAL_APP_EXECUTABLE || require('electron'), args: [path.resolve('.')], env: { ...process.env, CROKODIAL_USER_DATA_DIR: profile, CROKODIAL_RENDERER_URL: '' } });
  try {
    await hideNativeWindows(app);
    const page = await app.firstWindow();
    // Electron's native capture renders hidden fixture windows without showing
    // them or waiting for a compositor frame on the user's active desktop.
    const screenshot = async destination => {
      const window = await app.browserWindow(page);
      const base64 = await window.evaluate(async current => (await current.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64'));
      const bytes = Buffer.from(base64, 'base64');
      assert.ok(bytes.length > 100, 'Hidden fixture capture must produce an image');
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, bytes);
    };
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ ipcMain }) => {
      global.testRequests = [];
      global.invalidateSession = false;
      global.authFailuresRemaining = 0;
      global.authFailureStatus = 0;
      global.mainConversation = { conversationKey: 'main:11:9:sandbox', sessionId: 'main-session' };
      global.histories = new Map([[global.mainConversation.sessionId, []]]);
      ipcMain.removeHandler('api-fetch');
      ipcMain.handle('api-fetch', async (_, payload) => {
        const requestUrl = new URL(payload.url);
        const request = { path: requestUrl.pathname, search: requestUrl.search, method: payload.method, body: payload.body && JSON.parse(payload.body), headers: payload.headers };
        global.testRequests.push(request);
        let data = {}, status = 200;
        if (request.path === '/api/auth/me') {
          if (global.authFailuresRemaining-- > 0) return { ok: false, status: global.authFailureStatus, statusText: 'Synthetic outage', headers: {}, body: '' };
          if (request.headers?.Authorization === 'Bearer isolated-desktop-test-token' && !global.invalidateSession) data = { id: 11, name: 'Workspace test', email: 'native-smoke@example.test', tenant_id: 9 };
          else { status = 401; data = { error: { code: 'NO_TOKEN', message: 'No authentication token provided' } }; }
        }
        else if (request.path === '/api/auth/desktop/login') {
          if (request.headers?.['x-crokodial-desktop-client'] !== 'crokodial-sms-desktop') { status = 400; data = { error: { code: 'DESKTOP_CLIENT_REQUIRED', message: 'Valid desktop client header is required' } }; }
          else if (request.body?.email !== 'native-smoke@example.test' || request.body?.password !== 'Synthetic-test-password') { status = 401; data = { error: { message: 'Invalid email or password' } }; }
          else data = { token: 'isolated-desktop-test-token', user: { id: 11, name: 'Workspace test', email: 'native-smoke@example.test', tenant_id: 9 } };
        }
        else if (request.path === '/api/auth/login') { status = 400; data = { error: { message: 'Native client must use the desktop login contract' } }; }
        else if (request.path === '/api/auth/google/mail/status') data = {configured:true,connected:true,historyConnected:true,connectUrl:'/api/auth/google/mail',historyConnectUrl:'/api/auth/google/mail/history'};
        else if (request.path === '/api/auth/google/workspace/status') data = {provider:'google_workspace',configured:false,connected:false,email:null,generation:null,capabilities:[],missingCapabilities:['drive_read','sheets_read','sheets_write']};
        else if (request.path === '/api/ai-agents/7/google-workspace/grants') data = {grants:[]};
        else if (request.path === '/api/auth/google/contacts/status') data = {provider:'google_contacts',configured:false,connected:false,email:null,generation:null,capabilities:[],missingCapabilities:['contacts_read','contacts_write']};
        else if (request.path === '/api/ai-agents/7/google-contacts/grants') data = {grants:[]};
        else if (request.path === '/api/ai-agents/7/business/scheduling/status') data = {google:{connected:false,syncEnabled:false,accountEmail:null},calendly:{connected:false,syncEnabled:false,accountEmail:null}};
        else if (request.path.endsWith('/conversation/activity')) data = {items:[]};
        else if (request.path.endsWith('/execution/events')) data = {events:[]};
        else if (request.method === 'GET' && request.path.includes('/conversation/session/')) {
          const sessionId = request.path.split('/').at(-1), before = Number(requestUrl.searchParams.get('before')) || Number.POSITIVE_INFINITY;
          const eligible = (global.histories.get(sessionId) || []).filter(message => message.sequence < before), messages = eligible.slice(-200);
          data = { conversationKey: global.mainConversation.conversationKey, sessionId, messages, hasMore: eligible.length > messages.length, ...(eligible.length > messages.length ? { nextBefore: messages[0].sequence } : {}) };
        }
        else if (request.path === '/api/ai-agents') data = [{ id: 7, name: 'Personal Assistant', role: 'personal_assistant' }, { id: 9, name: 'Second Assistant', role: 'personal_assistant' }, { id: 8, name: 'Sales', role: 'sales' }];
        else if (request.path === '/api/ai-agents/7/intelligence/status') data = { environment: 'sandbox', memoryEnabled: true, planningEnabled: true, memoryMode: 'persistent' };
        else if (request.path === '/api/insurance-plans') data = { plans: [{ id: 'lifex', name: 'LIFEX', variants: [{ id: 'lifex-hsa-3500', name: 'HSA 3500' }] }] };
        else if (request.path === '/api/insurance-plans/lifex') data = { instructions: 'Verified plan guidance fixture', announcements: [{ id: 'announcement-1', title: 'Portal delay', body: 'Review the effective date before escalation.', active: true, effectiveFrom: null, expiresAt: null, affectedEffectiveFrom: '2026-10-01', affectedEffectiveTo: '2026-10-01' }], supportContacts: [{ id: 'support', label: 'Support', email: 'support@example.test', purpose: 'Portal issues' }], documents: [] };
        else if (request.path === '/api/dialer/voice-session') { status = 403; data = { error: { message: 'Calling disabled for this isolated UI test' } }; }
        else if (request.path.endsWith('/conversation/session')) {
          data = { ...global.mainConversation, memoryMode: 'persistent' };
        }
        else if (request.path.endsWith('/conversation/message')) {
          await new Promise(resolve => setTimeout(resolve, 900));
          data = { success: true, message: 'Verified test reply. Your draft remains private.', grounding: { citations: ['Test plan instructions'] }, proposedActions: [{ name: 'draft_support_email' }], recommendation: { action: 'Review the source benefits', reason: 'The plan has a verified brochure.', evidence: [], tradeoff: 'Confirm current availability before choosing.', missingPrerequisites: [], executionStatus: 'recommended' } };
          const rows=global.histories.get(request.body.sessionId) || [], sequence=rows.reduce((highest, message) => Math.max(highest, message.sequence), 0); rows.push({id:`user-${request.body.requestId}`,role:'user',content:request.body.message,createdAt:Date.now(),requestId:request.body.requestId,sequence:sequence+1},{id:`assistant-${request.body.requestId}`,role:'assistant',content:data.message,createdAt:Date.now()+1,requestId:request.body.requestId,sequence:sequence+2}); global.histories.set(request.body.sessionId,rows);
        }
        return { ok: status < 400, status, statusText: 'Test', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(status < 400 ? { success: true, data } : { success: false, ...data }) };
      });
    });
    await page.reload();
    await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
    // Drive the test renderer via CDP without intercepting the user's keyboard.
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible() || window.isFocusable())), false);
    assert.equal((await app.evaluate(() => global.testRequests)).some(request => request.path.startsWith('/api/dialer/')), false, 'Do not initialize calling before authenticated sign-in');
    await page.getByPlaceholder('Email', { exact: true }).fill('native-smoke@example.test');
    await page.getByPlaceholder('Password', { exact: true }).fill('Deliberately incorrect fixture');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByText('Invalid email or password', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('crokodial_auth_token')), null);
    await page.getByPlaceholder('Password', { exact: true }).fill('Synthetic-test-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('tab', { name: 'Dialer', exact: true }).waitFor({ timeout: 10000 }).catch(async error => {
      console.error('Native fixture login diagnostics', await page.locator('body').innerText(), await app.evaluate(() => global.testRequests.map(request => ({ path: request.path, desktopClient: request.headers?.['x-crokodial-desktop-client'], emailMatches: request.body?.email === 'native-smoke@example.test', passwordMatches: request.body?.password === 'Synthetic-test-password' }))));
      throw error;
    });
    assert.equal(await page.evaluate(() => localStorage.getItem('crokodial_auth_token')), 'isolated-desktop-test-token');
    await page.reload();
    await page.getByRole('tab', { name: 'Dialer', exact: true }).waitFor();
    const authRequests = await app.evaluate(() => global.testRequests);
    assert.equal(authRequests.filter(request => request.path === '/api/auth/desktop/login').length, 2);
    assert.equal(authRequests.some(request => request.path === '/api/auth/login'), false);
    const restoredRequest = authRequests.filter(request => request.path === '/api/auth/me').at(-1);
    assert.equal(restoredRequest.headers.Authorization, 'Bearer isolated-desktop-test-token');
    assert.equal(restoredRequest.headers['x-crokodial-desktop-client'], 'crokodial-sms-desktop');
    assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('crokodial_auth_user')))).tenant_id, 9);
    // Startup network errors and a temporarily unavailable backend recover on
    // their own without asking the owner to identify or sign in again.
    for (const outageStatus of [0, 503]) {
      await app.evaluate((_electron, status) => { global.authFailuresRemaining = 1; global.authFailureStatus = status; }, outageStatus);
      await page.reload();
      await page.getByRole('heading', { name: 'Connection interrupted' }).waitFor();
      assert.equal(await page.evaluate(() => localStorage.getItem('crokodial_auth_token')), 'isolated-desktop-test-token');
      await page.getByRole('tab', { name: 'Dialer', exact: true }).waitFor();
    }
    assert.equal((await app.evaluate(() => global.testRequests)).filter(request => request.path === '/api/auth/desktop/login').length, 2, 'Recovering a session must not repeat sign-in');
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible() || window.isFocusable())), false, 'Authentication and renderer reload must not restore native focus');
    await page.getByPlaceholder('Enter number').fill('2125550123');
    await page.evaluate(() => { window.originalCallAudio = document.querySelector('#dialer-workspace audio'); });
    await page.getByRole('tab', { name: 'Assistant', exact: true }).click();
    await page.getByLabel('Message your assistant').waitFor().catch(async error => {
      console.error('Native assistant mount diagnostics', await page.locator('body').innerText().catch(() => '(body unavailable)'), errors, (await app.evaluate(() => global.testRequests)).slice(-20).map(request => request.path));
      throw error;
    });
    assert.ok((await page.getByLabel('Message your assistant').boundingBox()).height >= 72, 'Assistant composer should provide a larger writing area');
    assert.equal(await page.getByText('Review drafts before sharing. Verify coverage with the cited source.', { exact: true }).count(), 0, 'The review reminder should be removed');
    assert.equal(await page.getByRole('button', { name: 'Context and goals', exact: true }).count(), 0);
    assert.equal(await page.locator('.assistant-environment').count(), 0);
    assert.equal(await page.locator('.assistant-workspace select').count(), 0, 'Automatic routing must not require mode, assistant, plan or variation selectors');
    assert.equal(await page.getByRole('heading', { name: 'How can I help?' }).count(), 0);
    assert.equal(await page.getByText('Explain the active plan announcements', { exact: true }).count(), 0);
    fs.mkdirSync('artifacts', { recursive: true });
    await screenshot('artifacts/native-assistant-unified-empty.png');
    await page.getByLabel('Message your assistant').fill('An unfinished support draft');
    await page.getByRole('tab', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Dialer', exact: true }).click();
    assert.equal(await page.getByPlaceholder('Enter number').inputValue(), '2125550123');
    assert.equal(await page.evaluate(() => window.originalCallAudio === document.querySelector('#dialer-workspace audio')), true);
    await page.getByRole('tab', { name: 'Assistant', exact: true }).click();
    assert.equal(await page.getByLabel('Message your assistant').inputValue(), 'An unfinished support draft');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'New conversation', exact: true }).count(), 0, 'The permanent main chat must not expose a reset or new-session control');
    assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isDisabled(), true);
    await page.getByRole('tab', { name: 'Dialer', exact: true }).click();
    await page.getByRole('tab', { name: 'Assistant', exact: true }).click();
    await page.getByText('Verified test reply. Your draft remains private.', { exact: true }).last().waitFor();
    await page.getByLabel('Message your assistant').fill('Follow up');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByRole('status').waitFor({ state: 'hidden' });
    const requests = await app.evaluate(() => global.testRequests);
    assert.equal(requests.filter(request => request.path.endsWith('/conversation/session') && request.method === 'POST').length, 1, 'Conversation must reuse one session');
    assert.equal(requests.filter(request => request.path.endsWith('/conversation/message')).length, 2);
    assert.equal(requests.find(request => request.path.endsWith('/conversation/message')).body.audience, undefined, 'Owner authority must come from the authenticated route, never a browser audience field');
    assert.ok(requests.find(request => request.path.endsWith('/conversation/message')).body.requestId, 'Each owner instruction must carry an idempotent request key');
    assert.equal(requests.find(request => request.path === '/api/insurance-plans').headers['x-crokodial-contract-version'], '2026-02-26.1');
    assert.ok(requests.some(request => request.path === '/api/dialer/voice-session'));
    assert.equal(errors.length, 0, errors.join('\n'));
    fs.mkdirSync('artifacts', { recursive: true });
    await screenshot('artifacts/native-assistant-smoke.png');
    const originalConversationKey = await app.evaluate(() => global.mainConversation.conversationKey);
    assert.equal(originalConversationKey, 'main:11:9:sandbox');
    assert.deepEqual((await app.evaluate(() => global.testRequests)).find(request => request.path.endsWith('/conversation/session') && request.method === 'POST').body, {}, 'The server selects the one canonical owner conversation');
    await page.reload();
    await page.getByRole('tab', { name: 'Assistant', exact: true }).click();
    await page.getByText('Follow up', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'New conversation', exact: true }).count(), 0);
    await page.getByLabel('Message your assistant').fill('Continue the same conversation after reconnecting');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByText('Verified test reply. Your draft remains private.', { exact: true }).last().waitFor();
    const reopened = (await app.evaluate(() => global.testRequests)).filter(request => request.path.endsWith('/conversation/session') && request.method === 'POST');
    assert.equal(reopened.length, 2);
    assert.deepEqual(reopened.map(request => request.body), [{}, {}]);
    assert.equal((await app.evaluate(() => global.testRequests)).filter(request => request.method === 'DELETE' && request.path.includes('/conversation/session/')).length, 0, 'Reload/unmount must retain the durable conversation');
    const converse = async text => {
      await page.getByLabel('Message your assistant').fill(text);
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await page.getByRole('status').waitFor({ state: 'hidden' });
    };
    for (const text of ['Does LIFEX cover specialist visits?', 'What about MedPerformance?', 'Which one has the better benefits?', "What's the deductible for LIFEX?"]) await converse(text);
    const multiTurn = (await app.evaluate(() => global.testRequests)).filter(request => request.path.endsWith('/conversation/message'));
    assert.deepEqual(multiTurn.slice(-4).map(request => request.body.message), ['Does LIFEX cover specialist visits?', 'What about MedPerformance?', 'Which one has the better benefits?', "What's the deductible for LIFEX?"]);
    assert.deepEqual(multiTurn.at(-1).body.workspacePlanHistory.slice(-3), ['Does LIFEX cover specialist visits?', 'What about MedPerformance?', 'Which one has the better benefits?']);
    assert.ok(multiTurn.every(request => request.body.sessionId === 'main-session'));
    const callsBeforeOwnerQuotes = multiTurn.length;
    const contextualRequests = ['Find a cheaper alternative for this client', 'Would the cheaper premium necessarily mean lower total costs?', 'Text me the quote', 'Draft a text with this comparison'];
    for (const text of contextualRequests) await converse(text);
    const ownerQuotes = (await app.evaluate(() => global.testRequests)).filter(request => request.path.endsWith('/conversation/message'));
    assert.equal(ownerQuotes.length, callsBeforeOwnerQuotes + contextualRequests.length, 'The server must resolve saved context and action intent before quote advice');
    assert.deepEqual(ownerQuotes.slice(-contextualRequests.length).map(request => request.body.message), contextualRequests);
    await converse('What is the monthly premium for 5000-hsa age 35 employee in Florida?');
    assert.equal((await app.evaluate(() => global.testRequests)).filter(request => request.path.endsWith('/conversation/message')).at(-1).body.message, 'What is the monthly premium for 5000-hsa age 35 employee in Florida?');
    await screenshot('artifacts/native-insurance-smoke.png');
    await converse('What states is this plan available in?');
    const afterQuote = (await app.evaluate(() => global.testRequests)).filter(request => request.path.endsWith('/conversation/message')).at(-1);
    assert.equal(afterQuote.body.message, 'What states is this plan available in?');
    assert.ok(afterQuote.body.workspacePlanHistory.includes('What is the monthly premium for 5000-hsa age 35 employee in Florida?'), 'Cross-engine plan context reaches the shared knowledge resolver');
    assert.equal(afterQuote.body.workspacePlanHistory.some(text => text.includes('$663.21')), false, 'Generated rates must not become user input or verified policy evidence');
    await converse("Draft an email to support about my client's missing ID cards.");
    await screenshot('artifacts/native-assistant-smoke.png');
    // A conversation can grow beyond the visible page while the app stays open.
    // Polling must expose the newest older-page cursor, then preserve that older
    // cursor after the owner starts paging instead of jumping back to the head.
    await app.evaluate(() => {
      const existing = global.histories.get(global.mainConversation.sessionId);
      const archive = Array.from({ length: 410 }, (_, index) => ({ id: `archive-${index + 1}`, role: index % 2 ? 'assistant' : 'user', content: `Archive message ${index + 1}`, createdAt: 1_700_000_000_000 + index, sequence: index + 1 }));
      existing.forEach((message, index) => { message.sequence = archive.length + index + 1; });
      global.histories.set(global.mainConversation.sessionId, [...archive, ...existing]);
    });
    await page.getByRole('button', { name: 'Load earlier messages', exact: true }).waitFor();
    assert.equal(await page.getByText('Archive message 1', { exact: true }).count(), 0, 'The initial page should remain bounded');
    await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click();
    await page.getByText('Archive message 200', { exact: true }).waitFor();
    assert.equal(await page.getByText('Archive message 1', { exact: true }).count(), 0, 'The first older page remains bounded');
    await page.waitForTimeout(5500);
    await page.getByRole('button', { name: 'Load earlier messages', exact: true }).click();
    await page.getByText('Archive message 1', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Load earlier messages', exact: true }).count(), 0, 'The history cursor is exhausted after the earlier page loads');
    assert.ok((await app.evaluate(() => global.testRequests)).some(request => request.method === 'GET' && /\?before=\d+&limit=200$/.test(request.search)), 'Older history is fetched through the same canonical session cursor');
    assert.equal((await app.evaluate(() => global.testRequests)).filter(request => request.method === 'DELETE' && request.path.includes('/conversation/session/')).length, 0, 'Permanent chat navigation and pagination never issue DELETE');
    await page.getByRole('tab', { name: 'Dialer', exact: true }).click();
    await screenshot('artifacts/native-dialer-smoke.png');
    await page.getByRole('tab', { name: 'Assistant', exact: true }).click();
    await app.evaluate(() => { global.invalidateSession = true; });
    await page.reload();
    await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('crokodial_auth_token')), null, 'An invalidated server session must clear native authentication');
    await page.reload();
    await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('crokodial_auth_token')), null);
    assert.equal(await page.evaluate(() => localStorage.getItem('crokodial_auth_user')), null);
    console.log('PASS: desktop login endpoint/header/envelope, invalid-login error, bearer session restoration and invalidated-session cleanup; all authentication uses isolated fixtures.');
    console.log('PASS: one server-selected main conversation survives reload, exposes no reset/new-chat control, never sends DELETE, and paginates the complete saved history.');
    console.log('PASS: unified dropdown-free assistant, server-owned quote/context/action routing, user-only context, native mounted dialer audio, dial input/draft preservation, pending assistant navigation, persistent history, plan catalog and no renderer errors. All platform responses isolated fixtures; no calls or messages sent. Real quote results are verified separately through the application sandbox.');
  } finally { await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {}); await app.close(); fs.rmSync(profile, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
