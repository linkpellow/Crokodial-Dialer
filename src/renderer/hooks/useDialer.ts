/**
 * useDialer - React bridge to DialerEngine.
 * Instantiates the engine, subscribes to events, fetches phone numbers, and exposes state + actions.
 *
 * @see dialerblueprint.md Section 7 (State Schema), Section 2 (Telephony Engine), Section 3 (Identity & Routing)
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import {
  DialerEngine,
  type ConnectionStatus,
  type UIState,
  type DialerEngineConfig,
  type LeadContext,
} from '@/core/DialerEngine';
import {
  fetchPhoneNumbers,
  logCallStart,
} from '@/renderer/services/dialerApiService';
import { resolveCallerNumber } from '@/renderer/utils/resolveCallerNumber';

/** Placeholder numbers for caller ID when no backend. Override via config. */
const DEFAULT_PHONE_NUMBERS = ['+15551234567', '+15559876543'];

const SETTINGS_KEY = 'crokodial-dialer-settings';

export interface DialerSettingsType {
  volume: number;
  selectedCallerNumber: string;
  keypadColor: string;
  outboundRingSound: string | null;
}

const DEFAULT_SETTINGS: DialerSettingsType = {
  volume: 80,
  selectedCallerNumber: 'auto',
  keypadColor: '#1a3d1a',
  outboundRingSound: null,
};

function loadSettings(): Partial<DialerSettingsType> {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      volume: typeof parsed.volume === 'number' ? parsed.volume : undefined,
      selectedCallerNumber: typeof parsed.selectedCallerNumber === 'string' ? parsed.selectedCallerNumber : undefined,
      keypadColor: typeof parsed.keypadColor === 'string' ? parsed.keypadColor : undefined,
      outboundRingSound: parsed.outboundRingSound === null || typeof parsed.outboundRingSound === 'string' ? parsed.outboundRingSound as string | null : undefined,
    };
  } catch {
    return {};
  }
}

function saveSettings(settings: DialerSettingsType): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // ignore storage errors
  }
}

export interface UseDialerState {
  connectionStatus: ConnectionStatus;
  connectionErrorMessage: string | null;
  uiState: UIState;
  isMuted: boolean;
  isOnHold: boolean;
  phoneNumber: string;
  selectedCallerNumber: string;
  volume: number;
  keypadColor: string;
  outboundRingSound: string | null;
  callDirection: 'inbound' | 'outbound' | null;
  availablePhoneNumbers: string[];
  userAssignments: string[];
  leadContext: LeadContext | null;
  remoteStream: MediaStream | null;
  permissionError: string | null;
}

export interface UseDialerActions {
  setPhoneNumber: (value: string) => void;
  setSelectedCallerNumber: (value: string) => void;
  setVolume: (value: number) => void;
  setOutboundRingSound: (url: string | null) => void;
  setLeadContext: (ctx: LeadContext | null) => void;
  clearPermissionError: () => void;
  resetToIdle: () => void;
  initializeTelnyxClient: (config: DialerEngineConfig) => void;
  retryConnection: () => void;
  startCall: () => void;
  /** Start call with explicit destination and leadContext (for auto-dialer). */
  startCallWithLead: (destinationNumber: string, leadContext: LeadContext) => void;
  hangupCall: () => void;
  answerCall: () => void;
  toggleMute: () => void;
  toggleHold: () => void;
  sendDTMF: (digit: string) => void;
  sendDTMFSequence: (digits: string, interDigitMs?: number) => void;
  handleKeypadPress: (key: string) => void;
}

export function useDialer(): {
  state: UseDialerState;
  actions: UseDialerActions;
  engine: DialerEngine | null;
} {
  const engineRef = useRef<DialerEngine | null>(null);
  const saved = loadSettings();
  const [state, setState] = useState<UseDialerState>({
    connectionStatus: 'disconnected',
    connectionErrorMessage: null,
    uiState: 'idle',
    isMuted: false,
    isOnHold: false,
    phoneNumber: '',
    selectedCallerNumber: saved.selectedCallerNumber ?? DEFAULT_SETTINGS.selectedCallerNumber,
    volume: saved.volume ?? DEFAULT_SETTINGS.volume,
    keypadColor: saved.keypadColor ?? DEFAULT_SETTINGS.keypadColor,
    outboundRingSound: saved.outboundRingSound ?? DEFAULT_SETTINGS.outboundRingSound,
    callDirection: null,
    availablePhoneNumbers: DEFAULT_PHONE_NUMBERS,
    userAssignments: [],
    leadContext: null,
    remoteStream: null,
    permissionError: null,
  });

  // Create engine once on mount (with onCallLog)
  useEffect(() => {
    if (!engineRef.current) {
      engineRef.current = new DialerEngine({
        onCallLog: (data) => {
          logCallStart(data);
        },
      });
    }
    const engine = engineRef.current;

    const onStatusUpdate = (payload: {
      connectionStatus: ConnectionStatus;
      uiState: UIState;
      isMuted: boolean;
      isOnHold: boolean;
      connectionErrorMessage?: string | null;
    }) => {
      setState((prev) => ({
        ...prev,
        connectionStatus: payload.connectionStatus,
        uiState: payload.uiState,
        isMuted: payload.isMuted,
        isOnHold: payload.isOnHold,
        connectionErrorMessage: payload.connectionErrorMessage !== undefined ? payload.connectionErrorMessage : prev.connectionErrorMessage,
      }));
    };

    const onConnectionError = (payload: { message: string }) => {
      setState((prev) => ({
        ...prev,
        connectionErrorMessage: payload.message,
      }));
    };

    const onCallStateChange = (payload: { uiState: UIState; currentCall?: { direction?: string } | null }) => {
      const dir = payload.currentCall?.direction === 'inbound' || payload.currentCall?.direction === 'outbound'
        ? payload.currentCall.direction
        : null;
      setState((prev) => ({
        ...prev,
        uiState: payload.uiState,
        callDirection: dir,
      }));
    };

    const onRemoteStream = (payload: { stream: MediaStream }) => {
      setState((prev) => ({
        ...prev,
        remoteStream: payload.stream,
      }));
    };

    const onPermissionError = (payload: { message: string }) => {
      setState((prev) => ({
        ...prev,
        permissionError: payload.message,
      }));
    };

    engine.on('statusUpdate', onStatusUpdate);
    engine.on('callStateChange', onCallStateChange);
    engine.on('remoteStream', onRemoteStream);
    engine.on('permissionError', onPermissionError);
    engine.on('connectionError', onConnectionError);

    return () => {
      engine.off('statusUpdate', onStatusUpdate);
      engine.off('callStateChange', onCallStateChange);
      engine.off('remoteStream', onRemoteStream);
      engine.off('permissionError', onPermissionError);
      engine.off('connectionError', onConnectionError);
      engine.disconnectTelnyxClient();
    };
  }, []);

  // Auto-initialize Telnyx when credentials are available from env
  useEffect(() => {
    const username = (import.meta.env.VITE_TELNYX_WEBRTC_USERNAME as string)?.trim();
    const password = (import.meta.env.VITE_TELNYX_WEBRTC_PASSWORD as string)?.trim();
    if (username && password && engineRef.current) {
      engineRef.current.initializeTelnyxClient({ login: username, password });
    } else if ((!username || !password) && import.meta.env.DEV) {
      console.warn(
        '[useDialer] Telnyx credentials missing (VITE_TELNYX_WEBRTC_USERNAME, VITE_TELNYX_WEBRTC_PASSWORD). Skipping auto-connect.'
      );
    }
  }, []);

  // Persist settings when volume, selectedCallerNumber, keypadColor, or outboundRingSound change
  useEffect(() => {
    saveSettings({
      volume: state.volume,
      selectedCallerNumber: state.selectedCallerNumber,
      keypadColor: state.keypadColor,
      outboundRingSound: state.outboundRingSound,
    });
  }, [state.volume, state.selectedCallerNumber, state.keypadColor, state.outboundRingSound]);

  // Fetch phone numbers and user assignments on mount
  useEffect(() => {
    const apiBase = (import.meta.env.VITE_API_BASE as string)?.trim();
    if (!apiBase) return;

    fetchPhoneNumbers().then((numbers) => {
      setState((prev) => ({
        ...prev,
        availablePhoneNumbers: numbers.length > 0 ? numbers : prev.availablePhoneNumbers,
        userAssignments: numbers,
      }));
    });
  }, []);

  const setPhoneNumber = useCallback((value: string) => {
    setState((prev) => ({ ...prev, phoneNumber: value }));
  }, []);

  const setSelectedCallerNumber = useCallback((value: string) => {
    setState((prev) => ({ ...prev, selectedCallerNumber: value }));
  }, []);

  const setVolume = useCallback((value: number) => {
    setState((prev) => ({ ...prev, volume: Math.max(0, Math.min(100, value)) }));
  }, []);

  const setOutboundRingSound = useCallback((url: string | null) => {
    setState((prev) => ({ ...prev, outboundRingSound: url }));
  }, []);

  const clearPermissionError = useCallback(() => {
    setState((prev) => ({ ...prev, permissionError: null }));
  }, []);

  const resetToIdle = useCallback(() => {
    engineRef.current?.resetToIdle?.();
    setState((prev) => ({ ...prev, permissionError: null }));
  }, []);

  const setLeadContext = useCallback((ctx: LeadContext | null) => {
    setState((prev) => ({ ...prev, leadContext: ctx }));
  }, []);

  // Keep ref to latest state for callbacks that need current values
  const stateRef = useRef(state);
  stateRef.current = state;

  const initializeTelnyxClient = useCallback((config: DialerEngineConfig) => {
    engineRef.current?.initializeTelnyxClient(config);
  }, []);

  const retryConnection = useCallback(() => {
    const username = (import.meta.env.VITE_TELNYX_WEBRTC_USERNAME as string)?.trim();
    const password = (import.meta.env.VITE_TELNYX_WEBRTC_PASSWORD as string)?.trim();
    if (username && password && engineRef.current) {
      engineRef.current.initializeTelnyxClient({ login: username, password });
    }
  }, []);

  const startCall = useCallback(() => {
    const engine = engineRef.current;
    if (!engine) return;

    const {
      phoneNumber,
      selectedCallerNumber,
      availablePhoneNumbers,
      userAssignments,
      leadContext,
    } = stateRef.current;
    const dest = phoneNumber.trim();
    if (!dest) return;

    const callerNumber = resolveCallerNumber(
      selectedCallerNumber === 'auto' ? 'auto' : selectedCallerNumber,
      selectedCallerNumber,
      availablePhoneNumbers,
      userAssignments,
      leadContext ?? undefined
    );

    if (!callerNumber) return;

    engine.startCall(dest, callerNumber, undefined, leadContext ?? undefined);
  }, []);

  const startCallWithLead = useCallback((destinationNumber: string, leadContext: LeadContext) => {
    const engine = engineRef.current;
    if (!engine) return;
    const dest = destinationNumber.trim();
    if (!dest) return;

    const {
      selectedCallerNumber,
      availablePhoneNumbers,
      userAssignments,
    } = stateRef.current;
    const callerNumber = resolveCallerNumber(
      selectedCallerNumber === 'auto' ? 'auto' : selectedCallerNumber,
      selectedCallerNumber,
      availablePhoneNumbers,
      userAssignments,
      leadContext
    );
    if (!callerNumber) return;

    setState((prev) => ({
      ...prev,
      phoneNumber: dest,
      leadContext,
    }));
    engine.startCall(dest, callerNumber, undefined, leadContext);
  }, []);

  const hangupCall = useCallback(() => {
    engineRef.current?.hangupCall();
  }, []);

  const answerCall = useCallback(() => {
    engineRef.current?.answerCall();
  }, []);

  const toggleMute = useCallback(() => {
    engineRef.current?.toggleMute();
  }, []);

  const toggleHold = useCallback(() => {
    engineRef.current?.toggleHold();
  }, []);

  const sendDTMF = useCallback((digit: string) => {
    engineRef.current?.sendDTMF(digit);
  }, []);

  const sendDTMFSequence = useCallback((digits: string, interDigitMs = 120) => {
    void engineRef.current?.sendDTMFSequence(digits, interDigitMs);
  }, []);

  const handleKeypadPress = useCallback((key: string) => {
    const engine = engineRef.current;
    const { uiState } = stateRef.current;
    const isInCall = uiState === 'in_call' || uiState === 'held';

    if (isInCall && /^[0-9*#]$/.test(key)) {
      engine?.sendDTMF(key);
    } else if (!isInCall) {
      if (key === 'backspace') {
        setState((prev) => ({
          ...prev,
          phoneNumber: prev.phoneNumber.slice(0, -1),
        }));
      } else if (/^[0-9*#]$/.test(key)) {
        setState((prev) => ({
          ...prev,
          phoneNumber: prev.phoneNumber + key,
        }));
      }
    }
  }, []);

  return {
    state,
    actions: {
      setPhoneNumber,
      setSelectedCallerNumber,
      setVolume,
      setOutboundRingSound,
      setLeadContext,
      clearPermissionError,
      resetToIdle,
      initializeTelnyxClient,
      retryConnection,
      startCall,
      startCallWithLead,
      hangupCall,
      answerCall,
      toggleMute,
      toggleHold,
      sendDTMF,
      sendDTMFSequence,
      handleKeypadPress,
    },
    engine: engineRef.current,
  };
}
