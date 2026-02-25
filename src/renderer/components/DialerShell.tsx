/**
 * DialerShell - Wraps DialerPage and SettingsPage with shared useDialer state.
 * Manages navigation between dialer and settings views.
 */

import { useState } from 'react';
import { useDialer } from '@/renderer/hooks/useDialer';
import { DialerPage } from '@/renderer/components/DialerPage';
import { SettingsPage } from '@/renderer/components/SettingsPage';

interface DialerShellProps {
  onLogout: () => void;
}

export function DialerShell({ onLogout }: DialerShellProps) {
  const { state, actions } = useDialer();
  const [view, setView] = useState<'dialer' | 'settings'>('dialer');

  if (view === 'settings') {
    return (
      <SettingsPage
        state={state}
        actions={actions}
        onBack={() => setView('dialer')}
      />
    );
  }

  return (
    <DialerPage
      state={state}
      actions={actions}
      onLogout={onLogout}
      onOpenSettings={() => setView('settings')}
    />
  );
}
