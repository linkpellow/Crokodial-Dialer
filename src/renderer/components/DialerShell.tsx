/** Keep every workspace mounted: call audio, auto-dial, drafts and requests survive navigation. */
import { useState } from 'react';
import { Phone, Sparkles, Settings } from 'lucide-react';
import { useDialer } from '@/renderer/hooks/useDialer';
import { DialerPage } from '@/renderer/components/DialerPage';
import { SettingsPage } from '@/renderer/components/SettingsPage';
import { PersonalAssistant } from '@/renderer/components/PersonalAssistant';

export function DialerShell({ onLogout }: { onLogout: () => void }) {
  const { state, actions } = useDialer();
  const [view, setView] = useState<'dialer' | 'assistant' | 'settings'>('dialer');
  const callActive = ['dialing', 'ringing', 'in_call', 'held'].includes(state.uiState);
  return (
    <div className="unified-shell">
      <div className="workspace-container">
        <section id="dialer-workspace" role="tabpanel" aria-labelledby="dialer-tab" hidden={view !== 'dialer'} className="workspace-panel">
          <DialerPage state={state} actions={actions} onLogout={onLogout} onOpenSettings={() => setView('settings')} />
        </section>
        <section id="assistant-workspace" role="tabpanel" aria-labelledby="assistant-tab" hidden={view !== 'assistant'} className="workspace-panel">
          <PersonalAssistant active={view === 'assistant'} callActive={callActive} callLabel={state.leadContext?.leadName || state.phoneNumber} onReturnToCall={() => setView('dialer')} />
        </section>
        <section id="settings-workspace" role="tabpanel" aria-labelledby="settings-tab" hidden={view !== 'settings'} className="workspace-panel">
          <SettingsPage state={state} actions={actions} onBack={() => setView('dialer')} />
        </section>
      </div>
      <nav className="workspace-nav" aria-label="Crokodial workspaces" role="tablist" onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
        const current = tabs.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        tabs[next]?.click(); tabs[next]?.focus();
      }}>
        <button id="dialer-tab" role="tab" tabIndex={view === 'dialer' ? 0 : -1} aria-controls="dialer-workspace" aria-selected={view === 'dialer'} onClick={() => setView('dialer')}><Phone size={14}/><span>Dialer</span>{callActive && <i className="live-call-dot" aria-label="Call in progress"/>}</button>
        <button id="assistant-tab" role="tab" tabIndex={view === 'assistant' ? 0 : -1} aria-controls="assistant-workspace" aria-selected={view === 'assistant'} onClick={() => setView('assistant')}><Sparkles size={14}/><span>Assistant</span></button>
        <button id="settings-tab" className="settings-tab" role="tab" tabIndex={view === 'settings' ? 0 : -1} aria-label="Settings" aria-controls="settings-workspace" aria-selected={view === 'settings'} onClick={() => setView('settings')}><Settings size={15}/></button>
      </nav>
    </div>
  );
}
