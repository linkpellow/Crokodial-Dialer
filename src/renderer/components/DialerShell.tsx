/** Keep every workspace mounted: call audio, auto-dial, drafts and requests survive navigation. */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Phone, Sparkles, Settings, FileText } from 'lucide-react';
import { useDialer } from '@/renderer/hooks/useDialer';
import { DialerPage } from '@/renderer/components/DialerPage';
import { SettingsPage } from '@/renderer/components/SettingsPage';
import { PersonalAssistant } from '@/renderer/components/PersonalAssistant';
import { NotesWorkspace } from './NotesWorkspace';
import { ContactNotesDrafts } from '../services/contactNotesDrafts';
import { NativeRecordingController } from '../services/nativeRecordingController';
import { notesApi } from '../services/notesApiService';
import { registerNativeWorkGuard } from '../services/nativeWorkGuard';

export function DialerShell({ onLogout }: { onLogout: () => void }) {
  const { state, actions, engine } = useDialer();
  const engineRef = useRef(engine); engineRef.current = engine;
  const [notes] = useState(() => new ContactNotesDrafts(notesApi.save));
  const [recording] = useState(() => new NativeRecordingController(notesApi, () => engineRef.current?.getRecordingCallSnapshot() ?? null, job => {
    if (typeof job.notes === 'string' && Number.isSafeInteger(job.notesRevision)) notes.receive({ contactId: job.contactId, notes: job.notes, notesRevision: job.notesRevision! });
  }));
  const capture = useSyncExternalStore(recording.subscribe, recording.getSnapshot);
  const resourceGeneration = useRef(0);
  const [guardMessage, setGuardMessage] = useState('');
  useEffect(() => {
    const generation = ++resourceGeneration.current;
    const guard = (event: BeforeUnloadEvent) => { if (recording.hasUnsavedAudio() || notes.isDirty()) { event.preventDefault(); event.returnValue = ''; } };
    const clearGuard = registerNativeWorkGuard(() => recording.hasUnsavedAudio() || notes.isDirty());
    window.addEventListener('beforeunload', guard);
    return () => { clearGuard(); window.removeEventListener('beforeunload', guard); queueMicrotask(() => { if (resourceGeneration.current === generation) { recording.dispose(); notes.dispose(); } }); };
  }, [recording, notes]);
  const safeLogout = async () => {
    if (recording.hasUnsavedAudio()) { setGuardMessage('Stop recording and finish pending uploads before signing out.'); setView('notes'); return; }
    if (!await notes.flushAll()) { setGuardMessage('Save or resolve your note drafts before signing out.'); setView('notes'); return; }
    if (recording.hasUnsavedAudio() || notes.isDirty()) { setGuardMessage('Finish pending recordings and notes before signing out.'); setView('notes'); return; }
    onLogout();
  };
  const [view, setView] = useState<'dialer' | 'assistant' | 'notes' | 'settings'>('dialer');
  const callActive = ['dialing', 'ringing', 'in_call', 'held'].includes(state.uiState);
  return (
    <div className="unified-shell">
      {guardMessage && <div className="native-recording-banner" role="alert"><span>{guardMessage}</span><button onClick={() => setGuardMessage('')}>Dismiss</button></div>}
      {(recording.hasUnsavedAudio() || capture.phase === 'processing') && <div className="native-recording-banner"><span>{capture.phase === 'recording' ? 'Recording' : 'Recording work'} · {capture.contact?.name} · {Math.floor(capture.elapsedSeconds / 60)}:{String(capture.elapsedSeconds % 60).padStart(2, '0')}</span><button onClick={() => setView('notes')}>Open Notes</button></div>}
      <div className="workspace-container">
        <section id="dialer-workspace" role="tabpanel" aria-labelledby="dialer-tab" hidden={view !== 'dialer'} className="workspace-panel">
          <DialerPage state={state} actions={actions} onLogout={() => void safeLogout()} onOpenSettings={() => setView('settings')} />
        </section>
        <section id="assistant-workspace" role="tabpanel" aria-labelledby="assistant-tab" hidden={view !== 'assistant'} className="workspace-panel">
          <PersonalAssistant active={view === 'assistant'} callActive={callActive} callLabel={state.leadContext?.leadName || state.phoneNumber} onReturnToCall={() => setView('dialer')} />
        </section>
        <section id="notes-workspace" role="tabpanel" aria-labelledby="notes-tab" hidden={view !== 'notes'} className="workspace-panel">
          <NotesWorkspace engine={engine} store={notes} recording={recording} onReturnToCall={() => setView('dialer')} />
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
        <button id="dialer-tab" role="tab" tabIndex={view === 'dialer' ? 0 : -1} aria-label="Dialer" title={callActive ? 'Dialer — Call in progress' : 'Dialer'} aria-controls="dialer-workspace" aria-selected={view === 'dialer'} onClick={() => setView('dialer')}><Phone size={18} aria-hidden="true"/>{callActive && <i className="live-call-dot" aria-label="Call in progress"/>}</button>
        <button id="assistant-tab" role="tab" tabIndex={view === 'assistant' ? 0 : -1} aria-label="Assistant" title="Assistant" aria-controls="assistant-workspace" aria-selected={view === 'assistant'} onClick={() => setView('assistant')}><Sparkles size={18} aria-hidden="true"/></button>
        <button id="notes-tab" role="tab" tabIndex={view === 'notes' ? 0 : -1} aria-label="Notes" title="Notes" aria-controls="notes-workspace" aria-selected={view === 'notes'} onClick={() => setView('notes')}><FileText size={18} aria-hidden="true"/></button>
        <button id="settings-tab" role="tab" tabIndex={view === 'settings' ? 0 : -1} aria-label="Settings" title="Settings" aria-controls="settings-workspace" aria-selected={view === 'settings'} onClick={() => setView('settings')}><Settings size={18} aria-hidden="true"/></button>
      </nav>
    </div>
  );
}
