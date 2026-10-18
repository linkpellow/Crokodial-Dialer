import { useNativeWorkState } from './nativeWorkState';
import { workspaceRequest } from '../../services/assistantWorkspaceApi';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssistantBackgroundTask, AssistantBackgroundNotification, AssistantBackgroundTrigger, AssistantGmailStatus, GmailTriageReview } from '../../services/assistantWorkspaceTypes';
import { gmailConnectionReady } from '../../services/assistantConnections';
import { NativeGmailConnection } from '../NativeGmailConnection';

const statusText: Record<string, string> = { active: 'Scheduled', paused: 'Paused', canceled: 'Canceled', completed: 'Completed',
  queued: 'Queued', running: 'Running', waiting_device: 'Waiting for computer', waiting_configuration: 'Needs configuration',
  waiting_recovery: 'Recovering saved execution', waiting_input: 'Needs your answer', waiting_approval: 'Waiting for approval',
  unknown: 'Outcome unresolved', failed: 'Failed', budget_exhausted: 'Limit reached' };
const triageStatus:Record<string,string>={active:'Reviewing',paused:'Paused',canceled:'Canceled',completed:'Completed',failed:'Failed',waiting_connection:'Reconnect Gmail'};
const money = (micros: number) => `$${(micros / 1000000).toFixed(4)}`;
const stamp = (at: number) => new Date(at).toLocaleString();
const schedule = (trigger: AssistantBackgroundTrigger) => trigger.kind === 'event' ? `Owner event: ${trigger.eventKey}`
  : trigger.kind === 'daily' ? `Daily at ${trigger.localTime} (${trigger.timeZone})` : trigger.kind === 'interval' ? `Every ${trigger.everyMinutes} minutes` : `Once: ${stamp(trigger.at)}`;

/** Bounded preparation goals. Pausing stops new runs; canceling also requests cancellation of the current goal. */
export function NativeBackgroundTasks({ agentId, initialTaskId, onActivity }: { agentId: number; initialTaskId?: string; onActivity?: () => void }) {
  const [tasks, setTasks] = useState<AssistantBackgroundTask[]>([]), [notifications, setNotifications] = useState<AssistantBackgroundNotification[]>([]);
  const [reviews,setReviews]=useState<GmailTriageReview[]>([]);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const [objective, setObjective] = useState(''), [kind, setKind] = useState<'once' | 'interval' | 'daily' | 'event'>('once');
  const [once, setOnce] = useState(''), [localTime, setLocalTime] = useState('09:00');
  const [timeZone, setTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [eventKey, setEventKey] = useState('owner.requested'), [maxRuns, setMaxRuns] = useState(5);
  const [everyMinutes, setEveryMinutes] = useState(30);
  const [runBudget, setRunBudget] = useState('0.01'), [totalBudget, setTotalBudget] = useState('0.05'), [notify, setNotify] = useState(true);
  const [triageQuery, setTriageQuery] = useState(''), [triageFolder,setTriageFolder]=useState<'all'|'inbox'|'sent'>('inbox'),[triagePages,setTriagePages]=useState(25),[triageItems,setTriageItems]=useState(500),[triageSeconds,setTriageSeconds]=useState(60), [gmailStatus, setGmailStatus] = useState<AssistantGmailStatus | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, string>>({});
  const defaultTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const formDirty = Boolean(objective || triageQuery || triageFolder!=='inbox'||triagePages!==25||triageItems!==500||triageSeconds!==60||once || kind !== 'once' || everyMinutes !== 30 || localTime !== '09:00' || timeZone !== defaultTimeZone || eventKey !== 'owner.requested' || maxRuns !== 5 || runBudget !== '0.01' || totalBudget !== '0.05' || !notify);
  useNativeWorkState(formDirty || Object.values(answers).some(value => Boolean(value.trim())), busy);
  const requestKeys = useRef(new Map<string, string>()), generation = useRef(0);
  const base = `/background`;
  const currentBase = useRef(agentId); currentBase.current = agentId;
  const requestId = (key: string) => { const existing = requestKeys.current.get(key); if (existing) return existing;
    const id = crypto.randomUUID(); requestKeys.current.set(key, id); return id; };
  const load = useCallback(async (signal?: AbortSignal) => {
    const revision = ++generation.current;
    try {
      const [backgroundResult,triageResult] = await Promise.allSettled([workspaceRequest<{ tasks: AssistantBackgroundTask[]; notifications: AssistantBackgroundNotification[] }>(agentId,base,undefined,undefined,signal),workspaceRequest<{reviews:GmailTriageReview[]}>(agentId,`${base}/gmail-triage`,undefined,undefined,signal)]);
      if(backgroundResult.status==='rejected')throw backgroundResult.reason;const data=backgroundResult.value;
      if (!Array.isArray(data?.tasks) || !Array.isArray(data.notifications)) throw new Error('Unable to load background tasks');
      const triage=triageResult.status==='fulfilled'&&Array.isArray(triageResult.value?.reviews)?triageResult.value.reviews:[];
      const triageError=triageResult.status==='rejected'?(triageResult.reason instanceof Error?triageResult.reason.message:'Unable to load Gmail reviews')
        :Array.isArray(triageResult.value?.reviews)?'':'Unable to load Gmail reviews';
      if (!signal?.aborted && revision === generation.current && currentBase.current === agentId) { setTasks(data.tasks); setNotifications(data.notifications);setReviews(triage); setError(triageError); }
    } catch (cause) { if (!signal?.aborted && revision === generation.current && currentBase.current === agentId) setError(cause instanceof Error ? cause.message : 'Unable to load background tasks'); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, [agentId]);
  useEffect(() => {
    setTasks([]); setNotifications([]);setReviews([]); setResults({}); setAnswers({}); requestKeys.current.clear();
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { if (!document.hidden) await load(controller.signal); if (!controller.signal.aborted) timer = setTimeout(poll, 10000); };
    void poll(); return () => { controller.abort(); clearTimeout(timer); generation.current++; };
  }, [load]);
  async function post(path: string, body: unknown, key?: string) {
    setBusy(true); setError('');
    try {
      await workspaceRequest(agentId,`${base}${path}`,body);
      if (currentBase.current !== agentId) return false;
      if (key) requestKeys.current.delete(key);
      const resumed = /^\/([^/]+)\/resume$/.exec(path);
      if (resumed) setAnswers(previous => { const next = { ...previous }; delete next[resumed[1]]; return next; });
      await load(); onActivity?.(); return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Unable to update background task'); return false; }
    finally { setBusy(false); }
  }
  async function showResult(task: AssistantBackgroundTask) {
    if (!task.latestRun) return;
    setBusy(true); setError('');
    try {
      const data = await workspaceRequest<{ result: { message?: string } | null }>(agentId,`${base}/${task.id}/runs/${task.latestRun.id}`);
      if (currentBase.current !== agentId) return;
      setResults(previous => ({ ...previous, [task.id]: typeof data.result?.message === 'string' ? data.result.message : 'No completed result is available yet.' }));
    } catch (cause) { if (currentBase.current === agentId) setError(cause instanceof Error ? cause.message : 'Unable to load the saved result'); }
    finally { if (currentBase.current === agentId) setBusy(false); }
  }
  async function create() {
    const at = new Date(once).getTime(), perRun = Math.round(Number(runBudget) * 1000000), total = Math.round(Number(totalBudget) * 1000000);
    if (!objective.trim() || kind === 'once' && (!Number.isFinite(at) || at <= Date.now()) || !Number.isSafeInteger(perRun) || perRun < 0 || !Number.isSafeInteger(total) || total < perRun) {
      setError('Enter an objective, a future time and valid spending limits.'); return;
    }
    const trigger: AssistantBackgroundTrigger = kind === 'once' ? { kind, at } : kind === 'interval' ? { kind, everyMinutes } : kind === 'daily' ? { kind, localTime, timeZone } : { kind, eventKey };
    const payload = { objective: objective.trim(), trigger, maxRuns: kind === 'once' ? 1 : maxRuns, runBudgetMicros: perRun,
      totalBudgetMicros: total, notificationPolicy: notify ? 'meaningful' : 'none' };
    const key = `create:${JSON.stringify(payload)}`;
    if (await post('', { ...payload, requestId: requestId(key) }, key)) { setObjective(''); setOnce(''); setKind('once'); setEveryMinutes(30); setLocalTime('09:00'); setTimeZone(defaultTimeZone); setEventKey('owner.requested'); setMaxRuns(5); setRunBudget('0.01'); setTotalBudget('0.05'); setNotify(true); }
  }
  async function createTriage(){
    const payload={query:triageQuery.trim(),folder:triageFolder,pageSize:20,maxPages:triagePages,maxItems:triageItems,timeBudgetMs:triageSeconds*1000};
    if(!payload.query||!Number.isSafeInteger(triagePages)||triagePages<1||triagePages>100||!Number.isSafeInteger(triageItems)||triageItems<1||triageItems>2000||!Number.isSafeInteger(triageSeconds)||triageSeconds<5||triageSeconds>300){setError('Enter an exact query and valid page, item, and time limits.');return;}
    const key=`gmail-triage:${JSON.stringify(payload)}`;if(await post('/gmail-triage',{...payload,requestId:requestId(key)},key)){setTriageQuery('');setTriageFolder('inbox');setTriagePages(25);setTriageItems(500);setTriageSeconds(60);}
  }
  async function controlTriage(review:GmailTriageReview,operation:'pause'|'cancel'|'resume'){
    const key=`gmail-triage:${operation}:${review.id}`;return post(`/gmail-triage/${review.id}/${operation}`,operation==='resume'?{requestId:requestId(key)}:{},operation==='resume'?key:undefined);
  }
  function openEvidence(url:string){try{const parsed=new URL(url);if(parsed.protocol!=='https:'||parsed.hostname!=='mail.google.com'||!parsed.pathname.startsWith('/mail/'))throw new Error();if(!window.dialer?.openExternal)throw new Error();void window.dialer.openExternal(url);}catch{setError('This Gmail evidence link is invalid.');}}
  const unread = notifications.filter(item => item.readAt === null);
  return <section className="nativework-stack" aria-label="Background tasks">
    <div><h3 className="nativework-strong">Background tasks</h3>
      <p className="nativework-muted">Schedule bounded research and drafts using your assistant. Tasks use its existing permissions and spending limits.</p></div>
    {error && <p role="alert" className="nativework-error">{error}</p>}
    {unread.length > 0 && <div className="nativework-panel" aria-label="Task notifications">
      <ul>{unread.slice(0, 5).map(item => <li key={item.id}>{item.message}</li>)}</ul>
      <button type="button" disabled={busy} onClick={() => void post('/notifications/read', { through: Math.max(...unread.map(item => item.id)) })} className="nativework-link">Mark notifications read</button>
    </div>}
    {!initialTaskId && <section className="nativework-stack nativework-panel" aria-label="Comprehensive Gmail review">
      <div><h4 className="nativework-strong">Comprehensive read-only Gmail review</h4><p className="nativework-muted">Review all matching pages within explicit page, item, and time limits. The time budget is checked between atomic pages. Progress, cursors, deduplication, and evidence survive restart. Gmail is never marked read, labeled, archived, drafted, or sent.</p></div>
      <NativeGmailConnection required={['mailbox_read']} reason="Connect Gmail read-only access before starting a comprehensive inbox review." onStatus={setGmailStatus} onConnected={() => {}}/>
      <label>Exact Gmail search query<input aria-label="Exact Gmail triage query" maxLength={200} value={triageQuery} placeholder="is:unread newer_than:1d" onChange={event => setTriageQuery(event.target.value)} /></label>
      <div className="nativework-row"><label>Folder<select aria-label="Gmail review folder" value={triageFolder} onChange={event=>setTriageFolder(event.target.value as typeof triageFolder)}><option value="inbox">Inbox</option><option value="sent">Sent</option><option value="all">All mail</option></select></label>
        <label>Maximum pages<input aria-label="Gmail review maximum pages" type="number" min={1} max={100} value={triagePages} onChange={event=>setTriagePages(Number(event.target.value))}/></label>
        <label>Maximum items<input aria-label="Gmail review maximum items" type="number" min={1} max={2000} value={triageItems} onChange={event=>setTriageItems(Number(event.target.value))}/></label>
        <label>Time budget (seconds)<input aria-label="Gmail review time budget" type="number" min={5} max={300} value={triageSeconds} onChange={event=>setTriageSeconds(Number(event.target.value))}/></label></div>
      <button type="button" className="nativework-primary" disabled={busy || !triageQuery.trim() || !gmailConnectionReady(gmailStatus, ['mailbox_read'])} onClick={()=>void createTriage()}>Start comprehensive review</button>
      {!gmailConnectionReady(gmailStatus, ['mailbox_read']) && <p className="nativework-small nativework-muted">Mailbox triage stays disabled until the main chat confirms Gmail mailbox-read consent.</p>}
    </section>}
    {!initialTaskId&&reviews.length>0&&<section className="nativework-stack" aria-label="Saved Gmail reviews"><h4 className="nativework-strong">Saved Gmail reviews</h4>{reviews.map(review=><article key={review.id} className="nativework-stack nativework-panel">
      <p className="nativework-strong">{review.query}</p><p role="status">{triageStatus[review.status]??review.status}{review.processing?' · Processing a bounded page':''}</p>
      <p className="nativework-small nativework-muted">{review.pagesProcessed}/{review.maxPages} pages · {review.itemsScanned}/{review.maxItems} items · {review.uniqueThreads} unique threads · {(review.elapsedMs/1000).toFixed(1)}/{(review.timeBudgetMs/1000).toFixed(0)} seconds</p>
      <p>Missed {review.counts.missed} · Unanswered {review.counts.unanswered} · Follow-up {review.counts.follow_up}</p>
      {review.completionReason&&<p className="nativework-small">{review.completionReason}</p>}{review.errorMessage&&<p className="nativework-error">{review.errorMessage}</p>}
      {review.results.filter(item=>item.missed||item.unanswered||item.followUp).slice(0,20).map(item=><div key={item.threadId} className="nativework-stack">
        <p><strong>{item.subject||'(No subject)'}</strong> · {item.from}</p><p className="nativework-small nativework-muted">{new Date(item.observedAt).toLocaleString()} · {item.rationale} · Source {item.sourceId}</p>
        <button type="button" className="nativework-link" onClick={()=>openEvidence(item.evidenceUrl)}>Open Gmail evidence</button>
      </div>)}
      {review.resultsTruncated&&<p className="nativework-small nativework-muted">Showing the first 50 saved evidence rows. Counts cover the entire bounded review.</p>}
      <div className="nativework-row">{review.status==='active'&&<button type="button" disabled={busy} onClick={()=>void controlTriage(review,'pause')}>Pause</button>}
        {['paused','waiting_connection'].includes(review.status)&&<button type="button" disabled={busy||!gmailConnectionReady(gmailStatus,['mailbox_read'])} onClick={()=>void controlTriage(review,'resume')}>Resume</button>}
        {!['completed','canceled','failed'].includes(review.status)&&<button type="button" disabled={busy} onClick={()=>void controlTriage(review,'cancel')}>Cancel</button>}</div>
    </article>)}</section>}
    {!initialTaskId && <form onSubmit={event => { event.preventDefault(); void create(); }} className="nativework-stack nativework-panel">
      <label>Task objective<textarea required maxLength={4000} value={objective} onChange={event => setObjective(event.target.value)}
        placeholder="Prepare a brief from the current client records" /></label>
      <div className="nativework-row">
        <label>Trigger<select value={kind} onChange={event => setKind(event.target.value as typeof kind)}>
          <option value="once">Once</option><option value="interval">Recurring interval</option><option value="daily">Daily</option><option value="event">Owner event</option></select></label>
        {kind === 'once' && <label>Run at ({Intl.DateTimeFormat().resolvedOptions().timeZone})<input type="datetime-local" required value={once} onChange={event => setOnce(event.target.value)} /></label>}
        {kind === 'interval' && <label>Repeat every (minutes)<input type="number" min={5} max={1440} required value={everyMinutes} onChange={event => setEveryMinutes(Number(event.target.value))} /></label>}
        {kind === 'daily' && <><label>Local time<input type="time" required value={localTime} onChange={event => setLocalTime(event.target.value)} /></label>
          <label>Timezone<input required value={timeZone} onChange={event => setTimeZone(event.target.value)} /></label></>}
        {kind === 'event' && <label>Event name<input required pattern="[a-z][a-z0-9_.:\-]{0,79}" value={eventKey} onChange={event => setEventKey(event.target.value)} /></label>}
      </div>
      <div className="nativework-row">
        {kind !== 'once' && <label>Maximum runs<input type="number" min={1} max={100} required value={maxRuns} onChange={event => setMaxRuns(Number(event.target.value))} /></label>}
        <label>Per-run limit (USD)<input type="number" min="0" max="0.05" step="0.001" required value={runBudget} onChange={event => setRunBudget(event.target.value)} /></label>
        <label>Total limit (USD)<input type="number" min="0" max="5" step="0.001" required value={totalBudget} onChange={event => setTotalBudget(event.target.value)} /></label>
      </div>
      <label className="nativework-row"><input type="checkbox" checked={notify} onChange={event => setNotify(event.target.checked)} />Notify on meaningful changes</label>
      <p className="nativework-small nativework-muted">Daily schedules skip nonexistent daylight-saving times and run once when an hour repeats. Owner events are submitted from this account. The server must be running; local tasks also need your qualified computer.</p>
      <button disabled={busy} className="nativework-primary">Save background task</button>
    </form>}
    <button type="button" onClick={() => void load()} disabled={busy} className="nativework-link">Refresh tasks</button>
    {loading ? <p role="status">Loading tasks…</p> : tasks.length === 0 ? <p className="nativework-muted">No background tasks yet.</p> :
      <ul className="nativework-stack">{tasks.filter(task => !initialTaskId || task.id === initialTaskId).map(task => {
        const run = task.latestRun, ended = ['completed', 'canceled', 'budget_exhausted'].includes(task.status);
        const resumable = !ended && (task.status === 'paused' || run && ['waiting_input', 'waiting_approval', 'waiting_device', 'waiting_configuration'].includes(run.status)) && !['failed', 'canceled', 'budget_exhausted'].includes(run?.status ?? '');
        return <li key={task.id} className="nativework-stack nativework-panel">
          <p className="nativework-strong">{task.objective}</p><p>{schedule(task.trigger)} · {statusText[task.status]}</p>
          <p className="nativework-small nativework-muted">{task.runCount}/{task.maxRuns} runs · Spent {money(task.spentMicros)} · Committed {money(task.committedMicros)} / {money(task.totalBudgetMicros)}
            {task.nextDueAt ? ` · Next: ${stamp(task.nextDueAt)}` : ''}</p>
          {run && <p role="status">{statusText[run.status]}{run.message ? ` — ${run.message}` : ''}{run.retryAt && run.status === 'waiting_device' ? ` Next check: ${stamp(run.retryAt)}.` : ''}</p>}
          {results[task.id] && <p className="nativework-prewrap">{results[task.id]}</p>}
          {task.status === 'paused' && run?.status === 'running' && <p className="nativework-small">New runs are paused. The current bounded goal may finish; cancel to stop it.</p>}
          {run?.status === 'waiting_input' && <label>Clarification<input value={answers[task.id] ?? ''} onChange={event => setAnswers(previous => ({ ...previous, [task.id]: event.target.value }))} /></label>}
          <div className="nativework-row">
            {run?.goalId && <button type="button" disabled={busy} onClick={() => void showResult(task)}>View goal result</button>}
            {task.status === 'active' && <button type="button" disabled={busy} onClick={() => void post(`/${task.id}/pause`, {})}>Pause future runs</button>}
            {resumable && <button type="button" disabled={busy || run?.status === 'waiting_input' && !answers[task.id]?.trim()} onClick={() => { const key = `resume:${task.id}:${answers[task.id] ?? ''}`;
              void post(`/${task.id}/resume`, { requestId: requestId(key), ...(answers[task.id]?.trim() ? { message: answers[task.id].trim() } : {}) }, key); }}>{run?.status === 'unknown' ? 'Recheck outcome and resume' : 'Resume'}</button>}
            {!ended && <button type="button" disabled={busy} onClick={() => void post(`/${task.id}/cancel`, {})}>Cancel task</button>}
            {task.status === 'active' && task.trigger.kind === 'event' && <button type="button" disabled={busy} onClick={() => { const key = `event:${task.id}`;
              void post(`/${task.id}/events`, { eventId: requestId(key), eventKey: task.trigger.kind === 'event' ? task.trigger.eventKey : '' }, key); }}>Send owner event</button>}
          </div>
        </li>;
      })}</ul>}
  </section>;
}
