import { app, shell } from 'electron';
import { fork, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
let worker: ChildProcess | undefined;
let nextId = 0;
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
function sourceDirectory(): string {
  const candidates = [process.env.CROKODIAL_COMPASS_SOURCE, path.join(process.resourcesPath, 'quotes-compass'), path.join(app.getAppPath(), 'resources/quotes-compass'), '/Volumes/Lacie/Repos/quotes compass'];
  const source = candidates.find(candidate => candidate && fs.existsSync(path.join(candidate, 'src/assistant/orchestrator.js')));
  if (!source) throw new Error('Quotes Compass is unavailable. Connect the source drive or set CROKODIAL_COMPASS_SOURCE to your existing Quotes Compass directory.');
  return source;
}
function ensureWorker(): ChildProcess {
  if (worker?.connected) return worker;
  worker = fork(path.join(app.getAppPath(), 'scripts/compass-worker.mjs'), [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', CROKODIAL_COMPASS_SOURCE: sourceDirectory() },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const child = worker;
  worker.on('message', (message: { id: number; data?: unknown; error?: string }) => {
    const request = pending.get(message.id);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error)); else request.resolve(message.data);
  });
  const fail = () => {
    if (worker !== child) return;
    worker = undefined;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('The insurance engine stopped. Retry to reconnect.')); }
    pending.clear();
  };
  worker.once('error', fail); worker.once('exit', fail);
  return worker;
}
export function compassRequest(operation: unknown, payload: unknown): Promise<unknown> {
  if (operation !== 'plans' && operation !== 'chat' && operation !== 'brochure') return Promise.reject(new Error('Unknown insurance operation.'));
  const child = ensureWorker();
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Insurance research timed out. Try a more specific question.')); stopCompass(); }, operation === 'chat' ? 180000 : 30000);
    pending.set(id, { resolve, reject, timer });
    child.send({ id, operation, payload }, error => { if (error) { clearTimeout(timer); pending.delete(id); reject(new Error('Unable to reach the insurance engine.')); } });
  });
}
export function stopCompass(): void {
  const child = worker; worker = undefined;
  for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('The insurance session was closed.')); }
  pending.clear(); child?.kill();
}
export async function openCompassBrochure(planId: unknown): Promise<void> {
  if (typeof planId !== 'string' || !/^[a-z0-9-]+$/.test(planId)) throw new Error('Invalid plan identifier.');
  const target = await compassRequest('brochure', { planId }) as { path?: string; pdfUrl?: string; error?: string; message?: string; openKind?: string };
  if (target.path && (target.openKind === 'local_pdf' || target.openKind === 'local_text')) {
    const filename = fs.realpathSync(target.path);
    const source = fs.realpathSync(sourceDirectory());
    if (!filename.startsWith(source + path.sep) || !/\.(pdf|txt)$/i.test(filename)) throw new Error('Unsupported brochure location.');
    const error = await shell.openPath(filename);
    if (error) throw new Error('The brochure could not be opened.');
  } else if (target.pdfUrl && target.openKind === 'remote_pdf') {
    const url = new URL(target.pdfUrl);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Unsupported brochure URL.');
    await shell.openExternal(url.href);
  } else throw new Error(target.message || 'A brochure is not available for this product.');
}
