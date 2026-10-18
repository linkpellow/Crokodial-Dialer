import type { AssistantGmailStatus } from './assistantWorkspaceTypes';

/** These capabilities are server-issued prerequisites, never inferred authorization. */
export type GmailCapability = 'send' | 'history' | 'mailbox_read';
export interface AssistantConnectionRequired {
  provider: 'gmail';
  capabilities: GmailCapability[];
  resumePolicy: 'prepare_only' | 'explicit';
  requestId?: string;
  reason?: string;
}
const capabilities: GmailCapability[] = ['send', 'history', 'mailbox_read'];
export function normalizeGmailCapabilities(required: readonly GmailCapability[]): GmailCapability[] {
  const values = new Set(required);
  if (values.has('mailbox_read')) values.add('history');
  if (values.has('history')) values.add('send');
  return capabilities.filter(capability => values.has(capability));
}
export function parseConnectionRequired(value: unknown): AssistantConnectionRequired | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object') throw new Error('The assistant returned an invalid connection request.');
  const item = value as AssistantConnectionRequired;
  if (item.provider !== 'gmail' || !Array.isArray(item.capabilities) || !item.capabilities.length ||
    item.capabilities.some(capability => !capabilities.includes(capability)) ||
    !['prepare_only', 'explicit'].includes(item.resumePolicy) ||
    item.reason !== undefined && (typeof item.reason !== 'string' || item.reason.length > 2000) ||
    item.requestId !== undefined && (typeof item.requestId !== 'string' || item.requestId.length > 100)) {
    throw new Error('The assistant returned an invalid connection request.');
  }
  return { provider: 'gmail', capabilities: normalizeGmailCapabilities(item.capabilities), resumePolicy: item.resumePolicy,
    ...(item.requestId ? { requestId: item.requestId } : {}), ...(item.reason ? { reason: item.reason } : {}) };
}
export function gmailConnectionReady(status: AssistantGmailStatus | null, required: readonly GmailCapability[]): boolean {
  if (!status?.connected) return false;
  return required.every(capability => capability === 'send' || capability === 'history' && status.historyConnected || capability === 'mailbox_read' && status.mailboxReadConnected === true);
}
export function gmailConnectionLabel(required: readonly GmailCapability[], status: AssistantGmailStatus | null): string {
  if (required.includes('mailbox_read')) return 'Connect Gmail send, search and history';
  if (required.includes('history') && status?.connected) return 'Connect email history';
  return 'Connect Gmail';
}

/** Human-readable mirror of the OAuth scopes shown before opening Google consent. */
export function gmailCapabilityDisclosure(required: readonly GmailCapability[]): string {
  const normalized = normalizeGmailCapabilities(required);
  if (normalized.includes('mailbox_read')) {
    return 'Google consent requests account identity, Gmail send, and Gmail read-only access. Read-only access is used to search the mailbox and read email history; connecting alone never sends a message.';
  }
  if (normalized.includes('history')) {
    return 'Google consent requests account identity, Gmail send, and Gmail read-only access. Read-only access is used for linked email history; connecting alone never sends a message.';
  }
  return 'Google consent requests account identity and Gmail send access. Connecting alone never sends a message.';
}
