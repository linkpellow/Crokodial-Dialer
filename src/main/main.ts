import { app, BrowserWindow, ipcMain, screen } from 'electron';
import path from 'path';
import fs from 'fs';

const CONFIG_PATH = path.join(app.getPath('userData'), 'dialer-window.json');

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
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.setAspectRatio(IPHONE_ASPECT_RATIO);

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
  });
  mainWindow.on('move', scheduleSaveBounds);
  mainWindow.on('resize', scheduleSaveBounds);

  if (!app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173');
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

interface ApiFetchPayload {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

ipcMain.handle('api-fetch', async (_event, payload: ApiFetchPayload) => {
  const { url, method = 'GET', headers = {}, body } = payload;
  if (!url || typeof url !== 'string') {
    return { ok: false, status: 0, statusText: 'Invalid URL', headers: {}, body: '' };
  }
  try {
    const res = await fetch(url, {
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

app.whenReady().then(createWindow);

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
