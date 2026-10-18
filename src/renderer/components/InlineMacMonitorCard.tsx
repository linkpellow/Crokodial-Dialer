import { useEffect, useMemo, useRef, useState } from 'react';
import { macConnectorService } from '../services/macConnectorService';
import type { WhatsAppObservation } from '../services/macConnectorTypes';
import {
  DEFAULT_MAC_MONITOR_KEYWORDS,
  MAX_MAC_MONITOR_KEYWORDS,
  MAX_MAC_MONITOR_WHATSAPP_CONVERSATIONS,
  refreshMacMonitor,
  startMacMonitor,
  stopMacMonitor,
  subscribeMacMonitor,
  type MacMonitorState,
  type WhatsAppMonitorConversation,
} from '../services/macConnectorMonitorManager';
import { parseMacMonitorChatRequest } from '../services/macMonitorChatRequest';

function targets(rows: readonly WhatsAppObservation[]): WhatsAppMonitorConversation[] {
  const values = new Map<string, WhatsAppMonitorConversation>();
  for (const row of rows) if (row.threadJid && !values.has(row.threadJid)) values.set(row.threadJid, { jid: row.threadJid, label: row.threadTitle || row.threadJid });
  return [...values.values()];
}

export function InlineMacMonitorCard({ turnId, persisted = true, text, agentId, sessionId, onPendingStateChange, onActivity }: {
  turnId: string; persisted?: boolean; text: string; agentId?: number; sessionId?: string;
  onPendingStateChange?: (turnId: string, state: { dirty: boolean; busy: boolean }) => void; onActivity?: () => void;
}) {
  const request = useMemo(() => parseMacMonitorChatRequest(text), [text]);
  if (!request) return null;
  return <ResolvedMacMonitorCard turnId={turnId} persisted={persisted} request={request} agentId={agentId} sessionId={sessionId} onPendingStateChange={onPendingStateChange} onActivity={onActivity}/>;
}

function ResolvedMacMonitorCard({ turnId, persisted, request, agentId, sessionId, onPendingStateChange, onActivity }: {
  turnId: string; persisted: boolean; request: NonNullable<ReturnType<typeof parseMacMonitorChatRequest>>; agentId?: number; sessionId?: string;
  onPendingStateChange?: (turnId: string, state: { dirty: boolean; busy: boolean }) => void; onActivity?: () => void;
}) {
  const [monitorState, setMonitorState] = useState<MacMonitorState>({ running: false });
  const [messages, setMessages] = useState(request.messages);
  const [selected, setSelected] = useState<WhatsAppMonitorConversation[]>([]);
  const [keywords, setKeywords] = useState<string[]>(request.keywords.length ? request.keywords : [...DEFAULT_MAC_MONITOR_KEYWORDS]);
  const [keyword, setKeyword] = useState('');
  const [query, setQuery] = useState(request.whatsappQuery);
  const [rows, setRows] = useState<WhatsAppObservation[]>([]);
  const [intervalMinutes, setIntervalMinutes] = useState(request.intervalMinutes);
  const [dirty, setDirty] = useState(false), dirtyRef = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const authority = agentId && sessionId ? { agentId, sessionId } : undefined;
  const markDirty = () => { dirtyRef.current = true; setDirty(true); };
  const clearDirty = () => { dirtyRef.current = false; setDirty(false); };

  useEffect(() => { onPendingStateChange?.(turnId, { dirty: dirty || Boolean(keyword), busy }); },
    [turnId, dirty, keyword, busy, onPendingStateChange]);
  useEffect(() => () => onPendingStateChange?.(turnId, { dirty: false, busy: false }), [turnId, onPendingStateChange]);
  useEffect(() => { dirtyRef.current = false; setDirty(false); }, [turnId, agentId, sessionId]);

  useEffect(() => {
    if (!authority) return;
    return subscribeMacMonitor(authority, value => {
      setMonitorState(value);
      if (value.configuration && !dirtyRef.current) {
        setMessages(value.configuration.messages); setSelected(value.configuration.whatsappConversations);
        setKeywords(value.configuration.keywords); setIntervalMinutes(value.configuration.intervalMinutes);
      }
    });
  }, [agentId, sessionId]);

  async function operate<T>(work: () => Promise<T>, complete?: (value: T) => void) {
    if (busy) return;
    setBusy(true); setError('');
    try { const value = await work(); complete?.(value); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The local monitor request failed.'); }
    finally { setBusy(false); }
  }

  function addKeyword() {
    const value = keyword.trim().replace(/\s+/g, ' ').toLowerCase();
    if (!value || value.length > 64 || /[\u0000-\u001f\u007f]/.test(value)) { setError('Enter a keyword or phrase from 1 to 64 characters.'); return; }
    if (keywords.includes(value)) { setError('That keyword is already selected.'); return; }
    if (keywords.length >= MAX_MAC_MONITOR_KEYWORDS) { setError(`Choose at most ${MAX_MAC_MONITOR_KEYWORDS} keywords.`); return; }
    setKeywords(current => [...current, value]); setKeyword(''); setError(''); markDirty();
  }

  function start() {
    if (!authority) { setError('Reopen the current signed-in Personal Assistant conversation before starting the monitor.'); return; }
    if (!persisted) { setError('Wait for this request to be saved in the permanent conversation before starting the monitor.'); return; }
    void operate(() => startMacMonitor({ messages, whatsappConversations: selected, keywords, intervalMinutes }, authority), value => {
      setMonitorState(value); clearDirty(); onActivity?.();
    });
  }

  function stop() {
    if (!authority) { setError('Reopen the current signed-in Personal Assistant conversation before stopping the monitor.'); return; }
    void operate(() => stopMacMonitor(authority, true), value => { setMonitorState(value); clearDirty(); onActivity?.(); });
  }

  function refresh() {
    if (!authority) { setError('Reopen the current signed-in Personal Assistant conversation to inspect the monitor.'); return; }
    if (!monitorState.running) { setError('The local monitor is not running for this account and main conversation.'); return; }
    void operate(() => refreshMacMonitor(authority), value => { setMonitorState(value); onActivity?.(); });
  }

  const choices = targets(rows);
  return <article className="assistant-work-card assistant-inline-mac" aria-label="Local read monitor request for saved message" data-turn-id={turnId}>
    <div className="assistant-card-heading"><strong>Local communication monitor</strong><span>{monitorState.running ? 'Active' : 'On this Mac'}</span></div>
    <p>This owner-bound monitor only reads bounded Apple Messages metadata and exact WhatsApp thread identities while Crokodial Workspace is running. It cannot send, label, delete, or modify messages.</p>
    {!persisted && <p className="assistant-inline-mac-warning">Wait for this request to be saved in the permanent conversation before changing monitor settings.</p>}
    {request.operation === 'stop' ? <div className="assistant-card-buttons"><button type="button" disabled={busy || !authority} onClick={stop}>Stop and clear this local monitor</button></div>
      : request.operation === 'status' ? <div className="assistant-card-buttons"><button type="button" disabled={busy || !authority || !monitorState.running} onClick={refresh}>Refresh monitor now</button>{monitorState.running && <button type="button" disabled={busy} onClick={stop}>Stop monitor</button>}</div>
        : <>
          <label className="nativework-row"><input type="checkbox" checked={messages} onChange={event => { setMessages(event.target.checked); markDirty(); }}/>Watch recent Apple Messages threads</label>
          {request.whatsapp && <section className="nativework-stack nativework-panel" aria-label="Exact WhatsApp monitor selection">
            <p><strong>Choose exact WhatsApp conversations</strong></p>
            <form className="nativework-row" onSubmit={event => { event.preventDefault(); void operate(() => macConnectorService.searchWhatsApp(query), value => setRows(value.observations)); }}>
              <label>Find conversation<input value={query} minLength={2} maxLength={100} required onChange={event => setQuery(event.target.value)}/></label><button disabled={busy || query.trim().length < 2}>Search read-only</button>
            </form>
            {choices.map(choice => <div className="nativework-row" key={choice.jid}><span>{choice.label}<br/><span className="assistant-inline-mac-meta">Stable JID: {choice.jid}</span></span><button type="button" disabled={busy || selected.some(value => value.jid === choice.jid) || selected.length >= MAX_MAC_MONITOR_WHATSAPP_CONVERSATIONS} onClick={() => { setSelected(current => [...current, choice]); markDirty(); }}>{selected.some(value => value.jid === choice.jid) ? 'Selected' : 'Monitor this exact thread'}</button></div>)}
            {selected.map(choice => <div className="nativework-row" key={`selected:${choice.jid}`}><span>Selected: {choice.label} ({choice.jid})</span><button type="button" onClick={() => { setSelected(current => current.filter(value => value.jid !== choice.jid)); markDirty(); }}>Remove</button></div>)}
          </section>}
          <section className="nativework-stack nativework-panel" aria-label="Monitor urgency keywords"><p><strong>Attention keywords ({keywords.length}/{MAX_MAC_MONITOR_KEYWORDS})</strong></p><p className="assistant-inline-mac-meta">Hints are heuristic. Review the original conversation before acting.</p>
            <form className="nativework-row" onSubmit={event => { event.preventDefault(); addKeyword(); }}><label>Add keyword or phrase<input value={keyword} maxLength={64} onChange={event => { setKeyword(event.target.value); markDirty(); }}/></label><button disabled={busy || keywords.length >= MAX_MAC_MONITOR_KEYWORDS}>Add</button></form>
            <ul>{keywords.map(value => <li className="nativework-row" key={value}><span>{value}</span><button type="button" disabled={keywords.length === 1} onClick={() => { setKeywords(current => current.filter(item => item !== value)); markDirty(); }}>Remove</button></li>)}</ul>
          </section>
          <label>Check every (minutes)<input type="number" min={1} max={30} value={intervalMinutes} onChange={event => { setIntervalMinutes(Number(event.target.value)); markDirty(); }}/></label>
          <div className="assistant-card-buttons"><button type="button" disabled={busy || !authority || !persisted || (!messages && selected.length === 0) || keywords.length === 0} onClick={start}>{monitorState.running ? 'Restart monitor with these exact settings' : 'Start this read-only monitor'}</button>{monitorState.running && <button type="button" disabled={busy} onClick={stop}>Stop monitor</button>}</div>
        </>}
    {busy && <p role="status">Updating the local monitor…</p>}{error && <p className="assistant-error" role="alert">{error}</p>}
    {monitorState.configuration && <p role="status">{monitorState.running ? 'Active' : 'Stopped'} every {monitorState.configuration.intervalMinutes} minute{monitorState.configuration.intervalMinutes === 1 ? '' : 's'} · Apple Messages {monitorState.configuration.messages ? 'on' : 'off'} · WhatsApp threads {monitorState.configuration.whatsappConversations.length} · keywords: {monitorState.configuration.keywords.join(', ')}.</p>}
    {monitorState.snapshot && <p className="assistant-inline-mac-meta">Last observed {new Date(monitorState.snapshot.observedAt).toLocaleString()} · {monitorState.snapshot.urgencyHints.length} new attention hint{monitorState.snapshot.urgencyHints.length === 1 ? '' : 's'}.</p>}
  </article>;
}
