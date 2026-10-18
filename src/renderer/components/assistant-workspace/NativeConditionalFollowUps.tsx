import { useNativeWorkState } from './nativeWorkState';
import { previewSurface } from './previewSurface';
import { workspaceRequest } from '../../services/assistantWorkspaceApi';
import { useCallback, useEffect, useRef, useState } from 'react';
import { conditionalFollowUpConditions, type ConditionalFollowUp, type ConditionalFollowUpExclusion } from '../../services/assistantWorkspaceTypes';
import { emailDraftPreview, type EmailDraftDetail, type EmailDraftSummary } from '../../services/assistantWorkspaceTypes';

const labels: Record<ConditionalFollowUp['status'], string> = {pending: 'Review required — unsent', scheduled: 'Scheduled', paused: 'Paused', checking: 'Checking conditions',
  submitting: 'Submission in progress', submitted: 'Submitted — delivery unconfirmed', suppressed: 'Suppressed — unsent', canceled: 'Canceled — unsent', unknown: 'Outcome unknown — do not resend'};

/** Inline review for exact email revisions; scheduling and immediate sending share the saved draft. */
export function NativeConditionalFollowUps({agentId, initialFollowUpId, onActivity}: {agentId: number; initialFollowUpId?: string; onActivity?: () => void}) {
  const [followUps, setFollowUps] = useState<ConditionalFollowUp[]>([]), [exclusions, setExclusions] = useState<ConditionalFollowUpExclusion[]>([]);
  const [drafts, setDrafts] = useState<EmailDraftSummary[]>([]), [draftId, setDraftId] = useState(''), [at, setAt] = useState('');
  const [previews, setPreviews] = useState<Record<string, EmailDraftDetail>>({}), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [excludedContact, setExcludedContact] = useState(''), [reason, setReason] = useState('');
  useNativeWorkState(Boolean(draftId || at || excludedContact || reason), busy);
  const keys = useRef(new Map<string, string>()), revision = useRef(0);
  const base = String(agentId), currentBase = useRef(base); currentBase.current = base;
  const load = useCallback(async (signal?: AbortSignal) => {
    const generation = ++revision.current;
    try {
      const [tasks,emails] = await Promise.all([workspaceRequest<{followUps: ConditionalFollowUp[]; exclusions: ConditionalFollowUpExclusion[]}>(agentId,'/conditional-followups'),workspaceRequest<{drafts: EmailDraftSummary[]}>(agentId,'/email-drafts')]);
      if (!Array.isArray(tasks.followUps) || !Array.isArray(emails.drafts)) throw new Error('Unable to load scheduled emails');
      if (!signal?.aborted && currentBase.current === base && generation === revision.current) { setFollowUps(tasks.followUps); setExclusions(tasks.exclusions); setDrafts(emails.drafts); }
    } catch (cause) { if (!signal?.aborted && currentBase.current === base && generation === revision.current) setError(cause instanceof Error ? cause.message : 'Unable to load scheduled emails'); }
  }, [base]);
  useEffect(() => {
    setFollowUps([]); setExclusions([]); setDrafts([]); setPreviews({}); setDraftId(''); setError(''); keys.current.clear();
    const controller = new AbortController(); void load(controller.signal);
    const timer = setInterval(() => { if (!document.hidden) void load(controller.signal); }, 15000);
    return () => { controller.abort(); clearInterval(timer); revision.current++; };
  }, [load]);
  async function preview(id: string) {
    setBusy(true); setError('');
    try {
      const data = await workspaceRequest<EmailDraftDetail>(agentId,`/email-drafts/${id}`);
      if (data.id !== id) throw new Error('Unable to open this saved email');
      if (currentBase.current === base) setPreviews(previous => ({...previous, [id]: data}));
    } catch (cause) { if (currentBase.current === base) setError(cause instanceof Error ? cause.message : 'Unable to open email'); }
    finally { if (currentBase.current === base) setBusy(false); }
  }
  async function post(path: string, body: unknown, requestKey?: string) {
    setBusy(true); setError('');
    try {
      await workspaceRequest(agentId,`/conditional-followups${path}`,body);
      if (currentBase.current !== base) return;
      if (requestKey) keys.current.delete(requestKey);
      if (path === '') { setDraftId(''); setAt(''); }
      if (path === '/exclusions') { setExcludedContact(''); setReason(''); }
      await load(); onActivity?.();
    } catch (cause) { if (currentBase.current === base) setError(cause instanceof Error ? cause.message : 'Unable to update the follow-up'); }
    finally { if (currentBase.current === base) setBusy(false); }
  }
  function create() {
    const draft = drafts.find(item => item.id === draftId), dueAt = new Date(at).getTime();
    if (!draft || !Number.isFinite(dueAt) || dueAt <= Date.now()) { setError('Choose a saved reply draft and a future send time.'); return; }
    const content = {draftId, expectedRevision: draft.revision, contentHash: draft.contentHash, dueAt}, key = JSON.stringify(content);
    const requestId = keys.current.get(key) ?? crypto.randomUUID(); keys.current.set(key, requestId);
    void post('', {...content, requestId}, key);
  }
  const renderPreview = (draft: EmailDraftDetail) => <div className="nativework-stack nativework-panel" aria-label={`Email preview ${draft.subject}`}>
    <p>From: {draft.mailbox.sender} · To: {draft.email} · Revision {draft.revision}</p>
    <p className="nativework-strong">{draft.subject}</p><p className="nativework-prewrap">{draft.text}</p>
    {draft.html && <iframe title={`Scheduled email preview: ${draft.subject}`} sandbox="" referrerPolicy="no-referrer" srcDoc={emailDraftPreview(previewSurface(draft.html))} className="nativework-preview" />}
    <ul className="nativework-small">{draft.attachments.map(item => <li key={item.sha256}>{item.name} — {item.byteSize} bytes · SHA-256 {item.sha256}</li>)}</ul>
  </div>;
  return <section aria-label="Conditional follow-ups" className="nativework-stack">
    <div><h3 className="nativework-strong">Conditional follow-ups</h3><p className="nativework-muted">Schedule a saved Gmail reply after reviewing its exact content. The assistant checks again just before sending.</p></div>
    {error && <p role="alert" className="nativework-error">{error}</p>}
    {!initialFollowUpId && <form onSubmit={event => {event.preventDefault(); create();}} className="nativework-stack nativework-panel">
      <label>Saved email draft<select aria-label="Saved email draft" required value={draftId} onChange={event => {setDraftId(event.target.value); if (event.target.value) void preview(event.target.value);}}><option value="">Choose a draft</option>{drafts.filter(draft => draft.status === 'draft').map(draft => <option key={draft.id} value={draft.id}>{draft.subject} · {draft.email} · v{draft.revision}</option>)}</select></label>
      {previews[draftId] && renderPreview(previews[draftId])}
      <label>Send at ({Intl.DateTimeFormat().resolvedOptions().timeZone})<input required type="datetime-local" value={at} onChange={event => setAt(event.target.value)} /></label>
      <p>{conditionalFollowUpConditions}</p>
      <p className="nativework-small nativework-muted">Uses the exact linked Gmail thread and CRM records. Other inbox threads and external calendars are not monitored. Keep the server running.</p>
      <button disabled={busy || !draftId} className="nativework-primary">Prepare scheduled email review</button>
    </form>}
    <ul className="nativework-stack">{followUps.filter(item => !initialFollowUpId || item.id === initialFollowUpId).map(item => {
      const draft = previews[item.draftId], exact = draft?.revision === item.revision && draft.contentHash === item.contentHash;
      return <li key={item.id} className="nativework-stack nativework-panel">
        <p className="nativework-strong">{item.subject} → {item.email}</p><p>{new Date(item.dueAt).toLocaleString()} · {labels[item.status]}</p>
        {item.reason && <p role="status">{item.reason}</p>}
        {item.providerMessageId && <p className="nativework-small">Provider receipt: {item.providerMessageId}</p>}
        {item.status === 'pending' && <><p>{conditionalFollowUpConditions}</p><button type="button" disabled={busy} onClick={() => void preview(item.draftId)} className="nativework-link">Review exact email</button>
          {exact && renderPreview(draft)}{draft && !exact && <p className="nativework-error">The draft changed. Cancel this follow-up and prepare its new revision.</p>}
          <button type="button" disabled={busy || !exact} onClick={() => void post(`/${item.id}/approve`, {})} className="nativework-primary">Approve this exact scheduled email</button></>}
        <div className="nativework-row">
          {['scheduled', 'checking'].includes(item.status) && <button type="button" disabled={busy} onClick={() => void post(`/${item.id}/pause`, {})}>Pause follow-up</button>}
          {item.status === 'paused' && <button type="button" disabled={busy} onClick={() => void post(`/${item.id}/resume`, {})}>Resume follow-up</button>}
          {['pending', 'scheduled', 'paused', 'checking'].includes(item.status) && <button type="button" disabled={busy} onClick={() => void post(`/${item.id}/cancel`, {})}>Cancel follow-up</button>}
        </div>
      </li>;
    })}</ul>
    <details className="nativework-panel"><summary>Follow-up exclusions ({exclusions.length})</summary>
      <p className="nativework-small">Exclude a contact from conditional email follow-ups. This does not change consent or other campaigns.</p>
      <form onSubmit={event => {event.preventDefault(); void post('/exclusions', {contactId: Number(excludedContact), reason});}} className="nativework-row">
        <label>Contact ID<input type="number" min="1" required value={excludedContact} onChange={event => setExcludedContact(event.target.value)} /></label>
        <label>Reason<input required maxLength={500} value={reason} onChange={event => setReason(event.target.value)} /></label><button disabled={busy}>Exclude contact</button>
      </form>
      <ul className="nativework-stack">{exclusions.map(item => <li key={item.contactId}>Contact {item.contactId}: {item.reason} <button type="button" disabled={busy} onClick={() => void post('/exclusions', {contactId: item.contactId, reason: null})} className="nativework-link">Remove exclusion</button></li>)}</ul>
    </details>
  </section>;
}
