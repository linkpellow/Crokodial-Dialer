import { useEffect, useRef } from 'react';
import { ArrowLeft } from 'lucide-react';
import { NativeEmailWorkflow } from './NativeEmailWorkflow';
import { NativeConditionalFollowUps } from './NativeConditionalFollowUps';
import { NativeScreenshotWorkflow } from './NativeScreenshotWorkflow';
import { NativeArtifactWorkspace } from './NativeArtifactWorkspace';
import { NativeBackgroundTasks } from './NativeBackgroundTasks';
import { NativeToolControls } from './NativeToolControls';
import { NativeQualification } from './NativeQualification';
import { NativeWorkStateProvider, type NativeWorkState } from './nativeWorkState';
export type { NativeWorkState } from './nativeWorkState';
import './nativework.css';

export type NativeWorkKind = 'email' | 'followup' | 'screenshot' | 'artifact' | 'background';
export interface NativeWorkReviewProps {
  agentId: number;
  kind: NativeWorkKind;
  id?: string;
  onActivity?: () => void;
  onClose?: () => void;
  onStateChange?: (state: NativeWorkState) => void;
}
const titles: Record<NativeWorkKind, string> = {
  email: 'Email', followup: 'Follow-ups', screenshot: 'Screenshot review', artifact: 'Artifacts', background: 'Background tasks',
};

/** Native editors use the same authenticated owner APIs and exact approval bindings as chat. */
export function NativeWorkReview({ agentId, kind, id, onActivity, onClose, onStateChange }: NativeWorkReviewProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [agentId, kind, id]);
  return <section className="nativework" aria-label={`${titles[kind]} review`}>
    <header className="nativework-heading">
      {onClose && <button type="button" onClick={onClose} aria-label="Back to conversation"><ArrowLeft size={15}/></button>}
      <h2 ref={heading} tabIndex={-1}>{titles[kind]}</h2>
    </header>
    <NativeWorkStateProvider key={`${agentId}:${kind}:${id ?? ''}`} onStateChange={onStateChange}>
      {kind === 'email' && <NativeEmailWorkflow agentId={agentId} initialDraftId={id} onActivity={onActivity}/>}
      {kind === 'followup' && <NativeConditionalFollowUps agentId={agentId} initialFollowUpId={id} onActivity={onActivity}/>}
      {kind === 'screenshot' && <NativeScreenshotWorkflow agentId={agentId} initialRecordId={id} onActivity={onActivity}/>}
      {kind === 'artifact' && <NativeArtifactWorkspace agentId={agentId} initialArtifactId={id} onActivity={onActivity}/>}
      {kind === 'background' && <NativeBackgroundTasks agentId={agentId} initialTaskId={id} onActivity={onActivity}/>}
    </NativeWorkStateProvider>
  </section>;
}

export function NativeCapabilitySettings({ agentId, onActivity, onStateChange }: { agentId: number; onActivity?: () => void; onStateChange?: (state: NativeWorkState) => void }) {
  return <section className="nativework" aria-label="Assistant capabilities">
    <NativeWorkStateProvider onStateChange={onStateChange}><NativeToolControls key={`tools:${agentId}`} agentId={agentId} onActivity={onActivity}/></NativeWorkStateProvider>
    <details className="nativework-panel"><summary>Compute and measured model evidence</summary><NativeQualification key={`quality:${agentId}`} agentId={agentId}/></details>
  </section>;
}
