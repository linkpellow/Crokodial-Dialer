import { useNativeWorkState } from './nativeWorkState';
import { workspaceRequest } from '../../services/assistantWorkspaceApi';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AssistantBackgroundTask, AssistantBackgroundNotification, AssistantBackgroundTrigger } from '../../services/assistantWorkspaceTypes';

const statusText: Record<string, string> = { active: 'Scheduled', paused: 'Paused', canceled: 'Canceled', completed: 'Completed',
  queued: 'Queued', running: 'Running', waiting_device: 'Waiting for computer', waiting_configuration: 'Needs configuration',
  waiting_recovery: 'Recovering saved execution', waiting_input: 'Needs your answer', waiting_approval: 'Waiting for approval',
  unknown: 'Outcome unresolved', failed: 'Failed', budget_exhausted: 'Limit reached' };
const money = (micros: number) => `$${(micros / 1000000).toFixed(4)}`;
const stamp = (at: number) => new Date(at).toLocaleString();
const schedule = (trigger: AssistantBackgroundTrigger) => trigger.kind === 'event' ? `Owner event: ${trigger.eventKey}`
  : trigger.kind === 'daily' ? `Daily at ${trigger.localTime} (${trigger.timeZone})` : `Once: ${stamp(trigger.at)}`;

/** Bounded preparation goals. Pausing stops new runs; canceling also requests cancellation of the current goal. */
export function NativeBackgroundTasks({ agentId, initialTaskId, onActivity }: { agentId: number; initialTaskId?: string; onActivity?: () => void }) {
  const [tasks, setTasks] = useState<AssistantBackgroundTask[]>([]), [notifications, setNotifications] = useState<AssistantBackgroundNotification[]>([]);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const [objective, setObjective] = useState(''), [kind, setKind] = useState<'once' | 'daily' | 'event'>('once');
  const [once, setOnce] = useState(''), [localTime, setLocalTime] = useState('09:00');
  const [timeZone, setTimeZone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [eventKey, setEventKey] = useState('owner.requested'), [maxRuns, setMaxRuns] = useState(5);
  const [runBudget, setRunBudget] = useState('0.01'), [totalBudget, setTotalBudget] = useState('0.05'), [notify, setNotify] = useState(true);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [results, setResults] = useState<Record<string, string>>({});
  const defaultTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const formDirty = Boolean(objective || once || kind !== 'once' || localTime !== '09:00' || timeZone !== defaultTimeZone || eventKey !== 'owner.requested' || maxRuns !== 5 || runBudget !== '0.01' || totalBudget !== '0.05' || !notify);
  useNativeWorkState(formDirty || Object.values(answers).some(value => Boolean(value.trim())), busy);
  const requestKeys = useRef(new Map<string, string>()), generation = useRef(0);
  const base = `/background`;
  const currentBase = useRef(agentId); currentBase.current = agentId;
  const requestId = (key: string) => { const existing = requestKeys.current.get(key); if (existing) return existing;
    const id = crypto.randomUUID(); requestKeys.current.set(key, id); return id; };
  const load = useCallback(async (signal?: AbortSignal) => {
    const revision = ++generation.current;
    try {
      const data = await workspaceRequest<{ tasks: AssistantBackgroundTask[]; notifications: AssistantBackgroundNotification[] }>(agentId,base);
      if (!Array.isArray(data?.tasks) || !Array.isArray(data.notifications)) throw new Error('Unable to load background tasks');
      if (!signal?.aborted && revision === generation.current && currentBase.current === agentId) { setTasks(data.tasks); setNotifications(data.notifications); setError(''); }
    } catch (cause) { if (!signal?.aborted && revision === generation.current && currentBase.current === agentId) setError(cause instanceof Error ? cause.message : 'Unable to load background tasks'); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, [agentId]);
  useEffect(() => {
    setTasks([]); setNotifications([]); setResults({}); setAnswers({}); requestKeys.current.clear();
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
    const trigger: AssistantBackgroundTrigger = kind === 'once' ? { kind, at } : kind === 'daily' ? { kind, localTime, timeZone } : { kind, eventKey };
    const payload = { objective: objective.trim(), trigger, maxRuns: kind === 'once' ? 1 : maxRuns, runBudgetMicros: perRun,
      totalBudgetMicros: total, notificationPolicy: notify ? 'meaningful' : 'none' };
    const key = `create:${JSON.stringify(payload)}`;
    if (await post('', { ...payload, requestId: requestId(key) }, key)) { setObjective(''); setOnce(''); setKind('once'); setLocalTime('09:00'); setTimeZone(defaultTimeZone); setEventKey('owner.requested'); setMaxRuns(5); setRunBudget('0.01'); setTotalBudget('0.05'); setNotify(true); }
  }
  const unread = notifications.filter(item => item.readAt === null);
  return <section className="nativework-stack" aria-label="Background tasks">
    <div><h3 className="nativework-strong">Background tasks</h3>
      <p className="nativework-muted">Schedule bounded research and drafts using your assistant. Tasks use its existing permissions and spending limits.</p></div>
    {error && <p role="alert" className="nativework-error">{error}</p>}
    {unread.length > 0 && <div className="nativework-panel" aria-label="Task notifications">
      <ul>{unread.slice(0, 5).map(item => <li key={item.id}>{item.message}</li>)}</ul>
      <button type="button" disabled={busy} onClick={() => void post('/notifications/read', { through: Math.max(...unread.map(item => item.id)) })} className="nativework-link">Mark notifications read</button>
    </div>}
    {!initialTaskId && <form onSubmit={event => { event.preventDefault(); void create(); }} className="nativework-stack nativework-panel">
      <label>Task objective<textarea required maxLength={4000} value={objective} onChange={event => setObjective(event.target.value)}
        placeholder="Prepare a brief from the current client records" /></label>
      <div className="nativework-row">
        <label>Trigger<select value={kind} onChange={event => setKind(event.target.value as typeof kind)}>
          <option value="once">Once</option><option value="daily">Daily</option><option value="event">Owner event</option></select></label>
        {kind === 'once' && <label>Run at ({Intl.DateTimeFormat().resolvedOptions().timeZone})<input type="datetime-local" required value={once} onChange={event => setOnce(event.target.value)} /></label>}
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
