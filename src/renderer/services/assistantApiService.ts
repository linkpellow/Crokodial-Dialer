import { authenticatedFetch, getStoredUser } from './dialerApiService';
import { parseConnectionRequired, type AssistantConnectionRequired } from './assistantConnections';
import type { WorkspaceMessage } from './assistantWorkspaceTypes';

const API_BASE = (import.meta.env.VITE_API_BASE ?? '').replace(/\/$/, '');
export const platformUrl = (path: string) => `${API_BASE}${path}`;
export interface AssistantAgent { id: number; name: string; role: 'sales' | 'customer_service' | 'personal_assistant' }
export interface InsurancePlan { id: string; name: string; variants: Array<{ id: string; name: string; network?: string }> }
export interface AssistantReply {
  success?: boolean; message?: string; reply?: string; error?: string; model?: string;
  grounding?: { citations?: string[] };
  citations?: Array<{ tool?: string; planId?: string; detail?: string }>;
  proposedActions?: Array<{ name: string }>;
  confirmedOutcomes?: Array<{ actionId: string; state: string }>;
  goal?: { id: string; status: string };
  connectionRequired?: AssistantConnectionRequired;
}

export interface AssistantPendingConnection {
  id: string; originalRequest: string; connectionRequired: AssistantConnectionRequired;
  state: 'waiting_connection' | 'ready' | 'account_changed'; createdAt: number;
}
function pendingConnections(value: unknown): AssistantPendingConnection[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw new Error('Saved connection requests could not be read.');
  return value.map(item => {
    const connectionRequired = parseConnectionRequired(item?.connectionRequired);
    if (!item || !uuid.test(item.id) || typeof item.originalRequest !== 'string' || !item.originalRequest.trim() || item.originalRequest.length > 15000 || !connectionRequired ||
      !['waiting_connection','ready','account_changed'].includes(item.state) || !Number.isFinite(item.createdAt)) throw new Error('Saved connection requests could not be read.');
    return { id: item.id, originalRequest: item.originalRequest, connectionRequired, state: item.state, createdAt: item.createdAt };
  });
}

export interface AssistantIntelligenceStatus { environment: 'sandbox' | 'production'; memoryEnabled: boolean; planningEnabled: boolean; memoryMode: string }

export class AssistantApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = 'AssistantApiError';
  }
}

export async function apiRequest<T>(path: string, options?: RequestInit): Promise<T> {
  if (!API_BASE) throw new Error('Crokodial connection is not configured. Set VITE_API_BASE and rebuild.');
  if (!path.startsWith('/api/') || path.includes('\\') || new URL(platformUrl(path)).origin !== new URL(API_BASE).origin) throw new Error('Request is outside the configured Crokodial API.');
  const owner = getStoredUser();
  const response = await authenticatedFetch(platformUrl(path), {
    ...options,
    headers: { 'x-crokodial-contract-version': '2026-02-26.1', ...options?.headers },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new AssistantApiError(body?.error?.message ?? body?.message ?? `Crokodial request failed (${response.status}).`, response.status, body?.error?.code);
  const current = getStoredUser();
  if (owner?.id !== current?.id || owner?.tenant_id !== current?.tenant_id) throw new Error('The signed-in account changed. Reopen the conversation.');
  if (body === null) throw new Error('Crokodial returned an invalid response.');
  return (body?.data ?? body) as T;
}
const request = apiRequest;

export async function listPersonalAssistants(): Promise<AssistantAgent[]> {
  const agents = await request<AssistantAgent[]>('/api/ai-agents');
  return agents.filter(agent => agent.role === 'personal_assistant');
}
export async function listInsurancePlans(): Promise<InsurancePlan[]> {
  return (await request<{ plans: InsurancePlan[] }>('/api/insurance-plans')).plans;
}
type OwnerConversationBinding = { environment: AssistantIntelligenceStatus['environment']; conversationKey: string };
const ownerConversations = new Map<string, OwnerConversationBinding>();
type UnresolvedRequest = { requestId: string; messageHash: string; conversationKey: string; createdAt: number };
const MAX_UNRESOLVED_REQUESTS = 100;
const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
function readUnresolvedRequests(key: string): UnresolvedRequest[] {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length > MAX_UNRESOLVED_REQUESTS || parsed.some(item =>
      !item || typeof item !== 'object' || !uuid.test(item.requestId) || !/^[a-f0-9]{64}$/.test(item.messageHash) ||
      typeof item.conversationKey !== 'string' || !item.conversationKey || item.conversationKey.length > 100 ||
      !Number.isSafeInteger(item.createdAt) || item.createdAt <= 0 ||
      Object.keys(item).some(field => !['requestId', 'messageHash', 'conversationKey', 'createdAt'].includes(field)))) throw new Error();
    return parsed as UnresolvedRequest[];
  } catch { throw new Error('The assistant could not read its pending request receipts. No message was sent. Restore local storage before retrying.'); }
}
function saveUnresolvedRequests(key: string, records: UnresolvedRequest[]): void {
  try {
    const value = JSON.stringify(records);
    localStorage.setItem(key, value);
    if (localStorage.getItem(key) !== value) throw new Error();
  } catch { throw new Error('The assistant could not preserve this request for safe retries. No new message was sent. Restore local storage before retrying.'); }
}
function migrateUnresolvedConversation(ownerKey:string,environment:AssistantIntelligenceStatus['environment'],legacy:string|null,canonical:string):void {
  if(!legacy||legacy===canonical)return;
  const journalKey=`${ownerKey}:unresolved:${environment}`,records=readUnresolvedRequests(journalKey);
  if(records.some(item=>item.conversationKey===legacy))saveUnresolvedRequests(journalKey,records.map(item=>item.conversationKey===legacy?{...item,conversationKey:canonical}:item));
}
async function ownerRequestIdentity(agentId: number, sessionId: string, message: string) {
  const ownerKey = conversationStorageKey(agentId), binding = ownerConversations.get(`${ownerKey}:${sessionId}`);
  if (!binding) throw new Error('Reopen this assistant conversation before continuing.');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message));
  if (conversationStorageKey(agentId) !== ownerKey) throw new Error('The signed-in account changed. Reopen the conversation.');
  const messageHash = Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
  const journalKey = `${ownerKey}:unresolved:${binding.environment}`, records = readUnresolvedRequests(journalKey);
  const previous = records.find(item => item.conversationKey === binding.conversationKey && item.messageHash === messageHash);
  if (previous) return { journalKey, ownerKey, record: previous, retry: true };
  // The authoritative server request ledger has no time-based expiry. Never
  // age out an uncertain identity and silently turn a retry into a new action.
  // Only opaque receipt metadata survives memory-mode changes and app restart.
  if (records.length >= MAX_UNRESOLVED_REQUESTS) throw new Error('Too many assistant requests have unresolved outcomes. Review their saved action receipts before sending more messages.');
  const record = { requestId: crypto.randomUUID(), messageHash, conversationKey: binding.conversationKey, createdAt: Date.now() };
  saveUnresolvedRequests(journalKey, [...records, record]);
  return { journalKey, ownerKey, record, retry: false };
}
const routeKey = (agentId: number, sessionId: string) => `${conversationStorageKey(agentId)}:${sessionId}`;
function ownerConversation(agentId: number, sessionId: string): OwnerConversationBinding {
  const binding = ownerConversations.get(routeKey(agentId, sessionId));
  if (!binding) throw new Error('Reopen this assistant conversation before continuing.');
  return binding;
}
export async function startAssistantSession(agentId: number): Promise<string> {
  const ownerKey = conversationStorageKey(agentId);
  const status = await readAssistantSessionSettings(agentId);
  if (conversationStorageKey(agentId) !== ownerKey) throw new Error('The signed-in account changed. Reopen the conversation.');
  const legacyConversationKey = legacyAssistantConversationKey(agentId);
  const result = await request<{ sessionId: string; conversationKey: string }>(`/api/ai-agents/${agentId}/conversation/session`, { method: 'POST', body: '{}' });
  if (!result.sessionId) throw new Error('Crokodial did not create a conversation.');
  // Never associate an earlier account's in-flight creation with a new sign-in.
  if (conversationStorageKey(agentId) !== ownerKey) throw new Error('The signed-in account changed. Reopen the conversation.');
  const conversationKey=result.conversationKey;
  if(typeof conversationKey!=='string'||!conversationKey||conversationKey.length>100)throw new Error('Crokodial did not identify the main conversation.');
  migrateUnresolvedConversation(ownerKey,status.environment,legacyConversationKey,conversationKey);
  clearLegacyAssistantConversationKey(agentId);
  ownerConversations.set(`${ownerKey}:${result.sessionId}`, { environment: status.environment, conversationKey });
  return result.sessionId;
}
function conversationStorageKey(agentId: number): string {
  const user = getStoredUser();
  if (!user || !Number.isSafeInteger(user.id) || !Number.isSafeInteger(user.tenant_id) || user.id <= 0 || user.tenant_id! <= 0) throw new Error('Sign in to restore this conversation.');
  return `crokodial_assistant_conversation:${API_BASE}:${user.tenant_id}:${user.id}:${agentId}`;
}
/** Read an obsolete client-generated key only to migrate retry receipt metadata. */
function legacyAssistantConversationKey(agentId: number): string | null {
  const storageKey = conversationStorageKey(agentId);
  const saved = sessionStorage.getItem(storageKey) ?? localStorage.getItem(storageKey);
  if (saved && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(saved)) return saved;
  return null;
}
function clearLegacyAssistantConversationKey(agentId: number): void { const key = conversationStorageKey(agentId); localStorage.removeItem(key); sessionStorage.removeItem(key); }
export function assistantSessionUsesOwnerContext(agentId: number, sessionId: string): boolean {
  ownerConversation(agentId, sessionId);
  return true;
}
/** Restore the server-selected main conversation's transcript. */
export async function readAssistantConversation(agentId: number, sessionId: string, before?:number): Promise<{ sessionId: string; messages: WorkspaceMessage[]; pendingConnections: AssistantPendingConnection[];hasMore:boolean;nextBefore?:number }> {
  ownerConversation(agentId, sessionId);
  const query=before===undefined?'':`?before=${encodeURIComponent(String(before))}&limit=200`;
  const value = await request<{ sessionId: string; messages: WorkspaceMessage[]; pendingConnections?: AssistantPendingConnection[];hasMore?:boolean;nextBefore?:number }>(`/api/ai-agents/${agentId}/conversation/session/${encodeURIComponent(sessionId)}${query}`);
  if (value?.sessionId !== sessionId || !Array.isArray(value.messages) || value.messages.some(message =>
    !message || typeof message.id !== 'string' || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || !Number.isFinite(message.createdAt) || !Number.isSafeInteger(message.sequence) || message.sequence<=0) || typeof value.hasMore!=='boolean' || value.nextBefore!==undefined&&(!Number.isSafeInteger(value.nextBefore)||value.nextBefore<=0)) throw new Error('The saved conversation could not be read.');
  return { ...value,hasMore:value.hasMore, pendingConnections: pendingConnections(value.pendingConnections) };
}
export async function sendAssistantMessage(agentId: number, sessionId: string, message: string, workspacePlanHistory: string[] = [], onRequest?: (requestId: string) => void): Promise<AssistantReply> {
  ownerConversation(agentId, sessionId);
  const identity = await ownerRequestIdentity(agentId, sessionId, message);
  onRequest?.(identity.record.requestId);
  const result = await request<AssistantReply>(`/api/ai-agents/${agentId}/conversation/message`, {
    method: 'POST', body: JSON.stringify({ sessionId, message, workspacePlanHistory,
      requestId: identity.record.requestId }),
  });
  if (conversationStorageKey(agentId) !== identity.ownerKey) throw new Error('The signed-in account changed. Reopen the conversation to review its original request.');
  if (result?.success !== true || typeof result.message !== 'string' || !result.message.trim()) throw new Error(result?.error || 'The assistant could not produce a response.');
  return acceptOwnerReply(result, identity);
}
function acceptOwnerReply(result: AssistantReply, identity: Awaited<ReturnType<typeof ownerRequestIdentity>> | undefined): AssistantReply {
  const connectionRequired = parseConnectionRequired(result.connectionRequired);
  if (connectionRequired) result.connectionRequired = connectionRequired;
  const outcomes = Array.isArray(result.confirmedOutcomes) ? result.confirmedOutcomes : undefined;
  const outcomesValid = result.confirmedOutcomes === undefined || outcomes !== undefined && outcomes.every(item =>
    item && typeof item.actionId === 'string' && uuid.test(item.actionId) && ['pending','ready','executing','submitted','succeeded','failed','rejected','expired','unknown'].includes(item.state));
  const goalValid = result.goal === undefined || result.goal && typeof result.goal.id === 'string' && uuid.test(result.goal.id) && ['queued','running','waiting_input','waiting_approval','completed','failed','canceled','budget_exhausted','unknown'].includes(result.goal.status);
  const uncertain = !outcomesValid || !goalValid || outcomes?.some(item => ['unknown','executing','ready'].includes(item.state)) || result.goal && ['unknown','queued','running'].includes(result.goal.status);
  // An interrupted retry with no verifiable receipt may be the server's
  // "accepted, outcome unverified" response. Retain its UUID conservatively.
  if (identity && !uncertain && (!identity.retry || outcomes?.length || result.goal)) {
    try { saveUnresolvedRequests(identity.journalKey, readUnresolvedRequests(identity.journalKey).filter(item => item.requestId !== identity.record.requestId)); }
    catch { /* The acknowledged response is still useful; retaining its key is safe. */ }
  }
  return result;
}
/** Resume only the server's saved prerequisite. Reconnection itself never executes this call. */
export async function resumeAssistantConnection(agentId: number, sessionId: string, continuationId: string, onRequest?: (requestId: string) => void): Promise<AssistantReply> {
  ownerConversation(agentId, sessionId);
  if (!uuid.test(continuationId)) throw new Error('Reopen the saved connection request.');
  const identity = await ownerRequestIdentity(agentId, sessionId, `resume-connection:${continuationId}`);
  onRequest?.(identity.record.requestId);
  const result = await request<AssistantReply>(`/api/ai-agents/${agentId}/conversation/session/${encodeURIComponent(sessionId)}/connections/${continuationId}/resume`, { method: 'POST', body: JSON.stringify({ requestId: identity.record.requestId }) });
  if (conversationStorageKey(agentId) !== identity.ownerKey) throw new Error('The signed-in account changed. Reopen the conversation.');
  if (result?.success !== true || typeof result.message !== 'string' || !result.message.trim()) throw new Error(result?.error || 'The saved request could not be resumed.');
  return acceptOwnerReply(result, identity);
}
export async function cancelAssistantConnection(agentId: number, sessionId: string, continuationId: string): Promise<void> {
  ownerConversation(agentId, sessionId);
  if (!uuid.test(continuationId)) throw new Error('Reopen the saved connection request.');
  await request(`/api/ai-agents/${agentId}/conversation/session/${encodeURIComponent(sessionId)}/connections/${continuationId}`, { method: 'DELETE' });
}
export async function openPlatform(path: '/plans' | '/ai-assistants'): Promise<void> {
  if (!API_BASE) throw new Error('Crokodial connection is not configured.');
  if (window.dialer?.openExternal) await window.dialer.openExternal(platformUrl(path));
  else window.open(platformUrl(path), '_blank', 'noopener,noreferrer');
}
export interface PlanConfiguration {
  instructions: string;
  announcements: Array<{ id: string; title: string; body: string; active: boolean; effectiveFrom: string | null; expiresAt: string | null; affectedEffectiveFrom: string | null; affectedEffectiveTo: string | null }>;
  supportContacts: Array<{ id: string; label: string; email: string; purpose: string }>;
  documents: Array<{ id: number; filename: string; status: string }>;
}
export async function getPlanConfiguration(planId: string): Promise<PlanConfiguration> {
  return request(`/api/insurance-plans/${encodeURIComponent(planId)}`);
}

/** Memory lifetime is server-owned; no extra user interface is required. */
export async function readAssistantSessionSettings(agentId: number): Promise<AssistantIntelligenceStatus> {
  const result = await request<AssistantIntelligenceStatus>(`/api/ai-agents/${agentId}/intelligence/status`);
  if (!result || !['sandbox', 'production'].includes(result.environment) || typeof result.memoryEnabled !== 'boolean' || typeof result.planningEnabled !== 'boolean' || !['none', 'session', 'conversation', 'persistent'].includes(result.memoryMode)) throw new Error('Assistant context settings are unavailable.');
  return result;
}
