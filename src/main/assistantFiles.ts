/** Screenshot-only binary IPC; the renderer cannot select a URL or a filesystem path. */
export const SCREENSHOT_MAX_BYTES = 6 * 1024 * 1024;
const IMAGE_RESPONSE_MAX_BYTES = 32 * 1024 * 1024, JSON_MAX_BYTES = 2 * 1024 * 1024;
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
interface Identity { agentId: number; token: string }
function identity(value: unknown): Identity {
  if (!value || typeof value !== 'object') throw new Error('Invalid screenshot request.');
  const p = value as Identity;
  if (!Number.isSafeInteger(p.agentId) || p.agentId < 1) throw new Error('Invalid assistant.');
  if (typeof p.token !== 'string' || !/^[A-Za-z0-9._~+\/-]+=*$/.test(p.token) || p.token.length > 8192) throw new Error('Sign in to use screenshots.');
  return p;
}
async function boundedBody(response: Response, max: number): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > max) { await response.body?.cancel(); throw new Error('Screenshot response exceeded the size limit.'); }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let length = 0;
  try {
    while (true) { const next = await reader.read(); if (next.done) break; length += next.value.byteLength; if (length > max) { await reader.cancel(); throw new Error('Screenshot response exceeded the size limit.'); } chunks.push(next.value); }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, length);
}
function imageType(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  throw new Error('Choose a PNG, JPEG or WebP screenshot.');
}
export function createAssistantFiles(origin: string, fetcher: typeof fetch = fetch) {
  const url = new URL(origin);
  if (url.origin !== origin || url.username || url.password || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Invalid platform origin.');
  const target = (p: Identity) => `${origin}/api/ai-agents/${p.agentId}/screenshot-records`;
  const headers = (p: Identity) => ({ Authorization: `Bearer ${p.token}`, 'x-crokodial-contract-version': '2026-02-26.1', 'x-crokodial-desktop-client': 'crokodial-sms-desktop' });
  let transfers = 0;
  async function limited<T>(run: () => Promise<T>) { if (transfers >= 2) throw new Error('Screenshot transfer is busy. Try again shortly.'); transfers++; try { return await run(); } finally { transfers--; } }
  return {
    async upload(value: unknown) {
      try {
        const p = identity(value) as Identity & { requestId: string; filename: string; base64: string };
        if (typeof p.requestId !== 'string' || !uuid.test(p.requestId)) throw new Error('Invalid screenshot request identity.');
        if (typeof p.filename !== 'string' || !p.filename || p.filename.length > 200 || /[\x00-\x1f/\\]/.test(p.filename)) throw new Error('Invalid screenshot filename.');
        if (typeof p.base64 !== 'string' || !p.base64 || p.base64.length > Math.ceil(SCREENSHOT_MAX_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(p.base64)) throw new Error('Choose one screenshot up to 6 MiB.');
        const bytes = Buffer.from(p.base64, 'base64');
        if (!bytes.length || bytes.length > SCREENSHOT_MAX_BYTES || bytes.toString('base64') !== p.base64) throw new Error('Invalid screenshot bytes.');
        const mime = imageType(bytes);
        return await limited(async () => {
          const form = new FormData(); form.set('requestId', p.requestId); form.set('screenshot', new Blob([new Uint8Array(bytes)], { type: mime }), p.filename);
          const response = await fetcher(target(p), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(120000), headers: headers(p), body: form });
          return { ok: response.ok, status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers.entries()), body: (await boundedBody(response, JSON_MAX_BYTES)).toString('utf8') };
        });
      } catch (error) { return { ok: false, status: 0, statusText: error instanceof Error ? error.message : 'Screenshot upload failed.', headers: {}, body: '' }; }
    },
    async read(value: unknown) {
      try {
        const p = identity(value) as Identity & { recordId: string };
        if (typeof p.recordId !== 'string' || !uuid.test(p.recordId)) throw new Error('Invalid screenshot record.');
        return await limited(async () => {
          const response = await fetcher(`${target(p)}/${p.recordId}/image`, { redirect: 'error', signal: AbortSignal.timeout(30000), headers: headers(p) });
          if (response.ok && response.headers.get('content-type')?.split(';')[0] !== 'image/png') { await response.body?.cancel(); throw new Error('Invalid screenshot image response.'); }
          const bytes = await boundedBody(response, response.ok ? IMAGE_RESPONSE_MAX_BYTES : JSON_MAX_BYTES);
          if (response.ok && imageType(bytes) !== 'image/png') throw new Error('Invalid screenshot image response.');
          return { ok: response.ok, status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers.entries()), base64: response.ok ? bytes.toString('base64') : '', contentType: 'image/png', ...(response.ok ? {} : { errorBody: bytes.toString('utf8') }) };
        });
      } catch (error) { return { ok: false, status: 0, statusText: error instanceof Error ? error.message : 'Screenshot could not be loaded.', headers: {}, base64: '', contentType: 'image/png', errorBody: '' }; }
    },
  };
}
