/**
 * Crokodial Dialer - FloatingDialerWidget layout
 * Auth-guarded: Login required before Telnyx and dialer mount.
 *
 * @see dialerblueprint.md Section 1 (Visual Framework), Section 4 (Asset Manifest)
 */

import { useEffect, useState } from 'react';
import { checkAuth, getStoredUser, logout, UNAUTHORIZED_EVENT, REQUIRES_TENANT_EVENT, type LoginUser } from '@/renderer/services/dialerApiService';
import { LoginScreen } from '@/renderer/components/LoginScreen';
import { DialerShell } from '@/renderer/components/DialerShell';

function App() {
  const [user, setUser] = useState<LoginUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authAttempt, setAuthAttempt] = useState(0);
  const [requiresOrgMessage, setRequiresOrgMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setAuthLoading(true);
    setAuthError(null);
    checkAuth().then((valid) => {
      if (cancelled) return;
      setUser(valid ? getStoredUser() : null);
      setAuthLoading(false);
    }).catch((error) => {
      if (cancelled) return;
      setAuthError(error instanceof Error ? error.message : 'Unable to connect to Crokodial.');
      setAuthLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [authAttempt]);

  useEffect(() => {
    const handler = () => setUser(null);
    window.addEventListener(UNAUTHORIZED_EVENT, handler);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, handler);
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ message?: string }>).detail;
      setUser(null);
      setRequiresOrgMessage(detail?.message ?? 'An organization is required.');
    };
    window.addEventListener(REQUIRES_TENANT_EVENT, handler);
    return () => window.removeEventListener(REQUIRES_TENANT_EVENT, handler);
  }, []);

  const handleLogin = (u: LoginUser) => {
    setUser(u);
    setRequiresOrgMessage(null);
  };

  const handleLogout = () => {
    logout();
    setUser(null);
  };

  if (authLoading) {
    return (
      <div
        className="h-full w-full flex items-center justify-center"
        style={{
          background: 'radial-gradient(ellipse 120% 80% at 50% 30%, #a8e063 0%, #7cb342 25%, #5a8a0f 55%, #2d5016 100%)',
        }}
      >
        <p className="text-white/90 text-sm">Loading...</p>
      </div>
    );
  }

  if (authError) {
    return <div className="assistant-workspace"><div className="assistant-empty"><h2>Connection interrupted</h2><p role="alert">{authError}</p><button onClick={() => setAuthAttempt(value => value + 1)}>Retry connection</button><button onClick={() => setAuthError(null)}>Sign in</button></div></div>;
  }

  if (!user) {
    return (
      <LoginScreen
        onLogin={handleLogin}
        setupMessage={requiresOrgMessage}
        onDismissSetupMessage={() => setRequiresOrgMessage(null)}
      />
    );
  }

  return <DialerShell onLogout={handleLogout} />;
}

export default App;
