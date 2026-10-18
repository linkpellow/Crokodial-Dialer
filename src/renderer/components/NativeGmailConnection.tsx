import { useCallback, useEffect, useRef, useState } from 'react';
import { Mail, Loader2, Check } from 'lucide-react';
import { beginGmailConnection, getGmailStatus } from '../services/assistantWorkspaceApi';

type GmailStatus = Awaited<ReturnType<typeof getGmailStatus>>;
export function NativeGmailConnection({ history, onStatus, onConnected }: {
  history: boolean; onStatus: (status: GmailStatus | null) => void; onConnected: () => void;
}) {
  const [status, setStatus] = useState<GmailStatus | null>(null);
  const [error, setError] = useState(''), [checking, setChecking] = useState(true), [opening, setOpening] = useState(false);
  const [waiting, setWaiting] = useState(false), [connected, setConnected] = useState(false);
  const alive = useRef(false), sequence = useRef(0), attempted = useRef(false), needsHistory = useRef(history);
  const callbacks = useRef({ onStatus, onConnected }); callbacks.current = { onStatus, onConnected }; needsHistory.current = history;
  const refresh = useCallback(async () => {
    const current = ++sequence.current; setChecking(true);
    try {
      const next = await getGmailStatus();
      if (!alive.current || sequence.current !== current) return;
      setStatus(next); setError(''); callbacks.current.onStatus(next);
      if (attempted.current && next.connected && (!needsHistory.current || next.historyConnected)) {
        attempted.current = false; setWaiting(false); setConnected(true); callbacks.current.onConnected();
      }
    } catch (cause) {
      if (alive.current && sequence.current === current) { setError(cause instanceof Error ? cause.message : 'Could not check Gmail.'); callbacks.current.onStatus(null); }
    } finally { if (alive.current && sequence.current === current) setChecking(false); }
  }, []);
  useEffect(() => {
    alive.current = true; void refresh();
    const focus = () => { if (!document.hidden) void refresh(); };
    window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    return () => { alive.current = false; sequence.current++; window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
  }, [refresh]);
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 5000);
    const timeout = setTimeout(() => { attempted.current = false; setWaiting(false); }, 10 * 60 * 1000);
    return () => { clearInterval(timer); clearTimeout(timeout); };
  }, [waiting, refresh]);
  const ready = status?.connected && (!history || status.historyConnected);
  async function connect() {
    setOpening(true); setError('');
    try {
      if (!window.dialer?.openExternal) throw new Error('Open Gmail connection from Crokodial Workspace.');
      const response = await beginGmailConnection(history);
      if (!alive.current) return;
      await window.dialer.openExternal(response.authorizationUrl);
      if (!alive.current) return;
      attempted.current = true; setWaiting(true); setConnected(false);
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Could not open Google connection.'); }
    finally { if (alive.current) setOpening(false); }
  }
  if (ready && !connected && !error) return null;
  return <article className="assistant-work-card" aria-label="Gmail connection">
    <div className="assistant-card-heading">{ready ? <Check size={15}/> : <Mail size={15}/>}<strong>{ready ? 'Gmail connected' : history && status?.connected ? 'Connect email history' : 'Connect Gmail'}</strong></div>
    <p>{ready ? 'Your mailbox is ready. Continue reviewing your email here.' : status && !status.configured ? 'Google email setup is unavailable on this server. Your conversation and drafts are saved.' : history ? 'Allow access to linked email threads to reply and check for responses before a follow-up.' : 'Connect your Google account to send emails after reviewing the exact message.'}</p>
    {error && <p role="alert">{error}</p>}
    {waiting && !ready && <p role="status">Finish Google consent in your browser, then return here. Your message stays in this conversation.</p>}
    <div className="assistant-card-buttons">
      {!ready && status?.configured && <button disabled={opening} onClick={() => void connect()}>{opening ? <Loader2 className="spin" size={13}/> : <Mail size={13}/>} {history ? 'Connect email history' : 'Connect Gmail'}</button>}
      {!ready && <button disabled={checking} onClick={() => void refresh()}>{checking ? 'Checking…' : 'Check connection'}</button>}
    </div>
  </article>;
}
