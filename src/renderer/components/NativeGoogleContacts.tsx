import { Check, Cloud, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  beginGoogleContactsConnection,
  decideGoogleContactsGrant,
  executeGoogleContactsGrant,
  getGoogleContactsStatus,
  listGoogleContactsGrants,
  prepareGoogleContactsRequest,
} from '../services/assistantWorkspaceApi';
import type { GoogleContactsConnectionStatus, GoogleContactsToolGrant } from '../services/assistantWorkspaceTypes';
import type { GoogleContactsCapability } from '../services/assistantConnections';
import { macConnectorService } from '../services/macConnectorService';
import type { MacConnectorReceipt, MacConnectorReview, MacContact, MacContactChange } from '../services/macConnectorTypes';

const readCapability = ['contacts_read'] as const;
const writeCapabilities = ['contacts_read', 'contacts_write'] as const;
const isWrite = (grant: GoogleContactsToolGrant) => grant.tool === 'contacts.google.create' || grant.tool === 'contacts.google.update';
const visibleGrant = (grant: GoogleContactsToolGrant) => ['pending', 'approved', 'executing', 'succeeded', 'unknown', 'failed'].includes(grant.state);
const pretty = (value: unknown) => {
  const text = JSON.stringify(value, null, 2) ?? String(value);
  return text.length <= 50_000 ? text : `${text.slice(0, 50_000)}\n…bounded preview truncated…`;
};
type TransferCandidate = {
  source: { resourceName: string; etag: string };
  proposedLocalCreate: { firstName: string; lastName: string; organization: string; emails: string[]; phones: string[] };
  mode: 'create_only'; requiresLocalMacReview: true;
};
type LocalReview = { review: MacConnectorReview<MacContactChange>; candidate: TransferCandidate; matches: MacContact[] };

function googleContactLabel(value: unknown): string {
  if (!value || typeof value !== 'object') return 'Existing Google contact';
  const contact = value as Record<string, unknown>;
  const names = Array.isArray(contact.names) ? contact.names : [];
  const emails = Array.isArray(contact.emailAddresses) ? contact.emailAddresses : [];
  const phones = Array.isArray(contact.phoneNumbers) ? contact.phoneNumbers : [];
  const name = names[0] && typeof names[0] === 'object' ? String((names[0] as Record<string, unknown>).displayName ?? '') : '';
  const email = emails[0] && typeof emails[0] === 'object' ? String((emails[0] as Record<string, unknown>).value ?? '') : '';
  const phone = phones[0] && typeof phones[0] === 'object' ? String((phones[0] as Record<string, unknown>).value ?? '') : '';
  return [name || 'Existing Google contact', email || phone].filter(Boolean).join(' · ');
}

function transferCandidates(grant: GoogleContactsToolGrant): TransferCandidate[] {
  const raw = grant.result?.candidates;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is TransferCandidate => Boolean(item && typeof item === 'object'
    && (item as TransferCandidate).mode === 'create_only' && (item as TransferCandidate).requiresLocalMacReview
    && typeof (item as TransferCandidate).source?.resourceName === 'string'
    && typeof (item as TransferCandidate).proposedLocalCreate?.firstName === 'string'
    && Array.isArray((item as TransferCandidate).proposedLocalCreate?.emails)
    && Array.isArray((item as TransferCandidate).proposedLocalCreate?.phones))).slice(0, 30);
}

/** Google People access stays separate from Gmail/Calendar/Drive; local transfer is create-only and separately reviewed. */
export function NativeGoogleContacts({ agentId, sessionId, conversationKey, required, onActivity }: { agentId: number; sessionId: string; conversationKey: string; required?: readonly GoogleContactsCapability[]; onActivity?: () => void }) {
  const [status, setStatus] = useState<GoogleContactsConnectionStatus>();
  const [grants, setGrants] = useState<GoogleContactsToolGrant[]>([]), [error, setError] = useState('');
  const [checking, setChecking] = useState(true), [opening, setOpening] = useState(false), [waiting, setWaiting] = useState(false), [busyId, setBusyId] = useState('');
  const [localBusy, setLocalBusy] = useState(''), [localReviews, setLocalReviews] = useState<Record<string, LocalReview>>({});
  const [localReceipts, setLocalReceipts] = useState<Record<string, MacConnectorReceipt>>({});
  const [localReconciliationMatches, setLocalReconciliationMatches] = useState<Record<string, MacContact[]>>({});
  const [macQuery, setMacQuery] = useState(''), [macContacts, setMacContacts] = useState<MacContact[]>([]), [selectedMac, setSelectedMac] = useState<MacContact>();
  const [googleMatches, setGoogleMatches] = useState<unknown[]>([]);
  const alive = useRef(true), sequence = useRef(0), attempted = useRef<readonly ('contacts_read' | 'contacts_write')[]>([]), automatic = useRef(new Set<string>());

  const applyGrant = useCallback((grant: GoogleContactsToolGrant) => setGrants(items => items.some(item => item.id === grant.id)
    ? items.map(item => item.id === grant.id ? grant : item) : [grant, ...items]), []);
  const runApprovedRead = useCallback(async (grant: GoogleContactsToolGrant) => {
    if (isWrite(grant) || grant.state !== 'approved' || automatic.current.has(grant.id)) return;
    automatic.current.add(grant.id);
    try {
      const result = await executeGoogleContactsGrant(agentId, grant);
      if (alive.current) { applyGrant(result.grant); onActivity?.(); }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Could not finish the Google Contacts read.'); }
    finally { automatic.current.delete(grant.id); }
  }, [agentId, applyGrant, onActivity]);
  const refresh = useCallback(async () => {
    const version = ++sequence.current;
    try {
      const [connection, saved] = await Promise.allSettled([getGoogleContactsStatus(), listGoogleContactsGrants(agentId)]);
      if (!alive.current || version !== sequence.current) return;
      if (connection.status === 'fulfilled') {
        setStatus(connection.value);
        if (attempted.current.length && connection.value.connected && attempted.current.every(item => connection.value.capabilities.includes(item))) { attempted.current = []; setWaiting(false); onActivity?.(); }
      } else setError(connection.reason instanceof Error ? connection.reason.message : 'Could not check Google Contacts.');
      if (saved.status === 'fulfilled') {
        setGrants(saved.value.grants);
        for (const grant of saved.value.grants) {
          void runApprovedRead(grant);
          if (grant.state === 'succeeded' && grant.tool === 'contacts.google.transfer_preview') transferCandidates(grant).forEach((candidate, index) => {
            const key = `${grant.id}:${candidate.source.resourceName}:${index}`;
            void restoreLocal(key, candidate);
          });
        }
      } else if (connection.status === 'fulfilled') setError(saved.reason instanceof Error ? saved.reason.message : 'Could not load Google Contacts activity.');
      if (connection.status === 'fulfilled' && saved.status === 'fulfilled') setError('');
    } finally { if (alive.current && version === sequence.current) setChecking(false); }
  }, [agentId, onActivity, runApprovedRead]);
  useEffect(() => {
    alive.current = true; void refresh();
    const focus = () => { if (!document.hidden) void refresh(); };
    const timer = setInterval(focus, 5000); window.addEventListener('focus', focus); document.addEventListener('visibilitychange', focus);
    return () => { alive.current = false; sequence.current++; clearInterval(timer); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', focus); };
  }, [refresh]);

  async function connect(capabilities: readonly ('contacts_read' | 'contacts_write')[]) {
    setOpening(true); setError('');
    try {
      if (!window.dialer?.openExternal) throw new Error('Open Google Contacts connection from the native app.');
      const connection = await beginGoogleContactsConnection([...capabilities]);
      await window.dialer.openExternal(connection.authorizationUrl);
      if (!alive.current) return; attempted.current = capabilities; setWaiting(true); void refresh();
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Could not open Google Contacts connection.'); }
    finally { if (alive.current) setOpening(false); }
  }
  async function decide(grant: GoogleContactsToolGrant, decision: 'approve' | 'reject') {
    setBusyId(grant.id); setError('');
    try { const result = await decideGoogleContactsGrant(agentId, grant, decision); if (alive.current) { applyGrant(result.grant); onActivity?.(); } }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Could not record the Google Contacts decision.'); }
    finally { if (alive.current) setBusyId(''); }
  }
  async function executeWrite(grant: GoogleContactsToolGrant) {
    if (!isWrite(grant)) return;
    setBusyId(grant.id); setError('');
    try { const result = await executeGoogleContactsGrant(agentId, grant); if (alive.current) { applyGrant(result.grant); onActivity?.(); } }
    catch (cause) { if (alive.current) { setError(cause instanceof Error ? cause.message : 'Google Contacts outcome could not be confirmed.'); void refresh(); } }
    finally { if (alive.current) setBusyId(''); }
  }
  async function prepareLocal(key: string, candidate: TransferCandidate) {
    setLocalBusy(key); setError('');
    try {
      let connector = await macConnectorService.status();
      if (connector.contacts.state === 'permission_required') connector = await macConnectorService.requestAccess('contacts');
      if (connector.contacts.state !== 'available') throw new Error(connector.contacts.detail || 'Enable Contacts access for Crokodial Workspace first.');
      const proposed = candidate.proposedLocalCreate;
      if (!proposed.firstName && !proposed.lastName && !proposed.organization) throw new Error('This Google contact needs a name or organization before it can be created in Mac Contacts.');
      const query = proposed.emails[0] || proposed.phones[0] || [proposed.firstName, proposed.lastName].filter(Boolean).join(' ') || proposed.organization;
      const matches = query ? (await macConnectorService.searchContacts(query)).contacts : [];
      const change: MacContactChange = { operation: 'create', contact: { firstName: proposed.firstName, lastName: proposed.lastName,
        ...(proposed.organization ? { organization: proposed.organization } : {}), emails: proposed.emails, phones: proposed.phones } };
      const receipt = localReceipts[key];
      const revision = receipt?.state === 'reconciled' && receipt.resolution === 'not_applied' ? (receipt.context?.revision ?? 1) + 1 : 1;
      const review = await macConnectorService.prepareContactChange(change, transferOrigin(key, candidate, revision));
      if (alive.current) {
        setLocalReviews(items => ({ ...items, [key]: { review, candidate, matches } }));
        setLocalReceipts(items => { const next = { ...items }; delete next[key]; return next; });
        setLocalReconciliationMatches(items => { const next = { ...items }; delete next[key]; return next; });
      }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Could not prepare the Mac Contacts review.'); }
    finally { if (alive.current) setLocalBusy(''); }
  }
  function transferOrigin(key: string, candidate: TransferCandidate, revision = 1) {
    const proposed = candidate.proposedLocalCreate;
    const change: MacContactChange = { operation: 'create', contact: { firstName: proposed.firstName, lastName: proposed.lastName,
      ...(proposed.organization ? { organization: proposed.organization } : {}), emails: proposed.emails, phones: proposed.phones } };
    return { conversationKey, agentId, sessionId, turnId: `google-contact-transfer:${key}`, requestId: key.split(':', 1)[0],
      turnText: JSON.stringify({ source: 'google-contact-transfer', key, candidate, change }), revision };
  }
  async function restoreLocal(key: string, candidate: TransferCandidate) {
    try {
      const snapshot = await macConnectorService.restoreReviewedWrite(transferOrigin(key, candidate), 'contact.create');
      if (!alive.current || snapshot.state === 'none') return;
      if (snapshot.state === 'pending') setLocalReviews(items => ({ ...items, [key]: { review: snapshot.review as MacConnectorReview<MacContactChange>, candidate, matches: [] } }));
      else setLocalReceipts(items => ({ ...items, [key]: snapshot.receipt }));
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Could not restore the saved Mac Contacts receipt.'); }
  }
  async function inspectUnknownLocal(key: string, candidate: TransferCandidate) {
    setLocalBusy(key); setError('');
    try {
      const proposed = candidate.proposedLocalCreate;
      const query = proposed.emails[0] || proposed.phones[0] || [proposed.firstName, proposed.lastName].filter(Boolean).join(' ') || proposed.organization;
      if (!query || query.trim().length < 2) throw new Error('This contact has no safe value to use for outcome reconciliation.');
      const matches = (await macConnectorService.searchContacts(query)).contacts;
      if (alive.current) setLocalReconciliationMatches(items => ({ ...items, [key]: matches }));
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Could not inspect Mac Contacts for reconciliation.'); }
    finally { if (alive.current) setLocalBusy(''); }
  }
  async function reconcileLocal(key: string, resolution: 'applied' | 'not_applied') {
    const receipt = localReceipts[key]; if (!receipt) return;
    setLocalBusy(key); setError('');
    try {
      const snapshot = await macConnectorService.reconcileReviewedWrite(receipt, resolution, { agentId, sessionId });
      if (alive.current && snapshot.state !== 'none' && snapshot.state !== 'pending') { setLocalReceipts(items => ({ ...items, [key]: snapshot.receipt })); onActivity?.(); }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Could not reconcile the Mac Contacts receipt.'); }
    finally { if (alive.current) setLocalBusy(''); }
  }
  async function createLocal(key: string) {
    const item = localReviews[key]; if (!item) return;
    setLocalBusy(key); setError('');
    try {
      const receipt = await macConnectorService.executeContactChange(item.review, transferOrigin(key, item.candidate, item.review.context?.revision ?? 1));
      if (alive.current) { setLocalReceipts(items => ({ ...items, [key]: receipt })); setLocalReviews(items => { const next = { ...items }; delete next[key]; return next; }); onActivity?.(); }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Mac Contacts did not confirm the create.'); }
    finally { if (alive.current) setLocalBusy(''); }
  }
  async function searchMacForGoogle() {
    const query = macQuery.trim();
    if (query.length < 2) { setError('Enter at least two characters to search Mac Contacts.'); return; }
    setLocalBusy('mac-to-google-search'); setError('');
    try {
      let connector = await macConnectorService.status();
      if (connector.contacts.state === 'permission_required') connector = await macConnectorService.requestAccess('contacts');
      if (connector.contacts.state !== 'available') throw new Error(connector.contacts.detail || 'Enable Contacts access for Crokodial Workspace first.');
      const result = await macConnectorService.searchContacts(query);
      if (alive.current) { setMacContacts(result.contacts.slice(0, 100)); setSelectedMac(undefined); setGoogleMatches([]); }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Could not search Mac Contacts.'); }
    finally { if (alive.current) setLocalBusy(''); }
  }
  async function prepareMacToGoogleCreate() {
    if (!selectedMac) return;
    if (!writeReady) { setError('Enable reviewed Google Contacts changes before preparing this create-only handoff.'); return; }
    setLocalBusy('mac-to-google-create'); setError(''); setGoogleMatches([]);
    try {
      const duplicateQuery = selectedMac.emails[0] || selectedMac.phones[0] || selectedMac.name || selectedMac.organization;
      if (!duplicateQuery || duplicateQuery.trim().length < 2) throw new Error('This local contact needs a name, email, phone, or organization for Google duplicate review.');
      const search = await prepareGoogleContactsRequest(agentId, { tool: 'contacts.google.search', requestId: crypto.randomUUID(),
        args: { query: duplicateQuery.trim(), pageSize: 20 } });
      applyGrant(search.grant);
      const searchResult = await executeGoogleContactsGrant(agentId, search.grant);
      applyGrant(searchResult.grant);
      if (searchResult.grant.state !== 'succeeded' || !searchResult.grant.result) throw new Error(searchResult.grant.message || 'Google duplicate review did not complete.');
      const possible = Array.isArray(searchResult.grant.result.contacts) ? searchResult.grant.result.contacts.slice(0, 20) : [];
      const emails = [...new Set(selectedMac.emails.map(value => value.trim()).filter(Boolean))].slice(0, 10);
      const phones = [...new Set(selectedMac.phones.map(value => value.trim()).filter(Boolean))].slice(0, 10);
      const contact = {
        ...((selectedMac.firstName || selectedMac.lastName) ? { name: { ...(selectedMac.firstName ? { givenName: selectedMac.firstName } : {}), ...(selectedMac.lastName ? { familyName: selectedMac.lastName } : {}) } } : {}),
        ...(emails.length ? { emailAddresses: emails.map(value => ({ value })) } : {}),
        ...(phones.length ? { phoneNumbers: phones.map(value => ({ value })) } : {}),
        ...(selectedMac.organization ? { organizations: [{ name: selectedMac.organization }] } : {}),
      };
      if (!Object.keys(contact).length) throw new Error('This local contact has no supported fields to create in Google Contacts.');
      const create = await prepareGoogleContactsRequest(agentId, { tool: 'contacts.google.create', requestId: crypto.randomUUID(), args: { contact } });
      if (alive.current) { setGoogleMatches(possible); applyGrant(create.grant); onActivity?.(); }
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : 'Could not prepare the Google Contacts create review.'); }
    finally { if (alive.current) setLocalBusy(''); }
  }

  const requestedCapabilities = required?.length ? required : readCapability;
  const requiredReady = Boolean(status?.connected && requestedCapabilities.every(item => status.capabilities.includes(item)));
  const readReady = Boolean(status?.connected && readCapability.every(item => status.capabilities.includes(item)));
  const writeReady = Boolean(status?.connected && writeCapabilities.every(item => status.capabilities.includes(item)));
  const visible = grants.filter(visibleGrant);
  return <article className="assistant-work-card" aria-label="Google Contacts connection and actions">
    <div className="assistant-card-heading">{requiredReady ? <Check size={15}/> : <Cloud size={15}/>}<strong>{requiredReady ? 'Google Contacts connected' : 'Connect Google Contacts'}</strong></div>
    <p>{readReady ? `Google Contacts is connected${status?.email ? ` as ${status.email}` : ''}. Search and reads are bounded; every create or update is reviewed here first.`
      : status && !status.configured ? 'Google Contacts is not configured on this server. Your conversation remains saved.'
        : 'Connect Google Contacts to search people, prepare reviewed contact changes, and create a separately reviewed Mac Contacts copy.'}</p>
    {!readReady && status?.configured && <p>This connection is separate from Gmail, Calendar, Drive and Sheets. The first connection requests read-only Contacts access.</p>}
    {readReady && !writeReady && status?.configured && <p>Creating or updating a Google contact is optional. Enable it separately, then every exact change still requires approval in this chat.</p>}
    {waiting && <p role="status">Finish Google consent in your browser, then return here. The launch link is one-use; start again below if you closed it.</p>}
    {error && <p role="alert">{error}</p>}
    <div className="assistant-card-buttons">{!requiredReady && status?.configured && <button disabled={opening} onClick={() => void connect(requestedCapabilities)}>{opening ? <Loader2 className="spin" size={13}/> : <Cloud size={13}/>} {waiting ? 'Start connection again' : 'Connect Google Contacts'}</button>}{!required && readReady && !writeReady && status?.configured && <button disabled={opening} onClick={() => void connect(writeCapabilities)}>{opening ? <Loader2 className="spin" size={13}/> : <Cloud size={13}/>} {waiting ? 'Start permission upgrade again' : 'Enable reviewed contact changes'}</button>}<button disabled={checking} onClick={() => void refresh()}>{checking ? 'Checking…' : 'Check connection'}</button></div>
    {readReady && <details className="nativework nativework-panel" aria-label="Mac Contacts to Google Contacts create-only handoff">
      <summary>Mac Contacts → Google Contacts</summary>
      <p className="nativework-muted">Search and select one local contact. Crokodial checks Google for possible matches, then prepares a create-only Google review. It never merges, overwrites, updates, or deletes a contact.</p>
      <form className="nativework-row" onSubmit={event => { event.preventDefault(); void searchMacForGoogle(); }}><label>Find local contact<input required minLength={2} maxLength={100} value={macQuery} onChange={event => setMacQuery(event.target.value)}/></label><button disabled={Boolean(localBusy)}>Search Mac Contacts</button></form>
      {macContacts.length > 0 && <ul className="nativework-stack">{macContacts.map(contact => <li key={contact.id} className="nativework-row"><span>{contact.name || contact.organization || contact.emails[0] || contact.phones[0] || 'Unnamed contact'} · {contact.emails[0] || contact.phones[0] || 'No address'}</span><button type="button" disabled={Boolean(localBusy)} onClick={() => { setSelectedMac(contact); setGoogleMatches([]); }}>Select</button></li>)}</ul>}
      {selectedMac && <div className="nativework-stack"><p><strong>Selected local contact</strong> · {selectedMac.name || selectedMac.organization || selectedMac.emails[0] || selectedMac.phones[0]}</p>
        {!writeReady ? <button type="button" disabled={opening} onClick={() => void connect(writeCapabilities)}>Enable reviewed Google create access</button>
          : <button type="button" disabled={Boolean(localBusy)} onClick={() => void prepareMacToGoogleCreate()}>{localBusy === 'mac-to-google-create' ? 'Checking Google duplicates…' : 'Check duplicates and prepare create review'}</button>}
        {googleMatches.length > 0 && <p role="alert">Possible existing Google matches: {googleMatches.slice(0, 5).map(googleContactLabel).join(', ')}. Nothing will be merged or overwritten; approve only if you want a separate Google contact.</p>}
      </div>}
    </details>}
    {visible.map(grant => <section key={grant.id} className="nativework nativework-panel" aria-label="Google Contacts action review">
      <h3>{grant.tool}</h3><p><strong>{grant.state.replace(/_/g, ' ')}</strong> · {grant.destination}</p><pre>{pretty(grant.args)}</pre>{grant.message && <p role="status">{grant.message}</p>}
      {grant.result && grant.tool !== 'contacts.google.transfer_preview' && <details><summary>Google receipt</summary><pre>{pretty(grant.result)}</pre></details>}
      {grant.state === 'unknown' && <p role="alert">Search Google Contacts before preparing another write. This action will not be retried automatically.</p>}
      <div className="assistant-card-buttons">
        {grant.state === 'pending' && isWrite(grant) && <><button disabled={busyId === grant.id} onClick={() => void decide(grant, 'approve')}>Approve exact Google contact change</button><button disabled={busyId === grant.id} onClick={() => void decide(grant, 'reject')}>Reject</button></>}
        {grant.state === 'approved' && isWrite(grant) && <button disabled={busyId === grant.id} onClick={() => void executeWrite(grant)}>Execute approved change once</button>}
        {grant.state === 'approved' && !isWrite(grant) && <p role="status"><Loader2 className="spin" size={13}/> Reading the connected Google account…</p>}
      </div>
      {grant.state === 'succeeded' && grant.tool === 'contacts.google.transfer_preview' && <div className="nativework-stack">
        <p><strong>Create-only Mac Contacts handoff</strong></p><p className="nativework-muted">No record is merged, overwritten or deleted. Each proposed contact requires a second local review and one-use confirmation.</p>
        {transferCandidates(grant).map((candidate, index) => { const key = `${grant.id}:${candidate.source.resourceName}:${index}`, local = localReviews[key], receipt = localReceipts[key], reconciliationMatches = localReconciliationMatches[key], proposed = candidate.proposedLocalCreate;
          return <div key={key} className="nativework-panel"><p className="nativework-strong">{[proposed.firstName, proposed.lastName].filter(Boolean).join(' ') || proposed.organization || proposed.emails[0] || 'Unnamed Google contact'}</p>
            <p>{proposed.emails.join(', ') || 'No email'} · {proposed.phones.join(', ') || 'No phone'}</p>
            {!local && !receipt && <button type="button" disabled={localBusy === key} onClick={() => void prepareLocal(key, candidate)}>{localBusy === key ? 'Checking local Contacts…' : 'Review create in Mac Contacts'}</button>}
            {local && <div className="nativework-stack"><p><strong>Exact local create review</strong></p><pre>{pretty(local.review.payload)}</pre>{local.matches.length > 0 && <p role="alert">Possible existing local matches: {local.matches.slice(0, 5).map(item => item.name || item.organization || item.emails[0] || item.phones[0]).join(', ')}. Nothing will be merged or overwritten; continuing creates a separate contact.</p>}<button type="button" disabled={localBusy === key} onClick={() => void createLocal(key)}>Create this reviewed local contact once</button></div>}
            {receipt && <div className="nativework-stack"><p role="status">{receipt.message}</p>{receipt.state === 'unknown' && <><p role="alert">Inspect Mac Contacts before recording whether this create happened. It will never be retried automatically.</p><button type="button" disabled={localBusy === key} onClick={() => void inspectUnknownLocal(key, candidate)}>Inspect Mac Contacts for this exact person</button>{reconciliationMatches && <><p>{reconciliationMatches.length ? `Possible matches: ${reconciliationMatches.slice(0, 5).map(item => item.name || item.organization || item.emails[0] || item.phones[0]).join(', ')}` : 'No matching local contact was found.'}</p><div className="assistant-card-buttons"><button type="button" disabled={localBusy === key} onClick={() => void reconcileLocal(key, 'applied')}>I verified this contact is present</button><button type="button" disabled={localBusy === key} onClick={() => void reconcileLocal(key, 'not_applied')}>I verified this contact is absent</button></div></>}</>}{receipt.state === 'reconciled' && receipt.resolution === 'not_applied' && <button type="button" disabled={localBusy === key} onClick={() => void prepareLocal(key, candidate)}>Prepare separately reviewed revision {(receipt.context?.revision ?? 1) + 1}</button>}</div>}
          </div>; })}
      </div>}
    </section>)}
  </article>;
}
