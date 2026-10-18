import { useCallback, useEffect, useRef, useState } from 'react';
import { Mail, Loader2, Check } from 'lucide-react';
import { beginGmailConnection, getGmailStatus } from '../services/assistantWorkspaceApi';
import { gmailCapabilityDisclosure, gmailConnectionLabel, gmailConnectionReady, normalizeGmailCapabilities, type GmailCapability } from '../services/assistantConnections';

type GmailStatus = Awaited<ReturnType<typeof getGmailStatus>>;
export function NativeGmailConnection({ history = false, required, reason, onStatus, onConnected }: {
  history?: boolean; required?: GmailCapability[]; reason?: string;
  onStatus: (status: GmailStatus | null) => void; onConnected: () => void;
}) {
  const needs = normalizeGmailCapabilities(required?.length ? required : history ? ['history'] : ['send']);
  const needsKey = [...needs].sort().join(',');
  const [status, setStatus] = useState<GmailStatus | null>(null);
  const [error, setError] = useState(''), [checking, setChecking] = useState(true), [opening, setOpening] = useState(false);
  const [waiting, setWaiting] = useState(false), [connected, setConnected] = useState(false), [timedOut, setTimedOut] = useState(false);
  const alive = useRef(false), sequence = useRef(0), attempted = useRef(false), needsRef = useRef(needs);
  const callbacks = useRef({ onStatus, onConnected }); callbacks.current = { onStatus, onConnected }; needsRef.current = needs;
  const refresh = useCallback(async () => {
    const current = ++sequence.current; setChecking(true);
    try {
      const next = await getGmailStatus();
      if (!alive.current || sequence.current !== current) return;
      setStatus(next); setError(''); callbacks.current.onStatus(next);
      if (attempted.current && gmailConnectionReady(next, needsRef.current)) {
        attempted.current = false; setWaiting(false); setConnected(true); setTimedOut(false); callbacks.current.onConnected();
      }
    } catch (cause) {
      if (alive.current && sequence.current === current) { setStatus(null); setError(cause instanceof Error ? cause.message : 'Could not check Gmail.'); callbacks.current.onStatus(null); }
    } finally { if (alive.current && sequence.current === current) setChecking(false); }
  }, []);
  useEffect(() => {
    alive.current = true; void refresh();
    const focus = () => { if (!document.hidden) void refresh(); };
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    return () => { alive.current = false; sequence.current++; window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
  }, [refresh]);
  useEffect(() => { setConnected(false); if (alive.current) void refresh(); }, [needsKey, refresh]);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
    const timeout = setTimeout(() => { attempted.current = false; setWaiting(false); setTimedOut(true); }, 10 * 60 * 1000);
    return () => { clearInterval(timer); clearTimeout(timeout); };
  }, [waiting, refresh]);
  const ready = gmailConnectionReady(status, needs), label = gmailConnectionLabel(needs, status);
  async function connect() {
    setOpening(true); setError(''); setTimedOut(false);
    try {
      if (!window.dialer?.openExternal) throw new Error('Open Gmail connection from Crokodial Workspace.');
      const response = await beginGmailConnection(needs);
      if (!alive.current) return;
      await window.dialer.openExternal(response.authorizationUrl);
      if (!alive.current) return;
      attempted.current = true; setWaiting(true); setConnected(false);
      void refresh();
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Could not open Google connection.'); }
    finally { if (alive.current) setOpening(false); }
  }
  if (ready && !required && !connected && !error) return null;
  return <article className="assistant-work-card" aria-label="Gmail connection">
    <div className="assistant-card-heading">{ready ? <Check size={15}/> : <Mail size={15}/>}<strong>{ready ? 'Gmail connected' : label}</strong></div>
    <p>{ready ? `Your mailbox${(status?.mailboxEmail || status?.email) ? ` (${status.mailboxEmail || status.email})` : ''} is ready. Continue the saved request below; connecting never sends or changes a message.` : status && !status.configured ? 'Google email setup is unavailable on this server. Your conversation and drafts are saved.' : reason || (needs.includes('modify') ? 'Allow reviewed Gmail changes so the assistant can prepare one exact selected-thread action for your approval.' : needs.includes('mailbox_read') ? 'Allow Gmail search and history to find the right conversation and prepare your reply here.' : needs.includes('history') ? 'Allow access to linked email threads to reply and check for responses before a follow-up.' : 'Connect your Google account to prepare emails and review exact recipients and content before sending.')}</p>
    {!ready && status?.configured && <p>{gmailCapabilityDisclosure(needs)}</p>}
    {error && <p role="alert">{error} Your saved request has not been resumed.</p>}
    {waiting && !ready && <p role="status">Finish Google consent in your browser, then return here. Your original request stays saved in this conversation.</p>}
    {timedOut && !ready && <p role="status">Connection is still incomplete. Check the connection or open consent again; your saved request remains available.</p>}
    <div className="assistant-card-buttons">
      {!ready && status?.configured && <button disabled={opening || waiting} onClick={() => void connect()}>{opening ? <Loader2 className="spin" size={13}/> : <Mail size={13}/>} {label}</button>}
      {(!ready || required) && <button disabled={checking} onClick={() => void refresh()}>{checking ? 'Checking…' : 'Check connection'}</button>}
    </div>
  </article>;
}
