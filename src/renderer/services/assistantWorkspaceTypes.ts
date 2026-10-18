/** Native wire contracts for the supporting platform assistant endpoints.
 * Source: private-sms-app/packages/shared/src/config. Keep behavior and limits aligned.
 * No platform renderer or runtime dependency is imported into this native application. */


export type AssistantActionKind = 'message.sms' | 'message.email' | 'notes.append' | 'preference.update' | 'quote.generate' | 'quote.sms' | 'quote.email' | 'lead.immediate_call' | 'appointment.reschedule' | 'appointment.cancel' | 'appointment.book' | 'appointment.no_show' | 'appointment.exception';
export type AssistantActionState = 'pending' | 'ready' | 'executing' | 'succeeded' | 'submitted' | 'failed' | 'unknown' | 'rejected' | 'expired';
export interface AssistantActionRecord {
  id: string;
  agentId: number;
  kind: AssistantActionKind;
  state: AssistantActionState;
  summary: string;
  result: { message: string; messageId?: number; providerMessageId?:string; quoteOutcome?: { low: number; high: number; message: string } } | null;
  createdAt: number;
  expiresAt: number;
}


export type AssistantWorkspaceKind = 'action' | 'artifact' | 'background' | 'email' | 'followup' | 'screenshot';
export interface AssistantWorkspaceItem {
  id: string;
  entityId: string;
  kind: AssistantWorkspaceKind;
  title: string;
  detail: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  action?: AssistantActionRecord;
}
export interface AssistantWorkspaceActivity { items: AssistantWorkspaceItem[]; }
export interface AssistantWorkspaceMessage {
  sequence: number; id: string; role: 'user' | 'assistant'; content: string; createdAt: number; requestId?: string;
}

export const EMAIL_ATTACHMENT_MAX_COUNT = 10;
export const EMAIL_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const EMAIL_ATTACHMENTS_MAX_BYTES = 15 * 1024 * 1024;
export type EmailRecipientInput = { contactId: number } | { email: string; name?: string } | { supportContact: { planId: string; id: string } };
export interface EmailResolvedRecipient { email: string; name?: string; source: 'contact' | 'support_contact' | 'owner_provided'; contactId?: number; supportContact?: { planId: string; id: string } }
export interface EmailRecipients { to: EmailResolvedRecipient[]; cc: EmailResolvedRecipient[]; bcc: EmailResolvedRecipient[] }
export interface EmailDraftAttachment { name: string; contentType: 'application/pdf' | 'image/png' | 'image/jpeg' | 'text/plain'; base64: string; }
export interface EmailTemplateSummary { id: string; title: string; version: number; subject: string; fields: string[]; attachmentNames: string[]; updatedAt: number }
export interface EmailTemplateDetail extends EmailTemplateSummary { text: string; html: string; attachments: EmailDraftAttachment[] }
export interface EmailDraftInput { contactId?: number; template?: { id: string; version: number; values?: Record<string, string> }; to?: EmailRecipientInput[]; cc?: EmailRecipientInput[]; bcc?: EmailRecipientInput[]; subject: string; text: string; html: string; attachments: EmailDraftAttachment[]; replyThreadId?: string; replySource?: 'linked_contact' | 'mailbox'; artifact?: { id: string; version: number }; }
export interface EmailDraftDetail {
  id: string; contactId: number | null; email: string; recipients?: EmailRecipients; correctionOf?: { id: string; revision: number; contentHash: string }; revision: number; contentHash: string; subject: string; text: string; html: string;
  attachments: Array<EmailDraftAttachment & { sha256: string; byteSize: number }>;
  replyThreadId?: string; replySource?: 'linked_contact' | 'mailbox'; artifact?: { id: string; version: number }; mailbox: { provider: 'gmail'; generation: string; sender: string };
  status: 'draft' | 'submitting' | 'submitted' | 'unknown' | 'failed'; action: AssistantActionRecord | null; createdAt: number; updatedAt: number;
}
export type EmailDraftSummary = Pick<EmailDraftDetail, 'id' | 'contactId' | 'email' | 'recipients' | 'correctionOf' | 'revision' | 'contentHash' | 'subject' | 'status' | 'createdAt' | 'updatedAt'> & { action: AssistantActionRecord | null };
/** Scripts, navigation, forms and external resources have no preview grant. */
export function emailDraftPreview(html: string): string {
  // A sandboxed srcdoc can still expose clickable links to its embedder. The
  // review surface is intentionally inert: destinations remain visible as
  // text in the message, but reviewing can never navigate or open a URL.
  const inertHtml = html.replace(/\s+href\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; navigate-to 'none'"><meta name="referrer" content="no-referrer"><body>${inertHtml}</body>`;
}

export type ConditionalFollowUpStatus = 'pending' | 'scheduled' | 'paused' | 'checking' | 'submitting' | 'submitted' | 'suppressed' | 'canceled' | 'unknown';
export interface ConditionalFollowUp {
  id: string; draftId: string; revision: number; contentHash: string; contactId: number; email: string; subject: string;
  dueAt: number; status: ConditionalFollowUpStatus; reason: string | null; createdAt: number; updatedAt: number;
  approvedAt: number | null; approvalExpiresAt: number; providerMessageId: string | null;
}
export interface ConditionalFollowUpExclusion { contactId: number; reason: string; updatedAt: number }
export const conditionalFollowUpConditions = 'Send this exact email once, only if there is no new reply in the linked Gmail thread or CRM, no active booking, no client membership, and no opt-out or exclusion. Unavailable evidence or a delay over 15 minutes suppresses the send.';

/** Artifacts are untrusted documents, never application code or tool authority. */
export const ASSISTANT_ARTIFACT_MAX_BYTES = 128 * 1024;
export const ASSISTANT_ARTIFACT_MAX_COUNT = 50;
export const ASSISTANT_ARTIFACT_MAX_VERSIONS = 100;
export const ASSISTANT_ARTIFACT_STORAGE_BYTES = 10 * 1024 * 1024;
export interface AssistantArtifact {
  id: string; title: string; currentVersion: number; createdAt: number; updatedAt: number;
}
export interface AssistantArtifactVersion {
  version: number; html: string; sha256: string; byteSize: number; createdAt: number;
  source: 'import' | 'edit' | 'template' | 'generated'; request: string | null;
  validation: 'unverified';
}
export interface AssistantArtifactDetail {
  artifact: AssistantArtifact; version: AssistantArtifactVersion;
  versions: Array<Omit<AssistantArtifactVersion, 'html' | 'request'>>;
}
/** No same-origin, popup, navigation, form, download, storage or native bridge grant. */
export const ASSISTANT_ARTIFACT_SANDBOX = 'allow-scripts';
export const ASSISTANT_ARTIFACT_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
export function assistantArtifactPreview(html: string): string {
  // The trusted policy precedes all untrusted content. Additional meta policies
  // can only restrict it. Isolation depends on the iframe sandbox as well.
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${ASSISTANT_ARTIFACT_CSP}"><meta name="referrer" content="no-referrer"></head><body>${html}</body></html>`;
}

export const SCREENSHOT_FIELDS = ['planName', 'monthlyPremium', 'effectiveDate', 'memberId'] as const;
export type ScreenshotField = typeof SCREENSHOT_FIELDS[number];
export const SCREENSHOT_FIELD_LABELS: Record<ScreenshotField, string> = { planName: 'Plan name', monthlyPremium: 'Monthly premium', effectiveDate: 'Effective date', memberId: 'Member / policy ID' };
export type ScreenshotFields = Partial<Record<ScreenshotField, string>>;
export interface ScreenshotClient { id: number; name: string; email: string | null; phone: string | null }
export interface ScreenshotChange { field: ScreenshotField; current: string | null; proposed: string; conflict: boolean; existingValues: string[] }
export interface ScreenshotPreview { digest: string; client: ScreenshotClient; fields: ScreenshotFields; changes: ScreenshotChange[] }
export interface ScreenshotReceipt { clientId: number; clientName: string; appliedAt: number; changedFields: ScreenshotField[]; keptFields: ScreenshotField[]; values: ScreenshotFields; sourceSha256: string; destination: 'crokodial_crm' }
export interface ScreenshotRecordSummary { id: string; filename: string; state: 'extracting' | 'review' | 'applied'; createdAt: number; updatedAt: number; clientName: string | null; receipt: ScreenshotReceipt | null }
export interface ScreenshotRecord extends ScreenshotRecordSummary { text: string; extractionError: string | null; fields: ScreenshotFields; identity: { name?: string; email?: string; phone?: string }; preview: ScreenshotPreview | null }

export interface CalendarReadArguments { start: string; end: string }
export type AssistantToolRequest = { tool: 'calendar.google.read'; requestId: string; args: CalendarReadArguments } | { tool: 'crm.notes.append'; requestId: string; args: { contactId: number; note: string } };
export interface AssistantToolCapability {
  id: 'calendar.google.read' | 'crm.notes.append' | 'gmail.read' | 'browser.control';
  name: string;
  effect: 'read' | 'write';
  available: boolean;
  reason: string;
  approval: 'per_request' | 'unavailable';
}
export interface CalendarToolResult {
  events: Array<{ id: string; title: string; start: string; end: string; allDay: boolean; status: string }>;
  total: number;
  truncated: boolean;
  observedAt: number;
}
export interface AssistantToolGrant {
  id: string;
  tool: 'calendar.google.read';
  revision: number;
  payloadDigest: string;
  destination: string;
  args: CalendarReadArguments;
  state: 'pending' | 'approved' | 'rejected' | 'executing' | 'succeeded' | 'failed' | 'unknown' | 'expired';
  createdAt: number;
  expiresAt: number;
  result: CalendarToolResult | null;
  message: string | null;
}
export type AssistantPreparedTool = { kind: 'grant'; grant: AssistantToolGrant } | { kind: 'action'; action: AssistantActionRecord };


/** Trigger identity and ownership are established by the authenticated server. */
export type AssistantBackgroundTrigger =
  | { kind: 'once'; at: number }
  | { kind: 'daily'; localTime: string; timeZone: string }
  | { kind: 'event'; eventKey: string };
export type AssistantBackgroundTaskStatus = 'active' | 'paused' | 'canceled' | 'completed' | 'budget_exhausted';
export type AssistantBackgroundRunStatus = AssistantGoalStatus | 'waiting_device' | 'waiting_configuration' | 'waiting_recovery';
export interface AssistantBackgroundTaskInput {
  requestId: string;
  objective: string;
  contactId?: number;
  trigger: AssistantBackgroundTrigger;
  maxRuns: number;
  runBudgetMicros: number;
  totalBudgetMicros: number;
  notificationPolicy: 'meaningful' | 'none';
}
export interface AssistantBackgroundRun {
  id: string;
  taskId: string;
  goalId: string | null;
  status: AssistantBackgroundRunStatus;
  dueAt: number;
  retryAt: number | null;
  offlineAttempts: number;
  spentMicros: number;
  reservedMicros: number;
  message: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface AssistantBackgroundTask {
  id: string;
  agentId: number;
  objective: string;
  contactId: number | null;
  trigger: AssistantBackgroundTrigger;
  status: AssistantBackgroundTaskStatus;
  nextDueAt: number | null;
  maxRuns: number;
  runCount: number;
  runBudgetMicros: number;
  totalBudgetMicros: number;
  committedMicros: number;
  spentMicros: number;
  notificationPolicy: 'meaningful' | 'none';
  latestRun: AssistantBackgroundRun | null;
  createdAt: number;
  updatedAt: number;
}
export interface AssistantBackgroundNotification {
  id: number;
  taskId: string;
  runId: string;
  status: AssistantBackgroundRunStatus;
  message: string;
  createdAt: number;
  readAt: number | null;
}

export interface AiQualificationReport {
  observedAt:number;
  routingEnabled:boolean;
  routingMode:'automatic'|'explicit';
  registryStatus:'loaded'|'missing-or-invalid';
  task:string;
  channel:string;
  admissionRequired:true;
  profiles:Array<{
    id:string;modelId:string;provider:string;task:string;channel:string;economics:string;
    candidate:boolean;reason:string;fresh:boolean;matchesWorkflow:boolean;
    measuredAt:string|null;validUntil:string|null;sampleCount:number|null;minimumSamples:number;
    qualityScore:number|null;baselineCorrectCompletionRate:number;p95LatencyMs:number|null;p95FirstTextMs:number|null;
    costPerSuccessfulTaskMicros:number|null;criticalFailures:number;dataPolicyApproved:boolean;
  }>;
  localDevices:Array<{name:string;online:boolean;ready:boolean;hardwareVerified:boolean;modelCount:number}>;
  limits:{maximumTurnChargeMicros:number;paidDailyLimitMicros:number};
}

export type AssistantGoalStatus = 'queued' | 'running' | 'waiting_input' | 'waiting_approval' | 'completed' | 'failed' | 'canceled' | 'budget_exhausted' | 'unknown';
export type WorkspaceMessage = AssistantWorkspaceMessage;
export type WorkspaceItem = AssistantWorkspaceItem;
export interface AssistantGmailStatus { configured: boolean; connected: boolean; historyConnected: boolean; mailboxReadConnected?: boolean; mailboxAccountId?: string; mailboxEmail?: string; email?: string | null; connectUrl: string; historyConnectUrl: string }
export interface GmailConnection { authorizationUrl: string; expiresAt: string; capabilities?: Array<'send' | 'history' | 'mailbox_read'>; oauthScopes?: string[] }
export interface AiExecutionProgress { sequence: number; requestId: string; turnId: string; state: 'pending' | 'routing' | 'queued' | 'running' | 'fallback' | 'validation' | 'tool' | 'settled' | 'completed' | 'cached' | 'deferred' | 'canceled' | 'failed' | 'unknown'; channel: string; modelId?: string; provider?: string; reason?: string; maximumProviderChargeMicros?: number; actualProviderChargeMicros?: number | null; createdAt: number }
