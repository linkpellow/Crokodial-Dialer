import type { ScreenshotFields, ScreenshotRecord } from './assistantWorkspaceTypes';

export type SheetAppendCell = string | number | boolean | null;
export type SheetAppendSourceKind = 'screenshot_extraction' | 'native_whatsapp_sales_review';
export interface SheetAppendSource {
  kind: SheetAppendSourceKind;
  sourceId: string;
  label: string;
  observedAt: number;
  rows: Array<Record<string, SheetAppendCell>>;
}

export interface SheetAppendReviewContext {
  source: SheetAppendSourceKind;
  sourceId: string;
  columnMapping: string[];
  rowCount: number;
  observedAt: number;
  sourceDigest?: string;
  provenance?: Array<Record<string, unknown>>;
}

const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export function parseSheetColumnMapping(value: string, available: readonly string[]): string[] {
  const fields = value.split(',').map(item => item.trim()).filter(Boolean);
  if (!fields.length) throw new Error('Enter the source fields in exact target-column order.');
  if (fields.length > 50 || fields.some(field => !FIELD.test(field))) throw new Error('Use up to 50 comma-separated source field names.');
  if (new Set(fields).size !== fields.length) throw new Error('Each source field can appear only once in the column mapping.');
  const allowed = new Set(available);
  const missing = fields.find(field => !allowed.has(field));
  if (missing) throw new Error(`“${missing}” is not available in this source.`);
  return fields;
}

export function exactSheetValues(source: SheetAppendSource, columns: readonly string[]): SheetAppendCell[][] {
  if (!source.rows.length || source.rows.length > 200) throw new Error('Choose between 1 and 200 source rows.');
  const values = source.rows.map(row => columns.map(column => row[column] ?? null));
  if (new TextEncoder().encode(JSON.stringify(values)).byteLength > 262_144) throw new Error('The exact Sheet values exceed the 256 KB review limit.');
  return values;
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Preserve compact source identities and cryptographic digests in the durable
 * grant even when the target Sheet does not include provenance columns. */
export async function sheetAppendReviewContext(source: SheetAppendSource, columns: readonly string[]): Promise<SheetAppendReviewContext> {
  const base = { source: source.kind, sourceId: source.sourceId, columnMapping: [...columns], rowCount: source.rows.length, observedAt: source.observedAt };
  if (source.kind !== 'native_whatsapp_sales_review') return base;
  const provenance = await Promise.all(source.rows.map(async row => {
    let fieldProvenance: Record<string, { mode?: unknown; confidence?: unknown }> = {};
    try {
      const parsed = JSON.parse(typeof row.fieldProvenance === 'string' ? row.fieldProvenance : '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) fieldProvenance = parsed;
    } catch { throw new Error('Reviewed WhatsApp field provenance is invalid.'); }
    const fields = Object.entries(fieldProvenance).map(([field, details]) => ({ field, mode: details?.mode, confidence: details?.confidence }));
    if (!fields.length) throw new Error('Reviewed WhatsApp sales rows require field provenance.');
    const resolvedConflicts = typeof row.resolvedConflicts === 'string' && row.resolvedConflicts
      ? row.resolvedConflicts.split(',').map(value => { const [field, resolution] = value.split(':'); return { field, resolution }; }) : [];
    const threadJid = typeof row.sourceThreadJid === 'string' && row.sourceThreadJid ? row.sourceThreadJid : undefined;
    return {
      observationId: String(row.sourceObservationId ?? ''), threadId: String(row.sourceThreadId ?? ''), ...(threadJid ? { threadJid } : {}),
      threadTitle: String(row.sourceThreadTitle ?? ''), sender: row.sourceSender === null ? null : String(row.sourceSender ?? ''),
      sentAt: row.sourceSentAt === null ? null : String(row.sourceSentAt ?? ''),
      sourceTextDigest: await sha256(String(row.sourceExactText ?? '')),
      fieldProvenanceDigest: await sha256(String(row.fieldProvenance ?? '')),
      fields, resolvedConflicts,
    };
  }));
  return { ...base, sourceDigest: await sha256(JSON.stringify(source.rows)), provenance };
}

export function screenshotSheetSource(record: ScreenshotRecord, reviewedFields: ScreenshotFields): SheetAppendSource {
  const fields = record.receipt?.values ?? reviewedFields;
  const premium = fields.monthlyPremium?.trim();
  return {
    kind: 'screenshot_extraction',
    sourceId: record.id,
    label: `Screenshot ${record.filename}`,
    observedAt: record.updatedAt,
    rows: [{
      recordId: record.id,
      filename: record.filename,
      clientName: record.receipt?.clientName ?? record.preview?.client.name ?? record.identity.name ?? null,
      clientEmail: record.preview?.client.email ?? record.identity.email ?? null,
      clientPhone: record.preview?.client.phone ?? record.identity.phone ?? null,
      planName: fields.planName ?? null,
      monthlyPremium: !premium ? null : Number.isFinite(Number(premium)) ? Number(premium) : premium,
      effectiveDate: fields.effectiveDate ?? null,
      memberId: fields.memberId ?? null,
    }],
  };
}
