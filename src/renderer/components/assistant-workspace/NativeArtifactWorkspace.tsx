import { useNativeWorkState, useNativeDiscardGuard } from './nativeWorkState';
import { previewSurface } from './previewSurface';
import { workspaceRequest } from '../../services/assistantWorkspaceApi';
import { useEffect, useRef, useState } from 'react';
import { ASSISTANT_ARTIFACT_SANDBOX, assistantArtifactPreview, type AssistantArtifact, type AssistantArtifactDetail } from '../../services/assistantWorkspaceTypes';

export const ARTIFACT_COUNTER_TEMPLATE = `<main style="font:18px system-ui;text-align:center;padding:40px"><h1>Interactive counter</h1><p aria-live="polite" id="count">0</p><button type="button" id="increment">Increment</button><button type="button" id="reset">Reset</button></main><script>let count=0;const output=document.getElementById('count');document.getElementById('increment').addEventListener('click',()=>{output.textContent=String(++count)});document.getElementById('reset').addEventListener('click',()=>{count=0;output.textContent='0'});</script>`;
const field = 'nativework-field';
const button = 'nativework-button';

export function NativeArtifactWorkspace({ agentId, initialArtifactId, onActivity }: { agentId: number; initialArtifactId?: string; onActivity?: () => void }) {
  return <ArtifactWorkspace key={`${agentId}:${initialArtifactId ?? ''}`} agentId={agentId} initialArtifactId={initialArtifactId} onActivity={onActivity} />;
}
function ArtifactWorkspace({ agentId, initialArtifactId, onActivity }: { agentId: number; initialArtifactId?: string; onActivity?: () => void }) {
  const [items, setItems] = useState<AssistantArtifact[]>([]), [detail, setDetail] = useState<AssistantArtifactDetail | null>(null);
  const [title, setTitle] = useState('Untitled artifact'), [html, setHtml] = useState(''), [request, setRequest] = useState('');
  const [preview, setPreview] = useState(''), [previewRevision, setPreviewRevision] = useState(0);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const alive = useRef(true), active = useRef<AbortController | null>(null), frame = useRef<HTMLIFrameElement | null>(null);
  const pendingGeneration = useRef<{ payload: string; requestId: string } | null>(null);
  const base = '/artifacts';
  async function api<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    return workspaceRequest<T>(agentId,`${base}${path}`,body,method);
  }
  function show(value: AssistantArtifactDetail) {
    setDetail(value); setTitle(value.artifact.title); setHtml(value.version.html);
    // Opening never silently executes imported/model-generated JavaScript.
    setPreview(''); setPreviewRevision(value => value + 1);
  }
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController(); active.current = controller;
    void (async () => {
      const value = await api<{ artifacts: AssistantArtifact[] }>('', 'GET', undefined, controller.signal);
      if (alive.current) setItems(value.artifacts);
      if (initialArtifactId) {
        const selected = await api<AssistantArtifactDetail>(`/${initialArtifactId}`, 'GET', undefined, controller.signal);
        if (alive.current) show(selected);
      }
    })().catch(cause => { if (!controller.signal.aborted) setError(cause.message); }).finally(() => { if (alive.current) setLoading(false); });
    return () => { alive.current = false; controller.abort(); active.current?.abort(); };
  }, [agentId, initialArtifactId]); // A new agent remounts the workspace and discards in-flight state.
  useEffect(() => {
    // Existing application message handlers must never interpret an artifact as
    // a connector callback. This workspace exposes no postMessage capability.
    const rejectArtifactMessage = (event: MessageEvent) => {
      if (frame.current?.contentWindow && event.source === frame.current.contentWindow) event.stopImmediatePropagation();
    };
    window.addEventListener('message', rejectArtifactMessage, true);
    return () => window.removeEventListener('message', rejectArtifactMessage, true);
  }, []);
  async function run(work: (signal: AbortSignal) => Promise<void>) {
    if (busy) return;
    const controller = new AbortController(); active.current = controller;
    setBusy(true); setError('');
    try { await work(controller.signal); } catch (cause) { if (alive.current && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Artifact request failed'); }
    finally { if (alive.current) setBusy(false); }
  }
  async function accept(value: AssistantArtifactDetail) {
    if (!alive.current) return;
    pendingGeneration.current = null;
    onActivity?.();
    show(value); setItems(current => [value.artifact, ...current.filter(item => item.id !== value.artifact.id)]);
  }
  function generate() {
    const payload = JSON.stringify({ title: title.trim(), request: request.trim() });
    if (pendingGeneration.current?.payload !== payload) pendingGeneration.current = { payload, requestId: crypto.randomUUID() };
    const requestId = pendingGeneration.current.requestId;
    // A failed transport may hide a completed, charged generation. Retain the
    // same key until success or an intentional edit creates a different request.
    void run(async signal => accept(await api<AssistantArtifactDetail>('/generate', 'POST', { title, request, requestId }, signal)));
  }
  function open(id: string, version?: number) { void run(async signal => { const value = await api<AssistantArtifactDetail>(`/${id}${version ? `?version=${version}` : ''}`, 'GET', undefined, signal); if (alive.current) show(value); }); }
  const dirty = detail ? title !== detail.artifact.title || html !== detail.version.html : Boolean(html.trim() || request.trim() || title !== 'Untitled artifact');
  useNativeWorkState(dirty, busy || loading);
  const { guard, notice } = useNativeDiscardGuard(dirty, busy || loading);
  return <section aria-label="Artifact workspace" className="nativework-stack">
    <div><h3 className="nativework-strong">Artifact workspace</h3><p className="nativework-muted">Create interactive documents, keep immutable versions, and preview them in an isolated frame. Model generation uses your existing compute and spending controls.</p></div>
    {notice}
    {error && <p role="alert" className="nativework-error">{error}</p>}
    <div className="nativework-stack">
      <aside className="nativework-stack" aria-label="Artifact library">
        <h4 className="nativework-strong">Library</h4>
        <button type="button" className={button} disabled={busy} onClick={() => guard(() => { pendingGeneration.current = null; setDetail(null); setTitle('Untitled artifact'); setHtml(''); setRequest(''); setPreview(''); })}>New document</button>
        {loading ? <p>Loading artifacts…</p> : !items.length && <p className="nativework-muted">No saved artifacts yet.</p>}
        <ul className="nativework-stack">{items.map(item => <li key={item.id}><button type="button" disabled={busy} onClick={() => guard(() => open(item.id))} aria-pressed={detail?.artifact.id === item.id} className={`${button}`}><span>{item.title}</span><span className="nativework-small nativework-muted">Version {item.currentVersion}</span></button></li>)}</ul>
      </aside>
      <div className="nativework-stack">
        <label>Artifact title<input className={field} value={title} maxLength={160} onChange={event => { pendingGeneration.current = null; setTitle(event.target.value); }} disabled={busy} /></label>
        {!detail && <>
          <label>What should the document do?<textarea className={field} value={request} maxLength={4000} onChange={event => { pendingGeneration.current = null; setRequest(event.target.value); }} disabled={busy} placeholder="Build a simple task tracker with add and complete controls" /></label>
          <div className="nativework-row">
            <button type="button" className={button} disabled={busy || !request.trim() || !title.trim()} onClick={generate}>Generate with assistant</button>
            <button type="button" className={button} disabled={busy} onClick={() => guard(() => { pendingGeneration.current = null; setTitle('Interactive counter'); setHtml(ARTIFACT_COUNTER_TEMPLATE); setPreview(''); })}>Use counter template</button>
          </div>
        </>}
        {detail && <div className="nativework-row">
          <label>Version <select aria-label="Artifact version" className={button} disabled={busy || dirty} value={detail.version.version} onChange={event => open(detail.artifact.id, Number(event.target.value))}>{detail.versions.map(version => <option value={version.version} key={version.version}>{version.version} · {version.source}</option>)}</select></label>
          <span>Interaction unverified</span><span className="nativework-small">{detail.version.byteSize.toLocaleString()} bytes</span>
        </div>}
        <label>HTML source<textarea aria-label="HTML source" className={`${field}`} spellCheck={false} value={html} onChange={event => setHtml(event.target.value)} disabled={busy} placeholder="Paste generated HTML here, or use a template." /></label>
        <div className="nativework-row">
          <button type="button" className={button} disabled={busy || !title.trim() || !html.trim()} onClick={() => void run(async signal => accept(detail ? await api<AssistantArtifactDetail>(`/${detail.artifact.id}`, 'PUT', { title, html, expectedVersion: detail.artifact.currentVersion }, signal) : await api<AssistantArtifactDetail>('', 'POST', { title, html, source: html === ARTIFACT_COUNTER_TEMPLATE ? 'template' : 'import' }, signal)))}>{detail ? 'Save new version' : 'Save artifact'}</button>
          <button type="button" className={button} disabled={busy || !html.trim()} onClick={() => { setPreview(html); setPreviewRevision(value => value + 1); }}>Run preview</button>
          {preview && <button type="button" className={button} onClick={() => setPreview('')}>Stop preview</button>}
          {detail && <button type="button" className={button} disabled={busy} onClick={() => void run(async signal => { const id = detail.artifact.id; await api(`/${id}`, 'DELETE', {}, signal); if (alive.current) { setItems(current => current.filter(item => item.id !== id)); setDetail(null); setHtml(''); setPreview(''); setTitle('Untitled artifact'); onActivity?.(); } })}>Delete artifact</button>}
          {busy && <span role="status">Working…</span>}
        </div>
        <p className="nativework-small nativework-muted">Preview is isolated from your account and tools. Run it to check behavior. Saving preserves the document; temporary preview state resets when you stop or reopen it.</p>
        {preview && <iframe ref={frame} key={previewRevision} title="Artifact preview" sandbox={ASSISTANT_ARTIFACT_SANDBOX} {...{ credentialless: '' }} referrerPolicy="no-referrer" srcDoc={assistantArtifactPreview(previewSurface(preview))}  className="nativework-panel nativework-preview" />}
      </div>
    </div>
  </section>;
}
