import { useEffect, useState } from 'react';
import { macMonitorState, resumeSavedMacMonitor, subscribeMacMonitor } from '../services/macConnectorMonitorManager';

/** Keeps an explicitly configured local read monitor alive while the Workspace app is running. */
export function MacMonitorStatus({ agentId, sessionId }: { agentId: number; sessionId: string }) {
  const [state, setState] = useState<ReturnType<typeof macMonitorState>>({ running: false });
  useEffect(() => { const authority = { agentId, sessionId }; const unsubscribe = subscribeMacMonitor(authority, setState);
    void resumeSavedMacMonitor(authority); return unsubscribe; }, [agentId, sessionId]);
  if (!state.running && !state.error) return null;
  const messages = state.snapshot?.messageThreads.length ?? 0, whatsapp = state.snapshot?.whatsappObservations.length ?? 0;
  const hints = state.snapshot?.urgencyHints ?? [];
  const readErrors = state.snapshot?.errors ?? [];
  const target = state.configuration?.whatsappConversation;
  return <article className="assistant-work-card" aria-label="Local communication monitor">
    <div className="assistant-card-heading"><strong>Local read monitor</strong><span>{state.running ? 'Active' : 'Needs attention'}</span></div>
    {state.error ? <p role="alert">{state.error}</p> : <p>Watching bounded local sources every {state.configuration?.intervalMinutes} minute{state.configuration?.intervalMinutes === 1 ? '' : 's'}{target ? `; WhatsApp is bound to ${target.label} (${target.jid})` : ''}. Latest snapshot: {messages} Messages thread{messages === 1 ? '' : 's'}, {whatsapp} WhatsApp observation{whatsapp === 1 ? '' : 's'}.</p>}
    {!!readErrors.length && <ul>{readErrors.map((item, index) => <li key={`${item.source}-${index}`} role="alert">{item.source}: {item.message}</li>)}</ul>}
    {!!hints.length && <details><summary>{hints.length} new keyword-based attention hint{hints.length === 1 ? '' : 's'}</summary><p>Heuristic only; review the original conversation before acting.</p><ul>{hints.slice(0, 5).map(hint => <li key={hint.observationId}><strong>{hint.threadTitle}</strong> · {hint.keywords.join(', ')}</li>)}</ul></details>}
  </article>;
}
