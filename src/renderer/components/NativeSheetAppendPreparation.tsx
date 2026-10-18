import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { GoogleWorkspaceToolGrant } from '../services/assistantWorkspaceTypes';
import { exactSheetValues, parseSheetColumnMapping, sheetAppendReviewContext, type SheetAppendSource } from '../services/sheetAppendPreparation';

const RESOURCE_ID = /^[A-Za-z0-9_-]{1,256}$/;

/** Creates an inert, durable Google Sheets review. Approval and execution stay
 * in the permanent chat's Google Workspace card and never happen here. */
export type PrepareSheetAppendReview = (agentId: number, input: { tool: 'sheets.google.append'; requestId: string; args: Record<string, unknown> }) => Promise<{ kind: 'grant'; grant: GoogleWorkspaceToolGrant }>;
export function NativeSheetAppendPreparation({ agentId, source, prepareRequest, onActivity, onStateChange, onPrepared }: { agentId: number; source: SheetAppendSource; prepareRequest: PrepareSheetAppendReview; onActivity?: () => void; onStateChange?: (state: { dirty: boolean; busy: boolean }) => void; onPrepared?: (grantId: string) => void }) {
  const fields = useMemo(() => [...new Set(source.rows.flatMap(row => Object.keys(row)))], [source]);
  const sourceKey = useMemo(() => JSON.stringify([source.kind, source.sourceId, source.observedAt, source.rows]), [source]);
  const [spreadsheetId, setSpreadsheetId] = useState(''), [range, setRange] = useState(''), [mapping, setMapping] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [prepared, setPrepared] = useState('');
  const requestId = useRef(crypto.randomUUID());
  const dirty = !prepared && Boolean(spreadsheetId || range || mapping);
  useLayoutEffect(() => { onStateChange?.({ dirty, busy }); return () => onStateChange?.({ dirty: false, busy: false }); }, [busy, dirty, onStateChange]);
  useEffect(() => { setSpreadsheetId(''); setRange(''); setMapping(''); setError(''); setPrepared(''); requestId.current = crypto.randomUUID(); }, [sourceKey]);

  async function prepare() {
    if (busy) return;
    setError(''); setPrepared('');
    const exactSpreadsheet = spreadsheetId.trim(), exactRange = range.trim();
    if (!RESOURCE_ID.test(exactSpreadsheet)) { setError('Enter the exact Google spreadsheet ID.'); return; }
    if (!exactRange || exactRange.length > 500 || /[\u0000-\u001f\u007f]/.test(exactRange)) { setError('Enter the exact A1 append range, including its sheet tab.'); return; }
    let columns: string[], values;
    try { columns = parseSheetColumnMapping(mapping, fields); values = exactSheetValues(source, columns); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'The Sheet mapping is invalid.'); return; }
    setBusy(true);
    try {
      const reviewContext = await sheetAppendReviewContext(source, columns);
      const result = await prepareRequest(agentId, {
        tool: 'sheets.google.append', requestId: requestId.current,
        args: { spreadsheetId: exactSpreadsheet, range: exactRange, values, valueInputOption: 'RAW', reviewContext },
      });
      setPrepared(result.grant.id); onPrepared?.(result.grant.id); onActivity?.();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The Google Sheets review could not be prepared.'); }
    finally { setBusy(false); }
  }

  if (!source.rows.length) return null;
  return <section className="nativework-stack nativework-panel" aria-label="Prepare exact Google Sheets append">
    <div><strong>Prepare Google Sheets append</strong><p className="nativework-small nativework-muted">Source: {source.label}. This only saves a RAW-value review. It cannot approve, write, or send anything.</p></div>
    <p className="nativework-small">Available source fields: {fields.join(', ')}</p>
    <label>Exact spreadsheet ID<input aria-label="Exact spreadsheet ID" value={spreadsheetId} maxLength={256} onChange={event => { setSpreadsheetId(event.target.value); setPrepared(''); requestId.current = crypto.randomUUID(); }} /></label>
    <label>Exact A1 append range<input aria-label="Exact A1 append range" value={range} maxLength={500} placeholder="Sales!A:G" onChange={event => { setRange(event.target.value); setPrepared(''); requestId.current = crypto.randomUUID(); }} /></label>
    <label>Column mapping, left to right<input aria-label="Sheet column mapping" value={mapping} maxLength={1_000} placeholder={fields.slice(0, 6).join(', ')} onChange={event => { setMapping(event.target.value); setPrepared(''); requestId.current = crypto.randomUUID(); }} /></label>
    <p className="nativework-small nativework-muted">Enter source field names in the exact order of the target range's columns. The durable review records this mapping and all {source.rows.length} exact row{source.rows.length === 1 ? '' : 's'}.</p>
    {error && <p role="alert" className="nativework-error">{error}</p>}
    {prepared && <p role="status">Prepared review {prepared}. Return to the main chat's Google Workspace card to inspect every value, then approve or reject it. No Sheet was changed.</p>}
    <button type="button" disabled={busy || Boolean(prepared)} onClick={() => void prepare()}>{busy ? 'Preparing review…' : 'Prepare exact append review'}</button>
  </section>;
}
