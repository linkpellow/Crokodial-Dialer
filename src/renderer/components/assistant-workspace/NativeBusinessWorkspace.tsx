import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiRequest, platformUrl } from '../../services/assistantApiService';
import { decideWorkspaceAction, workspaceRequest } from '../../services/assistantWorkspaceApi';
import type { AssistantActionRecord } from '../../services/assistantWorkspaceTypes';
import { useNativeWorkState } from './nativeWorkState';

type CalendarProvider = 'google' | 'calendly';
type Connection = { connected: boolean; syncEnabled: boolean; accountName?: string | null; accountEmail?: string | null; status?: string | null; error?: string | null; desktopConnect?: { method: 'POST'; path: string } };
type Status = { calendly: Connection; google: Connection };
type CalendarConnection = { provider: CalendarProvider; authorizationUrl: string; expiresAt: string; oauthScopes: string[] };
type EventType = { uri: string; name: string; duration: number; active: boolean };
type Slot = { startsAt: string; endsAt: string; timezone?: string };
type Availability = { slots: Slot[]; timezone?: string; source?: string };
type Contact = { id: number; name: string; phone: string | null; email: string | null; city: string | null; state: string | null; clientStatus: string | null; updatedAt: string | null };
type Duplicate = { key: string; reasons: Array<'email' | 'phone' | 'name'>; contacts: Contact[] };
type SalesReport = {
  source: 'crokodial_crm'; scope: 'tenant'; start: string; end: string; newClientRecords: number; distinctClientContacts: number;
  activeClientRecords: number; appointments: { total: number; scheduled: number; confirmed: number; completed: number; noShow: number; cancelled: number };
  daily: Array<{ date: string; clientRecords: number }>; averageClientRecordsPerActiveDay: number; longestDailyStreak: number; premiumAvailable: false; observedAt: number;
};

const localInput = (offsetDays: number, hour = 9) => {
  const date = new Date(); date.setDate(date.getDate() + offsetDays); date.setHours(hour, 0, 0, 0);
  const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return shifted.toISOString().slice(0, 16);
};
const iso = (value: string) => new Date(value).toISOString();
const label = (value: string) => new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const emptyContact = { phone: '', firstName: '', lastName: '', email: '', city: '', state: '' };

/** Native controls for the same owner-scoped tools available to the permanent assistant conversation. */
export function NativeBusinessWorkspace({ agentId, onActivity }: { agentId: number; onActivity?: () => void }) {
  const [status, setStatus] = useState<Status>();
  const [eventTypes, setEventTypes] = useState<EventType[]>([]), [eventType, setEventType] = useState('');
  const [from, setFrom] = useState(() => localInput(1)), [to, setTo] = useState(() => localInput(8));
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone), [availability, setAvailability] = useState<Availability>();
  const [query, setQuery] = useState(''), [contacts, setContacts] = useState<Contact[]>([]), [selected, setSelected] = useState<Contact>();
  const [create, setCreate] = useState(emptyContact), [patch, setPatch] = useState(emptyContact);
  const [duplicates, setDuplicates] = useState<Duplicate[]>(), [report, setReport] = useState<SalesReport>();
  const [reportFrom, setReportFrom] = useState(() => localInput(-30, 0).slice(0, 10)), [reportTo, setReportTo] = useState(() => localInput(1, 0).slice(0, 10));
  const [pending, setPending] = useState<AssistantActionRecord>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState<CalendarProvider>(), [waiting, setWaiting] = useState<CalendarProvider>();
  const alive = useRef(true), controller = useRef<AbortController>(), requestIds = useRef(new Map<string, string>()), waitingRef = useRef<CalendarProvider>();
  const dirty = useMemo(() => Object.values(create).some(Boolean) || Object.values(patch).some(Boolean), [create, patch]);
  useNativeWorkState(dirty, busy);
  const requestId = (key: string) => { const found = requestIds.current.get(key); if (found) return found; const value = crypto.randomUUID(); requestIds.current.set(key, value); return value; };
  const api = useCallback(<T,>(path: string, body?: unknown, method?: string) => workspaceRequest<T>(agentId, `/business${path}`, body, method, controller.current?.signal), [agentId]);
  async function run<T>(work: () => Promise<T>, accept?: (value: T) => void) {
    setBusy(true); setError('');
    try { const value = await work(); if (alive.current) accept?.(value); return value; }
    catch (cause) { if (alive.current && !(cause instanceof DOMException && cause.name === 'AbortError')) setError(cause instanceof Error ? cause.message : 'The business workspace request failed.'); }
    finally { if (alive.current) setBusy(false); }
  }
  const loadScheduling = useCallback(async () => {
    const value = await api<Status>('/scheduling/status');
    let available: EventType[] = [];
    if (value.calendly.connected && value.calendly.syncEnabled) available = (await api<{ eventTypes: EventType[] }>('/scheduling/event-types')).eventTypes;
    if (alive.current) {
      setStatus(value); setEventTypes(available); setEventType(current => available.some(item => item.uri === current) ? current : available[0]?.uri ?? '');
      const pendingProvider = waitingRef.current;
      if ((pendingProvider === 'google' && value.google.connected)
        || (pendingProvider === 'calendly' && value.calendly.connected && value.calendly.syncEnabled)) {
        waitingRef.current = undefined;
        setWaiting(undefined);
      }
    }
    return value;
  }, [api]);
  useEffect(() => {
    alive.current = true; controller.current = new AbortController();
    setBusy(true); setError('');
    void loadScheduling()
      .catch(cause => { if (alive.current && !(cause instanceof DOMException && cause.name === 'AbortError')) setError(cause instanceof Error ? cause.message : 'Could not load calendar connections.'); })
      .finally(() => { if (alive.current) setBusy(false); });
    return () => { alive.current = false; controller.current?.abort(); };
  }, [loadScheduling]);
  useEffect(() => {
    if (!waiting) return;
    const refresh = () => { if (!document.hidden) void loadScheduling().catch(cause => { if (alive.current) setError(cause instanceof Error ? cause.message : 'Could not refresh calendar connections.'); }); };
    const timer = setInterval(refresh, 5000); window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [waiting, loadScheduling]);
  async function connectCalendar(provider: CalendarProvider) {
    if (connecting || busy) return;
    setConnecting(provider); setError('');
    try {
      if (!window.dialer?.openExternal) throw new Error('Open the calendar connection from Crokodial Workspace.');
      const endpoint = provider === 'google' ? '/api/auth/google/calendar/desktop/connect' : '/api/calendly/oauth/desktop/connect';
      const expectedPath = provider === 'google' ? '/api/auth/google/calendar/desktop/authorize' : '/api/calendly/oauth/desktop/authorize';
      const connection = await apiRequest<CalendarConnection>(endpoint, { method: 'POST', body: '{}' });
      const origin = new URL(platformUrl('/')), url = new URL(connection.authorizationUrl, origin);
      if (connection.provider !== provider || url.origin !== origin.origin || url.pathname !== expectedPath || url.username || url.password || url.hash
        || !url.searchParams.get('ticket') || url.searchParams.getAll('ticket').length !== 1 || [...url.searchParams.keys()].some(key => key !== 'ticket')
        || !Number.isFinite(Date.parse(connection.expiresAt)) || Date.parse(connection.expiresAt) <= Date.now()) throw new Error('The calendar connection link is unavailable. Please try again.');
      await window.dialer.openExternal(url.href);
      if (alive.current) { waitingRef.current = provider; setWaiting(provider); void loadScheduling(); }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Could not open the calendar connection.'); }
    finally { if (alive.current) setConnecting(undefined); }
  }
  async function findContacts() {
    if (query.trim().length < 2) { setError('Enter at least two characters to search contacts.'); return; }
    await run(() => api<{ contacts: Contact[] }>(`/contacts?query=${encodeURIComponent(query.trim())}`), value => setContacts(value.contacts));
  }
  async function prepareCreate() {
    const contact = Object.fromEntries(Object.entries(create).filter(([, value]) => value.trim()).map(([key, value]) => [key, value.trim()]));
    const key = `contact.create:${JSON.stringify(contact)}`;
    const result = await run(() => api<{ action: AssistantActionRecord }>('/contacts/actions', { operation: 'create', requestId: requestId(key), contact }));
    if (result) { requestIds.current.delete(key); setPending(result.action); setCreate(emptyContact); onActivity?.(); }
  }
  async function prepareUpdate() {
    if (!selected) return;
    const values = Object.fromEntries(Object.entries(patch).filter(([, value]) => value.trim()).map(([key, value]) => [key, value.trim()]));
    if (!Object.keys(values).length) { setError('Enter at least one changed value.'); return; }
    const key = `contact.update:${selected.id}:${JSON.stringify(values)}`;
    const result = await run(() => api<{ action: AssistantActionRecord }>('/contacts/actions', { operation: 'update', requestId: requestId(key), contactId: selected.id, patch: values }));
    if (result) { requestIds.current.delete(key); setPending(result.action); setPatch(emptyContact); onActivity?.(); }
  }
  async function decide(decision: 'approve' | 'reject') {
    if (!pending) return;
    const result = await run(() => decideWorkspaceAction(agentId, pending.id, decision));
    if (result) { setPending(result.action); onActivity?.(); }
  }
  const contactFields = (state: typeof emptyContact, set: (value: typeof emptyContact) => void, requirePhone: boolean) => <div className="nativework-grid">
    <label>Phone<input required={requirePhone} value={state.phone} onChange={event => set({ ...state, phone: event.target.value })}/></label>
    <label>First name<input value={state.firstName} onChange={event => set({ ...state, firstName: event.target.value })}/></label>
    <label>Last name<input value={state.lastName} onChange={event => set({ ...state, lastName: event.target.value })}/></label>
    <label>Email<input type="email" value={state.email} onChange={event => set({ ...state, email: event.target.value })}/></label>
    <label>City<input value={state.city} onChange={event => set({ ...state, city: event.target.value })}/></label>
    <label>State<input value={state.state} onChange={event => set({ ...state, state: event.target.value })}/></label>
  </div>;
  return <section className="nativework-stack" aria-label="Scheduling, contacts and reports">
    {error && <p className="nativework-error" role="alert">{error}</p>}
    <details className="nativework-panel" open>
      <summary>Scheduling and Calendly</summary>
      {status && <p className="nativework-muted">Calendly: {status.calendly.connected && status.calendly.syncEnabled ? `connected${status.calendly.accountEmail ? ` as ${status.calendly.accountEmail}` : ''}` : status.calendly.connected ? 'connected; initial sync is still pending' : 'not connected'} · Google Calendar: {status.google.connected ? 'connected' : 'not connected'}</p>}
      <div className="nativework-row">
        {status && !status.google.connected && <button type="button" disabled={busy || Boolean(connecting)} onClick={() => void connectCalendar('google')}>{connecting === 'google' ? 'Opening Google…' : 'Connect Google Calendar'}</button>}
        {status && (!status.calendly.connected || !status.calendly.syncEnabled) && <button type="button" disabled={busy || Boolean(connecting)} onClick={() => void connectCalendar('calendly')}>{connecting === 'calendly' ? 'Opening Calendly…' : 'Connect Calendly'}</button>}
        <button type="button" disabled={busy || Boolean(connecting)} onClick={() => void run(loadScheduling)}>Check connections</button>
      </div>
      {waiting && <p role="status">Finish {waiting === 'google' ? 'Google Calendar' : 'Calendly'} consent in your browser, then return here. This chat stays open and no appointment is changed by connecting.</p>}
      <div className="nativework-grid"><label>From<input type="datetime-local" value={from} onChange={event => setFrom(event.target.value)}/></label><label>To<input type="datetime-local" value={to} onChange={event => setTo(event.target.value)}/></label><label>Timezone<input value={timezone} onChange={event => setTimezone(event.target.value)}/></label></div>
      <button type="button" disabled={busy || !from || !to} onClick={() => void run(() => api<Availability>(`/scheduling/availability?start=${encodeURIComponent(iso(from))}&end=${encodeURIComponent(iso(to))}&timezone=${encodeURIComponent(timezone)}&limit=16`), setAvailability)}>Check live availability</button>
      {availability && (availability.slots.length ? <ul>{availability.slots.map(slot => <li key={`${slot.startsAt}:${slot.endsAt}`}>{label(slot.startsAt)}–{new Date(slot.endsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</li>)}</ul> : <p>No open slots were returned for this range.</p>)}
      {!!eventTypes.length && <div className="nativework-stack"><label>Calendly event type<select value={eventType} onChange={event => setEventType(event.target.value)}>{eventTypes.map(item => <option key={item.uri} value={item.uri}>{item.name} · {item.duration} minutes</option>)}</select></label>
        <button type="button" disabled={busy || !eventType} onClick={() => { const key = `link:${eventType}`; void run(() => api<{ action: AssistantActionRecord }>('/scheduling/booking-links', { requestId: requestId(key), eventTypeUri: eventType }), value => { requestIds.current.delete(key); setPending(value.action); onActivity?.(); }); }}>Prepare one-use booking link</button></div>}
    </details>
    <details className="nativework-panel">
      <summary>Contacts</summary>
      <div className="nativework-row"><label>Search contacts<input value={query} onChange={event => setQuery(event.target.value)}/></label><button type="button" disabled={busy || query.trim().length < 2} onClick={() => void findContacts()}>Search</button></div>
      {!!contacts.length && <ul>{contacts.map(contact => <li key={contact.id}><button type="button" onClick={() => { setSelected(contact); setPatch(emptyContact); }}>{contact.name}</button> · {contact.phone ?? 'no phone'} · {contact.email ?? 'no email'}</li>)}</ul>}
      {selected && <form className="nativework-stack" onSubmit={event => { event.preventDefault(); void prepareUpdate(); }}><strong>Prepare changes to {selected.name}</strong>{contactFields(patch, setPatch, false)}<button disabled={busy}>Review exact contact update</button></form>}
      <form className="nativework-stack" onSubmit={event => { event.preventDefault(); void prepareCreate(); }}><strong>Create a contact</strong>{contactFields(create, setCreate, true)}<button disabled={busy}>Review exact new contact</button></form>
      <button type="button" disabled={busy} onClick={() => void run(() => api<{ candidates: Duplicate[] }>('/contacts/duplicates'), value => setDuplicates(value.candidates))}>Review possible duplicates</button>
      {duplicates && (duplicates.length ? <ul>{duplicates.map(group => <li key={group.key}><strong>{group.reasons.join(' and ')} match</strong>: {group.contacts.map(item => `${item.name} (#${item.id})`).join(', ')}</li>)}</ul> : <p>No likely duplicates were found in the bounded review.</p>)}
    </details>
    <details className="nativework-panel">
      <summary>Sales report</summary>
      <div className="nativework-row"><label>Start<input type="date" value={reportFrom} onChange={event => setReportFrom(event.target.value)}/></label><label>End<input type="date" value={reportTo} onChange={event => setReportTo(event.target.value)}/></label><button type="button" disabled={busy || !reportFrom || !reportTo} onClick={() => void run(() => api<{ report: SalesReport }>(`/reports/sales?start=${encodeURIComponent(new Date(`${reportFrom}T00:00:00`).toISOString())}&end=${encodeURIComponent(new Date(`${reportTo}T00:00:00`).toISOString())}`), value => setReport(value.report))}>Generate report</button></div>
      {report && <div><p><strong>{report.newClientRecords}</strong> new client records · <strong>{report.distinctClientContacts}</strong> distinct contacts · <strong>{report.longestDailyStreak}</strong> day longest streak</p><p>{report.appointments.total} appointments: {report.appointments.completed} completed, {report.appointments.scheduled + report.appointments.confirmed} upcoming, {report.appointments.noShow} no-show, {report.appointments.cancelled} canceled.</p><p className="nativework-small nativework-muted">Source: live tenant-scoped Crokodial CRM records. Premium totals are unavailable until a premium source is connected.</p></div>}
    </details>
    {pending && <section className="nativework-panel" aria-label="Exact action review"><h3>{pending.state === 'pending' ? 'Review exact action' : 'Action receipt'}</h3><pre className="nativework-prewrap">{pending.summary}</pre>{pending.result?.message && <p role="status">{pending.result.message}</p>}{pending.state === 'pending' && <div className="nativework-row"><button type="button" disabled={busy} onClick={() => void decide('approve')}>Approve exact action</button><button type="button" disabled={busy} onClick={() => void decide('reject')}>Reject</button></div>}</section>}
  </section>;
}
