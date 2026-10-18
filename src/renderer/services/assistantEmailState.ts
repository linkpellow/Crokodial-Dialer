import type { EmailDraftDetail, EmailDraftInput, EmailRecipientInput, EmailResolvedRecipient } from './assistantWorkspaceTypes';

export function emailRecipientInput(recipient: EmailResolvedRecipient): EmailRecipientInput {
  if (recipient.source === 'contact' && recipient.contactId) return { contactId: recipient.contactId };
  if (recipient.source === 'support_contact' && recipient.supportContact) return { supportContact: recipient.supportContact };
  return { email: recipient.email, ...(recipient.name ? { name: recipient.name } : {}) };
}
/** Editable corrections preserve authoritative recipient provenance, not just display text. */
export function emailDraftContent(draft: EmailDraftDetail): EmailDraftInput {
  return { ...(draft.contactId ? { contactId: draft.contactId } : {}), subject: draft.subject, text: draft.text, html: draft.html,
    ...(draft.recipients ? { to: draft.recipients.to.map(emailRecipientInput), cc: draft.recipients.cc.map(emailRecipientInput), bcc: draft.recipients.bcc.map(emailRecipientInput) } : {}),
    attachments: draft.attachments.map(({name, contentType, base64}) => ({name, contentType, base64})),
    ...(draft.replyThreadId ? { replyThreadId: draft.replyThreadId, ...(draft.replySource ? { replySource: draft.replySource } : {}) } : {}), ...(draft.artifact ? { artifact: draft.artifact } : {}) };
}
export function parseOwnerEmailRecipients(text: string): EmailRecipientInput[] {
  if (/[\r\n]/.test(text)) throw new Error('Enter email addresses separated by commas; line breaks are not allowed.');
  const addresses = text.split(/[,;]/).map(value => value.trim()).filter(Boolean);
  if (addresses.length > 20) throw new Error('Use at most 20 recipients in one email.');
  if (addresses.some(value => !/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(value) || value.length > 254)) throw new Error('Enter complete email addresses without display names.');
  if (new Set(addresses.map(value => value.toLowerCase())).size !== addresses.length) throw new Error('Remove duplicate email addresses.');
  return addresses.map(email => ({ email }));
}
export function exactEmailRevision(draft: Pick<EmailDraftDetail, 'id' | 'revision' | 'contentHash'>) {
  return { draftId: draft.id, expectedRevision: draft.revision, contentHash: draft.contentHash };
}

export type EmailBatchResult = { draftId: string; status: 'submitted' | 'rejected' | 'failed' | 'unknown'; error?: string };
export function validateEmailBatchReview(selected: Array<Pick<EmailDraftDetail,'id'|'revision'|'contentHash'>>, reviewed: EmailDraftDetail[]): EmailDraftDetail[] {
  if (!selected.length || selected.length > 20 || new Set(selected.map(item=>item.id)).size !== selected.length ||
    !Array.isArray(reviewed) || reviewed.length !== selected.length || new Set(reviewed.map(item=>item.id)).size !== reviewed.length ||
    reviewed.some(item=>!selected.some(original=>original.id===item.id&&original.revision===item.revision&&original.contentHash===item.contentHash))) {
    throw new Error('The reviewed set changed. Reload the saved drafts before continuing.');
  }
  return reviewed;
}
export function validateEmailBatchResults(selected: Array<{id:string}>, results: unknown): EmailBatchResult[] {
  if (!Array.isArray(results) || results.length!==selected.length || new Set(results.map(item=>item?.draftId)).size!==results.length || results.some(item=>
    !item || !selected.some(original=>original.id===item.draftId) || !['submitted','rejected','failed','unknown'].includes(item.status) || item.error!==undefined&&typeof item.error!=='string')) {
    throw new Error('The batch receipt is incomplete. Reload the saved outcomes before continuing.');
  }
  return results;
}
