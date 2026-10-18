import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import type { MacWriteAuthority, MacWriteAuthorityRequest, MessageThread, WhatsAppObservation } from './macConnectors';

export interface WhatsAppMonitorConversation {
  /** Stable WhatsApp contact/group identifier selected from a reviewed result. */
  jid: string;
  /** Display label shown when the user selected this exact JID. */
  label: string;
}

export interface MacMonitorConfiguration {
  messages: boolean;
  whatsappConversations: WhatsAppMonitorConversation[];
  keywords: string[];
  intervalMinutes: number;
}

export interface MacMonitorUrgencyHint {
  source: 'messages' | 'whatsapp';
  observationId: string;
  threadId: string;
  threadTitle: string;
  preview: string;
  sentAt: string | null;
  level: 'attention';
  heuristic: true;
  keywords: string[];
}

export interface MacMonitorSnapshot {
  observedAt: number;
  messageThreads: MessageThread[];
  whatsappObservations: WhatsAppObservation[];
  urgencyHints: MacMonitorUrgencyHint[];
  errors: Array<{ source: 'messages' | 'whatsapp'; message: string }>;
}

export interface MacMonitorState {
  running: boolean;
  configuration?: MacMonitorConfiguration;
  snapshot?: MacMonitorSnapshot;
  error?: string;
}

interface Readers {
  listMessageThreads(query: string): Promise<{ threads: MessageThread[] }>;
  readWhatsAppConversation(jid: string): Promise<{
    conversation: { jid: string; label: string };
    observations: WhatsAppObservation[];
  }>;
}

interface Storage {
  load(): unknown;
  save(value: unknown): void;
  clear(): void;
}

export interface MacMonitorStorageCodec {
  encode(plaintext: string): string;
  decode(stored: string): string;
}

interface Clock {
  now(): number;
  schedule(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  cancel(timer: ReturnType<typeof setTimeout>): void;
}

const MAX_MESSAGES = 50;
const MAX_WHATSAPP = 100;
const MAX_WHATSAPP_CONVERSATIONS = 20;
const MAX_HINTS = 20;
const MAX_SEEN = 1_000;
const MAX_STORAGE_BYTES = 32_768;
const MAX_KEYWORDS = 20;
const MAX_KEYWORD_LENGTH = 64;
const DEFAULT_KEYWORDS = ['urgent', 'asap', 'immediately', 'emergency', 'time sensitive', 'deadline', 'overdue', 'cancel today', 'need help', 'needs help'] as const;

function cleanText(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, maximum) : '';
}

function exactText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label} is invalid.`);
  const result = value.trim();
  if (!result) throw new Error(`${label} is required.`);
  return result;
}

function normalizeKeywords(value: unknown): string[] {
  const values = value === undefined ? DEFAULT_KEYWORDS : value;
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_KEYWORDS) {
    throw new Error('Choose from 1 to 20 urgency keywords.');
  }
  const result: string[] = [], seen = new Set<string>();
  for (const value of values) {
    const keyword = exactText(value, 'Urgency keyword', MAX_KEYWORD_LENGTH).replace(/\s+/g, ' ').toLowerCase();
    if (seen.has(keyword)) throw new Error('Urgency keywords must be unique.');
    seen.add(keyword); result.push(keyword);
  }
  return result;
}

function normalizeConversation(value: unknown): WhatsAppMonitorConversation {
  if (!value || typeof value !== 'object') throw new Error('Select an exact WhatsApp conversation.');
  const row = value as Record<string, unknown>;
  return {
    jid: exactText(row.jid, 'WhatsApp conversation identifier', 256),
    label: exactText(row.label, 'WhatsApp conversation label', 200),
  };
}

function normalizeConfiguration(value: unknown): MacMonitorConfiguration {
  if (!value || typeof value !== 'object') throw new Error('Select Messages or one or more exact WhatsApp conversations and an interval from 1 to 30 minutes.');
  const input = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(input, 'whatsappQuery')) {
    throw new Error('Saved WhatsApp query monitors cannot be resumed safely. Search WhatsApp and explicitly select one conversation before monitoring.');
  }
  if (typeof input.messages !== 'boolean' || !Number.isInteger(input.intervalMinutes) || Number(input.intervalMinutes) < 1 || Number(input.intervalMinutes) > 30) {
    throw new Error('Select Messages or one or more exact WhatsApp conversations and an interval from 1 to 30 minutes.');
  }
  if (input.whatsappConversation !== undefined && input.whatsappConversations !== undefined) {
    throw new Error('Choose WhatsApp conversations using one configuration format.');
  }
  // Migrate the former single-conversation shape without weakening the stable-JID review boundary.
  const rawConversations = input.whatsappConversations !== undefined
    ? input.whatsappConversations
    : input.whatsappConversation !== undefined ? [input.whatsappConversation] : [];
  if (!Array.isArray(rawConversations) || rawConversations.length > MAX_WHATSAPP_CONVERSATIONS) {
    throw new Error('Select at most 20 exact WhatsApp conversations.');
  }
  const whatsappConversations = rawConversations.map(normalizeConversation);
  const jids = new Set<string>();
  for (const conversation of whatsappConversations) {
    if (jids.has(conversation.jid)) throw new Error('Each WhatsApp conversation can be selected only once.');
    jids.add(conversation.jid);
  }
  if (!input.messages && whatsappConversations.length === 0) throw new Error('Select Messages or one or more exact WhatsApp conversations and an interval from 1 to 30 minutes.');
  return { messages: input.messages, whatsappConversations, keywords: normalizeKeywords(input.keywords), intervalMinutes: Number(input.intervalMinutes) };
}

function matchedKeywords(text: string, configured: readonly string[]): string[] {
  const matches = new Set<string>();
  for (const keyword of configured) {
    const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    if (new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, 'i').test(text)) matches.add(keyword);
  }
  return [...matches];
}

function observationKey(source: string, id: string, sentAt: string | null, text: string): string {
  return createHash('sha256').update(JSON.stringify([source, id, sentAt, text])).digest('hex');
}

function snapshotFingerprint(snapshot: MacMonitorSnapshot): string {
  return createHash('sha256').update(JSON.stringify({
    messages: snapshot.messageThreads.map(row => [row.id, row.lastMessageAt, row.lastMessage, row.lastMessageFromMe]),
    whatsapp: snapshot.whatsappObservations.map(row => [row.threadJid, row.id, row.sentAt, row.text, row.fromMe]),
    errors: snapshot.errors,
  })).digest('hex');
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Persistent, read-only monitor owned by Electron rather than a renderer window. */
export function createMacConnectorMonitor(dependencies: { readers: Readers; storage: Storage; clock?: Clock }) {
  const clock: Clock = dependencies.clock ?? { now: () => Date.now(), schedule: (callback, delay) => setTimeout(callback, delay), cancel: timer => clearTimeout(timer) };
  const listeners = new Set<(state: MacMonitorState) => void>();
  let state: MacMonitorState = { running: false };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { revision: number; promise: Promise<MacMonitorSnapshot> } | null = null;
  let generation = 0;
  let fingerprint = '';
  let seen = new Set<string>();
  let seenOrder: string[] = [];

  const publish = (next: MacMonitorState) => {
    state = clone(next);
    for (const listener of listeners) listener(clone(state));
  };
  const remember = (key: string) => {
    if (seen.has(key)) return false;
    seen.add(key); seenOrder.push(key);
    while (seenOrder.length > MAX_SEEN) { const removed = seenOrder.shift(); if (removed) seen.delete(removed); }
    return true;
  };
  const hints = (messages: MessageThread[], whatsapp: WhatsAppObservation[], configuredKeywords: readonly string[]): MacMonitorUrgencyHint[] => {
    const result: MacMonitorUrgencyHint[] = [];
    for (const row of messages) {
      const key = observationKey('messages', row.id, row.lastMessageAt, row.lastMessage), fresh = remember(key);
      const keywords = row.lastMessageFromMe === false ? matchedKeywords(row.lastMessage, configuredKeywords) : [];
      if (fresh && keywords.length && result.length < MAX_HINTS) result.push({ source: 'messages', observationId: key, threadId: row.id, threadTitle: cleanText(row.title, 200), preview: cleanText(row.lastMessage, 240), sentAt: row.lastMessageAt, level: 'attention', heuristic: true, keywords });
    }
    for (const row of whatsapp) {
      const key = observationKey('whatsapp', `${row.threadJid}:${row.id}`, row.sentAt, row.text), fresh = remember(key);
      const keywords = !row.fromMe ? matchedKeywords(row.text, configuredKeywords) : [];
      if (fresh && keywords.length && result.length < MAX_HINTS) result.push({ source: 'whatsapp', observationId: key, threadId: row.threadJid, threadTitle: cleanText(row.threadTitle, 200), preview: cleanText(row.text, 240), sentAt: row.sentAt, level: 'attention', heuristic: true, keywords });
    }
    return result;
  };
  async function read(configuration: MacMonitorConfiguration, baselineExisting = false): Promise<MacMonitorSnapshot> {
    const [messageResult, whatsappResults] = await Promise.all([
      configuration.messages
        ? dependencies.readers.listMessageThreads('').then(result => ({ threads: result.threads, errors: [] as MacMonitorSnapshot['errors'] }))
          .catch(error => ({ threads: [], errors: [{ source: 'messages' as const, message: cleanText(error instanceof Error ? error.message : String(error), 500) }] }))
        : Promise.resolve({ threads: [], errors: [] as MacMonitorSnapshot['errors'] }),
      Promise.all(configuration.whatsappConversations.map(async target => {
        try {
          const result = await dependencies.readers.readWhatsAppConversation(target.jid);
          if (!result?.conversation || result.conversation.jid !== target.jid) throw new Error(`The selected WhatsApp conversation identity changed for ${target.label}. Select it again.`);
          const targetErrors: MacMonitorSnapshot['errors'] = [];
          const currentLabel = cleanText(result.conversation.label, 200).trim();
          if (currentLabel && currentLabel !== target.label) targetErrors.push({ source: 'whatsapp',
            message: `The selected WhatsApp conversation label changed from “${target.label}” to “${currentLabel}”. The stable JID still matches; review and reselect it if this was unexpected.` });
          const rows = Array.isArray(result.observations) ? result.observations : [];
          if (rows.some(row => row.threadJid !== target.jid)) throw new Error(`The selected WhatsApp conversation ${target.label} returned a different thread. Select it again.`);
          return { observations: rows, errors: targetErrors };
        } catch (error) {
          return { observations: [] as WhatsAppObservation[], errors: [{ source: 'whatsapp' as const,
            message: cleanText(error instanceof Error ? error.message : String(error), 500) }] };
        }
      })),
    ]);
    const errors = [...messageResult.errors, ...whatsappResults.flatMap(result => result.errors)].slice(0, MAX_WHATSAPP_CONVERSATIONS + 1);
    const messageThreads = (Array.isArray(messageResult.threads) ? messageResult.threads : []).slice(0, MAX_MESSAGES);
    // Preserve a bounded share for every explicitly selected conversation so a
    // busy first thread cannot hide fresh observations from the remaining JIDs.
    const perConversationLimit = Math.max(1, Math.floor(MAX_WHATSAPP / Math.max(1, whatsappResults.length)));
    const whatsappObservations = whatsappResults.flatMap(result => result.observations.slice(0, perConversationLimit)).slice(0, MAX_WHATSAPP);
    const urgencyHints = hints(messageThreads, whatsappObservations, configuration.keywords);
    return { observedAt: clock.now(), messageThreads, whatsappObservations,
      urgencyHints: baselineExisting ? [] : urgencyHints, errors };
  }
  function scheduleNext(): void {
    if (!state.running || timer || !state.configuration) return;
    const interval = state.configuration.intervalMinutes * 60_000;
    timer = clock.schedule(() => { timer = null; void refresh().finally(scheduleNext); }, interval);
  }
  function refresh(baselineExisting = false): Promise<MacMonitorSnapshot> {
    const revision = generation;
    if (pending?.revision === revision) return pending.promise;
    const configuration = state.configuration;
    if (!state.running || !configuration) return Promise.reject(new Error('The local monitor is not running.'));
    const promise = read(configuration, baselineExisting).then(snapshot => {
      const nextFingerprint = snapshotFingerprint(snapshot);
      if (revision === generation && state.running && (nextFingerprint !== fingerprint || snapshot.urgencyHints.length
        || Boolean(state.snapshot?.urgencyHints.length))) {
        fingerprint = nextFingerprint;
        publish({ running: true, configuration, snapshot });
      }
      return clone(snapshot);
    }).finally(() => { if (pending?.promise === promise) pending = null; });
    pending = { revision, promise };
    return promise;
  }
  async function start(value: unknown, persist = true, baselineExisting = false): Promise<MacMonitorState> {
    const configuration = normalizeConfiguration(value);
    if (timer) { clock.cancel(timer); timer = null; }
    generation++;
    fingerprint = ''; seen = new Set(); seenOrder = [];
    publish({ running: true, configuration });
    try { if (persist) dependencies.storage.save(configuration); await refresh(baselineExisting); scheduleNext(); return getState(); }
    catch (cause) {
      const error = cleanText(cause instanceof Error ? cause.message : String(cause), 500) || 'Local monitor could not start.';
      publish({ running: false, configuration, error });
      throw cause;
    }
  }
  function stop(clearSaved = true): MacMonitorState {
    if (timer) { clock.cancel(timer); timer = null; }
    generation++;
    if (clearSaved) dependencies.storage.clear();
    publish({ running: false });
    return getState();
  }
  async function resume(): Promise<MacMonitorState> {
    if (state.running) return getState();
    try {
      const saved = dependencies.storage.load();
      if (saved === undefined || saved === null) return getState();
      // Re-saving migrates a valid legacy Messages-only configuration into the
      // encrypted atomic store. Legacy free-text WhatsApp queries fail closed.
      return await start(saved, true, true);
    }
    catch (cause) {
      publish({ running: false, error: cleanText(cause instanceof Error ? cause.message : String(cause), 500) || 'Saved local monitor settings are invalid.' });
      return getState();
    }
  }
  function shutdown(): void {
    if (timer) { clock.cancel(timer); timer = null; }
    generation++;
    state = { running: false };
  }
  function getState(): MacMonitorState { return clone(state); }
  function subscribe(listener: (value: MacMonitorState) => void) { listeners.add(listener); listener(getState()); return () => listeners.delete(listener); }
  return { getState, start, stop, refresh, resume, shutdown, subscribe };
}

type MacMonitorOwnerBinding = Pick<MacWriteAuthority, 'userId' | 'tenantId' | 'environment' | 'conversationKey'>;
type StoredMonitorEnvelope = { version: 1; owner: MacMonitorOwnerBinding; configuration: MacMonitorConfiguration };

function monitorOwner(value: unknown): MacMonitorOwnerBinding {
  if (!value || typeof value !== 'object') throw new Error('The local monitor requires current server authority.');
  const row = value as Record<string, unknown>;
  if (!Number.isSafeInteger(row.userId) || Number(row.userId) <= 0 || !Number.isSafeInteger(row.tenantId) || Number(row.tenantId) <= 0
    || !['sandbox', 'production'].includes(String(row.environment)) || typeof row.conversationKey !== 'string'
    || !row.conversationKey || row.conversationKey.length > 256 || /[\u0000-\u001f\u007f]/.test(row.conversationKey)) {
    throw new Error('The local monitor received invalid server authority.');
  }
  return { userId: Number(row.userId), tenantId: Number(row.tenantId), environment: row.environment as 'sandbox' | 'production',
    conversationKey: row.conversationKey };
}

function sameMonitorOwner(left: MacMonitorOwnerBinding | undefined, right: MacMonitorOwnerBinding): boolean {
  return Boolean(left && left.userId === right.userId && left.tenantId === right.tenantId
    && left.environment === right.environment && left.conversationKey === right.conversationKey);
}

/**
 * Adds owner/main-conversation isolation around the process-level monitor.
 * The bearer is retained only in memory for periodic revalidation; the encrypted
 * store contains a non-secret server-derived owner binding and configuration.
 */
export function createAuthorizedMacConnectorMonitor(dependencies: {
  readers: Readers;
  storage: Storage;
  verify(request: MacWriteAuthorityRequest): Promise<MacWriteAuthority>;
  clock?: Clock;
}) {
  let storageOwner: MacMonitorOwnerBinding | undefined;
  let activeOwner: MacMonitorOwnerBinding | undefined;
  let activeRequest: MacWriteAuthorityRequest | undefined;
  let lifecycle: Promise<unknown> = Promise.resolve();

  const readEnvelope = (): StoredMonitorEnvelope | undefined => {
    const value = dependencies.storage.load();
    if (!value || typeof value !== 'object') return undefined;
    const row = value as Record<string, unknown>;
    if (row.version !== 1 || !row.owner || !row.configuration) return undefined; // Unbound legacy settings fail closed.
    try { return { version: 1, owner: monitorOwner(row.owner), configuration: normalizeConfiguration(row.configuration) }; }
    catch { return undefined; }
  };
  const scopedStorage: Storage = {
    load: () => {
      const envelope = readEnvelope();
      return envelope && storageOwner && sameMonitorOwner(envelope.owner, storageOwner) ? envelope.configuration : undefined;
    },
    save: value => {
      if (!storageOwner) throw new Error('The local monitor has no verified owner binding.');
      dependencies.storage.save({ version: 1, owner: storageOwner, configuration: normalizeConfiguration(value) } satisfies StoredMonitorEnvelope);
    },
    clear: () => dependencies.storage.clear(),
  };

  const assertPeriodicAuthority = async (): Promise<void> => {
    const request = activeRequest, expected = activeOwner;
    if (!request || !expected) throw new Error('The local monitor is paused until the owner signs in again.');
    const current = monitorOwner(await dependencies.verify(request));
    if (!sameMonitorOwner(expected, current) || request !== activeRequest) {
      throw new Error('The signed-in owner or permanent assistant conversation changed. The local monitor was paused.');
    }
  };
  const monitor = createMacConnectorMonitor({
    readers: {
      listMessageThreads: async query => { await assertPeriodicAuthority(); return dependencies.readers.listMessageThreads(query); },
      readWhatsAppConversation: async jid => { await assertPeriodicAuthority(); return dependencies.readers.readWhatsAppConversation(jid); },
    },
    storage: scopedStorage,
    ...(dependencies.clock ? { clock: dependencies.clock } : {}),
  });

  const serialized = <T>(work: () => Promise<T>): Promise<T> => {
    const result = lifecycle.then(work, work);
    lifecycle = result.then(() => undefined, () => undefined);
    return result;
  };
  const authorize = async (request: MacWriteAuthorityRequest): Promise<MacMonitorOwnerBinding> => monitorOwner(await dependencies.verify(request));
  const replaceScope = (owner: MacMonitorOwnerBinding, request: MacWriteAuthorityRequest): void => {
    if (activeOwner && !sameMonitorOwner(activeOwner, owner)) monitor.stop(false);
    activeOwner = owner; activeRequest = request; storageOwner = owner;
  };

  return {
    state(request: MacWriteAuthorityRequest): Promise<MacMonitorState> {
      return serialized(async () => {
        const owner = await authorize(request);
        if (!sameMonitorOwner(activeOwner, owner)) {
          if (activeOwner) monitor.stop(false);
          activeOwner = undefined; activeRequest = undefined; storageOwner = owner;
          return { running: false };
        }
        activeRequest = request; storageOwner = owner;
        return monitor.getState();
      });
    },
    resume(request: MacWriteAuthorityRequest): Promise<MacMonitorState> {
      return serialized(async () => {
        const owner = await authorize(request);
        if (sameMonitorOwner(activeOwner, owner) && monitor.getState().running) {
          activeRequest = request; storageOwner = owner; return monitor.getState();
        }
        replaceScope(owner, request);
        return monitor.resume();
      });
    },
    start(configuration: unknown, request: MacWriteAuthorityRequest): Promise<MacMonitorState> {
      return serialized(async () => {
        const owner = await authorize(request);
        replaceScope(owner, request);
        return monitor.start(configuration);
      });
    },
    refresh(request: MacWriteAuthorityRequest): Promise<MacMonitorState> {
      return serialized(async () => {
        const owner = await authorize(request);
        if (!sameMonitorOwner(activeOwner, owner) || !monitor.getState().running) throw new Error('The local monitor is not running for this owner.');
        activeRequest = request; storageOwner = owner;
        await monitor.refresh(); return monitor.getState();
      });
    },
    stop(request: MacWriteAuthorityRequest, clearSaved = true): Promise<MacMonitorState> {
      return serialized(async () => {
        const owner = await authorize(request), envelope = readEnvelope();
        if (activeOwner && !sameMonitorOwner(activeOwner, owner)) monitor.stop(false);
        else monitor.stop(false);
        activeOwner = undefined; activeRequest = undefined; storageOwner = owner;
        if (clearSaved && envelope && sameMonitorOwner(envelope.owner, owner)) dependencies.storage.clear();
        return { running: false };
      });
    },
    subscribe(listener: () => void): () => void { return monitor.subscribe(() => listener()); },
    shutdown(): void { activeRequest = undefined; activeOwner = undefined; storageOwner = undefined; monitor.shutdown(); },
  };
}

/** Atomic mode-0600 monitor storage. The main process supplies an OS-backed encryption codec. */
export function createFileMacMonitorStorage(filePath: string, codec: MacMonitorStorageCodec): Storage {
  const write = (value: unknown): void => {
    const encoded = codec.encode(JSON.stringify(value));
    if (Buffer.byteLength(encoded) > MAX_STORAGE_BYTES) throw new Error('Saved monitor settings are too large.');
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const descriptor = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(descriptor, encoded, 'utf8'); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      fs.renameSync(temporary, filePath);
      fs.chmodSync(filePath, 0o600);
      const directory = fs.openSync(path.dirname(filePath), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } finally {
      try { fs.unlinkSync(temporary); } catch (cause) { if ((cause as NodeJS.ErrnoException)?.code !== 'ENOENT') throw cause; }
    }
  };
  return {
    load() {
      try {
        const stat = fs.lstatSync(filePath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STORAGE_BYTES) throw new Error('Saved monitor settings are invalid.');
        const stored = fs.readFileSync(filePath, 'utf8');
        let parsed: unknown;
        try { parsed = JSON.parse(stored); }
        catch { return JSON.parse(codec.decode(stored)); }
        // Old versions stored the raw configuration as JSON. It is returned for
        // strict normalization: Messages-only settings migrate, query-based
        // WhatsApp settings are rejected until the user selects an exact JID.
        if (parsed && typeof parsed === 'object' && !Object.prototype.hasOwnProperty.call(parsed, 'ciphertext')) {
          write(parsed); // Seal legacy plaintext before validation or possible fail-closed display.
          return parsed;
        }
        return JSON.parse(codec.decode(stored));
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
        throw cause;
      }
    },
    save: write,
    clear() {
      try {
        fs.unlinkSync(filePath);
        const directory = fs.openSync(path.dirname(filePath), 'r');
        try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      } catch (cause) { if ((cause as NodeJS.ErrnoException)?.code !== 'ENOENT') throw cause; }
    },
  };
}
