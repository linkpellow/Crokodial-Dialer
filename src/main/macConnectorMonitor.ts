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
  whatsappConversation?: WhatsAppMonitorConversation;
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
const MAX_HINTS = 20;
const MAX_SEEN = 1_000;
const MAX_STORAGE_BYTES = 4_096;
const KEYWORDS = ['urgent', 'asap', 'immediately', 'emergency', 'time sensitive', 'deadline', 'overdue', 'cancel today', 'need help', 'needs help'] as const;
const keywordPattern = new RegExp(`(?:^|[^a-z0-9])(${KEYWORDS.map(value => value.replace(/\s+/g, '\\s+')).join('|')})(?=$|[^a-z0-9])`, 'gi');

function cleanText(value: unknown, maximum: number): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, maximum) : '';
}

function exactText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw new Error(`${label} is invalid.`);
  const result = value.trim();
  if (!result) throw new Error(`${label} is required.`);
  return result;
}

function normalizeConfiguration(value: unknown): MacMonitorConfiguration {
  if (!value || typeof value !== 'object') throw new Error('Select Messages or an exact WhatsApp conversation and an interval from 1 to 30 minutes.');
  const input = value as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(input, 'whatsappQuery')) {
    throw new Error('Saved WhatsApp query monitors cannot be resumed safely. Search WhatsApp and explicitly select one conversation before monitoring.');
  }
  if (typeof input.messages !== 'boolean' || !Number.isInteger(input.intervalMinutes) || Number(input.intervalMinutes) < 1 || Number(input.intervalMinutes) > 30) {
    throw new Error('Select Messages or an exact WhatsApp conversation and an interval from 1 to 30 minutes.');
  }
  let whatsappConversation: WhatsAppMonitorConversation | undefined;
  if (input.whatsappConversation !== undefined) {
    if (!input.whatsappConversation || typeof input.whatsappConversation !== 'object') throw new Error('Select an exact WhatsApp conversation.');
    const row = input.whatsappConversation as Record<string, unknown>;
    whatsappConversation = {
      jid: exactText(row.jid, 'WhatsApp conversation identifier', 256),
      label: exactText(row.label, 'WhatsApp conversation label', 200),
    };
  }
  if (!input.messages && !whatsappConversation) throw new Error('Select Messages or an exact WhatsApp conversation and an interval from 1 to 30 minutes.');
  return { messages: input.messages, ...(whatsappConversation ? { whatsappConversation } : {}), intervalMinutes: Number(input.intervalMinutes) };
}

function matchedKeywords(text: string): string[] {
  const matches = new Set<string>();
  keywordPattern.lastIndex = 0;
  for (let match = keywordPattern.exec(text); match && matches.size < 8; match = keywordPattern.exec(text)) matches.add(match[1].toLowerCase().replace(/\s+/g, ' '));
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
  const hints = (messages: MessageThread[], whatsapp: WhatsAppObservation[]): MacMonitorUrgencyHint[] => {
    const result: MacMonitorUrgencyHint[] = [];
    for (const row of messages) {
      const key = observationKey('messages', row.id, row.lastMessageAt, row.lastMessage), fresh = remember(key);
      const keywords = row.lastMessageFromMe === false ? matchedKeywords(row.lastMessage) : [];
      if (fresh && keywords.length && result.length < MAX_HINTS) result.push({ source: 'messages', observationId: key, threadId: row.id, threadTitle: cleanText(row.title, 200), preview: cleanText(row.lastMessage, 240), sentAt: row.lastMessageAt, level: 'attention', heuristic: true, keywords });
    }
    for (const row of whatsapp) {
      const key = observationKey('whatsapp', `${row.threadJid}:${row.id}`, row.sentAt, row.text), fresh = remember(key);
      const keywords = !row.fromMe ? matchedKeywords(row.text) : [];
      if (fresh && keywords.length && result.length < MAX_HINTS) result.push({ source: 'whatsapp', observationId: key, threadId: row.threadJid, threadTitle: cleanText(row.threadTitle, 200), preview: cleanText(row.text, 240), sentAt: row.sentAt, level: 'attention', heuristic: true, keywords });
    }
    return result;
  };
  async function read(configuration: MacMonitorConfiguration, baselineExisting = false): Promise<MacMonitorSnapshot> {
    const errors: MacMonitorSnapshot['errors'] = [];
    const [messageResult, whatsappResult] = await Promise.all([
      configuration.messages ? dependencies.readers.listMessageThreads('').catch(error => { errors.push({ source: 'messages', message: cleanText(error instanceof Error ? error.message : String(error), 500) }); return { threads: [] }; }) : Promise.resolve({ threads: [] }),
      configuration.whatsappConversation ? dependencies.readers.readWhatsAppConversation(configuration.whatsappConversation.jid).then(result => {
        if (!result?.conversation || result.conversation.jid !== configuration.whatsappConversation?.jid) throw new Error('The selected WhatsApp conversation identity changed. Select it again.');
        const currentLabel = cleanText(result.conversation.label, 200).trim();
        if (currentLabel && currentLabel !== configuration.whatsappConversation.label) errors.push({ source: 'whatsapp',
          message: `The selected WhatsApp conversation label changed from “${configuration.whatsappConversation.label}” to “${currentLabel}”. The stable JID still matches; review and reselect it if this was unexpected.` });
        const rows = Array.isArray(result.observations) ? result.observations : [];
        if (rows.some(row => row.threadJid !== configuration.whatsappConversation?.jid)) throw new Error('The selected WhatsApp conversation returned a different thread. Select it again.');
        return { observations: rows };
      }).catch(error => { errors.push({ source: 'whatsapp', message: cleanText(error instanceof Error ? error.message : String(error), 500) }); return { observations: [] }; }) : Promise.resolve({ observations: [] }),
    ]);
    const messageThreads = (Array.isArray(messageResult.threads) ? messageResult.threads : []).slice(0, MAX_MESSAGES);
    const whatsappObservations = (Array.isArray(whatsappResult.observations) ? whatsappResult.observations : []).slice(0, MAX_WHATSAPP);
    const urgencyHints = hints(messageThreads, whatsappObservations);
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
