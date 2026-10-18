import { workspaceRequest } from '../../services/assistantWorkspaceApi';
import { useEffect, useState } from 'react';
import type { AiQualificationReport } from '../../services/assistantWorkspaceTypes';

export function NativeQualification({agentId}:{agentId:number}) {
  const [report,setReport]=useState<AiQualificationReport|null>(null),[error,setError]=useState(''),[revision,setRevision]=useState(0);
  useEffect(()=>{const abort=new AbortController();setReport(null);setError('');void(async()=>{
    try {const value=await workspaceRequest<AiQualificationReport>(agentId,'/qualification');if(!abort.signal.aborted)setReport(value);
    }catch(cause){if(!abort.signal.aborted)setError(cause instanceof Error?cause.message:'Unable to load qualification evidence');}
  })();return()=>abort.abort();},[agentId,revision]);
  return <section aria-label="Model qualification" className="nativework-stack nativework-panel">
    <div className="nativework-row"><h3 className="nativework-strong">Model qualification</h3><button type="button" onClick={()=>setRevision(n=>n+1)}>Refresh evidence</button></div>
    {error?<p role="alert">{error}</p>:!report?<p role="status">Loading measured evidence...</p>:<>
      <p>{report.routingEnabled?'Hybrid execution is enabled on this server.':'Hybrid execution is disabled on this server.'} Your routing mode is {report.routingMode}. Each request still needs capacity, quota and budget admission.</p>
      <p className="nativework-small">Workflow: {report.task} · {report.channel} · turn limit ${(report.limits.maximumTurnChargeMicros/1000000).toFixed(4)}</p>
      {!report.profiles.length&&<p>No measured routing profiles are available for this account. Model names and connected devices alone do not establish qualification.</p>}
      <ul className="nativework-stack">{report.profiles.map(profile=><li key={profile.id} className="nativework-panel">
        <strong>{profile.modelId}</strong> · {profile.provider} · {profile.economics}<p>{profile.reason}</p>
        <dl className="nativework-grid nativework-small">
          <div><dt>Measured correctness</dt><dd>{profile.qualityScore===null?'Unavailable':`${(profile.qualityScore*100).toFixed(1)}%`}</dd></div>
          <div><dt>Samples / required</dt><dd>{profile.sampleCount??'Unknown'} / {profile.minimumSamples}</dd></div>
          <div><dt>p95 completion</dt><dd>{profile.p95LatencyMs===null?'Unavailable':`${profile.p95LatencyMs} ms`}</dd></div>
          <div><dt>Cost per successful task</dt><dd>{profile.costPerSuccessfulTaskMicros===null?'Unmeasured':`$${(profile.costPerSuccessfulTaskMicros/1000000).toFixed(6)}`}</dd></div>
        </dl><p className="nativework-small">Evidence {profile.fresh?'current':'stale or missing'} · critical failures {profile.criticalFailures} · expires {profile.validUntil?new Date(profile.validUntil).toLocaleString():'unknown'}</p>
      </li>)}</ul>
      <ul className="nativework-small">{report.localDevices.map((device,index)=><li key={index}>{device.name}: {device.online?'online':'offline'} · {device.ready?'ready':'not ready'} · hardware {device.hardwareVerified?'verified':'unverified'} · {device.modelCount} models</li>)}</ul>
    </>}
  </section>;
}
