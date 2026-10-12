import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CalendarDays, ChevronRight, PhoneIncoming, PhoneOutgoing, Phone, RefreshCw } from 'lucide-react';
import { workspaceContactsApi, activityDateHeading, activityDuration, activitySlot, activityStatus, activityTime, mergeWorkspaceRows, type ContactActivity, type ContactHistoryFilter } from '../services/workspaceContactsApi';
import { localDateValue } from '../services/appointmentsApiService';
import './contacts.css';

export function ContactHistory({ contactId, active = true, refreshKey = 0 }: { contactId: number; active?: boolean; refreshKey?: number | string }) {
  const [filter, setFilter] = useState<ContactHistoryFilter>('all'), [rows, setRows] = useState<ContactActivity[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null), [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false), [loaded, setLoaded] = useState(false), [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0), [expanded, setExpanded] = useState<string | null>(null);
  const [dataKey, setDataKey] = useState('');
  const [backgroundLoading, setBackgroundLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null), sentinelRef = useRef<HTMLDivElement>(null);
  const generation = useRef(0), busy = useRef(false), mounted = useRef(true), activeRef = useRef(active); activeRef.current = active;
  const stateKey = `${contactId}\n${filter}\n${refresh}`, stateKeyRef = useRef(stateKey); stateKeyRef.current = stateKey;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++generation.current; }; }, []);
  const rowsRef = useRef(rows); rowsRef.current = rows;
  const scrollRestore = useRef<{ top: number; height: number } | null>(null);
  const lastActive = useRef(active), lastRefreshKey = useRef(refreshKey), pendingRefresh = useRef(false);
  const failedRequest = useRef<{ cursor: string | null; head: boolean }>({ cursor: null, head: false });
  useLayoutEffect(() => {
    const before = scrollRestore.current, list = scrollRef.current;
    if (before && list) list.scrollTop = before.top + list.scrollHeight - before.height;
    scrollRestore.current = null;
  }, [rows]);
  const load = useCallback(async (cursor: string | null = null, head = false) => {
    if (busy.current) return;
    const request = ++generation.current, requestedKey = stateKey;
    busy.current = true; failedRequest.current = { cursor, head }; setBackgroundLoading(head); setLoading(true); setError('');
    try {
      const page = await workspaceContactsApi.history(contactId, { filter, cursor });
      if (!mounted.current || request !== generation.current || requestedKey !== stateKeyRef.current) return;
      const previous = rowsRef.current;
      const overlap = head && page.hasMore && previous.length > 0 && page.items.some(row => previous.some(existing => existing.id === row.id));
      if (overlap) {
        const fresh = new Set(page.items.map(row => row.id));
        const list = scrollRef.current;
        if (list && list.scrollTop > 0) scrollRestore.current = { top: list.scrollTop, height: list.scrollHeight };
        setRows([...page.items, ...previous.filter(row => !fresh.has(row.id))]);
      } else {
        setRows(cursor ? mergeWorkspaceRows(previous, page.items) : page.items);
        setHasMore(page.hasMore); setNextCursor(page.nextCursor);
      }
      setDataKey(requestedKey); setLoaded(true);
    } catch (failure) {
      if (mounted.current && request === generation.current && requestedKey === stateKeyRef.current) setError(failure instanceof Error ? failure.message : 'Unable to load contact history.');
    } finally { if (mounted.current && request === generation.current) { busy.current = false; setLoading(false); } }
  }, [contactId, filter, stateKey]);
  useEffect(() => {
    ++generation.current; busy.current = false; setRows([]); setNextCursor(null); setHasMore(false); setLoaded(false); setError(''); setLoading(false); setExpanded(null);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    if (activeRef.current) void load();
  }, [load]);
  useEffect(() => { if (active && !loaded && !loading && !error) void load(); }, [active, loaded, loading, error, load]);
  useEffect(() => {
    if (active && !lastActive.current && loaded) pendingRefresh.current = true;
    if (refreshKey !== lastRefreshKey.current) { pendingRefresh.current = true; lastRefreshKey.current = refreshKey; }
    lastActive.current = active;
    if (active && loaded && dataKey === stateKey && !loading && pendingRefresh.current) { pendingRefresh.current = false; void load(null, true); }
  }, [active, loaded, loading, refreshKey, dataKey, stateKey, load]);
  const loadMore = useCallback(() => { if (activeRef.current && hasMore && nextCursor && !loading && !error) void load(nextCursor); }, [hasMore, nextCursor, loading, error, load]);
  useEffect(() => {
    if (!active || !hasMore || !sentinelRef.current || !scrollRef.current) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) loadMore(); }, { root: scrollRef.current, rootMargin: '120px' });
    observer.observe(sentinelRef.current); return () => observer.disconnect();
  }, [active, hasMore, loadMore]);
  useEffect(() => {
    if (!active || !loaded) return;
    const refreshVisible = () => { if (!document.hidden) void load(null, true); };
    const timer = setInterval(refreshVisible, 30_000);
    window.addEventListener('focus', refreshVisible);
    return () => { clearInterval(timer); window.removeEventListener('focus', refreshVisible); };
  }, [active, loaded, load]);
  const visibleRows = dataKey === stateKey ? rows : [];
  return <section className="contact-history" aria-label="Contact history">
    <div className="contact-history-heading"><h2>History</h2><button className="icon-button" aria-label="Refresh history" title="Refresh history" disabled={loading} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14}/></button></div>
    <div className="workspace-list-filters" role="tablist" aria-label="History type">{(['all', 'calls', 'appointments'] as const).map(value => <button key={value} role="tab" aria-selected={filter === value} onClick={() => setFilter(value)}>{value.charAt(0).toUpperCase() + value.slice(1)}</button>)}</div>
    <div className="contact-history-list" ref={scrollRef} aria-label="History timeline" tabIndex={0}>
      {visibleRows.map((item, index) => {
        const day = localDateValue(new Date(item.occurredAt));
        const newDay = index === 0 || localDateValue(new Date(visibleRows[index - 1].occurredAt)) !== day;
        const call = item.kind === 'call' ? item : null;
        const missed = call && ['missed', 'no_answer', 'no answer', 'busy', 'failed'].includes(call.status.toLowerCase());
        const Icon = item.kind === 'appointment' ? CalendarDays : call?.direction === 'inbound' ? PhoneIncoming : call?.direction === 'outbound' ? PhoneOutgoing : Phone;
        const title = item.kind === 'appointment' ? item.title || 'Appointment' : call?.direction === 'inbound' ? 'Incoming call' : call?.direction === 'outbound' ? 'Outgoing call' : 'Call';
        const status = activityStatus(call ? call.outcome || call.status : item.status);
        const summary = item.kind === 'appointment' ? `${activitySlot(item)} · ${status}` : [activityTime(item.occurredAt), status, activityDuration(item.durationSeconds)].filter(Boolean).join(' · ');
        return <div className="contact-history-entry" key={item.id}>
          {newDay && <h3 className="contact-history-day"><span>{activityDateHeading(item.occurredAt)}</span></h3>}
          <article className={`contact-history-event ${item.kind}${missed ? ' missed' : ''}`} data-history-id={item.id} data-history-type={item.kind}>
            <span className="contact-history-icon" aria-hidden="true"><Icon size={16}/></span>
            <div className="contact-history-event-body">
              <button className="contact-history-event-toggle" aria-expanded={expanded === item.id} aria-label={`Details for ${title}, ${summary}`} onClick={() => setExpanded(value => value === item.id ? null : item.id)}>
                <span><strong>{title}</strong><small>{summary}</small></span><ChevronRight className={expanded === item.id ? 'expanded' : ''} size={15} aria-hidden="true"/>
              </button>
              {expanded === item.id && <div className="contact-history-event-detail">
                <time dateTime={item.occurredAt}>{new Date(item.occurredAt).toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' })}</time>
                {item.kind === 'call' && item.disposition && <p>Disposition: {item.disposition}</p>}
                <p>{item.kind === 'call' ? item.verified ? 'Confirmed call record' : 'Historical call record; provider confirmation is unavailable.' : `Appointment: ${activityStatus(item.status)}`}</p>
                {item.kind === 'call' && !activityDuration(item.durationSeconds) && <p>Duration unavailable</p>}
              </div>}
            </div>
          </article>
        </div>;
      })}
      {!loading && !error && loaded && dataKey === stateKey && visibleRows.length === 0 && <p className="workspace-list-message">{filter === 'calls' ? 'No call history for this contact.' : filter === 'appointments' ? 'No appointment history for this contact.' : 'No history for this contact yet.'}</p>}
      {loading && !backgroundLoading && <p className="workspace-list-message" role="status">Loading history…</p>}
      {error && <p className="workspace-list-error" role="alert">{error} <button onClick={() => void load(failedRequest.current.cursor, failedRequest.current.head)}>Retry</button></p>}
      <div className="workspace-list-sentinel" ref={sentinelRef}/>
      {hasMore && (!loading || backgroundLoading) && !error && <button disabled={loading} className="workspace-load-more" onClick={loadMore}>Load earlier activity</button>}
    </div>
  </section>;
}
