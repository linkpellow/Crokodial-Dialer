import { useEffect, useMemo, useState } from 'react';
import type { WhatsAppObservation } from '../services/macConnectorTypes';
import {
  extractWhatsAppSaleDraft, finalizeWhatsAppSaleReview, initialWhatsAppSaleValues,
  WHATSAPP_SALE_FIELDS, WHATSAPP_SALE_FIELD_LABELS, whatsAppSalesSheetSource,
  type ReviewedWhatsAppSaleRow, type WhatsAppSaleField,
} from '../services/whatsAppSalesExtraction';
import { NativeSheetAppendPreparation, type PrepareSheetAppendReview } from './NativeSheetAppendPreparation';

type PendingState = { dirty: boolean; busy: boolean };
const OMIT = '__omit__', OWNER_VALUE = '__owner_value__';

function display(value: string): string {
  return value || '(empty)';
}

/**
 * Converts untrusted local WhatsApp evidence into owner-reviewed structured
 * sales rows. Only explicitly labelled values are prefilled; missing values
 * remain blank and every conflict must be resolved or deliberately omitted.
 */
export function NativeWhatsAppSalesExtraction({ agentId, turnId, query, observedAt, observations, prepareRequest, onStateChange, onActivity }: {
  agentId: number; turnId: string; query: string; observedAt: number; observations: readonly WhatsAppObservation[];
  prepareRequest: PrepareSheetAppendReview; onStateChange?: (state: PendingState) => void; onActivity?: () => void;
}) {
  const drafts = useMemo(() => observations.map(extractWhatsAppSaleDraft), [observations]);
  const [selectedId, setSelectedId] = useState(drafts[0]?.observation.id ?? '');
  const selected = drafts.find(draft => draft.observation.id === selectedId) ?? drafts[0];
  const [values, setValues] = useState<Partial<Record<WhatsAppSaleField, string>>>({});
  const [resolutions, setResolutions] = useState<Partial<Record<WhatsAppSaleField, 'selected' | 'omitted' | 'owner_value'>>>({});
  const [confirmed, setConfirmed] = useState(false), [touched, setTouched] = useState(false), [error, setError] = useState('');
  const [reviewedRows, setReviewedRows] = useState<ReviewedWhatsAppSaleRow[]>([]);
  const [sheetPrepared, setSheetPrepared] = useState(false), [sheetState, setSheetState] = useState<PendingState>({ dirty: false, busy: false });

  useEffect(() => {
    if (!selected) return;
    setValues(initialWhatsAppSaleValues(selected)); setResolutions({}); setConfirmed(false); setTouched(false); setError('');
  }, [selected?.observation.id]);

  const dirty = touched || reviewedRows.length > 0 && !sheetPrepared || sheetState.dirty;
  useEffect(() => { onStateChange?.({ dirty, busy: sheetState.busy }); return () => onStateChange?.({ dirty: false, busy: false }); }, [dirty, onStateChange, sheetState.busy]);

  function setField(field: WhatsAppSaleField, value: string) {
    setValues(current => ({ ...current, [field]: value })); setTouched(true); setConfirmed(false); setError('');
  }

  function resolveConflict(field: WhatsAppSaleField, choice: string) {
    setTouched(true); setConfirmed(false); setError('');
    if (choice === OMIT) {
      setResolutions(current => ({ ...current, [field]: 'omitted' }));
      setValues(current => ({ ...current, [field]: '' }));
    } else if (choice === OWNER_VALUE) {
      setResolutions(current => ({ ...current, [field]: 'owner_value' }));
      setValues(current => ({ ...current, [field]: '' }));
    } else {
      setResolutions(current => ({ ...current, [field]: 'selected' }));
      setValues(current => ({ ...current, [field]: choice }));
    }
  }

  function stage() {
    if (!selected) return;
    try {
      const row = finalizeWhatsAppSaleReview(selected, { values, conflictResolutions: resolutions, confirmed });
      setReviewedRows(current => [...current.filter(item => item.sourceObservationId !== row.sourceObservationId), row]);
      setSheetPrepared(false); setTouched(false); setConfirmed(false); setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The structured sales row is invalid.'); }
  }

  if (!selected) return null;
  const extracted = WHATSAPP_SALE_FIELDS.filter(field => selected.candidates[field].length).length;
  const source = reviewedRows.length ? whatsAppSalesSheetSource(turnId, query, observedAt, reviewedRows) : null;

  return <section className="nativework-stack nativework-panel" aria-label="Review WhatsApp sales extraction">
    <div><strong>Review structured WhatsApp sales</strong><p className="nativework-small nativework-muted">Only explicitly labelled facts are prefilled. Unlabelled or invalid values stay blank. Review the exact source before a row can reach the separate Google Sheets approval.</p></div>
    <label>Source observation<select aria-label="WhatsApp sale source observation" value={selected.observation.id} onChange={event => setSelectedId(event.target.value)}>{drafts.map((draft, index) => <option key={draft.observation.id} value={draft.observation.id}>{index + 1}. {draft.observation.threadTitle} · {draft.observation.sender || (draft.observation.fromMe ? 'You' : 'Participant')} · {draft.observation.sentAt ?? 'time unavailable'}</option>)}</select></label>
    <div className="nativework-panel"><p className="nativework-small nativework-muted">Exact source · observation {selected.observation.id}</p><p className="assistant-inline-mac-exact">{selected.observation.text || '(No text; nothing can be extracted.)'}</p></div>
    <p className="nativework-small">{extracted ? `${extracted} field${extracted === 1 ? '' : 's'} had explicit labelled evidence.` : 'No explicitly labelled sales fields were found. Every structured value must be entered and confirmed by you.'}</p>
    {WHATSAPP_SALE_FIELDS.map(field => {
      const candidates = selected.candidates[field], conflict = candidates.length > 1, resolution = resolutions[field];
      return <div key={field} className="nativework-stack">
        <label>{WHATSAPP_SALE_FIELD_LABELS[field]}
          {conflict ? <select aria-label={`Resolve ${WHATSAPP_SALE_FIELD_LABELS[field]}`} value={resolution === 'omitted' ? OMIT : resolution === 'owner_value' ? OWNER_VALUE : resolution === 'selected' ? values[field] ?? '' : ''} onChange={event => resolveConflict(field, event.target.value)}>
            <option value="">Resolve conflicting explicit values…</option>
            {candidates.map(candidate => <option key={candidate.value} value={candidate.value}>Use {candidate.value}</option>)}
            <option value={OMIT}>Omit as unresolved</option><option value={OWNER_VALUE}>Enter a different reviewed value</option>
          </select> : <input aria-label={WHATSAPP_SALE_FIELD_LABELS[field]} value={values[field] ?? ''} onChange={event => setField(field, event.target.value)} />}
        </label>
        {conflict && resolution === 'owner_value' && <input aria-label={`Reviewed ${WHATSAPP_SALE_FIELD_LABELS[field]}`} value={values[field] ?? ''} onChange={event => setField(field, event.target.value)} />}
        {candidates.length > 0 && <details><summary>{conflict ? `${candidates.length} conflicting explicit candidates` : 'Explicit labelled source match'}</summary><ul>{candidates.map(candidate => <li key={`${candidate.value}:${candidate.sourceExcerpt}`}><strong>{display(candidate.value)}</strong> from label “{candidate.sourceLabel}”<br/><span className="nativework-small nativework-muted">{candidate.sourceExcerpt}</span></li>)}</ul></details>}
      </div>;
    })}
    <label className="nativework-row"><input type="checkbox" aria-label="Confirm WhatsApp sales review" checked={confirmed} onChange={event => { setConfirmed(event.target.checked); setTouched(true); setError(''); }} />I reviewed the exact source, structured values, omissions and conflicts.</label>
    {error && <p role="alert" className="nativework-error">{error}</p>}
    <button type="button" onClick={stage}>Stage this reviewed sales row</button>
    {reviewedRows.length > 0 && <section aria-label="Staged WhatsApp sales rows"><strong>{reviewedRows.length} reviewed row{reviewedRows.length === 1 ? '' : 's'} staged</strong><ul>{reviewedRows.map(row => <li key={row.sourceObservationId}>{row.clientName || row.planName || row.sourceObservationId} · {row.monthlyPremium === null ? 'premium omitted' : `$${row.monthlyPremium.toFixed(2)}`}<button type="button" onClick={() => { setReviewedRows(current => current.filter(item => item.sourceObservationId !== row.sourceObservationId)); setSheetPrepared(false); }}>Remove</button></li>)}</ul></section>}
    {source && <NativeSheetAppendPreparation agentId={agentId} source={source} prepareRequest={prepareRequest} onStateChange={setSheetState} onPrepared={() => setSheetPrepared(true)} onActivity={onActivity}/>}
  </section>;
}
