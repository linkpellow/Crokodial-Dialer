import { normalizeGmailCapabilities, type GmailCapability } from './assistantConnections';
import { apiRequest, AssistantApiError, platformUrl } from './assistantApiService';
import { getAuthHeaders, getStoredUser, logout } from './dialerApiService';
import type {
  AssistantWorkspaceActivity, AssistantGmailStatus, GmailConnection, AssistantActionRecord,
  EmailDraftInput, EmailDraftDetail, EmailDraftSummary, AssistantArtifact, AssistantArtifactDetail,
  ConditionalFollowUp, ConditionalFollowUpExclusion, ScreenshotRecord, ScreenshotRecordSummary,
  ScreenshotFields, ScreenshotField, ScreenshotClient, AssistantBackgroundTask, AssistantBackgroundTaskInput,
  AssistantBackgroundNotification, AssistantBackgroundRun, AssistantToolCapability, AssistantToolGrant,
  AssistantPreparedTool, AssistantToolRequest, AiQualificationReport, AiExecutionProgress,
} from './assistantWorkspaceTypes';

export * from './assistantWorkspaceTypes';

/** All native workflow calls use the same authenticated, origin-bound transport as the dialer. */
export function workspaceRequest<T>(agentId: number, path: string, body?: unknown, method?: string): Promise<T> {
  if (!Number.isSafeInteger(agentId) || agentId <= 0) throw new Error('Choose an existing Personal Assistant.');
  const pathname = path.split('?')[0];
  if (!pathname.startsWith('/') || pathname.startsWith('//') || path.includes('#') || pathname.includes('\\') || pathname.split('/').includes('..') || /%2e|%2f|%5c/i.test(pathname)) throw new Error('Invalid assistant request path.');
  return apiRequest<T>(`/api/ai-agents/${agentId}${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const id = (value: string) => encodeURIComponent(value);
type Revision = { expectedRevision: number; contentHash: string };
export const listWorkspaceActivity = (agentId: number) => workspaceRequest<AssistantWorkspaceActivity>(agentId, '/conversation/activity');
export const listExecutionProgress = (agentId: number, requestId: string, after = 0) => workspaceRequest<{ events: AiExecutionProgress[] }>(agentId, `/execution/events?requestId=${id(requestId)}&after=${after}`);
export const decideWorkspaceAction = (agentId: number, actionId: string, decision: 'approve' | 'reject') => workspaceRequest<{ action: AssistantActionRecord }>(agentId, `/actions/${id(actionId)}/decision`, { decision });

export async function getGmailStatus(): Promise<AssistantGmailStatus> {
  const value = await apiRequest<AssistantGmailStatus>('/api/auth/google/mail/status');
  if (!value || typeof value.configured !== 'boolean' || typeof value.connected !== 'boolean' || typeof value.historyConnected !== 'boolean') throw new Error('Could not verify the Gmail connection.');
  return value;
}
/** The browser receives a short-lived, one-use ticket; the native bearer never enters its URL. */
export async function beginGmailConnection(requirement: boolean | GmailCapability[] = false): Promise<GmailConnection> {
  const requested = Array.isArray(requirement) ? [...new Set(requirement)] : undefined;
  if (requested && (!requested.length || requested.some(item => !['send', 'history', 'mailbox_read'].includes(item)))) throw new Error('Unknown Gmail connection capability.');
  const capabilities = requested ? normalizeGmailCapabilities(requested) : undefined;
  const history = capabilities ? capabilities.includes('history') || capabilities.includes('mailbox_read') : requirement;
  const value = await apiRequest<GmailConnection>('/api/auth/google/mail/desktop/connect', { method: 'POST', body: JSON.stringify({ history, ...(capabilities ? { capabilities } : {}) }) });
  const origin = new URL(platformUrl('/')), url = new URL(value.authorizationUrl, origin);
  if (url.origin !== origin.origin || url.pathname !== '/api/auth/google/mail/desktop/authorize' || url.username || url.password || url.hash ||
    !url.searchParams.get('ticket') || [...url.searchParams.keys()].some(key => key !== 'ticket') || url.searchParams.getAll('ticket').length !== 1 ||
    !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()) throw new Error('The Gmail connection link is unavailable. Please try again.');
  return { ...value, authorizationUrl: url.href };
}

export const listEmailDrafts = (agentId: number) => workspaceRequest<{ drafts: EmailDraftSummary[]; capability: { available: boolean; provider: string | null; reason: string } }>(agentId, '/email-drafts');
export const readEmailDraft = (agentId: number, draftId: string) => workspaceRequest<EmailDraftDetail>(agentId, `/email-drafts/${id(draftId)}`);
export const createEmailDraft = (agentId: number, content: EmailDraftInput, requestId: string) => workspaceRequest<EmailDraftDetail>(agentId, '/email-drafts', { content, requestId });
export const updateEmailDraft = (agentId: number, draftId: string, content: EmailDraftInput, revision: Revision) => workspaceRequest<EmailDraftDetail>(agentId, `/email-drafts/${id(draftId)}`, { content, ...revision }, 'PUT');
export const reviewEmailDraft = (agentId: number, draftId: string, revision: Revision) => workspaceRequest<EmailDraftDetail>(agentId, `/email-drafts/${id(draftId)}/review`, revision);
export const decideEmailDraft = (agentId: number, draftId: string, revision: Revision, decision: 'approve' | 'reject') => workspaceRequest<EmailDraftDetail>(agentId, `/email-drafts/${id(draftId)}/decision`, { ...revision, decision });
export const deleteEmailDraft = (agentId: number, draftId: string) => workspaceRequest<{ deleted: true }>(agentId, `/email-drafts/${id(draftId)}`, {}, 'DELETE');
export const listEmailThreads = (agentId: number, contactId: number) => workspaceRequest<{ threads: Array<{ threadId: string }> }>(agentId, `/email-drafts/threads?contactId=${contactId}`);

export const listConditionalFollowUps = (agentId: number) => workspaceRequest<{ followUps: ConditionalFollowUp[]; exclusions: ConditionalFollowUpExclusion[] }>(agentId, '/conditional-followups');
export const createConditionalFollowUp = (agentId: number, input: Revision & { requestId: string; draftId: string; dueAt: number }) => workspaceRequest<{ followUp: ConditionalFollowUp }>(agentId, '/conditional-followups', input);
export const readConditionalFollowUp = (agentId: number, followUpId: string) => workspaceRequest<{ followUp: ConditionalFollowUp }>(agentId, `/conditional-followups/${id(followUpId)}`);
export const controlConditionalFollowUp = (agentId: number, followUpId: string, operation: 'approve' | 'pause' | 'resume' | 'cancel') => workspaceRequest<{ followUp: ConditionalFollowUp }>(agentId, `/conditional-followups/${id(followUpId)}/${operation}`, {});
export const setFollowUpExclusion = (agentId: number, contactId: number, reason: string | null) => workspaceRequest<{ exclusions: ConditionalFollowUpExclusion[] }>(agentId, '/conditional-followups/exclusions', { contactId, reason });

export const listArtifacts = (agentId: number) => workspaceRequest<{ artifacts: AssistantArtifact[] }>(agentId, '/artifacts');
export const readArtifact = (agentId: number, artifactId: string, version?: number) => workspaceRequest<AssistantArtifactDetail>(agentId, `/artifacts/${id(artifactId)}${version === undefined ? '' : `?version=${version}`}`);
export const createArtifact = (agentId: number, content: { title: string; html: string; source?: 'import' | 'template' }) => workspaceRequest<AssistantArtifactDetail>(agentId, '/artifacts', content);
export const generateArtifact = (agentId: number, input: { title: string; request: string; requestId: string }) => workspaceRequest<AssistantArtifactDetail>(agentId, '/artifacts/generate', input);
export const updateArtifact = (agentId: number, artifactId: string, input: { title: string; html: string; expectedVersion: number }) => workspaceRequest<AssistantArtifactDetail>(agentId, `/artifacts/${id(artifactId)}`, input, 'PUT');
export const deleteArtifact = (agentId: number, artifactId: string) => workspaceRequest<{ deleted: true }>(agentId, `/artifacts/${id(artifactId)}`, {}, 'DELETE');

export const listBackgroundTasks = (agentId: number) => workspaceRequest<{ tasks: AssistantBackgroundTask[]; notifications: AssistantBackgroundNotification[] }>(agentId, '/background');
export const createBackgroundTask = (agentId: number, input: AssistantBackgroundTaskInput) => workspaceRequest<{ task: AssistantBackgroundTask }>(agentId, '/background', input);
export const readBackgroundTask = (agentId: number, taskId: string) => workspaceRequest<{ task: AssistantBackgroundTask; runs: AssistantBackgroundRun[] }>(agentId, `/background/${id(taskId)}`);
export const readBackgroundResult = (agentId: number, taskId: string, runId: string) => workspaceRequest<{ run: AssistantBackgroundRun; result: unknown }>(agentId, `/background/${id(taskId)}/runs/${id(runId)}`);
export const controlBackgroundTask = (agentId: number, taskId: string, operation: 'pause' | 'cancel') => workspaceRequest<{ task: AssistantBackgroundTask; runs: AssistantBackgroundRun[] }>(agentId, `/background/${id(taskId)}/${operation}`, {});
export const resumeBackgroundTask = (agentId: number, taskId: string, input: { requestId: string; message?: string }) => workspaceRequest<{ task: AssistantBackgroundTask; runs: AssistantBackgroundRun[] }>(agentId, `/background/${id(taskId)}/resume`, input);
export const triggerBackgroundTask = (agentId: number, taskId: string, input: { eventId: string; eventKey: string }) => workspaceRequest<{ task: AssistantBackgroundTask; run: AssistantBackgroundRun | null }>(agentId, `/background/${id(taskId)}/events`, input);
export const markBackgroundNotificationsRead = (agentId: number, through: number) => workspaceRequest<{ read: true }>(agentId, '/background/notifications/read', { through });

export const listAssistantTools = (agentId: number) => workspaceRequest<{ capabilities: AssistantToolCapability[]; grants: AssistantToolGrant[] }>(agentId, '/tools');
export const searchToolContacts = (agentId: number, query: string) => workspaceRequest<{ contacts: Array<{ id: number; name: string }> }>(agentId, `/tools/contacts?query=${id(query)}`);
export const prepareAssistantTool = (agentId: number, input: AssistantToolRequest) => workspaceRequest<AssistantPreparedTool>(agentId, '/tools/requests', input);
export const decideToolGrant = (agentId: number, grant: Pick<AssistantToolGrant, 'id' | 'revision' | 'payloadDigest'>, decision: 'approve' | 'reject') => workspaceRequest<{ grant: AssistantToolGrant }>(agentId, `/tools/grants/${id(grant.id)}/decision`, { revision: grant.revision, payloadDigest: grant.payloadDigest, decision });
export const executeToolGrant = (agentId: number, grant: Pick<AssistantToolGrant, 'id' | 'revision' | 'payloadDigest'>) => workspaceRequest<{ grant: AssistantToolGrant }>(agentId, `/tools/grants/${id(grant.id)}/execute`, { revision: grant.revision, payloadDigest: grant.payloadDigest });
export const readQualification = (agentId: number) => workspaceRequest<AiQualificationReport>(agentId, '/qualification');

export const listScreenshotRecords = (agentId: number) => workspaceRequest<{ records: ScreenshotRecordSummary[] }>(agentId, '/screenshot-records');
export const readScreenshotRecord = (agentId: number, recordId: string) => workspaceRequest<ScreenshotRecord>(agentId, `/screenshot-records/${id(recordId)}`);
export const searchScreenshotClients = (agentId: number, query: string) => workspaceRequest<{ clients: ScreenshotClient[] }>(agentId, `/screenshot-records/clients?query=${id(query)}`);
export const previewScreenshotRecord = (agentId: number, recordId: string, clientId: number, fields: ScreenshotFields) => workspaceRequest<ScreenshotRecord>(agentId, `/screenshot-records/${id(recordId)}/preview`, { clientId, fields });
export const applyScreenshotRecord = (agentId: number, recordId: string, previewDigest: string, resolutions: Partial<Record<ScreenshotField, 'keep' | 'replace'>>) => workspaceRequest<ScreenshotRecord>(agentId, `/screenshot-records/${id(recordId)}/apply`, { previewDigest, resolutions });
export const deleteScreenshotRecord = (agentId: number, recordId: string) => workspaceRequest<{ deleted: true }>(agentId, `/screenshot-records/${id(recordId)}`, {}, 'DELETE');

type ScreenshotTransport = { ok: boolean; status: number; statusText: string; headers: Record<string, string>; body?: string; base64?: string; contentType?: string; errorBody?: string };
function screenshotIdentity() {
  const owner = getStoredUser(), authorization = getAuthHeaders().Authorization;
  if (!owner || !authorization?.startsWith('Bearer ')) throw new Error('Sign in to use screenshots.');
  return { owner: `${owner.tenant_id}:${owner.id}`, token: authorization.slice(7) };
}
function checkScreenshotIdentity(identity: ReturnType<typeof screenshotIdentity>) {
  const current = getStoredUser();
  if (`${current?.tenant_id}:${current?.id}` !== identity.owner) throw new Error('The signed-in account changed. Reopen the conversation.');
  if (getAuthHeaders().Authorization !== `Bearer ${identity.token}`) throw new Error('The signed-in session changed. Reopen the conversation.');
}
function checkScreenshotResponse(response: ScreenshotTransport, identity: ReturnType<typeof screenshotIdentity>) {
  checkScreenshotIdentity(identity);
  if (response.status === 401) logout();
  if (!response.ok) {
    let body; try { body = JSON.parse(response.errorBody ?? response.body ?? '{}'); } catch { /* Transport failures have no JSON response. */ }
    throw new AssistantApiError(body?.error?.message ?? (response.status === 0 ? response.statusText : `Screenshot request failed (${response.status}).`), response.status, body?.error?.code);
  }
}
export async function uploadScreenshot(agentId: number, file: File, requestId: string = crypto.randomUUID()): Promise<ScreenshotRecord> {
  if (!window.dialer?.uploadAssistantScreenshot) throw new Error('Update Crokodial Workspace to upload screenshots.');
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size <= 0 || file.size > 6 * 1024 * 1024) throw new Error('Choose a PNG, JPEG or WebP screenshot up to 6 MB.');
  const identity = screenshotIdentity();
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = ''; for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  checkScreenshotIdentity(identity);
  const response = await window.dialer.uploadAssistantScreenshot({ agentId, requestId, filename: file.name, base64: btoa(binary), token: identity.token });
  checkScreenshotResponse(response, identity);
  const value = JSON.parse(response.body ?? '{}');
  if (!(value.data ?? value)?.id) throw new Error('The screenshot response is invalid.');
  return value.data ?? value;
}
export async function getScreenshotImage(agentId: number, recordId: string): Promise<string> {
  if (!window.dialer?.readAssistantScreenshot) throw new Error('Update Crokodial Workspace to view screenshots.');
  const identity = screenshotIdentity();
  const response = await window.dialer.readAssistantScreenshot({ agentId, recordId, token: identity.token });
  checkScreenshotResponse(response, identity);
  if (response.contentType !== 'image/png' || typeof response.base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(response.base64)) throw new Error('The screenshot image is invalid.');
  return `data:image/png;base64,${response.base64}`;
}
