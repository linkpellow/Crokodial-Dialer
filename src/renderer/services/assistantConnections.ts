import type { AssistantGmailStatus } from './assistantWorkspaceTypes';

/** These capabilities are server-issued prerequisites, never inferred authorization. */
export type GmailCapability = 'send' | 'history' | 'mailbox_read' | 'modify';
export type GoogleWorkspaceCapability = 'drive_read' | 'sheets_read' | 'sheets_write';
export type GoogleContactsCapability = 'contacts_read' | 'contacts_write';
export type GoogleCalendarCapability = 'calendar_access';
export type CalendlyCapability = 'scheduling_access';
type RequirementBase = { resumePolicy: 'prepare_only' | 'explicit'; requestId?: string; reason?: string };
export type AssistantConnectionRequired =
  | RequirementBase & { provider: 'gmail'; capabilities: GmailCapability[] }
  | RequirementBase & { provider: 'google_workspace'; capabilities: GoogleWorkspaceCapability[] }
  | RequirementBase & { provider: 'google_contacts'; capabilities: GoogleContactsCapability[] }
  | RequirementBase & { provider: 'google_calendar'; capabilities: GoogleCalendarCapability[] }
  | RequirementBase & { provider: 'calendly'; capabilities: CalendlyCapability[] };
export type AssistantConnectionProvider = AssistantConnectionRequired['provider'];

const allowed = {
  gmail: ['send', 'history', 'mailbox_read', 'modify'],
  google_workspace: ['drive_read', 'sheets_read', 'sheets_write'],
  google_contacts: ['contacts_read', 'contacts_write'],
  google_calendar: ['calendar_access'],
  calendly: ['scheduling_access'],
} as const;
const providers = Object.keys(allowed) as AssistantConnectionProvider[];

export function normalizeGmailCapabilities(required: readonly GmailCapability[]): GmailCapability[] {
  const values = new Set(required);
  if (values.has('modify')) values.add('mailbox_read');
  if (values.has('mailbox_read')) values.add('history');
  if (values.has('history')) values.add('send');
  return allowed.gmail.filter(capability => values.has(capability));
}
export function normalizeGoogleWorkspaceCapabilities(required: readonly GoogleWorkspaceCapability[]): GoogleWorkspaceCapability[] {
  const values = new Set(required);
  if (values.has('sheets_write')) values.add('sheets_read');
  return allowed.google_workspace.filter(capability => values.has(capability));
}
export function normalizeGoogleContactsCapabilities(required: readonly GoogleContactsCapability[]): GoogleContactsCapability[] {
  const values = new Set(required);
  if (values.has('contacts_write')) values.add('contacts_read');
  return allowed.google_contacts.filter(capability => values.has(capability));
}

export function parseConnectionRequired(value: unknown): AssistantConnectionRequired | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object') throw new Error('The assistant returned an invalid connection request.');
  const item = value as Record<string, unknown>;
  const provider = item.provider;
  if (typeof provider !== 'string' || !providers.includes(provider as AssistantConnectionProvider)
    || !Array.isArray(item.capabilities) || !item.capabilities.length
    || item.capabilities.some(capability => typeof capability !== 'string' || !(allowed[provider as AssistantConnectionProvider] as readonly string[]).includes(capability))
    || !['prepare_only', 'explicit'].includes(String(item.resumePolicy))
    || item.reason !== undefined && (typeof item.reason !== 'string' || item.reason.length > 2000)
    || item.requestId !== undefined && (typeof item.requestId !== 'string' || item.requestId.length > 100)) {
    throw new Error('The assistant returned an invalid connection request.');
  }
  const capabilities = provider === 'gmail' ? normalizeGmailCapabilities(item.capabilities as GmailCapability[])
    : provider === 'google_workspace' ? normalizeGoogleWorkspaceCapabilities(item.capabilities as GoogleWorkspaceCapability[])
      : provider === 'google_contacts' ? normalizeGoogleContactsCapabilities(item.capabilities as GoogleContactsCapability[])
        : [...new Set(item.capabilities as string[])];
  return { provider, capabilities, resumePolicy: item.resumePolicy,
    ...(item.requestId ? { requestId: item.requestId } : {}), ...(item.reason ? { reason: item.reason } : {}) } as AssistantConnectionRequired;
}

export const connectionProviderLabel = (provider: AssistantConnectionProvider): string => ({
  gmail: 'Gmail', google_workspace: 'Google Workspace', google_contacts: 'Google Contacts',
  google_calendar: 'Google Calendar', calendly: 'Calendly',
})[provider];

export function gmailConnectionReady(status: AssistantGmailStatus | null, required: readonly GmailCapability[]): boolean {
  if (!status?.connected) return false;
  return required.every(capability => capability === 'send' || capability === 'history' && status.historyConnected
    || capability === 'mailbox_read' && status.mailboxReadConnected === true || capability === 'modify' && status.modifyConnected === true);
}
export function gmailConnectionLabel(required: readonly GmailCapability[], status: AssistantGmailStatus | null): string {
  if (required.includes('modify')) return 'Connect reviewed Gmail changes';
  if (required.includes('mailbox_read')) return 'Connect Gmail send, search and history';
  if (required.includes('history') && status?.connected) return 'Connect email history';
  return 'Connect Gmail';
}

/** Human-readable mirror of the OAuth scopes shown before opening Google consent. */
export function gmailCapabilityDisclosure(required: readonly GmailCapability[]): string {
  const normalized = normalizeGmailCapabilities(required);
  if (normalized.includes('modify')) {
    return 'Google consent requests account identity and Gmail modify access. That permission can read and send mail and change thread state; Crokodial uses it only for the exact thread action you review, and connecting alone changes nothing.';
  }
  if (normalized.includes('mailbox_read')) {
    return 'Google consent requests account identity, Gmail send, and Gmail read-only access. Read-only access is used to search the mailbox and read email history; connecting alone never sends a message.';
  }
  if (normalized.includes('history')) {
    return 'Google consent requests account identity, Gmail send, and Gmail read-only access. Read-only access is used for linked email history; connecting alone never sends a message.';
  }
  return 'Google consent requests account identity and Gmail send access. Connecting alone never sends a message.';
}
