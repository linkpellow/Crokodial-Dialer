/**
 * LoginScreen - Crokodial agent login for standalone dialer.
 * Auth-guarded: Telnyx and dialer UI mount only after successful login.
 */

import { useState } from 'react';
import { motion } from 'framer-motion';
import { login, type LoginUser } from '@/renderer/services/dialerApiService';
import { extractErrorMessage } from '@/utils/extractErrorMessage';

interface LoginScreenProps {
  onLogin: (user: LoginUser) => void;
  setupMessage?: string | null;
  onDismissSetupMessage?: () => void;
}

export function LoginScreen({ onLogin, setupMessage, onDismissSetupMessage }: LoginScreenProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const user = await login(email.trim(), password);
      onLogin(user);
    } catch (err) {
      setError(extractErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="h-full w-full flex flex-col items-center justify-center p-6"
      style={{
        background: 'radial-gradient(ellipse 120% 80% at 50% 30%, #a8e063 0%, #7cb342 25%, #5a8a0f 55%, #2d5016 100%)',
        WebkitAppRegion: 'drag' as React.CSSProperties['WebkitAppRegion'],
      }}
    >
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-xs rounded-xl p-6 shadow-xl"
        style={{
          background: 'rgba(26, 61, 26, 0.85)',
          border: '1px solid rgba(255,255,255,0.12)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), 0 8px 32px rgba(0,0,0,0.3)',
          WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'],
        }}
      >
        <h2 className="text-white text-lg font-semibold mb-4 text-center">Crokodial Dialer</h2>
        <p className="text-white/80 text-sm mb-5 text-center">Sign in to continue</p>
        {setupMessage && (
          <div
            className="mb-4 rounded-lg px-3 py-2.5 flex items-start gap-2"
            style={{
              background: 'rgba(234, 179, 8, 0.2)',
              border: '1px solid rgba(234, 179, 8, 0.4)',
            }}
          >
            <p className="text-amber-200 text-xs flex-1">{setupMessage}</p>
            {onDismissSetupMessage && (
              <button
                type="button"
                onClick={onDismissSetupMessage}
                className="text-amber-200/80 hover:text-amber-100 text-xs shrink-0"
              >
                Dismiss
              </button>
            )}
          </div>
        )}
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="Email"
            required
            autoComplete="email"
            className="w-full rounded-lg px-3 py-2.5 text-white placeholder-white/40 text-sm focus:outline-none focus:ring-2 focus:ring-white/40"
            style={{
              background: 'rgba(26, 61, 26, 0.8)',
              border: '1px solid rgba(255,255,255,0.15)',
            }}
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Password"
            required
            autoComplete="current-password"
            className="w-full rounded-lg px-3 py-2.5 text-white placeholder-white/40 text-sm focus:outline-none focus:ring-2 focus:ring-white/40"
            style={{
              background: 'rgba(26, 61, 26, 0.8)',
              border: '1px solid rgba(255,255,255,0.15)',
            }}
          />
          {error && (
            <p className="text-red-300 text-sm">{error}</p>
          )}
          <motion.button
            type="submit"
            disabled={loading}
            whileTap={{ scale: 0.98 }}
            className="w-full py-2.5 rounded-lg text-white font-medium text-sm disabled:opacity-60 disabled:cursor-not-allowed"
            style={{
              background: 'linear-gradient(180deg, #52e878 0%, #34C759 50%, #2a9d41 100%)',
              boxShadow: '0 2px 8px rgba(52,199,89,0.4)',
            }}
          >
            {loading ? 'Signing in...' : 'Sign in'}
          </motion.button>
        </form>
      </motion.div>
    </div>
  );
}
