import { createHash, randomUUID } from 'crypto';
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

export type ConnectorState = 'available' | 'permission_required' | 'denied' | 'unavailable' | 'unsupported' | 'unknown';

export interface ContactRecord {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  organization: string;
  emails: string[];
  phones: string[];
}

export interface MessageThread {
  id: string;
  title: string;
  participants: string[];
  service: string;
  lastMessage: string;
  lastMessageAt: string | null;
  /** null means the local database did not expose message direction. */
  lastMessageFromMe: boolean | null;
}

export interface ThreadMessage {
  id: string;
  text: string;
  sender: string;
  fromMe: boolean;
  sentAt: string | null;
}

export interface WhatsAppObservation {
  id: string;
  threadId: string;
  /** Stable WhatsApp conversation identifier (for example, a contact or group JID). */
  threadJid: string;
  threadTitle: string;
  sender: string;
  text: string;
  fromMe: boolean;
  sentAt: string | null;
}

export interface ContactCreateInput {
  operation: 'create';
  contact: { firstName: string; lastName: string; organization?: string; emails?: string[]; phones?: string[] };
}

export interface ContactUpdateInput {
  operation: 'update';
  contactId: string;
  changes: { firstName?: string; lastName?: string; organization?: string; addEmails?: string[]; addPhones?: string[] };
}

export type ContactMutationInput = ContactCreateInput | ContactUpdateInput;

interface ContactAdapter {
  requestAccess(): Promise<void>;
  search(query: string): Promise<ContactRecord[]>;
  listAll(): Promise<ContactRecord[]>;
  create(contact: ContactCreateInput['contact']): Promise<ContactRecord>;
  update(contactId: string, changes: ContactUpdateInput['changes']): Promise<ContactRecord>;
}

interface MessagesAdapter {
  historyStatus(): Promise<ConnectorState>;
  requestAutomationAccess(): Promise<void>;
  listThreads(query: string): Promise<MessageThread[]>;
  readThread(threadId: string): Promise<{ thread: MessageThread; messages: ThreadMessage[] }>;
  sendExistingThread(threadId: string, text: string): Promise<void>;
}

interface WhatsAppAdapter {
  status(): Promise<ConnectorState>;
  search(query: string): Promise<WhatsAppObservation[]>;
  readConversation(jid: string): Promise<{ conversation: { jid: string; label: string }; observations: WhatsAppObservation[] }>;
}

export interface MacWriteAuthority {
  version: 1;
  userId: number;
  tenantId: number;
  environment: 'sandbox' | 'production';
  conversationKey: string;
  lineage: string;
}

export interface MacWriteAuthorityRequest { bearerToken: string; agentId: number; sessionId: string }

export interface MacNativeWriteClaim {
  reviewId: string;
  claimToken: string;
  requestId: string;
  turnId: string;
  turnDigest: string;
  kind: 'contact.create' | 'contact.update' | 'messages.send';
  revision: number;
  payloadDigest: string;
  reviewDigest: string;
}

export type MacNativeWriteServerReceipt = {
  reviewId: string;
  state: 'executing' | 'succeeded' | 'failed' | 'unknown' | 'reconciled';
  resolution?: 'applied' | 'not_applied';
  message?: string;
};

export class MacConnectorAuthorityError extends Error {
  constructor(message: string, readonly definitive = false) { super(message); this.name = 'MacConnectorAuthorityError'; }
}

export interface MacConnectorDependencies {
  platform: string;
  contacts: ContactAdapter;
  messages: MessagesAdapter;
  whatsapp: WhatsAppAdapter;
  authority: {
    verify(request: MacWriteAuthorityRequest): Promise<MacWriteAuthority>;
    claim(request: MacWriteAuthorityRequest, claim: MacNativeWriteClaim): Promise<MacNativeWriteServerReceipt>;
    assert(request: MacWriteAuthorityRequest, reviewId: string, claimToken: string): Promise<MacNativeWriteServerReceipt>;
    finalize(request: MacWriteAuthorityRequest, reviewId: string, claimToken: string,
      state: 'succeeded' | 'failed' | 'unknown', message: string): Promise<MacNativeWriteServerReceipt>;
    reconcile(request: MacWriteAuthorityRequest, claim: MacNativeWriteClaim,
      resolution: 'applied' | 'not_applied'): Promise<MacNativeWriteServerReceipt>;
  };
  openExternal(url: string): Promise<void>;
  now(): number;
  randomId(): string;
}

type ReviewKind = 'contact.create' | 'contact.update' | 'messages.send' | 'sms.compose';
type DurableReviewKind = Exclude<ReviewKind, 'sms.compose'>;
export interface MacWriteContext {
  tenantId: number;
  userId: number;
  /** Absent only on receipts written before the permanent-conversation binding existed. */
  conversationKey?: string;
  environment?: 'sandbox' | 'production';
  /** Opaque server-derived authorization lineage; never contains a bearer token. */
  lineage?: string;
  /** Audit metadata. Agent replacement never changes write authority. */
  agentId: number;
  turnId: string;
  requestId?: string;
  turnDigest: string;
  revision: number;
}

type DurableWriteState = 'pending' | 'executing' | 'succeeded' | 'submitted' | 'rejected' | 'expired' | 'unknown' | 'reconciled';

interface StoredReview {
  id: string;
  kind: ReviewKind;
  digest: string;
  createdAt: number;
  expiresAt: number;
  payload: unknown;
}

interface DurableStoredReview extends StoredReview {
  kind: DurableReviewKind;
  profileId: string;
  context: MacWriteContext;
  payloadDigest: string;
  state: DurableWriteState;
  updatedAt: number;
  receipt?: Record<string, unknown>;
  /** Opaque server claim secret. It exists only inside the OS-encrypted ledger. */
  serverClaim?: { claimToken: string };
  reconciliation?: { resolution: 'applied' | 'not_applied'; reconciledAt: number };
}

interface DurableLedger {
  version: 1;
  profileId: string;
  records: DurableStoredReview[];
}

export interface MacConnectorWriteStorage {
  load(): unknown;
  save(ledger: DurableLedger): void;
  loadArchive?(key: string): unknown;
  saveArchive?(key: string, archive: DurableLedger): void;
}

export interface MacConnectorStorageCodec {
  encode(plaintext: string): string;
  decode(stored: string): string;
}

const REVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_CONTACTS = 5_000;
const MAX_REVIEWS = 100;
const MAX_DURABLE_REVIEWS = 1_000;
const ARCHIVE_ROTATION_BATCH = 250;
const MAX_DURABLE_FILE_BYTES = 16 * 1024 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function stringValue(value: unknown, field: string, max: number, required = false): string {
  if (typeof value !== 'string') throw new Error(`${field} must be text.`);
  const normalized = value.trim();
  if (required && !normalized) throw new Error(`${field} is required.`);
  if (normalized.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) throw new Error(`${field} is invalid.`);
  return normalized;
}

function idValue(value: unknown, field: string): string {
  return stringValue(value, field, 256, true);
}

function emailValue(value: unknown): string {
  const email = stringValue(value, 'Email', 254, true).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw new Error('Email is invalid.');
  return email;
}

function phoneValue(value: unknown): string {
  const input = stringValue(value, 'Phone', 40, true);
  if (!/^[+()\-.\s0-9]+$/.test(input)) throw new Error('Phone is invalid.');
  const digits = input.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) throw new Error('Phone is invalid.');
  return input.startsWith('+') ? `+${digits}` : digits;
}

function listValues(value: unknown, validator: (entry: unknown) => string, max = 10): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw new Error('Too many values.');
  return [...new Set(value.map(validator))];
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  return stringValue(value, field, max);
}

function normalizeContactMutation(value: unknown): ContactMutationInput {
  if (!value || typeof value !== 'object') throw new Error('Contact change is required.');
  const input = value as Record<string, unknown>;
  if (input.operation === 'create') {
    const contact = input.contact as Record<string, unknown> | undefined;
    if (!contact || typeof contact !== 'object') throw new Error('Contact details are required.');
    const firstName = stringValue(contact.firstName, 'First name', 100);
    const lastName = stringValue(contact.lastName, 'Last name', 100);
    const organization = optionalText(contact.organization, 'Organization', 200);
    if (!firstName && !lastName && !organization) throw new Error('A name or organization is required.');
    return { operation: 'create', contact: { firstName, lastName, ...(organization !== undefined ? { organization } : {}), emails: listValues(contact.emails, emailValue), phones: listValues(contact.phones, phoneValue) } };
  }
  if (input.operation === 'update') {
    const changes = input.changes as Record<string, unknown> | undefined;
    if (!changes || typeof changes !== 'object') throw new Error('Contact changes are required.');
    const normalized: ContactUpdateInput['changes'] = {};
    for (const [key, label, max] of [['firstName', 'First name', 100], ['lastName', 'Last name', 100], ['organization', 'Organization', 200]] as const) {
      const result = optionalText(changes[key], label, max);
      if (result !== undefined) normalized[key] = result;
    }
    if (changes.addEmails !== undefined) normalized.addEmails = listValues(changes.addEmails, emailValue);
    if (changes.addPhones !== undefined) normalized.addPhones = listValues(changes.addPhones, phoneValue);
    if (Object.keys(normalized).length === 0) throw new Error('At least one contact change is required.');
    return { operation: 'update', contactId: idValue(input.contactId, 'Contact ID'), changes: normalized };
  }
  throw new Error('Unknown contact change.');
}

function safeDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function boundedString(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max) : '';
}

function normalizeContact(value: unknown): ContactRecord | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const id = boundedString(row.id, 256).trim();
  if (!id) return null;
  const emails = Array.isArray(row.emails) ? row.emails.map(item => boundedString(item, 254).trim()).filter(item => EMAIL_PATTERN.test(item)).slice(0, 20) : [];
  const phones = Array.isArray(row.phones) ? row.phones.map(item => boundedString(item, 80).trim()).filter(Boolean).slice(0, 20) : [];
  return {
    id,
    name: boundedString(row.name, 200).trim(),
    firstName: boundedString(row.firstName, 100).trim(),
    lastName: boundedString(row.lastName, 100).trim(),
    organization: boundedString(row.organization, 200).trim(),
    emails: [...new Set(emails)],
    phones: [...new Set(phones)],
  };
}

function normalizeThread(value: unknown): MessageThread | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const id = boundedString(row.id, 512).trim();
  if (!id) return null;
  return {
    id,
    title: boundedString(row.title, 200).trim() || 'Messages conversation',
    participants: Array.isArray(row.participants) ? [...new Set(row.participants.map(item => boundedString(item, 254).trim()).filter(Boolean))].slice(0, 50) : [],
    service: boundedString(row.service, 40).trim(),
    lastMessage: boundedString(row.lastMessage, 1_000),
    lastMessageAt: safeDate(row.lastMessageAt),
    lastMessageFromMe: row.lastMessageFromMe === true || row.lastMessageFromMe === 1 ? true : row.lastMessageFromMe === false || row.lastMessageFromMe === 0 ? false : null,
  };
}

function permissionFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:-1743|not authorized|not permitted|permission|operation not permitted|EACCES|EPERM)/i.test(message);
}

function digest(kind: ReviewKind, payload: unknown): string {
  return createHash('sha256').update(canonicalJson({ kind, payload })).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

function normalizeWriteContext(value: unknown, allowLegacyConversation = false): MacWriteContext {
  if (!value || typeof value !== 'object') throw new Error('A persisted conversation request is required for this write.');
  const input = value as Record<string, unknown>;
  const positive = (field: 'tenantId' | 'userId' | 'agentId' | 'revision') => {
    const number = input[field];
    if (!Number.isSafeInteger(number) || Number(number) <= 0) throw new Error('The signed-in owner or request revision is invalid.');
    return Number(number);
  };
  const turnId = idValue(input.turnId, 'Persisted turn ID');
  if (turnId.startsWith('received:')) throw new Error('Wait for this request to appear in the saved conversation before reviewing a local write.');
  const requestId = input.requestId === undefined ? undefined : idValue(input.requestId, 'Persisted request ID');
  const conversationKey = input.conversationKey === undefined && allowLegacyConversation
    ? undefined : idValue(input.conversationKey, 'Permanent conversation ID');
  const environment = input.environment === undefined ? undefined
    : input.environment === 'sandbox' || input.environment === 'production' ? input.environment : (() => { throw new Error('Assistant environment is invalid.'); })();
  const lineage = input.lineage === undefined ? undefined : stringValue(input.lineage, 'Authorization lineage', 64, true).toLowerCase();
  if (lineage !== undefined && !/^[a-f0-9]{64}$/.test(lineage)) throw new Error('Authorization lineage is invalid.');
  const turnDigest = stringValue(input.turnDigest, 'Turn digest', 64, true).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(turnDigest)) throw new Error('Turn digest is invalid.');
  return { tenantId: positive('tenantId'), userId: positive('userId'), ...(conversationKey ? { conversationKey } : {}), ...(environment ? { environment } : {}), ...(lineage ? { lineage } : {}), agentId: positive('agentId'), turnId, ...(requestId ? { requestId } : {}), turnDigest, revision: positive('revision') };
}

function normalizeReceiptCursor(value: unknown): { cursor?: { createdAt: number; id: string } } {
  if (!value || typeof value !== 'object') throw new Error('A signed-in conversation is required to list local write receipts.');
  const input = value as Record<string, unknown>;
  let cursor: { createdAt: number; id: string } | undefined;
  if (input.cursor !== undefined) {
    const encoded = stringValue(input.cursor, 'Receipt page cursor', 128, true);
    const match = /^(\d{1,16}):([\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})$/i.exec(encoded);
    const createdAt = match ? Number(match[1]) : NaN;
    if (!match || !Number.isSafeInteger(createdAt) || createdAt <= 0) throw new Error('Receipt page cursor is invalid.');
    cursor = { createdAt, id: match[2] };
  }
  return cursor ? { cursor } : {};
}

function normalizeAuthorityRequest(value: unknown): MacWriteAuthorityRequest {
  if (!value || typeof value !== 'object') throw new Error('Current server authorization is required for this local write.');
  const input = value as Record<string, unknown>;
  const bearerToken = stringValue(input.bearerToken, 'Current authorization', 8_192, true);
  if (/\s/.test(bearerToken)) throw new Error('Current authorization is invalid.');
  if (!Number.isSafeInteger(input.agentId) || Number(input.agentId) <= 0) throw new Error('Current assistant is invalid.');
  return { bearerToken, agentId: Number(input.agentId), sessionId: idValue(input.sessionId, 'Current assistant session') };
}

function normalizeAuthority(value: unknown): MacWriteAuthority {
  if (!value || typeof value !== 'object') throw new Error('Crokodial returned invalid local-write authority.');
  const input = value as Record<string, unknown>;
  if (input.version !== 1 || !Number.isSafeInteger(input.userId) || Number(input.userId) <= 0
    || !Number.isSafeInteger(input.tenantId) || Number(input.tenantId) <= 0
    || !['sandbox', 'production'].includes(String(input.environment))) throw new Error('Crokodial returned invalid local-write authority.');
  const lineage = stringValue(input.lineage, 'Authorization lineage', 64, true).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(lineage)) throw new Error('Crokodial returned invalid local-write authority.');
  return { version: 1, userId: Number(input.userId), tenantId: Number(input.tenantId), environment: input.environment as 'sandbox' | 'production',
    conversationKey: idValue(input.conversationKey, 'Permanent conversation ID'), lineage };
}

function normalizeNativeWriteServerReceipt(value: unknown, reviewId: string, allowed: readonly MacNativeWriteServerReceipt['state'][]): MacNativeWriteServerReceipt {
  if (!value || typeof value !== 'object') throw new MacConnectorAuthorityError('Crokodial returned an invalid native-write receipt.');
  const input = value as Record<string, unknown>;
  if (input.reviewId !== reviewId || !allowed.includes(input.state as MacNativeWriteServerReceipt['state'])) {
    throw new MacConnectorAuthorityError('Crokodial returned an invalid native-write receipt.');
  }
  const resolution = input.resolution === undefined ? undefined
    : input.resolution === 'applied' || input.resolution === 'not_applied' ? input.resolution
      : (() => { throw new MacConnectorAuthorityError('Crokodial returned an invalid native-write receipt.'); })();
  const message = input.message === undefined ? undefined : stringValue(input.message, 'Native write receipt', 1_000, true);
  return { reviewId, state: input.state as MacNativeWriteServerReceipt['state'], ...(resolution ? { resolution } : {}), ...(message ? { message } : {}) };
}

function authorityMatchesContext(authority: MacWriteAuthority, context: MacWriteContext): boolean {
  return authority.userId === context.userId && authority.tenantId === context.tenantId
    && authority.conversationKey === context.conversationKey
    && (context.environment === undefined || authority.environment === context.environment)
    && (context.lineage === undefined || authority.lineage === context.lineage);
}

function authorityMatchesOwnerConversation(authority: MacWriteAuthority, context: MacWriteContext): boolean {
  return authority.userId === context.userId && authority.tenantId === context.tenantId
    && authority.conversationKey === context.conversationKey
    && (context.environment === undefined || authority.environment === context.environment);
}

function authorityOwnsPersistedReceipt(authority: MacWriteAuthority, context: MacWriteContext): boolean {
  // Legacy receipts without both bindings cannot be attributed to the current
  // server environment/main conversation and therefore stay hidden.
  return authority.userId === context.userId && authority.tenantId === context.tenantId
    && authority.environment === context.environment
    && authority.conversationKey === context.conversationKey;
}

function sameConversation(left: MacWriteContext, right: MacWriteContext): boolean {
  // Receipts from the first durable-ledger release had no conversation key.
  // Their globally unique saved turn/request binding is migrated lazily.
  return left.conversationKey === undefined || right.conversationKey === undefined || left.conversationKey === right.conversationKey;
}

function sameWriteOrigin(left: MacWriteContext, right: MacWriteContext): boolean {
  return left.tenantId === right.tenantId && left.userId === right.userId && sameConversation(left, right)
    && left.turnId === right.turnId && left.requestId === right.requestId && left.turnDigest === right.turnDigest;
}

function sameWriteRequest(left: MacWriteContext, right: MacWriteContext): boolean {
  return left.tenantId === right.tenantId && left.userId === right.userId && sameConversation(left, right)
    && left.turnId === right.turnId && left.requestId === right.requestId;
}

function sameOwner(left: MacWriteContext, right: MacWriteContext): boolean {
  return left.tenantId === right.tenantId && left.userId === right.userId;
}

function cleanError(value: unknown): string {
  return boundedString(value instanceof Error ? value.message : String(value), 1_000) || 'The provider outcome could not be confirmed.';
}

function validateDurableLedger(value: unknown): DurableLedger | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object') throw new Error('Saved Mac write receipts are invalid.');
  const input = value as Record<string, unknown>;
  if (input.version !== 1 || !UUID_PATTERN.test(String(input.profileId ?? '')) || !Array.isArray(input.records) || input.records.length > MAX_DURABLE_REVIEWS) {
    throw new Error('Saved Mac write receipts are invalid.');
  }
  const profileId = String(input.profileId);
  const records = input.records.map(item => {
    if (!item || typeof item !== 'object') throw new Error('Saved Mac write receipts are invalid.');
    const row = item as Record<string, unknown>;
    const kind = row.kind;
    if (!['contact.create', 'contact.update', 'messages.send'].includes(String(kind)) || !UUID_PATTERN.test(String(row.id ?? ''))
      || !/^[a-f0-9]{64}$/.test(String(row.digest ?? '')) || !/^[a-f0-9]{64}$/.test(String(row.payloadDigest ?? ''))
      || !['pending', 'executing', 'succeeded', 'submitted', 'rejected', 'expired', 'unknown', 'reconciled'].includes(String(row.state))
      || !Number.isSafeInteger(row.createdAt) || !Number.isSafeInteger(row.updatedAt) || !Number.isSafeInteger(row.expiresAt)
      || row.profileId !== profileId) throw new Error('Saved Mac write receipts are invalid.');
    const context = normalizeWriteContext(row.context, true);
    const payload = row.payload;
    const payloadDigest = digest(kind as DurableReviewKind, payload);
    if (payloadDigest !== row.payloadDigest || digest(kind as DurableReviewKind, { context, payload }) !== row.digest) throw new Error('Saved Mac write receipts failed integrity validation.');
    const reconciliation = row.reconciliation;
    if (reconciliation !== undefined && (!reconciliation || typeof reconciliation !== 'object'
      || !['applied', 'not_applied'].includes(String((reconciliation as Record<string, unknown>).resolution))
      || !Number.isSafeInteger((reconciliation as Record<string, unknown>).reconciledAt))) throw new Error('Saved Mac write receipts are invalid.');
    const serverClaim = row.serverClaim;
    if (serverClaim !== undefined && (!serverClaim || typeof serverClaim !== 'object'
      || !UUID_PATTERN.test(String((serverClaim as Record<string, unknown>).claimToken ?? '')))) {
      throw new Error('Saved Mac write receipts are invalid.');
    }
    return item as DurableStoredReview;
  });
  return { version: 1, profileId, records };
}

/** Atomic mode-0600 storage. The main process supplies an OS-backed encryption codec. */
export function createFileMacConnectorWriteStorage(filePath: string, codec: MacConnectorStorageCodec): MacConnectorWriteStorage {
  const archiveDirectory = `${filePath}.archive`;
  const read = (target: string): unknown => {
    try {
      const stat = fs.lstatSync(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DURABLE_FILE_BYTES) throw new Error('Saved Mac write receipts are invalid.');
      return JSON.parse(codec.decode(fs.readFileSync(target, 'utf8')));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
      throw cause;
    }
  };
  const write = (target: string, value: DurableLedger): void => {
    const encoded = codec.encode(JSON.stringify(value));
    if (Buffer.byteLength(encoded) > MAX_DURABLE_FILE_BYTES) throw new Error('The local write receipt archive is full.');
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const descriptor = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(descriptor, encoded, 'utf8'); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      fs.renameSync(temporary, target);
      fs.chmodSync(target, 0o600);
      const directory = fs.openSync(path.dirname(target), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    } finally {
      try { fs.unlinkSync(temporary); } catch (cause) { if ((cause as NodeJS.ErrnoException)?.code !== 'ENOENT') throw cause; }
    }
  };
  return {
    load: () => read(filePath),
    save: ledger => write(filePath, ledger),
    loadArchive(key) {
      if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Saved Mac write archive key is invalid.');
      return read(path.join(archiveDirectory, `${key}.secure`));
    },
    saveArchive(key, archive) {
      if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('Saved Mac write archive key is invalid.');
      write(path.join(archiveDirectory, `${key}.secure`), archive);
    },
  };
}

function reviewSummary(kind: ReviewKind, payload: any): string {
  if (kind === 'contact.create') return `Create ${[payload.contact.firstName, payload.contact.lastName].filter(Boolean).join(' ') || payload.contact.organization}`;
  if (kind === 'contact.update') return `Update Contacts record ${payload.contactId}`;
  if (kind === 'messages.send') return `Submit one message to existing thread ${payload.thread.title}`;
  return `Open an unsent Messages draft addressed to ${payload.phone}`;
}

function reviewPublic(review: StoredReview) {
  return { id: review.id, kind: review.kind, digest: review.digest, summary: reviewSummary(review.kind, review.payload), payload: review.payload, createdAt: review.createdAt, expiresAt: review.expiresAt };
}

export function createMacConnectors(dependencies: MacConnectorDependencies = createDefaultMacConnectorDependencies(), suppliedStorage?: MacConnectorWriteStorage) {
  const permission = { contacts: 'unknown' as ConnectorState, messagesAutomation: 'unknown' as ConnectorState };
  const reviews = new Map<string, StoredReview>();
  let memoryLedger: DurableLedger | undefined;
  const memoryArchives = new Map<string, DurableLedger>();
  const storage: MacConnectorWriteStorage = suppliedStorage ?? {
    load: () => memoryLedger ? JSON.parse(JSON.stringify(memoryLedger)) : undefined,
    save: value => { memoryLedger = JSON.parse(JSON.stringify(value)) as DurableLedger; },
  };
  let durableLedger: DurableLedger | undefined;

  function archiveKey(context: MacWriteContext, kind: DurableReviewKind, legacy = false): string {
    return createHash('sha256').update(canonicalJson({
      profileId: ledger().profileId, kind, tenantId: context.tenantId, userId: context.userId,
      ...(!legacy && context.conversationKey ? { conversationKey: context.conversationKey } : {}),
      turnId: context.turnId, requestId: context.requestId ?? null,
    })).digest('hex');
  }

  function readArchive(key: string): DurableLedger | undefined {
    const raw = storage.loadArchive ? storage.loadArchive(key) : memoryArchives.get(key);
    const archive = validateDurableLedger(raw);
    if (archive && archive.profileId !== ledger().profileId) throw new Error('Saved Mac write receipts belong to a different local profile.');
    return archive;
  }

  function writeArchive(key: string, archive: DurableLedger): void {
    if (storage.saveArchive) storage.saveArchive(key, archive);
    else memoryArchives.set(key, JSON.parse(JSON.stringify(archive)) as DurableLedger);
  }

  function archivedFor(context: MacWriteContext, kind: DurableReviewKind): DurableStoredReview[] {
    const keys = [archiveKey(context, kind), ...(context.conversationKey ? [archiveKey(context, kind, true)] : [])];
    const seen = new Set<string>();
    const records: DurableStoredReview[] = [];
    for (const key of new Set(keys)) {
      for (const record of readArchive(key)?.records ?? []) {
        if (!seen.has(record.id) && record.kind === kind && sameWriteRequest(record.context, context)) { seen.add(record.id); records.push(record); }
      }
    }
    return records;
  }

  function persistLedger(next: DurableLedger): void {
    storage.save(next);
    durableLedger = next;
  }

  function ledger(): DurableLedger {
    if (durableLedger) return durableLedger;
    const loaded = validateDurableLedger(storage.load());
    if (!loaded) {
      const profileId = dependencies.randomId();
      if (!UUID_PATTERN.test(profileId)) throw new Error('Local profile identity is unavailable.');
      durableLedger = { version: 1, profileId, records: [] };
      return durableLedger;
    }
    const recoveredAt = dependencies.now();
    let changed = false;
    const records = loaded.records.map(record => {
      if (record.state !== 'executing') return record;
      changed = true;
      const receipt = {
        state: 'unknown', reviewId: record.id,
        message: record.kind === 'messages.send'
          ? 'Crokodial restarted while Messages was submitting this reviewed text. Inspect the thread before recording a new revision.'
          : 'Crokodial restarted while Contacts was applying this reviewed change. Search Contacts before recording a new revision.',
        error: 'The app cannot prove whether the external write completed.',
      };
      return { ...record, state: 'unknown' as const, updatedAt: recoveredAt, receipt };
    });
    durableLedger = changed ? { ...loaded, records } : loaded;
    if (changed) storage.save(durableLedger);
    return durableLedger;
  }

  function replaceDurable(current: DurableStoredReview, next: DurableStoredReview): DurableStoredReview {
    const currentLedger = ledger();
    const index = currentLedger.records.findIndex(item => item.id === current.id);
    if (index < 0) throw new Error('The saved review is unavailable.');
    const records = [...currentLedger.records]; records[index] = next;
    persistLedger({ ...currentLedger, records });
    return next;
  }

  function durableReviewPublic(review: DurableStoredReview) {
    return { ...reviewPublic(review), context: review.context, state: review.state };
  }

  function durableReceipt(review: DurableStoredReview): Record<string, unknown> {
    return { ...(review.receipt ?? {
      state: review.state,
      reviewId: review.id,
      message: review.state === 'executing' ? 'This reviewed write is executing. It cannot be submitted again.' : 'This reviewed write has a saved receipt.',
    }), kind: review.kind, digest: review.digest, context: review.context };
  }

  function durableSnapshot(review: DurableStoredReview) {
    return review.state === 'pending'
      ? { state: 'pending' as const, review: durableReviewPublic(review), nextRevision: review.context.revision }
      : { state: review.state, receipt: durableReceipt(review), nextRevision: review.state === 'reconciled' && review.reconciliation?.resolution === 'not_applied' ? review.context.revision + 1 : review.context.revision };
  }

  function expireIfNeeded(review: DurableStoredReview): DurableStoredReview {
    if (review.state !== 'pending' || review.expiresAt > dependencies.now()) return review;
    const receipt = { state: 'expired', reviewId: review.id, message: 'This exact local write review expired. Prepare and inspect a new review.' };
    return replaceDurable(review, { ...review, state: 'expired', updatedAt: dependencies.now(), receipt });
  }

  async function verifyAuthority(value: unknown): Promise<MacWriteAuthority> {
    return normalizeAuthority(await dependencies.authority.verify(normalizeAuthorityRequest(value)));
  }

  async function authorizedPrepareContext(contextValue: unknown, authorityValue: unknown): Promise<MacWriteContext> {
    const context = normalizeWriteContext(contextValue);
    if (!context.requestId || !UUID_PATTERN.test(context.requestId)) {
      throw new MacConnectorAuthorityError('Wait for this request to be saved in the permanent conversation before reviewing a local write.', true);
    }
    const authority = await verifyAuthority(authorityValue);
    if (!authorityMatchesContext(authority, context)) throw new MacConnectorAuthorityError('The active server conversation no longer authorizes this local write.', true);
    return { ...context, environment: authority.environment, lineage: authority.lineage };
  }

  function nativeClaim(record: DurableStoredReview, claimToken = record.serverClaim?.claimToken): MacNativeWriteClaim {
    if (!claimToken || !UUID_PATTERN.test(claimToken) || !record.context.requestId || !UUID_PATTERN.test(record.context.requestId)) {
      throw new Error('This native write has no valid durable server claim identity.');
    }
    return { reviewId: record.id, claimToken, requestId: record.context.requestId, turnId: record.context.turnId,
      turnDigest: record.context.turnDigest, kind: record.kind, revision: record.context.revision,
      payloadDigest: record.payloadDigest, reviewDigest: record.digest };
  }

  async function authorizedExecution(binding: unknown, kind: DurableReviewKind, authorityValue: unknown): Promise<
    { executing: DurableStoredReview; authorityRequest: MacWriteAuthorityRequest } | { receipt: Record<string, unknown> }
  > {
    // Validate the opaque saved binding first, but claim only after the awaited
    // server check. Every caller re-binds after that check to preserve the
    // exactly-once claim under concurrent IPC invocations.
    const initial = bindDurable(binding, kind);
    if (!initial.context.environment || !initial.context.lineage) {
      return { receipt: finishDurable(bindDurable(binding, kind), 'rejected', { state: 'rejected', reviewId: initial.id,
        message: 'This review predates server authorization binding and was invalidated. Prepare and inspect a new review.' }) };
    }
    const authorityRequest = normalizeAuthorityRequest(authorityValue);
    let authority: MacWriteAuthority;
    try { authority = normalizeAuthority(await dependencies.authority.verify(authorityRequest)); }
    catch (error) {
      if (error instanceof MacConnectorAuthorityError && error.definitive) {
        return { receipt: finishDurable(bindDurable(binding, kind), 'rejected', { state: 'rejected', reviewId: initial.id,
          message: 'The signed-in server authorization changed. This pending local write was invalidated before any provider action.', error: cleanError(error) }) };
      }
      throw error;
    }
    if (!authorityMatchesContext(authority, initial.context)) {
      return { receipt: finishDurable(bindDurable(binding, kind), 'rejected', { state: 'rejected', reviewId: initial.id,
        message: 'The active owner, tenant, conversation, or authorization lineage changed. This pending local write was invalidated before any provider action.' }) };
    }
    const claimToken = dependencies.randomId();
    if (!UUID_PATTERN.test(claimToken)) throw new Error('Native write claim identity is unavailable.');
    const executing = markExecuting(bindDurable(binding, kind), claimToken);
    try {
      normalizeNativeWriteServerReceipt(await dependencies.authority.claim(authorityRequest, nativeClaim(executing)), executing.id, ['executing']);
      return { executing, authorityRequest };
    } catch (error) {
      return { receipt: finishDurable(executing, 'unknown', { state: 'unknown', reviewId: executing.id,
        message: 'Crokodial could not prove whether the server execution claim was saved. No provider write was started; reconcile this receipt before any retry.',
        error: cleanError(error) }) };
    }
  }

  function latestFor(context: MacWriteContext, kind: DurableReviewKind, authority?: MacWriteAuthority): DurableStoredReview | undefined {
    return [...ledger().records.filter(item => item.kind === kind && sameWriteRequest(item.context, context)), ...archivedFor(context, kind)]
      .filter(item => !authority || authorityOwnsPersistedReceipt(authority, item.context))
      .sort((left, right) => right.context.revision - left.context.revision || right.createdAt - left.createdAt)[0];
  }

  function rotateTerminalReceipts(): DurableLedger {
    const current = ledger();
    if (current.records.length < MAX_DURABLE_REVIEWS) return current;
    const terminal = current.records.filter(record => !['pending', 'executing', 'unknown'].includes(record.state))
      .sort((left, right) => left.updatedAt - right.updatedAt).slice(0, ARCHIVE_ROTATION_BATCH);
    if (!terminal.length) throw new Error('Too many local writes have unresolved outcomes. Reconcile their saved receipts before preparing more writes.');
    const groups = new Map<string, DurableStoredReview[]>();
    for (const record of terminal) {
      const key = archiveKey(record.context, record.kind);
      groups.set(key, [...(groups.get(key) ?? []), record]);
    }
    // Archive first, then atomically replace the active ledger. A crash between
    // these steps leaves harmless duplicate copies and never loses replay data.
    for (const [key, additions] of groups) {
      const existing = readArchive(key) ?? { version: 1 as const, profileId: current.profileId, records: [] };
      const byId = new Map(existing.records.map(record => [record.id, record]));
      additions.forEach(record => byId.set(record.id, record));
      if (byId.size > MAX_DURABLE_REVIEWS) throw new Error('This saved request has too many archived revisions. Start a new persisted request.');
      writeArchive(key, { ...existing, records: [...byId.values()] });
    }
    const archivedIds = new Set(terminal.map(record => record.id));
    const next = { ...current, records: current.records.filter(record => !archivedIds.has(record.id)) };
    persistLedger(next);
    return next;
  }

  function prepareDurable(kind: DurableReviewKind, contextValue: unknown, payload: unknown): DurableStoredReview {
    const context = normalizeWriteContext(contextValue);
    const payloadDigest = digest(kind, payload);
    let currentLedger = ledger();
    const uncertain = currentLedger.records.find(item => sameOwner(item.context, context) && item.kind === kind
      && item.payloadDigest === payloadDigest && ['executing', 'unknown'].includes(item.state));
    if (uncertain) throw new Error('This exact write has an unresolved outcome. Reconcile its saved receipt before creating any new revision.');
    const previous = latestFor(context, kind);
    if (previous) {
      const settled = expireIfNeeded(previous);
      if (context.revision === settled.context.revision && settled.payloadDigest === payloadDigest && settled.state === 'pending') return settled;
      if (context.revision === settled.context.revision) throw new Error('This persisted request already has a saved write receipt. Restore it instead of preparing another write.');
      if (context.revision !== settled.context.revision + 1 || settled.state !== 'reconciled' || settled.reconciliation?.resolution !== 'not_applied') {
        throw new Error('A new revision is allowed only after the prior outcome is explicitly reconciled as not applied.');
      }
    } else if (context.revision !== 1) throw new Error('The first reviewed write for a persisted request must use revision 1.');
    if (currentLedger.records.length >= MAX_DURABLE_REVIEWS) currentLedger = rotateTerminalReceipts();
    const createdAt = dependencies.now();
    const record: DurableStoredReview = {
      id: dependencies.randomId(), kind, context, profileId: currentLedger.profileId, payload,
      payloadDigest, digest: digest(kind, { context, payload }), state: 'pending',
      createdAt, updatedAt: createdAt, expiresAt: createdAt + REVIEW_TTL_MS,
    };
    if (!UUID_PATTERN.test(record.id)) throw new Error('Review identity is unavailable.');
    persistLedger({ ...currentLedger, records: [...currentLedger.records, record] });
    return record;
  }

  function bindDurable(binding: unknown, kind: DurableReviewKind): DurableStoredReview {
    if (!binding || typeof binding !== 'object') throw new Error('Review binding is required.');
    const candidate = binding as Record<string, unknown>;
    const id = idValue(candidate.id, 'Review ID');
    const suppliedDigest = stringValue(candidate.digest, 'Review digest', 64, true);
    const context = normalizeWriteContext(candidate.context);
    const record = ledger().records.find(item => item.id === id);
    if (!record || record.kind !== kind || !sameWriteOrigin(record.context, context) || record.context.revision !== context.revision) throw new Error('This saved review does not belong to the signed-in owner and persisted request.');
    const current = expireIfNeeded(record);
    if (current.state !== 'pending') throw new Error('This reviewed write already has a saved receipt and cannot be replayed.');
    if (suppliedDigest !== current.digest) throw new Error('The reviewed request changed.');
    return current;
  }

  function markExecuting(record: DurableStoredReview, claimToken: string): DurableStoredReview {
    return replaceDurable(record, { ...record, state: 'executing', serverClaim: { claimToken }, updatedAt: dependencies.now(), receipt: {
      state: 'executing', reviewId: record.id, message: 'The exact reviewed write is executing and cannot be submitted again.',
    } });
  }

  function finishDurable(record: DurableStoredReview, state: DurableWriteState, receipt: Record<string, unknown>): Record<string, unknown> {
    const boundReceipt = { ...receipt, kind: record.kind, digest: record.digest, context: record.context };
    try {
      replaceDurable(record, { ...record, state, updatedAt: dependencies.now(), receipt: boundReceipt });
      return boundReceipt;
    } catch (error) {
      const unknown = { state: 'unknown', reviewId: record.id, kind: record.kind, digest: record.digest, context: record.context, message: 'The external write may have completed, but Crokodial could not preserve its final receipt. Reconcile before any retry.', error: cleanError(error) };
      try { replaceDurable(record, { ...record, state: 'unknown', updatedAt: dependencies.now(), receipt: unknown }); } catch { /* An on-disk executing state is recovered as unknown on restart. */ }
      return unknown;
    }
  }

  async function assertNativeProviderBoundary(record: DurableStoredReview, authorityRequest: MacWriteAuthorityRequest): Promise<void> {
    const claim = nativeClaim(record);
    normalizeNativeWriteServerReceipt(
      await dependencies.authority.assert(authorityRequest, record.id, claim.claimToken), record.id, ['executing']);
  }

  async function finalizeNativeServer(record: DurableStoredReview, authorityRequest: MacWriteAuthorityRequest,
    state: 'succeeded' | 'failed' | 'unknown', message: string): Promise<MacNativeWriteServerReceipt> {
    const claim = nativeClaim(record);
    return normalizeNativeWriteServerReceipt(
      await dependencies.authority.finalize(authorityRequest, record.id, claim.claimToken, state, message), record.id, [state]);
  }

  function unknownReceipt(record: DurableStoredReview, message: string, error: unknown): Record<string, unknown> {
    return finishDurable(record, 'unknown', { state: 'unknown', message, reviewId: record.id, error: cleanError(error) });
  }

  async function failBeforeProvider(record: DurableStoredReview, authorityRequest: MacWriteAuthorityRequest,
    message: string, error?: unknown): Promise<Record<string, unknown>> {
    try {
      await finalizeNativeServer(record, authorityRequest, 'failed', message);
      return finishDurable(record, 'rejected', { state: 'rejected', message, reviewId: record.id,
        ...(error === undefined ? {} : { error: cleanError(error) }) });
    } catch (finalizeError) {
      return unknownReceipt(record,
        'No provider write was started, but Crokodial could not close its durable server claim. Reconcile this receipt before any retry.', finalizeError);
    }
  }

  function requireMac(): void {
    if (dependencies.platform !== 'darwin') throw new Error('Mac connectors are available on macOS only.');
  }

  function pruneReviews(): void {
    const now = dependencies.now();
    for (const [id, review] of reviews) if (review.expiresAt <= now) reviews.delete(id);
    while (reviews.size >= MAX_REVIEWS) reviews.delete(reviews.keys().next().value as string);
  }

  function prepare(kind: ReviewKind, payload: unknown) {
    pruneReviews();
    const createdAt = dependencies.now();
    const review: StoredReview = { id: dependencies.randomId(), kind, payload, digest: digest(kind, payload), createdAt, expiresAt: createdAt + REVIEW_TTL_MS };
    if (!UUID_PATTERN.test(review.id)) throw new Error('Review identity is unavailable.');
    reviews.set(review.id, review);
    return reviewPublic(review);
  }

  function consume(binding: unknown, kind: ReviewKind): StoredReview {
    if (!binding || typeof binding !== 'object') throw new Error('Review binding is required.');
    const candidate = binding as Record<string, unknown>;
    const id = idValue(candidate.id, 'Review ID');
    const suppliedDigest = stringValue(candidate.digest, 'Review digest', 64, true);
    const review = reviews.get(id);
    if (!review || review.kind !== kind) throw new Error('This review is missing or was already used.');
    if (review.expiresAt <= dependencies.now()) { reviews.delete(id); throw new Error('This review expired. Review the request again.'); }
    if (suppliedDigest !== review.digest) throw new Error('The reviewed request changed.');
    reviews.delete(id);
    return review;
  }

  async function status() {
    if (dependencies.platform !== 'darwin') return {
      platform: 'unsupported',
      contacts: { state: 'unsupported', detail: 'Contacts integration requires macOS.' },
      messagesHistory: { state: 'unsupported', detail: 'Messages history requires macOS.' },
      messagesSend: { state: 'unsupported', detail: 'Messages automation requires macOS.' },
      whatsapp: { state: 'unsupported', detail: 'Local WhatsApp search requires macOS.' },
      smsDraft: { state: 'unsupported', detail: 'SMS compose handoff requires macOS.' },
    };
    const [messagesHistory, whatsapp] = await Promise.all([
      dependencies.messages.historyStatus().catch(error => permissionFailure(error) ? 'permission_required' as const : 'unavailable' as const),
      dependencies.whatsapp.status().catch(error => permissionFailure(error) ? 'permission_required' as const : 'unavailable' as const),
    ]);
    return {
      platform: 'macos',
      contacts: { state: permission.contacts, detail: permission.contacts === 'available' ? 'Contacts access is available.' : permission.contacts === 'denied' ? 'Contacts denied Automation access. Enable Crokodial Workspace in Privacy & Security > Automation.' : 'Check Contacts to request or verify Automation access.' },
      messagesHistory: { state: messagesHistory, detail: messagesHistory === 'available' ? 'Messages history is readable from this Mac.' : messagesHistory === 'permission_required' ? 'Grant Crokodial Workspace Full Disk Access to read existing Messages history.' : 'Messages history is unavailable.' },
      messagesSend: { state: permission.messagesAutomation, detail: permission.messagesAutomation === 'available' ? 'Messages Automation access is available.' : permission.messagesAutomation === 'denied' ? 'Messages denied Automation access. Enable Crokodial Workspace in Privacy & Security > Automation.' : 'Check Messages to request or verify Automation access.' },
      whatsapp: { state: whatsapp, detail: whatsapp === 'available' ? 'A supported local WhatsApp store is available in read-only mode.' : whatsapp === 'permission_required' ? 'Grant Crokodial Workspace Full Disk Access to read local WhatsApp data.' : 'No supported, readable WhatsApp store was found.' },
      smsDraft: { state: 'available', detail: 'Opens the system sms: compose surface with a reviewed recipient. Apple does not permit message text in sms: links.' },
    };
  }

  async function requestAccess(connector: unknown) {
    requireMac();
    if (connector === 'contacts') {
      try { await dependencies.contacts.requestAccess(); permission.contacts = 'available'; }
      catch (error) { permission.contacts = permissionFailure(error) ? 'denied' : 'unavailable'; throw error; }
    } else if (connector === 'messages') {
      try { await dependencies.messages.requestAutomationAccess(); permission.messagesAutomation = 'available'; }
      catch (error) { permission.messagesAutomation = permissionFailure(error) ? 'denied' : 'unavailable'; throw error; }
    } else throw new Error('Unknown connector permission.');
    return status();
  }

  function requirePermission(key: keyof typeof permission, name: string): void {
    if (permission[key] !== 'available') throw new Error(`Check ${name} access before using this connector.`);
  }

  async function searchContacts(queryValue: unknown): Promise<{ contacts: ContactRecord[] }> {
    requireMac(); requirePermission('contacts', 'Contacts');
    const query = stringValue(queryValue, 'Contact search', 100, true);
    if (query.length < 2) throw new Error('Enter at least two characters.');
    const rows = await dependencies.contacts.search(query);
    return { contacts: rows.map(normalizeContact).filter((row): row is ContactRecord => Boolean(row)).slice(0, 100) };
  }

  async function previewContactDuplicates(): Promise<{ groups: Array<{ key: string; reason: string; contacts: ContactRecord[] }>; truncated: boolean }> {
    requireMac(); requirePermission('contacts', 'Contacts');
    const raw = await dependencies.contacts.listAll();
    const contacts = raw.map(normalizeContact).filter((row): row is ContactRecord => Boolean(row)).slice(0, MAX_CONTACTS);
    const parent = contacts.map((_, index) => index);
    const find = (index: number): number => parent[index] === index ? index : (parent[index] = find(parent[index]));
    const union = (a: number, b: number) => { const left = find(a), right = find(b); if (left !== right) parent[right] = left; };
    const observed = new Map<string, number>();
    contacts.forEach((contact, index) => {
      const keys = [...contact.emails.map(email => `email:${email.toLowerCase()}`), ...contact.phones.map(phone => `phone:${phone.replace(/\D/g, '')}`).filter(key => key.length >= 13)];
      for (const key of new Set(keys)) { const prior = observed.get(key); if (prior !== undefined) union(index, prior); else observed.set(key, index); }
    });
    const grouped = new Map<number, ContactRecord[]>();
    contacts.forEach((contact, index) => { const root = find(index); grouped.set(root, [...(grouped.get(root) ?? []), contact]); });
    const allGroups = [...grouped.values()].filter(group => group.length > 1).map(group => {
      const sharedEmails = group.flatMap(contact => contact.emails.map(value => value.toLowerCase())).filter((value, index, all) => all.indexOf(value) !== index);
      const sharedPhones = group.flatMap(contact => contact.phones.map(value => value.replace(/\D/g, ''))).filter((value, index, all) => value.length >= 7 && all.indexOf(value) !== index);
      const reason = sharedEmails[0] ? `Shared email ${sharedEmails[0]}` : `Shared phone ending ${sharedPhones[0]?.slice(-4) ?? 'number'}`;
      return { key: createHash('sha256').update(group.map(contact => contact.id).sort().join('\0')).digest('hex').slice(0, 16), reason, contacts: group };
    });
    return { groups: allGroups.slice(0, 100), truncated: raw.length > MAX_CONTACTS || allGroups.length > 100 };
  }

  async function prepareContactMutation(input: unknown) {
    requireMac(); requirePermission('contacts', 'Contacts');
    if (!input || typeof input !== 'object') throw new Error('Contact change is required.');
    const candidate = input as Record<string, unknown>;
    const normalized = normalizeContactMutation(candidate.change);
    const context = await authorizedPrepareContext(candidate.context, candidate.authority);
    return durableReviewPublic(prepareDurable(normalized.operation === 'create' ? 'contact.create' : 'contact.update', context, normalized));
  }

  async function executeContactMutation(binding: unknown) {
    requireMac(); requirePermission('contacts', 'Contacts');
    if (!binding || typeof binding !== 'object') throw new Error('Review binding is required.');
    const candidate = binding as Record<string, unknown>;
    const requestedKind = candidate.kind === 'contact.create' ? 'contact.create' : candidate.kind === 'contact.update' ? 'contact.update' : null;
    if (!requestedKind) throw new Error('Unknown contact review.');
    const authorization = await authorizedExecution(candidate, requestedKind, candidate.authority);
    if ('receipt' in authorization) return authorization.receipt;
    const { executing: review, authorityRequest } = authorization;
    try { await assertNativeProviderBoundary(review, authorityRequest); }
    catch (error) {
      return unknownReceipt(review, 'No Contacts write was started, but Crokodial could not revalidate the durable server claim. Reconcile this receipt before any retry.', error);
    }
    try {
      const payload = review.payload as ContactMutationInput;
      const result = payload.operation === 'create' ? await dependencies.contacts.create(payload.contact) : await dependencies.contacts.update(payload.contactId, payload.changes);
      const contact = normalizeContact(result);
      if (!contact) throw new Error('Contacts returned an invalid record.');
      try { await finalizeNativeServer(review, authorityRequest, 'succeeded', payload.operation === 'create' ? 'Contact created.' : 'Contact updated.'); }
      catch (error) {
        return unknownReceipt(review, 'Contacts accepted the write, but Crokodial could not preserve its durable server receipt. Search Contacts and reconcile before any retry.', error);
      }
      return finishDurable(review, 'succeeded', { state: 'succeeded', message: payload.operation === 'create' ? 'Contact created.' : 'Contact updated.', contact, reviewId: review.id });
    } catch (error) {
      try { await finalizeNativeServer(review, authorityRequest, 'unknown', 'Contacts did not confirm the final state.'); } catch { /* The local unknown receipt retains the exact encrypted claim for recovery. */ }
      return unknownReceipt(review, 'Contacts did not confirm the final state. Search Contacts and reconcile this receipt before recording a new revision.', error);
    }
  }

  async function listMessageThreads(queryValue: unknown = '') {
    requireMac();
    const query = stringValue(queryValue, 'Messages search', 100);
    const rows = await dependencies.messages.listThreads(query);
    return { threads: rows.map(normalizeThread).filter((row): row is MessageThread => Boolean(row)).slice(0, 50) };
  }

  async function readMessageThread(threadIdValue: unknown) {
    requireMac();
    const threadId = idValue(threadIdValue, 'Messages thread');
    const result = await dependencies.messages.readThread(threadId);
    const thread = normalizeThread(result.thread);
    if (!thread || thread.id !== threadId) throw new Error('Messages returned a different conversation.');
    const messages = (Array.isArray(result.messages) ? result.messages : []).map(value => {
      if (!value || typeof value !== 'object') return null;
      const row = value as unknown as Record<string, unknown>;
      const id = boundedString(row.id, 512).trim();
      if (!id) return null;
      return { id, text: boundedString(row.text, 10_000), sender: boundedString(row.sender, 254), fromMe: row.fromMe === true, sentAt: safeDate(row.sentAt) };
    }).filter((row): row is ThreadMessage => Boolean(row)).slice(0, 100);
    return { thread, messages };
  }

  async function prepareMessageSend(input: unknown) {
    requireMac(); requirePermission('messagesAutomation', 'Messages');
    if (!input || typeof input !== 'object') throw new Error('Message request is required.');
    const candidate = input as Record<string, unknown>;
    const context = await authorizedPrepareContext(candidate.context, candidate.authority);
    const threadId = idValue(candidate.threadId, 'Messages thread');
    const text = stringValue(candidate.text, 'Message', 4_000, true);
    const current = await readMessageThread(threadId);
    const payload = { thread: { id: current.thread.id, title: current.thread.title, participants: [...current.thread.participants].sort(), service: current.thread.service }, text };
    return durableReviewPublic(prepareDurable('messages.send', context, payload));
  }

  async function executeMessageSend(binding: unknown) {
    requireMac(); requirePermission('messagesAutomation', 'Messages');
    const candidate = binding as Record<string, unknown>;
    // authorizedExecution re-binds and persists executing within the same
    // post-verification microtask, before its promise resolves to this caller.
    const authorization = await authorizedExecution(binding, 'messages.send', candidate?.authority);
    if ('receipt' in authorization) return authorization.receipt;
    const { executing, authorityRequest } = authorization;
    const payload = executing.payload as { thread: MessageThread; text: string };
    let current: Awaited<ReturnType<typeof readMessageThread>>;
    try { current = await readMessageThread(payload.thread.id); }
    catch (error) {
      return failBeforeProvider(executing, authorityRequest, 'Crokodial could not revalidate the existing Messages thread, so nothing was submitted. Start a new persisted request after inspecting the thread.', error);
    }
    if (JSON.stringify([...current.thread.participants].sort()) !== JSON.stringify(payload.thread.participants) || current.thread.service !== payload.thread.service) {
      return failBeforeProvider(executing, authorityRequest, 'The existing Messages thread changed. Start a new persisted chat request before reviewing another send.');
    }
    try { await assertNativeProviderBoundary(executing, authorityRequest); }
    catch (error) {
      return unknownReceipt(executing, 'No Messages send was started, but Crokodial could not revalidate the durable server claim. Reconcile this receipt before any retry.', error);
    }
    try {
      await dependencies.messages.sendExistingThread(payload.thread.id, payload.text);
      try { await finalizeNativeServer(executing, authorityRequest, 'succeeded', 'Messages accepted the exact reviewed text for the existing thread.'); }
      catch (error) {
        return unknownReceipt(executing, 'Messages accepted the send, but Crokodial could not preserve its durable server receipt. Inspect the thread and reconcile before any retry.', error);
      }
      return finishDurable(executing, 'submitted', { state: 'submitted', message: 'Messages accepted the exact reviewed text for the existing thread. Delivery is not confirmed.', reviewId: executing.id });
    } catch (error) {
      try { await finalizeNativeServer(executing, authorityRequest, 'unknown', 'Messages did not confirm whether the reviewed text was submitted.'); } catch { /* Preserve encrypted recovery claim. */ }
      return unknownReceipt(executing, 'Messages did not confirm whether the reviewed text was submitted. Inspect the thread and reconcile this receipt before recording a new revision.', error);
    }
  }

  async function restoreReviewedWrite(input: unknown) {
    requireMac();
    if (!input || typeof input !== 'object') throw new Error('Saved write lookup is required.');
    const candidate = input as Record<string, unknown>;
    const supplied = normalizeWriteContext(candidate.context);
    const authority = await verifyAuthority(candidate.authority);
    if (!authorityMatchesOwnerConversation(authority, supplied)) {
      throw new MacConnectorAuthorityError('The saved receipt does not belong to the active owner conversation.', true);
    }
    const context: MacWriteContext = { ...supplied, userId: authority.userId, tenantId: authority.tenantId,
      conversationKey: authority.conversationKey, environment: authority.environment };
    const kind = candidate.kind;
    if (!['contact.create', 'contact.update', 'messages.send'].includes(String(kind))) throw new Error('Unknown saved write kind.');
    const review = latestFor(context, kind as DurableReviewKind, authority);
    if (review && !sameWriteOrigin(review.context, context)) throw new Error('The saved request content changed. Restore the original persisted turn before reviewing its receipt.');
    return review ? durableSnapshot(expireIfNeeded(review)) : { state: 'none', nextRevision: 1 };
  }

  async function listReviewedWrites(input: unknown) {
    requireMac();
    if (!input || typeof input !== 'object') throw new Error('A signed-in conversation is required to list local write receipts.');
    const candidate = input as Record<string, unknown>;
    const scope = normalizeReceiptCursor(candidate);
    const authority = await verifyAuthority(candidate.authority);
    const belongs = (record: DurableStoredReview) => authorityOwnsPersistedReceipt(authority, record.context);
    const owned = ledger().records.filter(belongs).sort((left, right) => right.createdAt - left.createdAt || right.id.localeCompare(left.id));
    const afterCursor = scope.cursor ? owned.filter(record => record.createdAt < scope.cursor!.createdAt
      || record.createdAt === scope.cursor!.createdAt && record.id.localeCompare(scope.cursor!.id) < 0) : owned;
    const page = afterCursor.slice(0, 100);
    const records = page.map(value => {
      const record = expireIfNeeded(value);
      return { kind: record.kind, context: record.context, payload: record.payload, summary: reviewSummary(record.kind, record.payload),
        createdAt: record.createdAt, updatedAt: record.updatedAt, ...durableSnapshot(record) };
    });
    const nextCursor = afterCursor.length > page.length && page.length
      ? `${page[page.length - 1].createdAt}:${page[page.length - 1].id}` : undefined;
    return { records, truncated: Boolean(nextCursor), ...(nextCursor ? { nextCursor } : {}) };
  }

  async function reconcileReviewedWrite(input: unknown) {
    requireMac();
    if (!input || typeof input !== 'object') throw new Error('Saved receipt reconciliation is required.');
    const candidate = input as Record<string, unknown>;
    const id = idValue(candidate.id, 'Review ID');
    const suppliedDigest = stringValue(candidate.digest, 'Review digest', 64, true);
    const context = normalizeWriteContext(candidate.context);
    const authorityRequest = normalizeAuthorityRequest(candidate.authority);
    const resolution = candidate.resolution === 'applied' ? 'applied' : candidate.resolution === 'not_applied' ? 'not_applied' : null;
    if (!resolution) throw new Error('Choose whether the reviewed write was applied.');
    const record = ledger().records.find(item => item.id === id);
    if (!record || !sameWriteOrigin(record.context, context) || record.context.revision !== context.revision || record.digest !== suppliedDigest) {
      throw new Error('This saved receipt does not belong to the signed-in owner and persisted request.');
    }
    if (record.state !== 'unknown') throw new Error('Only an unresolved write can be reconciled.');
    const authority = normalizeAuthority(await dependencies.authority.verify(authorityRequest));
    if (!authorityOwnsPersistedReceipt(authority, record.context)) {
      throw new MacConnectorAuthorityError('The active owner, tenant, or permanent conversation changed before reconciliation.', true);
    }
    if (record.serverClaim) {
      const server = normalizeNativeWriteServerReceipt(
        await dependencies.authority.reconcile(authorityRequest, nativeClaim(record), resolution), record.id,
        ['succeeded', 'failed', 'reconciled']);
      if (server.state === 'succeeded') {
        const state: DurableWriteState = record.kind === 'messages.send' ? 'submitted' : 'succeeded';
        const message = server.message ?? (record.kind === 'messages.send'
          ? 'The durable server receipt confirms that Messages accepted this reviewed send. Delivery is not confirmed.'
          : 'The durable server receipt confirms that Contacts accepted this reviewed change.');
        return durableSnapshot(replaceDurable(record, { ...record, state, updatedAt: dependencies.now(), receipt: {
          state, reviewId: record.id, message,
        } }));
      }
      if (server.state === 'failed') {
        return durableSnapshot(replaceDurable(record, { ...record, state: 'rejected', updatedAt: dependencies.now(), receipt: {
          state: 'rejected', reviewId: record.id, message: server.message ?? 'The durable server receipt confirms that no native provider write was started.',
        } }));
      }
      if (server.resolution !== resolution) throw new Error('The durable server receipt has a different reconciliation. Refresh this write receipt.');
    }
    const reconciledAt = dependencies.now();
    const receipt = {
      state: 'reconciled', reviewId: record.id, resolution,
      message: resolution === 'applied'
        ? 'You recorded that the external write is present. This exact action remains closed.'
        : 'You recorded that the external write is absent. A separately reviewed next revision is now allowed.',
    };
    const saved = replaceDurable(record, { ...record, state: 'reconciled', updatedAt: reconciledAt, reconciliation: { resolution, reconciledAt }, receipt });
    return durableSnapshot(saved);
  }

  function normalizeWhatsAppObservation(value: unknown, expectedJid?: string): WhatsAppObservation | null {
    if (!value || typeof value !== 'object') return null;
    const row = value as Record<string, unknown>;
    const id = boundedString(row.id, 128).trim();
    const threadId = boundedString(row.threadId, 128).trim();
    const threadJid = boundedString(row.threadJid, 256).trim();
    if (!id || !threadId || !threadJid || expectedJid && threadJid !== expectedJid) return null;
    return { id, threadId, threadJid, threadTitle: boundedString(row.threadTitle, 200) || threadJid, sender: boundedString(row.sender, 254),
      text: boundedString(row.text, 10_000), fromMe: row.fromMe === true, sentAt: safeDate(row.sentAt) };
  }

  async function searchWhatsApp(queryValue: unknown) {
    requireMac();
    const query = stringValue(queryValue, 'WhatsApp search', 100, true);
    if (query.length < 2) throw new Error('Enter at least two characters.');
    const observations = (await dependencies.whatsapp.search(query)).map(value => normalizeWhatsAppObservation(value))
      .filter((row): row is WhatsAppObservation => Boolean(row)).slice(0, 100);
    return { observations, readOnly: true };
  }

  async function readWhatsAppConversation(jidValue: unknown) {
    requireMac();
    const jid = stringValue(jidValue, 'WhatsApp conversation identifier', 256, true);
    const result = await dependencies.whatsapp.readConversation(jid);
    if (!result?.conversation || result.conversation.jid !== jid) throw new Error('The selected WhatsApp conversation identity changed or is unavailable. Select it again.');
    const label = boundedString(result.conversation.label, 200).trim() || jid;
    const candidates = Array.isArray(result.observations) ? result.observations : [];
    if (candidates.some(value => !value || typeof value !== 'object' || boundedString((value as unknown as Record<string, unknown>).threadJid, 256).trim() !== jid)) {
      throw new Error('The selected WhatsApp conversation returned data from a different thread. Monitoring stopped for this read.');
    }
    const observations = candidates.map(value => normalizeWhatsAppObservation(value, jid))
      .filter((row): row is WhatsAppObservation => Boolean(row)).slice(0, 100);
    return { conversation: { jid, label }, observations, readOnly: true };
  }

  async function prepareSmsDraft(input: unknown) {
    requireMac();
    if (!input || typeof input !== 'object') throw new Error('SMS draft is required.');
    const candidate = input as Record<string, unknown>;
    const phone = phoneValue(candidate.phone);
    const text = stringValue(candidate.text, 'Draft text', 4_000, true);
    return prepare('sms.compose', { phone, text });
  }

  async function openSmsDraft(binding: unknown) {
    requireMac();
    const review = consume(binding, 'sms.compose');
    const payload = review.payload as { phone: string; text: string };
    // Apple's supported sms: URL accepts only a recipient. The exact body stays
    // in the review surface for manual copy; no native send is triggered here.
    await dependencies.openExternal(`sms:${payload.phone}`);
    return { state: 'opened', message: 'Opened an unsent system Messages compose surface. The reviewed text remains in Crokodial for copy and was not sent.', reviewId: review.id, text: payload.text };
  }

  return { status, requestAccess, searchContacts, previewContactDuplicates, prepareContactMutation, executeContactMutation, listMessageThreads, readMessageThread, prepareMessageSend, executeMessageSend, restoreReviewedWrite, listReviewedWrites, reconcileReviewedWrite, searchWhatsApp, readWhatsAppConversation, prepareSmsDraft, openSmsDraft };
}

type ExecFileFunction = typeof execFile;

function runFile(exec: ExecFileFunction, executable: string, args: string[], timeout = 8_000): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(executable, args, { timeout, maxBuffer: 2 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) return reject(new Error(`${stderr || error.message}`.trim()));
      resolve(stdout);
    });
  });
}

const CONTACTS_JXA = String.raw`
function clean(value) { try { var result = value(); return result == null ? '' : String(result); } catch (_) { return ''; } }
function values(entries) { try { return entries().map(function (entry) { return clean(entry.value); }).filter(Boolean); } catch (_) { return []; } }
function record(person) { return { id: clean(person.id), name: clean(person.name), firstName: clean(person.firstName), lastName: clean(person.lastName), organization: clean(person.organization), emails: values(person.emails), phones: values(person.phones) }; }
function find(people, id) { for (var index = 0; index < people.length; index++) if (clean(people[index].id) === id) return people[index]; throw new Error('Contact no longer exists.'); }
function run(argv) {
  var input = JSON.parse(argv[0]);
  var contacts = Application('Contacts');
  var people = contacts.people();
  if (input.operation === 'probe') return JSON.stringify({ ok: true, count: people.length });
  if (input.operation === 'list') return JSON.stringify(people.slice(0, 5000).map(record));
  if (input.operation === 'search') { var needle = input.query.toLowerCase(); return JSON.stringify(people.filter(function (person) { var row = record(person); return [row.name, row.organization].concat(row.emails, row.phones).join('\n').toLowerCase().indexOf(needle) !== -1; }).slice(0, 100).map(record)); }
  if (input.operation === 'create') {
    var data = input.contact;
    var person = contacts.Person({ firstName: data.firstName, lastName: data.lastName, organization: data.organization || '' });
    contacts.people.push(person);
    (data.emails || []).forEach(function (value) { person.emails.push(contacts.Email({ label: 'work', value: value })); });
    (data.phones || []).forEach(function (value) { person.phones.push(contacts.Phone({ label: 'mobile', value: value })); });
    contacts.save(); return JSON.stringify(record(person));
  }
  if (input.operation === 'update') {
    var target = find(people, input.contactId), changes = input.changes;
    if (changes.firstName !== undefined) target.firstName.set(changes.firstName);
    if (changes.lastName !== undefined) target.lastName.set(changes.lastName);
    if (changes.organization !== undefined) target.organization.set(changes.organization);
    (changes.addEmails || []).forEach(function (value) { target.emails.push(contacts.Email({ label: 'work', value: value })); });
    (changes.addPhones || []).forEach(function (value) { target.phones.push(contacts.Phone({ label: 'mobile', value: value })); });
    contacts.save(); return JSON.stringify(record(target));
  }
  throw new Error('Unsupported Contacts operation.');
}`;

const MESSAGES_JXA = String.raw`
function value(specifier) { try { var result = specifier(); return result == null ? '' : String(result); } catch (_) { return ''; } }
function run(argv) {
  var input = JSON.parse(argv[0]), messages = Application('Messages'), chats = messages.chats();
  if (input.operation === 'probe') return JSON.stringify({ ok: true, count: chats.length });
  if (input.operation === 'send') {
    var matches = chats.filter(function (chat) { return value(chat.id) === input.threadId; });
    if (matches.length !== 1) throw new Error('The existing Messages thread is unavailable.');
    messages.send(input.text, { to: matches[0] });
    return JSON.stringify({ submitted: true });
  }
  throw new Error('Unsupported Messages operation.');
}`;

function hexText(value: string): string { return Buffer.from(value, 'utf8').toString('hex'); }

function parseJsonOutput(output: string): any {
  const trimmed = output.trim();
  if (!trimmed) return [];
  return JSON.parse(trimmed);
}

function jxaRunner(exec: ExecFileFunction, script: string, payload: unknown): Promise<any> {
  return runFile(exec, '/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, '--', JSON.stringify(payload)]).then(parseJsonOutput);
}

function sqliteRunner(exec: ExecFileFunction, database: string, sql: string): Promise<any[]> {
  return runFile(exec, '/usr/bin/sqlite3', ['-readonly', '-json', database, sql], 5_000).then(result => parseJsonOutput(result) as any[]);
}

export function createDefaultMacConnectorDependencies(options: { execFile?: ExecFileFunction; homeDir?: string; platform?: string; openExternal?: (url: string) => Promise<void>; authority?: MacConnectorDependencies['authority'] } = {}): MacConnectorDependencies {
  const exec = options.execFile ?? execFile;
  const homeDir = options.homeDir ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const messagesDatabase = path.join(homeDir, 'Library', 'Messages', 'chat.db');
  const whatsappDatabases = [path.join(homeDir, 'Library', 'Group Containers', 'group.net.whatsapp.WhatsApp.shared', 'ChatStorage.sqlite')];

  async function contacts(operation: string, payload: Record<string, unknown> = {}) { return jxaRunner(exec, CONTACTS_JXA, { operation, ...payload }); }
  async function messagesAutomation(operation: string, payload: Record<string, unknown> = {}) { return jxaRunner(exec, MESSAGES_JXA, { operation, ...payload }); }
  async function readableDatabase(database: string): Promise<ConnectorState> {
    try { await fs.promises.access(database, fs.constants.R_OK); await sqliteRunner(exec, database, 'SELECT 1 AS ok FROM sqlite_master LIMIT 1;'); return 'available'; }
    catch (error) { if (permissionFailure(error)) return 'permission_required'; return 'unavailable'; }
  }

  const contactAdapter: ContactAdapter = {
    requestAccess: async () => { await contacts('probe'); },
    search: async query => contacts('search', { query }),
    listAll: async () => contacts('list'),
    create: async contact => contacts('create', { contact }),
    update: async (contactId, changes) => contacts('update', { contactId, changes }),
  };

  const messagesAdapter: MessagesAdapter = {
    historyStatus: () => readableDatabase(messagesDatabase),
    requestAutomationAccess: async () => { await messagesAutomation('probe'); },
    listThreads: async query => {
      const needle = hexText(query.toLowerCase());
      const sql = `SELECT c.guid AS id, COALESCE(NULLIF(c.display_name,''), NULLIF(c.chat_identifier,''), 'Messages conversation') AS title, COALESCE((SELECT group_concat(h.id, char(31)) FROM chat_handle_join chj JOIN handle h ON h.ROWID=chj.handle_id WHERE chj.chat_id=c.ROWID),'') AS participants, COALESCE(c.service_name,'') AS service, COALESCE((SELECT m.text FROM chat_message_join cmj JOIN message m ON m.ROWID=cmj.message_id WHERE cmj.chat_id=c.ROWID ORDER BY m.date DESC LIMIT 1),'') AS lastMessage, (SELECT strftime('%Y-%m-%dT%H:%M:%fZ',(CASE WHEN m.date>100000000000 THEN m.date/1000000000.0 ELSE m.date END)+978307200,'unixepoch') FROM chat_message_join cmj JOIN message m ON m.ROWID=cmj.message_id WHERE cmj.chat_id=c.ROWID ORDER BY m.date DESC LIMIT 1) AS lastMessageAt, (SELECT CASE WHEN m.is_from_me=1 THEN 1 ELSE 0 END FROM chat_message_join cmj JOIN message m ON m.ROWID=cmj.message_id WHERE cmj.chat_id=c.ROWID ORDER BY m.date DESC LIMIT 1) AS lastMessageFromMe FROM chat c WHERE (${needle ? `lower(COALESCE(c.display_name,'')||' '||COALESCE(c.chat_identifier,'')||' '||COALESCE((SELECT group_concat(h.id,' ') FROM chat_handle_join chj JOIN handle h ON h.ROWID=chj.handle_id WHERE chj.chat_id=c.ROWID),'')) LIKE '%'||lower(CAST(X'${needle}' AS TEXT))||'%'` : '1=1'}) AND EXISTS(SELECT 1 FROM chat_message_join cmj WHERE cmj.chat_id=c.ROWID) ORDER BY (SELECT max(m.date) FROM chat_message_join cmj JOIN message m ON m.ROWID=cmj.message_id WHERE cmj.chat_id=c.ROWID) DESC LIMIT 50;`;
      const rows = await sqliteRunner(exec, messagesDatabase, sql);
      return rows.map(row => ({ ...row, participants: String(row.participants || '').split('\u001f').filter(Boolean), lastMessageFromMe: row.lastMessageFromMe === 1 }));
    },
    readThread: async threadId => {
      const encoded = hexText(threadId);
      const threadRows = await sqliteRunner(exec, messagesDatabase, `SELECT c.guid AS id, COALESCE(NULLIF(c.display_name,''),NULLIF(c.chat_identifier,''),'Messages conversation') AS title, COALESCE((SELECT group_concat(h.id,char(31)) FROM chat_handle_join chj JOIN handle h ON h.ROWID=chj.handle_id WHERE chj.chat_id=c.ROWID),'') AS participants, COALESCE(c.service_name,'') AS service, '' AS lastMessage, NULL AS lastMessageAt, NULL AS lastMessageFromMe FROM chat c WHERE c.guid=CAST(X'${encoded}' AS TEXT) LIMIT 1;`);
      if (threadRows.length !== 1) throw new Error('Messages thread was not found.');
      const messageRows = await sqliteRunner(exec, messagesDatabase, `SELECT m.guid AS id, COALESCE(m.text,'') AS text, COALESCE(h.id,'') AS sender, CASE WHEN m.is_from_me=1 THEN 1 ELSE 0 END AS fromMe, strftime('%Y-%m-%dT%H:%M:%fZ',(CASE WHEN m.date>100000000000 THEN m.date/1000000000.0 ELSE m.date END)+978307200,'unixepoch') AS sentAt FROM chat_message_join cmj JOIN message m ON m.ROWID=cmj.message_id JOIN chat c ON c.ROWID=cmj.chat_id LEFT JOIN handle h ON h.ROWID=m.handle_id WHERE c.guid=CAST(X'${encoded}' AS TEXT) ORDER BY m.date DESC LIMIT 100;`);
      const row = threadRows[0];
      return { thread: { ...row, participants: String(row.participants || '').split('\u001f').filter(Boolean) }, messages: messageRows.reverse().map(item => ({ ...item, fromMe: item.fromMe === 1 })) };
    },
    sendExistingThread: async (threadId, text) => { await messagesAutomation('send', { threadId, text }); },
  };

  async function whatsappDatabase(): Promise<string | null> {
    for (const database of whatsappDatabases) if (await readableDatabase(database) === 'available') return database;
    return null;
  }

  async function requireWhatsAppDatabase(): Promise<string> {
    const database = await whatsappDatabase();
    if (!database) throw new Error('A supported WhatsApp store is unavailable.');
    const columns = await sqliteRunner(exec, database, "SELECT m.name AS messageColumn, s.name AS sessionColumn FROM pragma_table_info('ZWAMESSAGE') m CROSS JOIN pragma_table_info('ZWACHATSESSION') s WHERE m.name IN ('Z_PK','ZTEXT','ZMESSAGEDATE','ZISFROMME','ZFROMJID','ZCHATSESSION') AND s.name IN ('Z_PK','ZCONTACTJID','ZPARTNERNAME');");
    const names = new Set(columns.flatMap(row => [row.messageColumn, row.sessionColumn]));
    for (const required of ['Z_PK','ZTEXT','ZMESSAGEDATE','ZISFROMME','ZFROMJID','ZCHATSESSION','ZCONTACTJID','ZPARTNERNAME']) if (!names.has(required)) throw new Error('This WhatsApp database version is not supported.');
    return database;
  }

  const whatsappObservationSelect = "SELECT CAST(m.Z_PK AS TEXT) AS id, CAST(s.Z_PK AS TEXT) AS threadId, COALESCE(s.ZCONTACTJID,'') AS threadJid, COALESCE(NULLIF(s.ZPARTNERNAME,''),NULLIF(s.ZCONTACTJID,''),'WhatsApp conversation') AS threadTitle, COALESCE(m.ZFROMJID,'') AS sender, COALESCE(m.ZTEXT,'') AS text, CASE WHEN m.ZISFROMME=1 THEN 1 ELSE 0 END AS fromMe, strftime('%Y-%m-%dT%H:%M:%fZ',m.ZMESSAGEDATE+978307200,'unixepoch') AS sentAt FROM ZWAMESSAGE m JOIN ZWACHATSESSION s ON s.Z_PK=m.ZCHATSESSION";
  const normalizedWhatsAppRows = (rows: any[]): WhatsAppObservation[] => rows.map(row => ({ ...row, fromMe: row.fromMe === 1 }));

  const whatsappAdapter: WhatsAppAdapter = {
    status: async () => {
      for (const database of whatsappDatabases) {
        const state = await readableDatabase(database);
        if (state === 'available') {
          const tables = await sqliteRunner(exec, database, "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ZWAMESSAGE','ZWACHATSESSION') ORDER BY name;");
          return tables.length === 2 ? 'available' : 'unavailable';
        }
        if (state === 'permission_required') return state;
      }
      return 'unavailable';
    },
    search: async query => {
      const database = await requireWhatsAppDatabase();
      const needle = hexText(query.toLowerCase());
      const sql = `${whatsappObservationSelect} WHERE lower(COALESCE(m.ZTEXT,'')||' '||COALESCE(s.ZPARTNERNAME,'')||' '||COALESCE(s.ZCONTACTJID,'')) LIKE '%'||lower(CAST(X'${needle}' AS TEXT))||'%' ORDER BY m.ZMESSAGEDATE DESC LIMIT 100;`;
      return normalizedWhatsAppRows(await sqliteRunner(exec, database, sql));
    },
    readConversation: async jid => {
      const database = await requireWhatsAppDatabase();
      const encoded = hexText(jid);
      const sessions = await sqliteRunner(exec, database, `SELECT CAST(s.Z_PK AS TEXT) AS threadId, COALESCE(s.ZCONTACTJID,'') AS jid, COALESCE(NULLIF(s.ZPARTNERNAME,''),NULLIF(s.ZCONTACTJID,''),'WhatsApp conversation') AS label FROM ZWACHATSESSION s WHERE s.ZCONTACTJID=CAST(X'${encoded}' AS TEXT) LIMIT 2;`);
      if (sessions.length === 0) throw new Error('The selected WhatsApp conversation is no longer available. Select it again.');
      if (sessions.length !== 1) throw new Error('The selected WhatsApp conversation identifier is ambiguous. Select a different conversation.');
      const conversation = { jid: String(sessions[0].jid || ''), label: String(sessions[0].label || jid) };
      if (conversation.jid !== jid) throw new Error('The selected WhatsApp conversation identity changed. Select it again.');
      const rows = await sqliteRunner(exec, database, `${whatsappObservationSelect} WHERE s.ZCONTACTJID=CAST(X'${encoded}' AS TEXT) ORDER BY m.ZMESSAGEDATE DESC LIMIT 100;`);
      return { conversation, observations: normalizedWhatsAppRows(rows) };
    },
  };

  return {
    platform,
    contacts: contactAdapter,
    messages: messagesAdapter,
    whatsapp: whatsappAdapter,
    authority: options.authority ?? {
      verify: async () => { throw new MacConnectorAuthorityError('Current server authorization is unavailable. No external write was started.'); },
      claim: async () => { throw new MacConnectorAuthorityError('The native-write server claim is unavailable. No external write was started.'); },
      assert: async () => { throw new MacConnectorAuthorityError('The native-write server claim is unavailable. No external write was started.'); },
      finalize: async () => { throw new MacConnectorAuthorityError('The native-write server receipt is unavailable.'); },
      reconcile: async () => { throw new MacConnectorAuthorityError('The native-write server receipt is unavailable.'); },
    },
    openExternal: options.openExternal ?? (async () => { throw new Error('System compose handoff is unavailable.'); }),
    now: () => Date.now(),
    randomId: () => randomUUID(),
  };
}
