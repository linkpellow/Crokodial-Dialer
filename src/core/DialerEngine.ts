/**
 * Headless Dialer Engine - Wraps Telnyx WebRTC and exposes a state machine + events
 * for the React UI. Manages call lifecycle, connection status, and remote stream wiring.
 *
 * @see dialerblueprint.md Section 2 (Telephony Engine), Section 7 (State Schema)
 */

import { EventEmitter } from 'events';
import { TelnyxRTC, Call, SwEvent, NOTIFICATION_TYPE } from '@telnyx/webrtc';
import { extractErrorMessage } from '@/utils/extractErrorMessage';

// --- Type Definitions ---

export type ConnectionStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'registered'
  | 'error';

export type UIState =
  | 'idle'
  | 'dialing'
  | 'ringing'
  | 'in_call'
  | 'held'
  | 'ended';

export interface LeadContext {
  leadId?: string;
  leadName?: string;
  leadPhone?: string;
  state?: string;
  zip?: string;
}

export interface CallLogData {
  destinationNumber: string;
  callerNumber: string;
  direction: 'inbound' | 'outbound';
  leadContext?: LeadContext;
}

export interface DialerEngineOptions {
  onCallLog?: (data: CallLogData) => void;
}

export interface DialerEngineConfig {
  login_token?: string;
  login?: string;
  password?: string;
  onCallLog?: (data: CallLogData) => void;
}

export interface StartCallOptions {
  destinationNumber: string;
  callerNumber: string;
  callerName?: string;
}

export interface StatusUpdatePayload {
  connectionStatus: ConnectionStatus;
  uiState: UIState;
  isMuted: boolean;
  isOnHold: boolean;
  connectionErrorMessage?: string | null;
}

export interface ConnectionErrorPayload {
  message: string;
}

export interface CallStateChangePayload {
  uiState: UIState;
  currentCall: Call | null;
}

export interface IncomingCallPayload {
  call: Call;
  callerNumber?: string;
  callerName?: string;
}

export interface RemoteStreamPayload {
  stream: MediaStream;
}

export interface PermissionErrorPayload {
  message: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isAuthFailure(msg: string): boolean {
  const lower = msg.toLowerCase();
  return lower.includes('auth') || lower.includes('401') || lower.includes('unauthorized');
}

/** Acquire local MediaStream before newCall/answer. Prevents SDK from doing its own getUserMedia which can crash in Electron. */
async function acquireLocalStream(): Promise<MediaStream> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('Microphone access is not available in this environment.');
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('No audio track in stream. Please check your microphone.');
    }
    return stream;
  } catch (err) {
    const message = err instanceof Error ? err.message : (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string' ? (err as { message: string }).message : String(err));
    throw new Error(message !== '[object Object]' ? message : 'Microphone access denied');
  }
}

/** Maps Telnyx call.state string to our UIState */
function telnyxStateToUIState(telnyxState: string): UIState {
  const s = (telnyxState || '').toLowerCase();
  if (s === 'trying' || s === 'requesting' || s === 'early') return 'dialing';
  if (s === 'ringing' || s === 'answering') return 'ringing';
  if (s === 'active') return 'in_call';
  if (s === 'held') return 'held';
  if (s === 'hangup' || s === 'destroy' || s === 'purge') return 'ended';
  return 'idle';
}

// --- DialerEngine Class ---

export class DialerEngine extends EventEmitter {
  private client: TelnyxRTC | null = null;
  private _connectionStatus: ConnectionStatus = 'disconnected';
  private _uiState: UIState = 'idle';
  private _currentCall: Call | null = null;
  private _isMuted = false;
  private _isOnHold = false;
  private _onCallLog: ((data: CallLogData) => void) | null = null;
  private _pendingCallLeadContext: LeadContext | null = null;
  private _currentLocalStream: MediaStream | null = null;
  private _lastConfig: DialerEngineConfig | null = null;
  private _reconnectAttempts = 0;
  private _reconnectBlocked = false;
  private _connectionErrorMessage: string | null = null;

  constructor(options?: DialerEngineOptions) {
    super();
    this._onCallLog = options?.onCallLog ?? null;
  }

  private handleNotification = (notification: { type: string; call?: Call }) => {
    if (notification.type !== NOTIFICATION_TYPE.callUpdate || !notification.call) {
      return;
    }

    const call = notification.call;

    // Inbound ringing - store as current call and emit incomingCall
    if (
      call.direction === 'inbound' &&
      (call.state === 'ringing' || call.state === 'Ringing')
    ) {
      this._currentCall = call;
      this.setUIState('ringing');
      this.emit('incomingCall', {
        call,
        callerNumber: call.options?.remoteCallerNumber,
        callerName: call.options?.remoteCallerName,
      } as IncomingCallPayload);
      this.emit('callStateChange', {
        uiState: this._uiState,
        currentCall: this._currentCall,
      } as CallStateChangePayload);
      this.emitStatusUpdate();

      // Desktop notification and focus window
      this.showIncomingCallNotification(
        call.options?.remoteCallerName ?? call.options?.remoteCallerNumber ?? 'Unknown'
      );
      return;
    }

    // Outbound or active - handle state transitions for our current call
    if (this._currentCall?.id === call.id || !this._currentCall) {
      this._currentCall = call;
      const nextUIState = telnyxStateToUIState(call.state);
      this.setUIState(nextUIState);

      // Remote stream available when active
      if (nextUIState === 'in_call' && call.remoteStream) {
        this.emit('remoteStream', { stream: call.remoteStream } as RemoteStreamPayload);
      }

      // Call log when transitioning to active
      if (nextUIState === 'in_call' && this._onCallLog) {
        const direction = call.direction === 'inbound' ? 'inbound' : 'outbound';
        const destinationNumber =
          direction === 'inbound'
            ? (call.options?.callerNumber ?? '') // Our number they reached (if available)
            : (call.options?.destinationNumber ?? '');
        const callerNumber =
          direction === 'inbound'
            ? (call.options?.remoteCallerNumber ?? '')
            : (call.options?.callerNumber ?? '');
        this._onCallLog({
          destinationNumber,
          callerNumber,
          direction,
          leadContext: this._pendingCallLeadContext ?? undefined,
        });
        this._pendingCallLeadContext = null;
      }

      // Sync mute/hold from call
      this._isMuted = call.isAudioMuted ?? this._isMuted;
      if (nextUIState === 'held') this._isOnHold = true;
      if (nextUIState === 'in_call') this._isOnHold = false;

      this.emit('callStateChange', {
        uiState: this._uiState,
        currentCall: this._currentCall,
      } as CallStateChangePayload);

      // Clear currentCall and stop local stream when ended
      if (nextUIState === 'ended') {
        if (this._currentLocalStream) {
          this._currentLocalStream.getTracks().forEach((t) => t.stop());
          this._currentLocalStream = null;
        }
        this._currentCall = null;
        this._isMuted = false;
        this._isOnHold = false;
      }

      this.emitStatusUpdate();
    }
  };

  get connectionStatus(): ConnectionStatus {
    return this._connectionStatus;
  }

  get uiState(): UIState {
    return this._uiState;
  }

  get currentCall(): Call | null {
    return this._currentCall;
  }

  get isMuted(): boolean {
    return this._isMuted;
  }

  get isOnHold(): boolean {
    return this._isOnHold;
  }

  private setUIState(state: UIState): void {
    if (this._uiState !== state) {
      this._uiState = state;
    }
  }

  private setConnectionStatus(status: ConnectionStatus): void {
    if (this._connectionStatus !== status) {
      this._connectionStatus = status;
      this.emitStatusUpdate();
    }
  }

  private showIncomingCallNotification(callerLabel: string): void {
    if (typeof window === 'undefined') return;
    if ('Notification' in window && Notification.permission === 'granted') {
      const n = new Notification('Incoming Call', { body: callerLabel });
      n.onclick = () => {
        window.dialer?.showWindow?.();
      };
    } else if ('Notification' in window && Notification.permission !== 'denied') {
      Notification.requestPermission().then((p) => {
        if (p === 'granted') {
          const n = new Notification('Incoming Call', { body: callerLabel });
          n.onclick = () => {
            window.dialer?.showWindow?.();
          };
        }
      });
    }
    window.dialer?.showWindow?.();
  }

  private emitStatusUpdate(): void {
    this.emit('statusUpdate', {
      connectionStatus: this._connectionStatus,
      uiState: this._uiState,
      isMuted: this._isMuted,
      isOnHold: this._isOnHold,
      connectionErrorMessage: this._connectionErrorMessage,
    } as StatusUpdatePayload);
  }

  /**
   * Initialize Telnyx WebRTC client. Supports login_token or login+password.
   * @param fromReconnect - When true, called from scheduled reconnect; do not reset attempt counter.
   */
  initializeTelnyxClient(config: DialerEngineConfig, fromReconnect = false): void {
    if (!fromReconnect) {
      this._reconnectAttempts = 0;
      this._reconnectBlocked = false;
      this._connectionErrorMessage = null;
    }

    if (this.client) {
      this.disconnectTelnyxClient();
    }

    if (config.onCallLog) {
      this._onCallLog = config.onCallLog;
    }

    this._lastConfig = config;

    type TelnyxClientConfig = {
      login_token?: string;
      login?: string;
      password?: string;
      iceServers?: RTCIceServer[];
    };
    const clientConfig: TelnyxClientConfig = {};
    if (config.login_token) {
      clientConfig.login_token = config.login_token;
    } else if (config.login && config.password) {
      clientConfig.login = config.login;
      clientConfig.password = config.password;
      clientConfig.iceServers = [
        { urls: 'stun:stun.telnyx.com:3478' },
        { urls: 'stun:stun.l.google.com:19302' },
        {
          urls: 'turn:turn.telnyx.com:3478?transport=tcp',
          username: config.login,
          credential: config.password,
        },
      ];
    } else {
      this.setConnectionStatus('error');
      this.emit('statusUpdate', {
        connectionStatus: 'error',
        uiState: this._uiState,
        isMuted: this._isMuted,
        isOnHold: this._isOnHold,
      } as StatusUpdatePayload);
      return;
    }

    this.client = new TelnyxRTC(clientConfig);
    this.setConnectionStatus('connecting');

    this.client.on(SwEvent.Ready, () => {
      this._reconnectAttempts = 0;
      this._reconnectBlocked = false;
      this._connectionErrorMessage = null;
      this.setConnectionStatus('registered');
    });

    this.client.on(SwEvent.Error, (payload?: unknown) => {
      const msg = extractErrorMessage(payload, 'Connection error');
      this._connectionErrorMessage = msg;
      this.setConnectionStatus('error');
      this.emit('connectionError', { message: msg } as ConnectionErrorPayload);
    });

    this.client.on(SwEvent.SocketOpen, () => {
      if (this._connectionStatus === 'connecting') {
        this.setConnectionStatus('connected');
      }
    });

    this.client.on(SwEvent.Notification, this.handleNotification);

    this.client.on(SwEvent.SocketClose, () => {
      if (this._currentCall) {
        this.cleanupCall();
      } else {
        if (this._currentLocalStream) {
          this._currentLocalStream.getTracks().forEach((t) => t.stop());
          this._currentLocalStream = null;
        }
        this.setUIState('idle');
        this.emitStatusUpdate();
      }
      this.client = null;
      this.setConnectionStatus('disconnected');

      if (this._lastConfig && !this._reconnectBlocked) {
        this._reconnectAttempts++;
        if (this._reconnectAttempts >= 3) {
          this._connectionErrorMessage = 'Connection failed after multiple attempts';
          this._lastConfig = null;
          this._reconnectBlocked = true;
          this.emit('connectionError', { message: this._connectionErrorMessage } as ConnectionErrorPayload);
          this.emitStatusUpdate();
        } else {
          setTimeout(() => {
            if (this._lastConfig && !this._reconnectBlocked) {
              this.initializeTelnyxClient(this._lastConfig, true);
            }
          }, 5000);
        }
      }
    });

    this.client.on(SwEvent.SocketError, (payload?: { error?: unknown }) => {
      const errorMessage = extractErrorMessage(payload?.error, 'Telnyx connection error');
      console.error('[Telnyx] Socket Error:', errorMessage);

      if (this._currentCall) {
        this.cleanupCall();
      } else {
        if (this._currentLocalStream) {
          this._currentLocalStream.getTracks().forEach((t) => t.stop());
          this._currentLocalStream = null;
        }
        this.setUIState('idle');
        this.setConnectionStatus('error');
        this.emitStatusUpdate();
      }
      this.client = null;

      if (isAuthFailure(errorMessage)) {
        this._lastConfig = null;
        this._reconnectBlocked = true;
        this._connectionErrorMessage = errorMessage;
        console.warn('[Telnyx] Auth failure detected. Stopping auto-reconnect.');
        this.emit('connectionError', { message: errorMessage } as ConnectionErrorPayload);
        this.emitStatusUpdate();
      } else if (this._lastConfig && !this._reconnectBlocked) {
        this._reconnectAttempts++;
        if (this._reconnectAttempts >= 3) {
          this._connectionErrorMessage = errorMessage || 'Connection failed after multiple attempts';
          this._lastConfig = null;
          this._reconnectBlocked = true;
          this.emit('connectionError', { message: this._connectionErrorMessage } as ConnectionErrorPayload);
          this.emitStatusUpdate();
        } else {
          setTimeout(() => {
            if (this._lastConfig && !this._reconnectBlocked) {
              this.initializeTelnyxClient(this._lastConfig, true);
            }
          }, 5000);
        }
      }
    });

    this.client.connect();
  }

  /**
   * Start an outbound call.
   */
  async startCall(
    destinationNumber: string,
    callerNumber: string,
    callerName?: string,
    leadContext?: LeadContext
  ): Promise<void> {
    if (!this.client) {
      throw new Error('Telnyx client not initialized. Call initializeTelnyxClient first.');
    }

    this.setUIState('dialing');
    this.emit('callStateChange', {
      uiState: this._uiState,
      currentCall: this._currentCall,
    } as CallStateChangePayload);
    this.emitStatusUpdate();

    this._pendingCallLeadContext = leadContext ?? null;

    let localStream: MediaStream;
    try {
      localStream = await acquireLocalStream();
      this._currentLocalStream = localStream;
    } catch (err) {
      const message = err instanceof Error ? err.message : (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string' ? (err as { message: string }).message : String(err));
      this.emit('permissionError', { message: typeof message === 'string' && message !== '[object Object]' ? message : 'Permission denied' } as PermissionErrorPayload);
      this.setUIState('idle');
      this.emit('callStateChange', {
        uiState: this._uiState,
        currentCall: null,
      } as CallStateChangePayload);
      this.emitStatusUpdate();
      return;
    }

    const call = this.client.newCall({
      destinationNumber,
      callerNumber,
      callerName,
      localStream,
      audio: true,
      video: false,
    });

    this._currentCall = call;
  }

  /**
   * Internal: stop local stream and remote audio; clear call reference. Does not touch client.
   * Sets uiState to 'ended' only when a call existed (for disposition modal); otherwise 'idle'.
   */
  private cleanupCall(): void {
    const hadCall = !!this._currentCall;
    if (this._currentLocalStream) {
      this._currentLocalStream.getTracks().forEach((t) => t.stop());
      this._currentLocalStream = null;
    }
    if (this._currentCall) {
      this._currentCall = null;
    }
    this._isMuted = false;
    this._isOnHold = false;
    this.setUIState(hadCall ? 'ended' : 'idle');
    this.emit('callStateChange', {
      uiState: this._uiState,
      currentCall: null,
    } as CallStateChangePayload);
    this.emitStatusUpdate();
  }

  /**
   * Teardown: stop all media tracks and clear call state. Call on component unmount to prevent memory leaks.
   */
  teardown(): void {
    this.cleanupCall();
  }

  /**
   * End the current call.
   */
  hangupCall(): void {
    if (this._currentCall) {
      this._currentCall.hangup();
    }
    this.cleanupCall();
  }

  /**
   * Answer an incoming ringing call.
   */
  async answerCall(): Promise<void> {
    if (!this._currentCall) return;
    const state = (this._currentCall.state || '').toLowerCase();
    if (state !== 'ringing' && state !== 'answering') return;

    try {
      const stream = await acquireLocalStream();
      this._currentLocalStream = stream;
    } catch (micError) {
      const message = micError instanceof Error ? micError.message : (micError && typeof micError === 'object' && 'message' in micError && typeof (micError as { message: unknown }).message === 'string' ? (micError as { message: string }).message : String(micError));
      this.emit('permissionError', { message: typeof message === 'string' && message !== '[object Object]' ? message : 'Permission denied' } as PermissionErrorPayload);
      return;
    }

    await this._currentCall.answer();
  }

  /**
   * Toggle mute on the current call.
   */
  toggleMute(): void {
    if (!this._currentCall) return;
    this._currentCall.toggleAudioMute();
    this._isMuted = this._currentCall.isAudioMuted;
    this.emitStatusUpdate();
  }

  /**
   * Send DTMF digit (0-9, *, #).
   */
  sendDTMF(digit: string): void {
    if (!this._currentCall) return;
    const d = String(digit).trim();
    if (/^[0-9*#]$/.test(d)) {
      this._currentCall.dtmf(d);
    }
  }

  /**
   * Send DTMF sequence with inter-digit delay for IVR stability.
   */
  async sendDTMFSequence(digits: string, interDigitMs = 120): Promise<void> {
    if (!this._currentCall) return;
    const valid = String(digits).replace(/[^0-9*#]/g, '');
    for (let i = 0; i < valid.length; i++) {
      this._currentCall.dtmf(valid[i]);
      if (i < valid.length - 1) {
        await delay(interDigitMs);
      }
    }
  }

  /**
   * Toggle hold on the current call.
   */
  toggleHold(): void {
    if (!this._currentCall) return;
    this._currentCall.toggleHold();
    this._isOnHold = !this._isOnHold;
    this.emitStatusUpdate();
  }

  /**
   * Get the remote MediaStream for the current call (for attaching to an audio element).
   */
  getRemoteStream(): MediaStream | null {
    if (!this._currentCall) return null;
    try {
      return this._currentCall.remoteStream ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Reset UI state from ended back to idle (e.g. after disposition saved/skipped).
   */
  resetToIdle(): void {
    this._uiState = 'idle';
    this.emit('callStateChange', {
      uiState: this._uiState,
      currentCall: this._currentCall,
    } as CallStateChangePayload);
    this.emitStatusUpdate();
  }

  /**
   * Disconnect the Telnyx client and reset state.
   * Clears _lastConfig before disconnecting so SocketClose handler does not schedule reconnect.
   */
  disconnectTelnyxClient(): void {
    this._lastConfig = null;
    this._reconnectBlocked = false;
    this._connectionErrorMessage = null;
    if (this.client) {
      try {
        this.client.off?.(SwEvent.Notification, this.handleNotification);
      } catch {
        // Fallback if off not available
      }
      this.client.disconnect();
      this.client = null;
    }
    if (this._currentLocalStream) {
      this._currentLocalStream.getTracks().forEach((t) => t.stop());
      this._currentLocalStream = null;
    }
    this._currentCall = null;
    this._isMuted = false;
    this._isOnHold = false;
    this.setUIState('idle');
    this.setConnectionStatus('disconnected');
    this.emitStatusUpdate();
  }
}
