import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronRight, UserRound } from 'lucide-react';
import { workspaceContactsApi, workspaceContactInitials, workspaceContactName, workspaceContactPhone, workspaceContactIndicator, mergeWorkspaceRows, patchWorkspaceContactRows, type WorkspaceContact, type WorkspaceContactFilter, type WorkspaceContactUpdate } from '../services/workspaceContactsApi';
import { CollapsibleSearch } from './CollapsibleSearch';
import './contacts.css';

export function WorkspaceContacts({ onSelect, selecting = false, selectedContactId, active = true, error: selectionError = '', refreshKey = 0, contactUpdate }: {
  onSelect: (contactId: number) => void; selecting?: boolean; selectedContactId?: number; active?: boolean; error?: string; refreshKey?: number | string; contactUpdate?: WorkspaceContactUpdate | null;
}) {
  const [query, setQuery] = useState(''), [filter, setFilter] = useState<WorkspaceContactFilter>('all');
  const [search, setSearch] = useState(''), [rows, setRows] = useState<WorkspaceContact[]>([]);
  const [loading, setLoading] = useState(false), [error, setError] = useState('');
  const [nextCursor, setNextCursor] = useState<string | null>(null), [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [dataKey, setDataKey] = useState('');
  const [backgroundLoading, setBackgroundLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null), sentinelRef = useRef<HTMLDivElement>(null);
  const generation = useRef(0), busy = useRef(false), activeRef = useRef(active); activeRef.current = active;
  const stateKey = `${filter}\n${search}`, stateKeyRef = useRef(stateKey); stateKeyRef.current = stateKey;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++generation.current; }; }, []);
  useEffect(() => { const timer = setTimeout(() => setSearch(query.trim()), 250); return () => clearTimeout(timer); }, [query]);
  const rowsRef = useRef(rows); rowsRef.current = rows;
  const scrollRestore = useRef<{ top: number; anchors: { id: string; offset: number }[] } | null>(null);
  const lastActive = useRef(active), lastRefreshKey = useRef(refreshKey), pendingRefresh = useRef(false);
  const failedRequest = useRef<{ cursor: string | null; head: boolean }>({ cursor: null, head: false });
  useLayoutEffect(() => {
    const before = scrollRestore.current, list = scrollRef.current;
    if (before && list) {
      const anchor = before.anchors.map(saved => ({ saved, element: list.querySelector<HTMLElement>(`[data-contact-id="${saved.id}"]`) })).find(item => item.element);
      if (anchor?.element) list.scrollTop += anchor.element.getBoundingClientRect().top - list.getBoundingClientRect().top - anchor.saved.offset;
      else list.scrollTop = before.top;
    }
    scrollRestore.current = null;
  }, [rows]);
  const load = useCallback(async (cursor: string | null = null, head = false) => {
    if (busy.current) return;
    const request = ++generation.current, requestedKey = stateKey;
    busy.current = true; failedRequest.current = { cursor, head }; setBackgroundLoading(head); setLoading(true); setError('');
    try {
      const previous = rowsRef.current;
      let page = await workspaceContactsApi.list({ filter, search, cursor });
      const current = () => mounted.current && request === generation.current && requestedKey === stateKeyRef.current;
      if (!current()) return;
      if (head && previous.length) {
        // Reconcile the loaded window, including visible older rows, against one
        // fresh keyset snapshot. Stop at its former oldest ID, never at a guessed offset.
        const oldestId = previous[previous.length - 1].id;
        let refreshed = page.contacts;
        const seenCursors = new Set<string>();
        const maxPages = Math.ceil(previous.length / 50) + 2;
        let pages = 1;
        while (page.hasMore && (!refreshed.length || refreshed[refreshed.length - 1].id > oldestId)) {
          if (!page.nextCursor || seenCursors.has(page.nextCursor) || pages >= maxPages) throw new Error('Contacts are changing quickly. The list will update automatically.');
          seenCursors.add(page.nextCursor);
          page = await workspaceContactsApi.list({ filter, search, cursor: page.nextCursor });
          if (!current()) return;
          refreshed = mergeWorkspaceRows(refreshed, page.contacts);
          pages += 1;
        }
        const list = scrollRef.current;
        if (list && list.scrollTop > 0) {
          const top = list.getBoundingClientRect().top;
          const anchors = Array.from(list.querySelectorAll<HTMLElement>('[data-contact-id]')).filter(row => row.getBoundingClientRect().bottom > top).slice(0, 5).map(row => ({ id: row.dataset.contactId!, offset: row.getBoundingClientRect().top - top }));
          scrollRestore.current = { top: list.scrollTop, anchors };
        }
        setRows(refreshed);
      } else {
        setRows(cursor ? mergeWorkspaceRows(previous, page.contacts) : page.contacts);
      }
      setHasMore(page.hasMore); setNextCursor(page.nextCursor);
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
  useEffect(() => {
    if (!active) return;
    // A visible list stays current without resetting its search, filter, or cursor pages.
    // The request guard prevents timer/focus/visibility events from overlapping.
    const refreshVisible = () => { if (!document.hidden) void load(null, loaded); };
    const timer = setInterval(refreshVisible, 30_000);
    window.addEventListener('focus', refreshVisible);
    document.addEventListener('visibilitychange', refreshVisible);
    return () => { clearInterval(timer); window.removeEventListener('focus', refreshVisible); document.removeEventListener('visibilitychange', refreshVisible); };
  }, [active, loaded, load]);
  const visibleRows = dataKey === stateKey ? rows : [];
  return <section className="workspace-contacts" aria-label="Contacts" aria-busy={loading}>
    <div className="workspace-contact-toolbar">
      <CollapsibleSearch id="workspace-contact-search" value={query} onChange={setQuery} header={
        <div className="workspace-list-filters" role="tablist" aria-label="Contact type">{(['all', 'leads', 'clients'] as const).map(value => <button key={value} role="tab" aria-selected={filter === value} onClick={() => setFilter(value)}>{value.charAt(0).toUpperCase() + value.slice(1)}</button>)}</div>
      } />
    </div>
    {selectionError && <p className="workspace-list-error" role="alert">{selectionError}</p>}
    {selecting && <p className="workspace-list-message" role="status">Opening contact notes…</p>}
    <div className="workspace-contacts-list" ref={scrollRef} aria-label="Contact list" tabIndex={0}>
      {visibleRows.map(contact => {
        const name = workspaceContactName(contact), initials = workspaceContactInitials(contact);
        const indicator = workspaceContactIndicator(contact);
        return <button className={`workspace-contact-row${selectedContactId === contact.id ? ' selected' : ''}`} key={contact.id} data-contact-id={contact.id} disabled={selecting} aria-label={`Open notes for ${name}${indicator ? `, ${indicator.label}` : ''}`} aria-pressed={selectedContactId === contact.id} onClick={() => onSelect(contact.id)}>
          {indicator && <span className={`workspace-contact-indicator ${indicator.tone}`} title={indicator.label} aria-hidden="true"/>}
          <span className="workspace-contact-avatar" aria-hidden="true">{initials || <UserRound size={17}/>}</span>
          <span className="workspace-contact-summary"><strong>{name}</strong><small>{workspaceContactPhone(contact.phone)}</small></span>
          <ChevronRight className="workspace-contact-chevron" size={16} aria-hidden="true"/>
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
