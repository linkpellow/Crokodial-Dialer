import { useNativeWorkState, useNativeDiscardGuard } from './nativeWorkState';
import { previewSurface } from './previewSurface';
import { workspaceRequest } from '../../services/assistantWorkspaceApi';
import { useEffect, useRef, useState } from 'react';
import { emailDraftPreview, EMAIL_ATTACHMENT_MAX_BYTES, EMAIL_ATTACHMENTS_MAX_BYTES, type EmailDraftInput, type EmailDraftDetail, type EmailDraftSummary } from '../../services/assistantWorkspaceTypes';
import type { AssistantArtifact } from '../../services/assistantWorkspaceTypes';
const field='nativework-field';
const button='nativework-button';
const empty:EmailDraftInput={contactId:0,subject:'',text:'',html:'',attachments:[]};
export function NativeEmailWorkflow(props:{agentId:number;initialDraftId?:string;onActivity?:()=>void}) {return <EmailWorkflow key={`${props.agentId}:${props.initialDraftId??''}`} {...props}/>;}
function EmailWorkflow({agentId,initialDraftId,onActivity}:{agentId:number;initialDraftId?:string;onActivity?:()=>void}) {
  const [drafts,setDrafts]=useState<EmailDraftSummary[]>([]),[detail,setDetail]=useState<EmailDraftDetail|null>(null),[content,setContent]=useState<EmailDraftInput>(empty);
  const [capability,setCapability]=useState<{available:boolean;reason:string}|null>(null),[artifacts,setArtifacts]=useState<AssistantArtifact[]>([]),[contacts,setContacts]=useState<Array<{id:number;name:string}>>([]),[threads,setThreads]=useState<Array<{threadId:string}>>([]);
  const [query,setQuery]=useState(''),[busy,setBusy]=useState(false),[dirty,setDirty]=useState(false),[error,setError]=useState('');
  const createKey=useRef<{content:string;id:string}|null>(null);
  const alive=useRef(true),controller=useRef<AbortController|null>(null);
  async function api<T>(path:string,method='GET',body?:unknown):Promise<T> {
    return workspaceRequest<T>(agentId,path,body,method);
  }
  function show(value:EmailDraftDetail) {setDetail(value);setContent({contactId:value.contactId,subject:value.subject,text:value.text,html:value.html,attachments:value.attachments.map(({name,contentType,base64})=>({name,contentType,base64})),replyThreadId:value.replyThreadId,artifact:value.artifact});setDirty(false);setDrafts(items=>[value,...items.filter(item=>item.id!==value.id)]);}
  async function work(task:()=>Promise<void>) {if(busy)return;setBusy(true);setError('');try{await task();}catch(cause){if(alive.current)setError(cause instanceof Error?cause.message:'Email request failed');}finally{if(alive.current)setBusy(false);}}
  useEffect(()=>{alive.current=true;controller.current=new AbortController();void work(async()=>{const loaded=await api<{drafts:EmailDraftSummary[];capability:{available:boolean;reason:string}}>('/email-drafts');if(!alive.current)return;setDrafts(loaded.drafts);setCapability(loaded.capability);if(initialDraftId){const value=await api<EmailDraftDetail>(`/email-drafts/${initialDraftId}`);if(alive.current)show(value);}const library=await api<{artifacts:AssistantArtifact[]}>('/artifacts');if(alive.current)setArtifacts(library.artifacts);});return()=>{alive.current=false;controller.current?.abort();};},[]);
  useNativeWorkState(dirty, busy);
  const { guard, notice } = useNativeDiscardGuard(dirty, busy);
  const edit=(patch:Partial<EmailDraftInput>)=>{setContent(value=>({...value,...patch}));setDirty(true);};
  const frozen=detail!==null&&detail.status!=='draft',expected=detail?{expectedRevision:detail.revision,contentHash:detail.contentHash}:null;
  async function save(){const serialized=JSON.stringify(content);if(createKey.current?.content!==serialized)createKey.current={content:serialized,id:crypto.randomUUID()};const value=await api<EmailDraftDetail>(`/email-drafts${detail?`/${detail.id}`:''}`,detail?'PUT':'POST',detail?{content,...expected}:{content,requestId:createKey.current.id});if(alive.current){show(value);onActivity?.();}}
  async function files(list:FileList|null) {if(!list)return;await work(async()=>{const selected=Array.from(list);if(content.attachments.length+selected.length>3||selected.some(file=>file.size>EMAIL_ATTACHMENT_MAX_BYTES)||selected.reduce((sum,file)=>sum+file.size,0)+content.attachments.reduce((sum,file)=>sum+atob(file.base64).length,0)>EMAIL_ATTACHMENTS_MAX_BYTES)throw new Error('Use at most three attachments: 512 KiB each and 1 MiB total.');
    const added=await Promise.all(selected.map(file=>new Promise<EmailDraftInput['attachments'][number]>((resolve,reject)=>{if(!['application/pdf','image/png','image/jpeg','text/plain'].includes(file.type)){reject(new Error('Choose PDF, PNG, JPEG or plain text files.'));return;}const reader=new FileReader();reader.onerror=()=>reject(new Error('Unable to read attachment'));reader.onload=()=>resolve({name:file.name,contentType:file.type as EmailDraftInput['attachments'][number]['contentType'],base64:String(reader.result).split(',')[1]});reader.readAsDataURL(file);})));if(alive.current)edit({attachments:[...content.attachments,...added]});});}
  return <section aria-label="Email workflow" className="nativework-stack">
    <div><h3 className="nativework-strong">Email draft and review</h3><p className="nativework-muted">Prepare the exact message, inspect the rendered email and attachments, then approve that revision.</p></div>
    {notice}
    {error&&<p role="alert">{error}</p>}{capability&&<p>{capability.reason}</p>}
    <div className="nativework-row"><button className={button} disabled={busy} onClick={()=>guard(()=>{setDetail(null);setContent(empty);setDirty(false);setThreads([]);createKey.current=null;})}>New email</button>{drafts.map(item=><button key={item.id} className={button} disabled={busy} onClick={()=>guard(()=>void work(async()=>{const value=await api<EmailDraftDetail>(`/email-drafts/${item.id}`);if(alive.current)show(value);}))}>{item.subject} · {item.status}</button>)}</div>
    {!detail&&<div className="nativework-stack"><label>Find email recipient<input className={field} value={query} onChange={event=>setQuery(event.target.value)}/></label><button className={button} disabled={busy||query.trim().length<2} onClick={()=>void work(async()=>{const result=await api<{contacts:Array<{id:number;name:string}>}>(`/tools/contacts?query=${encodeURIComponent(query)}`);if(alive.current)setContacts(result.contacts);})}>Find recipient</button><label>Email recipient<select aria-label="Email recipient" className={field} value={content.contactId||''} onChange={event=>{edit({contactId:Number(event.target.value),replyThreadId:undefined});setThreads([]);}}><option value="">Select a saved contact</option>{contacts.map(item=><option key={item.id} value={item.id}>{item.name} · #{item.id}</option>)}</select></label></div>}
    {detail&&!frozen&&<button className={button} disabled={busy} onClick={()=>void work(async()=>{await api(`/email-drafts/${detail.id}`,'DELETE',{});if(alive.current){setDrafts(items=>items.filter(item=>item.id!==detail.id));setDetail(null);setContent(empty);setDirty(false);createKey.current=null;onActivity?.();}})}>Delete unsent draft</button>}
    {detail&&<p>To: <strong>{detail.email}</strong> · From: {detail.mailbox.sender} · Revision {detail.revision}</p>}
    <fieldset disabled={busy||frozen} className="nativework-stack">
      <div className="nativework-row"><button className={button} disabled={!content.contactId} onClick={()=>void work(async()=>{const result=await api<{threads:Array<{threadId:string}>}>(`/email-drafts/threads?contactId=${content.contactId}`);if(alive.current)setThreads(result.threads);})}>Load linked reply threads</button><label>Reply thread<select aria-label="Reply thread" className={field} value={content.replyThreadId??''} onChange={event=>edit({replyThreadId:event.target.value||undefined})}><option value="">New email</option>{content.replyThreadId&&!threads.some(item=>item.threadId===content.replyThreadId)&&<option value={content.replyThreadId}>{content.replyThreadId}</option>}{threads.map(item=><option key={item.threadId} value={item.threadId}>{item.threadId}</option>)}</select></label></div>
      <label>Email subject<input className={field} maxLength={140} value={content.subject} onChange={event=>edit({subject:event.target.value})}/></label>
      <label>Email text<textarea aria-label="Email text" className={`${field}`} maxLength={16000} value={content.text} onChange={event=>edit({text:event.target.value})}/></label>
      <details><summary>Formatting and templates</summary><div className="nativework-stack">
      <label>Saved HTML template<select aria-label="Saved HTML template" className={field} value={content.artifact?.id??''} onChange={event=>{const selected=artifacts.find(item=>item.id===event.target.value);edit({artifact:selected?{id:selected.id,version:selected.currentVersion}:undefined});}}><option value="">Use the HTML below</option>{artifacts.map(item=><option key={item.id} value={item.id}>{item.title} · version {item.currentVersion}</option>)}</select></label>
      <label>Email HTML<textarea aria-label="Email HTML" className={`${field}`} maxLength={131072} value={content.html} disabled={!!content.artifact} onChange={event=>edit({html:event.target.value})}/></label>
      </div></details>
      <label>Email attachments<input className={field} type="file" multiple accept="application/pdf,image/png,image/jpeg,text/plain" onChange={event=>{void files(event.target.files);event.target.value='';}}/></label>
      <ul>{content.attachments.map((item,index)=><li key={`${item.name}:${index}`} className="nativework-row"><span>{item.name}</span><button className={button} onClick={()=>edit({attachments:content.attachments.filter((_,position)=>position!==index)})}>Remove {item.name}</button></li>)}</ul>
    </fieldset>
    <button className={button} disabled={busy||frozen||!capability?.available||!content.contactId||!content.subject.trim()||!content.text.trim()} onClick={()=>void work(save)}>{detail?'Save email revision':'Save email draft'}</button>
    {detail&&<div className="nativework-stack nativework-panel"><p>Saved revision {detail.revision} · {detail.status}{dirty?' · Unsaved changes; save before review':''}</p>
      {detail.html?<iframe title="Email preview" sandbox="" referrerPolicy="no-referrer" srcDoc={emailDraftPreview(previewSurface(detail.html))}  className="nativework-preview"/>:<pre className="nativework-prewrap">{detail.text}</pre>}
      {!!detail.html&&<details><summary>Plain text alternative</summary><pre className="nativework-prewrap">{detail.text}</pre></details>}
      <ul>{detail.attachments.map(item=><li key={item.name}><a className="nativework-link" href={`data:${item.contentType};base64,${item.base64}`} download={item.name}>Download {item.name}</a> · {item.byteSize} bytes · SHA-256 {item.sha256}</li>)}</ul>
      <p className="nativework-small">Saved HTML excludes scripts, forms, external images and unsafe styling. Attachments are fixed bytes in this revision.</p>
      {detail.action?.result&&<p role="status">{detail.action.result.message}</p>}
      {detail.action&&['expired','rejected','failed'].includes(detail.action.state)&&<p>This review is {detail.action.state}. Save a new revision to prepare another approval.</p>}
      {!frozen&&!dirty&&!detail.action&&<button className={button} disabled={busy} onClick={()=>void work(async()=>{const value=await api<EmailDraftDetail>(`/email-drafts/${detail.id}/review`,'POST',expected);if(alive.current){show(value);onActivity?.();}})}>Review exact email</button>}
      {!frozen&&!dirty&&detail.action?.state==='pending'&&<div className="nativework-row"><button className={button} disabled={busy} onClick={()=>void work(async()=>{const value=await api<EmailDraftDetail>(`/email-drafts/${detail.id}/decision`,'POST',{...expected,decision:'approve'});if(alive.current){show(value);onActivity?.();}})}>Approve and submit email</button><button className={button} disabled={busy} onClick={()=>void work(async()=>{const value=await api<EmailDraftDetail>(`/email-drafts/${detail.id}/decision`,'POST',{...expected,decision:'reject'});if(alive.current){show(value);onActivity?.();}})}>Reject email</button></div>}
      {['unknown','submitting'].includes(detail.status)&&<p>Submission cannot be safely repeated. Check your mailbox before preparing another message.</p>}
    </div>}{busy&&<p role="status">Working…</p>}
  </section>;
}
