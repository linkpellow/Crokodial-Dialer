import { authenticatedFetch, getAuthHeaders, logout, REQUIRES_TENANT_EVENT, type Contact } from './dialerApiService';
import { ContactNotesConflictError } from './contactNotesDrafts';
import type { ContactNotesSnapshot, ConversationRecordingCapabilities, RecordingSession, ConversationRecordingSessionSummary } from '../../shared/conversationRecording';

const base = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');
export class NotesApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
function contactPath(contactId: number): string {
  if (!Number.isSafeInteger(contactId) || contactId <= 0) throw new Error('Select a valid contact.');
  return `/api/dialer/contacts/${contactId}`;
}
function sessionPath(contactId: number, sessionId: string): string {
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(sessionId)) throw new Error('Invalid recording session.');
  return `${contactPath(contactId)}/recording-sessions/${sessionId}`;
}
async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(`${base}${path}`, options);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const latest = body?.error?.details;
    if (response.status === 409 && latest && latest.contactId === Number(path.match(/contacts\/(\d+)/)?.[1]) && typeof latest.notes === 'string' && Number.isSafeInteger(latest.contactId) && Number.isSafeInteger(latest.notesRevision)) throw new ContactNotesConflictError(latest);
    throw new NotesApiError(body?.error?.message ?? body?.message ?? `Request failed (${response.status}).`, response.status);
  }
  return body?.data ?? body;
}
async function nativeResult<T>(response: SerializedFetchResponse): Promise<T> {
  if (!response.status) throw new Error(response.statusText || 'Connection interrupted. Retry the recording upload.');
  let body: any;
  try { body = JSON.parse(response.body); } catch { body = null; }
  if (response.status === 401) logout();
  if (response.status === 403 && body?.error?.code === 'REQUIRES_TENANT') {
    logout(); window.dispatchEvent(new CustomEvent(REQUIRES_TENANT_EVENT, { detail: { message: body.error.message } }));
  }
  if (!response.ok) throw new NotesApiError(body?.error?.message ?? `Recording request failed (${response.status}).`, response.status);
  return body?.data ?? body;
}
export interface UploadClip { sequence: number; blob: Blob; startOffsetMs: number; endOffsetMs: number }
export const notesApi = {
  async contact(contactId: number): Promise<Contact & ContactNotesSnapshot> {
    contactPath(contactId);
    const contact = await request<Contact & { notes_revision?: number }>(`/api/dialer/leads/${contactId}`);
    if (contact.id !== contactId || !Number.isSafeInteger(contact.notes_revision) || Number(contact.notes_revision) < 0) throw new Error('Unable to verify the contact notes revision.');
    return { ...contact, contactId, notes: contact.call_notes ?? '', notesRevision: Number(contact.notes_revision) };
  },
  save: (contactId: number, notes: string, notesRevision: number) => request<ContactNotesSnapshot>(`${contactPath(contactId)}/notes`, { method: 'PATCH', body: JSON.stringify({ notes, notesRevision }) }),
  capabilities: () => request<ConversationRecordingCapabilities>('/api/dialer/recordings/capabilities'),
  list: async (contactId: number) => (await request<{ sessions: ConversationRecordingSessionSummary[] }>(`${contactPath(contactId)}/recording-sessions`)).sessions,
  get: (contactId: number, sessionId: string) => request<RecordingSession>(sessionPath(contactId, sessionId)),
  create: (contactId: number, sessionId: string, callId: string, startedAt: string, retainAudio: boolean) => request<RecordingSession>(`${contactPath(contactId)}/recording-sessions`, { method: 'POST', body: JSON.stringify({ sessionId, source: 'dialer', callId, startedAt, retainAudio }) }),
  async upload(contactId: number, sessionId: string, clip: UploadClip): Promise<RecordingSession> {
    sessionPath(contactId, sessionId);
    if (!window.dialer?.uploadRecordingSegment) throw new Error('Recording upload is unavailable. Rebuild Crokodial Workspace.');
    const response = await window.dialer.uploadRecordingSegment({ contactId, sessionId, sequence: clip.sequence, audio: await clip.blob.arrayBuffer(), mimeType: clip.blob.type, startOffsetMs: clip.startOffsetMs, endOffsetMs: clip.endOffsetMs, authorization: getAuthHeaders().Authorization ?? '' });
    return nativeResult<RecordingSession>(response);
  },
  finalize: (contactId: number, sessionId: string, expectedSegments: number, endedAt: string) => request<RecordingSession>(`${sessionPath(contactId, sessionId)}/finalize`, { method: 'POST', body: JSON.stringify({ expectedSegments, endedAt }) }),
  retry: (contactId: number, sessionId: string, sequence: number) => request<RecordingSession>(`${sessionPath(contactId, sessionId)}/segments/${sequence}/retry`, { method: 'POST' }),
  cancel: (contactId: number, sessionId: string) => request<RecordingSession>(`${sessionPath(contactId, sessionId)}/cancel`, { method: 'POST' }),
  deleteAudio: (contactId: number, sessionId: string) => request<RecordingSession>(`${sessionPath(contactId, sessionId)}/audio`, { method: 'DELETE' }),
  async audio(contactId: number, sessionId: string, sequence: number): Promise<Blob> {
    sessionPath(contactId, sessionId);
    if (!window.dialer.downloadRecordingAudio) throw new Error('Audio playback is unavailable.');
    const response = await window.dialer.downloadRecordingAudio({ contactId, sessionId, sequence, authorization: getAuthHeaders().Authorization ?? '' });
    if (!response.ok) {
      await nativeResult({ ...response, body: response.errorBody ?? '' });
      throw new Error('Unable to load recording audio.');
    }
    return new Blob([response.body], { type: response.headers['content-type'] || 'audio/webm' });
  },
};
export type NotesApi = typeof notesApi;
