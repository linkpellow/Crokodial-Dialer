import type { RecordingSession } from '../../shared/conversationRecording';
import { RECORDING_MAX_BYTES, RECORDING_MAX_DURATION_SECONDS } from '../../shared/conversationRecording';
import { NotesApiError, type NotesApi, type UploadClip } from './notesApiService';

export interface NativeCallSnapshot {
  callId: string;
  registeredCallId?: string | null;
  state: string;
  remoteNumber: string;
  contactId?: number;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  isMuted: boolean;
  isOnHold: boolean;
}
export interface RecordingContact { id: number; e164: string; name: string }
export interface NativeRecordingState {
  phase: 'idle' | 'starting' | 'recording' | 'stopping' | 'uploading' | 'processing' | 'complete' | 'error';
  contact?: RecordingContact;
  callId?: string;
  sessionId?: string;
  elapsedSeconds: number;
  pendingSegments: number;
  error?: string;
  notice?: string;
  job?: RecordingSession;
}
interface Segment {
  recorder: MediaRecorder;
  sequence: number;
  startOffsetMs: number;
  endOffsetMs?: number;
  chunks: Blob[];
  bytes: number;
}
const live = (stream: MediaStream | null) => stream?.getAudioTracks().some(track => track.readyState === 'live');
export function canonicalPhone(number: string): string {
  const digits = number.replace(/\D/g, '');
  return digits.length === 10 ? `1${digits}` : digits;
}
export function matchesRecordingContact(call: NativeCallSnapshot, contact: RecordingContact): boolean {
  const number = canonicalPhone(contact.e164);
  return number.length >= 10 && number === canonicalPhone(call.remoteNumber) && (!call.contactId || call.contactId === contact.id);
}

/** One native window owns both call media and capture. Only recording-created output tracks are stopped. */
export class NativeRecordingController {
  private state: NativeRecordingState = { phase: 'idle', elapsedSeconds: 0, pendingSegments: 0 };
  private listeners = new Set<() => void>();
  private generation = 0;
  private disposed = false;
  private context?: AudioContext;
  private output?: MediaStream;
  private destination?: MediaStreamAudioDestinationNode;
  private sources: MediaStreamAudioSourceNode[] = [];
  private gains: GainNode[] = [];
  private tracks: MediaStreamTrack[] = [];
  private current?: Segment;
  private closing = 0;
  private queue: UploadClip[] = [];
  private sequence = 0;
  private totalBytes = 0;
  private origin = 0;
  private endedAt = '';
  private timer?: ReturnType<typeof setInterval>;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private uploading = false;
  private finalizeStarted = false;
  private stopped = true;
  private stopping?: Promise<void>;
  private paused = false;
  private pollCount = 0;
  private incomplete = false;
  private created = false;
  private creation?: { contactId: number; sessionId: string; callId: string; startedAt: string; retainAudio: boolean };
  constructor(private readonly api: NotesApi, private readonly call: () => NativeCallSnapshot | null, private readonly receiveNotes: (job: RecordingSession) => void, private readonly segmentMs = 55_000) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(update: Partial<NativeRecordingState>): void {
    if (this.disposed) return;
    this.state = { ...this.state, ...update, pendingSegments: this.queue.length + this.closing };
    this.listeners.forEach(listener => listener());
  }
  hasUnsavedAudio(): boolean { return !this.stopped || Boolean(this.current) || this.closing > 0 || this.queue.length > 0 || this.state.phase === 'starting' || this.state.phase === 'stopping' || this.state.phase === 'uploading' || (this.created && this.stopped && !this.finalizeStarted && this.state.job?.status === 'active'); }
  private valid(generation: number) { return !this.disposed && generation === this.generation; }
  private currentCall(): NativeCallSnapshot {
    const call = this.call();
    if (!call || call.callId !== this.state.callId || !['in_call', 'held'].includes(call.state)) throw new Error('The selected call has ended.');
    if (!this.state.contact || !matchesRecordingContact(call, this.state.contact)) throw new Error('The call no longer matches the recording contact.');
    if (!live(call.localStream) || !live(call.remoteStream)) throw new Error('Both sides of the call audio must be connected.');
    return call;
  }
  async start(contact: RecordingContact, retainAudio: boolean): Promise<void> {
    if (this.disposed || this.hasUnsavedAudio() || this.state.phase === 'processing' || (this.state.job && !['completed', 'canceled'].includes(this.state.job.status))) throw new Error('Finish the current recording before starting another.');
    const call = this.call();
    if (!call || !matchesRecordingContact(call, contact) || !['in_call', 'held'].includes(call.state) || !live(call.localStream) || !live(call.remoteStream)) throw new Error('Select the contact whose connected call is open in the dialer. Both audio streams are required.');
    const generation = ++this.generation;
    this.queue = []; this.sequence = 0; this.totalBytes = 0; this.closing = 0; this.paused = false; this.stopped = false; this.finalizeStarted = false; this.pollCount = 0; this.incomplete = false; this.created = false; this.creation = undefined;
    this.publish({ phase: 'starting', contact, callId: call.callId, sessionId: crypto.randomUUID(), elapsedSeconds: 0, error: undefined, notice: undefined, job: undefined });
    try {
      this.context = new AudioContext();
      await this.context.resume();
      if (!this.valid(generation)) return;
      const [capabilities, owned] = await Promise.all([this.api.capabilities(), this.api.contact(contact.id)]);
      if (!this.valid(generation)) return;
      if (this.stopped) throw new Error('Recording canceled before capture started.');
      if (!capabilities.available) throw new Error(capabilities.reason || 'AI recording is not configured for this workspace.');
      if (canonicalPhone(owned.e164) !== canonicalPhone(contact.e164)) throw new Error('The contact phone number changed. Reload the contact before recording.');
      const registered = this.currentCall().registeredCallId;
      if (!registered) throw new Error('Register the selected contact for this call before recording.');
      this.destination = this.context.createMediaStreamDestination();
      this.output = this.destination.stream;
      this.updateGraph(this.currentCall());
      this.creation = { contactId: contact.id, sessionId: this.state.sessionId!, callId: registered, startedAt: new Date().toISOString(), retainAudio };
      this.origin = performance.now();
      this.current = this.beginSegment(0);
      this.publish({ phase: 'recording' });
      this.timer = setInterval(() => this.monitor(), 250);
      await this.createSession();
      if (!this.valid(generation)) return;
      await this.pump();
      this.schedulePoll();
    } catch (failure) {
      if (!this.valid(generation)) return;
      this.paused = true;
      await this.stop();
      this.disposeGraph();
      this.publish({ phase: 'error', error: failure instanceof Error ? failure.message : 'Unable to start recording.' });
      // A created session with no audio can be safely canceled; failure remains visible.
      if (this.state.job && this.sequence === 0) await this.api.cancel(contact.id, this.state.sessionId!).catch(() => undefined);
    }
  }
  private async createSession(): Promise<void> {
    const input = this.creation;
    if (!input) return;
    const generation = this.generation;
    const job = await this.api.create(input.contactId, input.sessionId, input.callId, input.startedAt, input.retainAudio);
    if (!this.valid(generation)) return;
    this.created = true; this.receive(job);
  }
  private beginSegment(startOffsetMs: number): Segment {
    if (!this.output) throw new Error('Recording audio is not connected.');
    const mimeType = ['audio/webm;codecs=opus', 'audio/webm'].find(type => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error('WebM audio recording is unavailable.');
    const recorder = new MediaRecorder(this.output, { mimeType, audioBitsPerSecond: 64_000 });
    const segment: Segment = { recorder, sequence: this.sequence, startOffsetMs, chunks: [], bytes: 0 };
    const generation = this.generation;
    recorder.ondataavailable = event => {
      if (!this.valid(generation) || !event.data.size) return;
      segment.chunks.push(event.data); segment.bytes += event.data.size;
      if (segment === this.current && segment.bytes >= 3 * 1024 * 1024) this.rotate();
    };
    recorder.onerror = () => { if (this.valid(generation)) void this.stop('Audio capture was interrupted. Captured audio is being saved.'); };
    recorder.onstop = () => {
      if (!this.valid(generation)) return;
      if (segment.endOffsetMs === undefined) {
        segment.endOffsetMs = Math.max(segment.startOffsetMs + 1, Math.round(performance.now() - this.origin));
        if (this.current === segment) {
          this.current = undefined; this.stopped = true; this.endedAt = new Date().toISOString();
          this.disposeGraph(); this.publish({ phase: 'stopping', notice: 'Call audio stopped. Captured audio is being saved.' });
        }
      } else this.closing = Math.max(0, this.closing - 1);
      const blob = new Blob(segment.chunks, { type: mimeType });
      segment.chunks = [];
      if (!blob.size || blob.size > 4 * 1024 * 1024 || (segment.endOffsetMs ?? 0) - segment.startOffsetMs > 60_000) {
        this.paused = true; this.incomplete = true;
        this.publish({ phase: 'error', error: 'A recording segment exceeded its limits or contained no audio. Keep this session for review; it will not be finalized with missing audio.' });
        void this.stop();
        return;
      }
      this.totalBytes += blob.size;
      this.queue.push({ sequence: segment.sequence, blob, startOffsetMs: segment.startOffsetMs, endOffsetMs: segment.endOffsetMs! });
      this.queue.sort((a, b) => a.sequence - b.sequence);
      this.publish({});
      if (this.totalBytes >= RECORDING_MAX_BYTES - 4 * 1024 * 1024) void this.stop('The recording reached its size limit.');
      void this.pump();
    };
    recorder.start(1000);
    this.sequence++;
    return segment;
  }
  private stopSegment(segment: Segment): void {
    if (segment.endOffsetMs !== undefined) return;
    segment.endOffsetMs = Math.max(segment.startOffsetMs + 1, Math.round(performance.now() - this.origin));
    this.closing++;
    if (segment.recorder.state !== 'inactive') segment.recorder.stop();
  }
  private rotate(): void {
    if (this.stopped || !this.current) return;
    if (this.queue.length + this.closing >= 2) { void this.stop('Uploads are falling behind. Recording stopped to preserve the captured audio. Retry pending uploads before recording again.'); return; }
    const previous = this.current;
    try {
      // Start a new container before stopping the old one. Every blob is independently decodable.
      this.current = this.beginSegment(Math.round(performance.now() - this.origin));
      this.stopSegment(previous);
    } catch (error) { void this.stop(error instanceof Error ? error.message : 'Unable to continue recording.'); }
  }
  private updateGraph(call: NativeCallSnapshot): void {
    const tracks = [call.localStream!, call.remoteStream!].map(stream => stream.getAudioTracks().find(track => track.readyState === 'live')!);
    if (tracks.some((track, i) => track !== this.tracks[i])) {
      this.sources.forEach(source => source.disconnect()); this.gains.forEach(gain => gain.disconnect());
      this.sources = []; this.gains = [];
      for (const track of tracks) {
        const source = this.context!.createMediaStreamSource(new MediaStream([track]));
        const gain = this.context!.createGain(); source.connect(gain); gain.connect(this.destination!);
        this.sources.push(source); this.gains.push(gain);
      }
      this.tracks = tracks;
    }
    this.gains[0].gain.value = call.isMuted || call.isOnHold ? 0 : 0.5;
    this.gains[1].gain.value = call.isOnHold ? 0 : 0.5;
  }
  private monitor(): void {
    if (this.stopped) return;
    try { this.updateGraph(this.currentCall()); } catch { void this.stop('The call ended or its audio disconnected. Captured audio is being saved.'); return; }
    const elapsed = Math.max(0, performance.now() - this.origin);
    this.publish({ elapsedSeconds: Math.floor(elapsed / 1000) });
    if (elapsed >= (RECORDING_MAX_DURATION_SECONDS - 5) * 1000) { void this.stop('The recording reached its two-hour limit.'); return; }
    if (this.current && elapsed - this.current.startOffsetMs >= this.segmentMs) this.rotate();
  }
  stop(notice?: string): Promise<void> {
    if (this.stopping) return this.stopping;
    if (this.stopped) return Promise.resolve();
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.publish({ phase: this.paused ? 'error' : 'stopping', ...(notice ? { notice } : {}) });
    const generation = this.generation;
    this.stopping = (async () => {
      // A freshly rotated encoder needs a few frames before stop can emit a valid container.
      if (this.current) {
        const age = performance.now() - this.origin - this.current.startOffsetMs;
        if (age < 160) await new Promise(resolve => setTimeout(resolve, 160 - age));
      }
      if (!this.valid(generation)) return;
      this.endedAt = new Date().toISOString();
      if (this.current) { const current = this.current; this.current = undefined; this.stopSegment(current); }
      this.disposeGraph();
      await this.pump();
    })().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }
  private disposeGraph(): void {
    if (this.timer) clearInterval(this.timer);
    this.sources.forEach(source => { try { source.disconnect(); } catch {} });
    this.gains.forEach(gain => { try { gain.disconnect(); } catch {} });
    this.output?.getTracks().forEach(track => track.stop());
    void this.context?.close().catch(() => undefined);
    this.sources = []; this.gains = []; this.tracks = []; this.context = undefined; this.output = undefined; this.destination = undefined;
  }
  private async pump(): Promise<void> {
    if (this.uploading || this.paused || this.disposed || !this.created || !this.state.contact || !this.state.sessionId) return;
    const generation = this.generation, contactId = this.state.contact.id, sessionId = this.state.sessionId;
    this.uploading = true;
    try {
      while (this.queue.length && this.valid(generation)) {
        const clip = this.queue[0];
        if (this.stopped) this.publish({ phase: 'uploading' });
        const job = await this.api.upload(contactId, sessionId, clip);
        if (!this.valid(generation)) return;
        this.queue.shift(); this.receive(job); this.publish({});
      }
      if (this.stopped && !this.incomplete && !this.closing && this.sequence > 0 && !this.finalizeStarted && this.valid(generation)) {
        this.finalizeStarted = true;
        this.publish({ phase: 'uploading' });
        const job = await this.api.finalize(contactId, sessionId, this.sequence, this.endedAt);
        if (!this.valid(generation)) return;
        this.receive(job); this.publish({ phase: job.status === 'completed' ? 'complete' : 'processing' }); this.schedulePoll();
      }
    } catch (failure) {
      if (this.valid(generation)) {
        this.paused = true; this.finalizeStarted = false;
        await this.stop();
        this.publish({ phase: 'error', error: failure instanceof Error ? failure.message : 'Upload failed. Captured audio is preserved for retry.' });
      }
    } finally { this.uploading = false; }
  }
  private receive(job: RecordingSession): void {
    if (job.sessionId !== this.state.sessionId || job.contactId !== this.state.contact?.id) throw new Error('Recording response does not match its contact and session.');
    this.publish({ job });
    if (job.status === 'completed') {
      this.receiveNotes(job); this.publish({ phase: 'complete', error: undefined });
    } else if (['failed', 'needs_review', 'canceled'].includes(job.status)) {
      this.publish({ ...(this.stopped ? { phase: 'error' as const } : {}), error: job.error || (job.status === 'canceled' ? 'Recording canceled.' : 'The recording needs review.') });
    }
  }
  private schedulePoll(): void {
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.disposed || this.pollCount >= 3600 || !this.state.sessionId || ['completed', 'canceled'].includes(this.state.job?.status ?? '')) return;
    this.pollTimer = setTimeout(() => { void this.poll(); }, 2000);
  }
  private async poll(): Promise<void> {
    if (this.disposed || !this.state.contact || !this.state.sessionId) return;
    const generation = this.generation;
    try {
      const job = await this.api.get(this.state.contact.id, this.state.sessionId);
      if (!this.valid(generation)) return;
      this.pollCount++; this.receive(job);
      if (!['failed', 'needs_review', 'completed', 'canceled'].includes(job.status)) this.schedulePoll();
    } catch (error) { if (this.valid(generation)) this.publish({ error: `Live notes refresh paused: ${error instanceof Error ? error.message : 'Connection interrupted'}. Use Retry to resume.` }); }
  }
  async retry(): Promise<void> {
    const generation = this.generation;
    if (this.disposed) return;
    if (this.incomplete) throw new Error('This recording has an incomplete audio segment and cannot be finalized. Cancel it and start a new recording.');
    this.paused = false; this.publish({ error: undefined });
    if (!this.created) await this.createSession();
    await this.pump();
    if (!this.valid(generation)) return;
    const failed = this.state.job?.segments.find(segment => ['failed', 'needs_review'].includes(segment.status) && segment.retryable);
    if (failed && this.state.contact && this.state.sessionId) this.receive(await this.api.retry(this.state.contact.id, this.state.sessionId, failed.sequence));
    await this.poll();
  }
  async cancel(): Promise<void> {
    this.paused = true; await this.stop();
    if (this.state.contact && this.state.sessionId) {
      let job: RecordingSession | undefined;
      try { job = await this.api.cancel(this.state.contact.id, this.state.sessionId); } catch (error) {
        if (this.created || !(error instanceof NotesApiError) || error.status !== 404) throw error;
      }
      ++this.generation; this.queue = []; this.closing = 0; this.publish({ phase: 'complete', job, error: undefined, notice: 'Recording canceled. Saved contact notes were not changed.' });
    }
  }
  dispose(): void {
    this.disposed = true; ++this.generation; this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    if (this.current?.recorder.state !== 'inactive') this.current?.recorder.stop();
    this.disposeGraph(); this.current = undefined; this.queue = []; this.listeners.clear();
  }
}
