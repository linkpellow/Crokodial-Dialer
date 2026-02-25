/**
 * DialerPage - Main dialer UI after authentication.
 * Keypad, caller ID, call controls, disposition modal.
 *
 * @see dialerblueprint.md Section 1 (Visual Framework)
 */

import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Mic, MicOff, Pause, Phone, PhoneOff, Play, LogOut, Volume2, Zap, Tag, ChevronDown, Settings } from 'lucide-react';
import { useAutoDialer } from '@/renderer/hooks/useAutoDialer';
import { saveDisposition, fetchFilterOptions } from '@/renderer/services/dialerApiService';
import { DispositionModal } from '@/renderer/components/DispositionModal';
import { GlassCheckbox } from '@/renderer/components/ui/GlassCheckbox';

const KEYPAD_KEYS = [
  ['1', '2', '3'],
  ['4', '5', '6'],
  ['7', '8', '9'],
  ['*', '0', '#'],
];

const btnTap = { scale: 0.94 };
const btnHover = { scale: 1.02 };
const keypadTapGlow = {
  scale: 0.94,
  boxShadow:
    'inset 0 0 12px rgba(255,255,255,0.4), inset 0 2px 6px rgba(0,0,0,0.35), inset 0 -1px 0 rgba(255,255,255,0.06), 0 1px 2px rgba(0,0,0,0.15)',
  transition: { duration: 0.1 },
};

interface DialerPageProps {
  state: import('@/renderer/hooks/useDialer').UseDialerState;
  actions: import('@/renderer/hooks/useDialer').UseDialerActions;
  onLogout: () => void;
  onOpenSettings: () => void;
}

export function DialerPage({ state, actions, onLogout, onOpenSettings }: DialerPageProps) {
  const [leadFilters, setLeadFilters] = useState({ dispositions: [] as string[] });
  const [filterOptions, setFilterOptions] = useState({ dispositions: [] as string[] });
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const dispositionsRef = useRef<HTMLDivElement>(null);
  const autoDial = useAutoDialer(actions.startCallWithLead, state.connectionStatus, leadFilters);
  const audioRef = useRef<HTMLAudioElement>(null);
  const ringbackRef = useRef<HTMLAudioElement | null>(null);
  const lastResizeModeRef = useRef<'compact' | 'full' | null>(null);
  useEffect(() => {
    fetchFilterOptions().then((opts) =>
      setFilterOptions({ dispositions: opts.dispositions ?? [] })
    );
  }, []);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dispositionsRef.current && !dispositionsRef.current.contains(e.target as Node)) {
        setOpenDropdown(null);
      }
    };
    if (openDropdown) {
      document.addEventListener('mousedown', handleClickOutside, true);
      return () => document.removeEventListener('mousedown', handleClickOutside, true);
    }
  }, [openDropdown]);

  // Outbound ringback: play when ringing outbound and configured
  useEffect(() => {
    const shouldPlay =
      state.uiState === 'ringing' &&
      state.callDirection === 'outbound' &&
      state.outboundRingSound;

    if (!shouldPlay) {
      const el = ringbackRef.current;
      if (el) {
        el.pause();
        el.currentTime = 0;
      }
      return;
    }

    let el = ringbackRef.current;
    if (!el) {
      el = new Audio();
      ringbackRef.current = el;
    }
    el.src = state.outboundRingSound!;
    el.loop = true;
    el.play().catch(() => {});
    return () => {
      el?.pause();
      el ? (el.currentTime = 0) : null;
    };
  }, [state.uiState, state.callDirection, state.outboundRingSound]);

  // Attach remote stream to audio element when available
  useEffect(() => {
    const el = audioRef.current;
    if (el && state.remoteStream) {
      el.srcObject = state.remoteStream;
    }
  }, [state.remoteStream]);

  // Apply volume from settings
  useEffect(() => {
    const el = audioRef.current;
    if (el) {
      el.volume = Math.max(0, Math.min(1, state.volume / 100));
    }
  }, [state.volume]);

  const isInCall = state.uiState === 'in_call' || state.uiState === 'held';
  const isRinging = state.uiState === 'ringing';
  const showAnswer = isRinging;
  const showCall = state.uiState === 'idle' || state.uiState === 'ended';

  // Compact mode is temporarily disabled. Keep a single full layout.
  const showCompactCallView = false;

  const getStatusText = () => {
    if (state.uiState === 'idle') return 'Ready to call';
    if (state.uiState === 'dialing') return 'Dialing…';
    if (state.uiState === 'ringing') {
      return state.callDirection === 'inbound' ? 'Incoming call' : 'Ringing…';
    }
    if (state.uiState === 'in_call') return 'Call in progress';
    if (state.uiState === 'held') return 'Call on hold';
    return 'Ready to call';
  };

  const handleCallOrAnswer = () => {
    if (showAnswer) {
      actions.answerCall();
    } else if (showCall) {
      actions.startCall();
    }
  };

  const handleDispositionSave = async (
    disposition: string,
    notes: string
  ): Promise<{ ok: boolean; error?: string }> => {
    const contactId = state.leadContext?.leadId;
    if (!contactId) {
      actions.resetToIdle();
      autoDial.actions.signalDispositionComplete();
      return { ok: true };
    }
    const result = await saveDisposition(contactId, { disposition, notes });
    if (!result.ok) return result;
    actions.resetToIdle();
    autoDial.actions.signalDispositionComplete();
    return { ok: true };
  };

  const handleDispositionSkip = () => {
    actions.resetToIdle();
    autoDial.actions.signalDispositionComplete();
  };

  // When call ends without a contact (manual dial), skip disposition modal and reset immediately
  useEffect(() => {
    if (state.uiState === 'ended' && !state.leadContext?.leadId) {
      actions.resetToIdle();
      autoDial.actions.signalDispositionComplete();
    }
  }, [state.uiState, state.leadContext?.leadId]);

  useEffect(() => {
    if (!window.dialer?.windowResize) return;
    if (lastResizeModeRef.current === 'full') return;
    lastResizeModeRef.current = 'full';
    window.dialer.windowResize('full');
  }, []);

  return (
    <div
      className="relative h-full w-full overflow-hidden select-none flex flex-col rounded-lg utopia-noise"
      style={{
        WebkitAppRegion: 'drag' as React.CSSProperties['WebkitAppRegion'],
        background: 'radial-gradient(ellipse 120% 80% at 50% 30%, #a8e063 0%, #7cb342 25%, #5a8a0f 55%, #2d5016 100%)',
        border: '1px solid rgba(255,255,255,0.12)',
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.1), 0 4px 24px rgba(0,0,0,0.2)',
      }}
    >
      {/* Hidden audio for remote stream */}
      <audio ref={audioRef} autoPlay playsInline style={{ display: 'none' }} />

      {state.permissionError && (
        <div
          className="shrink-0 flex items-center justify-between gap-3 px-4 py-2"
          style={{
            background: 'rgba(185, 28, 28, 0.9)',
            color: 'white',
            WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'],
          }}
        >
          <span className="text-sm font-medium">Microphone Access Required</span>
          <motion.button
            type="button"
            onClick={actions.clearPermissionError}
            whileTap={btnTap}
            whileHover={btnHover}
            className="px-2 py-1 rounded text-xs font-medium bg-white/20 hover:bg-white/30"
          >
            Dismiss
          </motion.button>
        </div>
      )}

      {state.connectionStatus === 'error' && state.connectionErrorMessage && (
        <div
          className="shrink-0 flex items-center justify-between gap-3 px-4 py-2"
          style={{
            background: 'rgba(185, 28, 28, 0.9)',
            color: 'white',
            WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'],
          }}
        >
          <span className="text-sm font-medium">{state.connectionErrorMessage}</span>
          <motion.button
            type="button"
            onClick={actions.retryConnection}
            whileTap={btnTap}
            whileHover={btnHover}
            className="px-2 py-1 rounded text-xs font-medium bg-white/20 hover:bg-white/30"
          >
            Retry
          </motion.button>
        </div>
      )}

      <div className="flex-1 flex flex-col min-h-0 overflow-visible">
        {/* Header: glass bar with connection pulse when registered */}
        <motion.header
          className="shrink-0 flex flex-col border-b border-white/10"
          style={{
            background: 'rgba(26, 61, 26, 0.6)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
          }}
          animate={{
            boxShadow:
              state.connectionStatus === 'registered'
                ? [
                    '0 0 8px rgba(52,199,89,0.3), inset 0 1px 0 rgba(255,255,255,0.06)',
                    '0 0 16px rgba(52,199,89,0.6), inset 0 1px 0 rgba(255,255,255,0.06)',
                    '0 0 8px rgba(52,199,89,0.3), inset 0 1px 0 rgba(255,255,255,0.06)',
                  ]
                : 'inset 0 1px 0 rgba(255,255,255,0.06)',
          }}
          transition={{
            repeat: state.connectionStatus === 'registered' ? Infinity : 0,
            duration: 2,
          }}
        >
          <div className="flex items-center justify-between px-3 py-2.5">
            <div className="flex items-center gap-2">
              <h1 className="text-white/95 font-semibold text-sm tracking-wide">Crokodial</h1>
              <motion.button
                type="button"
                onClick={() => (autoDial.isActive ? autoDial.actions.stopAutoDial() : autoDial.actions.startAutoDial())}
                whileTap={btnTap}
                whileHover={btnHover}
                className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors"
                style={{
                  WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'],
                  background: autoDial.isActive ? 'rgba(52,199,89,0.4)' : 'rgba(255,255,255,0.1)',
                  color: 'white',
                }}
                title={autoDial.isActive ? 'Stop auto-dial' : 'Start auto-dial'}
              >
                <Zap size={12} />
                {autoDial.isActive ? 'Stop' : 'Auto'}
              </motion.button>
              {autoDial.status === 'queueEmpty' && (
                <span className="text-white/80 text-xs">Queue Empty</span>
              )}
              {autoDial.status === 'disconnected' && (
                <span className="text-amber-300/90 text-xs">Reconnect to dial</span>
              )}
              <div className="relative z-[150] hidden" ref={dispositionsRef}>
                <button
                  type="button"
                  onClick={() => setOpenDropdown((v) => (v === 'dispositions' ? null : 'dispositions'))}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-2 ${
                    leadFilters.dispositions.length > 0
                      ? 'bg-lime-500/20 text-lime-400 border border-lime-500/30'
                      : 'bg-white/5 text-white/80 hover:bg-white/10 border border-white/10'
                  }`}
                  style={{ WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'] }}
                >
                  <Tag className="w-4 h-4" />
                  <span>Disposition</span>
                  {leadFilters.dispositions.length > 0 && (
                    <span className="bg-lime-500 text-black text-xs font-bold px-1.5 py-0.5 rounded">
                      {leadFilters.dispositions.length}
                    </span>
                  )}
                  <ChevronDown
                    className={`w-3 h-3 transition-transform ${openDropdown === 'dispositions' ? 'rotate-180' : ''}`}
                  />
                </button>
                <AnimatePresence>
                  {openDropdown === 'dispositions' && (
                    <motion.div
                      initial={{ opacity: 0, y: -10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      transition={{ duration: 0.15 }}
                      className="absolute left-0 top-full mt-1 py-2 rounded-lg overflow-hidden min-w-[180px] max-h-48 overflow-y-auto"
                      style={{
                        background: 'rgba(26, 61, 26, 0.95)',
                        backdropFilter: 'blur(12px)',
                        border: '1px solid rgba(255,255,255,0.12)',
                        boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
                      }}
                    >
                      <div className="space-y-1.5 px-2">
                        {filterOptions.dispositions.map((d) => (
                          <GlassCheckbox
                            key={d}
                            checked={leadFilters.dispositions.includes(d)}
                            onChange={() => {
                              setLeadFilters((prev) => ({
                                ...prev,
                                dispositions: prev.dispositions.includes(d)
                                  ? prev.dispositions.filter((x) => x !== d)
                                  : [...prev.dispositions, d],
                              }));
                            }}
                            label={d}
                          />
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
            <div className="flex gap-1.5" style={{ WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'] }}>
              <motion.button
                type="button"
                onClick={onOpenSettings}
                whileTap={btnTap}
                whileHover={btnHover}
                className="w-7 h-7 rounded-md flex items-center justify-center text-white/90 hover:text-white text-xs transition-colors"
                style={{
                  background: 'linear-gradient(180deg, rgba(255,255,255,0.12) 0%, rgba(0,0,0,0.15) 100%)',
                  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.1), 0 1px 2px rgba(0,0,0,0.2)',
                }}
                title="Settings"
              >
                <Settings size={14} />
              </motion.button>
              <motion.button
                type="button"
                onClick={onLogout}
                whileTap={btnTap}
                whileHover={btnHover}
                className="w-7 h-7 rounded-md flex items-center justify-center text-white/90 hover:text-white text-xs transition-colors"
                style={{
                  background: 'linear-gradient(180deg, rgba(255,255,255,0.12) 0%, rgba(0,0,0,0.15) 100%)',
                  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.1), 0 1px 2px rgba(0,0,0,0.2)',
                }}
                title="Log out"
              >
                <LogOut size={14} />
              </motion.button>
              <motion.button
                type="button"
                onClick={() => window.dialer?.minimize()}
                whileTap={btnTap}
                whileHover={btnHover}
                className="w-7 h-7 rounded-md flex items-center justify-center text-white/90 hover:text-white text-xs transition-colors"
                style={{
                  background: 'linear-gradient(180deg, rgba(255,255,255,0.12) 0%, rgba(0,0,0,0.15) 100%)',
                  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.1), 0 1px 2px rgba(0,0,0,0.2)',
                }}
              >
                −
              </motion.button>
              <motion.button
                type="button"
                onClick={() => window.dialer?.close()}
                whileTap={btnTap}
                whileHover={btnHover}
                className="w-7 h-7 rounded-md flex items-center justify-center text-white/90 hover:text-white text-xs transition-colors"
                style={{
                  background: 'linear-gradient(180deg, rgba(255,255,255,0.12) 0%, rgba(0,0,0,0.15) 100%)',
                  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.1), 0 1px 2px rgba(0,0,0,0.2)',
                }}
              >
                ×
              </motion.button>
            </div>
          </div>
          {/* Liquid-fill connection progress bar */}
          <div className="h-0.5 w-full overflow-hidden bg-black/20">
            <motion.div
              className="h-full rounded-r-full"
              animate={{
                width:
                  state.connectionStatus === 'connecting' || state.connectionStatus === 'connected'
                    ? ['0%', '100%']
                    : state.connectionStatus === 'registered'
                      ? '100%'
                      : state.connectionStatus === 'error'
                        ? '100%'
                        : '0%',
                backgroundColor:
                  state.connectionStatus === 'registered'
                    ? 'rgba(52,199,89,0.9)'
                    : state.connectionStatus === 'error'
                      ? 'rgba(239,68,68,0.8)'
                      : 'rgba(52,199,89,0.6)',
              }}
              transition={{
                width:
                  state.connectionStatus === 'connecting' || state.connectionStatus === 'connected'
                    ? { repeat: Infinity, duration: 1.5 }
                    : { duration: 0.3 },
                backgroundColor: { duration: 0.2 },
              }}
            />
          </div>
        </motion.header>

        <main className="flex-1 flex flex-col min-h-0 overflow-visible">
          <AnimatePresence mode="wait">
            {showCompactCallView ? (
              <motion.div
                key="compact"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.95 }}
                transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
                className="flex flex-col flex-1 p-1.5 gap-1.5 min-h-0 justify-between"
                style={{ WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'] }}
              >
                <div
                  className="shrink-0 rounded-xl p-2.5 flex flex-col gap-0.5"
                  style={{
                    background: 'rgba(26, 61, 26, 0.7)',
                    border: '1px solid rgba(255,255,255,0.1)',
                    boxShadow: 'inset 0 2px 6px rgba(0,0,0,0.25)',
                  }}
                >
                  <p className="text-white/90 text-sm font-medium truncate">
                    {state.leadContext?.leadName || 'Unknown'}
                  </p>
                  <p className="text-white/70 text-xs truncate">
                    {state.leadContext?.leadPhone ?? state.phoneNumber ?? ''}
                  </p>
                  <p className="text-lime-400/90 text-xs mt-0.5">{getStatusText()}</p>
                </div>
                <div className="shrink-0 flex items-center gap-1.5">
                  <Volume2 size={16} className="text-white/90 shrink-0" />
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={state.volume}
                    onChange={(e) => actions.setVolume(Number(e.target.value))}
                    className="flex-1 h-1.5 appearance-none rounded-full min-w-0 bg-white/20"
                    style={{ WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'] }}
                  />
                </div>
                <div
                  className="shrink-0 flex items-center justify-center gap-2.5 py-1.5 border-t border-white/10"
                  style={{
                    background: 'rgba(26, 61, 26, 0.6)',
                    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
                  }}
                >
                  {isInCall ? (
                    <>
                      <motion.button
                        type="button"
                        onClick={actions.toggleMute}
                        whileTap={btnTap}
                        whileHover={{ scale: 1.08 }}
                        className="w-12 h-12 rounded-full text-white flex items-center justify-center"
                        style={{
                          WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'],
                          background: 'linear-gradient(180deg, rgba(40,70,40,0.9) 0%, rgba(26,61,26,0.95) 100%)',
                          boxShadow: 'inset 0 2px 6px rgba(0,0,0,0.35), inset 0 -1px 0 rgba(255,255,255,0.06), 0 2px 6px rgba(0,0,0,0.2)',
                          border: '1px solid rgba(255,255,255,0.06)',
                        }}
                      >
                        {state.isMuted ? <MicOff size={22} /> : <Mic size={22} />}
                      </motion.button>
                      <motion.button
                        type="button"
                        onClick={actions.hangupCall}
                        whileTap={btnTap}
                        whileHover={{ scale: 1.08 }}
                        className="w-16 h-16 rounded-full text-white flex items-center justify-center"
                        style={{
                          WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'],
                          background: 'linear-gradient(180deg, rgba(185,28,28,0.9) 0%, rgba(153,27,27,0.95) 100%)',
                          boxShadow: '0 0 24px rgba(185,28,28,0.4), 0 4px 12px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.15)',
                          border: '1px solid rgba(255,255,255,0.15)',
                        }}
                      >
                        <PhoneOff size={28} />
                      </motion.button>
                      <motion.button
                        type="button"
                        onClick={actions.toggleHold}
                        whileTap={btnTap}
                        whileHover={{ scale: 1.08 }}
                        className="w-12 h-12 rounded-full text-white flex items-center justify-center"
                        style={{
                          WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'],
                          background: 'linear-gradient(180deg, rgba(40,70,40,0.9) 0%, rgba(26,61,26,0.95) 100%)',
                          boxShadow: 'inset 0 2px 6px rgba(0,0,0,0.35), inset 0 -1px 0 rgba(255,255,255,0.06), 0 2px 6px rgba(0,0,0,0.2)',
                          border: '1px solid rgba(255,255,255,0.06)',
                        }}
                      >
                        {state.isOnHold ? <Play size={22} /> : <Pause size={22} />}
                      </motion.button>
                    </>
                  ) : isRinging && state.callDirection === 'inbound' ? (
                    <>
                      <motion.button
                        type="button"
                        onClick={actions.hangupCall}
                        whileTap={btnTap}
                        whileHover={{ scale: 1.08 }}
                        className="w-12 h-12 rounded-full text-white flex items-center justify-center"
                        style={{
                          WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'],
                          background: 'linear-gradient(180deg, rgba(185,28,28,0.9) 0%, rgba(153,27,27,0.95) 100%)',
                          boxShadow: '0 0 24px rgba(185,28,28,0.4), 0 4px 12px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.15)',
                          border: '1px solid rgba(255,255,255,0.15)',
                        }}
                      >
                        <PhoneOff size={22} />
                      </motion.button>
                      <motion.button
                        type="button"
                        onClick={actions.answerCall}
                        whileTap={btnTap}
                        whileHover={{ scale: 1.06 }}
                        className="call-btn-glow w-16 h-16 rounded-full text-white flex items-center justify-center"
                        style={{
                          WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'],
                          background: 'linear-gradient(180deg, #52e878 0%, #34C759 40%, #2a9d41 100%)',
                          boxShadow: '0 0 24px rgba(52,199,89,0.45), 0 4px 12px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.25)',
                          border: '1px solid rgba(255,255,255,0.2)',
                        }}
                      >
                        <Phone size={32} />
                      </motion.button>
                    </>
                  ) : (
                    <motion.button
                      type="button"
                      onClick={actions.hangupCall}
                      whileTap={btnTap}
                      whileHover={{ scale: 1.08 }}
                      className="w-16 h-16 rounded-full text-white flex items-center justify-center"
                      style={{
                        WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'],
                        background: 'linear-gradient(180deg, rgba(185,28,28,0.9) 0%, rgba(153,27,27,0.95) 100%)',
                        boxShadow: '0 0 24px rgba(185,28,28,0.4), 0 4px 12px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.15)',
                        border: '1px solid rgba(255,255,255,0.15)',
                      }}
                    >
                      <PhoneOff size={28} />
                    </motion.button>
                  )}
                </div>
              </motion.div>
            ) : (
              <motion.div
                key="full"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.25 }}
                className="flex-1 flex flex-col min-h-0 p-3 gap-2.5 overflow-visible"
              >
          {/* Number input - frosted */}
          <div className="shrink-0 flex flex-col gap-1">
            <label htmlFor="phone-input" className="text-white/90 text-xs font-medium">
              Number
            </label>
            <input
              id="phone-input"
              type="tel"
              value={state.phoneNumber}
              onChange={(e) => actions.setPhoneNumber(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (state.uiState === 'ringing') actions.answerCall();
                  else actions.startCall();
                }
              }}
              placeholder="Enter number"
              className="w-full text-white rounded-lg px-3 py-2.5 text-sm placeholder-white/40 focus:outline-none focus:ring-2 focus:ring-white/40 focus:ring-offset-1 focus:ring-offset-transparent"
              style={{
                WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'],
                background: 'rgba(26, 61, 26, 0.7)',
                border: '1px solid rgba(255,255,255,0.1)',
                boxShadow: 'inset 0 2px 6px rgba(0,0,0,0.25), inset 0 -1px 0 rgba(255,255,255,0.05)',
              }}
            />
          </div>

          {/* Keypad: 3x4 grid + backspace aligned with # */}
          <div className="flex-1 min-h-0 mt-2.5 flex flex-col overflow-visible">
            <div className="flex-1 min-h-0 flex items-center justify-center overflow-visible">
              <div className="grid grid-cols-3 gap-2.5 aspect-[3/5] h-[88%] max-h-full w-auto max-w-full [grid-template-rows:repeat(5,minmax(0,1fr))]">
                {KEYPAD_KEYS.map((row) =>
                  row.map((key) => (
                    <motion.button
                      key={key}
                      type="button"
                      onClick={() => actions.handleKeypadPress(key)}
                      whileTap={keypadTapGlow}
                      whileHover={{ scale: 1.04 }}
                      transition={{ duration: 0.1 }}
                      className="aspect-square w-full max-w-full h-full max-h-full rounded-full text-white text-xl font-medium flex items-center justify-center min-w-0 min-h-0"
                      style={{
                        WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'],
                        backgroundColor: state.keypadColor,
                        boxShadow: 'inset 0 2px 6px rgba(0,0,0,0.35), inset 0 -1px 0 rgba(255,255,255,0.06), 0 1px 2px rgba(0,0,0,0.15)',
                      }}
                    >
                      {key}
                    </motion.button>
                  ))
                )}
                {/* Row 5: empty slots for col 1–2, backspace aligned with # */}
                <div />
                <div />
                <motion.button
                  type="button"
                  onClick={() => actions.handleKeypadPress('backspace')}
                  whileTap={keypadTapGlow}
                  transition={{ duration: 0.1 }}
                  whileHover={{ scale: 1.04 }}
                  className="aspect-square w-full max-w-full h-full max-h-full rounded-full text-white text-xl font-medium flex items-center justify-center min-w-0 min-h-0"
                  style={{
                    WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'],
                    backgroundColor: state.keypadColor,
                    boxShadow: 'inset 0 2px 6px rgba(0,0,0,0.35), inset 0 -1px 0 rgba(255,255,255,0.06), 0 1px 2px rgba(0,0,0,0.15)',
                  }}
                >
                  ⌫
                </motion.button>
              </div>
            </div>
          </div>

          {/* Action Bar */}
          <div
            className="shrink-0 flex items-center justify-center py-2.5 overflow-visible border-t border-white/10"
            style={{
              background: 'rgba(26, 61, 26, 0.6)',
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
            }}
          >
            {isInCall ? (
              <div className="flex items-center justify-center gap-2.5">
                <motion.button
                  type="button"
                  onClick={actions.toggleMute}
                  whileTap={btnTap}
                  whileHover={{ scale: 1.08 }}
                  className="w-12 h-12 rounded-full text-white flex items-center justify-center"
                  style={{
                    WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'],
                    background: 'linear-gradient(180deg, rgba(40,70,40,0.9) 0%, rgba(26,61,26,0.95) 100%)',
                    boxShadow: 'inset 0 2px 6px rgba(0,0,0,0.35), inset 0 -1px 0 rgba(255,255,255,0.06), 0 2px 6px rgba(0,0,0,0.2)',
                    border: '1px solid rgba(255,255,255,0.06)',
                  }}
                >
                  {state.isMuted ? <MicOff size={22} /> : <Mic size={22} />}
                </motion.button>
                <motion.button
                  type="button"
                  onClick={actions.hangupCall}
                  whileTap={btnTap}
                  whileHover={{ scale: 1.08 }}
                  className="w-16 h-16 rounded-full text-white flex items-center justify-center"
                  style={{
                    WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'],
                    background: 'linear-gradient(180deg, rgba(185,28,28,0.9) 0%, rgba(153,27,27,0.95) 100%)',
                    boxShadow: '0 0 24px rgba(185,28,28,0.4), 0 4px 12px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.15)',
                    border: '1px solid rgba(255,255,255,0.15)',
                  }}
                >
                  <PhoneOff size={28} />
                </motion.button>
                <motion.button
                  type="button"
                  onClick={actions.toggleHold}
                  whileTap={btnTap}
                  whileHover={{ scale: 1.08 }}
                  className="w-12 h-12 rounded-full text-white flex items-center justify-center"
                  style={{
                    WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'],
                    background: 'linear-gradient(180deg, rgba(40,70,40,0.9) 0%, rgba(26,61,26,0.95) 100%)',
                    boxShadow: 'inset 0 2px 6px rgba(0,0,0,0.35), inset 0 -1px 0 rgba(255,255,255,0.06), 0 2px 6px rgba(0,0,0,0.2)',
                    border: '1px solid rgba(255,255,255,0.06)',
                  }}
                >
                  {state.isOnHold ? <Play size={22} /> : <Pause size={22} />}
                </motion.button>
              </div>
            ) : isRinging && state.callDirection === 'inbound' ? (
              <div className="flex items-center justify-center gap-3">
                <motion.button
                  type="button"
                  onClick={actions.hangupCall}
                  whileTap={btnTap}
                  whileHover={{ scale: 1.08 }}
                  className="w-12 h-12 rounded-full text-white flex items-center justify-center"
                  style={{
                    WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'],
                    background: 'linear-gradient(180deg, rgba(185,28,28,0.9) 0%, rgba(153,27,27,0.95) 100%)',
                    boxShadow: '0 0 24px rgba(185,28,28,0.4), 0 4px 12px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.15)',
                    border: '1px solid rgba(255,255,255,0.15)',
                  }}
                >
                  <PhoneOff size={22} />
                </motion.button>
                <motion.button
                  type="button"
                  onClick={actions.answerCall}
                  whileTap={btnTap}
                  whileHover={{ scale: 1.06 }}
                  className="call-btn-glow w-16 h-16 rounded-full text-white flex items-center justify-center relative transition-shadow"
                  style={{
                    WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'],
                    background: 'linear-gradient(180deg, #52e878 0%, #34C759 40%, #2a9d41 100%)',
                    boxShadow: '0 0 24px rgba(52,199,89,0.45), 0 4px 12px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.25)',
                    border: '1px solid rgba(255,255,255,0.2)',
                  }}
                >
                  <Phone size={32} />
                </motion.button>
              </div>
            ) : state.uiState === 'dialing' || (isRinging && state.callDirection === 'outbound') ? (
              <motion.button
                type="button"
                onClick={actions.hangupCall}
                whileTap={btnTap}
                whileHover={{ scale: 1.08 }}
                className="w-16 h-16 rounded-full text-white flex items-center justify-center"
                style={{
                  WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'],
                  background: 'linear-gradient(180deg, rgba(185,28,28,0.9) 0%, rgba(153,27,27,0.95) 100%)',
                  boxShadow: '0 0 24px rgba(185,28,28,0.4), 0 4px 12px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.15)',
                  border: '1px solid rgba(255,255,255,0.15)',
                }}
              >
                <PhoneOff size={28} />
              </motion.button>
            ) : (
              <motion.button
                type="button"
                onClick={handleCallOrAnswer}
                whileTap={btnTap}
                whileHover={{ scale: 1.06 }}
                className="call-btn-glow w-16 h-16 rounded-full text-white flex items-center justify-center relative transition-shadow"
                style={{
                  WebkitAppRegion: 'no-drag' as React.CSSProperties['WebkitAppRegion'],
                  background: 'linear-gradient(180deg, #52e878 0%, #34C759 40%, #2a9d41 100%)',
                  boxShadow: '0 0 24px rgba(52,199,89,0.45), 0 4px 12px rgba(0,0,0,0.25), inset 0 1px 0 rgba(255,255,255,0.25)',
                  border: '1px solid rgba(255,255,255,0.2)',
                }}
              >
                <Phone size={32} />
              </motion.button>
            )}
          </div>
              </motion.div>
            )}
          </AnimatePresence>
        </main>
      </div>

      <DispositionModal
        open={state.uiState === 'ended' && !!state.leadContext?.leadId}
        contactId={state.leadContext?.leadId ?? null}
        onSave={handleDispositionSave}
        onSkip={handleDispositionSkip}
      />
    </div>
  );
}
