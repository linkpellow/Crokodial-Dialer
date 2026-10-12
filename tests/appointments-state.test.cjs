const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { buildSync } = require('esbuild');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-appointments-state-'));
buildSync({ stdin: { contents: `export * from './src/renderer/services/appointmentsApiService'; export * from './src/shared/appointmentFollowUpStatus';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: path.join(directory, 'state.cjs'), define: { 'import.meta.env.VITE_API_BASE': '"https://fixture.invalid"' } });
const api = require(path.join(directory, 'state.cjs'));
process.on('exit', () => fs.rmSync(directory, { recursive: true, force: true }));
let storedUser = null;
global.localStorage = { getItem: key => key === 'crokodial_auth_user' && storedUser ? JSON.stringify(storedUser) : null };
let requests = [], payload;
global.fetch = async (url, options) => { requests.push({ url, options }); return new Response(JSON.stringify({ data: payload }), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
const appointment = (overrides = {}) => ({ id: 10, contact_id: 2, contact: { id: 2, firstName: 'Synthetic', lastName: 'Person' }, appointment_type: 'Consultation', status: 'scheduled', scheduled_at: '2026-10-12T13:00:00Z', duration: 30, follow_up_appointments: [], ...overrides });

test('list uses canonical scoped endpoint, viewer timezone and follow-up evidence; filters and sorts without cloning records', async () => {
  requests = [];
  payload = [appointment({ id: 11, scheduled_at: '2026-10-12T15:00:00Z' }), appointment(), appointment(), appointment({ id: 12, status: 'cancelled' }), appointment({ id: 13, appointment_type: '[15-minute buffer before Consultation]' })];
  assert.deepEqual((await api.appointmentsApi.list('2026-10-12')).map(row => row.id), [10, 11]);
  assert.equal(requests.length, 1);
  const url = new URL(requests[0].url);
  assert.equal(url.pathname, '/api/appointments');
  assert.equal(url.searchParams.get('includeExternal'), 'true');
  assert.equal(url.searchParams.get('includeFollowUp'), 'true');
  assert.equal(url.searchParams.get('viewerTimeZone'), api.viewerTimeZone());
  assert.equal(new Date(url.searchParams.get('startDate')).getHours(), 0);
});
test('disposition binds canonical appointment/contact/source and never sends notes or creates contacts', async () => {
  requests = []; payload = { disposition: 'No Show', noShow: { notice: 'Saved' } };
  assert.equal((await api.appointmentsApi.saveDisposition(appointment(), 'No Show')).disposition, 'No Show');
  assert.equal(requests[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].options.body), { disposition: 'No Show', source: 'appointments', appointmentId: 10 });
  assert.equal(new URL(requests[0].url).pathname, '/api/dialer/contacts/2/disposition');
  await assert.rejects(api.appointmentsApi.saveDisposition(appointment({ contact: { id: 3 } }), 'No Show'), /no linked contact/);
  await assert.rejects(api.appointmentsApi.saveDisposition(appointment({ id: 'calendar:10' }), 'No Show'), /no linked contact/);
  assert.equal(requests.length, 1);
});
test('identity requires exact record IDs and membership does not revive a former client', () => {
  assert.equal(api.linkedAppointmentContact(appointment()), 2);
  assert.equal(api.linkedAppointmentContact(appointment({ contact_id: null })), null);
  assert.equal(api.linkedAppointmentContact(appointment({ contact: { id: 3, name: 'Synthetic Person' } })), null);
  assert.equal(api.appointmentIsClient(appointment({ contact: { id: 2, last_call_disposition: 'Closed' } })), true);
  assert.equal(api.appointmentIsClient(appointment({ contact: { id: 2, last_call_disposition: 'Closed', client_status: 'former_client' } })), false);
});
test('date navigation uses local calendar days across DST and rejects invalid dates', () => {
  assert.equal(api.shiftAppointmentDate('2026-03-08', 1), '2026-03-09');
  assert.equal(api.shiftAppointmentDate('2026-11-01', -1), '2026-10-31');
  assert.throws(() => api.appointmentDateRange('2026-02-30'), /valid date/);
});
test('follow-up status keeps time, contact evidence and disposition separate', () => {
  const now = new Date('2026-10-12T17:00:00Z');
  assert.equal(api.getAppointmentFollowUpStatus(appointment(), now, 'America/New_York'), 'needed');
  assert.equal(api.getAppointmentFollowUpStatus(appointment({ follow_up_appointments: [{ id: 11, contact_id: 2, status: 'scheduled', appointment_type: 'Follow up', scheduled_at: '2026-10-13T13:00:00Z' }] }), now, 'America/New_York'), 'scheduled');
  assert.equal(api.getAppointmentFollowUpStatus(appointment({ follow_up_appointments: undefined }), now, 'America/New_York'), null);
  assert.equal(api.getAppointmentFollowUpStatus(appointment({ contact: { id: 3 } }), now, 'America/New_York'), null);
});
test('visibility and follow-up rules remain identical to the canonical platform implementation', () => {
  const platform = process.env.CROKODIAL_PLATFORM_REPO || path.resolve('../CrokodialSMS-1/private-sms-app');
  for (const helper of ['appointmentFollowUpStatus', 'appointmentVisibility']) {
    assert.equal(fs.readFileSync(`src/shared/${helper}.ts`, 'utf8'), fs.readFileSync(path.join(platform, `packages/shared/src/utils/${helper}.ts`), 'utf8'));
  }
});
test('appointment rows show the complete slot in the viewer zone without inventing missing duration', () => {
  assert.equal(api.appointmentTimeSlot(appointment({ duration: 15 }), 'America/New_York'), '9:00am - 9:15am');
  assert.equal(api.appointmentTimeSlot(appointment({ duration: 45 }), 'America/Los_Angeles'), '6:00am - 6:45am');
  assert.equal(api.appointmentDateLabel(appointment(), 'America/New_York'), 'Mon, Oct 12');
  assert.equal(api.appointmentTimeSlot(appointment({ duration: undefined }), 'America/New_York'), '9:00am · End time unavailable');
  assert.equal(api.appointmentTimeSlot(appointment({ duration: 0 }), 'America/New_York'), '9:00am · End time unavailable');
  assert.equal(api.appointmentTimeSlot(appointment({ all_day: true }), 'America/New_York'), 'All day');
});
test('compact badges keep no-show, actual client membership and follow-up evidence distinct', () => {
  const now = new Date('2026-10-12T17:00:00Z');
  assert.deepEqual(api.appointmentStatusBadge(appointment({ status: 'no_show' }), now, true, 'America/New_York'), { text: 'No show', tone: 'no-show' });
  assert.deepEqual(api.appointmentStatusBadge(appointment({ contact: { id: 2, last_call_disposition: 'No Show', client_status: 'client' } }), now), { text: 'No show', tone: 'no-show' });
  assert.deepEqual(api.appointmentStatusBadge(appointment({ contact: { id: 2, client_status: 'client' } }), now), { text: 'Client', tone: 'client' });
  assert.deepEqual(api.appointmentStatusBadge(appointment(), now, true, 'America/New_York'), { text: 'Follow up needed', tone: 'needed' });
  assert.deepEqual(api.appointmentStatusBadge(appointment(), now, false, 'America/New_York'), { text: 'Scheduled', tone: 'neutral' });
  assert.deepEqual(api.appointmentStatusBadge(appointment({ follow_up_appointments: undefined, contact: { id: 2, last_call_disposition: 'Not interested' } }), now), { text: 'Not interested', tone: 'neutral' });
});
test('search-only disposition uses its existing contact binding without inventing an appointment or sending notes', async () => {
  requests = []; payload = { disposition: null };
  assert.equal((await api.appointmentsApi.saveContactDisposition(2, null)).disposition, null);
  assert.equal(new URL(requests[0].url).pathname, '/api/dialer/contacts/2/disposition');
  assert.deepEqual(JSON.parse(requests[0].options.body), { disposition: null, source: 'sms' });
  await assert.rejects(api.appointmentsApi.saveContactDisposition(0, 'No Show'), /valid contact/);
  await assert.rejects(api.appointmentsApi.saveContactDisposition('2', 'No Show'), /valid contact/);
  assert.equal(requests.length, 1);
});

test('account timezone controls calendar day boundaries, labels and follow-up queries independently of the system timezone', async () => {
  try {
    storedUser = { id: 11, timezone: 'America/Los_Angeles' };
    assert.equal(api.viewerTimeZone(), 'America/Los_Angeles');
    assert.equal(api.localDateValue(new Date('2026-10-13T02:00:00Z')), '2026-10-12');
    assert.equal(api.appointmentTimeSlot(appointment({ duration: 15 })), '6:00am - 6:15am');
    requests = []; payload = [];
    await api.appointmentsApi.list('2026-10-12');
    const query = new URL(requests[0].url).searchParams;
    assert.equal(query.get('viewerTimeZone'), 'America/Los_Angeles');
    assert.equal(query.get('startDate'), '2026-10-12T07:00:00.000Z');
    assert.equal(query.get('endDate'), '2026-10-13T06:59:59.999Z');
    storedUser = { id: 11, timezone: 'not/a-zone' };
    assert.equal(api.viewerTimeZone(), Intl.DateTimeFormat().resolvedOptions().timeZone);
  } finally { storedUser = null; }
});
test('configured-zone day boundaries cover spring/fall DST and fractional UTC offsets without losing appointments', () => {
  const spring = api.appointmentDateRange('2026-03-08', 'America/New_York');
  assert.equal(spring.start.toISOString(), '2026-03-08T05:00:00.000Z');
  assert.equal(spring.end.toISOString(), '2026-03-09T03:59:59.999Z');
  assert.equal(spring.end - spring.start + 1, 23 * 60 * 60 * 1000);
  const fall = api.appointmentDateRange('2026-11-01', 'America/New_York');
  assert.equal(fall.start.toISOString(), '2026-11-01T04:00:00.000Z');
  assert.equal(fall.end.toISOString(), '2026-11-02T04:59:59.999Z');
  assert.equal(fall.end - fall.start + 1, 25 * 60 * 60 * 1000);
  assert.equal(api.appointmentDateRange('2026-10-12', 'Asia/Kathmandu').start.toISOString(), '2026-10-11T18:15:00.000Z');
  assert.equal(api.shiftAppointmentDate('2026-12-31', 1), '2027-01-01');
});
test('explicit follow-up and closed outcomes receive rails, unrelated dispositions do not', () => {
  const now = new Date('2026-10-12T12:00:00Z');
  assert.equal(api.appointmentStatusBadge(appointment({ contact: { id: 2, last_call_disposition: 'Follow Up' } }), now).tone, 'needed');
  assert.equal(api.appointmentStatusBadge(appointment({ contact: { id: 2, last_call_disposition: 'Closed', client_status: null } }), now).tone, 'client');
  assert.equal(api.appointmentStatusBadge(appointment({ contact: { id: 2, last_call_disposition: 'Not interested' } }), now).tone, 'neutral');
});
