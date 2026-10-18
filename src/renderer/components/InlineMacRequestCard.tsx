import { useCallback, useEffect, useMemo, useState } from 'react';
import { macConnectorService } from '../services/macConnectorService';
import { parseMacChatRequest, runMacChatRead, type MacChatReadResult, type MacChatRequest } from '../services/macChatRequest';
import type { MacConnectorReceipt, MacConnectorReview, MacConnectorStatus, MacMessageThread, MacThreadMessage, MacWriteOrigin } from '../services/macConnectorTypes';
import type { PrepareSheetAppendReview } from './NativeSheetAppendPreparation';
import { NativeWhatsAppSalesExtraction } from './NativeWhatsAppSalesExtraction';

const time = (value: string | null) => value ? new Date(value).toLocaleString() : 'Time unavailable';

function title(kind: NonNullable<ReturnType<typeof parseMacChatRequest>>['kind']): string {
  if (kind === 'contacts.search') return 'Local Contacts request';
  if (kind === 'whatsapp.read') return 'Local WhatsApp read-only request';
  if (kind === 'messages.read') return 'Local Messages request';
  if (kind === 'messages.send') return 'Reviewed Messages request';
  return 'Unsent SMS compose request';
}

function ExactReview({ review, busy, onExecute }: { review: MacConnectorReview; busy: boolean; onExecute: () => void }) {
  const payload = review.payload as { thread?: MacMessageThread; phone?: string; text?: string };
  return <section className="assistant-inline-mac-review" aria-label="Exact local action review">
    <strong>Exact one-use review</strong>
    <p>{review.summary}</p>
    {payload.thread && <p>Existing thread: {payload.thread.title}<br/><span className="assistant-inline-mac-meta">Participants: {payload.thread.participants.join(', ') || 'Unavailable'} · {payload.thread.service || 'Unknown service'}</span></p>}
    {payload.phone && <p>Recipient: {payload.phone}</p>}
    {payload.text && <p className="assistant-inline-mac-exact">{payload.text}</p>}
    <p className="assistant-inline-mac-meta">Expires {new Date(review.expiresAt).toLocaleString()} · digest {review.digest.slice(0, 12)}</p>
    <button type="button" disabled={busy} onClick={onExecute}>{review.kind === 'messages.send' ? 'Submit this exact message once' : 'Open recipient-only unsent compose'}</button>
  </section>;
}

/**
 * A deterministic companion to a persisted user turn. It intentionally stores
 * no separate conversation/session state: reloads re-create the card from the
 * saved turn text, while every local read or reviewed action remains explicit.
 */
export function InlineMacRequestCard({ turnId, requestId, persisted = true, text, agentId, sessionId, conversationKey, prepareSheetAppend, onPendingStateChange, onActivity }: { turnId: string; requestId?: string; persisted?: boolean; text: string; agentId?: number; sessionId?: string; conversationKey?: string; prepareSheetAppend?: PrepareSheetAppendReview; onPendingStateChange?: (turnId: string, state: { dirty: boolean; busy: boolean }) => void; onActivity?: () => void }) {
  const request = useMemo(() => parseMacChatRequest(text), [text]);
  return request ? <ResolvedMacRequestCard turnId={turnId} requestId={requestId} persisted={persisted} turnText={text} request={request} agentId={agentId} sessionId={sessionId} conversationKey={conversationKey} prepareSheetAppend={prepareSheetAppend} onPendingStateChange={onPendingStateChange} onActivity={onActivity}/> : null;
}

function ResolvedMacRequestCard({ turnId, requestId, persisted, turnText, request: parsed, agentId, sessionId, conversationKey, prepareSheetAppend, onPendingStateChange, onActivity }: { turnId: string; requestId?: string; persisted: boolean; turnText: string; request: MacChatRequest; agentId?: number; sessionId?: string; conversationKey?: string; prepareSheetAppend?: PrepareSheetAppendReview; onPendingStateChange?: (turnId: string, state: { dirty: boolean; busy: boolean }) => void; onActivity?: () => void }) {
  const [status, setStatus] = useState<MacConnectorStatus>();
  const [result, setResult] = useState<MacChatReadResult>();
  const [thread, setThread] = useState<MacMessageThread>();
  const [messages, setMessages] = useState<MacThreadMessage[]>([]);
  const [review, setReview] = useState<MacConnectorReview>();
  const [receipt, setReceipt] = useState<MacConnectorReceipt>();
  const [revision, setRevision] = useState(1);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const onSheetStateChange = useCallback((state: { dirty: boolean; busy: boolean }) => onPendingStateChange?.(turnId, state), [onPendingStateChange, turnId]);
  const writeOrigin = useMemo<MacWriteOrigin | undefined>(() => agentId && sessionId && conversationKey && persisted ? { conversationKey, agentId, sessionId, turnId, ...(requestId ? { requestId } : {}), turnText, revision } : undefined,
    [agentId, sessionId, conversationKey, persisted, turnId, requestId, turnText, revision]);

  useEffect(() => {
    if (!writeOrigin || parsed.kind !== 'messages.send') return;
    let current = true;
    void macConnectorService.restoreReviewedWrite(writeOrigin, 'messages.send').then(snapshot => {
      if (!current) return;
      setRevision(snapshot.nextRevision);
      if (snapshot.state === 'pending') { setReview(snapshot.review); setReceipt(undefined); }
      else if (snapshot.state !== 'none') { setReceipt(snapshot.receipt); setReview(undefined); }
    }).catch(cause => { if (current) setError(cause instanceof Error ? cause.message : 'Saved local write receipts could not be restored.'); });
    return () => { current = false; };
  }, [parsed.kind, writeOrigin?.conversationKey, writeOrigin?.agentId, writeOrigin?.turnId, writeOrigin?.requestId, writeOrigin?.turnText]);

  async function operate<T>(work: () => Promise<T>, complete: (value: T) => void) {
    if (busy) return;
    setBusy(true); setError('');
    try { complete(await work()); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The local request could not be completed.'); }
    finally { setBusy(false); }
  }

  function checkAccess(connector: 'contacts' | 'messages') {
    void operate(() => macConnectorService.requestAccess(connector), value => setStatus(value));
  }

  function read() {
    if (parsed.kind === 'sms.compose') return;
    void operate(() => runMacChatRead(parsed, macConnectorService), value => { setResult(value); setThread(undefined); setMessages([]); });
  }

  function openThread(value: MacMessageThread) {
    void operate(() => macConnectorService.readMessageThread(value.id), response => { setThread(response.thread); setMessages(response.messages); setReview(undefined); });
  }

  function prepareThreadSend(value: MacMessageThread) {
    if (parsed.kind !== 'messages.send') return;
    if (!writeOrigin) { setError('Wait for this request to appear in the saved conversation before reviewing a local write.'); return; }
    void operate(() => macConnectorService.prepareMessageSend(value.id, parsed.text, writeOrigin), value => { setReview(value); setReceipt(undefined); });
  }

  function prepareSms() {
    const details = parsed.kind === 'sms.compose' ? parsed : parsed.kind === 'messages.send' && parsed.phone ? { phone: parsed.phone, text: parsed.text } : undefined;
    if (!details) return;
    void operate(() => macConnectorService.prepareSmsDraft(details.phone, details.text), value => setReview(value));
  }

  function executeReview() {
    if (!review) return;
    if (review.kind === 'messages.send' && !writeOrigin) { setError('Reopen the active saved conversation before executing this review.'); return; }
    void operate(
      () => review.kind === 'messages.send' ? macConnectorService.executeMessageSend(review, writeOrigin!) : macConnectorService.openSmsDraft(review),
      value => { setReceipt(value); setReview(undefined); onActivity?.(); },
    );
  }

  function reconcile(resolution: 'applied' | 'not_applied') {
    if (!receipt || receipt.state !== 'unknown') return;
    if (!writeOrigin) { setError('Reopen the active saved conversation before reconciling this receipt.'); return; }
    void operate(() => macConnectorService.reconcileReviewedWrite(receipt, resolution, writeOrigin), snapshot => {
      if (snapshot.state === 'none' || snapshot.state === 'pending') return;
      setReceipt(snapshot.receipt); setRevision(snapshot.nextRevision); onActivity?.();
    });
  }

  const messagesResult = result?.kind === 'messages.read' || result?.kind === 'messages.send' ? result : undefined;
  const contactsResult = result?.kind === 'contacts.search' ? result : undefined;
  const whatsAppResult = result?.kind === 'whatsapp.read' ? result : undefined;
  const contactsReady = status?.contacts.state === 'available';
  const messagesHistoryReady = !status || status.messagesHistory.state === 'available';
  const messagesSendReady = status?.messagesSend.state === 'available';
  const whatsAppReady = !status || status.whatsapp.state === 'available';

  return <article className="assistant-work-card assistant-inline-mac" aria-label={`${title(parsed.kind)} for saved message`} data-turn-id={turnId}>
    <div className="assistant-card-heading"><strong>{title(parsed.kind)}</strong><span>On this Mac</span></div>
    {parsed.kind === 'contacts.search' && <><p>{parsed.unknownNumber ? `Match the unknown number ${parsed.query} against Mac/iCloud Contacts.` : `Search Mac/iCloud Contacts for “${parsed.query}”.`} Results are limited to 100 records.</p>{!contactsReady && <p className="assistant-inline-mac-meta">{status?.contacts.detail ?? 'Checking Contacts access…'}</p>}<div className="assistant-card-buttons">{!contactsReady && <button type="button" disabled={busy} onClick={() => checkAccess('contacts')}>Check Contacts access</button>}<button type="button" disabled={busy || !contactsReady} onClick={read}>{parsed.unknownNumber ? 'Match number in Contacts' : 'Search local Contacts'}</button></div></>}
    {parsed.kind === 'whatsapp.read' && <><p>Search the supported local WhatsApp store for “{parsed.query}”. This is read-only and limited to 100 observations.</p>{!whatsAppReady && <p className="assistant-inline-mac-meta">{status?.whatsapp.detail}</p>}<div className="assistant-card-buttons"><button type="button" disabled={busy || !whatsAppReady} onClick={read}>Search local WhatsApp read-only</button></div></>}
    {parsed.kind === 'messages.read' && <><p>{parsed.query ? `Find existing Apple Messages threads matching “${parsed.query}”.` : 'List the 50 most recent Apple Messages threads.'} Opening a thread reads at most 100 recent messages.</p>{!messagesHistoryReady && <p className="assistant-inline-mac-meta">{status?.messagesHistory.detail}</p>}<div className="assistant-card-buttons"><button type="button" disabled={busy || !messagesHistoryReady} onClick={read}>Find existing Messages threads</button></div></>}
    {parsed.kind === 'messages.send' && <><p>Find an existing Apple Messages thread for “{parsed.target}”, inspect its participants and recent history, then prepare this exact text:</p><p className="assistant-inline-mac-exact">{parsed.text}</p><p>No message is sent by this search or by preparing a review. The write receipt is bound to this saved conversation turn.</p>{!persisted && <p className="assistant-inline-mac-warning">Wait for this message to be saved in the permanent conversation before reviewing a send.</p>}{!messagesHistoryReady && <p className="assistant-inline-mac-meta">{status?.messagesHistory.detail}</p>}<div className="assistant-card-buttons"><button type="button" disabled={busy || !messagesHistoryReady} onClick={read}>Find existing Messages thread</button>{parsed.phone && <button type="button" disabled={busy} onClick={prepareSms}>Review new-number unsent compose</button>}</div></>}
    {parsed.kind === 'sms.compose' && <><p>Prepare an unsent system compose addressed to {parsed.phone}. Apple’s supported handoff carries only the recipient; copy the reviewed text manually after the system composer opens.</p><p className="assistant-inline-mac-exact">{parsed.text}</p><div className="assistant-card-buttons"><button type="button" disabled={busy} onClick={prepareSms}>Review recipient-only compose handoff</button></div></>}

    {error && <p className="assistant-error" role="alert">{error}</p>}
    {busy && <p role="status">Working on the bounded local request…</p>}

    {contactsResult && <section aria-label="Local Contacts observations"><p className="assistant-inline-mac-warning">Untrusted local evidence: verify contact names and numbers before using them.</p>{contactsResult.contacts.length ? <ul>{contactsResult.contacts.map(contact => <li key={contact.id}><strong>{contact.name || contact.organization || 'Unnamed contact'}</strong><br/><span className="assistant-inline-mac-meta">{[...contact.phones, ...contact.emails].join(' · ') || 'No phone or email'}</span></li>)}</ul> : <p>No local Contacts match was found.</p>}</section>}
    {whatsAppResult && <section aria-label="Local WhatsApp observations"><p className="assistant-inline-mac-warning">Untrusted local evidence: verify conversation identity and content before relying on it.</p>{whatsAppResult.observations.length ? <><ul>{whatsAppResult.observations.map(row => <li key={row.id}><strong>{row.threadTitle}</strong> · {row.fromMe ? 'You' : row.sender || 'Participant'} · {time(row.sentAt)}<p className="assistant-inline-mac-exact">{row.text || '(Attachment or rich message)'}</p></li>)}</ul>{agentId && prepareSheetAppend && <NativeWhatsAppSalesExtraction agentId={agentId} turnId={turnId} query={parsed.kind === 'whatsapp.read' ? parsed.query : ''} observedAt={whatsAppResult.observedAt} observations={whatsAppResult.observations} prepareRequest={prepareSheetAppend} onStateChange={onSheetStateChange} onActivity={onActivity}/>}</> : <p>No read-only WhatsApp match was found.</p>}</section>}
    {messagesResult && <section aria-label="Local Messages thread observations"><p className="assistant-inline-mac-warning">Untrusted local evidence: verify thread participants and message content before acting.</p>{messagesResult.threads.length ? <ul>{messagesResult.threads.map(row => <li key={row.id}><strong>{row.title}</strong><br/><span className="assistant-inline-mac-meta">{row.participants.join(', ') || 'Participants unavailable'} · {time(row.lastMessageAt)}</span><div className="assistant-card-buttons"><button type="button" disabled={busy} onClick={() => openThread(row)}>{parsed.kind === 'messages.send' ? 'Inspect thread before review' : 'Read bounded thread history'}</button></div></li>)}</ul> : <p>No existing Messages thread matched.{parsed.kind === 'messages.send' && parsed.phone ? ' You may review the recipient-only unsent compose handoff above.' : ''}</p>}</section>}
    {thread && <section aria-label="Selected local Messages history"><p className="assistant-inline-mac-warning">Untrusted local evidence: confirm these participants before any send.</p><strong>{thread.title}</strong><p className="assistant-inline-mac-meta">{thread.participants.join(', ') || 'Participants unavailable'} · {thread.service || 'Unknown service'}</p>{messages.length ? <ol>{messages.map(message => <li key={message.id}><span className="assistant-inline-mac-meta">{message.fromMe ? 'You' : message.sender || 'Participant'} · {time(message.sentAt)}</span><p className="assistant-inline-mac-exact">{message.text || '(Attachment or rich message)'}</p></li>)}</ol> : <p>No readable messages were returned.</p>}{parsed.kind === 'messages.send' && <div className="assistant-card-buttons">{!messagesSendReady && <button type="button" disabled={busy} onClick={() => checkAccess('messages')}>Check Messages send access</button>}<button type="button" disabled={busy || !messagesSendReady} onClick={() => prepareThreadSend(thread)}>Review exact send to this thread</button></div>}</section>}
    {review && <ExactReview review={review} busy={busy} onExecute={executeReview}/>}
    {receipt && <section aria-label="Local action receipt"><strong>{receipt.state.replace(/_/g, ' ')}</strong><p>{receipt.message}</p>{receipt.error && <p className="assistant-error">{receipt.error}</p>}<p className="assistant-inline-mac-meta">Review {receipt.reviewId}. This durable one-use receipt is bound to this owner, profile, saved turn and canonical payload.</p>{receipt.state === 'unknown' && parsed.kind === 'messages.send' && <><p role="alert">Inspect the saved Messages thread first. Crokodial will not prepare or replay this write while its outcome is unresolved.</p><div className="assistant-card-buttons"><button type="button" disabled={busy || !thread} onClick={() => reconcile('applied')}>I inspected it · message is present</button><button type="button" disabled={busy || !thread} onClick={() => reconcile('not_applied')}>I inspected it · message is absent</button></div></>}{receipt.state === 'reconciled' && receipt.resolution === 'not_applied' && <button type="button" disabled={busy} onClick={() => { setReceipt(undefined); setReview(undefined); }}>Start separately reviewed revision {revision}</button>}</section>}
  </article>;
}
