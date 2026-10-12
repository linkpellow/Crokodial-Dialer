import { useEffect, useRef, useState } from 'react';
import { BookOpen, ExternalLink, Loader2, Phone, Plus, Send, Sparkles, X } from 'lucide-react';
import { disposeAssistantSession, getPlanConfiguration, listInsurancePlans, listPersonalAssistants, openPlatform, sendAssistantMessage, startAssistantSession, type AssistantAgent, type AssistantReply, type InsurancePlan, type PlanConfiguration } from '../services/assistantApiService';

type Lane = 'platform' | 'insurance';
interface Turn { id: string; role: 'user' | 'assistant'; text: string; sources?: string[]; actions?: string[] }
interface Conversation { turns: Turn[]; draft: string; sessionId?: string; busy: boolean; resetting?: boolean; error?: string }
const empty = (): Conversation => ({ turns: [], draft: '', busy: false });
const initial = { platform: empty(), insurance: empty() };
function answerParts(text: string, open: (planId: string) => void) {
  return text.split(/(⟦plan:[^|⟧]+\|[^⟧]+⟧)/g).map((part, index) => {
    const match = /^⟦plan:([^|⟧]+)\|([^⟧]+)⟧$/.exec(part);
    return match ? <button className="assistant-plan-link" key={index} title="Open source brochure" onClick={() => open(match[1])}>{match[2]}</button> : part;
  });
}

export function PersonalAssistant({ active, callActive, callLabel, onReturnToCall }: { active: boolean; callActive: boolean; callLabel?: string; onReturnToCall: () => void }) {
  const [lane, setLane] = useState<Lane>('platform');
  const [conversations, setConversations] = useState<Record<Lane, Conversation>>(initial);
  const [agents, setAgents] = useState<AssistantAgent[]>([]);
  const [agentId, setAgentId] = useState<number>();
  const [plans, setPlans] = useState<InsurancePlan[]>([]);
  const [localPlans, setLocalPlans] = useState<Array<{ id: string; name: string; carrier?: string }>>([]);
  const [planId, setPlanId] = useState('');
  const [variantId, setVariantId] = useState('');
  const [planConfiguration, setPlanConfiguration] = useState<PlanConfiguration>();
  const [planError, setPlanError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [setupError, setSetupError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const loaded = useRef(false);
  const alive = useRef(true);
  const sessions = useRef(new Map<number, string>());
  const agentConversations = useRef(new Map<number, Conversation>());
  const busyLanes = useRef(new Set<Lane>());
  const bottom = useRef<HTMLDivElement>(null);
  const conversation = conversations[lane];
  const anyConversationBusy = conversations.platform.busy || conversations.insurance.busy;
  const selectedPlan = plans.find(plan => plan.id === planId);
  const variants = selectedPlan?.variants ?? localPlans;

  const update = (target: Lane, transform: (old: Conversation) => Conversation) => {
    if (alive.current) setConversations(previous => ({ ...previous, [target]: transform(previous[target]) }));
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      for (const [id, session] of sessions.current) void disposeAssistantSession(id, session).catch(() => {});
      sessions.current.clear();
      void window.dialer?.clearAssistant?.().catch(() => {});
    };
  }, []);

  async function load() {
    setLoading(true); setSetupError(undefined);
    const results = await Promise.allSettled([listPersonalAssistants(), listInsurancePlans()]);
    if (!alive.current) return;
    if (results[0].status === 'fulfilled') { const fetched = results[0].value; setAgents(fetched); setAgentId(previous => previous ?? fetched[0]?.id); }
    else setSetupError(results[0].reason instanceof Error ? results[0].reason.message : 'Unable to load assistant settings.');
    if (results[1].status === 'fulfilled') { setPlans(results[1].value); setNotice(undefined); }
    else setNotice('Plan configuration is unavailable. You can still use the existing insurance catalog.');
    setLoading(false);
  }
  useEffect(() => { if (active && !loaded.current) { loaded.current = true; void load(); } }, [active]);
  useEffect(() => {
    let cancelled = false;
    setPlanConfiguration(undefined); setPlanError(undefined);
    if (!planId || !active) return;
    const refresh = () => getPlanConfiguration(planId).then(config => {
      if (!cancelled) { setPlanConfiguration(config); setPlanError(undefined); }
    }).catch(error => { if (!cancelled) setPlanError(error instanceof Error ? error.message : 'Could not load plan guidance.'); });
    void refresh();
    window.addEventListener('focus', refresh);
    return () => { cancelled = true; window.removeEventListener('focus', refresh); };
  }, [planId, active]);
  useEffect(() => {
    if (lane !== 'insurance' || localPlans.length) return;
    if (!window.dialer?.compassRequest) { update('insurance', old => ({ ...old, error: 'Insurance research is available in the native Crokodial app.' })); return; }
    window.dialer.compassRequest('plans').then(result => {
      if (!alive.current) return;
      setLocalPlans(result as Array<{ id: string; name: string; carrier?: string }>);
      update('insurance', old => ({ ...old, error: undefined }));
    }).catch(error => update('insurance', old => ({ ...old, error: error.message })));
  }, [lane]);
  useEffect(() => { if (active) bottom.current?.scrollIntoView({ behavior: 'instant' }); }, [conversation.turns.length, conversation.busy, active, lane]);

  async function send() {
    const text = conversation.draft.trim();
    if (!text || busyLanes.current.has(lane) || (lane === 'platform' && !agentId)) return;
    const target = lane;
    const targetAgent = agentId;
    const chosenPlan = selectedPlan;
    const chosenVariant = variantId;
    busyLanes.current.add(target);
    update(target, old => ({ ...old, busy: true, error: undefined, draft: '' }));
    try {
      let reply: AssistantReply;
      if (target === 'platform') {
        let sessionId = sessions.current.get(targetAgent!);
        if (!sessionId) {
          sessionId = await startAssistantSession(targetAgent!);
          if (!alive.current) { await disposeAssistantSession(targetAgent!, sessionId); return; }
          sessions.current.set(targetAgent!, sessionId);
        }
        // Context is explicit user selection. No contact identifiers are inferred from a phone number.
        const context = chosenPlan ? `[Selected insurance plan: ${chosenPlan.name}; family ID: ${chosenPlan.id}${chosenVariant ? `; product ID: ${chosenVariant}` : ''}]\n` : '';
        reply = await sendAssistantMessage(targetAgent!, sessionId, context + text);
      } else {
        const conversationId = conversation.sessionId ?? crypto.randomUUID();
        update(target, old => ({ ...old, sessionId: conversationId }));
        const researchMessage = chosenPlan && !chosenVariant ? `For ${chosenPlan.name} (${chosenPlan.id}): ${text}` : text;
        reply = await window.dialer.compassRequest!('chat', { message: researchMessage, planId: chosenVariant || undefined, conversationId }) as AssistantReply;
      }
      const answer = reply.message ?? reply.reply;
      if (!answer) throw new Error('The assistant returned an empty answer. Your message is ready to retry.');
      const sources = reply.grounding?.citations ?? reply.citations?.map(source => [source.tool, source.planId, source.detail].filter(Boolean).join(' · '));
      update(target, old => ({ ...old, busy: false, turns: [...old.turns, { id: crypto.randomUUID(), role: 'user', text }, { id: crypto.randomUUID(), role: 'assistant', text: answer, sources, actions: reply.proposedActions?.map(action => action.name.replace(/_/g, ' ')) }] }));
    } catch (error) {
      update(target, old => ({ ...old, busy: false, draft: old.draft || text, error: error instanceof Error ? error.message : 'Unable to reach the assistant.' }));
    } finally { busyLanes.current.delete(target); }
  }
  async function reset() {
    const target = lane;
    const targetAgent = agentId;
    if (busyLanes.current.has(target)) return;
    busyLanes.current.add(target);
    update(target, old => ({ ...old, busy: true, resetting: true, error: undefined }));
    try {
      if (target === 'platform' && targetAgent) {
        const session = sessions.current.get(targetAgent);
        if (session) await disposeAssistantSession(targetAgent, session);
        sessions.current.delete(targetAgent);
        agentConversations.current.delete(targetAgent);
      }
      update(target, empty);
    } catch (error) {
      update(target, old => ({ ...old, busy: false, resetting: false, error: error instanceof Error ? error.message : 'Could not clear the conversation.' }));
    } finally { busyLanes.current.delete(target); }
  }
  async function brochure(planId: string) {
    try { if (!window.dialer?.openBrochure) throw new Error('Open this brochure in the native app.'); await window.dialer.openBrochure(planId); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'Could not open the brochure.'); }
  }
  async function open(path: '/plans' | '/ai-assistants') {
    try { await openPlatform(path); } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not open Crokodial.'); }
  }

  return <div className="assistant-workspace">
    <header className="assistant-header">
      <div className="assistant-brand"><span className="assistant-mark"><Sparkles size={18}/></span><div><strong>Personal Assistant</strong><small>CROKODIAL WORKSPACE</small></div></div>
      <button className="icon-button" aria-label="Close window" onClick={() => window.dialer?.close()}><X size={15}/></button>
    </header>
    {callActive && <button className="assistant-call-banner" onClick={onReturnToCall}><Phone size={12}/><span>{callLabel || 'Call in progress'} · Return to dialer</span><i className="live-call-dot"/></button>}
    <div className="assistant-controls">
      <div className="assistant-mode-row"><select aria-label="Assistant service" value={lane} onChange={event => setLane(event.target.value as Lane)}><option value="platform">Platform assistant</option><option value="insurance">Insurance research</option></select><button className="icon-button" title="New conversation" aria-label="New conversation" disabled={conversation.busy} onClick={() => void reset()}><Plus size={16}/></button><button className="icon-button" title="Manage Plans in Crokodial" aria-label="Manage Plans" onClick={() => void open('/plans')}><BookOpen size={16}/></button></div>
      {lane === 'platform' && agents.length > 1 && <select aria-label="Personal Assistant" disabled={conversation.busy} value={agentId} onChange={event => { if (busyLanes.current.has('platform')) return; const next = Number(event.target.value); if (agentId) agentConversations.current.set(agentId, conversations.platform); setAgentId(next); update('platform', () => agentConversations.current.get(next) ?? empty()); }}><option disabled value="">Choose assistant</option>{agents.map(agent => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select>}
      <div className="assistant-plan-row"><select aria-label="Primary insurance plan" value={planId} disabled={anyConversationBusy} onChange={event => { if (busyLanes.current.size) return; setPlanId(event.target.value); setVariantId(''); update('insurance', old => ({ ...old, sessionId: undefined })); }}><option value="">All plans</option>{plans.map(plan => <option value={plan.id} key={plan.id}>{plan.name}</option>)}</select>{(lane === 'insurance' || selectedPlan) && <select aria-label="Insurance product variation" disabled={anyConversationBusy} value={variantId} onChange={event => { if (busyLanes.current.size) return; setVariantId(event.target.value); update('insurance', old => ({ ...old, sessionId: undefined })); }}><option value="">Choose product</option>{variants.map(variant => <option value={variant.id} key={variant.id}>{variant.name}</option>)}</select>}</div>
      <small className="assistant-service-label">{lane === 'platform' ? 'Shared platform settings · Private conversation' : 'Quotes Compass · Source catalog and brochures'}</small>
    </div>
    {planId && <details className="assistant-plan-context"><summary>Shared plan guidance {planConfiguration ? `· ${planConfiguration.documents.length} documents` : ''}</summary>
      {planError && <p role="alert">{planError}</p>}
      {!planConfiguration && !planError && <p>Loading current platform guidance…</p>}
      {planConfiguration && <><p>{planConfiguration.instructions || 'No plan instructions saved yet.'}</p>{planConfiguration.announcements.filter(item => item.active && (!item.effectiveFrom || item.effectiveFrom <= new Date().toISOString().slice(0, 10)) && (!item.expiresAt || item.expiresAt >= new Date().toISOString().slice(0, 10))).map(item => <div key={item.id}><strong>{item.title}</strong><p>{item.body}</p>{(item.affectedEffectiveFrom || item.affectedEffectiveTo) && <small>Customer effective dates: {item.affectedEffectiveFrom || 'any'} — {item.affectedEffectiveTo || 'any'}. Confirm applicability.</small>}</div>)}{planConfiguration.supportContacts.map(contact => <p key={contact.id}>{contact.label}: {contact.email}<br/>{contact.purpose}</p>)}</>}
      {lane === 'insurance' && <><p>Local research uses the Quotes Compass catalog and brochures. Uploaded documents and support drafts use your shared platform assistant.</p><button onClick={() => { const draft = conversation.draft; setLane('platform'); if (draft) update('platform', old => ({ ...old, draft: old.draft || draft })); }}>Use shared plan knowledge</button></>}
    </details>}
    <div className="assistant-transcript" role="log" aria-label="Assistant conversation" aria-live="polite">
      {loading && <p className="assistant-muted"><Loader2 className="spin" size={14}/> Loading your workspace…</p>}
      {setupError && lane === 'platform' && <div className="assistant-error" role="alert">{setupError}<button onClick={() => void load()}>Retry</button></div>}
      {!loading && !setupError && lane === 'platform' && !agents.length && <div className="assistant-empty"><Sparkles size={28}/><h2>Set up your assistant</h2><p>Create a Personal Assistant in Crokodial to use your shared instructions, tools, and knowledge here.</p><button onClick={() => void open('/ai-assistants')}>Open AI settings <ExternalLink size={12}/></button><button onClick={() => void load()}>Refresh</button></div>}
      {!conversation.turns.length && (lane === 'insurance' || agents.length > 0) && <div className="assistant-empty"><Sparkles size={28}/><h2>How can I help?</h2><p>{lane === 'platform' ? 'Ask about plan guidance, known issues, or prepare a support email draft.' : 'Compare premiums, research a medication, or find verified coverage details.'}</p><div className="assistant-suggestions">{(lane === 'platform' ? ['Explain the active plan announcements', 'Draft a support escalation email'] : ['Compare plans for a 35-year-old', 'Which plans cover metformin?']).map(prompt => <button key={prompt} onClick={() => update(lane, old => ({ ...old, draft: prompt }))}>{prompt}</button>)}</div></div>}
      {conversation.turns.map((turn, turnIndex) => <article key={turn.id} className={`assistant-turn ${turn.role}`}><small>{turn.role === 'user' ? 'YOU' : 'ASSISTANT'}</small><div className="assistant-answer">{answerParts(turn.text, id => void brochure(id))}</div>{lane === 'platform' && turn.role === 'assistant' && /QUOTE_SOURCE_MISMATCH|open insurance research/i.test(turn.text) && <button className="assistant-research-handoff" onClick={() => { const original = conversation.turns[turnIndex - 1]?.text || ''; setLane('insurance'); update('insurance', old => ({ ...old, draft: old.draft || original })); }}>Continue in Insurance research</button>}{Boolean(turn.sources?.length) && <details><summary>Sources ({turn.sources!.length})</summary>{turn.sources!.map((source, index) => <p key={index}>{source}</p>)}</details>}{Boolean(turn.actions?.length) && <p className="assistant-action-note">Suggested only: {turn.actions!.join(', ')}. No action was sent.</p>}</article>)}
      {conversation.busy && <div className="assistant-thinking" role="status"><Loader2 className="spin" size={14}/> {conversation.resetting ? 'Clearing conversation…' : lane === 'insurance' ? 'Researching… First model load may take 2 minutes.' : 'Researching your request…'}</div>}
      {conversation.error && <div className="assistant-error" role="alert">{conversation.error}</div>}
      <div ref={bottom}/>
    </div>
    {notice && <p className="assistant-notice">{notice}</p>}
    <form className="assistant-composer" onSubmit={event => { event.preventDefault(); void send(); }}><label className="sr-only" htmlFor="assistant-message">Message your assistant</label><textarea id="assistant-message" disabled={conversation.resetting} autoCorrect="off" spellCheck={false} placeholder="Ask your assistant…" maxLength={15000} rows={2} value={conversation.draft} onChange={event => update(lane, old => ({ ...old, draft: event.target.value }))} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}/><button type="submit" aria-label="Send message" disabled={conversation.busy || !conversation.draft.trim() || (lane === 'platform' && !agentId)}>{conversation.busy ? <Loader2 className="spin" size={16}/> : <Send size={16}/>}</button></form>
    <p className="assistant-footer">{lane === 'platform' ? 'Support drafts stay private. Review before sharing.' : 'Verify current rates and coverage with the cited source.'}</p>
  </div>;
}
