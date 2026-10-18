import { app, BrowserWindow, ipcMain, safeStorage, screen, shell, type IpcMainInvokeEvent } from 'electron';
import { compassRequest, openCompassBrochure, stopCompass } from './compass';
import path from 'path';
import fs from 'fs';
import { allowWorkspaceMicrophone, createRecordingBridge } from './recordingBridge';
import { createAssistantFiles } from './assistantFiles';
import { MacConnectorAuthorityError, createDefaultMacConnectorDependencies, createFileMacConnectorWriteStorage, createMacConnectors,
  type MacNativeWriteClaim, type MacNativeWriteServerReceipt, type MacWriteAuthority, type MacWriteAuthorityRequest } from './macConnectors';
import { createAuthorizedMacConnectorMonitor, createFileMacMonitorStorage } from './macConnectorMonitor';

// Never reuse or modify the installed Dialer's profile.
app.setName('Crokodial Workspace');
app.setPath('userData', process.env.CROKODIAL_USER_DATA_DIR ? path.resolve(process.env.CROKODIAL_USER_DATA_DIR) : path.join(app.getPath('appData'), 'Crokodial Workspace'));
// The durable Mac-write ledger is process-local while the app is running. A
// second main process could otherwise load the same pending receipt and claim
// it independently, so acquire the OS-wide application lock before creating
// connectors, registering write IPC, or opening a window.
const primaryInstance = app.requestSingleInstanceLock();

const PLATFORM_ORIGIN: string = JSON.parse(fs.readFileSync(path.join(__dirname, 'platform-config.json'), 'utf8')).origin;

const CONFIG_PATH = path.join(app.getPath('userData'), 'dialer-window.json');
const MAC_MONITOR_CONFIG_PATH = path.join(app.getPath('userData'), 'mac-read-monitor.json');
const MAC_WRITE_RECEIPTS_PATH = path.join(app.getPath('userData'), 'mac-write-receipts.secure');

interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

function loadWindowBounds(): WindowBounds | null {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as WindowBounds;
    if (typeof parsed.x === 'number' && typeof parsed.y === 'number' && typeof parsed.width === 'number' && typeof parsed.height === 'number') {
      return parsed;
    }
  } catch {
    // ignore
  }
  return null;
}

function saveWindowBoundsToDisk(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(mainWindow.getBounds()), 'utf-8');
  } catch {
    // ignore
  }
}

let mainWindow: BrowserWindow | null = null;
let saveBoundsTimer: ReturnType<typeof setTimeout> | null = null;
let resizeAnimationTimer: ReturnType<typeof setInterval> | null = null;

function clampToScreen(bounds: { x: number; y: number; width: number; height: number }) {
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: sw, height: sh } = primaryDisplay.workAreaSize;
  const { x: sx, y: sy } = primaryDisplay.workArea;
  return {
    x: Math.max(sx, Math.min(sx + sw - bounds.width, bounds.x)),
    y: Math.max(sy, Math.min(sy + sh - bounds.height, bounds.y)),
    width: Math.min(bounds.width, sw),
    height: Math.min(bounds.height, sh),
  };
}

function scheduleSaveBounds(): void {
  if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(() => {
    saveWindowBoundsToDisk();
    saveBoundsTimer = null;
  }, 300);
}

function stopResizeAnimation(): void {
  if (resizeAnimationTimer) {
    clearInterval(resizeAnimationTimer);
    resizeAnimationTimer = null;
  }
}

// Compact iPhone portrait aspect ratio (320×693)
const IPHONE_ASPECT_RATIO = 320 / 693;
const DEFAULT_WIDTH = 320;
const DEFAULT_HEIGHT = 693;
const MIN_WIDTH = 224;   // ~0.7× base
const MIN_HEIGHT = 485;  // ~0.7× base
const MAX_WIDTH = 960;   // 3× base
const MAX_HEIGHT = 2079; // 3× base

function animateWindowBounds(
  target: { width: number; height: number },
  durationMs = 200,
  onComplete?: () => void
): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  stopResizeAnimation();

  const start = mainWindow.getBounds();
  const startTime = Date.now();
  const endWidth = target.width;
  const endHeight = target.height;

  resizeAnimationTimer = setInterval(() => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      stopResizeAnimation();
      return;
    }

    const elapsed = Date.now() - startTime;
    const t = Math.min(1, elapsed / durationMs);
    const eased = 1 - Math.pow(1 - t, 3);

    const nextWidth = Math.round(start.width + (endWidth - start.width) * eased);
    const nextHeight = Math.round(start.height + (endHeight - start.height) * eased);

    mainWindow.setBounds(
      {
        x: start.x,
        y: start.y,
        width: nextWidth,
        height: nextHeight,
      },
      false
    );

    if (t >= 1) {
      stopResizeAnimation();
      onComplete?.();
    }
  }, 16);
}

function enforceAspectRatio(bounds: { width: number; height: number }) {
  let { width, height } = bounds;
  const currentRatio = width / height;
  if (currentRatio > IPHONE_ASPECT_RATIO) {
    height = Math.round(width / IPHONE_ASPECT_RATIO);
  } else {
    width = Math.round(height * IPHONE_ASPECT_RATIO);
  }
  if (width < MIN_WIDTH) {
    width = MIN_WIDTH;
    height = Math.round(width / IPHONE_ASPECT_RATIO);
  }
  if (height < MIN_HEIGHT) {
    height = MIN_HEIGHT;
    width = Math.round(height * IPHONE_ASPECT_RATIO);
  }
  if (width > MAX_WIDTH) {
    width = MAX_WIDTH;
    height = Math.round(width / IPHONE_ASPECT_RATIO);
  }
  if (height > MAX_HEIGHT) {
    height = MAX_HEIGHT;
    width = Math.round(height * IPHONE_ASPECT_RATIO);
  }
  return { width, height };
}

function createWindow(): void {
  const saved = loadWindowBounds();
  const defaults = { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, x: 100, y: 100 };
  const raw = saved ? clampToScreen({ ...defaults, ...saved }) : defaults;
  const { width, height } = enforceAspectRatio({ width: raw.width, height: raw.height });
  const bounds = { ...raw, width, height };

  mainWindow = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    maxWidth: MAX_WIDTH,
    maxHeight: MAX_HEIGHT,
    show: false,
    frame: process.platform === 'darwin',
    transparent: process.platform !== 'darwin',
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hidden' as const,
      trafficLightPosition: { x: 12, y: 10 },
      backgroundColor: '#142719',
    } : {}),
    alwaysOnTop: true,
    webPreferences: {
      additionalArguments: process.argv.includes('--workspace=assistant') ? ['--workspace=assistant'] : [],
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', event => event.preventDefault());
  const workspaceContents = mainWindow.webContents;
  workspaceContents.session.setPermissionCheckHandler((contents, permission, _origin, details) =>
    allowWorkspaceMicrophone(contents === mainWindow?.webContents, workspaceContents.getURL(), permission, details));
  workspaceContents.session.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(allowWorkspaceMicrophone(contents === mainWindow?.webContents, workspaceContents.getURL(), permission, details)));
  mainWindow.setAspectRatio(IPHONE_ASPECT_RATIO);

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
  });
  mainWindow.on('move', scheduleSaveBounds);
  mainWindow.on('resize', scheduleSaveBounds);

  if (!app.isPackaged && process.env.CROKODIAL_RENDERER_URL) {
    const rendererUrl = new URL(process.env.CROKODIAL_RENDERER_URL);
    if (!['localhost', '127.0.0.1'].includes(rendererUrl.hostname)) throw new Error('Development renderer must run on localhost.');
    mainWindow.loadURL(rendererUrl.href);
  } else {
    mainWindow.loadFile(
      path.join(__dirname, '../../dist-renderer/index.html')
    );
  }

  mainWindow.on('closed', () => {
    const win = mainWindow;
    if (saveBoundsTimer) {
      clearTimeout(saveBoundsTimer);
      saveBoundsTimer = null;
    }
    win?.removeAllListeners?.('move');
    win?.removeAllListeners?.('resize');
    mainWindow = null;
  });
}

function focusWorkspaceWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (app.isReady()) createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

interface ApiFetchPayload {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('Untrusted request.');
}

async function verifyMacWriteAuthority(request: { bearerToken: string; agentId: number; sessionId: string }): Promise<MacWriteAuthority> {
  const target = new URL(`/api/ai-agents/${request.agentId}/conversation/session/${encodeURIComponent(request.sessionId)}/authority`, PLATFORM_ORIGIN);
  if (target.origin !== PLATFORM_ORIGIN) throw new MacConnectorAuthorityError('Local-write authority endpoint is invalid.');
  let response: Response;
  try {
    response = await fetch(target, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: {
      Accept: 'application/json', Authorization: `Bearer ${request.bearerToken}`,
      'x-crokodial-contract-version': '2026-02-26.1', 'x-crokodial-desktop-client': 'crokodial-sms-desktop',
    } });
  } catch { throw new MacConnectorAuthorityError('Crokodial could not revalidate this local write. Try again while connected.'); }
  if (!response.ok) {
    const definitive = [400, 401, 403, 404, 409].includes(response.status);
    throw new MacConnectorAuthorityError(definitive
      ? 'The signed-in server authorization or active assistant conversation changed.'
      : 'Crokodial could not revalidate this local write. Try again while connected.', definitive);
  }
  const length = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(length) && length > 16_384) throw new MacConnectorAuthorityError('Crokodial returned invalid local-write authority.');
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 16_384) {
          await reader.cancel().catch(() => undefined);
          throw new MacConnectorAuthorityError('Crokodial returned invalid local-write authority.');
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  const text = Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8');
  let body: unknown;
  try { body = JSON.parse(text); } catch { throw new MacConnectorAuthorityError('Crokodial returned invalid local-write authority.'); }
  const envelope = body as { data?: unknown };
  return (envelope?.data ?? body) as MacWriteAuthority;
}

type NativeWriteAuthorityRequest = { bearerToken: string; agentId: number; sessionId: string };

function requireMacAuthorityRequest(value: unknown): MacWriteAuthorityRequest {
  if (!value || typeof value !== 'object') throw new MacConnectorAuthorityError('Current server authorization is required.', true);
  const row = value as Record<string, unknown>;
  if (typeof row.bearerToken !== 'string' || !row.bearerToken || row.bearerToken.length > 8_192 || /\s/.test(row.bearerToken)
    || !Number.isSafeInteger(row.agentId) || Number(row.agentId) <= 0 || typeof row.sessionId !== 'string'
    || !row.sessionId || row.sessionId.length > 256 || /[\u0000-\u001f\u007f]/.test(row.sessionId)) {
    throw new MacConnectorAuthorityError('Current server authorization is invalid.', true);
  }
  return { bearerToken: row.bearerToken, agentId: Number(row.agentId), sessionId: row.sessionId };
}

async function nativeWriteServerRequest(request: NativeWriteAuthorityRequest, pathSuffix: string, body: unknown): Promise<MacNativeWriteServerReceipt> {
  const target = new URL(`/api/ai-agents/${request.agentId}/conversation/session/${encodeURIComponent(request.sessionId)}/native-writes/${pathSuffix}`, PLATFORM_ORIGIN);
  if (target.origin !== PLATFORM_ORIGIN) throw new MacConnectorAuthorityError('Native-write receipt endpoint is invalid.');
  let response: Response;
  try {
    response = await fetch(target, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: {
      Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${request.bearerToken}`,
      'x-crokodial-contract-version': '2026-02-26.1', 'x-crokodial-desktop-client': 'crokodial-sms-desktop',
    }, body: JSON.stringify(body) });
  } catch { throw new MacConnectorAuthorityError('Crokodial could not preserve this native-write receipt. Inspect it before any retry.'); }
  if (!response.ok) {
    const definitive = [400, 401, 403, 404, 409].includes(response.status);
    throw new MacConnectorAuthorityError(definitive
      ? 'The signed-in server authorization, conversation, or native-write receipt changed.'
      : 'Crokodial could not preserve this native-write receipt. Inspect it before any retry.', definitive);
  }
  const length = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(length) && length > 16_384) throw new MacConnectorAuthorityError('Crokodial returned an invalid native-write receipt.');
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  if (reader) {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 16_384) {
          await reader.cancel().catch(() => undefined);
          throw new MacConnectorAuthorityError('Crokodial returned an invalid native-write receipt.');
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
  }
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')); }
  catch { throw new MacConnectorAuthorityError('Crokodial returned an invalid native-write receipt.'); }
  const envelope = parsed as { data?: unknown };
  return (envelope?.data ?? parsed) as MacNativeWriteServerReceipt;
}

const macWriteServerAuthority = {
  verify: verifyMacWriteAuthority,
  claim: (request: NativeWriteAuthorityRequest, claim: MacNativeWriteClaim) => nativeWriteServerRequest(request, 'claims', claim),
  assert: (request: NativeWriteAuthorityRequest, reviewId: string, claimToken: string) =>
    nativeWriteServerRequest(request, `claims/${encodeURIComponent(reviewId)}/assert`, { claimToken }),
  finalize: (request: NativeWriteAuthorityRequest, reviewId: string, claimToken: string,
    state: 'succeeded' | 'failed' | 'unknown', message: string) =>
    nativeWriteServerRequest(request, `claims/${encodeURIComponent(reviewId)}/finalize`, { claimToken, state, message }),
  reconcile: (request: NativeWriteAuthorityRequest, claim: MacNativeWriteClaim, resolution: 'applied' | 'not_applied') =>
    nativeWriteServerRequest(request, `claims/${encodeURIComponent(claim.reviewId)}/reconcile`, { ...claim, resolution }),
};

function startPrimaryInstance(): void {
const recordingBridge = createRecordingBridge(PLATFORM_ORIGIN);
const assistantFiles = createAssistantFiles(PLATFORM_ORIGIN);
const macConnectors = createMacConnectors(
  createDefaultMacConnectorDependencies({ openExternal: url => shell.openExternal(url), authority: macWriteServerAuthority }),
  createFileMacConnectorWriteStorage(MAC_WRITE_RECEIPTS_PATH, {
    encode(plaintext) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure local receipt storage is unavailable. No external write was started.');
      return JSON.stringify({ version: 1, ciphertext: safeStorage.encryptString(plaintext).toString('base64') });
    },
    decode(stored) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure local receipt storage is unavailable. External writes remain disabled.');
      const envelope = JSON.parse(stored) as { version?: unknown; ciphertext?: unknown };
      if (envelope.version !== 1 || typeof envelope.ciphertext !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(envelope.ciphertext)) throw new Error('Saved Mac write receipts are invalid.');
      return safeStorage.decryptString(Buffer.from(envelope.ciphertext, 'base64'));
    },
  }),
);
const macMonitor = createAuthorizedMacConnectorMonitor({
  readers: {
    listMessageThreads: query => macConnectors.listMessageThreads(query),
    readWhatsAppConversation: jid => macConnectors.readWhatsAppConversation(jid),
  },
  storage: createFileMacMonitorStorage(MAC_MONITOR_CONFIG_PATH, {
    encode(plaintext) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure local monitor storage is unavailable. Monitoring was not started.');
      return JSON.stringify({ version: 1, ciphertext: safeStorage.encryptString(plaintext).toString('base64') });
    },
    decode(stored) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure local monitor storage is unavailable. Saved monitoring remains stopped.');
      const envelope = JSON.parse(stored) as { version?: unknown; ciphertext?: unknown };
      if (envelope.version !== 1 || typeof envelope.ciphertext !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(envelope.ciphertext)) throw new Error('Saved local monitor settings are invalid.');
      return safeStorage.decryptString(Buffer.from(envelope.ciphertext, 'base64'));
    },
  }),
  verify: verifyMacWriteAuthority,
});
macMonitor.subscribe(() => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('mac-monitor-state-changed');
});
ipcMain.handle('assistant-screenshot-upload', (event, payload: unknown) => {
  assertTrustedSender(event);
  return assistantFiles.upload(payload);
});
ipcMain.handle('assistant-screenshot-read', (event, payload: unknown) => {
  assertTrustedSender(event);
  return assistantFiles.read(payload);
});
ipcMain.handle('recording-upload-segment', (event, payload: unknown) => {
  assertTrustedSender(event);
  return recordingBridge.upload(payload);
});
ipcMain.handle('recording-download-audio', (event, payload: unknown) => {
  assertTrustedSender(event);
  return recordingBridge.download(payload);
});
ipcMain.handle('mac-connectors-status', event => { assertTrustedSender(event); return macConnectors.status(); });
ipcMain.handle('mac-connectors-request-access', (event, connector: unknown) => { assertTrustedSender(event); return macConnectors.requestAccess(connector); });
ipcMain.handle('mac-contacts-search', (event, query: unknown) => { assertTrustedSender(event); return macConnectors.searchContacts(query); });
ipcMain.handle('mac-contacts-dedupe-preview', event => { assertTrustedSender(event); return macConnectors.previewContactDuplicates(); });
ipcMain.handle('mac-contacts-prepare-change', (event, payload: unknown) => { assertTrustedSender(event); return macConnectors.prepareContactMutation(payload); });
ipcMain.handle('mac-contacts-execute-change', (event, binding: unknown) => { assertTrustedSender(event); return macConnectors.executeContactMutation(binding); });
ipcMain.handle('mac-messages-list-threads', (event, query: unknown) => { assertTrustedSender(event); return macConnectors.listMessageThreads(query); });
ipcMain.handle('mac-messages-read-thread', (event, threadId: unknown) => { assertTrustedSender(event); return macConnectors.readMessageThread(threadId); });
ipcMain.handle('mac-messages-prepare-send', (event, payload: unknown) => { assertTrustedSender(event); return macConnectors.prepareMessageSend(payload); });
ipcMain.handle('mac-messages-execute-send', (event, binding: unknown) => { assertTrustedSender(event); return macConnectors.executeMessageSend(binding); });
ipcMain.handle('mac-reviewed-write-restore', (event, payload: unknown) => { assertTrustedSender(event); return macConnectors.restoreReviewedWrite(payload); });
ipcMain.handle('mac-reviewed-write-list', (event, payload: unknown) => { assertTrustedSender(event); return macConnectors.listReviewedWrites(payload); });
ipcMain.handle('mac-reviewed-write-reconcile', (event, payload: unknown) => { assertTrustedSender(event); return macConnectors.reconcileReviewedWrite(payload); });
ipcMain.handle('mac-whatsapp-search', (event, query: unknown) => { assertTrustedSender(event); return macConnectors.searchWhatsApp(query); });
ipcMain.handle('mac-sms-prepare-draft', (event, payload: unknown) => { assertTrustedSender(event); return macConnectors.prepareSmsDraft(payload); });
ipcMain.handle('mac-sms-open-draft', (event, binding: unknown) => { assertTrustedSender(event); return macConnectors.openSmsDraft(binding); });
ipcMain.handle('mac-monitor-state', (event, payload: unknown) => { assertTrustedSender(event); const row = payload as Record<string, unknown>; return macMonitor.state(requireMacAuthorityRequest(row?.authority)); });
ipcMain.handle('mac-monitor-resume', (event, payload: unknown) => { assertTrustedSender(event); const row = payload as Record<string, unknown>; return macMonitor.resume(requireMacAuthorityRequest(row?.authority)); });
ipcMain.handle('mac-monitor-start', (event, payload: unknown) => { assertTrustedSender(event); const row = payload as Record<string, unknown>; return macMonitor.start(row?.configuration, requireMacAuthorityRequest(row?.authority)); });
ipcMain.handle('mac-monitor-stop', (event, payload: unknown) => { assertTrustedSender(event); const row = payload as Record<string, unknown>; return macMonitor.stop(requireMacAuthorityRequest(row?.authority), row?.clearSaved !== false); });
ipcMain.handle('mac-monitor-refresh', (event, payload: unknown) => { assertTrustedSender(event); const row = payload as Record<string, unknown>; return macMonitor.refresh(requireMacAuthorityRequest(row?.authority)); });

ipcMain.handle('api-fetch', async (event, payload: ApiFetchPayload) => {
  assertTrustedSender(event);
  const { url, method = 'GET', headers = {}, body } = payload;
  if (!url || typeof url !== 'string') {
    return { ok: false, status: 0, statusText: 'Invalid URL', headers: {}, body: '' };
  }
  try {
    const target = new URL(url);
    if (target.origin !== PLATFORM_ORIGIN || !target.pathname.startsWith('/api/') || target.username || target.password) throw new Error('Request is outside the configured Crokodial API.');
    const res = await fetch(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(/\/(?:test|conversation)\/message$/.test(target.pathname) || /\/artifacts\/generate$/.test(target.pathname) ? 120000 : 30000),
      method,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      body: body ?? undefined,
    });
    const resBody = await res.text();
    const resHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      resHeaders[key] = value;
    });
    return {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers: resHeaders,
      body: resBody,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 0,
      statusText: message,
      headers: {},
      body: '',
    };
  }
});

ipcMain.handle('window-minimize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.minimize();
  }
});

ipcMain.handle('window-close', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close();
  }
});

ipcMain.handle('window-maximize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.handle('window-show', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
});
const FULL_WIDTH = DEFAULT_WIDTH;
const FULL_HEIGHT = DEFAULT_HEIGHT;

ipcMain.handle('window-resize', (_event, mode: 'full' | 'compact') => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // Compact mode is temporarily disabled; always keep full-size geometry.
  void mode;
  mainWindow.setMinimumSize(MIN_WIDTH, MIN_HEIGHT);
  mainWindow.setAspectRatio(0);
  animateWindowBounds({ width: FULL_WIDTH, height: FULL_HEIGHT }, 200, () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAspectRatio(IPHONE_ASPECT_RATIO);
    }
  });
});

ipcMain.handle('compass-request', (event, operation: unknown, payload: unknown) => { assertTrustedSender(event); return compassRequest(operation, payload); });
ipcMain.handle('compass-brochure', (event, planId: unknown) => { assertTrustedSender(event); return openCompassBrochure(planId); });
ipcMain.handle('compass-clear', event => { assertTrustedSender(event); stopCompass(); });
ipcMain.handle('open-external', async (event, value: unknown) => {
  assertTrustedSender(event);
  if (typeof value !== 'string') throw new Error('Invalid link.');
  const url = new URL(value);
  if (url.origin !== PLATFORM_ORIGIN) throw new Error('Link is outside your configured Crokodial site.');
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported link.');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Use a secure Crokodial address.');
  await shell.openExternal(url.href);
});
app.on('before-quit', () => { stopCompass(); macMonitor.shutdown(); });
app.whenReady().then(() => { createWindow(); });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
}

if (!primaryInstance) {
  app.quit();
} else {
  app.on('second-instance', focusWorkspaceWindow);
  startPrimaryInstance();
}
