import { Check, Cloud, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { beginGoogleWorkspaceConnection, decideGoogleWorkspaceGrant, executeGoogleWorkspaceGrant, getGoogleWorkspaceStatus, listGoogleWorkspaceGrants } from '../services/assistantWorkspaceApi';
import type { GoogleWorkspaceConnectionStatus, GoogleWorkspaceToolGrant } from '../services/assistantWorkspaceTypes';
import type { GoogleWorkspaceCapability } from '../services/assistantConnections';

const readCapabilities = ['drive_read', 'sheets_read'] as const;
const writeCapabilities = ['drive_read', 'sheets_read', 'sheets_write'] as const;
const isWrite = (grant: GoogleWorkspaceToolGrant) => grant.tool === 'sheets.google.append' || grant.tool === 'sheets.google.update';
const visibleGrant = (grant: GoogleWorkspaceToolGrant) => ['pending', 'approved', 'executing', 'succeeded', 'unknown', 'failed'].includes(grant.state);
const pretty = (value: unknown) => {
  const text = JSON.stringify(value, null, 2) ?? String(value);
  return text.length <= 50_000 ? text : `${text.slice(0, 50_000)}\n…bounded preview truncated…`;
};

/** Connection and exact write approvals stay visible in the one permanent assistant conversation. */
export function NativeGoogleWorkspace({ agentId, required, onActivity }: { agentId: number; required?: readonly GoogleWorkspaceCapability[]; onActivity?: () => void }) {
  const [status, setStatus] = useState<GoogleWorkspaceConnectionStatus>();
  const [grants, setGrants] = useState<GoogleWorkspaceToolGrant[]>([]), [error, setError] = useState('');
  const [checking, setChecking] = useState(true), [opening, setOpening] = useState(false), [waiting, setWaiting] = useState(false), [busyId, setBusyId] = useState('');
  const alive = useRef(true), sequence = useRef(0), attempted = useRef<readonly ('drive_read' | 'sheets_read' | 'sheets_write')[]>([]), automatic = useRef(new Set<string>());
  const applyGrant = useCallback((grant: GoogleWorkspaceToolGrant) => setGrants(items => items.map(item => item.id === grant.id ? grant : item)), []);
  const runConnectedRead = useCallback(async (grant: GoogleWorkspaceToolGrant) => {
    if (isWrite(grant) || !['pending', 'approved'].includes(grant.state) || automatic.current.has(grant.id)) return;
    automatic.current.add(grant.id);
    try {
      const result = await executeGoogleWorkspaceGrant(agentId, grant);
      if (alive.current) { applyGrant(result.grant); onActivity?.(); }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Could not finish the Google Workspace read.'); }
    finally { automatic.current.delete(grant.id); }
  }, [agentId, applyGrant, onActivity]);
  const refresh = useCallback(async () => {
    const version = ++sequence.current;
    try {
      const [connection, saved] = await Promise.allSettled([getGoogleWorkspaceStatus(), listGoogleWorkspaceGrants(agentId)]);
      if (!alive.current || version !== sequence.current) return;
      if (connection.status === 'fulfilled') {
        setStatus(connection.value);
        if (attempted.current.length && connection.value.connected && attempted.current.every(item => connection.value.capabilities.includes(item))) { attempted.current = []; setWaiting(false); onActivity?.(); }
      } else setError(connection.reason instanceof Error ? connection.reason.message : 'Could not check Google Workspace.');
      if (saved.status === 'fulfilled') {
        setGrants(saved.value.grants);
        for (const grant of saved.value.grants) void runConnectedRead(grant);
      } else if (connection.status === 'fulfilled') setError(saved.reason instanceof Error ? saved.reason.message : 'Could not load Google Workspace activity.');
      if (connection.status === 'fulfilled' && saved.status === 'fulfilled') setError('');
    } finally { if (alive.current && version === sequence.current) setChecking(false); }
  }, [agentId, onActivity, runConnectedRead]);
  useEffect(() => {
    alive.current = true; void refresh();
    const focus = () => { if (!document.hidden) void refresh(); };
    const timer = setInterval(focus, 5000); window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    return () => { alive.current = false; sequence.current++; clearInterval(timer); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
  }, [refresh]);
  async function connect(capabilities: readonly ('drive_read' | 'sheets_read' | 'sheets_write')[]) {
    setOpening(true); setError('');
    try {
      if (!window.dialer?.openExternal) throw new Error('Open Google Workspace connection from the native app.');
      const connection = await beginGoogleWorkspaceConnection([...capabilities]);
      await window.dialer.openExternal(connection.authorizationUrl);
      if (!alive.current) return; attempted.current = capabilities; setWaiting(true); void refresh();
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Could not open Google Workspace connection.'); }
    finally { if (alive.current) setOpening(false); }
  }
  async function decide(grant: GoogleWorkspaceToolGrant, decision: 'approve' | 'reject') {
    setBusyId(grant.id); setError('');
    try { const result = await decideGoogleWorkspaceGrant(agentId, grant, decision); if (alive.current) { setGrants(items => items.map(item => item.id === grant.id ? result.grant : item)); onActivity?.(); } }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Could not record the Google Sheets decision.'); }
    finally { if (alive.current) setBusyId(''); }
  }
  async function execute(grant: GoogleWorkspaceToolGrant) {
    setBusyId(grant.id); setError('');
    try { const result = await executeGoogleWorkspaceGrant(agentId, grant); if (alive.current) { setGrants(items => items.map(item => item.id === grant.id ? result.grant : item)); onActivity?.(); } }
    catch (cause) { if (alive.current) { setError(cause instanceof Error ? cause.message : 'Google Sheets outcome could not be confirmed.'); void refresh(); } }
    finally { if (alive.current) setBusyId(''); }
  }
  // OAuth is deliberately non-incremental, so retain capabilities already
  // granted to this same account while adding only the requested prerequisite.
  const requestedCapabilities: readonly GoogleWorkspaceCapability[] = required?.length
    ? [...new Set<GoogleWorkspaceCapability>([...(status?.capabilities ?? []), ...required])]
    : readCapabilities;
  const requiredReady = Boolean(status?.connected && requestedCapabilities.every(item => status.capabilities.includes(item)));
  const readReady = Boolean(status?.connected && readCapabilities.every(item => status.capabilities.includes(item)));
  const writeReady = Boolean(status?.connected && writeCapabilities.every(item => status.capabilities.includes(item)));
  const visible = grants.filter(visibleGrant);
  if ((required ? requiredReady : writeReady) && !visible.length && !error && !waiting) return null;
  return <article className="assistant-work-card" aria-label="Google Workspace connection and actions">
    <div className="assistant-card-heading">{requiredReady ? <Check size={15}/> : <Cloud size={15}/>}<strong>{requiredReady ? 'Google Workspace connected' : 'Connect Google Workspace'}</strong></div>
    <p>{readReady ? `Drive and Sheets are connected${status?.email ? ` as ${status.email}` : ''}. Reads stay bounded; every Sheet write is reviewed here first.` : status && !status.configured ? 'Google Drive and Sheets are not configured on this server. Your conversation remains saved.' : 'Connect Google Drive and Sheets to find plan files and read sales sheets directly from this chat.'}</p>
    {!readReady && status?.configured && <p>The first connection requests read-only Drive and Sheets access. It does not grant Gmail, Calendar, Contacts, or Sheet write access.</p>}
    {readReady && !writeReady && status?.configured && <p>Updating Google Sheets is optional. Enable it separately, then every exact Sheet write still requires approval and one-use execution in this chat.</p>}
    {waiting && <p role="status">Finish Google consent in your browser, then return here. This chat and its request stay saved.</p>}
    {error && <p role="alert">{error}</p>}
    <div className="assistant-card-buttons">{!requiredReady && status?.configured && <button disabled={opening} onClick={() => void connect(requestedCapabilities)}>{opening ? <Loader2 className="spin" size={13}/> : <Cloud size={13}/>} {waiting ? 'Start connection again' : 'Connect Google Workspace'}</button>}{!required && readReady && !writeReady && status?.configured && <button disabled={opening} onClick={() => void connect(writeCapabilities)}>{opening ? <Loader2 className="spin" size={13}/> : <Cloud size={13}/>} {waiting ? 'Start permission upgrade again' : 'Enable reviewed Sheet writes'}</button>}<button disabled={checking} onClick={() => void refresh()}>{checking ? 'Checking…' : 'Check connection'}</button></div>
    {visible.map(grant => <section key={grant.id} className="nativework nativework-panel" aria-label="Google Workspace action review">
      <h3>{grant.tool}</h3><p><strong>{grant.state.replace(/_/g, ' ')}</strong> · {grant.destination}</p><pre>{pretty(grant.args)}</pre>{grant.message && <p role="status">{grant.message}</p>}
      {grant.result && <details><summary>Provider receipt</summary><pre>{pretty(grant.result)}</pre></details>}
      {grant.state === 'unknown' && <p role="alert">{isWrite(grant) ? 'Inspect the destination sheet before preparing another write.' : 'Prepare a new bounded read if you still need this result.'} This action will not be retried automatically.</p>}
      <div className="assistant-card-buttons">{grant.state === 'pending' && isWrite(grant) && <><button disabled={busyId === grant.id} onClick={() => void decide(grant, 'approve')}>Approve exact Sheet write</button><button disabled={busyId === grant.id} onClick={() => void decide(grant, 'reject')}>Reject</button></>}{grant.state === 'approved' && isWrite(grant) && <button disabled={busyId === grant.id} onClick={() => void execute(grant)}>Execute approved write once</button>}{['pending', 'approved'].includes(grant.state) && !isWrite(grant) && <p role="status"><Loader2 className="spin" size={13}/> Reading the connected Google account…</p>}</div>
    </section>)}
  </article>;
}
