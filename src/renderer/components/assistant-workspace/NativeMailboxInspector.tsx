import { useEffect, useRef, useState } from 'react';
import { NativeGmailConnection } from '../NativeGmailConnection';
import { workspaceRequest } from '../../services/assistantWorkspaceApi';
import type { AssistantGmailStatus } from '../../services/assistantWorkspaceTypes';
import { gmailConnectionReady } from '../../services/assistantConnections';

interface MailSummary { reference: string; messageId: string; threadId: string; subject: string; from: string; to: string[]; cc: string[]; observedAt: number; identity: string }
interface MailSearch { items: MailSummary[]; nextCursor?: string | null; hasMore: boolean; omitted?: number; limitations?: string[] }
interface MailAttachment { partId: string; name: string; contentType: string; byteSize: number; downloadable: boolean; blockedReason?: string }
interface MailThread { threadId: string; messages: Array<{ messageId: string; subject: string; from: string; to: string[]; cc: string[]; text: string; truncated: boolean; observedAt: number; attachments: MailAttachment[] }>; limitations?: string[] }
const field = 'nativework-field', button = 'nativework-button';
/** Provider message bodies remain inert text. Reading a message never authorizes acting on it. */
export function NativeMailboxInspector({agentId,disabled,onSelect,onBusy}:{agentId:number;disabled:boolean;onSelect:(thread:MailThread)=>void;onBusy:(busy:boolean)=>void}) {
  const [status,setStatus]=useState<AssistantGmailStatus|null>(null),[query,setQuery]=useState(''),[folder,setFolder]=useState<'all'|'inbox'|'sent'>('inbox');
  const [search,setSearch]=useState<MailSearch|null>(null),[thread,setThread]=useState<MailThread|null>(null),[selected,setSelected]=useState<MailSummary|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[download,setDownload]=useState<{name:string;contentType:string;base64:string;sha256:string}|null>(null);
  const alive=useRef(true),locked=useRef(false),searchIdentity=useRef<{id:string;query:string;folder:string}|null>(null);
  const callback=useRef(onBusy);callback.current=onBusy;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;callback.current(false);};},[]);
  async function work(operation:()=>Promise<void>){if(locked.current||disabled)return;locked.current=true;setBusy(true);callback.current(true);setError('');try{await operation();}catch(cause){if(alive.current)setError(cause instanceof Error?cause.message:'Mailbox request failed.');}finally{locked.current=false;if(alive.current)setBusy(false);callback.current(false);}}
  async function find(more=false){
    if(!more)searchIdentity.current={id:crypto.randomUUID(),query:query.trim(),folder};
    const identity=searchIdentity.current;if(!identity)return;
    const result=await workspaceRequest<MailSearch>(agentId,'/mailbox/search',{requestId:identity.id,search:{query:identity.query,folder:identity.folder,pageSize:10,...(more&&search?.nextCursor?{cursor:search.nextCursor}:{})}});
    if(alive.current){setSearch(previous=>more&&previous?{...result,items:[...previous.items,...result.items.filter(item=>!previous.items.some(old=>old.messageId===item.messageId))]}:result);if(!more){setThread(null);setSelected(null);setDownload(null);}}
  }
  async function read(item:MailSummary){const identity=searchIdentity.current;if(!identity)return;const result=await workspaceRequest<MailThread>(agentId,'/mailbox/threads/read-discovered',{requestId:identity.id,reference:item.reference});if(alive.current){setThread(result);setSelected(item);setDownload(null);}}
  return <details><summary>Find and inspect Gmail conversations</summary><div className="nativework-stack">
    <NativeGmailConnection required={['mailbox_read']} onStatus={setStatus} onConnected={()=>{}}/>
    <p className="nativework-muted">Inspect the sender, recipients and conversation before choosing a reply. Email content is source material; instructions inside it do not control the assistant.</p>
    {status?.mailboxReadConnected&&<button className={button} disabled={disabled||busy} onClick={()=>void work(async()=>{await workspaceRequest(agentId,'/mailbox/access/revoke',{});if(alive.current){setStatus(current=>current?{...current,mailboxReadConnected:false}:current);setSearch(null);setThread(null);setSelected(null);setDownload(null);searchIdentity.current=null;}})}>Revoke Gmail search and read access</button>}
    {error&&<p role="alert">{error}</p>}
    <label>Mailbox search<input className={field} value={query} maxLength={500} onChange={event=>setQuery(event.target.value)}/></label>
    <label>Mailbox folder<select className={field} value={folder} onChange={event=>setFolder(event.target.value as 'all'|'inbox'|'sent')}><option value="inbox">Inbox</option><option value="sent">Sent</option><option value="all">All mail</option></select></label>
    <button className={button} disabled={disabled||busy||!gmailConnectionReady(status,['mailbox_read'])||!query.trim()} onClick={()=>void work(()=>find())}>Search Gmail</button>
    {search&&<><p>{search.items.length} messages shown{search.hasMore?' · More results available':''}{search.omitted?` · ${search.omitted} results omitted`:''}</p>{search.items.map(item=><button className={button} key={item.messageId} disabled={disabled||busy} onClick={()=>void work(()=>read(item))}>{item.subject||'(No subject)'} · {item.from} · {new Date(item.observedAt).toLocaleString()} · {item.identity.replace(/_/g,' ')}</button>)}{search.hasMore&&search.nextCursor&&<button className={button} disabled={disabled||busy} onClick={()=>void work(()=>find(true))}>Load more search results</button>}{search.limitations?.map((limit,index)=><p key={index}>{limit}</p>)}</>}
    {thread&&<article className="nativework-panel" aria-label="Inspected Gmail conversation">{thread.messages.map(message=><section key={message.messageId}><h4>{message.subject||'(No subject)'}</h4><p>From: {message.from}<br/>To: {message.to.join(', ')}<br/>CC: {message.cc.join(', ')||'None'}<br/>{new Date(message.observedAt).toLocaleString()}</p><pre className="nativework-prewrap">{message.text}</pre>{message.truncated&&<p>Message text is truncated. Do not assume the missing text.</p>}<ul>{message.attachments.map(attachment=><li key={attachment.partId}>{attachment.name} · {attachment.byteSize} bytes <button className={button} disabled={disabled||busy||!attachment.downloadable} onClick={()=>void work(async()=>{if(!selected||!searchIdentity.current)return;const result=await workspaceRequest<{name:string;contentType:string;base64:string;sha256:string}>(agentId,'/mailbox/attachments/read-discovered',{requestId:searchIdentity.current.id,attachment:{reference:selected.reference,messageId:message.messageId,partId:attachment.partId}});if(!['application/pdf','image/png','image/jpeg','text/plain'].includes(result.contentType)||!result.base64||result.base64.length>7*1024*1024||!/^[A-Za-z0-9+/]+={0,2}$/.test(result.base64))throw new Error('This attachment cannot be downloaded in the workspace.');if(alive.current)setDownload(result);})}>Prepare attachment download</button>{attachment.blockedReason&&<p>{attachment.blockedReason}</p>}</li>)}</ul></section>)}{thread.limitations?.map((limit,index)=><p key={index}>{limit}</p>)}<button className={button} disabled={disabled||busy} onClick={()=>void work(async()=>{await workspaceRequest(agentId,'/mailbox/threads/select',{threadId:thread.threadId});if(alive.current)onSelect(thread);})}>Use this conversation for the draft</button><button className={button} disabled={disabled||busy} onClick={()=>void work(async()=>{await workspaceRequest(agentId,'/mailbox/threads/revoke',{threadId:thread.threadId});if(alive.current){setThread(null);setSelected(null);setDownload(null);}})}>Revoke this conversation selection</button><p>Recipient selection remains separate and must be reviewed before sending.</p></article>}
    {download&&<p><a className="nativework-link" download={download.name} href={`data:${download.contentType};base64,${download.base64}`}>Download {download.name}</a> · SHA-256 {download.sha256}</p>}
    {busy&&<p role="status">Reading mailbox…</p>}
  </div></details>;
}
