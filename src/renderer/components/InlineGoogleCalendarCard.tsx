import { useEffect, useMemo, useState } from 'react';
import {
  listAssistantTools, prepareAssistantTool, decideToolGrant, executeToolGrant, reconcileToolGrant,
  type AssistantToolCapability, type AssistantToolGrant, type CalendarCreateArguments, type CalendarDeleteArguments,
  type CalendarEventInput, type CalendarEventSnapshot, type CalendarToolId, type CalendarUpdateArguments,
} from '../services/assistantWorkspaceApi';
import { calendarRequestUuid, parseCalendarChatRequest, type CalendarChatRequest } from '../services/calendarChatRequest';

type CalendarTool = CalendarToolId;
type CalendarEvent = CalendarEventSnapshot;
type CalendarGrant = AssistantToolGrant;
type Capability = AssistantToolCapability;

const localValue = (value?: string) => {
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  const date = new Date(value), shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return shifted.toISOString().slice(0, 16);
};
const exactIso = (value: string) => new Date(value).toISOString();
const eventLabel = (event: CalendarEvent) => `${event.start || 'Start unavailable'} · ${event.title || '(Untitled)'}`;
const toolFor = (mode: CalendarChatRequest['mode']): CalendarTool => `calendar.google.${mode}` as CalendarTool;
const eventTime = (value: CalendarEventInput['start']) => 'date' in value ? value.date : value.dateTime;

function exactArgs(grant: CalendarGrant): string {
  if (grant.tool === 'calendar.google.read') {
    const args = grant.args as { start: string; end: string };
    return `${args.start} – ${args.end}`;
  }
  if (grant.tool === 'calendar.google.delete') {
    const args = grant.args as CalendarDeleteArguments;
    return [`Delete event ${args.eventId}`, args.expectedRevision ? `Reviewed revision: ${args.expectedRevision}` : '',
      `Guest notifications: ${args.sendUpdates ?? 'none'}`].filter(Boolean).join('\n');
  }
  const args = grant.args as CalendarCreateArguments | CalendarUpdateArguments, event = args.event;
  return [grant.tool === 'calendar.google.create' ? `Create “${event.title}”` : `Update event ${(args as CalendarUpdateArguments).eventId} to “${event.title}”`,
    `${eventTime(event.start)} – ${eventTime(event.end)}`,
    grant.tool === 'calendar.google.update' && (args as CalendarUpdateArguments).expectedRevision ? `Reviewed revision: ${(args as CalendarUpdateArguments).expectedRevision}` : '',
    event.location ? `Location: ${event.location}` : '', event.attendees?.length ? `Attendees: ${event.attendees.join(', ')}` : '',
    event.description ? `Description: ${event.description}` : '', `Guest notifications: ${event.sendUpdates ?? 'none'}`].filter(Boolean).join('\n');
}

function CalendarGrantCard({ grant, busy, onDecision, onEdit, onDelete, onReconcile }: {
  grant: CalendarGrant; busy: boolean; onDecision: (grant: CalendarGrant, decision: 'approve' | 'reject') => void;
  onEdit: (event: CalendarEvent) => void; onDelete: (event: CalendarEvent) => void; onReconcile: (grant: CalendarGrant) => void;
}) {
  const events = grant.result && 'events' in grant.result ? grant.result.events : grant.result?.event ? [grant.result.event] : [];
  const resultAt = grant.result && ('observedAt' in grant.result ? grant.result.observedAt : grant.result.submittedAt);
  return <section className="assistant-inline-mac-review" aria-label="Exact Google Calendar review">
    <strong>{grant.tool === 'calendar.google.read' ? 'Exact calendar read review' : 'Exact calendar change review'}</strong>
    <p className="assistant-inline-mac-exact">{exactArgs(grant)}</p>
    <p className="assistant-inline-mac-meta">{grant.destination} · expires {new Date(grant.expiresAt).toLocaleString()} · digest {grant.payloadDigest.slice(0, 12)}</p>
    <p>Status: {grant.state.replace(/_/g, ' ')}</p>
    {grant.message && <p role="status">{grant.message}</p>}
    {['pending', 'approved'].includes(grant.state) && <div className="assistant-card-buttons"><button type="button" disabled={busy} onClick={() => onDecision(grant, 'approve')}>{grant.state === 'approved' ? 'Execute exact request' : grant.tool === 'calendar.google.read' ? 'Approve and read' : 'Approve exact calendar change'}</button><button type="button" disabled={busy} onClick={() => onDecision(grant, 'reject')}>Reject</button></div>}
    {grant.state === 'unknown' && <><p className="assistant-inline-mac-warning">The provider outcome is unresolved. Crokodial will inspect this exact event before allowing another write; it will not blindly replay the request.</p><button type="button" disabled={busy} onClick={() => onReconcile(grant)}>Reconcile exact provider receipt</button></>}
    {resultAt && <p className="assistant-inline-mac-meta">Observed {new Date(resultAt).toLocaleString()}{grant.result && 'truncated' in grant.result && grant.result.truncated ? ' · more events exist; narrow the range' : ''}</p>}
    {!!events.length && <ul>{events.map(event => <li key={event.id}><strong>{eventLabel(event)}</strong>{event.location && <><br/><span>{event.location}</span></>}<div className="assistant-card-buttons"><button type="button" disabled={busy || event.status === 'cancelled'} onClick={() => onEdit(event)}>Prepare exact update</button><button type="button" disabled={busy || event.status === 'cancelled'} onClick={() => onDelete(event)}>Prepare exact deletion</button></div></li>)}</ul>}
  </section>;
}

/** A calendar workflow reconstructed beside one saved turn in the permanent chat. */
export function InlineGoogleCalendarCard({ turnId, requestId, persisted = true, text, agentId, onPendingStateChange, onActivity }: {
  turnId: string; requestId?: string; persisted?: boolean; text: string; agentId?: number;
  onPendingStateChange?: (turnId: string, state: { dirty: boolean; busy: boolean }) => void; onActivity?: () => void;
}) {
  const parsed = useMemo(() => parseCalendarChatRequest(text), [text]);
  if (!parsed || !agentId) return null;
  return <ResolvedCalendarCard turnId={turnId} requestId={requestId} persisted={persisted} parsed={parsed} agentId={agentId} onPendingStateChange={onPendingStateChange} onActivity={onActivity}/>;
}

function ResolvedCalendarCard({ turnId, requestId, persisted, parsed, agentId, onPendingStateChange, onActivity }: {
  turnId: string; requestId?: string; persisted: boolean; parsed: CalendarChatRequest; agentId: number;
  onPendingStateChange?: (turnId: string, state: { dirty: boolean; busy: boolean }) => void; onActivity?: () => void;
}) {
  const [capabilities, setCapabilities] = useState<Capability[]>([]), [grants, setGrants] = useState<CalendarGrant[]>([]);
  const [mode, setMode] = useState(parsed.mode), [eventId, setEventId] = useState(parsed.eventId ?? '');
  const [expectedRevision, setExpectedRevision] = useState('');
  const [summary, setSummary] = useState(parsed.summary ?? ''), [start, setStart] = useState(localValue(parsed.start)), [end, setEnd] = useState(localValue(parsed.end));
  const [description, setDescription] = useState(''), [location, setLocation] = useState(''), [attendees, setAttendees] = useState('');
  const [sendUpdates, setSendUpdates] = useState<'none' | 'all' | 'externalOnly'>('none');
  const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const initialTool = toolFor(parsed.mode);
  const requestSeed = (tool: CalendarTool, exactEventId = eventId) =>
    `${requestId ?? turnId}:${tool}:${tool === 'calendar.google.update' || tool === 'calendar.google.delete' ? exactEventId.trim() : parsed.mode}`;
  const origin = requestSeed(initialTool, parsed.eventId ?? '');
  const available = (tool: CalendarTool) => capabilities.some(item => item.id === tool && item.available);

  useEffect(() => { onPendingStateChange?.(turnId, { dirty, busy }); }, [turnId, dirty, busy, onPendingStateChange]);
  useEffect(() => () => onPendingStateChange?.(turnId, { dirty: false, busy: false }), [turnId, onPendingStateChange]);
  useEffect(() => {
    let current = true;
    void Promise.all([listAssistantTools(agentId), calendarRequestUuid(origin)]).then(async ([data, stableId]) => {
      if (!current) return;
      setCapabilities(data.capabilities);
      const initial = data.grants.filter(grant => grant.requestKey === stableId);
      const eventIds = [...new Set(initial.flatMap(grant => grant.result && 'events' in grant.result
        ? grant.result.events.map(event => event.id) : grant.result?.event ? [grant.result.event.id] : []))];
      const relatedKeys = new Set([stableId, ...(await Promise.all(eventIds.flatMap(id => [
        calendarRequestUuid(requestSeed('calendar.google.update', id)),
        calendarRequestUuid(requestSeed('calendar.google.delete', id)),
      ])))]);
      if (current) setGrants(data.grants.filter(grant => relatedKeys.has(grant.requestKey)));
    }).catch(cause => { if (current) setError(cause instanceof Error ? cause.message : 'Could not restore Calendar requests.'); });
    return () => { current = false; };
  }, [agentId, origin]);

  async function operate(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError('');
    try { await work(); onActivity?.(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The Calendar request failed.'); }
    finally { setBusy(false); }
  }
  const replace = (grant: CalendarGrant) => setGrants(items => [grant, ...items.filter(item => item.id !== grant.id)]);
  function argsFor(tool: CalendarTool) {
    if (tool === 'calendar.google.read') return { start: exactIso(start), end: exactIso(end) };
    if (tool === 'calendar.google.delete') return { eventId: eventId.trim(), ...(expectedRevision ? { expectedRevision } : {}), sendUpdates };
    const emails = attendees.split(/[\s,;]+/).map(value => value.trim().toLowerCase()).filter(Boolean);
    const event: CalendarEventInput = { title: summary.trim(), start: { dateTime: exactIso(start) }, end: { dateTime: exactIso(end) },
      description: description.trim(), location: location.trim(), attendees: emails, sendUpdates };
    return tool === 'calendar.google.update'
      ? { eventId: eventId.trim(), ...(expectedRevision ? { expectedRevision } : {}), event }
      : { event };
  }
  function prepare(tool = toolFor(mode)) {
    if (!persisted) { setError('Wait for this request to be saved in the permanent conversation before creating a Calendar review.'); return; }
    void operate(async () => {
      const stableId = await calendarRequestUuid(requestSeed(tool));
      const prepared = await prepareAssistantTool(agentId, { tool, requestId: stableId, args: argsFor(tool) } as Parameters<typeof prepareAssistantTool>[1]);
      if (prepared.kind !== 'grant') throw new Error('The Calendar request returned an unexpected action.');
      replace(prepared.grant);
      setDirty(false);
    });
  }
  function decide(grant: CalendarGrant, decision: 'approve' | 'reject') {
    void operate(async () => {
      let value = await decideToolGrant(agentId, grant, decision);
      replace(value.grant);
      if (decision === 'approve' && value.grant.state === 'approved') {
        value = await executeToolGrant(agentId, value.grant);
        replace(value.grant);
      }
    });
  }
  function reconcile(grant: CalendarGrant) {
    void operate(async () => replace((await reconcileToolGrant(agentId, grant)).grant));
  }
  function edit(event: CalendarEvent) {
    setMode('update'); setEventId(event.id); setSummary(event.title); setStart(localValue(event.start)); setEnd(localValue(event.end));
    setExpectedRevision(event.revision); setDescription(event.description); setLocation(event.location); setAttendees(event.attendeeEmails.join(', '));
    setDirty(true);
  }
  function remove(event: CalendarEvent) {
    setMode('delete'); setEventId(event.id); setExpectedRevision(event.revision); setSummary(event.title); setDirty(true);
  }
  const tool = toolFor(mode);

  return <article className="assistant-work-card assistant-inline-mac" aria-label="Google Calendar request for saved message" data-turn-id={turnId}>
    <div className="assistant-card-heading"><strong>Google Calendar</strong><span>Exact review</span></div>
    <p>This request stays in the permanent chat. Reading is bounded; create, update, and delete require a separate exact approval tied to the connected Calendar account.</p>
    {parsed.needsClarification && <p className="assistant-inline-mac-warning">{parsed.needsClarification}</p>}
    {!persisted && <p className="assistant-inline-mac-warning">Wait for this message to be saved before preparing an external action.</p>}
    {error && <p className="assistant-error" role="alert">{error}</p>}
    {!available(tool) && <p className="assistant-inline-mac-meta">{capabilities.find(item => item.id === tool)?.reason ?? 'Checking the connected Google Calendar…'}</p>}
    {mode === 'read' ? <form className="nativework-stack" onSubmit={event => { event.preventDefault(); prepare(); }}><label>Start<input aria-label="Inline Calendar start" type="datetime-local" required value={start} onChange={event => { setStart(event.target.value); setDirty(true); }}/></label><label>End<input aria-label="Inline Calendar end" type="datetime-local" required value={end} onChange={event => { setEnd(event.target.value); setDirty(true); }}/></label><button disabled={busy || !persisted || !available(tool)}>Review exact date range</button></form>
      : mode === 'delete' ? <form className="nativework-stack" onSubmit={event => { event.preventDefault(); prepare(); }}><label>Exact Google event ID<input aria-label="Calendar event ID" required minLength={5} maxLength={1024} value={eventId} onChange={event => { setEventId(event.target.value); setDirty(true); }}/></label>{summary && <p>Event: {summary}</p>}<label>Guest cancellation notifications<select aria-label="Calendar guest notifications" value={sendUpdates} onChange={event => { setSendUpdates(event.target.value as typeof sendUpdates); setDirty(true); }}><option value="none">Do not send updates</option><option value="all">Notify all guests</option><option value="externalOnly">Notify guests outside this Google organization</option></select></label><button disabled={busy || !persisted || !available(tool)}>Review exact deletion</button></form>
      : <form className="nativework-stack" onSubmit={event => { event.preventDefault(); prepare(); }}>{mode === 'update' && <label>Exact Google event ID<input aria-label="Calendar event ID" required minLength={5} maxLength={1024} value={eventId} onChange={event => { setEventId(event.target.value); setDirty(true); }}/></label>}<label>Title<input aria-label="Calendar event title" required maxLength={500} value={summary} onChange={event => { setSummary(event.target.value); setDirty(true); }}/></label><label>Start<input aria-label="Inline Calendar start" type="datetime-local" required value={start} onChange={event => { setStart(event.target.value); setDirty(true); }}/></label><label>End<input aria-label="Inline Calendar end" type="datetime-local" required value={end} onChange={event => { setEnd(event.target.value); setDirty(true); }}/></label><label>Location<input maxLength={1000} value={location} onChange={event => { setLocation(event.target.value); setDirty(true); }}/></label><label>Attendee emails<input aria-label="Calendar attendee emails" placeholder="one@example.com, two@example.com" value={attendees} onChange={event => { setAttendees(event.target.value); setDirty(true); }}/></label><label>Guest notifications<select aria-label="Calendar guest notifications" value={sendUpdates} onChange={event => { setSendUpdates(event.target.value as typeof sendUpdates); setDirty(true); }}><option value="none">Do not send updates</option><option value="all">Notify all guests</option><option value="externalOnly">Notify guests outside this Google organization</option></select></label><label>Description<textarea maxLength={8000} rows={3} value={description} onChange={event => { setDescription(event.target.value); setDirty(true); }}/></label><button disabled={busy || !persisted || !available(tool)}>Review exact {mode === 'create' ? 'event creation' : 'event update'}</button></form>}
    {busy && <p role="status">Working on the bounded Calendar request…</p>}
    {grants.map(grant => <CalendarGrantCard key={grant.id} grant={grant} busy={busy} onDecision={decide} onEdit={edit} onDelete={remove} onReconcile={reconcile}/>)}
  </article>;
}
