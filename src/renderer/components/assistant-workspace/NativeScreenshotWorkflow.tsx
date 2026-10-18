import { useNativeWorkState, useNativeDiscardGuard } from './nativeWorkState';
import { workspaceRequest, uploadScreenshot, getScreenshotImage } from '../../services/assistantWorkspaceApi';
import { useEffect, useRef, useState } from 'react';
import { SCREENSHOT_FIELDS, SCREENSHOT_FIELD_LABELS, type ScreenshotClient, type ScreenshotField, type ScreenshotFields, type ScreenshotRecord } from '../../services/assistantWorkspaceTypes';

export function NativeScreenshotWorkflow({ agentId, initialRecordId, onActivity }: { agentId: number; initialRecordId?: string; onActivity?: () => void }) {
  const [record, setRecord] = useState<ScreenshotRecord | null>(null), [fields, setFields] = useState<ScreenshotFields>({});
  const [file, setFile] = useState<File | null>(null), [query, setQuery] = useState(''), [clients, setClients] = useState<ScreenshotClient[]>([]), [clientId, setClientId] = useState('');
  const [resolutions, setResolutions] = useState<Partial<Record<ScreenshotField, 'keep' | 'replace'>>>({});
  const [imageUrl, setImageUrl] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [confirmedClient, setConfirmedClient] = useState(false);
  const generation = useRef(0), uploadId = useRef(crypto.randomUUID()), activeImage = useRef('');
  const dirty = !record ? file !== null : !record.receipt && (SCREENSHOT_FIELDS.some(field => (fields[field] ?? '') !== (record.fields[field] ?? '')) || clientId !== (record.preview ? String(record.preview.client.id) : '') || Object.keys(resolutions).length > 0 || confirmedClient);
  useNativeWorkState(dirty, busy);
  const { guard, notice } = useNativeDiscardGuard(dirty, busy);
  const base = '/screenshot-records';
  async function request<T>(url: string, body?: unknown): Promise<T> {
    return workspaceRequest<T>(agentId,url,body);
  }
  async function loadImage(id: string, current: number) {
    const image = await getScreenshotImage(agentId,id);
    if (current !== generation.current) return;
    setImageUrl(image);
  }

  function show(next: ScreenshotRecord) { setRecord(next); setFields(next.fields); setClientId(next.preview ? String(next.preview.client.id) : ''); setResolutions({}); setConfirmedClient(false); }
  useEffect(() => {
    const current = ++generation.current;
    setRecord(null); setFields({}); setClients([]); setClientId(''); setFile(null); setQuery(''); setError(''); setBusy(false); setImageUrl(''); setResolutions({}); setConfirmedClient(false); uploadId.current = crypto.randomUUID();
    if (initialRecordId) { setBusy(true); void request<ScreenshotRecord>(`${base}/${initialRecordId}`).then(async next => { if (current !== generation.current) return; show(next); await loadImage(next.id, current); }).catch(cause => { if (current === generation.current) setError(cause.message); }).finally(() => { if (current === generation.current) setBusy(false); }); }
    return () => { generation.current++; if (activeImage.current) URL.revokeObjectURL(activeImage.current); activeImage.current = ''; };
  }, [agentId, initialRecordId]);
  async function operate(work: (current: () => boolean) => Promise<void>) {
    if (busy) return; const current = generation.current; setBusy(true); setError('');
    try { await work(() => current === generation.current); } catch (cause) { if (current === generation.current) setError(cause instanceof Error ? cause.message : 'Screenshot request failed'); } finally { if (current === generation.current) setBusy(false); }
  }
  function clearPreview() { setRecord(value => value ? { ...value, preview: null } : value); setResolutions({}); setConfirmedClient(false); }
  function clearRecord() {
    setRecord(null); setFields({}); setFile(null); setClients([]); setClientId(''); setQuery(''); setResolutions({}); setConfirmedClient(false); setImageUrl(''); uploadId.current = crypto.randomUUID();
    if (activeImage.current) URL.revokeObjectURL(activeImage.current); activeImage.current = '';
  }
  const conflictsResolved = record?.preview?.changes.every(change => !change.conflict || resolutions[change.field]) ?? false;
  function exportCsv() {
    if (!record?.receipt) return;
    const receipt = record.receipt, csv = (value: string) => `"${(/^(?:\s*[=+\-@]|[\t\r])/.test(value) ? `'${value}` : value).replace(/"/g, '""')}"`;
    const headers = ['Client ID', 'Client name', ...SCREENSHOT_FIELDS.map(field => SCREENSHOT_FIELD_LABELS[field])], values = [String(receipt.clientId), receipt.clientName, ...SCREENSHOT_FIELDS.map(field => receipt.values[field] ?? '')];
    const url = URL.createObjectURL(new Blob([headers.map(csv).join(',') + '\r\n' + values.map(csv).join(',') + '\r\n'], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `client-${receipt.clientId}-enrollment.csv`; anchor.click(); URL.revokeObjectURL(url);
  }
  return <section aria-label="Update from screenshot" className="nativework-stack nativework-panel">
    <div><h3 className="nativework-strong">Update from screenshot</h3><p className="nativework-muted">Extract locally, select an existing CRM client, then review each change. Missing or unclear values need your correction.</p></div>
    {notice}
    {error && <p role="alert" className="nativework-error">{error}</p>}
    {!record && <form className="nativework-stack" onSubmit={event => { event.preventDefault(); if (!file) return; void operate(async current => {
      const next = await uploadScreenshot(agentId, file, uploadId.current); if (!current()) return;
      show(next); setQuery(next.identity.email ?? next.identity.name ?? next.identity.phone ?? ''); onActivity?.(); await loadImage(next.id, generation.current);
    }); }}><label>Screenshot<input aria-label="Screenshot file" type="file" accept="image/png,image/jpeg,image/webp" onChange={event => { setFile(event.target.files?.[0] ?? null); uploadId.current = crypto.randomUUID(); }} /></label><button disabled={busy || !file}>{busy ? 'Extracting…' : 'Extract screenshot'}</button><p className="nativework-small">PNG, JPEG or WebP, up to 6 MB.</p></form>}
    {record && <>
      <div className="nativework-row"><button disabled={busy} onClick={() => guard(clearRecord)}>Review another screenshot</button><button disabled={busy} onClick={() => void operate(async current => { await workspaceRequest(agentId,`${base}/${record.id}`,{},'DELETE'); if (current()) { clearRecord(); onActivity?.(); } })}>Remove screenshot review</button></div>
      <div className="nativework-row">{imageUrl && <img src={imageUrl} alt="Uploaded screenshot for review" className="nativework-image" />}<details><summary>Extracted source text</summary><pre className="nativework-prewrap">{record.text || 'No OCR text available.'}</pre></details></div>
      {record.receipt ? <div role="status" className="nativework-stack"><p><strong>CRM update verified:</strong> {record.receipt.clientName}. {record.receipt.changedFields.length ? record.receipt.changedFields.map(field => SCREENSHOT_FIELD_LABELS[field]).join(', ') : 'No fields needed changing'}.</p><p className="nativework-small">Saved {new Date(record.receipt.appliedAt).toLocaleString()}. This receipt records the Crokodial CRM update.</p><button onClick={exportCsv}>Export updated values as CSV</button></div> : <>
        {record.extractionError && <p role="status">{record.extractionError}</p>}
        {record.state === 'extracting' && <p role="status">Extraction is pending. You can enter the visible values manually or reopen this review later.</p>}
        <div className="nativework-grid">{SCREENSHOT_FIELDS.map(field => <label key={field}>{SCREENSHOT_FIELD_LABELS[field]}<input aria-label={SCREENSHOT_FIELD_LABELS[field]} type={field === 'effectiveDate' ? 'date' : 'text'} inputMode={field === 'monthlyPremium' ? 'decimal' : undefined} maxLength={160} value={fields[field] ?? ''} onChange={event => { const value = event.target.value; setFields(existing => ({ ...existing, [field]: value })); clearPreview(); }} className="nativework-panel" /></label>)}</div>
        <form className="nativework-row" onSubmit={event => { event.preventDefault(); void operate(async current => { const result = await request<{ clients: ScreenshotClient[] }>(`${base}/clients?query=${encodeURIComponent(query)}`); if (current()) { setClients(result.clients); setClientId(''); clearPreview(); } }); }}><label>Find existing client<input aria-label="Find existing client" value={query} minLength={2} maxLength={100} required onChange={event => setQuery(event.target.value)} className="nativework-panel" /></label><button disabled={busy}>Search clients</button></form>
        {clients.length > 0 && <label>Select the exact client<select aria-label="Select client record" value={clientId} onChange={event => { setClientId(event.target.value); clearPreview(); }} className="nativework-panel"><option value="">Choose a client</option>{clients.map(client => <option key={client.id} value={client.id}>{client.name} · {client.email ?? client.phone ?? `ID ${client.id}`}</option>)}</select></label>}
        <button disabled={busy || !clientId || !Object.values(fields).some(value => value?.trim())} onClick={() => void operate(async current => { const cleaned = Object.fromEntries(Object.entries(fields).filter(([, value]) => value?.trim()).map(([key, value]) => [key, value.trim()])); const next = await request<ScreenshotRecord>(`${base}/${record.id}/preview`, { clientId: Number(clientId), fields: cleaned }); if (current()) { show(next); onActivity?.(); } })}>Review CRM changes</button>
        {record.preview && <div className="nativework-stack nativework-panel"><p className="nativework-strong">Review update to {record.preview.client.name}</p><p>{record.preview.client.email} {record.preview.client.phone} · Client {record.preview.client.id}</p>
          <ul className="nativework-stack">{record.preview.changes.map(change => <li key={change.field}><p><strong>{SCREENSHOT_FIELD_LABELS[change.field]}</strong>: {change.existingValues.join(' / ') || 'Empty'} → {change.proposed}</p>{change.conflict ? <label>Conflicting value — choose a resolution<select aria-label={`Resolve ${SCREENSHOT_FIELD_LABELS[change.field]}`} value={resolutions[change.field] ?? ''} onChange={event => setResolutions(existing => ({ ...existing, [change.field]: event.target.value as 'keep' | 'replace' }))} className="nativework-panel"><option value="">Choose…</option><option value="keep">Keep existing</option><option value="replace">Replace with reviewed value</option></select></label> : <p className="nativework-small">{change.current === change.proposed ? 'Already matches' : 'Fill missing value'}</p>}</li>)}</ul>
          <label className="nativework-row"><input type="checkbox" checked={confirmedClient} onChange={event => setConfirmedClient(event.target.checked)} />I checked the screenshot, selected client and field values.</label>
          <button disabled={busy || !conflictsResolved || !confirmedClient} onClick={() => void operate(async current => { const next = await request<ScreenshotRecord>(`${base}/${record.id}/apply`, { previewDigest: record.preview!.digest, resolutions }); if (current()) { show(next); onActivity?.(); } })}>Apply reviewed CRM update</button>
        </div>}
      </>}
    </>}
  </section>;
}
