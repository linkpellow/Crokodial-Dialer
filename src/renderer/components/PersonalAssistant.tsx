import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BookOpen, ExternalLink, Loader2, Phone, Send, Settings2, Sparkles, X } from 'lucide-react';
import { cancelAssistantConnection, resumeAssistantConnection, type AssistantPendingConnection, assistantSessionUsesOwnerContext, listInsurancePlans, listPersonalAssistants, openPlatform, readAssistantConversation, sendAssistantMessage, startAssistantSession, type AssistantAgent, type AssistantReply, type InsurancePlan } from '../services/assistantApiService';
import { conversationPlanHistory } from '../services/assistantRouting';
import { decideWorkspaceAction, getGmailStatus, listWorkspaceActivity, workspaceRequest } from '../services/assistantWorkspaceApi';
import type { AiExecutionProgress, WorkspaceItem } from '../services/assistantWorkspaceTypes';
import { gmailConnectionReady, type AssistantConnectionRequired } from '../services/assistantConnections';
import { NativeGmailConnection } from './NativeGmailConnection';
import { NativeCapabilitySettings, NativeWorkReview, type NativeWorkState } from './assistant-workspace/NativeWorkReview';
import './PersonalAssistant.css';

interface Turn { sequence?:number;requestId?: string; accepted?: boolean; id: string; role: 'user' | 'assistant'; text: string; createdAt: number; sources?: string[]; actions?: string[] }
interface Conversation { turns: Turn[]; draft: string; busy: boolean; error?: string }
type WorkKind = 'email' | 'followup' | 'screenshot' | 'artifact' | 'background';
type GmailStatus = Awaited<ReturnType<typeof getGmailStatus>>;
const empty = (): Conversation => ({ turns: [], draft: '', busy: false });
const labels: Record<string, string> = { pending: 'Awaiting approval', draft: 'Draft', saved: 'Saved', approved: 'Approved', ready: 'Ready', executing: 'Executing', submitting: 'Submitting', submitted: 'Submitted · delivery unconfirmed', succeeded: 'Completed', unknown: 'Outcome unresolved', rejected: 'Rejected', expired: 'Expired', failed: 'Failed', scheduled: 'Scheduled', suppressed: 'Suppressed', canceled: 'Canceled', active: 'Scheduled', paused: 'Paused', completed: 'Completed', waiting_approval: 'Awaiting approval', waiting_input: 'Needs your answer', applied: 'Record updated' };
const orderTurns=(a:Turn,b:Turn)=>a.sequence!==undefined&&b.sequence!==undefined?a.sequence-b.sequence:a.createdAt-b.createdAt||a.id.localeCompare(b.id);
function answerParts(text: string, open: (planId: string) => void) {
  return text.split(/(⟦plan:[^|⟧]+\|[^⟧]+⟧|\*\*[^*]+\*\*)/g).map((part, index) => {
    const match = /^⟦plan:([^|⟧]+)\|([^⟧]+)⟧$/.exec(part);
    if (match) return <button className="assistant-plan-link" key={index} title="Open source brochure" onClick={() => open(match[1])}>{match[2]}</button>;
    return part.startsWith('**') && part.endsWith('**') ? <strong key={index}>{part.slice(2, -2)}</strong> : part;
  });
}

export function PersonalAssistant({ active, callActive, callLabel, onReturnToCall, onPendingWorkChange }: { active: boolean; callActive: boolean; callLabel?: string; onReturnToCall: () => void; onPendingWorkChange?: (pending: boolean) => void }) {
  const [conversation, setConversation] = useState<Conversation>(empty);
  const [agents, setAgents] = useState<AssistantAgent[]>([]), [plans, setPlans] = useState<InsurancePlan[]>([]);
  const [loading, setLoading] = useState(false), [setupError, setSetupError] = useState<string>(), [notice, setNotice] = useState<string>();
  const [items, setItems] = useState<WorkspaceItem[]>([]), [activityError, setActivityError] = useState('');
  const [ownerContext, setOwnerContext] = useState(false), [settingsOpen, setSettingsOpen] = useState(false);
  const [editor, setEditor] = useState<{ kind: WorkKind; id?: string } | null>(null);
  const [pendingConnections, setPendingConnections] = useState<AssistantPendingConnection[]>([]);
  const [connectionRequired, setConnectionRequired] = useState<AssistantConnectionRequired | undefined>();
  const [historyPage,setHistoryPage]=useState<{hasMore:boolean;nextBefore?:number;loading:boolean}>({hasMore:false,loading:false});
  const [gmailHistory, setGmailHistory] = useState(false), [gmailStatus, setGmailStatus] = useState<GmailStatus | null>(null);
  const [progress, setProgress] = useState<AiExecutionProgress[]>([]), [progressRequest, setProgressRequest] = useState<string>();
  const [workState, setWorkState] = useState<NativeWorkState>({ dirty: false, busy: false });
  const [capabilityState, setCapabilityState] = useState<NativeWorkState>({ dirty: false, busy: false });
  const onCapabilityStateChange = useCallback((value: NativeWorkState) => setCapabilityState(old => old.dirty === value.dirty && old.busy === value.busy ? old : value), []);
  const [discardPrompt, setDiscardPrompt] = useState(false), deferredNavigation = useRef<(() => void) | null>(null);
  const workStateRef = useRef(workState);
  const onWorkStateChange = useCallback((value: NativeWorkState) => { workStateRef.current = value; setWorkState(old => old.dirty === value.dirty && old.busy === value.busy ? old : value); }, []);
  useLayoutEffect(() => { onPendingWorkChange?.(workState.dirty || workState.busy || capabilityState.dirty || capabilityState.busy || conversation.busy || Boolean(conversation.draft.trim())); }, [workState, capabilityState, conversation.busy, conversation.draft, onPendingWorkChange]);
  function navigateWork(action: () => void, includeComposer = false) {
    if (workStateRef.current.busy) { setNotice('Wait for the current workspace operation to finish before leaving this editor.'); return; }
    if (workStateRef.current.dirty || includeComposer && conversation.draft.trim()) { deferredNavigation.current = action; setDiscardPrompt(true); return; }
    setNotice(old => old === 'Wait for the current workspace operation to finish before leaving this editor.' ? undefined : old);
    action();
  }
  const pendingEditor = useRef<WorkKind | null>(null), loaded = useRef(false), loadPending = useRef(false), alive = useRef(true);
  const session = useRef<{ agentId: number; id: string }>(), sessionPending = useRef<Promise<{ agentId: number; id: string }>>();
  const busy = useRef(false);
  const historySequence = useRef(0), refreshSequence = useRef(0), bottom = useRef<HTMLDivElement>(null), input = useRef<HTMLTextAreaElement>(null);
  const transcript=useRef<HTMLDivElement>(null),historyPaging=useRef<{loadedEarlier:boolean;hasMore:boolean;nextBefore?:number}>({loadedEarlier:false,hasMore:false});
  const prependAnchor=useRef<{height:number;top:number}|null>(null);
  const update = (transform: (old: Conversation) => Conversation) => { if (alive.current) setConversation(transform); };

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; refreshSequence.current++; session.current = undefined; void window.dialer?.clearAssistant?.().catch(() => {}); };
  }, []);
  async function ensurePlatformSession(selectedAgentId?: number) {
    if (session.current) return session.current;
    if (sessionPending.current) return sessionPending.current;
    const agentId = selectedAgentId ?? agents[0]?.id;
    if (!agentId) throw new Error('Create a Personal Assistant in Crokodial to use your shared instructions and knowledge.');
    sessionPending.current = (async () => {
      const id = await startAssistantSession(agentId);
      if (!alive.current) throw new Error('Conversation closed.');
      session.current = { agentId, id }; historyPaging.current={loadedEarlier:false,hasMore:false};setHistoryPage({hasMore:false,loading:false});setOwnerContext(assistantSessionUsesOwnerContext(agentId, id));
      return session.current;
    })();
    try { return await sessionPending.current; } finally { sessionPending.current = undefined; }
  }
  async function refreshWorkspace(includeHistory = true) {
    const current = session.current;
    if (!current) return;
    try { if (!assistantSessionUsesOwnerContext(current.agentId, current.id)) return; }
    catch { if (alive.current) setActivityError('Sign in again to restore the saved conversation.'); return; }
    const sequence = ++refreshSequence.current, historyVersion = includeHistory ? ++historySequence.current : historySequence.current;
    const results = await Promise.allSettled([listWorkspaceActivity(current.agentId), includeHistory ? readAssistantConversation(current.agentId, current.id) : Promise.resolve(null)]);
    if (!alive.current || session.current !== current) return;
    if (sequence === refreshSequence.current && results[0].status === 'fulfilled') { setItems(results[0].value.items); setActivityError(''); }
    else if (sequence === refreshSequence.current && results[0].status === 'rejected') setActivityError(results[0].reason instanceof Error ? results[0].reason.message : 'Saved work could not be loaded.');
    if (historyVersion === historySequence.current && results[1].status === 'fulfilled' && results[1].value) {
      const messages = results[1].value.messages;
      setPendingConnections(results[1].value.pendingConnections);
      setConnectionRequired(results[1].value.pendingConnections[0]?.connectionRequired);
      if(!historyPaging.current.loadedEarlier)historyPaging.current={loadedEarlier:false,hasMore:results[1].value.hasMore,nextBefore:results[1].value.nextBefore};
      setHistoryPage({...historyPaging.current,loading:false});
      update(old => {const incoming=messages.map(message => ({ ...old.turns.find(turn => turn.id === message.id || message.requestId && turn.requestId === message.requestId && turn.role === message.role),sequence:message.sequence,id: message.id, requestId: message.requestId, accepted: false, role: message.role, text: message.content, createdAt: message.createdAt }));return ({ ...old, turns:[...old.turns.filter(turn=>!incoming.some(message=>message.id===turn.id||message.requestId&&message.requestId===turn.requestId&&message.role===turn.role)),...incoming].sort(orderTurns) });});
    } else if (historyVersion === historySequence.current && results[1].status === 'rejected') setActivityError('Conversation history could not be refreshed. Your saved work remains on the server.');
  }
  async function loadEarlierHistory() {
    const current=session.current,before=historyPage.nextBefore;if(!current||!before||historyPage.loading)return;
    const element=transcript.current;if(element)prependAnchor.current={height:element.scrollHeight,top:element.scrollTop};
    setHistoryPage(old=>({...old,loading:true}));
    try {const page=await readAssistantConversation(current.agentId,current.id,before);if(!alive.current||session.current!==current)return;const incoming=page.messages.map(message=>({sequence:message.sequence,id:message.id,requestId:message.requestId,accepted:false,role:message.role,text:message.content,createdAt:message.createdAt} as Turn));update(old=>({...old,turns:[...incoming,...old.turns.filter(turn=>!incoming.some(message=>message.id===turn.id))].sort(orderTurns)}));historyPaging.current={loadedEarlier:true,hasMore:page.hasMore,nextBefore:page.nextBefore};setHistoryPage({...historyPaging.current,loading:false});}
    catch(cause){if(alive.current){setHistoryPage(old=>({...old,loading:false}));setActivityError(cause instanceof Error?cause.message:'Earlier conversation history could not be loaded.');}}
  }
  async function load(silent = false) {
    if (loadPending.current || (silent && busy.current)) return;
    loadPending.current = true;
    if (!silent) { setLoading(true); setSetupError(undefined); }
    try {
      const results = await Promise.allSettled([listPersonalAssistants(), listInsurancePlans()]);
      if (!alive.current) return;
      if (results[0].status === 'fulfilled') {
        setAgents(results[0].value); setSetupError(undefined);
        if (results[0].value.length) {
          const current=session.current;
          if(current&&!results[0].value.some(agent=>agent.id===current.agentId)) {
            session.current=undefined;historyPaging.current={loadedEarlier:false,hasMore:false};setHistoryPage({hasMore:false,loading:false});
          }
          await ensurePlatformSession(results[0].value[0].id); await refreshWorkspace();
        }
      } else setSetupError(results[0].reason instanceof Error ? results[0].reason.message : 'Unable to load assistant settings.');
      if (results[1].status === 'fulfilled') { setPlans(results[1].value); setNotice(undefined); }
      else setNotice('Plan configuration is unavailable. Plan research may require a retry.');
    } catch (cause) { if (alive.current) setSetupError(cause instanceof Error ? cause.message : 'Unable to open the conversation.'); }
    finally { loadPending.current = false; if (alive.current) setLoading(false); }
  }
  useEffect(() => {
    if (!active) return;
    if (!loaded.current) { loaded.current = true; void load(); } else void load(true);
    input.current?.focus();
    const refresh = () => { if (!document.hidden) void load(true); };
    const timer = setInterval(() => { if (!document.hidden) void refreshWorkspace(!busy.current); }, 5000);
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [active]);
  useLayoutEffect(()=>{const anchor=prependAnchor.current,element=transcript.current;if(anchor&&element){element.scrollTop=anchor.top+(element.scrollHeight-anchor.height);prependAnchor.current=null;return;}if(active&&!editor&&!settingsOpen)bottom.current?.scrollIntoView({behavior:'instant'});},[conversation.turns.length,conversation.busy,active,editor,settingsOpen]);
  useEffect(() => {
    if (!progressRequest || !session.current) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>, cursor = 0;
    const agentId = session.current.agentId;
    const poll = async () => {
      try {
        const result = await workspaceRequest<{ events: AiExecutionProgress[] }>(agentId, `/execution/events?requestId=${encodeURIComponent(progressRequest)}&after=${cursor}`);
        if (!stopped && result.events?.length) { cursor = Math.max(cursor, ...result.events.map(event => event.sequence)); setProgress(old => [...old, ...result.events.filter(event => !old.some(previous => previous.sequence === event.sequence))]); }
      } catch { /* Durable activity and final response remain authoritative when progress is unavailable. */ }
      if (!stopped) timer = setTimeout(poll, 1000);
    };
    void poll(); return () => { stopped = true; clearTimeout(timer); };
  }, [progressRequest]);

  async function send(continuation?: AssistantPendingConnection) {
    const text = continuation ? continuation.originalRequest : conversation.draft.trim();
    if (!text || busy.current || loading) return;
    busy.current = true; refreshSequence.current++; historySequence.current++;
    const history = conversation.turns;
    let observedRequest: string | undefined;
    setProgress([]);
    update(old => ({ ...old, busy: true, error: undefined, draft: continuation ? old.draft : '' }));
    try {
      const current = await ensurePlatformSession();
      assistantSessionUsesOwnerContext(current.agentId, current.id);
      let reply: AssistantReply;
      if (continuation) reply = await resumeAssistantConnection(current.agentId, current.id, continuation.id, id => { observedRequest = id; if (alive.current) setProgressRequest(id); });
      else reply = await sendAssistantMessage(current.agentId, current.id, text, conversationPlanHistory(history), id => { observedRequest = id; if (alive.current) setProgressRequest(id); });
      if (reply.connectionRequired) setConnectionRequired(reply.connectionRequired);
      const answer = reply.message ?? reply.reply;
      if (!answer) throw new Error('The assistant returned an empty answer. Your message is ready to retry.');
      const sources = reply.grounding?.citations ?? reply.citations?.map(source => [source.tool, source.planId, source.detail].filter(Boolean).join(' · '));
      // A successful response is already authoritative. Keep its exact text in
      // memory until history supplies server IDs; a failing GET cannot erase it.
      const requestId = observedRequest!;
      update(old => ({ ...old, busy: false, turns: [...old.turns,
        ...(!old.turns.some(turn => turn.requestId === requestId && turn.role === 'user') ? [{ id: `received:${requestId}:user`, requestId, accepted: true, role: 'user' as const, text, createdAt: Date.now() }] : []),
        ...(!old.turns.some(turn => turn.requestId === requestId && turn.role === 'assistant') ? [{ id: `received:${requestId}:assistant`, requestId, accepted: true, role: 'assistant' as const, text: answer, createdAt: Date.now() + 1, sources }] : []),
      ] }));
      await refreshWorkspace();
      update(old => ({ ...old, busy: false, turns: old.turns.map((turn, index) => index === old.turns.length - 1 && turn.role === 'assistant' ? { ...turn, sources } : turn) }));
    } catch (error) {
      await refreshWorkspace();
      update(old => ({ ...old, busy: false, draft: continuation ? old.draft : old.draft || text, error: error instanceof Error ? error.message : 'Unable to reach the assistant.' }));
    } finally {
      if (observedRequest && session.current && alive.current) {
        try { const saved = await workspaceRequest<{ events: AiExecutionProgress[] }>(session.current.agentId, `/execution/events?requestId=${encodeURIComponent(observedRequest)}&after=0`); if (alive.current) setProgress(saved.events); } catch { /* Activity is the authoritative action receipt. */ }
      }
      busy.current = false; if (alive.current) setProgressRequest(undefined);
    }
  }
  async function brochure(planId: string) {
    try { if (!window.dialer?.openBrochure) throw new Error('Open this brochure in the native app.'); await window.dialer.openBrochure(planId); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Could not open the brochure.'); }
  }
  async function open(path: '/plans' | '/ai-assistants') {
    try { await openPlatform(path); } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not open Crokodial.'); }
  }
  function showWork(kind: WorkKind, id?: string) {
    if (editor?.kind === kind && editor.id === id) { setSettingsOpen(false); return; }
    navigateWork(() => {
    setSettingsOpen(false);
    if (kind === 'email' || kind === 'followup') {
      setGmailHistory(kind === 'followup');
      if (!id && (!gmailStatus?.connected || kind === 'followup' && !gmailStatus.historyConnected)) { pendingEditor.current = kind; setEditor(null); return; }
    }
    pendingEditor.current = null; onWorkStateChange({ dirty: false, busy: false }); setEditor({ kind, id });
    });
  }
  async function decide(item: WorkspaceItem, decision: 'approve' | 'reject') {
    if (busy.current || !session.current) return;
    busy.current = true; update(old => ({ ...old, busy: true, error: undefined }));
    try { await decideWorkspaceAction(session.current.agentId, item.entityId, decision); await refreshWorkspace(false); }
    catch (cause) { update(old => ({ ...old, error: cause instanceof Error ? cause.message : 'Could not record your decision.' })); }
    finally { busy.current = false; update(old => ({ ...old, busy: false })); }
  }
  const agentId = session.current?.agentId ?? agents[0]?.id;
  const feed = [...conversation.turns.map(turn => ({ id: turn.id, at: turn.createdAt, turn, item: undefined as WorkspaceItem | undefined })),
    ...items.map(item => ({ id: item.id, at: item.updatedAt, item, turn: undefined as Turn | undefined }))].sort((a, b) => a.turn&&b.turn?orderTurns(a.turn,b.turn):a.at-b.at||a.id.localeCompare(b.id));
  return <div className="assistant-workspace assistant-unified">
    <header className="assistant-header"><div className="assistant-brand"><span className="assistant-mark"><Sparkles size={18}/></span><div><strong>Personal Assistant</strong><small>CROKODIAL WORKSPACE</small></div></div>{!window.dialer?.nativeWindowControls && <button className="icon-button" aria-label="Close window" onClick={() => window.dialer?.close()}><X size={15}/></button>}</header>
    {callActive && <button className="assistant-call-banner" onClick={onReturnToCall}><Phone size={12}/><span>{callLabel || 'Call in progress'} · Return to dialer</span><i className="live-call-dot"/></button>}
    <div className="assistant-conversation-tools"><button className="icon-button" title="Manage Plans in Crokodial" aria-label="Manage Plans" onClick={() => void open('/plans')}><BookOpen size={16}/></button>{ownerContext && <button className="icon-button" aria-label="Assistant capabilities" title="Assistant capabilities" aria-expanded={settingsOpen} onClick={() => { setSettingsOpen(value => !value); }}><Settings2 size={16}/></button>}</div>
    <div ref={transcript} className="assistant-transcript" role="log" aria-label="Assistant conversation" aria-live="polite">
      {ownerContext && historyPage.hasMore && <div className="assistant-card-buttons"><button disabled={historyPage.loading} onClick={() => void loadEarlierHistory()}>{historyPage.loading ? 'Loading earlier messages…' : 'Load earlier messages'}</button></div>}
      {loading && <p className="assistant-muted"><Loader2 className="spin" size={14}/> Loading your workspace…</p>}
      {setupError && <div className="assistant-error" role="alert">{setupError}<button onClick={() => void load()}>Retry</button></div>}
      {!loading && !setupError && !agents.length && <div className="assistant-empty"><p>Create a Personal Assistant in Crokodial to use your shared instructions, tools, and knowledge here.</p><button onClick={() => void open('/ai-assistants')}>Open AI settings <ExternalLink size={12}/></button></div>}
      {feed.map(entry => entry.turn ? <article key={entry.id} className={`assistant-turn ${entry.turn.role}`}><small>{entry.turn.role === 'user' ? 'YOU' : 'ASSISTANT'}</small><div className="assistant-answer">{answerParts(entry.turn.text, id => void brochure(id))}</div>{Boolean(entry.turn.sources?.length) && <details><summary>Sources ({entry.turn.sources!.length})</summary>{entry.turn.sources!.map((source, index) => <p key={index}>{source}</p>)}</details>}{Boolean(entry.turn.actions?.length) && <p className="assistant-action-note">Suggested only: {entry.turn.actions!.join(', ')}. No action was sent.</p>}</article> : entry.item && <article key={entry.id} className="assistant-work-card" aria-label={`${entry.item.kind} activity`}><div className="assistant-card-heading"><strong>{entry.item.title}</strong><span>{labels[entry.item.status] ?? entry.item.status.replace(/_/g, ' ')}</span></div><p>{entry.item.detail}</p>{entry.item.action?.result?.message && <p role="status">{entry.item.action.result.message}</p>}<div className="assistant-card-buttons">{entry.item.kind === 'action' && entry.item.status === 'pending' && <><button disabled={conversation.busy} onClick={() => void decide(entry.item!, 'approve')}>Approve exact request</button><button disabled={conversation.busy} onClick={() => void decide(entry.item!, 'reject')}>Reject</button></>}{entry.item.kind !== 'action' && <button onClick={() => showWork(entry.item!.kind as WorkKind, entry.item!.entityId)}>{entry.item.kind === 'email' ? 'Review email' : entry.item.kind === 'screenshot' ? 'Review record' : entry.item.kind === 'artifact' ? 'Open artifact' : 'View task'}</button>}</div></article>)}
      {ownerContext && agentId && <NativeGmailConnection key={agentId} history={gmailHistory} required={connectionRequired?.capabilities} reason={connectionRequired?.reason} onStatus={setGmailStatus} onConnected={() => { const kind = pendingEditor.current; pendingEditor.current = null; if (kind) setEditor({ kind }); void refreshWorkspace(); }}/>}
      {ownerContext && pendingConnections.map(pending => <article key={pending.id} className="assistant-work-card" aria-label="Saved connection request"><strong>{pending.state === 'account_changed' ? 'Connected mailbox changed' : 'Continue your saved request'}</strong><p>{pending.originalRequest}</p><p>{pending.state === 'account_changed' ? 'This request belongs to the earlier mailbox. Connect that account again, or dismiss this saved request and ask again for the current account.' : 'Continuing reads or prepares the requested work. Sending still requires review and approval of exact recipients and content.'}</p><div className="assistant-card-buttons"><button disabled={conversation.busy || pending.state !== 'ready' || !gmailConnectionReady(gmailStatus, pending.connectionRequired.capabilities)} onClick={() => void send(pending)}>Continue request</button><button disabled={conversation.busy} onClick={() => { const current = session.current; if (!current) return; void cancelAssistantConnection(current.agentId, current.id, pending.id).then(() => refreshWorkspace()).catch(cause => update(old => ({ ...old, error: cause instanceof Error ? cause.message : 'Could not dismiss the saved request.' }))); }}>Dismiss saved request</button></div></article>)}
      {activityError && <div className="assistant-error" role="alert">{activityError}<button onClick={() => void refreshWorkspace()}>Reload saved work</button></div>}
      {ownerContext && agentId && (settingsOpen || capabilityState.dirty || capabilityState.busy) && <div hidden={!settingsOpen}><NativeCapabilitySettings agentId={agentId} onStateChange={onCapabilityStateChange} onActivity={() => void refreshWorkspace(false)}/></div>}
      {ownerContext && editor?.kind === 'email' && gmailStatus?.connected && !gmailStatus.historyConnected && <div className="assistant-card-buttons"><button onClick={() => setGmailHistory(true)}>Connect email history for replies</button></div>}
      {discardPrompt && <div className="assistant-error" role="alertdialog" aria-label="Unsaved workspace changes"><p>You have unsaved work. Keep editing or discard these edits to continue.</p><button onClick={() => { deferredNavigation.current = null; setDiscardPrompt(false); }}>Keep editing</button><button onClick={() => { const action = deferredNavigation.current; deferredNavigation.current = null; setDiscardPrompt(false); onWorkStateChange({ dirty: false, busy: false }); action?.(); }}>Discard edits and continue</button></div>}
      {ownerContext && agentId && editor && <NativeWorkReview key={`${agentId}:${editor.kind}:${editor.id ?? 'new'}`} agentId={agentId} kind={editor.kind} id={editor.id} onStateChange={onWorkStateChange} onActivity={() => void refreshWorkspace(false)} onClose={() => navigateWork(() => { setEditor(null); onWorkStateChange({ dirty: false, busy: false }); void refreshWorkspace(false); })}/>}
      {Boolean(progress.length) && <details className="assistant-progress"><summary>Execution progress ({progress.length})</summary>{progress.map((event, index) => <p key={`${event.sequence}:${index}`}>{(event.reason ?? event.state).replace(/_/g, ' ')}</p>)}</details>}
      {conversation.busy && <div className="assistant-thinking" role="status"><Loader2 className="spin" size={14}/> Working on your request…</div>}
      {conversation.error && <div className="assistant-error" role="alert">{conversation.error}<p>Review saved results before retrying. An uncertain request keeps its original receipt identity.</p></div>}
      <div ref={bottom}/>
    </div>
    {notice && <p className="assistant-notice">{notice}</p>}
    {ownerContext && <div className="assistant-work-shortcuts" aria-label="Assistant work"><button onClick={() => showWork('email')}>Email</button><button onClick={() => showWork('followup')}>Follow-up</button><button onClick={() => showWork('screenshot')}>Screenshot</button><button onClick={() => showWork('artifact')}>Artifact</button><button onClick={() => showWork('background')}>Task</button></div>}
    <form className="assistant-composer" onSubmit={event => { event.preventDefault(); void send(); }}><label className="sr-only" htmlFor="assistant-message">Message your assistant</label><textarea ref={input} id="assistant-message" autoCorrect="off" spellCheck={false} placeholder="Ask your assistant…" maxLength={15000} rows={4} value={conversation.draft} onChange={event => update(old => ({ ...old, draft: event.target.value }))} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}/><button type="submit" aria-label="Send message" disabled={loading || conversation.busy || !conversation.draft.trim()}>{conversation.busy ? <Loader2 className="spin" size={16}/> : <Send size={16}/>}</button></form>
  </div>;
}
