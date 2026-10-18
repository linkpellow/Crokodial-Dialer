import { CalendarDays, Check, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest, platformUrl } from '../services/assistantApiService';
import { workspaceRequest } from '../services/assistantWorkspaceApi';

type Provider = 'google' | 'calendly';
type Connection = { connected: boolean; syncEnabled: boolean; accountEmail?: string | null };
type Status = { google: Connection; calendly: Connection };
type Launch = { provider: Provider; authorizationUrl: string; expiresAt: string };

const endpoint: Record<Provider, { connect: string; authorize: string; label: string }> = {
  google: { connect: '/api/auth/google/calendar/desktop/connect', authorize: '/api/auth/google/calendar/desktop/authorize', label: 'Google Calendar' },
  calendly: { connect: '/api/calendly/oauth/desktop/connect', authorize: '/api/calendly/oauth/desktop/authorize', label: 'Calendly' },
};

/** Calendar consent starts inside the permanent chat and hands only a one-use launch ticket to the browser. */
export function NativeCalendarConnections({ agentId, required, onActivity }: { agentId: number; required?: Provider; onActivity?: () => void }) {
  const [status, setStatus] = useState<Status>();
  const [busy, setBusy] = useState<Provider>(), [waiting, setWaiting] = useState<Provider>(), [checking, setChecking] = useState(true), [error, setError] = useState('');
  const alive = useRef(true), sequence = useRef(0), waitingRef = useRef<Provider>(), reportedReady = useRef(false);
  const refresh = useCallback(async () => {
    const version = ++sequence.current;
    try {
      const value = await workspaceRequest<Status>(agentId, '/business/scheduling/status');
      if (!alive.current || version !== sequence.current) return;
      setStatus(value); setError('');
      const provider = waitingRef.current;
      if ((provider === 'google' && value.google.connected && value.google.syncEnabled) || (provider === 'calendly' && value.calendly.connected && value.calendly.syncEnabled)) {
        waitingRef.current = undefined; setWaiting(undefined); onActivity?.();
      }
      const requiredReady = required === 'google' ? value.google.connected && value.google.syncEnabled : required === 'calendly' ? value.calendly.connected && value.calendly.syncEnabled : false;
      if (requiredReady && !reportedReady.current) { reportedReady.current = true; onActivity?.(); }
      if (!requiredReady) reportedReady.current = false;
    } catch (cause) { if (alive.current && version === sequence.current) setError(cause instanceof Error ? cause.message : 'Could not check calendar connections.'); }
    finally { if (alive.current && version === sequence.current) setChecking(false); }
  }, [agentId, onActivity, required]);
  useEffect(() => {
    alive.current = true; void refresh();
    const focus = () => { if (!document.hidden) void refresh(); };
    const timer = setInterval(focus, 5000); window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    return () => { alive.current = false; sequence.current++; clearInterval(timer); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
  }, [refresh]);

  async function connect(provider: Provider) {
    if (busy) return;
    setBusy(provider); setError('');
    try {
      if (!window.dialer?.openExternal) throw new Error(`Open ${endpoint[provider].label} from Crokodial Workspace.`);
      const launch = await apiRequest<Launch>(endpoint[provider].connect, { method: 'POST', body: '{}' });
      const origin = new URL(platformUrl('/')), url = new URL(launch.authorizationUrl, origin);
      if (launch.provider !== provider || url.origin !== origin.origin || url.pathname !== endpoint[provider].authorize || url.username || url.password || url.hash
        || url.searchParams.getAll('ticket').length !== 1 || !/^[a-f0-9]{64}$/.test(url.searchParams.get('ticket') ?? '')
        || [...url.searchParams.keys()].some(key => key !== 'ticket') || !Number.isFinite(Date.parse(launch.expiresAt)) || Date.parse(launch.expiresAt) <= Date.now()) {
        throw new Error(`${endpoint[provider].label} returned an invalid connection link.`);
      }
      await window.dialer.openExternal(url.href);
      if (alive.current) { waitingRef.current = provider; setWaiting(provider); void refresh(); }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : `Could not open ${endpoint[provider].label}.`); }
    finally { if (alive.current) setBusy(undefined); }
  }

  const googleReady = Boolean(status?.google.connected && status.google.syncEnabled), calendlyReady = Boolean(status?.calendly.connected && status.calendly.syncEnabled);
  if (googleReady && calendlyReady && !waiting && !error) return null;
  return <article className="assistant-work-card" aria-label="Calendar connections">
    <div className="assistant-card-heading">{googleReady || calendlyReady ? <Check size={15}/> : <CalendarDays size={15}/>}<strong>Connect calendars</strong></div>
    <p>Connect scheduling accounts from this chat. Browser consent receives a one-use launch link; it cannot see your Crokodial session token.</p>
    {status && <p>Google Calendar: {googleReady ? `connected${status.google.accountEmail ? ` as ${status.google.accountEmail}` : ''}` : 'not connected'} · Calendly: {calendlyReady ? `connected${status.calendly.accountEmail ? ` as ${status.calendly.accountEmail}` : ''}` : status.calendly.connected ? 'finishing initial sync' : 'not connected'}.</p>}
    {waiting && <p role="status">Finish {endpoint[waiting].label} consent in your browser, then return here. This conversation stays open.</p>}
    {error && <p role="alert">{error}</p>}
    <div className="assistant-card-buttons">
      {(!required || required === 'google') && !googleReady && <button disabled={Boolean(busy)} onClick={() => void connect('google')}>{busy === 'google' ? <Loader2 className="spin" size={13}/> : <CalendarDays size={13}/>} Connect Google Calendar</button>}
      {(!required || required === 'calendly') && !calendlyReady && <button disabled={Boolean(busy)} onClick={() => void connect('calendly')}>{busy === 'calendly' ? <Loader2 className="spin" size={13}/> : <CalendarDays size={13}/>} Connect Calendly</button>}
      <button disabled={checking || Boolean(busy)} onClick={() => void refresh()}>{checking ? 'Checking…' : 'Check calendar connections'}</button>
    </div>
  </article>;
}
