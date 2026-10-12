import { CONTACT_NOTES_MAX_CHARACTERS, type ContactNotesSnapshot } from '../../shared/conversationRecording';

export type NotesSaveStatus = 'saved' | 'pending' | 'saving' | 'error' | 'conflict';
export interface ContactNotesDraft extends ContactNotesSnapshot {
  draft: string;
  status: NotesSaveStatus;
  error?: string;
}

export class ContactNotesConflictError extends Error {
  constructor(public readonly latest: ContactNotesSnapshot) {
    super('Notes changed in another window. Your draft has been preserved.');
    this.name = 'ContactNotesConflictError';
  }
}

type SaveNotes = (contactId: number, notes: string, notesRevision: number) => Promise<ContactNotesSnapshot>;

/** One serialized writer per contact, shared by compact and expanded editors in a renderer. */
export class ContactNotesDrafts {
  private disposed = false;
  private readonly records = new Map<number, ContactNotesDraft>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private readonly writes = new Map<number, Promise<boolean>>();
  private readonly submitted = new Map<number, { notes: string; revision: number }>();
  private readonly listeners = new Set<() => void>();
  private snapshot: Readonly<Record<number, ContactNotesDraft>> = {};

  constructor(private readonly saveNotes: SaveNotes, private readonly debounceMs = 700) {}

  getSnapshot = (): Readonly<Record<number, ContactNotesDraft>> => this.snapshot;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  get = (contactId: number): ContactNotesDraft | undefined => this.records.get(contactId);

  private publish(): void {
    this.snapshot = Object.fromEntries(this.records);
    this.listeners.forEach(listener => listener());
  }

  receive(latest: ContactNotesSnapshot): void {
    if (this.disposed) return;
    const previous = this.records.get(latest.contactId);
    if (!previous) {
      this.records.set(latest.contactId, { ...latest, draft: latest.notes, status: 'saved' });
      this.publish();
      return;
    }
    // Lists, sockets and late write responses can arrive in any order.
    if (latest.notesRevision <= previous.notesRevision) return;
    const submitted = this.submitted.get(latest.contactId);
    let draft = previous.draft;
    let conflict = previous.status === 'conflict';
    if (draft === previous.notes) {
      draft = latest.notes;
      conflict = false;
    } else if (latest.notes === draft) {
      conflict = false;
    } else if (submitted && previous.notesRevision <= submitted.revision && latest.notes.startsWith(submitted.notes)) {
      // Our accepted write, possibly followed by a summary, must not reset newer typing.
      const suffix = latest.notes.slice(submitted.notes.length);
      draft += suffix;
      conflict = false;
    } else if (latest.notes.startsWith(previous.notes)) {
      draft += latest.notes.slice(previous.notes.length);
    } else {
      conflict = true;
    }
    const status = conflict ? 'conflict' : draft === latest.notes ? 'saved' : this.writes.has(latest.contactId) ? 'saving' : 'pending';
    this.records.set(latest.contactId, { ...latest, draft, status,
      ...(conflict ? { error: 'Notes changed elsewhere. Your draft has been preserved.' } : {}) });
    this.publish();
    if (status === 'pending') this.schedule(latest.contactId);
  }

  change(contactId: number, draft: string): void {
    if (this.disposed) return;
    const previous = this.records.get(contactId);
    if (!previous || draft === previous.draft) return;
    const conflict = previous.status === 'conflict';
    const tooLong = draft.length > CONTACT_NOTES_MAX_CHARACTERS;
    this.records.set(contactId, { ...previous, draft,
      status: conflict ? 'conflict' : tooLong ? 'error' : draft === previous.notes ? 'saved' : 'pending',
      error: tooLong ? `Notes can contain up to ${CONTACT_NOTES_MAX_CHARACTERS.toLocaleString()} characters. Your draft is preserved.` : conflict ? previous.error : undefined });
    this.publish();
    this.schedule(contactId);
  }

  schedule(contactId: number): void {
    this.clearTimer(contactId);
    const state = this.records.get(contactId);
    if (!state || state.status === 'conflict' || state.status === 'error' || state.draft === state.notes) return;
    this.timers.set(contactId, setTimeout(() => { this.timers.delete(contactId); void this.flush(contactId); }, this.debounceMs));
  }

  private clearTimer(contactId: number): void {
    const timer = this.timers.get(contactId);
    if (timer) clearTimeout(timer);
    this.timers.delete(contactId);
  }

  flush(contactId: number): Promise<boolean> {
    if (this.disposed) return Promise.resolve(false);
    this.clearTimer(contactId);
    const running = this.writes.get(contactId);
    if (running) return running;
    // Defer until the running promise is registered; socket callbacks can be synchronous.
    const write = Promise.resolve().then(async () => {
      let retries = 0;
      for (;;) {
        if (this.disposed) return false;
        const state = this.records.get(contactId);
        if (!state || state.draft === state.notes) return true;
        if (state.status === 'conflict') return false;
        if (state.draft.length > CONTACT_NOTES_MAX_CHARACTERS) {
          this.records.set(contactId, { ...state, status: 'error', error: 'Notes exceed the 200,000 character limit. Your draft is preserved.' });
          this.publish();
          return false;
        }
        this.submitted.set(contactId, { notes: state.draft, revision: state.notesRevision });
        this.records.set(contactId, { ...state, status: 'saving', error: undefined });
        this.publish();
        try {
          const saved = await this.saveNotes(contactId, state.draft, state.notesRevision);
          if (saved.contactId !== contactId || typeof saved.notes !== 'string' || !Number.isSafeInteger(saved.notesRevision) ||
            saved.notesRevision <= state.notesRevision) {
            throw new Error('Unable to verify the saved notes revision. Your draft is preserved.');
          }
          this.receive(saved);
          retries = 0;
        } catch (failure) {
          if (this.disposed) return false;
          if (failure instanceof ContactNotesConflictError) {
            // A refused write was never canonical: reconcile only against the accepted base.
            this.submitted.delete(contactId);
            this.receive(failure.latest);
            const updated = this.records.get(contactId)!;
            if (updated.status !== 'conflict' && ++retries <= 3) continue;
            if (updated.status === 'conflict') return false;
          }
          const current = this.records.get(contactId)!;
          this.records.set(contactId, { ...current, status: 'error', error: failure instanceof Error ? failure.message : 'Unable to save notes. Your draft is preserved.' });
          this.publish();
          return false;
        } finally {
          this.submitted.delete(contactId);
        }
      }
    }).finally(() => {
      this.writes.delete(contactId);
      const state = this.records.get(contactId);
      if (state?.status === 'saving') {
        this.records.set(contactId, { ...state, status: state.draft === state.notes ? 'saved' : 'pending' });
        this.publish();
      }
    });
    this.writes.set(contactId, write);
    return write;
  }

  resolveConflict(contactId: number, resolution: 'draft' | 'latest'): void {
    const state = this.records.get(contactId);
    if (!state || state.status !== 'conflict') return;
    const draft = resolution === 'latest' ? state.notes : state.draft;
    this.records.set(contactId, { ...state, draft, status: draft === state.notes ? 'saved' : 'pending', error: undefined });
    this.publish();
    if (resolution === 'draft') void this.flush(contactId);
  }

  isDirty(): boolean { return [...this.records.values()].some(state => state.draft !== state.notes); }
  async flushAll(): Promise<boolean> {
    const results = await Promise.all([...this.records.keys()].map(contactId => this.flush(contactId)));
    return results.every(Boolean);
  }
  dispose(): void { this.disposed = true; this.stopTimers(); this.records.clear(); this.listeners.clear(); this.snapshot = {}; }
  stopTimers(): void { [...this.timers.keys()].forEach(contactId => this.clearTimer(contactId)); }
}
