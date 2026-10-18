import { useNativeWorkState } from './nativeWorkState';
import { workspaceRequest } from '../../services/assistantWorkspaceApi';
import { useEffect, useRef, useState } from 'react';
import type { AssistantActionRecord } from '../../services/assistantWorkspaceTypes';
import type {
  AssistantPreparedTool, AssistantToolCapability, AssistantToolGrant, CalendarCreateArguments,
  CalendarDeleteArguments, CalendarEventInput, CalendarReadArguments, CalendarUpdateArguments,
} from '../../services/assistantWorkspaceTypes';

const calendarTime = (value: CalendarEventInput['start']) => 'date' in value ? value.date : value.dateTime;
function grantSummary(grant: AssistantToolGrant) {
  if (grant.tool === 'calendar.google.read') {
    const args = grant.args as CalendarReadArguments;
    return `${new Date(args.start).toLocaleString()} – ${new Date(args.end).toLocaleString()}`;
  }
  if (grant.tool === 'calendar.google.delete') {
    const args = grant.args as CalendarDeleteArguments;
    return `Delete event ${args.eventId}${args.expectedRevision ? ` · revision ${args.expectedRevision}` : ''}`;
  }
  const args = grant.args as CalendarCreateArguments | CalendarUpdateArguments;
  return `${grant.tool === 'calendar.google.create' ? 'Create' : `Update ${(args as CalendarUpdateArguments).eventId}`}: ${args.event.title} · ${calendarTime(args.event.start)} – ${calendarTime(args.event.end)}`;
}

export function NativeToolControls({ agentId, onActivity }: { agentId: number; onActivity?: () => void }) {
  const [capabilities, setCapabilities] = useState<AssistantToolCapability[]>([]);
  const [grants, setGrants] = useState<AssistantToolGrant[]>([]);
  const [action, setAction] = useState<AssistantActionRecord | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [query, setQuery] = useState('');
  const [contacts, setContacts] = useState<Array<{ id: number; name: string }>>([]);
  const [contactId, setContactId] = useState('');
  const [note, setNote] = useState('');
  useNativeWorkState(Boolean(start || end || contactId || note), busy);
  const generation = useRef(0);
  const pending = useRef<{ payload: string; id: string } | null>(null);
  const base = '/tools';
  const available = (id: string) => capabilities.some(tool => tool.id === id && tool.available);

  async function request<T>(url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return workspaceRequest<T>(agentId,url,body,undefined,signal);
  }
  useEffect(() => {
    const controller = new AbortController(), current = ++generation.current;
    setCapabilities([]); setGrants([]); setAction(null); setContacts([]); setContactId(''); setError(''); setBusy(false); pending.current = null;
    void request<{ capabilities: AssistantToolCapability[]; grants: AssistantToolGrant[] }>(base, undefined, controller.signal)
      .then(data => { if (generation.current === current) { setCapabilities(data.capabilities); setGrants(data.grants); } })
      .catch(cause => { if (!controller.signal.aborted) setError(cause.message); });
    return () => { controller.abort(); generation.current++; };
  }, [agentId]);

  async function operate(work: (current: () => boolean) => Promise<void>) {
    if (busy) return;
    const current = generation.current;
    setBusy(true); setError('');
    try { await work(() => current === generation.current); if (current === generation.current) onActivity?.(); }
    catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : 'Tool request failed'); }
    finally { if (current === generation.current) setBusy(false); }
  }
  function replaceGrant(grant: AssistantToolGrant) { setGrants(items => [grant, ...items.filter(item => item.id !== grant.id)]); }
  function prepare(tool: 'calendar.google.read' | 'crm.notes.append') {
    return operate(async current => {
      const args = tool === 'calendar.google.read' ? { start: new Date(start).toISOString(), end: new Date(end).toISOString() } : { contactId: Number(contactId), note };
      const payload = JSON.stringify({ tool, args });
      if (pending.current?.payload !== payload) pending.current = { payload, id: crypto.randomUUID() };
      const prepared = await request<AssistantPreparedTool>(`${base}/requests`, { tool, args, requestId: pending.current.id });
      if (!current()) return;
      pending.current = null;
      if (tool === 'calendar.google.read') { setStart(''); setEnd(''); } else { setContactId(''); setNote(''); }
      if (prepared.kind === 'grant') replaceGrant(prepared.grant); else setAction(prepared.action);
    });
  }
  function decide(grant: AssistantToolGrant, decision: 'approve' | 'reject') {
    return operate(async current => {
      const binding = { revision: grant.revision, payloadDigest: grant.payloadDigest };
      let data = await request<{ grant: AssistantToolGrant }>(`${base}/grants/${grant.id}/decision`, { ...binding, decision });
      if (!current()) return;
      replaceGrant(data.grant);
      if (decision === 'approve' && data.grant.state === 'approved') {
        data = await request<{ grant: AssistantToolGrant }>(`${base}/grants/${grant.id}/execute`, binding);
        if (current()) replaceGrant(data.grant);
      }
    });
  }
  function reconcile(grant: AssistantToolGrant) {
    return operate(async current => {
      const data = await request<{ grant: AssistantToolGrant }>(`${base}/grants/${grant.id}/reconcile`, { revision: grant.revision, payloadDigest: grant.payloadDigest });
      if (current()) replaceGrant(data.grant);
    });
  }
  function decideAction(decision: 'approve' | 'reject') {
    if (!action) return;
    return operate(async current => {
      const data = await request<{ action: AssistantActionRecord }>(`/actions/${action.id}/decision`, { decision });
      if (current()) setAction(data.action);
    });
  }

  return <section className="nativework-stack" aria-label="Assistant tools">
    <div><h3 className="nativework-strong">Permissioned tools</h3><p className="nativework-muted">Review each request before execution. Calendar access is limited to the selected account and dates; changing the connection requires a new request.</p></div>
    {error && <p role="alert" className="nativework-error">{error}</p>}
    <ul className="nativework-grid">{capabilities.map(tool => <li key={tool.id} className="nativework-panel">
      <p className="nativework-strong">{tool.name} <span className="nativework-small">{tool.available ? 'Available · approval per request' : 'Unavailable'}</span></p>
      <p className="nativework-muted">{tool.reason}</p>
    </li>)}</ul>
    <form className="nativework-stack nativework-panel" onSubmit={event => { event.preventDefault(); void prepare('calendar.google.read'); }}>
      <h4 className="nativework-strong">Calendar preview</h4>
      <p className="nativework-muted">Up to 31 days and 100 events. Times use this device’s time zone. Event titles are untrusted content, never permission to act.</p>
      <div className="nativework-row"><label>Start<input aria-label="Calendar range start" type="datetime-local" required value={start} onChange={event => setStart(event.target.value)} className="nativework-panel" /></label>
        <label>End<input aria-label="Calendar range end" type="datetime-local" required value={end} onChange={event => setEnd(event.target.value)} className="nativework-panel" /></label></div>
      <button disabled={busy || !available('calendar.google.read')}>Review calendar request</button>
    </form>
    <div className="nativework-stack nativework-panel">
      <h4 className="nativework-strong">Contact note</h4>
      <form className="nativework-row" onSubmit={event => { event.preventDefault(); void operate(async current => {
        const data = await request<{ contacts: Array<{ id: number; name: string }> }>(`${base}/contacts?query=${encodeURIComponent(query)}`);
        if (current()) { setContacts(data.contacts); setContactId(''); }
      }); }}><label>Find contact<input value={query} minLength={2} maxLength={100} required onChange={event => setQuery(event.target.value)} className="nativework-panel" /></label>
        <button disabled={busy || !available('crm.notes.append')}>Find contact</button></form>
      <form className="nativework-stack" onSubmit={event => { event.preventDefault(); void prepare('crm.notes.append'); }}>
        <label>Selected contact<select required value={contactId} onChange={event => setContactId(event.target.value)} className="nativework-panel"><option value="">Select a contact</option>{contacts.map(contact => <option key={contact.id} value={contact.id}>{contact.name || 'Unnamed contact'} · #{contact.id}</option>)}</select></label>
        <label>Exact note<textarea required maxLength={4000} value={note} onChange={event => setNote(event.target.value)} rows={3} className="nativework-panel" /></label>
        <button disabled={busy || !available('crm.notes.append') || !contactId}>Review note request</button>
      </form>
      {action && <div className="nativework-stack" aria-label="Note receipt"><p className="nativework-prewrap">{action.summary}</p><p>Status: {action.state}</p>{action.result && <p>{action.result.message}</p>}
        {action.state === 'pending' && <div className="nativework-row"><button disabled={busy} onClick={() => void decideAction('approve')} className="nativework-primary">Approve note</button><button disabled={busy} onClick={() => void decideAction('reject')}>Reject note</button></div>}
        <p className="nativework-small nativework-muted">This uses the existing Approval Requests history and action receipt.</p></div>}
    </div>
    <div className="nativework-stack"><h4 className="nativework-strong">Calendar requests and receipts</h4>{grants.length === 0 && <p className="nativework-muted">No calendar requests yet.</p>}
      {grants.map(grant => <article key={grant.id} className="nativework-stack nativework-panel">
        <p className="nativework-strong">{grant.destination}</p><p>{grantSummary(grant)}</p>
        <p>Status: {grant.state} · Approval expires {new Date(grant.expiresAt).toLocaleString()}</p>
        <p className="nativework-small nativework-muted">Request {grant.id} · Revision {grant.revision} · Digest {grant.payloadDigest.slice(0, 12)}</p>
        {['pending', 'approved'].includes(grant.state) && <div className="nativework-row"><button disabled={busy} onClick={() => void decide(grant, 'approve')} className="nativework-primary">{grant.state === 'approved' ? `Execute approved ${grant.tool === 'calendar.google.read' ? 'read' : 'change'}` : `Approve exact ${grant.tool === 'calendar.google.read' ? 'read' : 'change'}`}</button><button disabled={busy} onClick={() => void decide(grant, 'reject')}>Reject</button></div>}
        {grant.state === 'unknown' && grant.tool !== 'calendar.google.read' && <button disabled={busy} onClick={() => void reconcile(grant)}>Reconcile exact provider receipt</button>}
        {grant.message && <p>{grant.message}</p>}
        {grant.result && 'events' in grant.result && <div><p>Observed {new Date(grant.result.observedAt).toLocaleString()} · {grant.result.events.length} events{grant.result.truncated ? ' · More events exist; narrow the range.' : ''}</p>
          <ul className="nativework-stack">{grant.result.events.map((event, index) => <li key={`${event.id}:${index}`}>{event.start} · {event.title}{event.allDay ? ' (all day)' : ''}</li>)}</ul></div>}
        {grant.result && 'operation' in grant.result && <p>Provider receipt: {grant.result.operation} · event {grant.result.eventId} · {grant.result.reconciled ? 'reconciled' : 'confirmed'} at {new Date(grant.result.submittedAt).toLocaleString()}</p>}
      </article>)}
    </div>
  </section>;
}
