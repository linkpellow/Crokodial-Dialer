import { useEffect, useRef, useState } from 'react';
import { BookOpen, ExternalLink, Loader2, Phone, Plus, Send, Sparkles, X } from 'lucide-react';
import { disposeAssistantSession, listInsurancePlans, listPersonalAssistants, openPlatform, sendAssistantMessage, startAssistantSession, type AssistantAgent, type AssistantReply, type InsurancePlan } from '../services/assistantApiService';
import { conversationPlanHistory, routeAssistantRequest, type CatalogProduct, type ResearchContext } from '../services/assistantRouting';
import './PersonalAssistant.css';

interface Turn { id: string; role: 'user' | 'assistant'; text: string; sources?: string[]; actions?: string[] }
interface Conversation { turns: Turn[]; draft: string; busy: boolean; resetting?: boolean; error?: string; research?: ResearchContext }
const empty = (): Conversation => ({ turns: [], draft: '', busy: false });
function answerParts(text: string, open: (planId: string) => void) {
  return text.split(/(⟦plan:[^|⟧]+\|[^⟧]+⟧)/g).map((part, index) => {
    const match = /^⟦plan:([^|⟧]+)\|([^⟧]+)⟧$/.exec(part);
    return match ? <button className="assistant-plan-link" key={index} title="Open source brochure" onClick={() => open(match[1])}>{match[2]}</button> : part;
  });
}

export function PersonalAssistant({ active, callActive, callLabel, onReturnToCall }: { active: boolean; callActive: boolean; callLabel?: string; onReturnToCall: () => void }) {
  const [conversation, setConversation] = useState<Conversation>(empty);
  const [agents, setAgents] = useState<AssistantAgent[]>([]);
  const [plans, setPlans] = useState<InsurancePlan[]>([]);
  const [loading, setLoading] = useState(false);
  const [setupError, setSetupError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const loaded = useRef(false);
  const loadPending = useRef(false);
  const alive = useRef(true);
  const session = useRef<{ agentId: number; id: string }>();
  const localConversationId = useRef(crypto.randomUUID());
  const localPlans = useRef<CatalogProduct[]>();
  const busy = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const update = (transform: (old: Conversation) => Conversation) => { if (alive.current) setConversation(transform); };

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      const current = session.current;
      session.current = undefined;
      if (current) void disposeAssistantSession(current.agentId, current.id).catch(() => {});
      void window.dialer?.clearAssistant?.().catch(() => {});
    };
  }, []);
  async function load(silent = false) {
    if (loadPending.current || (silent && busy.current)) return;
    loadPending.current = true;
    if (!silent) { setLoading(true); setSetupError(undefined); }
    const results = await Promise.allSettled([listPersonalAssistants(), listInsurancePlans()]);
    loadPending.current = false;
    if (!alive.current) return;
    if (results[0].status === 'fulfilled') { setAgents(results[0].value); setSetupError(undefined); }
    else setSetupError(results[0].reason instanceof Error ? results[0].reason.message : 'Unable to load assistant settings.');
    if (results[1].status === 'fulfilled') { setPlans(results[1].value); setNotice(undefined); }
    else setNotice('Plan configuration is unavailable. Plan research may require a retry.');
    setLoading(false);
  }
  useEffect(() => {
    if (!active) return;
    if (!loaded.current) { loaded.current = true; void load(); } else void load(true);
    input.current?.focus();
    const refresh = () => { if (!document.hidden) void load(true); };
    const timer = setInterval(refresh, 30_000);
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [active]);
  useEffect(() => { if (active) bottom.current?.scrollIntoView({ behavior: 'instant' }); }, [conversation.turns.length, conversation.busy, active]);

  async function platformReply(text: string, history: Turn[]) {
    const agentId = session.current?.agentId ?? agents[0]?.id;
    if (!agentId) throw new Error('Create a Personal Assistant in Crokodial to use your shared instructions and knowledge.');
    if (!session.current) {
      const id = await startAssistantSession(agentId);
      if (!alive.current) { await disposeAssistantSession(agentId, id); throw new Error('Conversation closed.'); }
      session.current = { agentId, id };
    }
    return sendAssistantMessage(agentId, session.current.id, text, conversationPlanHistory(history));
  }
  async function send() {
    const text = conversation.draft.trim();
    if (!text || busy.current || loading) return;
    busy.current = true;
    const history = conversation.turns;
    update(old => ({ ...old, busy: true, error: undefined, draft: '' }));
    try {
      // Metadata is loaded lazily: ordinary plan questions never start a second
      // model or research engine. No user is required to choose an assistant.
      let route = routeAssistantRequest({ message: text, history, families: plans, products: localPlans.current ?? [], research: conversation.research });
      if (route.kind !== 'platform' && !localPlans.current) {
        if (!window.dialer?.compassRequest) throw new Error('Quotes Compass research is available in the native Crokodial app.');
        localPlans.current = await window.dialer.compassRequest('plans') as CatalogProduct[];
        route = routeAssistantRequest({ message: text, history, families: plans, products: localPlans.current, research: conversation.research });
      }
      let reply: AssistantReply;
      if (route.kind === 'clarify') reply = { reply: route.reply };
      else if (route.kind === 'compass') {
        reply = await window.dialer.compassRequest!('chat', { message: route.message, planId: route.planId, planIds: route.planIds, quoteInputs: route.quoteInputs,
          conversationId: localConversationId.current, history: history.slice(-12).map(turn => ({ role: turn.role, text: turn.text.slice(0, 2000) })) }) as AssistantReply;
      } else reply = await platformReply(text, history);
      const answer = reply.message ?? reply.reply;
      if (!answer) throw new Error('The assistant returned an empty answer. Your message is ready to retry.');
      const sources = reply.grounding?.citations ?? reply.citations?.map(source => [source.tool, source.planId, source.detail].filter(Boolean).join(' · '));
      update(old => ({ ...old, busy: false, research: route.kind === 'platform' ? undefined : route.context,
        turns: [...old.turns, { id: crypto.randomUUID(), role: 'user', text }, { id: crypto.randomUUID(), role: 'assistant', text: answer, sources,
          actions: reply.proposedActions?.map(action => action.name.replace(/_/g, ' ')) }] }));
    } catch (error) {
      update(old => ({ ...old, busy: false, draft: old.draft || text, error: error instanceof Error ? error.message : 'Unable to reach the assistant.' }));
    } finally { busy.current = false; }
  }
  async function reset() {
    if (busy.current) return;
    busy.current = true;
    update(old => ({ ...old, busy: true, resetting: true, error: undefined }));
    try {
      const current = session.current;
      if (current) { await disposeAssistantSession(current.agentId, current.id); session.current = undefined; }
      await window.dialer?.clearAssistant?.();
      localConversationId.current = crypto.randomUUID();
      update(empty);
      input.current?.focus();
    } catch (error) {
      update(old => ({ ...old, busy: false, resetting: false, error: error instanceof Error ? error.message : 'Could not clear the conversation.' }));
    } finally { busy.current = false; }
  }
  async function brochure(planId: string) {
    try { if (!window.dialer?.openBrochure) throw new Error('Open this brochure in the native app.'); await window.dialer.openBrochure(planId); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Could not open the brochure.'); }
  }
  async function open(path: '/plans' | '/ai-assistants') {
    try { await openPlatform(path); } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not open Crokodial.'); }
  }

  return <div className="assistant-workspace assistant-unified">
    <header className="assistant-header">
      <div className="assistant-brand"><span className="assistant-mark"><Sparkles size={18}/></span><div><strong>Personal Assistant</strong><small>CROKODIAL WORKSPACE</small></div></div>
      {!window.dialer?.nativeWindowControls && <button className="icon-button" aria-label="Close window" onClick={() => window.dialer?.close()}><X size={15}/></button>}
    </header>
    {callActive && <button className="assistant-call-banner" onClick={onReturnToCall}><Phone size={12}/><span>{callLabel || 'Call in progress'} · Return to dialer</span><i className="live-call-dot"/></button>}
    <div className="assistant-conversation-tools"><button className="icon-button" title="New conversation" aria-label="New conversation" disabled={conversation.busy} onClick={() => void reset()}><Plus size={16}/></button><button className="icon-button" title="Manage Plans in Crokodial" aria-label="Manage Plans" onClick={() => void open('/plans')}><BookOpen size={16}/></button></div>
    <div className="assistant-transcript" role="log" aria-label="Assistant conversation" aria-live="polite">
      {loading && <p className="assistant-muted"><Loader2 className="spin" size={14}/> Loading your workspace…</p>}
      {setupError && <div className="assistant-error" role="alert">{setupError}<button onClick={() => void load()}>Retry</button></div>}
      {!loading && !setupError && !agents.length && <div className="assistant-empty"><p>Create a Personal Assistant in Crokodial to use your shared instructions, tools, and knowledge here.</p><button onClick={() => void open('/ai-assistants')}>Open AI settings <ExternalLink size={12}/></button></div>}
      {conversation.turns.map(turn => <article key={turn.id} className={`assistant-turn ${turn.role}`}><small>{turn.role === 'user' ? 'YOU' : 'ASSISTANT'}</small><div className="assistant-answer">{answerParts(turn.text, id => void brochure(id))}</div>{Boolean(turn.sources?.length) && <details><summary>Sources ({turn.sources!.length})</summary>{turn.sources!.map((source, index) => <p key={index}>{source}</p>)}</details>}{Boolean(turn.actions?.length) && <p className="assistant-action-note">Suggested only: {turn.actions!.join(', ')}. No action was sent.</p>}</article>)}
      {conversation.busy && <div className="assistant-thinking" role="status"><Loader2 className="spin" size={14}/> {conversation.resetting ? 'Clearing conversation…' : 'Researching your request…'}</div>}
      {conversation.error && <div className="assistant-error" role="alert">{conversation.error}</div>}
      <div ref={bottom}/>
    </div>
    {notice && <p className="assistant-notice">{notice}</p>}
    <form className="assistant-composer" onSubmit={event => { event.preventDefault(); void send(); }}><label className="sr-only" htmlFor="assistant-message">Message your assistant</label><textarea ref={input} id="assistant-message" disabled={conversation.resetting} autoCorrect="off" spellCheck={false} placeholder="Ask your assistant…" maxLength={15000} rows={2} value={conversation.draft} onChange={event => update(old => ({ ...old, draft: event.target.value }))} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}/><button type="submit" aria-label="Send message" disabled={loading || conversation.busy || !conversation.draft.trim()}>{conversation.busy ? <Loader2 className="spin" size={16}/> : <Send size={16}/>}</button></form>
    <p className="assistant-footer">Review drafts before sharing. Verify coverage with the cited source.</p>
  </div>;
}
