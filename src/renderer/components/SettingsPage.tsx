/**
 * SettingsPage - Caller ID and dialer preferences.
 */

import { motion } from 'framer-motion';
import { ChevronLeft } from 'lucide-react';
import type { UseDialerState, UseDialerActions } from '@/renderer/hooks/useDialer';

const btnTap = { scale: 0.94 };
const btnHover = { scale: 1.02 };

interface SettingsPageProps {
  state: UseDialerState;
  actions: UseDialerActions;
  onBack: () => void;
}

export function SettingsPage({ state, actions, onBack }: SettingsPageProps) {
  return (
    <div
      className="h-full flex flex-col overflow-hidden"
      style={{
        WebkitAppRegion: 'drag' as React.CSSProperties['WebkitAppRegion'],
        background: 'radial-gradient(ellipse 120% 80% at 50% 30%, #a8e063 0%, #7cb342 25%, #5a8a0f 55%, #2d5016 100%)',
        border: '1px solid rgba(255,255,255,0.12)',
      }}
    >
      {/* Header */}
      <motion.header
        className="shrink-0 flex flex-col border-b border-white/10"
        style={{
          background: 'rgba(26, 61, 26, 0.6)',
          backdropFilter: 'blur(12px)',
          WebkitBackdropFilter: 'blur(12px)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
        }}
      >
        <div className="flex items-center justify-between px-3 py-2.5">
          <motion.button
            type="button"
            onClick={onBack}
            whileTap={btnTap}
            whileHover={btnHover}
            className="flex items-center gap-1.5 text-white/95 font-medium text-sm"
            style={{ WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'] }}
          >
            <ChevronLeft size={18} />
            Back
          </motion.button>
          <h1 className="text-white/95 font-semibold text-sm tracking-wide">Settings</h1>
          <div className="w-12" />
        </div>
      </motion.header>

      {/* Content */}
      <main className="flex-1 flex flex-col min-h-0 p-4 gap-4 overflow-auto">
        {/* Caller ID */}
        <div className="shrink-0 flex flex-col gap-1">
          <label htmlFor="caller-id" className="text-white/90 text-xs font-medium">
            Caller ID
          </label>
          <select
            id="caller-id"
            value={state.selectedCallerNumber}
            onChange={(e) => actions.setSelectedCallerNumber(e.target.value)}
            className="w-full text-white rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-white/40 focus:ring-offset-1 focus:ring-offset-transparent"
            style={{
              WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'],
              background: 'rgba(26, 61, 26, 0.7)',
              border: '1px solid rgba(255,255,255,0.1)',
              boxShadow: 'inset 0 2px 6px rgba(0,0,0,0.25), inset 0 -1px 0 rgba(255,255,255,0.05)',
            }}
          >
            <option value="auto">Auto</option>
            {(state.userAssignments.length > 0 ? state.userAssignments : state.availablePhoneNumbers).map((num) => (
              <option key={num} value={num}>
                {num}
              </option>
            ))}
          </select>
        </div>
      </main>
    </div>
  );
}
