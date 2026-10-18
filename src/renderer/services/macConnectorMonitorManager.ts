import type { MacCurrentWriteAuthority, MacMessageThread, WhatsAppObservation } from './macConnectorTypes';
import { transientMacAuthority } from './macConnectorService';

export interface WhatsAppMonitorConversation { jid: string; label: string }
export const DEFAULT_MAC_MONITOR_KEYWORDS = ['urgent', 'asap', 'immediately', 'emergency', 'time sensitive', 'deadline', 'overdue', 'cancel today', 'need help', 'needs help'] as const;
export const MAX_MAC_MONITOR_KEYWORDS = 20;
export const MAX_MAC_MONITOR_WHATSAPP_CONVERSATIONS = 20;
export interface MacMonitorConfiguration {
  messages: boolean;
  whatsappConversations: WhatsAppMonitorConversation[];
  keywords: string[];
  intervalMinutes: number;
}
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

function validText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}

function normalizeConfiguration(value: unknown): MacMonitorConfiguration | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.messages !== 'boolean' || !Number.isInteger(row.intervalMinutes) || Number(row.intervalMinutes) < 1
    || Number(row.intervalMinutes) > 30 || row.whatsappQuery !== undefined
    || row.whatsappConversation !== undefined && row.whatsappConversations !== undefined) return undefined;
  const rawConversations = row.whatsappConversations !== undefined ? row.whatsappConversations
    : row.whatsappConversation !== undefined ? [row.whatsappConversation] : [];
  if (!Array.isArray(rawConversations) || rawConversations.length > MAX_MAC_MONITOR_WHATSAPP_CONVERSATIONS) return undefined;
  const whatsappConversations: WhatsAppMonitorConversation[] = [];
  const jids = new Set<string>();
  for (const value of rawConversations) {
    if (!value || typeof value !== 'object') return undefined;
    const conversation = value as Record<string, unknown>;
    if (!validText(conversation.jid, 256) || !validText(conversation.label, 200)) return undefined;
    const jid = conversation.jid.trim(), label = conversation.label.trim();
    if (jids.has(jid)) return undefined;
    jids.add(jid); whatsappConversations.push({ jid, label });
  }
  const rawKeywords = row.keywords === undefined ? DEFAULT_MAC_MONITOR_KEYWORDS : row.keywords;
  if (!Array.isArray(rawKeywords) || rawKeywords.length < 1 || rawKeywords.length > MAX_MAC_MONITOR_KEYWORDS) return undefined;
  const keywords: string[] = [], seenKeywords = new Set<string>();
  for (const value of rawKeywords) {
    if (!validText(value, 64)) return undefined;
    const keyword = value.trim().replace(/\s+/g, ' ').toLowerCase();
    if (seenKeywords.has(keyword)) return undefined;
    seenKeywords.add(keyword); keywords.push(keyword);
  }
  if (!row.messages && whatsappConversations.length === 0) return undefined;
  return { messages: row.messages, whatsappConversations, keywords, intervalMinutes: Number(row.intervalMinutes) };
}

function normalizeState(value: unknown): MacMonitorState {
  if (!value || typeof value !== 'object' || typeof (value as Record<string, unknown>).running !== 'boolean') throw new Error('The local monitor returned an invalid state.');
  const row = value as Record<string, any>;
  const configuration = row.configuration === undefined ? undefined : normalizeConfiguration(row.configuration);
  if (row.running && !configuration) throw new Error('The local monitor returned an invalid configuration.');
  const raw = row.snapshot && typeof row.snapshot === 'object' ? row.snapshot : undefined;
  const snapshot: MacMonitorSnapshot | undefined = raw ? {
    observedAt: Number.isFinite(raw.observedAt) ? Number(raw.observedAt) : Date.now(),
    messageThreads: Array.isArray(raw.messageThreads) ? raw.messageThreads.slice(0, 50) : [],
    whatsappObservations: Array.isArray(raw.whatsappObservations) ? raw.whatsappObservations.slice(0, 100) : [],
    urgencyHints: Array.isArray(raw.urgencyHints) ? raw.urgencyHints.slice(0, 20) : [],
    errors: Array.isArray(raw.errors) ? raw.errors.slice(0, MAX_MAC_MONITOR_WHATSAPP_CONVERSATIONS + 1) : [],
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
  const normalized = normalizeConfiguration(configuration);
  if (!normalized) throw new Error('Select Messages or one or more exact WhatsApp conversations, 1 to 20 unique urgency keywords, and an interval from 1 to 30 minutes.');
  const request = activate(authority); ensureSubscription();
  const result = normalizeState(await native().startMonitor({ configuration: normalized, authority: request }));
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
