import type { MacCurrentWriteAuthority, MacMessageThread, WhatsAppObservation } from './macConnectorTypes';
import { transientMacAuthority } from './macConnectorService';

export interface WhatsAppMonitorConversation { jid: string; label: string }
export interface MacMonitorConfiguration { messages: boolean; whatsappConversation?: WhatsAppMonitorConversation; intervalMinutes: number }
export interface MacMonitorUrgencyHint {
  source: 'messages' | 'whatsapp'; observationId: string; threadId: string; threadTitle: string; preview: string; sentAt: string | null;
  level: 'attention'; heuristic: true; keywords: string[];
}
export interface MacMonitorSnapshot {
  observedAt: number;
  messageThreads: MacMessageThread[];
  whatsappObservations: WhatsAppObservation[];
  urgencyHints: MacMonitorUrgencyHint[];
  errors: Array<{ source: 'messages' | 'whatsapp'; message: string }>;
}
export interface MacMonitorState { running: boolean; configuration?: MacMonitorConfiguration; snapshot?: MacMonitorSnapshot; error?: string }

type NativeMonitor = NonNullable<Window['dialer']['macConnectors']>;
let state: MacMonitorState = { running: false };
let nativeUnsubscribe: (() => void) | undefined;
let currentRequest: ReturnType<typeof transientMacAuthority> | undefined;
const listeners = new Set<(value: MacMonitorState) => void>();
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function validConfiguration(value: unknown): value is MacMonitorConfiguration {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  const whatsapp = row.whatsappConversation as Record<string, unknown> | undefined;
  return typeof row.messages === 'boolean' && Number.isInteger(row.intervalMinutes) && Number(row.intervalMinutes) >= 1 && Number(row.intervalMinutes) <= 30
    && row.whatsappQuery === undefined
    && (whatsapp === undefined || Boolean(whatsapp) && typeof whatsapp.jid === 'string' && whatsapp.jid.trim().length > 0 && whatsapp.jid.length <= 256
      && typeof whatsapp.label === 'string' && whatsapp.label.trim().length > 0 && whatsapp.label.length <= 200
      && !/[\u0000-\u001f\u007f]/.test(whatsapp.jid) && !/[\u0000-\u001f\u007f]/.test(whatsapp.label))
    && (row.messages || whatsapp !== undefined);
}

function normalizeState(value: unknown): MacMonitorState {
  if (!value || typeof value !== 'object' || typeof (value as Record<string, unknown>).running !== 'boolean') throw new Error('The local monitor returned an invalid state.');
  const row = value as Record<string, any>;
  const configuration = row.configuration === undefined ? undefined : validConfiguration(row.configuration) ? clone(row.configuration) : undefined;
  if (row.running && !configuration) throw new Error('The local monitor returned an invalid configuration.');
  const raw = row.snapshot && typeof row.snapshot === 'object' ? row.snapshot : undefined;
  const snapshot: MacMonitorSnapshot | undefined = raw ? {
    observedAt: Number.isFinite(raw.observedAt) ? Number(raw.observedAt) : Date.now(),
    messageThreads: Array.isArray(raw.messageThreads) ? raw.messageThreads.slice(0, 50) : [],
    whatsappObservations: Array.isArray(raw.whatsappObservations) ? raw.whatsappObservations.slice(0, 100) : [],
    urgencyHints: Array.isArray(raw.urgencyHints) ? raw.urgencyHints.slice(0, 20) : [],
    errors: Array.isArray(raw.errors) ? raw.errors.slice(0, 2) : [],
  } : undefined;
  return { running: row.running, ...(configuration ? { configuration } : {}), ...(snapshot ? { snapshot } : {}), ...(typeof row.error === 'string' ? { error: row.error.slice(0, 500) } : {}) };
}

function emit(value: MacMonitorState) {
  state = clone(value);
  for (const listener of listeners) listener(clone(state));
}

function activate(authority: MacCurrentWriteAuthority) {
  const request = transientMacAuthority(authority);
  currentRequest = request;
  return request;
}

function native(): NativeMonitor {
  const bridge = window.dialer?.macConnectors;
  if (!bridge?.monitorState || !bridge.resumeMonitor || !bridge.startMonitor || !bridge.stopMonitor || !bridge.refreshMonitor || !bridge.onMonitorState) throw new Error('Update Crokodial Workspace to use the local monitor.');
  return bridge;
}

function ensureSubscription() {
  if (nativeUnsubscribe) return;
  nativeUnsubscribe = native().onMonitorState(() => {
    const request = currentRequest;
    if (!request) { emit({ running: false }); return; }
    void native().monitorState({ authority: request }).then(value => {
      if (currentRequest === request) emit(normalizeState(value));
    }).catch(cause => {
      if (currentRequest === request) emit({ running: false, error: cause instanceof Error ? cause.message : 'The local monitor returned invalid data.' });
    });
  });
}

export function subscribeMacMonitor(authority: MacCurrentWriteAuthority, listener: (value: MacMonitorState) => void) {
  const request = activate(authority);
  state = { running: false };
  listeners.add(listener);
  try { ensureSubscription(); } catch (cause) { emit({ running: false, error: cause instanceof Error ? cause.message : 'The local monitor is unavailable.' }); }
  listener(clone(state));
  try {
    void native().monitorState({ authority: request }).then(value => {
      if (currentRequest === request) emit(normalizeState(value));
    }).catch(cause => {
      if (currentRequest === request) emit({ running: false, error: cause instanceof Error ? cause.message : 'The local monitor is unavailable.' });
    });
  } catch (cause) { emit({ running: false, error: cause instanceof Error ? cause.message : 'The local monitor is unavailable.' }); }
  return () => { listeners.delete(listener); };
}
export function macMonitorState() { return clone(state); }
export async function startMacMonitor(configuration: MacMonitorConfiguration, authority: MacCurrentWriteAuthority) {
  if (!validConfiguration(configuration)) throw new Error('Select Messages or an exact WhatsApp conversation and an interval from 1 to 30 minutes.');
  const request = activate(authority); ensureSubscription();
  const result = normalizeState(await native().startMonitor({ configuration, authority: request }));
  if (currentRequest === request) emit(result); return clone(result);
}
export async function stopMacMonitor(authority: MacCurrentWriteAuthority, clearSaved = true) {
  const request = activate(authority); ensureSubscription(); emit({ running: false });
  try { const result = normalizeState(await native().stopMonitor({ clearSaved, authority: request })); if (currentRequest === request) emit(result); return clone(result); }
  catch (cause) { const result = { running: false, error: cause instanceof Error ? cause.message : 'The local monitor could not stop.' }; if (currentRequest === request) emit(result); throw cause; }
}
export async function refreshMacMonitor(authority: MacCurrentWriteAuthority) {
  const request = activate(authority); ensureSubscription();
  const result = normalizeState(await native().refreshMonitor({ authority: request })); if (currentRequest === request) emit(result); return clone(result);
}
/** Resumes only after the current authenticated owner/main conversation is server verified. */
export async function resumeSavedMacMonitor(authority: MacCurrentWriteAuthority) {
  let request: ReturnType<typeof transientMacAuthority> | undefined;
  try {
    request = activate(authority); ensureSubscription();
    let result = normalizeState(await native().resumeMonitor({ authority: request }));
    // Former renderer-owned settings had no owner/main-conversation binding.
    // Clear them after current server authority succeeds; never adopt them into
    // whichever account happens to sign in next.
    try {
      const key = 'crokodial.mac-read-monitor.v1';
      const hadUnboundSettings = globalThis.localStorage?.getItem(key) !== null;
      globalThis.localStorage?.removeItem(key);
      if (!result.running && hadUnboundSettings) {
        result = { running: false, error: 'Unbound saved monitor settings were cleared. Review the sources and start the local monitor again.' };
      }
    } catch {
      // Main-process owner-bound storage remains authoritative when renderer
      // storage is unavailable.
    }
    if (currentRequest === request) emit(result); return clone(result);
  }
  catch (cause) { const result = { running: false, error: cause instanceof Error ? cause.message : 'The local monitor is unavailable.' }; if (request && currentRequest === request) emit(result); return clone(result); }
}
