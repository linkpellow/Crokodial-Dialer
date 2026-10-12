import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ChevronLeft, Mic, MoreHorizontal, Square, RefreshCw } from 'lucide-react';
import type { DialerEngine } from '../../core/DialerEngine';
import type { ContactNotesDrafts } from '../services/contactNotesDrafts';
import { notesApi } from '../services/notesApiService';
import { fetchContacts, type Contact } from '../services/dialerApiService';
import { NativeRecordingController, type RecordingContact } from '../services/nativeRecordingController';
import type { ConversationRecordingSessionSummary, RecordingSession } from '../../shared/conversationRecording';
import { WorkspaceAppointments, AppointmentDispositionControl, useWorkspaceAppointments } from './WorkspaceAppointments';
import { appointmentsApi, appointmentTimeSlot, appointmentDateLabel, linkedAppointmentContact, type AppointmentSelection, type WorkspaceAppointment } from '../services/appointmentsApiService';

const nameOf = (contact: Contact) => `${contact.firstName ?? contact.first_name ?? ''} ${contact.lastName ?? contact.last_name ?? ''}`.trim() || contact.e164;
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
export function NotesWorkspace({ engine, store, recording }: {
  engine: DialerEngine | null; store: ContactNotesDrafts; recording: NativeRecordingController; onReturnToCall: () => void;
}) {
  const drafts = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const capture = useSyncExternalStore(recording.subscribe, recording.getSnapshot);
  const [selected, setSelected] = useState<RecordingContact | null>(null);
  const [selectedAppointment, setSelectedAppointment] = useState<AppointmentSelection | null>(null);
  const appointmentsRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [appointmentSnapshot, setAppointmentSnapshot] = useState<WorkspaceAppointment | null>(null);
  const appointments = useWorkspaceAppointments(selectedAppointment);
  const [recordingDetails, setRecordingDetails] = useState(false);
  const [contactDisposition, setContactDisposition] = useState('');
  const [contactDispositionBusy, setContactDispositionBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [retainAudio, setRetainAudio] = useState(true);
  const [history, setHistory] = useState<ConversationRecordingSessionSummary[]>([]);
  const [viewed, setViewed] = useState<RecordingSession | null>(null);
  const [audioUrl, setAudioUrl] = useState('');
  const [audioLoading, setAudioLoading] = useState(false);
  const [operationBusy, setOperationBusy] = useState(false);
  const selectionGeneration = useRef(0);
  const playbackGeneration = useRef(0);
  const mounted = useRef(true);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const draft = selected ? drafts[selected.id] : undefined;
  const job = viewed ?? (capture.contact?.id === selected?.id ? capture.job : undefined);
  const jobRef = useRef(job); jobRef.current = job;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++selectionGeneration.current; }; }, []);
  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);
  useEffect(() => {
    let canceled = false;
    if (query.trim().length < 3) { setResults([]); setSearching(false); return; }
    setSearching(true);
    const timer = setTimeout(() => {
      fetchContacts({ search: query, limit: 20 }).then(response => { if (!canceled) setResults(response.contacts); }).catch(failure => { if (!canceled) setError(failure.message); }).finally(() => { if (!canceled) setSearching(false); });
    }, 300);
    return () => { canceled = true; clearTimeout(timer); };
  }, [query]);
  async function selectContact(id: number, appointment: WorkspaceAppointment | null = null) {
    if (selected) void store.flush(selected.id);
    const generation = ++selectionGeneration.current; ++playbackGeneration.current;
    setLoading(true); setError(''); setAudioUrl(''); setAudioLoading(false); setViewed(null);
    try {
      const contact = await notesApi.contact(id);
      if (!mounted.current || generation !== selectionGeneration.current) return;
      store.receive(contact);
      setSelected({ id: contact.id, e164: contact.e164, name: nameOf(contact) });
      setSelectedAppointment(appointment ? { id: appointment.id, contactId: id } : null);
      setAppointmentSnapshot(appointment);
      setContactDisposition(contact.last_call_disposition ?? '');
      setDetailOpen(true);
      setRecordingDetails(capture.contact?.id === id && Boolean(capture.error));
      if (store.get(id)?.status === 'error') void store.flush(id);
      setQuery(''); setResults([]); setHistory([]);
      const sessions = await notesApi.list(id);
      if (mounted.current && generation === selectionGeneration.current) setHistory(sessions);
    } catch (failure) { if (mounted.current && generation === selectionGeneration.current) setError(failure instanceof Error ? failure.message : 'Unable to load contact notes.'); }
    finally { if (mounted.current && generation === selectionGeneration.current) setLoading(false); }
  }
  function selectAppointment(appointment: WorkspaceAppointment) {
    const contactId = linkedAppointmentContact(appointment);
    if (!contactId) { setError('This appointment has no linked contact. Find a contact above to take notes.'); return; }
    void selectContact(contactId, appointment);
  }
  function backToAppointments() {
    if (selected) void store.flush(selected.id);
    ++selectionGeneration.current; ++playbackGeneration.current;
    setLoading(false); setDetailOpen(false); setError(''); setAudioUrl(''); setAudioLoading(false);
    requestAnimationFrame(() => appointmentsRef.current?.querySelector<HTMLElement>('.appointments-list')?.focus({ preventScroll: true }));
  }
  useEffect(() => { if (detailOpen) backRef.current?.focus({ preventScroll: true }); }, [detailOpen]);
  useEffect(() => {
    if (capture.contact?.id === selected?.id && capture.error) setRecordingDetails(true);
  }, [capture.error, capture.contact?.id, selected?.id]);
  async function changeContactDisposition(value: string) {
    if (!selected || contactDispositionBusy) return;
    const id = selected.id;
    setContactDispositionBusy(true); setError('');
    try {
      const result = await appointmentsApi.saveContactDisposition(id, value || null);
      if (mounted.current && selectedRef.current?.id === id) setContactDisposition(result.disposition ?? '');
      appointments.refresh();
    } catch (failure) {
      if (mounted.current && selectedRef.current?.id === id) setError(failure instanceof Error ? failure.message : 'Disposition was not saved. Please retry.');
    } finally { if (mounted.current) setContactDispositionBusy(false); }
  }
  async function refreshHistory() {
    if (!selected) return;
    const id = selected.id, generation = selectionGeneration.current;
    try {
      const [contact, sessions] = await Promise.all([notesApi.contact(id), notesApi.list(id)]);
      if (mounted.current && generation === selectionGeneration.current) { store.receive(contact); setHistory(sessions); }
    } catch (failure) { if (mounted.current && generation === selectionGeneration.current) setError(failure instanceof Error ? failure.message : 'Unable to refresh notes.'); }
  }
  useEffect(() => { if (capture.phase === 'complete' && selected?.id === capture.contact?.id) void refreshHistory(); }, [capture.phase, capture.contact?.id]);
  useEffect(() => {
    if (!viewed || !['active', 'finalizing'].includes(viewed.status)) return;
    const id = viewed.contactId, sessionId = viewed.sessionId, generation = selectionGeneration.current;
    let canceled = false, count = 0, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await notesApi.get(id, sessionId);
        if (canceled || generation !== selectionGeneration.current) return;
        setViewed(next);
        if (next.status === 'completed' && typeof next.notes === 'string' && Number.isSafeInteger(next.notesRevision)) store.receive({ contactId: id, notes: next.notes, notesRevision: next.notesRevision! });
        if (['active', 'finalizing'].includes(next.status) && ++count < 300) timer = setTimeout(poll, 3000);
      } catch { if (!canceled) setError('Recording refresh paused. Reopen the recording to retry.'); }
    };
    timer = setTimeout(poll, 3000);
    return () => { canceled = true; clearTimeout(timer); };
  }, [viewed?.sessionId, viewed?.status, store]);
  async function run(operation: () => Promise<unknown>) {
    if (operationBusy) return;
    setOperationBusy(true); setError('');
    try { await operation(); } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'Unable to complete this action.'); }
    finally { if (mounted.current) setOperationBusy(false); }
  }
  async function start() {
    if (!selected || !engine) return;
    const contact = selected;
    await engine.associateRecordingContact(contact);
    if (!mounted.current || selectedRef.current?.id !== contact.id) return;
    setViewed(null); setRecordingDetails(true);
    await recording.start(contact, retainAudio);
  }
  async function play(sequence: number) {
    if (!job) return;
    const generation = selectionGeneration.current, playback = ++playbackGeneration.current, sessionId = job.sessionId;
    setAudioLoading(true); setAudioUrl('');
    try {
      const blob = await notesApi.audio(job.contactId, job.sessionId, sequence);
      if (!mounted.current || generation !== selectionGeneration.current || playback !== playbackGeneration.current || jobRef.current?.sessionId !== sessionId) return;
      setAudioUrl(URL.createObjectURL(blob));
    } finally { if (mounted.current && generation === selectionGeneration.current) setAudioLoading(false); }
  }
  const activeCall = engine?.getRecordingCallSnapshot();
  const recordingElsewhere = Boolean(capture.contact && (!detailOpen || selected?.id !== capture.contact.id) && recording.hasUnsavedAudio());
  const shownAppointment = appointments.selectedAppointment ?? appointmentSnapshot;
  const recordingCurrent = capture.contact?.id === selected?.id;
  const captureStatus = recordingCurrent ? capture.phase === 'recording' ? `Recording · ${clock(capture.elapsedSeconds)}` : capture.phase === 'processing' ? 'Finishing AI notes…' : capture.phase === 'uploading' || capture.phase === 'stopping' ? 'Saving recorded audio…' : capture.phase === 'complete' ? 'Recording finished' : capture.phase === 'starting' ? 'Preparing recording…' : '' : '';
  const otherFailedDrafts = Object.values(drafts).filter(item => item.contactId !== selected?.id && ['error', 'conflict'].includes(item.status));
  return <div className="notes-workspace">
    {otherFailedDrafts.length > 0 && <div className="notes-draft-alert" role="alert"><span>{otherFailedDrafts.length === 1 ? "Another contact’s notes need attention. Their draft is preserved." : `${otherFailedDrafts.length} contacts have notes that need attention. Their drafts are preserved.`}</span><button onClick={() => void selectContact(otherFailedDrafts[0].contactId)}>Review notes</button></div>}
    <div className="notes-list-view" hidden={detailOpen}>
      <div className="notes-search">
        <label className="notes-label" htmlFor="notes-contact-search">Search</label>
        <input id="notes-contact-search" placeholder="Name or phone" value={query} onChange={event => setQuery(event.target.value)} />
        {searching && <p className="notes-muted" role="status">Finding contacts…</p>}
        {results.length > 0 && <ul className="notes-results">{results.map(contact => <li key={contact.id}><button disabled={loading} onClick={() => void selectContact(contact.id)}><strong>{nameOf(contact)}</strong><span>{contact.e164}</span></button></li>)}</ul>}
        {!searching && query.trim().length >= 3 && !results.length && <p className="notes-muted">No matching contacts.</p>}
        {activeCall?.contactId && <button className="notes-link" disabled={loading} onClick={() => void selectContact(activeCall.contactId!)}>Use current call contact</button>}
        {loading && <p role="status" className="notes-muted">Loading contact notes…</p>}
        {!detailOpen && error && <p role="alert" className="assistant-error">{error}</p>}
        {!detailOpen && selected && draft?.error && <p role="alert" className="assistant-error">{draft.error} <button className="notes-link" onClick={() => void selectContact(selected.id, appointmentSnapshot)}>Review note draft</button></p>}
        {recordingElsewhere && <div className="notes-recording-notice"><span>Recording for {capture.contact?.name} · {clock(capture.elapsedSeconds)}</span><button onClick={() => void selectContact(capture.contact!.id)}>Open recording contact</button></div>}
      </div>
      <div className="notes-appointments-host" ref={appointmentsRef}><WorkspaceAppointments model={appointments} selecting={loading} onSelect={selectAppointment}/></div>
    </div>
    {selected && detailOpen && <div className="notes-detail-view">
      <header className="notes-detail-header">
        <button ref={backRef} className="icon-button notes-back" onClick={backToAppointments} aria-label="Back to appointments" title="Back"><ChevronLeft size={21}/></button>
        <div><strong>{selected.name}</strong>{shownAppointment && <small>{appointmentDateLabel(shownAppointment)} · {appointmentTimeSlot(shownAppointment)}</small>}</div>
      </header>
      <div className="notes-detail-body">
        {selectedAppointment ? <AppointmentDispositionControl model={appointments} appointment={appointments.selectedAppointment}/> : <div className="appointment-disposition-control">
          <select className="appointment-disposition" aria-label={`Disposition for ${selected.name}`} value={contactDisposition} disabled={contactDispositionBusy || appointments.catalogLoading || Boolean(appointments.catalogError)} onChange={event => void changeContactDisposition(event.target.value)}>
            <option value="">No Disposition</option>
            {contactDisposition && !appointments.catalog.some(option => option.name === contactDisposition) && <option value={contactDisposition}>{contactDisposition}</option>}
            {appointments.catalog.map(option => <option key={option.id} value={option.name}>{option.name}</option>)}
          </select>
          {appointments.catalogError && <p role="alert" className="assistant-error">{appointments.catalogError} <button onClick={appointments.retryCatalog}>Retry dispositions</button></p>}
        </div>}
        {error && <p role="alert" className="assistant-error">{error}</p>}
        {recordingElsewhere && <div className="notes-recording-notice"><span>Recording for {capture.contact?.name}</span><button onClick={() => void selectContact(capture.contact!.id)}>Open recording contact</button></div>}
        {draft?.error && <p role="alert" className="assistant-error">{draft.error}{draft.status === 'error' && <button className="notes-link" onClick={() => void store.flush(selected.id)}>Retry saving notes</button>}</p>}
        {draft?.status === 'conflict' && <div className="notes-conflict"><details><summary>Review conflicting notes</summary><p>Your draft is preserved. The saved version is:</p><p className="notes-text">{draft.notes}</p></details><button onClick={() => store.resolveConflict(selected.id, 'draft')}>Keep my draft</button><button onClick={() => store.resolveConflict(selected.id, 'latest')}>Use saved notes</button></div>}
        <label className="notes-label" htmlFor="contact-notes">Notes</label>
        <div className="notes-editor-frame">
          <textarea id="contact-notes" value={draft?.draft ?? ''} disabled={!draft || loading} onChange={event => store.change(selected.id, event.target.value)} onBlur={() => void store.flush(selected.id)} placeholder="Type notes for this contact…" />
          <div className="notes-editor-toolbar" aria-label="Call recording">
            {recordingCurrent && ['starting', 'recording'].includes(capture.phase) ? <button className="notes-record-button recording-stop" aria-label="Stop and finish notes" onClick={() => void recording.stop()}><Square size={13}/>Stop</button> : <button className="notes-record-button" aria-label="Record call" title={!activeCall ? 'Connect a call for this contact to record' : 'Record this connected call'} disabled={operationBusy || loading || !activeCall || !['in_call', 'held'].includes(activeCall.state) || recording.hasUnsavedAudio() || capture.phase === 'processing'} onClick={() => void run(start)}><Mic size={15}/>Record</button>}
            <span className="notes-capture-status" role="status">{captureStatus}</span>
            <button className="icon-button" aria-label="Recording details" title="Recording options and history" aria-expanded={recordingDetails} aria-controls="notes-recording-details" onClick={() => setRecordingDetails(value => !value)}><MoreHorizontal size={16}/></button>
          </div>
          {recordingDetails && <div id="notes-recording-details" className="notes-recording-details" role="region" aria-label="Recording details">
            <section className="notes-card" aria-label="Recording options">
              <div className="notes-row"><h2>Recording</h2><button className="icon-button" onClick={() => void refreshHistory()} aria-label="Refresh contact notes"><RefreshCw size={13}/></button></div>
              <label className="notes-checkbox"><input type="checkbox" checked={retainAudio} disabled={recording.hasUnsavedAudio()} onChange={event => setRetainAudio(event.target.checked)} />Keep recording for playback</label>
              {recordingCurrent && <>
                {capture.notice && <p className="notes-muted">{capture.notice}</p>}
                {capture.error && <p className="assistant-error" role="alert">{capture.error}</p>}
                {(capture.error || capture.phase === 'error') && <div className="notes-row"><button disabled={operationBusy} onClick={() => void run(() => recording.retry())}>Retry recording work</button><button disabled={operationBusy} onClick={() => void run(() => recording.cancel())}>Cancel recording</button></div>}
              </>}
            </section>
        {job && <section className="notes-card" aria-label="AI recording notes"><div className="notes-row"><h2>{job.status === 'completed' ? 'Final AI notes' : 'Live AI draft'}</h2><small>{job.status.replace('_', ' ')}</small></div><p className="notes-text">{job.status === 'completed' ? job.summary || 'Notes added to this contact.' : job.draftNotes || 'The first live AI draft appears after roughly a minute of audio and processing.'}</p>{job.status !== 'completed' && <p className="notes-muted">Draft only. Review AI notes for accuracy; saved notes update after finalization.</p>}
          {job.error && <p className="assistant-error">{job.error}</p>}
          {job.segments.map(segment => <div className="notes-segment" key={segment.sequence}><span>Part {segment.sequence + 1} · {segment.status.replace('_', ' ')}</span>{segment.audioAvailable && <button disabled={audioLoading} onClick={() => void run(() => play(segment.sequence))}>Play part {segment.sequence + 1}</button>}{segment.retryable && ['failed', 'needs_review'].includes(segment.status) && <button disabled={operationBusy} onClick={() => void run(async () => { const generation = selectionGeneration.current; const next = await notesApi.retry(job.contactId, job.sessionId, segment.sequence); if (generation === selectionGeneration.current) setViewed(next); })}>Retry part {segment.sequence + 1}</button>}{segment.error && <small>{segment.error}</small>}</div>)}
          {viewed && !['completed', 'canceled'].includes(viewed.status) && viewed.sessionId !== (recording.hasUnsavedAudio() ? capture.sessionId : null) && <div className="notes-row">
            <button disabled={operationBusy || !viewed.segments.length} onClick={() => void run(async () => {
              const generation = selectionGeneration.current;
              const last = viewed.segments[viewed.segments.length - 1];
              const end = viewed.endedAt ?? new Date(Date.parse(viewed.startedAt) + last.endOffsetMs).toISOString();
              const next = await notesApi.finalize(viewed.contactId, viewed.sessionId, viewed.segmentCount, end);
              if (generation === selectionGeneration.current) setViewed(next);
            })}>{viewed.endedAt ? 'Retry final notes' : 'Finish saved segments'}</button>
            <button disabled={operationBusy} onClick={() => void run(async () => { const generation = selectionGeneration.current; const next = await notesApi.cancel(viewed.contactId, viewed.sessionId); if (generation === selectionGeneration.current) { setViewed(next); await refreshHistory(); } })}>Cancel saved recording</button>
          </div>}
          {audioUrl && <audio controls src={audioUrl} aria-label="Saved call recording"/>}
          {job.audioAvailable && <button className="notes-link" disabled={operationBusy} onClick={() => void run(async () => { const generation = selectionGeneration.current; const next = await notesApi.deleteAudio(job.contactId, job.sessionId); if (generation === selectionGeneration.current) { setViewed(next); setAudioUrl(''); ++playbackGeneration.current; await refreshHistory(); } })}>Delete saved audio (keeps notes)</button>}
        </section>}
        {history.length > 0 && <section className="notes-card"><h2>Recent recordings</h2>{history.map(session => <button className="notes-history" key={session.sessionId} disabled={operationBusy} onClick={() => void run(async () => { const generation = selectionGeneration.current; const next = await notesApi.get(selected.id, session.sessionId); if (generation === selectionGeneration.current) { ++playbackGeneration.current; setViewed(next); setAudioUrl(''); setAudioLoading(false); } })}><span>{new Date(session.startedAt).toLocaleString()}</span><small>{session.status.replace('_', ' ')} · {clock(session.totalDurationSeconds)}</small></button>)}</section>}
          </div>}
        </div>
      </div>
    </div>}
  </div>;
}
