const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { _electron: electron } = require('playwright');
const { hideNativeWindows } = require('./fixtures/hide-native-windows.cjs');
(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'native-appointments-'));
  const app = await electron.launch({ executablePath: process.env.CROKODIAL_APP_EXECUTABLE || require('electron'), args: [path.resolve('.')], env: { ...process.env, CROKODIAL_USER_DATA_DIR: profile, CROKODIAL_RENDERER_URL: '' } });
  try {
    const page = await app.firstWindow(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await hideNativeWindows(app);
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) { window.hide(); window.setSize(356, 700); }
      global.fixture = { requests: [], notes: { 11: 'Saved notes for Taylor.', 12: 'Saved notes for Morgan.' }, revisions: { 11: 0, 12: 0 }, disposition: null, failSave: false, failList: false, failNotes: false, reassociate: false };
      ipcMain.removeHandler('api-fetch'); ipcMain.handle('api-fetch', async (_, payload) => {
        const url = new URL(payload.url), p = url.pathname, b = payload.body ? JSON.parse(payload.body) : {}, state = global.fixture;
        state.requests.push({ path: p, search: url.search, method: payload.method, body: b });
        let data = {}, status = 200;
        const at = (hour, day = 0) => { const date = new Date(); date.setDate(date.getDate() + day); date.setHours(hour, 0, 0, 0); return date.toISOString(); };
        const contact = id => ({ id, firstName: id === 11 ? 'Taylor' : 'Morgan', lastName: 'Fixture', e164: id === 11 ? '+12125550111' : '+12125550112' });
        const row = (id, contactId, hour, extras = {}) => ({ id, contact_id: contactId, contact: contactId ? { ...contact(contactId), last_call_disposition: state.disposition } : null, scheduled_at: at(hour), duration: 30, status: 'scheduled', appointment_type: 'Consultation', follow_up_appointments: [], ...extras });
        if (p === '/api/auth/me') data = { id: 11, name: 'Appointments fixture', tenant_id: 9 };
        else if (p === '/api/appointments') {
          if (state.failList) { status = 503; data = { error: { message: 'Fixture appointment refresh interrupted.' } }; }
          else {
            const requested = new Date(url.searchParams.get('startDate')), today = new Date();
            data = requested.toDateString() === today.toDateString() ? [row(104, 12, 11), row(101, state.reassociate ? 12 : 11, 9), row(102, 11, 10), row('calendar:7', null, 12, { attendee_name: 'Unlinked Fixture' }), row(105, 12, 13, { status: 'cancelled' })] : [row(106, 12, 9, { scheduled_at: at(9, 1) })];
          }
        }
        else if (p === '/api/dialer/dispositions') data = { dispositions: [{ id: 1, name: 'Appointment' }, { id: 2, name: 'No Show' }, { id: 3, name: 'Follow Up' }] };
        else if (/^\/api\/dialer\/contacts\/11\/disposition$/.test(p)) {
          if (state.failSave) { status = 409; data = { error: { message: 'Fixture disposition was not saved.' } }; }
          else { state.disposition = b.disposition; data = { disposition: b.disposition, clientStatus: null }; }
        }
        else if (p === '/api/contacts') data = { contacts: [contact(12)], pagination: {} };
        else if (/^\/api\/dialer\/leads\/(11|12)$/.test(p)) { const id = Number(p.split('/').pop()); data = { ...contact(id), call_notes: state.notes[id], notes_revision: state.revisions[id] }; }
        else if (/^\/api\/dialer\/contacts\/(11|12)\/notes$/.test(p)) {
          const id = Number(p.split('/')[4]);
          if (state.failNotes) { status = 503; data = { error: { message: 'Fixture notes save interrupted.' } }; }
          else { state.notes[id] = b.notes; state.revisions[id]++; data = { contactId: id, notes: state.notes[id], notesRevision: state.revisions[id] }; }
        }
        else if (/\/recording-sessions$/.test(p)) data = { sessions: [] };
        else if (p === '/api/dialer/voice-session') { status = 403; data = { error: { message: 'Calling disabled in isolated appointment test.' } }; }
        else if (['/api/ai-agents', '/api/phone-numbers'].includes(p)) data = [];
        else if (p === '/api/insurance-plans') data = { plans: [] };
        return { ok: status < 400, status, statusText: 'Fixture', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(status < 400 ? { success: true, data } : { success: false, ...data }) };
      });
    });
    await page.evaluate(() => { localStorage.setItem('crokodial_auth_token', 'isolated-appointment-fixture'); localStorage.setItem('crokodial_auth_user', JSON.stringify({ id: 11, name: 'Appointments fixture', tenant_id: 9 })); });
    await page.reload();
    const noon = new Date(); noon.setHours(14, 0, 0, 0); await page.clock.setFixedTime(noon);
    await page.getByRole('tab', { name: 'Notes', exact: true }).click();
    await page.locator('[data-appointment-id="101"]').waitFor();
    assert.deepEqual(await page.locator('.appointment-mini').evaluateAll(rows => rows.map(row => row.dataset.appointmentId)), ['101', '102', '104', 'calendar:7']);
    assert.equal(await page.getByText('Follow Up Needed', { exact: true }).count(), 3);
    const noContact = page.locator('[data-appointment-id="calendar:7"]');
    assert.equal(await noContact.locator('button').isDisabled(), true); assert.equal(await noContact.locator('select').isDisabled(), true);
    assert.match(await noContact.innerText(), /No linked contact/);
    const first = page.locator('[data-appointment-id="101"]'), second = page.locator('[data-appointment-id="102"]');
    await first.locator('button').click();
    await page.locator('#contact-notes').waitFor(); assert.equal(await page.locator('#contact-notes').inputValue(), 'Saved notes for Taylor.');
    assert.equal(await first.locator('button').getAttribute('aria-pressed'), 'true');
    assert.equal((await app.evaluate(() => global.fixture.requests.filter(item => /\/(contacts|appointments)(\/|$)/.test(item.path) && (item.method === 'POST' || item.method === 'PATCH')))).length, 0);
    // A failed save and a later canonical refresh must not replace local typing.
    await app.evaluate(() => { global.fixture.failNotes = true; });
    await page.locator('#contact-notes').fill('Taylor draft preserved while visiting another appointment.');
    await page.getByRole('button', { name: 'Save notes', exact: true }).click();
    await page.getByText('Fixture notes save interrupted.', { exact: true }).waitFor();
    await page.locator('[data-appointment-id="104"] button').click();
    await page.waitForFunction(() => document.querySelector('#contact-notes')?.value === 'Saved notes for Morgan.');
    await first.locator('button').click();
    await page.waitForFunction(() => document.querySelector('#contact-notes')?.value.startsWith('Taylor draft preserved'));
    await app.evaluate(() => { global.fixture.failNotes = false; });
    await page.getByRole('button', { name: 'Save notes', exact: true }).click(); await page.getByText('Saved', { exact: true }).waitFor();
    // Same canonical disposition source and explicit appointment ID as the web.
    await app.evaluate(() => { global.fixture.failSave = true; });
    await first.locator('select').selectOption('No Show'); await page.getByText('Fixture disposition was not saved.', { exact: true }).waitFor();
    assert.equal(await first.locator('select').inputValue(), '');
    await app.evaluate(() => { global.fixture.failSave = false; });
    await first.locator('select').selectOption('No Show'); await page.getByText('Disposition saved for Taylor Fixture.', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('[data-appointment-id="102"] select')?.value === 'No Show');
    const mutations = await app.evaluate(() => global.fixture.requests.filter(item => item.path.endsWith('/disposition')));
    assert.deepEqual(mutations.at(-1).body, { disposition: 'No Show', source: 'appointments', appointmentId: 101 });
    // External changes are visible on refresh; a failed refresh suppresses stale follow-up claims.
    await app.evaluate(() => { global.fixture.disposition = 'Appointment'; });
    await page.getByRole('button', { name: 'Refresh appointments', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-appointment-id="101"] select')?.value === 'Appointment');
    await app.evaluate(() => { global.fixture.failList = true; });
    await page.getByRole('button', { name: 'Refresh appointments', exact: true }).click();
    await page.getByText('Fixture appointment refresh interrupted.', { exact: false }).waitFor();
    assert.equal(await page.getByText('Follow Up Needed', { exact: true }).count(), 0);
    await app.evaluate(() => { global.fixture.failList = false; });
    await page.getByRole('button', { name: 'Refresh appointments', exact: true }).click();
    await page.getByText('Follow Up Needed', { exact: true }).first().waitFor();
    await page.getByRole('button', { name: 'Next day', exact: true }).click(); await page.locator('[data-appointment-id="106"]').waitFor();
    assert.equal(await page.locator('#contact-notes').inputValue(), 'Taylor draft preserved while visiting another appointment.');
    await page.getByRole('button', { name: 'Today', exact: true }).click(); await first.waitFor();
    // Re-associating the appointment in the web app must not silently retarget an open note.
    await app.evaluate(() => { global.fixture.reassociate = true; });
    await page.getByRole('button', { name: 'Refresh appointments', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-appointment-id="101"] button')?.getAttribute('aria-pressed') === 'false');
    assert.equal(await page.locator('#contact-notes').inputValue(), 'Taylor draft preserved while visiting another appointment.');
    await page.getByLabel('Find a contact', { exact: true }).fill('Morgan'); await page.getByRole('button', { name: 'Morgan Fixture +12125550112', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#contact-notes')?.value === 'Saved notes for Morgan.');
    assert.equal(await page.locator('.appointment-select[aria-pressed="true"]').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Record call', exact: true }).isDisabled(), true);
    await page.getByRole('tab', { name: 'Assistant', exact: true }).click(); await page.getByRole('tab', { name: 'Notes', exact: true }).click();
    assert.equal(await page.locator('#contact-notes').inputValue(), 'Saved notes for Morgan.');
    await page.getByRole('button', { name: 'Back to appointments', exact: true }).click();
    await first.locator('button').click();
    await page.waitForFunction(() => document.querySelector('[data-appointment-id="101"] button')?.getAttribute('aria-pressed') === 'true');
    await page.locator('.notes-scroll').evaluate(element => { element.scrollTop = 0; });
    fs.mkdirSync('artifacts/native-appointments', { recursive: true }); await page.screenshot({ path: 'artifacts/native-appointments/compact-notes.png' });
    const overflow = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    assert.equal(overflow.scroll <= overflow.width, true);
    assert.deepEqual(errors, []);
    console.log('PASS isolated built Electron: chronological appointments, narrow layout, existing contact notes, failed-draft preservation, exact disposition mutation/error/sync, date navigation, reassociation guard, manual search and workspace navigation. No real data or calls used.');
  } finally { await app.close(); fs.rmSync(profile, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
