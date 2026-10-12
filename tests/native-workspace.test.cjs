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
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(({ ipcMain }) => {
      global.testRequests = [];
      global.invalidateSession = false;
      global.sessionResetResult = { status: 404, code: 'NOT_FOUND', message: 'Test session not found' };
      let sessionCount = 0;
      ipcMain.removeHandler('api-fetch');
      ipcMain.handle('api-fetch', async (_, payload) => {
        const request = { path: new URL(payload.url).pathname, method: payload.method, body: payload.body && JSON.parse(payload.body), headers: payload.headers };
        global.testRequests.push(request);
        let data = {}, status = 200;
        if (request.path === '/api/auth/me') {
          if (request.headers?.Authorization === 'Bearer isolated-desktop-test-token' && !global.invalidateSession) data = { id: 11, name: 'Workspace test', email: 'native-smoke@example.test', tenant_id: 9 };
          else { status = 401; data = { error: { code: 'NO_TOKEN', message: 'No authentication token provided' } }; }
        }
        else if (request.path === '/api/auth/desktop/login') {
          if (request.headers?.['x-crokodial-desktop-client'] !== 'crokodial-sms-desktop') { status = 400; data = { error: { code: 'DESKTOP_CLIENT_REQUIRED', message: 'Valid desktop client header is required' } }; }
          else if (request.body?.email !== 'native-smoke@example.test' || request.body?.password !== 'Synthetic-test-password') { status = 401; data = { error: { message: 'Invalid email or password' } }; }
          else data = { token: 'isolated-desktop-test-token', user: { id: 11, name: 'Workspace test', email: 'native-smoke@example.test', tenant_id: 9 } };
        }
        else if (request.path === '/api/auth/login') { status = 400; data = { error: { message: 'Native client must use the desktop login contract' } }; }
        else if (request.path === '/api/ai-agents') data = [{ id: 7, name: 'Personal Assistant', role: 'personal_assistant' }, { id: 9, name: 'Second Assistant', role: 'personal_assistant' }, { id: 8, name: 'Sales', role: 'sales' }];
        else if (request.path === '/api/insurance-plans') data = { plans: [{ id: 'lifex', name: 'LIFEX', variants: [{ id: 'lifex-hsa-3500', name: 'HSA 3500' }] }] };
        else if (request.path === '/api/insurance-plans/lifex') data = { instructions: 'Verified plan guidance fixture', announcements: [{ id: 'announcement-1', title: 'Portal delay', body: 'Review the effective date before escalation.', active: true, effectiveFrom: null, expiresAt: null, affectedEffectiveFrom: '2026-10-01', affectedEffectiveTo: '2026-10-01' }], supportContacts: [{ id: 'support', label: 'Support', email: 'support@example.test', purpose: 'Portal issues' }], documents: [] };
        else if (request.path === '/api/dialer/voice-session') { status = 403; data = { error: { message: 'Calling disabled for this isolated UI test' } }; }
        else if (request.path.endsWith('/test/session')) data = { sessionId: `session-${++sessionCount}` };
        else if (request.method === 'DELETE' && request.path.includes('/test/session/')) {
          await new Promise(resolve => { global.releaseSessionReset = resolve; });
          status = global.sessionResetResult.status;
          if (status !== 200) data = { error: { code: global.sessionResetResult.code, message: global.sessionResetResult.message } };
        }
        else if (request.path.endsWith('/test/message')) {
          await new Promise(resolve => setTimeout(resolve, 900));
          data = { success: true, message: 'Verified test reply. Your draft remains private.', grounding: { citations: ['Test plan instructions'] }, proposedActions: [{ name: 'draft_support_email' }] };
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
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible() || window.isFocusable())), false, 'Authentication and renderer reload must not restore native focus');
    await page.getByPlaceholder('Enter number').fill('2125550123');
    await page.evaluate(() => { window.originalCallAudio = document.querySelector('#dialer-workspace audio'); });
    await page.getByRole('tab', { name: 'Assistant', exact: true }).click();
    await page.getByLabel('Message your assistant').waitFor();
    assert.equal(await page.locator('.assistant-workspace select').count(), 0, 'Automatic routing must not require mode, assistant, plan or variation selectors');
    assert.equal(await page.getByRole('heading', { name: 'How can I help?' }).count(), 0);
    assert.equal(await page.getByText('Explain the active plan announcements', { exact: true }).count(), 0);
    fs.mkdirSync('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/native-assistant-unified-empty.png' });
    await page.getByLabel('Message your assistant').fill('An unfinished support draft');
    await page.getByRole('tab', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Dialer', exact: true }).click();
    assert.equal(await page.getByPlaceholder('Enter number').inputValue(), '2125550123');
    assert.equal(await page.evaluate(() => window.originalCallAudio === document.querySelector('#dialer-workspace audio')), true);
    await page.getByRole('tab', { name: 'Assistant', exact: true }).click();
    assert.equal(await page.getByLabel('Message your assistant').inputValue(), 'An unfinished support draft');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'New conversation', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isDisabled(), true);
    await page.getByRole('tab', { name: 'Dialer', exact: true }).click();
    await page.getByRole('tab', { name: 'Assistant', exact: true }).click();
    await page.getByText('Verified test reply. Your draft remains private.', { exact: true }).waitFor();
    await page.getByLabel('Message your assistant').fill('Follow up');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByRole('status').waitFor({ state: 'hidden' });
    const requests = await app.evaluate(() => global.testRequests);
    assert.equal(requests.filter(request => request.path.endsWith('/test/session') && request.method === 'POST').length, 1, 'Conversation must reuse one session');
    assert.equal(requests.filter(request => request.path.endsWith('/test/message')).length, 2);
    assert.equal(requests.find(request => request.path.endsWith('/test/message')).body.audience, 'agent');
    assert.equal(requests.find(request => request.path === '/api/insurance-plans').headers['x-crokodial-contract-version'], '2026-02-26.1');
    assert.ok(requests.some(request => request.path === '/api/dialer/voice-session'));
    assert.equal(errors.length, 0, errors.join('\n'));
    fs.mkdirSync('artifacts', { recursive: true });
    await page.screenshot({ path: 'artifacts/native-assistant-smoke.png' });
    const converse = async text => {
      await page.getByLabel('Message your assistant').fill(text);
      await page.getByRole('button', { name: 'Send message', exact: true }).click();
      await page.getByRole('status').waitFor({ state: 'hidden' });
    };
    for (const text of ['Does LIFEX cover specialist visits?', 'What about MedPerformance?', 'Which one has the better benefits?', "What's the deductible for LIFEX?"]) await converse(text);
    const multiTurn = (await app.evaluate(() => global.testRequests)).filter(request => request.path.endsWith('/test/message'));
    assert.deepEqual(multiTurn.slice(-4).map(request => request.body.message), ['Does LIFEX cover specialist visits?', 'What about MedPerformance?', 'Which one has the better benefits?', "What's the deductible for LIFEX?"]);
    assert.deepEqual(multiTurn.at(-1).body.workspacePlanHistory.slice(-3), ['Does LIFEX cover specialist visits?', 'What about MedPerformance?', 'Which one has the better benefits?']);
    assert.ok(multiTurn.every(request => request.body.sessionId === 'session-1'));
    const callsBeforeClarification = multiTurn.length;
    await converse('Find a cheaper alternative for this client');
    await page.getByText('What age should I use for the quote, and is coverage for the employee only, a spouse, or a family? Include the state so I can check availability.', { exact: true }).waitFor();
    assert.equal((await app.evaluate(() => global.testRequests)).filter(request => request.path.endsWith('/test/message')).length, callsBeforeClarification, 'Missing quote inputs are clarified without an extra model request');
    await converse('What is the monthly premium for 5000-hsa age 35 employee in Florida?');
    await page.getByText(/\$663\.21\/mo/).waitFor();
    await page.screenshot({ path: 'artifacts/native-insurance-smoke.png' });
    await converse('What states is this plan available in?');
    const afterQuote = (await app.evaluate(() => global.testRequests)).filter(request => request.path.endsWith('/test/message')).at(-1);
    assert.equal(afterQuote.body.message, 'What states is this plan available in?');
    assert.ok(afterQuote.body.workspacePlanHistory.includes('What is the monthly premium for 5000-hsa age 35 employee in Florida?'), 'Cross-engine plan context reaches the shared knowledge resolver');
    assert.equal(afterQuote.body.workspacePlanHistory.some(text => text.includes('$663.21')), false, 'Generated rates must not become user input or verified policy evidence');
    await converse("Draft an email to support about my client's missing ID cards.");
    await page.screenshot({ path: 'artifacts/native-assistant-smoke.png' });
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    await page.getByText('Clearing conversation…', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Message your assistant').isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Send message', exact: true }).isDisabled(), true);
    await app.evaluate(() => global.releaseSessionReset());
    await page.getByRole('status').waitFor({ state: 'hidden' });
    assert.equal(await page.getByLabel('Message your assistant').inputValue(), '');
    assert.equal(await page.getByRole('alert').count(), 0, 'An already missing session resets successfully after a server restart');
    assert.equal(await page.getByText('Verified test reply. Your draft remains private.', { exact: true }).count(), 0);
    assert.equal(await page.getByText(/\$663\.21\/mo/).count(), 0, 'New conversation clears both capabilities together');
    await page.getByLabel('Message your assistant').fill('Start a new session after the restart');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await page.getByText('Verified test reply. Your draft remains private.', { exact: true }).waitFor();
    assert.equal((await app.evaluate(() => global.testRequests)).filter(request => request.path.endsWith('/test/session') && request.method === 'POST').length, 2, 'Reset must discard the stale remote session ID');
    await page.getByLabel('Message your assistant').fill('Keep this draft if reset is denied');
    for (const failure of [{ status: 403, code: 'FORBIDDEN', message: 'Access denied' }, { status: 404, code: 'NOT_FOUND', message: 'AI agent not found' }]) {
      await app.evaluate((_, result) => { global.sessionResetResult = result; }, failure);
      await page.getByRole('button', { name: 'New conversation', exact: true }).click();
      await page.getByText('Clearing conversation…', { exact: true }).waitFor();
      await app.evaluate(() => global.releaseSessionReset());
      await page.getByRole('alert').filter({ hasText: failure.message }).waitFor();
      assert.equal(await page.getByLabel('Message your assistant').inputValue(), 'Keep this draft if reset is denied');
      assert.equal(await page.getByLabel('Message your assistant').isDisabled(), false);
      assert.equal(await page.getByText('Verified test reply. Your draft remains private.', { exact: true }).count(), 1, 'Real reset failures must preserve the conversation');
    }
    await page.getByRole('tab', { name: 'Dialer', exact: true }).click();
    await page.screenshot({ path: 'artifacts/native-dialer-smoke.png' });
    await page.getByRole('tab', { name: 'Assistant', exact: true }).click();
    await app.evaluate(() => { global.invalidateSession = true; global.sessionResetResult = { status: 401, code: 'TOKEN_EXPIRED', message: 'Session expired' }; });
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    await page.getByText('Clearing conversation…', { exact: true }).waitFor();
    await app.evaluate(() => global.releaseSessionReset());
    await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('crokodial_auth_token')), null, 'Reset401 must still invalidate authentication');
    await page.reload();
    await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('crokodial_auth_token')), null);
    assert.equal(await page.evaluate(() => localStorage.getItem('crokodial_auth_user')), null);
    console.log('PASS: desktop login endpoint/header/envelope, invalid-login error, bearer session restoration and invalidated-session cleanup; all authentication uses isolated fixtures.');
    console.log('PASS: missing remote session404 clears locally and creates a fresh session; forbidden/missing-agent errors preserve drafts and turns; reset401 still signs out.');
    console.log('PASS: actual packaged insurance worker quote; unified dropdown-free assistant, natural multi-turn handoff/user-only context, missing-input clarification, native mounted dialer audio, dial input/draft preservation, pending assistant navigation, persistent sessions, delayed reset locking, permission error, plan catalog and no renderer errors. All platform responses isolated fixtures; no calls or messages sent.');
  } finally { await app.close(); fs.rmSync(profile, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
