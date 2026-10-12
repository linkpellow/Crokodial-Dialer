/** Bounded binary IPC transport. Endpoints are constructed here, never supplied by the renderer. */
export const CLIP_MAX_BYTES = 4 * 1024 * 1024;
// A full session may include 240 summaries, their combined draft and canonical
// notes. Keep the response bounded without rejecting valid long-call history.
export const JSON_MAX_BYTES = 40 * 1024 * 1024;
const MIME_EXTENSIONS: Record<string, string> = {
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
  'audio/x-wav': 'wav', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3',
};
interface ClipIdentity { contactId: number; sessionId: string; sequence: number; authorization: string }
interface UploadClip extends ClipIdentity { audio: ArrayBuffer; mimeType: string; startOffsetMs: number; endOffsetMs: number }
function identity(value: unknown): ClipIdentity {
  if (!value || typeof value !== 'object') throw new Error('Invalid recording request.');
  const p = value as ClipIdentity;
  if (!Number.isSafeInteger(p.contactId) || p.contactId <= 0 || typeof p.sessionId !== 'string' || !/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(p.sessionId) || !Number.isSafeInteger(p.sequence) || p.sequence < 0 || p.sequence >= 240) throw new Error('Invalid recording identity.');
  if (typeof p.authorization !== 'string' || !/^Bearer [A-Za-z0-9._~+\/-]+=*$/.test(p.authorization) || p.authorization.length > 8192) throw new Error('Sign in to access recordings.');
  return p;
}
function audioType(value: unknown): string {
  if (typeof value !== 'string' || value.length > 100) throw new Error('Unsupported recording format.');
  const mime = value.toLowerCase().split(';')[0].trim();
  if (!Object.prototype.hasOwnProperty.call(MIME_EXTENSIONS, mime)) throw new Error('Unsupported recording format.');
  return mime;
}
async function boundedBody(response: Response, max: number): Promise<Uint8Array> {
  const length = Number(response.headers.get('content-length'));
  if (length > max) { await response.body?.cancel(); throw new Error('Recording response exceeded the size limit.'); }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) { await reader.cancel(); throw new Error('Recording response exceeded the size limit.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
export function createRecordingBridge(origin: string, fetcher: typeof fetch = fetch) {
  const platform = new URL(origin);
  if (platform.origin !== origin || (platform.protocol !== 'https:' && !(platform.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(platform.hostname)))) throw new Error('Invalid recording API origin.');
  let inFlight = 0;
  const target = (p: ClipIdentity) => `${origin}/api/dialer/contacts/${p.contactId}/recording-sessions/${p.sessionId}/segments/${p.sequence}`;
  async function limited<T>(run: () => Promise<T>): Promise<T> {
    if (inFlight >= 3) throw new Error('Recording transfer is busy. Try again shortly.');
    inFlight++;
    try { return await run(); } finally { inFlight--; }
  }
  return {
    async upload(value: unknown) {
      try {
        const p = identity(value) as UploadClip;
        const mime = audioType(p.mimeType);
        if (!(p.audio instanceof ArrayBuffer) || !p.audio.byteLength || p.audio.byteLength > CLIP_MAX_BYTES) throw new Error('Recording clip must be between 1 byte and 4 MiB.');
        if (!Number.isSafeInteger(p.startOffsetMs) || !Number.isSafeInteger(p.endOffsetMs) || p.startOffsetMs < 0 || p.endOffsetMs <= p.startOffsetMs || p.endOffsetMs > 7200000 || p.endOffsetMs - p.startOffsetMs > 60000) throw new Error('Invalid recording clip duration.');
        return await limited(async () => {
          const form = new FormData();
          form.set('audio', new Blob([p.audio], { type: mime }), `segment-${p.sequence}.${MIME_EXTENSIONS[mime]}`);
          form.set('startOffsetMs', String(p.startOffsetMs));
          form.set('endOffsetMs', String(p.endOffsetMs));
          const response = await fetcher(target(p), { method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(120000), headers: { Authorization: p.authorization, 'x-crokodial-contract-version': '2026-02-26.1', 'x-crokodial-desktop-client': 'crokodial-sms-desktop' }, body: form });
          const body = new TextDecoder().decode(await boundedBody(response, JSON_MAX_BYTES));
          return { ok: response.ok, status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers.entries()), body };
        });
      } catch (error) {
        return { ok: false, status: 0, statusText: error instanceof Error ? error.message : 'Recording upload failed.', headers: {}, body: '' };
      }
    },
    async download(value: unknown) {
      try {
        const p = identity(value);
        return await limited(async () => {
          const response = await fetcher(`${target(p)}/audio`, { redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Authorization: p.authorization, 'x-crokodial-contract-version': '2026-02-26.1', 'x-crokodial-desktop-client': 'crokodial-sms-desktop' } });
          if (response.ok) {
            try { audioType(response.headers.get('content-type')); } catch (error) { await response.body?.cancel(); throw error; }
          }
          const bytes = await boundedBody(response, response.ok ? CLIP_MAX_BYTES : JSON_MAX_BYTES);
          return { ok: response.ok, status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers.entries()), body: bytes.buffer as ArrayBuffer, ...(response.ok ? {} : { errorBody: new TextDecoder().decode(bytes) }) };
        });
      } catch (error) {
        return { ok: false, status: 0, statusText: error instanceof Error ? error.message : 'Recording playback failed.', headers: {}, body: new ArrayBuffer(0), errorBody: '' };
      }
    },
  };
}

export function allowWorkspaceMicrophone(trustedWindow: boolean, expectedUrl: string, permission: string, details: { isMainFrame: boolean; requestingUrl?: string; mediaType?: string; mediaTypes?: string[] }): boolean {
  if (!trustedWindow || permission !== 'media' || !details.isMainFrame || !expectedUrl || details.requestingUrl !== expectedUrl) return false;
  return details.mediaTypes ? details.mediaTypes.length === 1 && details.mediaTypes[0] === 'audio' : details.mediaType === 'audio';
}
