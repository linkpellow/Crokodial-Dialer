import type {
  MacConnectorReceipt,
  MacConnectorReview,
  MacConnectorReviewKind,
  MacConnectorStatus,
  MacContact,
  MacContactChange,
  MacContactDuplicateGroup,
  MacMessageThread,
  MacReviewedWriteSnapshot,
  MacReviewedWriteRecord,
  MacCurrentWriteAuthority,
  MacThreadMessage,
  MacWriteContext,
  MacWriteOrigin,
  WhatsAppObservation,
} from './macConnectorTypes';

function connectorBridge() {
  const bridge = window.dialer?.macConnectors;
  if (!bridge) throw new Error('Mac connectors are unavailable. Rebuild Crokodial Workspace.');
  return bridge;
}

function storedOwner(): { id: number; tenant_id?: number | null } | null {
  try {
    const raw = localStorage.getItem('crokodial_auth_user');
    return raw ? JSON.parse(raw) as { id: number; tenant_id?: number | null } : null;
  } catch { return null; }
}

function cleanId(value: string, label: string): string {
  const result = value.trim();
  if (!result || result.length > 256 || /[\u0000-\u001f\u007f]/.test(result)) throw new Error(`${label} is invalid.`);
  return result;
}

async function turnDigest(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function writeContext(origin: MacWriteOrigin): Promise<MacWriteContext> {
  const owner = storedOwner();
  if (!owner || !Number.isSafeInteger(owner.id) || !Number.isSafeInteger(owner.tenant_id) || owner.id <= 0 || owner.tenant_id! <= 0) throw new Error('Sign in to review this local write.');
  if (!Number.isSafeInteger(origin.agentId) || origin.agentId <= 0 || !Number.isSafeInteger(origin.revision) || origin.revision <= 0) throw new Error('The assistant or request revision is invalid.');
  const turnId = cleanId(origin.turnId, 'Persisted turn ID');
  if (turnId.startsWith('received:')) throw new Error('Wait for this request to appear in the saved conversation before reviewing a local write.');
  const requestId = origin.requestId === undefined ? undefined : cleanId(origin.requestId, 'Persisted request ID');
  const conversationKey = cleanId(origin.conversationKey, 'Permanent conversation ID');
  const digest = await turnDigest(origin.turnText);
  const current = storedOwner();
  if (current?.id !== owner.id || current?.tenant_id !== owner.tenant_id) throw new Error('The signed-in account changed. Reopen the saved conversation.');
  return { tenantId: owner.tenant_id!, userId: owner.id, conversationKey, agentId: origin.agentId, turnId, ...(requestId ? { requestId } : {}), turnDigest: digest, revision: origin.revision };
}

function durableBinding(review: MacConnectorReview) {
  if (!review.context || review.kind === 'sms.compose') throw new Error('This review is not bound to a persisted Crokodial request.');
  return { id: review.id, kind: review.kind, digest: review.digest, context: review.context };
}

export function transientMacAuthority(origin: MacCurrentWriteAuthority) {
  const bearerToken = localStorage.getItem('crokodial_auth_token');
  if (!bearerToken || bearerToken.length > 8_192 || /\s/.test(bearerToken)) throw new Error('Sign in again before reviewing a local write.');
  return { bearerToken, agentId: origin.agentId, sessionId: cleanId(origin.sessionId, 'Current assistant session') };
}

export const macConnectorService = {
  status: () => connectorBridge().status() as Promise<MacConnectorStatus>,
  requestAccess: (connector: 'contacts' | 'messages') => connectorBridge().requestAccess(connector) as Promise<MacConnectorStatus>,
  searchContacts: (query: string) => connectorBridge().searchContacts(query) as Promise<{ contacts: MacContact[] }>,
  previewContactDuplicates: () => connectorBridge().previewContactDuplicates() as Promise<{ groups: MacContactDuplicateGroup[]; truncated: boolean }>,
  prepareContactChange: async (change: MacContactChange, origin: MacWriteOrigin) => connectorBridge().prepareContactChange({ change, context: await writeContext(origin), authority: transientMacAuthority(origin) }) as Promise<MacConnectorReview<MacContactChange>>,
  executeContactChange: (review: MacConnectorReview<MacContactChange>, origin: MacCurrentWriteAuthority) => connectorBridge().executeContactChange({ ...durableBinding(review), authority: transientMacAuthority(origin) }) as Promise<MacConnectorReceipt>,
  listMessageThreads: (query = '') => connectorBridge().listMessageThreads(query) as Promise<{ threads: MacMessageThread[] }>,
  readMessageThread: (threadId: string) => connectorBridge().readMessageThread(threadId) as Promise<{ thread: MacMessageThread; messages: MacThreadMessage[] }>,
  prepareMessageSend: async (threadId: string, text: string, origin: MacWriteOrigin) => connectorBridge().prepareMessageSend({ threadId, text, context: await writeContext(origin), authority: transientMacAuthority(origin) }) as Promise<MacConnectorReview<{ thread: MacMessageThread; text: string }>>,
  executeMessageSend: (review: MacConnectorReview, origin: MacCurrentWriteAuthority) => connectorBridge().executeMessageSend({ ...durableBinding(review), authority: transientMacAuthority(origin) }) as Promise<MacConnectorReceipt>,
  restoreReviewedWrite: async (origin: MacWriteOrigin, kind: Exclude<MacConnectorReviewKind, 'sms.compose'>) => connectorBridge().restoreReviewedWrite({ kind, context: await writeContext(origin), authority: transientMacAuthority(origin) }) as Promise<MacReviewedWriteSnapshot>,
  reconcileReviewedWrite: (receipt: MacConnectorReceipt, resolution: 'applied' | 'not_applied', origin: MacCurrentWriteAuthority) => {
    if (!receipt.context || !receipt.digest || !receipt.kind) throw new Error('This unresolved receipt has no durable request binding.');
    return connectorBridge().reconcileReviewedWrite({ id: receipt.reviewId, digest: receipt.digest, context: receipt.context,
      resolution, authority: transientMacAuthority(origin) }) as Promise<MacReviewedWriteSnapshot>;
  },
  restoreReviewedWriteContext: (context: MacWriteContext, kind: Exclude<MacConnectorReviewKind, 'sms.compose'>, origin: MacCurrentWriteAuthority) => {
    const owner = storedOwner();
    if (!owner || owner.id !== context.userId || owner.tenant_id !== context.tenantId) throw new Error('The signed-in account changed. Reopen the saved conversation.');
    return connectorBridge().restoreReviewedWrite({ kind, context, authority: transientMacAuthority(origin) }) as Promise<MacReviewedWriteSnapshot>;
  },
  listReviewedWrites: (origin: MacCurrentWriteAuthority, cursor?: string) => {
    return connectorBridge().listReviewedWrites({ authority: transientMacAuthority(origin),
      ...(cursor ? { cursor: cleanId(cursor, 'Receipt page cursor') } : {}) }) as Promise<{ records: MacReviewedWriteRecord[]; truncated: boolean; nextCursor?: string }>;
  },
  searchWhatsApp: (query: string) => connectorBridge().searchWhatsApp(query) as Promise<{ observations: WhatsAppObservation[]; readOnly: true }>,
  prepareSmsDraft: (phone: string, text: string) => connectorBridge().prepareSmsDraft({ phone, text }) as Promise<MacConnectorReview<{ phone: string; text: string }>>,
  openSmsDraft: (review: MacConnectorReview) => connectorBridge().openSmsDraft({ id: review.id, digest: review.digest }) as Promise<MacConnectorReceipt>,
};
