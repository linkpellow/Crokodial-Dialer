const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { _electron: electron } = require('playwright');
const { hideNativeWindows } = require('./fixtures/hide-native-windows.cjs');
(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'native-appointments-'));
  const app = await electron.launch({ executablePath: process.env.CROKODIAL_APP_EXECUTABLE || require('electron'), args: [path.resolve('.')], env: { ...process.env, CROKODIAL_USER_DATA_DIR: profile, CROKODIAL_RENDERER_URL: '' } });
  try {
    await hideNativeWindows(app);
    const page = await app.firstWindow(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(15000);
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) { window.hide(); window.setSize(356, 700); }
      global.fixture = { requests: [], notes: { 11: 'Saved notes for Taylor.', 12: 'Saved notes for Morgan.' }, revisions: { 11: 0, 12: 0 }, disposition: null, morganDisposition: null, holdDispositions: false, pendingDispositions: [], holdNotes: false, pendingNotes: [], failSave: false, failList: false, failNotes: false, reassociate: false, emptyList: false };
      ipcMain.removeHandler('api-fetch'); ipcMain.handle('api-fetch', async (_, payload) => {
        const url = new URL(payload.url), p = url.pathname, b = payload.body ? JSON.parse(payload.body) : {}, state = global.fixture;
        state.requests.push({ path: p, search: url.search, method: payload.method, body: b });
        let data = {}, status = 200;
        const at = (hour, day = 0) => { const date = new Date(); date.setDate(date.getDate() + day); date.setHours(hour, 0, 0, 0); return date.toISOString(); };
        const contact = id => ({ id, firstName: id === 11 ? 'Taylor' : 'Morgan', lastName: 'Fixture', e164: id === 11 ? '+12125550111' : '+12125550112', last_call_disposition: id === 11 ? state.disposition : state.morganDisposition });
        const row = (id, contactId, hour, extras = {}) => ({ id, contact_id: contactId, contact: contactId ? { ...contact(contactId), last_call_disposition: contactId === 11 ? state.disposition : state.morganDisposition } : null, scheduled_at: at(hour), duration: 30, status: 'scheduled', appointment_type: 'Consultation', follow_up_appointments: [], ...extras });
        if (p === '/api/auth/me') data = { id: 11, name: 'Appointments fixture', tenant_id: 9 };
        else if (p === '/api/appointments') {
          if (state.failList) { status = 503; data = { error: { message: 'Fixture appointment refresh interrupted.' } }; }
          else if (state.emptyList) data = [];
          else {
            const requested = new Date(url.searchParams.get('startDate')), today = new Date();
            data = requested.toDateString() === today.toDateString() ? [row(104, 12, 11), row(101, state.reassociate ? 12 : 11, 9), row(102, 11, 10), row('calendar:7', null, 12, { attendee_name: 'Unlinked Fixture' }), row(105, 12, 13, { status: 'cancelled' })] : Array.from({ length: 16 }, (_, index) => row(106 + index, 12, 9, { scheduled_at: new Date(Date.parse(at(9, 1)) + index * 30 * 60_000).toISOString() }));
          }
        }
        else if (p === '/api/dialer/dispositions') data = { dispositions: [{ id: 1, name: 'Appointment' }, { id: 2, name: 'No Show' }, { id: 3, name: 'Follow Up' }] };
        else if (/^\/api\/dialer\/contacts\/(11|12)\/disposition$/.test(p)) {
          if (state.holdDispositions) await new Promise(resolve => state.pendingDispositions.push(resolve));
          if (state.failSave) { status = 409; data = { error: { message: 'Fixture disposition was not saved.' } }; }
          else { if (p.includes('/contacts/11/')) state.disposition = b.disposition; else state.morganDisposition = b.disposition; data = { disposition: b.disposition, clientStatus: null }; }
        }
        else if (p === '/api/contacts/workspace') data = { contacts: [{ ...contact(12), name: 'Morgan Fixture', phone: '+12125550112', clientStatus: null }], hasMore: false, nextCursor: null };
        else if (p === '/api/contacts') data = { contacts: [contact(12)], pagination: {} };
        else if (/^\/api\/dialer\/leads\/(11|12)$/.test(p)) { const id = Number(p.split('/').pop()); data = { ...contact(id), call_notes: state.notes[id], notes_revision: state.revisions[id] }; }
        else if (/^\/api\/dialer\/contacts\/(11|12)\/notes$/.test(p)) {
          const id = Number(p.split('/')[4]);
          if (state.holdNotes) await new Promise(resolve => state.pendingNotes.push(resolve));
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
    const noon = new Date(); noon.setHours(14, 0, 0, 0); await page.clock.setFixedTime(noon);
    await page.reload();
    await page.getByRole('tab', { name: 'Notes', exact: true }).click();
    await page.locator('[data-appointment-id="101"]').waitFor();
    const search = page.locator('#notes-contact-search');
    const findContact = async query => {
      if (!await search.isVisible()) await page.locator('.workspace-appointments').getByRole('button', { name: /Search/, exact: false }).click();
      await search.fill(query);
    };
    assert.equal(await search.getAttribute('placeholder'), 'Name or phone');
    assert.equal(await search.isVisible(), false, 'Search starts collapsed');
    assert.equal(await page.getByRole('button', { name: 'Refresh appointments', exact: true }).count(), 0);
    const list = page.locator('.appointments-list');
    const refresh = () => page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); window.dispatchEvent(new Event('focus')); delete document.hidden; });
    const dateTrigger = page.locator('.mission-date-trigger');
    const back = () => page.getByRole('button', { name: 'Back to appointments', exact: true }).click();
    const first = page.locator('[data-appointment-id="101"]'), second = page.locator('[data-appointment-id="102"]');
    const disposition = page.getByRole('combobox', { name: 'Disposition', exact: true });
    const notes = page.locator('#contact-notes');
    const eventually = async (condition, message) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 40)); }
      assert.fail(message);
    };
    assert.deepEqual(await page.locator('.appointment-mini').evaluateAll(rows => rows.map(row => row.dataset.appointmentId)), ['101', '102', '104', 'calendar:7']);
    assert.equal(await list.locator('select').count(), 0, 'The compact list must not contain disposition dropdowns');
    assert.equal(await page.locator('.appointment-status-tab.needed').count(), 3);
    assert.equal(await notes.isVisible(), false, 'The editor is a separate view');
    const noContact = page.locator('[data-appointment-id="calendar:7"]');
    assert.equal(await noContact.locator('button').isDisabled(), true);
    assert.match(await noContact.locator('button').getAttribute('title'), /No linked contact/);
    fs.mkdirSync('artifacts/native-appointments', { recursive: true });
    await page.screenshot({ path: 'artifacts/native-appointments/appointment-list.png' });
    await first.locator('button').click();
    await notes.waitFor(); assert.equal(await notes.inputValue(), 'Saved notes for Taylor.');
    assert.equal(await list.isVisible(), false, 'Opening notes replaces the list without a second window');
    assert.equal(await search.isVisible(), false);
    const editorSize = await notes.boundingBox();
    assert.ok(editorSize && editorSize.height > 300, 'Detail view should give notes most of the narrow workspace height');
    assert.equal(await first.locator('button').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByRole('button', { name: 'Save notes', exact: true }).count(), 0);
    assert.equal(await page.getByText('Saved', { exact: true }).count(), 0);
    assert.equal((await app.evaluate(() => global.fixture.requests.filter(item => /\/(contacts|appointments)(\/|$)/.test(item.path) && (item.method === 'POST' || item.method === 'PATCH')))).length, 0);
    // Back flushes pending typing; saving never requires an explicit Save button.
    await notes.fill('Taylor draft autosaves when returning to the list.');
    await back();
    await list.waitFor();
    await eventually(() => app.evaluate(() => global.fixture.notes[11] === 'Taylor draft autosaves when returning to the list.'), 'Back must persist the canonical note');
    await first.locator('button').click();
    await page.waitForFunction(() => document.querySelector('#contact-notes')?.value === 'Taylor draft autosaves when returning to the list.');
    // A save that fails after switching contacts surfaces an actionable alert and
    // retains the original contact's draft without changing the open notes.
    await app.evaluate(() => { global.fixture.failNotes = true; global.fixture.holdNotes = true; });
    await notes.fill('Taylor draft preserved while visiting another appointment.');
    await back();
    await eventually(() => app.evaluate(() => global.fixture.pendingNotes.length === 1), 'The original contact save must be in flight');
    await page.locator('[data-appointment-id="104"] button').click();
    await page.waitForFunction(() => document.querySelector('#contact-notes')?.value === 'Saved notes for Morgan.');
    await app.evaluate(() => { global.fixture.holdNotes = false; global.fixture.pendingNotes.splice(0).forEach(resolve => resolve()); });
    await page.getByRole('alert').filter({ hasText: 'Another contact’s notes need attention.' }).waitFor();
    assert.equal(await notes.inputValue(), 'Saved notes for Morgan.', 'Background failure must not replace the current contact notes');
    await page.getByRole('button', { name: 'Review notes', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#contact-notes')?.value.startsWith('Taylor draft preserved'));
    await page.getByRole('alert').filter({ hasText: 'Fixture notes save interrupted.' }).waitFor();
    await page.getByRole('button', { name: 'Retry saving notes', exact: true }).waitFor();
    await app.evaluate(() => { global.fixture.failNotes = false; });
    await page.getByRole('button', { name: 'Retry saving notes', exact: true }).click();
    await eventually(() => app.evaluate(() => global.fixture.notes[11] === 'Taylor draft preserved while visiting another appointment.'), 'Retry must persist the existing draft');
    await back(); await first.locator('button').click();
    await notes.waitFor();
    // Disposition exists only in detail, with canonical appointment/contact/source.
    assert.equal(await disposition.inputValue(), '');
    assert.equal(await disposition.locator('option').first().innerText(), 'No Disposition');
    await app.evaluate(() => { global.fixture.failSave = true; });
    await disposition.selectOption('No Show'); await page.getByText('Fixture disposition was not saved.', { exact: true }).waitFor();
    assert.equal(await disposition.inputValue(), '');
    await app.evaluate(() => { global.fixture.failSave = false; });
    await disposition.selectOption('No Show');
    await eventually(() => app.evaluate(() => global.fixture.disposition === 'No Show'), 'Disposition must persist');
    await page.waitForFunction(() => document.querySelector('.appointment-disposition-control select')?.value === 'No Show');
    const mutations = await app.evaluate(() => global.fixture.requests.filter(item => item.path.endsWith('/disposition')));
    assert.deepEqual(mutations.at(-1).body, { disposition: 'No Show', source: 'appointments', appointmentId: 101 });
    await back(); assert.equal(await list.locator('select').count(), 0);
    await second.locator('button').click();
    await page.waitForFunction(() => document.querySelector('.appointment-disposition-control select')?.value === 'No Show');
    assert.equal(await notes.inputValue(), 'Taylor draft preserved while visiting another appointment.');
    await back();
    // Refresh synchronizes canonical dispositions and suppresses stale follow-up claims on failure.
    await app.evaluate(() => { global.fixture.disposition = 'Appointment'; });
    await refresh();
    await first.locator('button').click();
    await page.waitForFunction(() => document.querySelector('.appointment-disposition-control select')?.value === 'Appointment');
    await back();
    await app.evaluate(() => { global.fixture.failList = true; });
    await refresh();
    await page.getByText('Fixture appointment refresh interrupted.', { exact: false }).waitFor();
    assert.equal(await page.locator('.appointment-status-tab.needed').count(), 0);
    await app.evaluate(() => { global.fixture.failList = false; });
    await refresh();
    await page.locator('.appointment-status-tab.needed').first().waitFor();
    // The same web-style calendar is anchored below the date, commits immediately,
    // and restores focus after Escape without any native date input or Apply step.
    await dateTrigger.click();
    const calendar = page.getByRole('dialog', { name: 'Choose date', exact: true });
    await calendar.waitFor();
    assert.equal(await calendar.locator('[data-calendar-day]').count(), 42);
    assert.equal(await calendar.locator('[aria-pressed="true"]').count(), 1);
    assert.equal(await calendar.locator('[aria-current="date"]').count(), 1);
    const triggerBounds = await dateTrigger.boundingBox(), popupBounds = await calendar.boundingBox();
    assert.ok(popupBounds.y >= triggerBounds.y + triggerBounds.height, 'Calendar opens below its date trigger');
    const calendarGeometry = await calendar.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      const cells = [...element.querySelectorAll('[data-calendar-day]')].map(day => {
        const rect = day.getBoundingClientRect();
        return { width: rect.width, height: rect.height, top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right };
      });
      return { viewport: { width: innerWidth, height: innerHeight }, bounds: { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom }, cells };
    });
    assert.ok(calendarGeometry.bounds.left >= 0 && calendarGeometry.bounds.right <= calendarGeometry.viewport.width, 'Calendar is fully inside the narrow viewport');
    assert.ok(calendarGeometry.bounds.bottom <= calendarGeometry.viewport.height, 'Calendar fits vertically above the window edge');
    assert.ok(calendarGeometry.cells.every(cell => cell.width >= 30 && cell.height >= 39 && cell.left >= calendarGeometry.bounds.left && cell.right <= calendarGeometry.bounds.right), 'Every date has a usable unclipped pointer target');
    fs.writeFileSync('artifacts/native-appointments/calendar-geometry.json', JSON.stringify(calendarGeometry, null, 2));
    await page.screenshot({ path: 'artifacts/native-appointments/mini-calendar.png' });
    await page.keyboard.press('Escape'); assert.equal(await calendar.count(), 0);
    assert.equal(await dateTrigger.evaluate(element => element === document.activeElement), true);
    await dateTrigger.click(); await calendar.waitFor();
    await page.locator('.appointments-heading h2').click(); assert.equal(await calendar.count(), 0);
    await dateTrigger.click(); await calendar.waitFor();
    const currentKey = await dateTrigger.getAttribute('data-selected-date');
    const chosenKey = await calendar.locator('[data-calendar-day]').evaluateAll((buttons, key) => buttons.find(button => button.dataset.calendarDay > key)?.dataset.calendarDay, currentKey);
    await calendar.locator(`[data-calendar-day="${chosenKey}"]`).click();
    assert.equal(await calendar.count(), 0);
    assert.equal(await dateTrigger.getAttribute('data-selected-date'), chosenKey);
    assert.equal(await page.locator('.appointments-heading h2').innerText(), 'Appointments');
    await dateTrigger.click(); await calendar.waitFor();
    assert.equal(await calendar.locator('[aria-pressed="true"]').getAttribute('data-calendar-day'), chosenKey);
    assert.notEqual(await calendar.locator('[data-today="true"]').getAttribute('data-calendar-day'), chosenKey, 'Today remains distinct from selected day');
    await calendar.getByRole('button', { name: 'Next month', exact: true }).click();
    await calendar.getByRole('button', { name: 'Previous month', exact: true }).click();
    assert.equal(await calendar.locator('[aria-pressed="true"]').getAttribute('data-calendar-day'), chosenKey);
    await page.keyboard.press('Escape');
    await page.locator('[data-appointment-id="106"]').waitFor();
    await refresh();
    assert.equal(await dateTrigger.getAttribute('data-selected-date'), chosenKey, 'Automatic refresh keeps chosen day');
    await page.getByRole('button', { name: 'Today', exact: true }).click(); await first.waitFor();
    // The hidden list remains mounted: date and exact scroll survive the detail round-trip.
    await page.getByRole('button', { name: 'Next day', exact: true }).click(); await page.locator('[data-appointment-id="106"]').waitFor();
    const chosenDate = await dateTrigger.getAttribute('data-selected-date');
    const later = page.locator('[data-appointment-id="116"] .appointment-select');
    await later.scrollIntoViewIfNeeded();
    const scrollBefore = await list.evaluate(element => { element.dataset.fixturePreserved = 'yes'; return element.scrollTop; });
    assert.ok(scrollBefore > 0, 'Long fixture agenda must scroll independently');
    await later.click();
    await page.waitForFunction(() => document.querySelector('#contact-notes')?.value === 'Saved notes for Morgan.');
    await notes.fill('Morgan note autosaved from a later appointment.');
    await back();
    assert.equal(await dateTrigger.getAttribute('data-selected-date'), chosenDate);
    assert.equal(await list.getAttribute('data-fixture-preserved'), 'yes', 'List DOM must remain mounted');
    assert.ok(Math.abs((await list.evaluate(element => element.scrollTop)) - scrollBefore) <= 1, 'Back must preserve appointment scroll position');
    await eventually(() => app.evaluate(() => global.fixture.notes[12] === 'Morgan note autosaved from a later appointment.'), 'Later appointment note must persist to Morgan');
    await page.getByRole('button', { name: 'Today', exact: true }).click(); await first.waitFor(); await first.locator('button').click();
    // A web reassociation must not silently retarget open notes or leave stale disposition writes enabled.
    await app.evaluate(() => { global.fixture.reassociate = true; });
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); window.dispatchEvent(new Event('focus')); delete document.hidden; });
    await page.waitForFunction(() => document.querySelector('[data-appointment-id="101"] button')?.getAttribute('aria-pressed') === 'false');
    assert.equal(await notes.inputValue(), 'Taylor draft preserved while visiting another appointment.');
    assert.ok(!(await disposition.isVisible()) || await disposition.isDisabled(), 'A changed appointment binding must not write through the stale disposition control');
    await back();
    // Manual search still opens contacts without requiring appointment selection.
    await findContact('Morgan'); await page.getByRole('button', { name: 'Morgan Fixture +12125550112', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#contact-notes')?.value === 'Morgan note autosaved from a later appointment.');
    assert.equal(await page.locator('.appointment-select[aria-pressed="true"]').count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Record call', exact: true }).isDisabled(), true);
    // Search-contact disposition uses non-call semantics and accepted late writes
    // update only the same reopened contact, never another contact's editor.
    const manualDisposition = page.getByRole('combobox', { name: 'Disposition for Morgan Fixture', exact: true });
    await app.evaluate(() => { global.fixture.holdDispositions = true; });
    await manualDisposition.selectOption('Appointment');
    await eventually(() => app.evaluate(() => global.fixture.pendingDispositions.length === 1), 'Manual disposition must be in flight');
    await back(); await findContact('Morgan');
    await page.getByRole('button', { name: 'Morgan Fixture +12125550112', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#contact-notes')?.value === 'Morgan note autosaved from a later appointment.');
    assert.equal(await manualDisposition.isDisabled(), true, 'The same contact write is still in flight after reopening');
    await app.evaluate(() => { global.fixture.holdDispositions=false; global.fixture.pendingDispositions.splice(0).forEach(resolve=>resolve()); });
    await page.waitForFunction(() => document.querySelector('.notes-detail-view select')?.value === 'Appointment');
    const manualMutation = await app.evaluate(() => global.fixture.requests.filter(item => item.path === '/api/dialer/contacts/12/disposition').at(-1));
    assert.deepEqual(manualMutation.body, { disposition: 'Appointment', source: 'sms' });
    assert.equal(manualMutation.body.appointmentId, undefined);
    assert.equal(manualMutation.body.notes, undefined);
    await app.evaluate(() => { global.fixture.holdDispositions = true; });
    await manualDisposition.selectOption('Follow Up');
    await eventually(() => app.evaluate(() => global.fixture.pendingDispositions.length === 1), 'Second manual disposition must be in flight');
    await back(); await second.locator('button').click();
    await page.waitForFunction(() => document.querySelector('#contact-notes')?.value === 'Taylor draft preserved while visiting another appointment.');
    await app.evaluate(() => { global.fixture.holdDispositions=false; global.fixture.pendingDispositions.splice(0).forEach(resolve=>resolve()); });
    await eventually(() => app.evaluate(() => global.fixture.morganDisposition === 'Follow Up'), 'The accepted write should persist for the original contact');
    await page.waitForFunction(() => document.querySelector('.appointment-disposition-control select')?.disabled === false);
    assert.equal(await disposition.inputValue(), 'Appointment', 'A late Morgan save must never overwrite Taylor disposition');
    await back(); await findContact('Morgan');
    await page.getByRole('button', { name: 'Morgan Fixture +12125550112', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#contact-notes')?.value === 'Morgan note autosaved from a later appointment.');
    assert.equal(await manualDisposition.inputValue(), 'Follow Up');
    await notes.fill('Morgan note survives navigation with automatic saving.');
    await page.getByRole('tab', { name: 'Assistant', exact: true }).click(); await page.getByRole('tab', { name: 'Notes', exact: true }).click();
    assert.equal(await notes.inputValue(), 'Morgan note survives navigation with automatic saving.');
    await eventually(() => app.evaluate(() => global.fixture.notes[12] === 'Morgan note survives navigation with automatic saving.'), 'Tab navigation must retain and autosave notes');
    await back(); await first.locator('button').click();
    await page.waitForFunction(() => document.querySelector('[data-appointment-id="101"] button')?.getAttribute('aria-pressed') === 'true');
    assert.equal(await page.getByRole('button', { name: 'Save notes', exact: true }).count(), 0);
    await page.screenshot({ path: 'artifacts/native-appointments/contact-notes.png' });
    await page.screenshot({ path: 'artifacts/native-appointments/compact-notes.png' });
    const overflow = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    assert.equal(overflow.scroll <= overflow.width, true);
    await back();
    const dayBeforeMidnight = await dateTrigger.getAttribute('data-selected-date');
    const tomorrow = new Date(noon); tomorrow.setDate(tomorrow.getDate() + 1);
    await page.clock.setFixedTime(tomorrow); await refresh();
    await page.waitForFunction(() => document.querySelector('.appointments-heading h2')?.textContent === 'Appointments');
    assert.equal(await dateTrigger.getAttribute('data-selected-date'), dayBeforeMidnight, 'Crossing midnight must not change the selected calendar date');
    await app.evaluate(() => { global.fixture.emptyList = true; }); await refresh();
    await page.getByText('No appointments for this date.', { exact: true }).waitFor();
    assert.equal(await dateTrigger.getAttribute('data-selected-date'), dayBeforeMidnight);
    assert.deepEqual(errors, []);
    console.log('PASS isolated built Electron: separate appointment/detail views, automatic canonical note persistence, failure/retry and draft preservation, detail-only disposition mutation/error/sync, date/scroll restoration, reassociation guard, manual search and workspace navigation. No real data or calls used.');
  } catch (error) {
    console.error('Appointment fixture failure:', error);
    try { const failedPage=await app.firstWindow(); console.error(await failedPage.locator('body').innerText()); await failedPage.screenshot({path:'artifacts/native-appointments/failure.png'}); } catch {}
    throw error;
  } finally {
    // Failed autosave cases intentionally leave a protected draft in this disposable
    // profile. Destroy only fixture windows so beforeunload cannot mask the assertion.
    await app.evaluate(({BrowserWindow})=>{for(const window of BrowserWindow.getAllWindows())window.destroy();}).catch(()=>{});
    await app.close().catch(()=>{}); fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
