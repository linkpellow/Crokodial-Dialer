import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ChevronLeft, Mic, MoreHorizontal, Square, History } from 'lucide-react';
import { CollapsibleSearch } from './CollapsibleSearch';
import type { DialerEngine } from '../../core/DialerEngine';
import type { ContactNotesDrafts } from '../services/contactNotesDrafts';
import { notesApi } from '../services/notesApiService';
import type { Contact } from '../services/dialerApiService';
import { WorkspaceContacts } from './WorkspaceContacts';
import { ContactHistory } from './ContactHistory';
import { workspaceContactsApi, workspaceContactName, workspaceContactPhone, type WorkspaceContact } from '../services/workspaceContactsApi';
import { ContactCallControl, type ContactCalling } from './ContactCallControl';
import { NativeRecordingController, type RecordingContact } from '../services/nativeRecordingController';
import type { ContactNotesSnapshot, ConversationRecordingSessionSummary, RecordingSession } from '../../shared/conversationRecording';
import { WorkspaceAppointments, AppointmentDispositionControl, useWorkspaceAppointments } from './WorkspaceAppointments';
import { appointmentsApi, appointmentTimeSlot, appointmentDateLabel, linkedAppointmentContact, type AppointmentSelection, type WorkspaceAppointment } from '../services/appointmentsApiService';

const nameOf = (contact: Contact) => `${contact.firstName ?? contact.first_name ?? ''} ${contact.lastName ?? contact.last_name ?? ''}`.trim() || contact.e164;
const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
export function NotesWorkspace({ engine, store, recording, mode = 'notes', active = true, calling }: {
  engine: DialerEngine | null; store: ContactNotesDrafts; recording: NativeRecordingController; onReturnToCall: () => void;
  mode?: 'notes' | 'contacts'; active?: boolean; calling?: ContactCalling;
}) {
  const drafts = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const capture = useSyncExternalStore(recording.subscribe, recording.getSnapshot);
  const [selected, setSelected] = useState<(RecordingContact & { state?: string }) | null>(null);
  const [selectedAppointment, setSelectedAppointment] = useState<AppointmentSelection | null>(null);
  const appointmentsRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailOrigin, setDetailOrigin] = useState<'notes' | 'contacts'>('notes');
  const [historyOpen, setHistoryOpen] = useState(false);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const cursor = useRef({ start: 0, end: 0, direction: 'none' as 'forward' | 'backward' | 'none', scrollTop: 0 });
  const detailVisible = detailOpen && detailOrigin === mode;
  const [appointmentSnapshot, setAppointmentSnapshot] = useState<WorkspaceAppointment | null>(null);
  const appointments = useWorkspaceAppointments(selectedAppointment);
  const [recordingDetails, setRecordingDetails] = useState(false);
  const [contactDisposition, setContactDisposition] = useState('');
  const [contactDispositionBusy, setContactDispositionBusy] = useState(false);
  const [contactUpdate, setContactUpdate] = useState<Pick<WorkspaceContact, 'id' | 'clientStatus' | 'disposition'>>();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<WorkspaceContact[]>([]);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const loadedSearch = useRef<string | null>(null);
  const [error, setError] = useState('');
  const [refreshError, setRefreshError] = useState('');
  const [recordingRefreshError, setRecordingRefreshError] = useState('');
  const refreshInFlight = useRef<string | null>(null);
  const dispositionVersion = useRef(0);
  const dispositionBusyRef = useRef(false);
  const [retainAudio, setRetainAudio] = useState(true);
  const [history, setHistory] = useState<ConversationRecordingSessionSummary[]>([]);
  const [viewed, setViewed] = useState<RecordingSession | null>(null);
  const [audioUrl, setAudioUrl] = useState('');
  const [audioLoading, setAudioLoading] = useState(false);
  const [operationBusy, setOperationBusy] = useState(false);
  const selectionGeneration = useRef(0);
  // Changes synchronously at selection start; rendered selected can still be the previous contact.
  const selectionTarget = useRef<number | null>(null);
  const selectionPending = useRef(false);
  const editorRestore = useRef<(typeof cursor.current & { contactId: number; generation: number }) | null>(null);
  const playbackGeneration = useRef(0);
  const mounted = useRef(true);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const draft = selected ? drafts[selected.id] : undefined;
  const job = viewed ?? (capture.contact?.id === selected?.id ? capture.job : undefined);
  const jobRef = useRef(job); jobRef.current = job;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; selectionTarget.current = null; ++selectionGeneration.current; }; }, []);
  useEffect(() => () => { if (audioUrl) URL.revokeObjectURL(audioUrl); }, [audioUrl]);
  useLayoutEffect(() => {
    const saved = editorRestore.current, editor = editorRef.current;
    editorRestore.current = null;
    if (saved && editor && document.activeElement === editor && saved.contactId === selectionTarget.current && saved.generation === selectionGeneration.current) {
      editor.setSelectionRange(saved.start, saved.end, saved.direction);
      editor.scrollTop = saved.scrollTop;
    }
  }, [draft?.draft, selected?.id]);
  function receiveNotes(latest: ContactNotesSnapshot) {
    const editor = editorRef.current, previous = store.get(latest.contactId)?.draft;
    if (editor && document.activeElement === editor && selectionTarget.current === latest.contactId && selectedRef.current?.id === latest.contactId) {
      editorRestore.current = { contactId: latest.contactId, generation: selectionGeneration.current, start: editor.selectionStart, end: editor.selectionEnd, direction: editor.selectionDirection, scrollTop: editor.scrollTop };
    }
    store.receive(latest);
    if (store.get(latest.contactId)?.draft === previous) editorRestore.current = null;
  }
  useEffect(() => {
    let canceled = false, inFlight = false;
    const search = query.trim();
    if (search.length < 3) { setResults([]); setSearching(false); setSearchError(''); loadedSearch.current = null; return; }
    if (!active || mode !== 'notes' || detailVisible) { setSearching(false); return; }
    const load = async (silent: boolean) => {
      if (canceled || inFlight) return;
      inFlight = true;
      if (!silent) setSearching(true);
      try {
        const response = await workspaceContactsApi.list({ search, limit: 20 });
        if (!canceled) { setResults(response.contacts); setSearchError(''); loadedSearch.current = search; }
      } catch (failure) { if (!canceled) setSearchError(failure instanceof Error ? failure.message : 'Search is temporarily unavailable. Retrying automatically.'); }
      finally { inFlight = false; if (!canceled) setSearching(false); }
    };
    const cached = loadedSearch.current === search;
    if (!cached) { setResults([]); setSearching(true); setSearchError(''); }
    const debounce = setTimeout(() => { void load(cached); }, 300);
    const refresh = () => { if (!document.hidden) void load(true); };
    const timer = setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { canceled = true; clearTimeout(debounce); clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [query, active, mode, detailVisible]);
  async function selectContact(id: number, appointment: WorkspaceAppointment | null = null) {
    if (selected) void store.flush(selected.id);
    const generation = ++selectionGeneration.current; ++playbackGeneration.current;
    selectionTarget.current = id; selectionPending.current = true; editorRestore.current = null;
    let received = false;
    setRecordingRefreshError('');
    setLoading(true); setError(''); setRefreshError(''); setAudioUrl(''); setAudioLoading(false); setViewed(null);
    try {
      const contact = await notesApi.contact(id);
      if (!mounted.current || generation !== selectionGeneration.current) return;
      received = true;
      receiveNotes(contact);
      const next = { id: contact.id, e164: contact.e164, name: nameOf(contact), state: contact.state ?? undefined };
      selectedRef.current = next; setSelected(next);
      setSelectedAppointment(appointment ? { id: appointment.id, contactId: id } : null);
      setAppointmentSnapshot(appointment);
      setContactDisposition(contact.last_call_disposition ?? '');
      setDetailOpen(true); setDetailOrigin(mode); setHistoryOpen(false);
      cursor.current = { start: 0, end: 0, direction: 'none', scrollTop: 0 };
      setRecordingDetails(capture.contact?.id === id && Boolean(capture.error));
      if (store.get(id)?.status === 'error') void store.flush(id);
      setHistory([]);
      const sessions = await notesApi.list(id);
      if (mounted.current && generation === selectionGeneration.current) setHistory(sessions);
    } catch (failure) { if (mounted.current && generation === selectionGeneration.current) {
      if (!received) selectionTarget.current = detailOpen ? selectedRef.current?.id ?? null : null;
      setError(failure instanceof Error ? failure.message : 'Unable to load contact notes.');
    } }
    finally { if (mounted.current && generation === selectionGeneration.current) { selectionPending.current = false; setLoading(false); } }
  }
  function selectAppointment(appointment: WorkspaceAppointment) {
    const contactId = linkedAppointmentContact(appointment);
    if (!contactId) { setError('This appointment has no linked contact. Use Search to find their notes.'); return; }
    void selectContact(contactId, appointment);
  }
  function backToList() {
    if (selected) void store.flush(selected.id);
    ++selectionGeneration.current; ++playbackGeneration.current;
    selectionTarget.current = null; selectionPending.current = false; editorRestore.current = null; setRecordingRefreshError('');
    setLoading(false); setDetailOpen(false); setHistoryOpen(false); setRecordingDetails(false); setError(''); setAudioUrl(''); setAudioLoading(false);
    requestAnimationFrame(() => {
      const list = detailOrigin === 'contacts' ? document.querySelector<HTMLElement>('.workspace-contacts-list') : appointmentsRef.current?.querySelector<HTMLElement>('.appointments-list');
      list?.focus({ preventScroll: true });
    });
  }
  function toggleHistory() {
    setRecordingDetails(false);
    if (!historyOpen) {
      const editor = editorRef.current;
      if (editor) cursor.current = { start: editor.selectionStart, end: editor.selectionEnd, direction: editor.selectionDirection, scrollTop: editor.scrollTop };
      if (selected) void store.flush(selected.id);
      setHistoryOpen(true);
      requestAnimationFrame(() => backRef.current?.focus({ preventScroll: true }));
    } else {
      setHistoryOpen(false);
      requestAnimationFrame(() => {
        const editor = editorRef.current;
        if (!editor) return;
        editor.focus({ preventScroll: true });
        editor.setSelectionRange(cursor.current.start, cursor.current.end, cursor.current.direction);
        editor.scrollTop = cursor.current.scrollTop;
      });
    }
  }
  useEffect(() => { if (detailVisible && active) backRef.current?.focus({ preventScroll: true }); }, [detailVisible, active]);
  useEffect(() => {
    if (capture.contact?.id === selected?.id && capture.error) setRecordingDetails(true);
  }, [capture.error, capture.contact?.id, selected?.id]);
  async function changeContactDisposition(value: string) {
    if (!selected || contactDispositionBusy) return;
    const id = selected.id;
    ++dispositionVersion.current; dispositionBusyRef.current = true;
    setContactDispositionBusy(true); setError('');
    try {
      const result = await appointmentsApi.saveContactDisposition(id, value || null);
      if (mounted.current) {
        if (selectedRef.current?.id === id) setContactDisposition(result.disposition ?? '');
        if ('clientStatus' in result) setContactUpdate({ id, clientStatus: result.clientStatus ?? null, disposition: result.disposition });
      }
      appointments.refresh();
    } catch (failure) {
      if (mounted.current && selectedRef.current?.id === id) setError(failure instanceof Error ? failure.message : 'Disposition was not saved. Please retry.');
    } finally { ++dispositionVersion.current; dispositionBusyRef.current = false; if (mounted.current) setContactDispositionBusy(false); }
  }
  async function refreshHistory() {
    if (!selected || selectionPending.current || selectionTarget.current !== selected.id) return;
    const id = selected.id, generation = selectionGeneration.current;
    const current = () => mounted.current && generation === selectionGeneration.current && selectionTarget.current === id && selectedRef.current?.id === id;
    const key = `${id}:${generation}`;
    if (refreshInFlight.current === key) return;
    refreshInFlight.current = key;
    const version = dispositionVersion.current;
    try {
      const [contact, sessions] = await Promise.all([notesApi.contact(id), notesApi.list(id)]);
      if (current()) {
        receiveNotes(contact); setHistory(sessions); setRefreshError('');
        const next = { id: contact.id, e164: contact.e164, name: nameOf(contact), state: contact.state ?? undefined };
        selectedRef.current = next; setSelected(next);
        if (!dispositionBusyRef.current && version === dispositionVersion.current) setContactDisposition(contact.last_call_disposition ?? '');
      }
    } catch { if (current()) setRefreshError('Updates are temporarily unavailable. Retrying automatically.'); }
    finally { if (refreshInFlight.current === key) refreshInFlight.current = null; }
  }
  const refreshSelected = useRef(refreshHistory); refreshSelected.current = refreshHistory;
  useEffect(() => {
    if (!active || !detailVisible || !selected) return;
    const refresh = () => { if (!document.hidden) void refreshSelected.current(); };
    const timer = setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [active, detailVisible, selected?.id]);
  useEffect(() => { if (capture.phase === 'complete' && selected?.id === capture.contact?.id) void refreshHistory(); }, [capture.phase, capture.contact?.id]);
  useEffect(() => {
    if (!active || !detailVisible || !viewed || !['active', 'finalizing'].includes(viewed.status)) { setRecordingRefreshError(''); return; }
    const id = viewed.contactId, sessionId = viewed.sessionId, generation = selectionGeneration.current;
    let canceled = false, inFlight = false, failures = 0;
    let timer: ReturnType<typeof setTimeout>;
    const current = () => !canceled && mounted.current && generation === selectionGeneration.current && selectionTarget.current === id && selectedRef.current?.id === id;
    const schedule = (delay: number) => { clearTimeout(timer); if (current()) timer = setTimeout(() => { void poll(); }, delay); };
    const poll = async () => {
      if (!current() || inFlight) return;
      if (document.hidden) { schedule(30_000); return; }
      inFlight = true;
      let continuing = true;
      try {
        const next = await notesApi.get(id, sessionId);
        if (!current()) return;
        if (next.contactId !== id || next.sessionId !== sessionId) throw new Error('Recording response did not match the selected contact.');
        failures = 0; setRecordingRefreshError(''); setViewed(next);
        if (next.status === 'completed' && typeof next.notes === 'string' && Number.isSafeInteger(next.notesRevision)) receiveNotes({ contactId: id, notes: next.notes, notesRevision: next.notesRevision! });
        continuing = ['active', 'finalizing'].includes(next.status);
      } catch {
        if (current()) { failures += 1; setRecordingRefreshError('Recording updates are temporarily unavailable. Retrying automatically.'); }
      } finally {
        inFlight = false;
        // Retry transient failures automatically; cap the backoff at 30 seconds.
        if (current() && continuing) schedule(failures ? Math.min(30_000, 3000 * 2 ** Math.min(failures, 4)) : 3000);
      }
    };
    const resume = () => { if (!document.hidden) { clearTimeout(timer); void poll(); } };
    schedule(3000);
    window.addEventListener('focus', resume); document.addEventListener('visibilitychange', resume);
    return () => { canceled = true; clearTimeout(timer); window.removeEventListener('focus', resume); document.removeEventListener('visibilitychange', resume); };
  }, [active, detailVisible, viewed?.sessionId, viewed?.status, store]);
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
  const digits = (number: string) => { const raw = number.replace(/\D/g, ''); return raw.length === 10 ? `1${raw}` : raw; };
  const matchingCall = Boolean(activeCall && selected && digits(activeCall.remoteNumber) === digits(selected.e164) && (!activeCall.contactId || activeCall.contactId === selected.id));
  const otherCall = calling && ['dialing', 'ringing', 'in_call', 'held'].includes(calling.state.uiState) && calling.state.leadContext?.leadId !== String(selected?.id);
  const recordingElsewhere = Boolean(capture.contact && (!detailOpen || selected?.id !== capture.contact.id) && recording.hasUnsavedAudio());
  const shownAppointment = appointments.selectedAppointment ?? appointmentSnapshot;
  const recordingCurrent = capture.contact?.id === selected?.id;
  const captureStatus = recordingCurrent ? capture.phase === 'recording' ? `Recording · ${clock(capture.elapsedSeconds)}` : capture.phase === 'processing' ? 'Finishing AI notes…' : capture.phase === 'uploading' || capture.phase === 'stopping' ? 'Saving recorded audio…' : capture.phase === 'complete' ? 'Recording finished' : capture.phase === 'starting' ? 'Preparing recording…' : '' : '';
  const otherFailedDrafts = Object.values(drafts).filter(item => (item.contactId !== selected?.id || (!detailVisible && mode === 'contacts')) && ['error', 'conflict'].includes(item.status));
  return <div className="notes-workspace">
    {otherFailedDrafts.length > 0 && <div className="notes-draft-alert" role="alert"><span>{otherFailedDrafts.length === 1 ? "Another contact’s notes need attention. Their draft is preserved." : `${otherFailedDrafts.length} contacts have notes that need attention. Their drafts are preserved.`}</span><button onClick={() => void selectContact(otherFailedDrafts[0].contactId)}>Review notes</button></div>}
    <div className="contacts-list-host" hidden={mode !== 'contacts' || detailVisible}>
      <WorkspaceContacts active={active && mode === 'contacts' && !detailVisible} onSelect={id => void selectContact(id)} selecting={loading} selectedContactId={selected?.id} error={error} contactUpdate={contactUpdate}/>
    </div>
    <div className="notes-list-view" hidden={mode !== 'notes' || detailVisible}>
      <div className="notes-list-notices">
        {activeCall?.contactId && <button className="notes-link" disabled={loading} onClick={() => void selectContact(activeCall.contactId!)}>Use current call contact</button>}
        {loading && <p role="status" className="notes-muted">Loading contact notes…</p>}
        {!detailVisible && error && <p role="alert" className="assistant-error">{error}</p>}
        {!detailVisible && selected && draft?.error && <p role="alert" className="assistant-error">{draft.error} <button className="notes-link" onClick={() => void selectContact(selected.id, appointmentSnapshot)}>Review note draft</button></p>}
        {recordingElsewhere && <div className="notes-recording-notice"><span>Recording for {capture.contact?.name} · {clock(capture.elapsedSeconds)}</span><button onClick={() => void selectContact(capture.contact!.id)}>Open recording contact</button></div>}
      </div>
      <div className="notes-appointments-host" ref={appointmentsRef}><WorkspaceAppointments model={appointments} selecting={loading} onSelect={selectAppointment} searchControl={heading => <CollapsibleSearch id="notes-contact-search" value={query} onChange={setQuery} header={heading}>
        {searching && <p className="notes-muted" role="status">Finding contacts…</p>}
        {searchError && <p className="notes-muted" role="status">{searchError}</p>}
        {results.length > 0 && <ul className="notes-results">{results.map(contact => <li key={contact.id}><button disabled={loading} onClick={() => void selectContact(contact.id)}><strong>{workspaceContactName(contact)}</strong><span>{contact.phone}</span></button></li>)}</ul>}
        {!searching && query.trim().length >= 3 && !results.length && <p className="notes-muted">No matching contacts.</p>}
      </CollapsibleSearch>}/></div>
    </div>
    {selected && detailOpen && <div className="notes-detail-view" hidden={!detailVisible}>
      <header className="notes-detail-header">
        <button ref={backRef} className="icon-button notes-back" onClick={historyOpen ? toggleHistory : backToList} aria-label={historyOpen ? 'Back to notes' : detailOrigin === 'contacts' ? 'Back to contacts' : 'Back to appointments'} title="Back"><ChevronLeft size={21}/></button>
        <div><strong>{selected.name}</strong>{shownAppointment ? <small>{appointmentDateLabel(shownAppointment)} · {appointmentTimeSlot(shownAppointment)}</small> : <small>{workspaceContactPhone(selected.e164)}</small>}</div>
      </header>
      {error && <p role="alert" className="assistant-error notes-shared-error">{error}</p>}
      {refreshError && <p role="status" className="notes-muted notes-shared-error">{refreshError}</p>}
      {historyOpen && draft?.error && <p role="alert" className="assistant-error notes-shared-error">{draft.error} <button onClick={toggleHistory}>Review notes</button></p>}
      <div className="notes-detail-body" hidden={historyOpen}>
        {selectedAppointment ? <AppointmentDispositionControl model={appointments} appointment={appointments.selectedAppointment}/> : <div className="appointment-disposition-control">
          <select className="appointment-disposition" aria-label={`Disposition for ${selected.name}`} value={contactDisposition} disabled={contactDispositionBusy || appointments.catalogLoading || Boolean(appointments.catalogError)} onChange={event => void changeContactDisposition(event.target.value)}>
            <option value="">No Disposition</option>
            {contactDisposition && !appointments.catalog.some(option => option.name === contactDisposition) && <option value={contactDisposition}>{contactDisposition}</option>}
            {appointments.catalog.map(option => <option key={option.id} value={option.name}>{option.name}</option>)}
          </select>
          {appointments.catalogError && <p role="alert" className="assistant-error">{appointments.catalogError} <button onClick={appointments.retryCatalog}>Retry dispositions</button></p>}
        </div>}
        {recordingElsewhere && <div className="notes-recording-notice"><span>Recording for {capture.contact?.name}</span><button onClick={() => void selectContact(capture.contact!.id)}>Open recording contact</button></div>}
        {draft?.error && <p role="alert" className="assistant-error">{draft.error}{draft.status === 'error' && <button className="notes-link" onClick={() => void store.flush(selected.id)}>Retry saving notes</button>}</p>}
        {draft?.status === 'conflict' && <div className="notes-conflict"><details><summary>Review conflicting notes</summary><p>Your draft is preserved. The saved version is:</p><p className="notes-text">{draft.notes}</p></details><button onClick={() => store.resolveConflict(selected.id, 'draft')}>Keep my draft</button><button onClick={() => store.resolveConflict(selected.id, 'latest')}>Use saved notes</button></div>}
        <label className="notes-label" htmlFor="contact-notes">Notes</label>
        <div className="notes-editor-frame">
          <textarea ref={editorRef} id="contact-notes" value={draft?.draft ?? ''} disabled={!draft || loading} onChange={event => store.change(selected.id, event.target.value)} onBlur={() => void store.flush(selected.id)} placeholder="Type notes for this contact…" />
        </div>
      </div>
      <div className="contact-history-host" hidden={!historyOpen}>
        <ContactHistory key={selected.id} contactId={selected.id} active={active && detailVisible && historyOpen} refreshKey={calling?.state.uiState}/>
      </div>
      {otherCall && <p className="notes-active-call-label">Current call · {calling.state.leadContext?.leadName || calling.state.phoneNumber}</p>}
      {calling?.state.permissionError && <div className="contact-call-error" role="alert"><span>{calling.state.permissionError}</span><button onClick={calling.actions.clearPermissionError}>Dismiss</button></div>}
      <div className="notes-contact-actions" aria-label="Contact actions">
        <div className="notes-actions-left">
          <div className="notes-record-group">
            {recordingCurrent && ['starting', 'recording'].includes(capture.phase) ? <button className="notes-record-button recording-stop" aria-label="Stop and finish notes" onClick={() => void recording.stop()}><Square size={13}/>Stop</button> : <button className="notes-record-button" aria-label="Record call" title={!activeCall ? 'Connect a call for this contact to record' : 'Record this connected call'} disabled={operationBusy || loading || !matchingCall || !activeCall || !['in_call', 'held'].includes(activeCall.state) || recording.hasUnsavedAudio() || capture.phase === 'processing'} onClick={() => void run(start)}><Mic size={15}/>Record</button>}
            <button className="notes-record-options" aria-label="Recording details" title="Recording options and saved audio" aria-expanded={recordingDetails} aria-controls="notes-recording-details" onClick={() => setRecordingDetails(value => !value)}><MoreHorizontal size={13}/></button>
          </div>
          <button className="notes-history-toggle" aria-label="History" aria-pressed={historyOpen} onClick={toggleHistory}><History size={15}/>History</button>
        </div>
        <ContactCallControl contact={selected} calling={calling}/>
      </div>
      {captureStatus && <span className="notes-capture-status" role="status">{captureStatus}</span>}
          {recordingDetails && <div id="notes-recording-details" className="notes-recording-details" role="region" aria-label="Recording details">
            <section className="notes-card" aria-label="Recording options">
              <div className="notes-row"><h2>Recording</h2></div>
              <label className="notes-checkbox"><input type="checkbox" checked={retainAudio} disabled={recording.hasUnsavedAudio()} onChange={event => setRetainAudio(event.target.checked)} />Keep recording for playback</label>
              {recordingCurrent && <>
                {capture.notice && <p className="notes-muted">{capture.notice}</p>}
                {capture.error && <p className="assistant-error" role="alert">{capture.error}</p>}
                {(capture.error || capture.phase === 'error') && <div className="notes-row"><button disabled={operationBusy} onClick={() => void run(() => recording.retry())}>Retry recording work</button><button disabled={operationBusy} onClick={() => void run(() => recording.cancel())}>Cancel recording</button></div>}
              </>}
            </section>
        {job && <section className="notes-card" aria-label="AI recording notes"><div className="notes-row"><h2>{job.status === 'completed' ? 'Final AI notes' : 'Live AI draft'}</h2><small>{job.status.replace('_', ' ')}</small></div><p className="notes-text">{job.status === 'completed' ? job.summary || 'Notes added to this contact.' : job.draftNotes || 'The first live AI draft appears after roughly a minute of audio and processing.'}</p>{job.status !== 'completed' && <p className="notes-muted">Draft only. Review AI notes for accuracy; saved notes update after finalization.</p>}
          {recordingRefreshError && <p className="notes-muted" role="status">{recordingRefreshError}</p>}
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
    </div>}
  </div>;
}
