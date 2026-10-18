import type { WhatsAppObservation } from './macConnectorTypes';
import type { SheetAppendCell, SheetAppendSource } from './sheetAppendPreparation';

export const WHATSAPP_SALE_FIELDS = ['clientName', 'clientEmail', 'clientPhone', 'planName', 'monthlyPremium', 'effectiveDate', 'memberId'] as const;
export type WhatsAppSaleField = typeof WHATSAPP_SALE_FIELDS[number];
export const WHATSAPP_SALE_FIELD_LABELS: Record<WhatsAppSaleField, string> = {
  clientName: 'Client name', clientEmail: 'Client email', clientPhone: 'Client phone', planName: 'Plan name',
  monthlyPremium: 'Monthly premium', effectiveDate: 'Effective date', memberId: 'Member / policy ID',
};

export interface WhatsAppSaleCandidate {
  value: string;
  sourceLabel: string;
  sourceExcerpt: string;
  confidence: 'explicit_label';
}

export interface WhatsAppSaleDraft {
  observation: WhatsAppObservation;
  candidates: Record<WhatsAppSaleField, WhatsAppSaleCandidate[]>;
  conflictFields: WhatsAppSaleField[];
}

export interface WhatsAppSaleReviewInput {
  values: Partial<Record<WhatsAppSaleField, string>>;
  /** Conflicting fields must be explicitly resolved to one candidate or omitted. */
  conflictResolutions: Partial<Record<WhatsAppSaleField, 'selected' | 'omitted' | 'owner_value'>>;
  confirmed: boolean;
}

export interface ReviewedWhatsAppSaleRow extends Record<string, SheetAppendCell> {
  sourceObservationId: string;
  sourceThreadId: string;
  sourceThreadJid: string | null;
  sourceThreadTitle: string;
  sourceSender: string | null;
  sourceDirection: 'inbound' | 'outbound';
  sourceSentAt: string | null;
  sourceExactText: string;
  clientName: string | null;
  clientEmail: string | null;
  clientPhone: string | null;
  planName: string | null;
  monthlyPremium: number | null;
  effectiveDate: string | null;
  memberId: string | null;
  fieldProvenance: string;
  resolvedConflicts: string;
  reviewedAt: string;
}

const LABELS: Array<{ field: WhatsAppSaleField; pattern: RegExp }> = [
  { field: 'monthlyPremium', pattern: /^(monthly\s+premium|premium)\s*[:=\-]\s*(.+)$/i },
  { field: 'effectiveDate', pattern: /^(effective\s+date|effective)\s*[:=\-]\s*(.+)$/i },
  { field: 'memberId', pattern: /^(member\s*(?:id|#|number)|policy\s*(?:id|#|number))\s*[:=\-]\s*(.+)$/i },
  { field: 'clientEmail', pattern: /^(client\s+email|customer\s+email|insured\s+email|email)\s*[:=\-]\s*(.+)$/i },
  { field: 'clientPhone', pattern: /^(client\s+phone|customer\s+phone|insured\s+phone|phone(?:\s+number)?)\s*[:=\-]\s*(.+)$/i },
  { field: 'clientName', pattern: /^(client\s+name|customer\s+name|insured\s+name|client|customer|insured)\s*[:=\-]\s*(.+)$/i },
  { field: 'planName', pattern: /^(plan\s+name|product\s+name|plan|product)\s*[:=\-]\s*(.+)$/i },
];

const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const premium = /^\$?\s*([0-9]{1,6}(?:,[0-9]{3})*(?:\.[0-9]{1,2})?)\s*(?:\/\s*(?:mo(?:nth)?|monthly)|per\s+month)?$/i;

function plain(value: unknown, maximum = 200): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum);
}

function normalize(field: WhatsAppSaleField, raw: string): string {
  const value = plain(raw, field === 'memberId' ? 120 : 200);
  if (!value) return '';
  if (field === 'clientEmail') return email.test(value) ? value.toLowerCase() : '';
  if (field === 'clientPhone') {
    const digits = value.replace(/\D/g, '');
    return digits.length >= 7 && digits.length <= 15 && /^[+()\d.\-\s]+$/.test(value) ? value : '';
  }
  if (field === 'monthlyPremium') {
    const match = value.match(premium);
    if (!match) return '';
    const amount = Number(match[1].replace(/,/g, ''));
    return Number.isFinite(amount) && amount >= 0 && amount <= 1_000_000 ? amount.toFixed(2) : '';
  }
  return value;
}

function blankCandidates(): Record<WhatsAppSaleField, WhatsAppSaleCandidate[]> {
  return { clientName: [], clientEmail: [], clientPhone: [], planName: [], monthlyPremium: [], effectiveDate: [], memberId: [] };
}

/**
 * Extract only facts that are explicitly labelled in the exact WhatsApp text.
 * Unlabelled prose is intentionally left blank so the owner can review it
 * without an inference being represented as a sale fact.
 */
export function extractWhatsAppSaleDraft(observation: WhatsAppObservation): WhatsAppSaleDraft {
  const candidates = blankCandidates();
  for (const sourceLine of observation.text.split(/\r?\n|[;|]+/).slice(0, 100)) {
    const line = plain(sourceLine, 500);
    if (!line) continue;
    for (const definition of LABELS) {
      const match = line.match(definition.pattern);
      if (!match) continue;
      const value = normalize(definition.field, match[2]);
      if (!value || candidates[definition.field].some(candidate => candidate.value === value)) break;
      candidates[definition.field].push({ value, sourceLabel: plain(match[1], 80), sourceExcerpt: line, confidence: 'explicit_label' });
      break;
    }
  }
  const conflictFields = WHATSAPP_SALE_FIELDS.filter(field => candidates[field].length > 1);
  return { observation, candidates, conflictFields };
}

export function initialWhatsAppSaleValues(draft: WhatsAppSaleDraft): Partial<Record<WhatsAppSaleField, string>> {
  return Object.fromEntries(WHATSAPP_SALE_FIELDS.flatMap(field => draft.candidates[field].length === 1 ? [[field, draft.candidates[field][0].value]] : []));
}

export function finalizeWhatsAppSaleReview(draft: WhatsAppSaleDraft, input: WhatsAppSaleReviewInput, reviewedAt = new Date().toISOString()): ReviewedWhatsAppSaleRow {
  if (!input.confirmed) throw new Error('Confirm that you reviewed the exact WhatsApp source and structured values.');
  for (const field of draft.conflictFields) if (!input.conflictResolutions[field]) throw new Error(`Resolve the conflicting ${WHATSAPP_SALE_FIELD_LABELS[field].toLowerCase()} values.`);

  const values = {} as Record<WhatsAppSaleField, string>;
  for (const field of WHATSAPP_SALE_FIELDS) {
    const supplied = plain(input.values[field] ?? '', 500);
    values[field] = normalize(field, supplied);
    if (supplied && !values[field]) throw new Error(`Enter a valid ${WHATSAPP_SALE_FIELD_LABELS[field].toLowerCase()} or leave it blank.`);
    if (!draft.conflictFields.includes(field)) continue;
    const resolution = input.conflictResolutions[field];
    if (resolution === 'omitted' && values[field]) throw new Error(`Omitted ${WHATSAPP_SALE_FIELD_LABELS[field].toLowerCase()} must stay blank.`);
    if (resolution === 'selected' && !draft.candidates[field].some(candidate => candidate.value === values[field])) {
      throw new Error(`Select one exact ${WHATSAPP_SALE_FIELD_LABELS[field].toLowerCase()} candidate or choose a reviewed value.`);
    }
    if (resolution === 'owner_value' && !values[field]) throw new Error(`Enter the reviewed ${WHATSAPP_SALE_FIELD_LABELS[field].toLowerCase()} value or omit it.`);
  }
  if (!WHATSAPP_SALE_FIELDS.some(field => values[field])) throw new Error('Enter or confirm at least one structured sales field.');
  const provenance: Partial<Record<WhatsAppSaleField, Record<string, unknown>>> = {};
  for (const field of WHATSAPP_SALE_FIELDS) {
    const value = values[field];
    if (!value) continue;
    const candidates = draft.candidates[field];
    const candidate = candidates.find(item => item.value === value);
    const mode = !candidate ? 'owner_entered' : candidates.length > 1 ? 'owner_selected_candidate' : 'explicit_label';
    provenance[field] = {
      mode,
      confidence: mode === 'explicit_label' ? 'explicit_label' : 'owner_reviewed',
      observationId: draft.observation.id,
      ...(candidate ? { sourceLabel: candidate.sourceLabel, sourceExcerpt: candidate.sourceExcerpt } : {}),
    };
  }
  const resolvedConflicts = draft.conflictFields.map(field => `${field}:${input.conflictResolutions[field]}`).join(',');
  const numericPremium = values.monthlyPremium ? Number(values.monthlyPremium) : null;
  return {
    sourceObservationId: draft.observation.id,
    sourceThreadId: draft.observation.threadId,
    sourceThreadJid: (draft.observation as WhatsAppObservation & { threadJid?: string }).threadJid || null,
    sourceThreadTitle: draft.observation.threadTitle,
    sourceSender: draft.observation.sender || null,
    sourceDirection: draft.observation.fromMe ? 'outbound' : 'inbound',
    sourceSentAt: draft.observation.sentAt,
    sourceExactText: draft.observation.text,
    clientName: values.clientName || null,
    clientEmail: values.clientEmail || null,
    clientPhone: values.clientPhone || null,
    planName: values.planName || null,
    monthlyPremium: numericPremium,
    effectiveDate: values.effectiveDate || null,
    memberId: values.memberId || null,
    fieldProvenance: JSON.stringify(provenance),
    resolvedConflicts,
    reviewedAt,
  };
}

export function whatsAppSalesSheetSource(turnId: string, query: string, observedAt: number, rows: readonly ReviewedWhatsAppSaleRow[]): SheetAppendSource {
  if (!rows.length) throw new Error('Review at least one WhatsApp sales row before preparing a Sheet append.');
  return {
    kind: 'native_whatsapp_sales_review', sourceId: turnId,
    label: `Reviewed WhatsApp sales for “${plain(query, 100)}”`, observedAt,
    rows: rows.slice(0, 100).map(row => ({ ...row })),
  };
}
