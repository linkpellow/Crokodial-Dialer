export type MacConnectorState = 'available' | 'permission_required' | 'denied' | 'unavailable' | 'unsupported' | 'unknown';

export interface MacConnectorStatusItem { state: MacConnectorState; detail: string }
export interface MacConnectorStatus {
  platform: 'macos' | 'unsupported';
  contacts: MacConnectorStatusItem;
  messagesHistory: MacConnectorStatusItem;
  messagesSend: MacConnectorStatusItem;
  whatsapp: MacConnectorStatusItem;
  smsDraft: MacConnectorStatusItem;
}

export interface MacContact {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  organization: string;
  emails: string[];
  phones: string[];
}

export type MacContactChange =
  | { operation: 'create'; contact: { firstName: string; lastName: string; organization?: string; emails?: string[]; phones?: string[] } }
  | { operation: 'update'; contactId: string; changes: { firstName?: string; lastName?: string; organization?: string; addEmails?: string[]; addPhones?: string[] } };

export interface MacContactDuplicateGroup { key: string; reason: string; contacts: MacContact[] }

export interface MacMessageThread {
  id: string;
  title: string;
  participants: string[];
  service: string;
  lastMessage: string;
  lastMessageAt: string | null;
  lastMessageFromMe: boolean | null;
}

export interface MacThreadMessage {
  id: string;
  text: string;
  sender: string;
  fromMe: boolean;
  sentAt: string | null;
}

export interface WhatsAppObservation {
  id: string;
  threadId: string;
  threadJid: string;
  threadTitle: string;
  sender: string;
  text: string;
  fromMe: boolean;
  sentAt: string | null;
}

export type MacConnectorReviewKind = 'contact.create' | 'contact.update' | 'messages.send' | 'sms.compose';
export interface MacWriteOrigin {
  conversationKey: string;
  agentId: number;
  sessionId: string;
  turnId: string;
  requestId?: string;
  turnText: string;
  revision: number;
}
export interface MacCurrentWriteAuthority { agentId: number; sessionId: string }
export interface MacWriteContext {
  tenantId: number;
  userId: number;
  conversationKey?: string;
  environment?: 'sandbox' | 'production';
  lineage?: string;
  agentId: number;
  turnId: string;
  requestId?: string;
  turnDigest: string;
  revision: number;
}
export interface MacConnectorReview<T = unknown> {
  id: string;
  kind: MacConnectorReviewKind;
  digest: string;
  summary: string;
  payload: T;
  createdAt: number;
  expiresAt: number;
  context?: MacWriteContext;
  state?: 'pending';
}

export interface MacConnectorReceipt<T = unknown> {
  state: 'executing' | 'succeeded' | 'submitted' | 'opened' | 'rejected' | 'expired' | 'unknown' | 'reconciled';
  message: string;
  reviewId: string;
  kind?: Exclude<MacConnectorReviewKind, 'sms.compose'>;
  digest?: string;
  context?: MacWriteContext;
  resolution?: 'applied' | 'not_applied';
  contact?: MacContact;
  text?: string;
  error?: string;
  result?: T;
}

export type MacReviewedWriteSnapshot =
  | { state: 'none'; nextRevision: number }
  | { state: 'pending'; review: MacConnectorReview; nextRevision: number }
  | { state: Exclude<MacConnectorReceipt['state'], 'opened'>; receipt: MacConnectorReceipt; nextRevision: number };

export type MacReviewedWriteRecord = Exclude<MacReviewedWriteSnapshot, { state: 'none' }> & {
  kind: Exclude<MacConnectorReviewKind, 'sms.compose'>;
  context: MacWriteContext;
  payload: unknown;
  summary: string;
  createdAt: number;
  updatedAt: number;
};
