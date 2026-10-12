import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronRight, RefreshCw, UserRound } from 'lucide-react';
import { workspaceContactsApi, workspaceContactInitials, workspaceContactName, workspaceContactPhone, mergeWorkspaceRows, mergeWorkspaceContactHead, patchWorkspaceContactRows, type WorkspaceContact, type WorkspaceContactFilter, type WorkspaceContactUpdate } from '../services/workspaceContactsApi';
import './contacts.css';

export function WorkspaceContacts({ onSelect, selecting = false, selectedContactId, active = true, error: selectionError = '', refreshKey = 0, contactUpdate }: {
  onSelect: (contactId: number) => void; selecting?: boolean; selectedContactId?: number; active?: boolean; error?: string; refreshKey?: number | string; contactUpdate?: WorkspaceContactUpdate | null;
}) {
  const [query, setQuery] = useState(''), [filter, setFilter] = useState<WorkspaceContactFilter>('all');
  const [search, setSearch] = useState(''), [rows, setRows] = useState<WorkspaceContact[]>([]);
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null), [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false), [refresh, setRefresh] = useState(0);
  const [dataKey, setDataKey] = useState('');
  const [backgroundLoading, setBackgroundLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null), sentinelRef = useRef<HTMLDivElement>(null);
  const generation = useRef(0), busy = useRef(false), activeRef = useRef(active); activeRef.current = active;
  const stateKey = `${filter}\n${search}\n${refresh}`, stateKeyRef = useRef(stateKey); stateKeyRef.current = stateKey;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++generation.current; }; }, []);
  useEffect(() => { const timer = setTimeout(() => setSearch(query.trim()), 250); return () => clearTimeout(timer); }, [query]);
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
      const page = await workspaceContactsApi.list({ filter, search, cursor });
      if (!mounted.current || request !== generation.current || requestedKey !== stateKeyRef.current) return;
      const previous = rowsRef.current;
      const overlap = head && page.hasMore && previous.length > 0 && page.contacts.some(row => previous.some(existing => existing.id === row.id));
      if (overlap) {
        const list = scrollRef.current;
        if (list && list.scrollTop > 0) scrollRestore.current = { top: list.scrollTop, height: list.scrollHeight };
        setRows(mergeWorkspaceContactHead(previous, page.contacts));
      } else {
        setRows(cursor ? mergeWorkspaceRows(previous, page.contacts) : page.contacts);
        setHasMore(page.hasMore); setNextCursor(page.nextCursor);
      }
      setDataKey(requestedKey); setLoaded(true);
    } catch (failure) {
      if (mounted.current && request === generation.current && requestedKey === stateKeyRef.current) setError(failure instanceof Error ? failure.message : 'Unable to load contacts.');
    } finally { if (mounted.current && request === generation.current) { busy.current = false; setLoading(false); } }
  }, [filter, search, stateKey]);
  useEffect(() => {
    ++generation.current; busy.current = false; setRows([]); setNextCursor(null); setHasMore(false); setLoaded(false); setError(''); setLoading(false);
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
  useEffect(() => {
    if (!contactUpdate) return;
    // A pre-mutation list response must not put stale membership back into this cache.
    ++generation.current; busy.current = false; setLoading(false);
    setRows(current => patchWorkspaceContactRows(current, filter, contactUpdate));
  }, [contactUpdate?.id, contactUpdate?.clientStatus, contactUpdate?.disposition, filter]);
  const loadMore = useCallback(() => { if (activeRef.current && hasMore && nextCursor && !loading && !error) void load(nextCursor); }, [hasMore, nextCursor, loading, error, load]);
  useEffect(() => {
    if (!active || !hasMore || !sentinelRef.current || !scrollRef.current) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) loadMore(); }, { root: scrollRef.current, rootMargin: '120px' });
    observer.observe(sentinelRef.current); return () => observer.disconnect();
  }, [active, hasMore, loadMore]);
  const visibleRows = dataKey === stateKey ? rows : [];
  return <section className="workspace-contacts" aria-label="Contacts">
    <div className="workspace-contact-search">
      <div className="workspace-contact-search-heading"><label htmlFor="workspace-contact-search">Search</label><button className="icon-button" aria-label="Refresh contacts" title="Refresh contacts" disabled={loading} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={14}/></button></div>
      <input id="workspace-contact-search" placeholder="Name or phone" value={query} onChange={event => setQuery(event.target.value)} />
    </div>
    <div className="workspace-list-filters" role="tablist" aria-label="Contact type">{(['all', 'leads', 'clients'] as const).map(value => <button key={value} role="tab" aria-selected={filter === value} onClick={() => setFilter(value)}>{value.charAt(0).toUpperCase() + value.slice(1)}</button>)}</div>
    {selectionError && <p className="workspace-list-error" role="alert">{selectionError}</p>}
    {selecting && <p className="workspace-list-message" role="status">Opening contact notes…</p>}
    <div className="workspace-contacts-list" ref={scrollRef} aria-label="Contact list" tabIndex={0}>
      {visibleRows.map(contact => {
        const name = workspaceContactName(contact), initials = workspaceContactInitials(contact);
        const membership = contact.clientStatus === 'client' ? 'Client' : contact.clientStatus === 'former_client' ? 'Former client' : 'Lead';
        return <button className={`workspace-contact-row${selectedContactId === contact.id ? ' selected' : ''}`} key={contact.id} data-contact-id={contact.id} disabled={selecting} aria-label={`Open notes for ${name}`} aria-pressed={selectedContactId === contact.id} onClick={() => onSelect(contact.id)}>
          <span className="workspace-contact-avatar" aria-hidden="true">{initials || <UserRound size={17}/>}</span>
          <span className="workspace-contact-summary"><strong>{name}</strong><small>{workspaceContactPhone(contact.phone)}</small></span>
          <span className={`workspace-contact-badge ${contact.clientStatus === 'client' ? 'client' : 'lead'}`}>{membership}</span><ChevronRight className="workspace-contact-chevron" size={16} aria-hidden="true"/>
        </button>;
      })}
      {!loading && !error && loaded && dataKey === stateKey && visibleRows.length === 0 && <p className="workspace-list-message">{search ? 'No contacts match this search.' : filter === 'clients' ? 'No clients yet.' : filter === 'leads' ? 'No leads yet.' : 'No contacts yet.'}</p>}
      {loading && !backgroundLoading && <p className="workspace-list-message" role="status">Loading contacts…</p>}
      {error && <p className="workspace-list-error" role="alert">{error} <button onClick={() => void load(failedRequest.current.cursor, failedRequest.current.head)}>Retry</button></p>}
      <div ref={sentinelRef} className="workspace-list-sentinel"/>
      {hasMore && (!loading || backgroundLoading) && !error && <button disabled={loading} className="workspace-load-more" onClick={loadMore}>Load more contacts</button>}
    </div>
  </section>;
}
