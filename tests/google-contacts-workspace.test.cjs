const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build } = require('esbuild');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crokodial-google-contacts-'));
let api;
before(async () => {
  await build({
    entryPoints: ['src/renderer/services/assistantWorkspaceApi.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(directory, 'api.cjs'),
    plugins: [{
      name: 'workspace-api-fixtures',
      setup(build) {
        build.onResolve({ filter: /assistantApiService$/ }, () => ({ path: 'assistant-api', namespace: 'fixture' }));
        build.onResolve({ filter: /dialerApiService$/ }, () => ({ path: 'dialer-api', namespace: 'fixture' }));
        build.onResolve({ filter: /assistantConnections$/ }, () => ({ path: 'connections', namespace: 'fixture' }));
        build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path: fixture }) => ({ contents: fixture === 'assistant-api'
          ? `exports.apiRequest = (...args) => global.__contactsApiRequest(...args); exports.platformUrl = value => new URL(value, 'https://platform.example.test/').href; exports.AssistantApiError = class extends Error {};`
          : fixture === 'dialer-api'
            ? `exports.getAuthHeaders = () => ({}); exports.getStoredUser = () => null; exports.logout = () => {};`
            : `exports.normalizeGmailCapabilities = value => value;`, loader: 'js' }));
      },
    }],
  });
  api = require(path.join(directory, 'api.cjs'));
});
after(() => fs.rmSync(directory, { recursive: true, force: true }));

test('Google Contacts launch uses the isolated one-use native OAuth ticket contract', async () => {
  const calls = [];
  global.__contactsApiRequest = async (...args) => {
    calls.push(args);
    return { authorizationUrl: '/api/auth/google/contacts/desktop/authorize?ticket=one-use-fixture', expiresAt: new Date(Date.now() + 60_000).toISOString(), capabilities: ['contacts_read'] };
  };
  const result = await api.beginGoogleContactsConnection(['contacts_read']);
  assert.equal(result.authorizationUrl, 'https://platform.example.test/api/auth/google/contacts/desktop/authorize?ticket=one-use-fixture');
  assert.equal(calls[0][0], '/api/auth/google/contacts/desktop/connect');
  assert.deepEqual(JSON.parse(calls[0][1].body), { capabilities: ['contacts_read'] });

  await assert.rejects(api.beginGoogleContactsConnection(['unknown']), /valid Google Contacts capability/);
  global.__contactsApiRequest = async () => ({ authorizationUrl: 'https://attacker.example/steal?ticket=fixture', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  await assert.rejects(api.beginGoogleContactsConnection(['contacts_read']), /connection link is unavailable/);
});

test('Google Workspace launch keeps read-only connection separate from Sheet write upgrade', async () => {
  const calls = [];
  global.__contactsApiRequest = async (...args) => {
    calls.push(args);
    return { authorizationUrl: '/api/auth/google/workspace/desktop/authorize?ticket=one-use-workspace', expiresAt: new Date(Date.now() + 60_000).toISOString(), capabilities: JSON.parse(args[1].body).capabilities };
  };
  await api.beginGoogleWorkspaceConnection(['drive_read', 'sheets_read']);
  await api.beginGoogleWorkspaceConnection(['drive_read', 'sheets_read', 'sheets_write']);
  assert.deepEqual(JSON.parse(calls[0][1].body), { capabilities: ['drive_read', 'sheets_read'] });
  assert.deepEqual(JSON.parse(calls[1][1].body), { capabilities: ['drive_read', 'sheets_read', 'sheets_write'] });
});

test('native card auto-runs only bounded reads and requires explicit write clicks', () => {
  const source = fs.readFileSync('src/renderer/components/NativeGoogleContacts.tsx', 'utf8');
  assert.match(source, /if \(isWrite\(grant\) \|\| grant\.state !== 'approved'/);
  assert.match(source, /grant\.state === 'pending' && isWrite\(grant\)[\s\S]*onClick=\{\(\) => void decide\(grant, 'approve'\)\}/);
  assert.match(source, /grant\.state === 'approved' && isWrite\(grant\)[\s\S]*onClick=\{\(\) => void executeWrite\(grant\)\}/);
  assert.match(source, /const readCapability = \['contacts_read'\] as const/);
  assert.match(source, /const requestedCapabilities = required\?\.length \? required : readCapability/);
  assert.match(source, /connect\(requestedCapabilities\)/);
  assert.match(source, /connect\(writeCapabilities\)/);
});

test('completed Google receipts stay in the continuous chat with operation-specific labels', () => {
  const contacts = fs.readFileSync('src/renderer/components/NativeGoogleContacts.tsx', 'utf8');
  assert.match(contacts, /\['pending', 'approved', 'executing', 'succeeded', 'unknown', 'failed'\]\.includes\(grant\.state\)/);

  const workspace = fs.readFileSync('src/renderer/components/NativeGoogleWorkspace.tsx', 'utf8');
  assert.match(workspace, /const isWrite = \(grant: GoogleWorkspaceToolGrant\)/);
  assert.match(workspace, /\['pending', 'approved', 'executing', 'succeeded', 'unknown', 'failed'\]\.includes\(grant\.state\)/);
  assert.match(workspace, /const runConnectedRead = useCallback/);
  assert.match(workspace, /if \(isWrite\(grant\) \|\| !\['pending', 'approved'\]\.includes\(grant\.state\)/);
  assert.match(workspace, /grant\.state === 'pending' && isWrite\(grant\)[\s\S]*Approve exact Sheet write/);
  assert.match(workspace, /grant\.state === 'approved' && isWrite\(grant\)[\s\S]*Execute approved write once/);
  assert.match(workspace, /const readCapabilities = \['drive_read', 'sheets_read'\] as const/);
  assert.match(workspace, /const writeCapabilities = \['drive_read', 'sheets_read', 'sheets_write'\] as const/);
  assert.match(workspace, /new Set<GoogleWorkspaceCapability>\(\[\.\.\.\(status\?\.capabilities \?\? \[\]\), \.\.\.required\]\)/);
  assert.match(workspace, /connect\(requestedCapabilities\)/);
  assert.match(workspace, /connect\(writeCapabilities\)/);
  assert.match(workspace, /Enable reviewed Sheet writes/);
  assert.doesNotMatch(workspace, /Approve exact Google read|Run approved read once/);
});

test('Google-to-Mac transfer remains a separate create-only local review', () => {
  const source = fs.readFileSync('src/renderer/components/NativeGoogleContacts.tsx', 'utf8');
  assert.match(source, /mode: 'create_only'; requiresLocalMacReview: true/);
  assert.match(source, /const change: MacContactChange = \{ operation: 'create'/);
  assert.match(source, /macConnectorService\.prepareContactChange\(change, transferOrigin\(key, candidate, revision\)\)/);
  assert.match(source, /macConnectorService\.restoreReviewedWrite\(transferOrigin\(key, candidate\), 'contact\.create'\)/);
  assert.match(source, /macConnectorService\.reconcileReviewedWrite\(receipt, resolution, \{ agentId, sessionId \}\)/);
  assert.match(source, /receipt\.state === 'unknown'/);
  assert.match(source, /inspectUnknownLocal\(key, candidate\)/);
  assert.match(source, /onClick=\{\(\) => void createLocal\(key\)\}>Create this reviewed local contact once/);
  assert.doesNotMatch(source, /MacContactChange = \{ operation: 'update'/);
  assert.match(source, /Nothing will be merged or overwritten/);

  const assistant = fs.readFileSync('src/renderer/components/PersonalAssistant.tsx', 'utf8');
  assert.match(assistant, /<NativeGoogleContacts key=\{`google-contacts:\$\{agentId\}`\} agentId=\{agentId\} sessionId=\{sessionId\}/);
});

test('Mac-to-Google transfer searches locally, warns on Google matches, and prepares create only', () => {
  const source = fs.readFileSync('src/renderer/components/NativeGoogleContacts.tsx', 'utf8');
  const start = source.indexOf('async function prepareMacToGoogleCreate');
  const end = source.indexOf('\n  const readReady', start);
  assert.ok(start > 0 && end > start);
  const flow = source.slice(start, end);
  assert.match(source, /macConnectorService\.searchContacts\(query\)[\s\S]*\.slice\(0, 100\)/);
  assert.match(flow, /tool: 'contacts\.google\.search'/);
  assert.match(flow, /tool: 'contacts\.google\.create'/);
  assert.doesNotMatch(flow, /contacts\.google\.update|operation: 'update'|merge|delete/);
  assert.match(source, /Possible existing Google matches:/);
  assert.match(source, /Nothing will be merged or overwritten/);
  assert.match(source, /Enable reviewed Google create access/);
});
