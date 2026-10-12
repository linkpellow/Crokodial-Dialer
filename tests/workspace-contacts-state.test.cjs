const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { buildSync } = require('esbuild');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-contacts-state-'));
buildSync({ stdin: { contents: `export * from './src/renderer/services/workspaceContactsApi';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', outfile: path.join(directory, 'state.cjs'), define: { 'import.meta.env.VITE_API_BASE': '"https://fixture.invalid"' } });
const api = require(path.join(directory, 'state.cjs'));
process.on('exit', () => fs.rmSync(directory, { recursive: true, force: true }));
global.localStorage = { getItem: () => null };
let requests = [], payload;
global.fetch = async (url, options) => { requests.push({ url, options }); return new Response(JSON.stringify({ data: payload }), { status: 200, headers: { 'Content-Type': 'application/json' } }); };
const contact = (overrides = {}) => ({ id: 2, name: 'Synthetic Person', firstName: 'Synthetic', lastName: 'Person', phone: '+12125550123', email: null, state: null, clientStatus: null, disposition: null, ...overrides });
const call = (overrides = {}) => ({ id: 'call:1', kind: 'call', callLogId: 1, occurredAt: '2026-10-12T14:00:00Z', direction: 'outbound', status: 'completed', outcome: 'answered', durationSeconds: 504, verified: true, source: 'telnyx', ...overrides });
test('owner contacts use scoped workspace query, actual membership filter, short search and opaque cursor', async () => {
  requests = []; payload = { contacts: [contact()], hasMore: true, nextCursor: 'next-cursor' };
  const result = await api.workspaceContactsApi.list({ filter: 'clients', search: ' Al ', cursor: 'opaque+/=' });
  assert.equal(result.contacts[0].id, 2);
  const url = new URL(requests[0].url);
  assert.equal(url.pathname, '/api/contacts/workspace');
  assert.equal(url.searchParams.get('filter'), 'clients'); assert.equal(url.searchParams.get('search'), 'Al');
  assert.equal(url.searchParams.get('cursor'), 'opaque+/=');
  assert.equal(url.searchParams.has('userId'), false); assert.equal(url.searchParams.has('tenantId'), false);
});
test('history is bound to exact contact and filter; unknown values remain unknown', async () => {
  requests = []; payload = { contactId: 2, items: [call({ direction: null, outcome: null, durationSeconds: null })], hasMore: false, nextCursor: null };
  assert.equal((await api.workspaceContactsApi.history(2, { filter: 'calls' })).items[0].durationSeconds, null);
  const url = new URL(requests[0].url); assert.equal(url.pathname, '/api/contacts/workspace/2/activity'); assert.equal(url.searchParams.get('filter'), 'calls');
  await assert.rejects(api.workspaceContactsApi.history(0), /valid contact/);
  payload.contactId = 3; await assert.rejects(api.workspaceContactsApi.history(2), /verify this contact/);
});
test('a repeated pagination cursor is rejected instead of looping indefinitely', async () => {
  payload = { contacts: [contact()], hasMore: true, nextCursor: 'same' };
  await assert.rejects(api.workspaceContactsApi.list({ cursor: 'same' }), /could not advance/);
  payload = { contactId: 2, items: [call()], hasMore: true, nextCursor: 'same' };
  await assert.rejects(api.workspaceContactsApi.history(2, { cursor: 'same' }), /could not advance/);
});
test('membership, identity, phone and duration presentation preserve actual data', () => {
  assert.equal(api.workspaceContactName(contact()), 'Synthetic Person');
  assert.equal(api.workspaceContactInitials(contact()), 'SP');
  assert.equal(api.workspaceContactPhone(contact().phone), '(212) 555-0123');
  assert.equal(api.workspaceContactPhone(null), 'No phone number');
  assert.equal(api.activityDuration(504), '8m 24s'); assert.equal(api.activityDuration(0), '0s');
  assert.equal(api.activityDuration(null), null); assert.equal(api.activityDuration(-1), null);
  assert.equal(api.activityStatus('no_show'), 'No show'); assert.equal(api.activityStatus(null), 'Status unavailable');
});
test('overlapping cursor pages keep stable identity without duplicate rows', () => {
  const rows = api.mergeWorkspaceRows([contact(), contact({ id: 3 })], [contact({ id: 3, name: 'Updated' }), contact({ id: 4 })]);
  assert.deepEqual(rows.map(row => row.id), [2, 3, 4]); assert.equal(rows[1].name, 'Updated');
});
test('malformed contact/history rows fail visibly before rendering', async () => {
  payload = { contacts: [contact({ phone: 123 })], hasMore: false, nextCursor: null };
  await assert.rejects(api.workspaceContactsApi.list(), /read the contact list/);
  payload = { contactId: 2, items: [call({ status: undefined })], hasMore: false, nextCursor: null };
  await assert.rejects(api.workspaceContactsApi.history(2), /verify this contact/);
});

test('fresh ID-descending head removes deleted or reclassified contacts while retaining older loaded pages', () => {
  const previous = [60, 59, 58, 57, 56, 55, 54].map(id => contact({ id }));
  const head = [61, 60, 58, 57].map(id => contact({ id }));
  assert.deepEqual(api.mergeWorkspaceContactHead(previous, head).map(row => row.id), [61, 60, 58, 57, 56, 55, 54]);
});
test('confirmed contact changes patch cached pages and honor membership filters without inventing records', () => {
  const rows = [contact(), contact({ id: 3, clientStatus: 'client' })];
  const closed = { id: 2, clientStatus: 'client', disposition: 'Closed' };
  assert.equal(api.patchWorkspaceContactRows(rows, 'all', closed)[0].clientStatus, 'client');
  assert.equal(api.patchWorkspaceContactRows(rows, 'all', closed)[0].disposition, 'Closed');
  assert.deepEqual(api.patchWorkspaceContactRows([contact(), contact({ id: 4 })], 'leads', closed).map(row => row.id), [4]);
  assert.deepEqual(api.patchWorkspaceContactRows([contact({ id: 3, clientStatus: 'client' }), contact({ id: 5, clientStatus: 'client' })], 'clients', { id: 3, clientStatus: 'former_client', disposition: null }).map(row => row.id), [5]);
  assert.equal(api.patchWorkspaceContactRows(rows, 'all', { ...closed, id: 999 }).length, 2);
});
