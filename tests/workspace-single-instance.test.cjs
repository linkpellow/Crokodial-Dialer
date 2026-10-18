const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('Workspace acquires its process lock before constructing connectors or any window', () => {
  const source = fs.readFileSync('src/main/main.ts', 'utf8');
  const lock = source.indexOf('app.requestSingleInstanceLock()');
  const connector = source.indexOf('const macConnectors = createMacConnectors(');
  const window = source.indexOf('new BrowserWindow(');
  assert.ok(lock >= 0, 'main process must acquire Electron single-instance lock');
  assert.ok(lock < connector, 'lock acquisition must precede Mac connector construction');
  assert.ok(lock < window, 'lock acquisition must precede window construction');
  assert.match(source, /if \(!primaryInstance\) \{\s*app\.quit\(\);\s*\} else \{\s*app\.on\('second-instance', focusWorkspaceWindow\);\s*startPrimaryInstance\(\);/);
});

test('a second launch restores and focuses the existing Workspace window', () => {
  const source = fs.readFileSync('src/main/main.ts', 'utf8');
  const start = source.indexOf('function focusWorkspaceWindow');
  const end = source.indexOf('\ninterface ApiFetchPayload', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end + 2);
  assert.match(body, /mainWindow\.isMinimized\(\)/);
  assert.match(body, /mainWindow\.restore\(\)/);
  assert.match(body, /mainWindow\.show\(\)/);
  assert.match(body, /mainWindow\.focus\(\)/);
});

test('Mac write authority is revalidated directly by main with a bounded same-origin response', () => {
  const source = fs.readFileSync('src/main/main.ts', 'utf8');
  const start = source.indexOf('async function verifyMacWriteAuthority');
  const end = source.indexOf('\nfunction startPrimaryInstance', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);
  assert.match(body, /\/api\/ai-agents\/\$\{request\.agentId\}\/conversation\/session\/\$\{encodeURIComponent\(request\.sessionId\)\}\/authority/);
  assert.match(body, /target\.origin !== PLATFORM_ORIGIN/);
  assert.match(body, /Authorization: `Bearer \$\{request\.bearerToken\}`/);
  assert.match(body, /AbortSignal\.timeout\(10_000\)/);
  assert.match(body, /bytes > 16_384/);
  assert.match(body, /reader\.cancel\(\)/);
  assert.doesNotMatch(body, /writeFile|localStorage|console\./, 'the transient bearer is neither persisted nor logged');
});

test('native provider writes use direct bounded server claim, assertion, finalization and reconciliation calls', () => {
  const source = fs.readFileSync('src/main/main.ts', 'utf8');
  const start = source.indexOf('async function nativeWriteServerRequest');
  const end = source.indexOf('\nfunction startPrimaryInstance', start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);
  assert.match(body, /\/native-writes\/\$\{pathSuffix\}/);
  assert.match(body, /method: 'POST'/);
  assert.match(body, /Authorization: `Bearer \$\{request\.bearerToken\}`/);
  assert.match(body, /AbortSignal\.timeout\(10_000\)/);
  assert.match(body, /bytes > 16_384/);
  for (const operation of ['claim:', 'assert:', 'finalize:', 'reconcile:']) assert.match(body, new RegExp(operation));
  assert.doesNotMatch(body, /writeFile|localStorage|console\./, 'the transient bearer is neither persisted nor logged');
});

test('persisted Mac monitor and receipt reads require current server authority before returning owner data', () => {
  const source = fs.readFileSync('src/main/main.ts', 'utf8');
  assert.doesNotMatch(source, /app\.whenReady\(\)\.then\(\(\) => \{[^}]*macMonitor\.resume\(/,
    'the monitor must never auto-resume before an owner signs in');
  for (const route of ['mac-reviewed-write-restore', 'mac-reviewed-write-list']) {
    assert.match(source, new RegExp(`ipcMain\\.handle\\('${route}'[\\s\\S]{0,240}macConnectors\\.`));
  }
  for (const route of ['mac-monitor-state', 'mac-monitor-resume', 'mac-monitor-start', 'mac-monitor-stop', 'mac-monitor-refresh']) {
    assert.match(source, new RegExp(`ipcMain\\.handle\\('${route}'[\\s\\S]{0,360}requireMacAuthorityRequest`));
  }
  assert.match(source, /webContents\.send\('mac-monitor-state-changed'\);/,
    'monitor subscriptions send only a data-free change signal');
  assert.doesNotMatch(source, /webContents\.send\('mac-monitor-state-changed',\s*state\)/);
});
