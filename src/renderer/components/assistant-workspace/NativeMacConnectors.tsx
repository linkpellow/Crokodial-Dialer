import { useEffect, useState } from 'react';
import { macConnectorService } from '../../services/macConnectorService';
import type {
  MacConnectorReceipt,
  MacConnectorReview,
  MacConnectorStatus,
  MacContact,
  MacContactChange,
  MacContactDuplicateGroup,
  MacMessageThread,
  MacReviewedWriteRecord,
  MacThreadMessage,
  WhatsAppObservation,
} from '../../services/macConnectorTypes';
import { useNativeWorkState } from './nativeWorkState';
import { startMacMonitor, stopMacMonitor, subscribeMacMonitor, type MacMonitorState, type WhatsAppMonitorConversation } from '../../services/macConnectorMonitorManager';

function timeLabel(value: string | null): string {
  return value ? new Date(value).toLocaleString() : 'Time unavailable';
}

function StateBadge({ state }: { state: string }) {
  return <span className="nativework-small">{state.replace(/_/g, ' ')}</span>;
}

function whatsappMonitorTargets(rows: readonly WhatsAppObservation[]): WhatsAppMonitorConversation[] {
  const targets = new Map<string, WhatsAppMonitorConversation>();
  for (const row of rows) if (row.threadJid && !targets.has(row.threadJid)) targets.set(row.threadJid, {
    jid: row.threadJid,
    label: row.threadTitle || row.threadJid,
  });
  return [...targets.values()];
}

function ReviewCard({ review, busy, action, label }: { review: MacConnectorReview; busy: boolean; action: () => void; label: string }) {
  const payload = review.payload as any;
  return <article className="nativework-stack nativework-panel" aria-label={`${review.kind} review`}>
    <p className="nativework-strong">Exact review</p>
    <p>{review.summary}</p>
    {payload.thread && <><p>Thread: {payload.thread.title}</p><p className="nativework-small nativework-muted">Participants: {payload.thread.participants.join(', ') || 'Unavailable'} · {payload.thread.service || 'Unknown service'}</p></>}
    {payload.phone && <p>Recipient: {payload.phone}</p>}
    {payload.text && <p className="nativework-prewrap">{payload.text}</p>}
    {payload.contact && <p className="nativework-prewrap">{JSON.stringify(payload.contact, null, 2)}</p>}
    {payload.changes && <p className="nativework-prewrap">{JSON.stringify(payload.changes, null, 2)}</p>}
    <p className="nativework-small nativework-muted">Review {review.id} · expires {new Date(review.expiresAt).toLocaleString()} · digest {review.digest.slice(0, 12)}</p>
    <button type="button" disabled={busy} onClick={action} className="nativework-primary">{label}</button>
  </article>;
}

export function NativeMacConnectors({ agentId, sessionId, conversationKey, onActivity }: { agentId: number; sessionId: string; conversationKey: string; onActivity?: () => void }) {
  const [status, setStatus] = useState<MacConnectorStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [receipts, setReceipts] = useState<MacConnectorReceipt[]>([]);
  const [savedWrites, setSavedWrites] = useState<MacReviewedWriteRecord[]>([]);
  const [savedWritesNextCursor, setSavedWritesNextCursor] = useState<string>();

  const [contactQuery, setContactQuery] = useState('');
  const [contacts, setContacts] = useState<MacContact[]>([]);
  const [duplicates, setDuplicates] = useState<MacContactDuplicateGroup[]>([]);
  const [duplicateTruncated, setDuplicateTruncated] = useState(false);

  const [messageQuery, setMessageQuery] = useState('');
  const [threads, setThreads] = useState<MacMessageThread[]>([]);
  const [selectedThread, setSelectedThread] = useState<MacMessageThread | null>(null);
  const [threadMessages, setThreadMessages] = useState<MacThreadMessage[]>([]);

  const [whatsAppQuery, setWhatsAppQuery] = useState('');
  const [whatsAppRows, setWhatsAppRows] = useState<WhatsAppObservation[]>([]);
  const [smsPhone, setSmsPhone] = useState('');
  const [smsText, setSmsText] = useState('');
  const [smsReview, setSmsReview] = useState<MacConnectorReview | null>(null);
  const [monitorMessages, setMonitorMessages] = useState(true);
  const [monitorWhatsApp, setMonitorWhatsApp] = useState<WhatsAppMonitorConversation | null>(null);
  const [monitorMinutes, setMonitorMinutes] = useState(5), [monitorState, setMonitorState] = useState<MacMonitorState>({ running: false });

  const dirty = Boolean(smsPhone || smsText || smsReview);
  useNativeWorkState(dirty, busy);
  useEffect(() => subscribeMacMonitor({ agentId, sessionId }, value => {
    setMonitorState(value);
    if (value.configuration?.whatsappConversation) setMonitorWhatsApp(value.configuration.whatsappConversation);
    if (value.snapshot) onActivity?.();
  }), [agentId, sessionId, onActivity]);

  async function operate<T>(work: () => Promise<T>, complete?: (result: T) => void) {
    if (busy) return;
    setBusy(true); setError('');
    try { const result = await work(); complete?.(result); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Mac connector request failed.'); }
    finally { setBusy(false); }
  }

  function refreshStatus() { return operate(macConnectorService.status, setStatus); }
  useEffect(() => { void macConnectorService.status().then(setStatus).catch(cause => setError(cause instanceof Error ? cause.message : 'Mac connector status failed.')); }, []);
  async function refreshSavedWrites() {
    const result = await macConnectorService.listReviewedWrites({ agentId, sessionId });
    setSavedWrites(result.records); setSavedWritesNextCursor(result.nextCursor);
    return result;
  }
  async function loadOlderSavedWrites() {
    if (!savedWritesNextCursor) return;
    const result = await macConnectorService.listReviewedWrites({ agentId, sessionId }, savedWritesNextCursor);
    setSavedWrites(items => {
      const identifiers = new Set(items.map(item => item.state === 'pending' ? item.review.id : item.receipt.reviewId));
      return [...items, ...result.records.filter(item => !identifiers.has(item.state === 'pending' ? item.review.id : item.receipt.reviewId))];
    });
    setSavedWritesNextCursor(result.nextCursor);
  }
  useEffect(() => {
    let current = true;
    void macConnectorService.listReviewedWrites({ agentId, sessionId }).then(result => {
      if (current) { setSavedWrites(result.records); setSavedWritesNextCursor(result.nextCursor); }
    }).catch(cause => { if (current) setError(cause instanceof Error ? cause.message : 'Saved Mac write receipts could not be restored.'); });
    return () => { current = false; };
  }, [agentId, sessionId, conversationKey]);

  function requestAccess(connector: 'contacts' | 'messages') {
    return operate(() => macConnectorService.requestAccess(connector), setStatus);
  }

  function loadThread(thread: MacMessageThread) {
    void operate(() => macConnectorService.readMessageThread(thread.id), data => {
      setSelectedThread(data.thread); setThreadMessages(data.messages);
    });
  }

  function executeSmsReview() {
    if (!smsReview) return;
    void operate(() => macConnectorService.openSmsDraft(smsReview), receipt => {
      setReceipts(items => [receipt, ...items]); setSmsReview(null); onActivity?.();
    });
  }

  function executeSavedWrite(record: MacReviewedWriteRecord) {
    if (record.state !== 'pending') return;
    void operate(async () => {
      const current = await macConnectorService.restoreReviewedWriteContext(record.context, record.kind, { agentId, sessionId });
      if (current.state !== 'pending') throw new Error('This saved review changed. Refresh its durable receipt before continuing.');
      const authority = { agentId, sessionId };
      return record.kind === 'messages.send'
        ? macConnectorService.executeMessageSend(current.review, authority)
        : macConnectorService.executeContactChange(current.review as MacConnectorReview<MacContactChange>, authority);
    }, receipt => { setReceipts(items => [receipt, ...items]); void refreshSavedWrites(); onActivity?.(); });
  }

  function reconcileSavedWrite(record: MacReviewedWriteRecord, resolution: 'applied' | 'not_applied') {
    if (record.state !== 'unknown') return;
    void operate(async () => {
      const current = await macConnectorService.restoreReviewedWriteContext(record.context, record.kind, { agentId, sessionId });
      if (current.state !== 'unknown') throw new Error('This saved receipt changed. Refresh it before reconciling.');
      return macConnectorService.reconcileReviewedWrite(current.receipt, resolution, { agentId, sessionId });
    }, () => { void refreshSavedWrites(); onActivity?.(); });
  }

  const whatsAppMonitorChoices = whatsappMonitorTargets(whatsAppRows);

  return <section className="nativework-stack" aria-label="Mac connectors">
    <div className="nativework-row"><div><h3 className="nativework-strong">Mac connections</h3><p className="nativework-muted">Local access stays on this Mac. Contact changes and outgoing actions require an exact review.</p></div><button type="button" disabled={busy} onClick={() => void refreshStatus()}>Refresh</button></div>
    {error && <p role="alert" className="nativework-error">{error}</p>}
    {status && <ul className="nativework-grid" aria-label="Mac connection status">
      {([['Contacts', status.contacts], ['Messages history', status.messagesHistory], ['Messages send', status.messagesSend], ['WhatsApp', status.whatsapp], ['SMS draft', status.smsDraft]] as const).map(([label, item]) => <li className="nativework-panel" key={label}><p className="nativework-strong">{label} · <StateBadge state={item.state}/></p><p className="nativework-muted">{item.detail}</p></li>)}
    </ul>}

    <article className="nativework-stack nativework-panel" aria-label="Saved local write receipts">
      <div className="nativework-row"><div><h4 className="nativework-strong">Saved local write receipts</h4><p className="nativework-muted">Durable reviews from this permanent conversation survive app restarts and assistant replacement. Nothing resumes automatically.</p></div><button type="button" disabled={busy} onClick={() => void operate(refreshSavedWrites)}>Refresh receipts</button></div>
      {savedWrites.length === 0 ? <p className="nativework-small nativework-muted">No active durable Mac write receipts.</p> : savedWrites.map(record => <div className="nativework-stack nativework-panel" key={record.state === 'pending' ? record.review.id : record.receipt.reviewId}>
        <div className="nativework-row"><p className="nativework-strong">{record.summary}</p><StateBadge state={record.state}/></div>
        <p className="nativework-small nativework-muted">Saved request {record.context.requestId ?? record.context.turnId} · revision {record.context.revision} · originally reviewed by assistant {record.context.agentId}</p>
        <pre className="nativework-prewrap">{JSON.stringify(record.payload, null, 2)}</pre>
        {record.state === 'pending' ? <><p>This exact saved review is still pending. Execution revalidates the current signed-in owner, tenant, permanent conversation, and authorization lineage first.</p><button type="button" className="nativework-primary" disabled={busy} onClick={() => executeSavedWrite(record)}>{record.kind === 'messages.send' ? 'Submit this saved exact message once' : 'Apply this saved exact contact change once'}</button></>
          : <><p>{record.receipt.message}</p>{record.receipt.error && <p className="nativework-error">{record.receipt.error}</p>}{record.state === 'unknown' && <><p>Inspect the original Messages thread or Contacts record above before choosing either outcome. This write cannot be replayed while unresolved.</p><div className="nativework-row"><button type="button" disabled={busy} onClick={() => reconcileSavedWrite(record, 'applied')}>I verified it was applied</button><button type="button" disabled={busy} onClick={() => reconcileSavedWrite(record, 'not_applied')}>I verified it was not applied</button></div></>}</>}
      </div>)}
      {savedWritesNextCursor && <button type="button" disabled={busy} onClick={() => void operate(loadOlderSavedWrites)}>Load older receipts</button>}
    </article>

    <article className="nativework-stack nativework-panel" aria-label="Mac Contacts">
      <div className="nativework-row"><div><h4 className="nativework-strong">Contacts</h4><p className="nativework-muted">Search, prepare a contact change, or preview possible duplicates. Duplicate previews never merge or delete records.</p></div><button type="button" disabled={busy} onClick={() => void requestAccess('contacts')}>Check Contacts access</button></div>
      <form className="nativework-row" onSubmit={event => { event.preventDefault(); void operate(() => macConnectorService.searchContacts(contactQuery), data => setContacts(data.contacts)); }}>
        <label>Find contact<input className="nativework-panel" required minLength={2} maxLength={100} value={contactQuery} onChange={event => setContactQuery(event.target.value)}/></label>
        <button disabled={busy || status?.contacts.state !== 'available'}>Search Contacts</button>
      </form>
      {contacts.length > 0 && <ul className="nativework-stack">{contacts.map(contact => <li key={contact.id} className="nativework-row"><span>{contact.name || contact.organization || 'Unnamed contact'} · {contact.emails[0] || contact.phones[0] || 'No address'}</span></li>)}</ul>}
      <p className="nativework-small nativework-muted">Ask the Personal Assistant in the permanent chat to create or update a contact. The saved user turn becomes the durable review origin; this panel never invents one.</p>
      <button type="button" disabled={busy || status?.contacts.state !== 'available'} onClick={() => void operate(macConnectorService.previewContactDuplicates, data => { setDuplicates(data.groups); setDuplicateTruncated(data.truncated); })}>Preview possible duplicates</button>
      {duplicates.length === 0 ? null : <ul className="nativework-stack">{duplicates.map(group => <li key={group.key} className="nativework-panel"><p className="nativework-strong">{group.reason}</p>{group.contacts.map(contact => <p key={contact.id}>{contact.name || contact.organization || 'Unnamed contact'} · {contact.emails.join(', ')} {contact.phones.join(', ')}</p>)}</li>)}</ul>}
      {duplicateTruncated && <p className="nativework-small nativework-muted">More possible duplicate groups exist.</p>}
    </article>

    <article className="nativework-stack nativework-panel" aria-label="Mac Messages">
      <div className="nativework-row"><div><h4 className="nativework-strong">Messages</h4><p className="nativework-muted">Read existing local threads. A send can target only the reviewed existing thread and is never retried automatically.</p></div><button type="button" disabled={busy} onClick={() => void requestAccess('messages')}>Check Messages access</button></div>
      <form className="nativework-row" onSubmit={event => { event.preventDefault(); void operate(() => macConnectorService.listMessageThreads(messageQuery), data => setThreads(data.threads)); }}>
        <label>Thread search<input className="nativework-panel" maxLength={100} value={messageQuery} onChange={event => setMessageQuery(event.target.value)} placeholder="Name or number"/></label><button disabled={busy || status?.messagesHistory.state !== 'available'}>Find existing threads</button>
      </form>
      {threads.length > 0 && <ul className="nativework-stack">{threads.map(thread => <li key={thread.id} className="nativework-row"><span><strong>{thread.title}</strong><br/><span className="nativework-small nativework-muted">{thread.participants.join(', ') || 'Participants unavailable'} · {timeLabel(thread.lastMessageAt)}</span></span><button type="button" disabled={busy} onClick={() => loadThread(thread)}>Open</button></li>)}</ul>}
      {selectedThread && <div className="nativework-stack"><p className="nativework-strong">{selectedThread.title}</p><p className="nativework-small nativework-muted">{selectedThread.participants.join(', ') || 'Participants unavailable'} · {selectedThread.service || 'Unknown service'}</p>
        <ol className="nativework-stack" aria-label="Messages thread">{threadMessages.map(message => <li key={message.id} className="nativework-panel"><p className="nativework-small">{message.fromMe ? 'You' : message.sender || 'Participant'} · {timeLabel(message.sentAt)}</p><p className="nativework-prewrap">{message.text || '(Attachment or rich message)'}</p></li>)}</ol>
        <p className="nativework-small nativework-muted">Ask the Personal Assistant in the permanent chat to prepare a reply. Its exact saved user turn is required before a Messages review can be created.</p>
      </div>}
    </article>

    <article className="nativework-stack nativework-panel" aria-label="WhatsApp read-only search">
      <h4 className="nativework-strong">WhatsApp · read only</h4><p className="nativework-muted">Searches a supported local WhatsApp store. This connector has no write or send operation.</p>
      <form className="nativework-row" onSubmit={event => { event.preventDefault(); void operate(() => macConnectorService.searchWhatsApp(whatsAppQuery), data => setWhatsAppRows(data.observations)); }}><label>Search local messages<input className="nativework-panel" required minLength={2} maxLength={100} value={whatsAppQuery} onChange={event => setWhatsAppQuery(event.target.value)}/></label><button disabled={busy || status?.whatsapp.state !== 'available'}>Search WhatsApp</button></form>
      {whatsAppRows.length > 0 && <><div className="nativework-stack" aria-label="WhatsApp monitor conversation choices"><p className="nativework-strong">Choose one exact conversation to monitor</p><p className="nativework-small nativework-muted">The saved monitor binds to the stable JID shown here. Matching names or message text in other conversations will not be read.</p>{whatsAppMonitorChoices.map(target => <div className="nativework-panel" key={target.jid}><p><strong>{target.label}</strong></p><p className="nativework-small nativework-muted">Stable JID: {target.jid}</p><button type="button" disabled={busy} onClick={() => setMonitorWhatsApp(target)}>Select this exact conversation</button></div>)}</div><ul className="nativework-stack">{whatsAppRows.map(row => <li key={row.id} className="nativework-panel"><p className="nativework-strong">{row.threadTitle}</p><p className="nativework-small nativework-muted">{row.fromMe ? 'You' : row.sender || 'Participant'} · {timeLabel(row.sentAt)} · {row.threadJid}</p><p className="nativework-prewrap">{row.text || '(Attachment or rich message)'}</p></li>)}</ul></>}
    </article>

    <article className="nativework-stack nativework-panel" aria-label="New SMS compose handoff">
      <h4 className="nativework-strong">New SMS compose handoff</h4><p className="nativework-muted">For a number without an existing thread, this opens the system sms: compose surface after review. Apple’s supported sms: link carries only the recipient; the text remains here for manual copy. Nothing is sent automatically.</p>
      <form className="nativework-stack" onSubmit={event => { event.preventDefault(); void operate(() => macConnectorService.prepareSmsDraft(smsPhone, smsText), setSmsReview); }}><label>Phone<input className="nativework-panel" required maxLength={40} value={smsPhone} onChange={event => { setSmsPhone(event.target.value); setSmsReview(null); }}/></label><label>Draft text<textarea className="nativework-panel" required maxLength={4000} rows={4} value={smsText} onChange={event => { setSmsText(event.target.value); setSmsReview(null); }}/></label><button disabled={busy}>Review unsent compose handoff</button></form>
      {smsReview && <ReviewCard review={smsReview} busy={busy} action={executeSmsReview} label="Open unsent system draft"/>}
    </article>

    <article className="nativework-stack nativework-panel" aria-label="Local read monitor settings">
      <h4 className="nativework-strong">Local read monitor</h4><p className="nativework-muted">While Crokodial Workspace is running, periodically check bounded Messages metadata and one explicitly selected WhatsApp conversation, even when its window is closed. Unchanged snapshots stay quiet. This monitor cannot send or modify anything.</p>
      <label className="nativework-row"><input type="checkbox" checked={monitorMessages} onChange={event => setMonitorMessages(event.target.checked)}/>Watch recent Messages threads</label>
      {monitorWhatsApp ? <div className="nativework-panel" role="group" aria-label="Selected WhatsApp monitor conversation"><p className="nativework-strong">Selected WhatsApp conversation</p><p>{monitorWhatsApp.label}</p><p className="nativework-small nativework-muted">Stable JID: {monitorWhatsApp.jid}</p><button type="button" disabled={busy} onClick={() => setMonitorWhatsApp(null)}>Remove WhatsApp selection</button></div> : <p className="nativework-small nativework-muted">No WhatsApp conversation selected. Search above, review the label and stable JID, then select one exact conversation.</p>}
      <label>Check every (minutes)<input type="number" min={1} max={30} value={monitorMinutes} onChange={event => setMonitorMinutes(Number(event.target.value))}/></label>
      <div className="nativework-row"><button type="button" disabled={busy || !monitorMessages && !monitorWhatsApp} onClick={() => void operate(() => startMacMonitor({ messages: monitorMessages, ...(monitorWhatsApp ? { whatsappConversation: monitorWhatsApp } : {}), intervalMinutes: monitorMinutes }, { agentId, sessionId }), setMonitorState)}>{monitorState.running ? 'Restart monitor with these settings' : 'Start monitor'}</button>{monitorState.running && <button type="button" disabled={busy} onClick={() => void operate(() => stopMacMonitor({ agentId, sessionId }), setMonitorState)}>Stop monitor</button>}</div>
      {monitorState.running && <p role="status">Active every {monitorState.configuration?.intervalMinutes} minute{monitorState.configuration?.intervalMinutes === 1 ? '' : 's'}{monitorState.configuration?.whatsappConversation ? ` · WhatsApp: ${monitorState.configuration.whatsappConversation.label} (${monitorState.configuration.whatsappConversation.jid})` : ''}{monitorState.snapshot ? ` · last observed ${new Date(monitorState.snapshot.observedAt).toLocaleString()}` : ''}.</p>}{monitorState.error && <p role="alert">{monitorState.error}</p>}
      {!!monitorState.snapshot?.errors.length && <ul aria-label="Local monitor read errors">{monitorState.snapshot.errors.map((item, index) => <li key={`${item.source}-${index}`} role="alert">{item.source}: {item.message}</li>)}</ul>}
      {!!monitorState.snapshot?.urgencyHints.length && <div className="nativework-panel"><p className="nativework-strong">New keyword-based attention hints</p><p className="nativework-small nativework-muted">Heuristic only. Review the original conversation before acting.</p><ul>{monitorState.snapshot.urgencyHints.slice(0, 10).map(hint => <li key={hint.observationId}><strong>{hint.threadTitle}</strong> · {hint.keywords.join(', ')}<p className="nativework-prewrap">{hint.preview}</p></li>)}</ul></div>}
    </article>

    {receipts.length > 0 && <article className="nativework-stack" aria-label="Mac connector receipts"><h4 className="nativework-strong">Receipts</h4>{receipts.map(receipt => <div className="nativework-panel" key={receipt.reviewId}><p className="nativework-strong">{receipt.state}</p><p>{receipt.message}</p>{receipt.error && <p className="nativework-error">{receipt.error}</p>}</div>)}</article>}
  </section>;
}
