const {test,after,before}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {build}=require('esbuild');
const {_electron:electron}=require('playwright');

const directory=fs.mkdtempSync(path.join(os.tmpdir(),'crokodial-gmail-triage-'));
let app,page;
before(async()=>{
  const entry=path.join(directory,'entry.tsx');
  fs.writeFileSync(entry,`import React from 'react';import{createRoot}from'react-dom/client';import{NativeBackgroundTasks}from ${JSON.stringify(path.resolve('src/renderer/components/assistant-workspace/NativeBackgroundTasks.tsx'))};
    (window as any).calls=[];(window as any).reviews=[];(window as any).dialer={openExternal:async(url:string)=>{(window as any).opened=url;}};
    createRoot(document.getElementById('root')!).render(<NativeBackgroundTasks agentId={7}/>);`);
  const mockApi=`export async function workspaceRequest(agentId:number,route:string,body?:any){(window as any).calls.push({agentId,route,body});
    if(route==='/background')return{tasks:[],notifications:[]};if(route==='/background/gmail-triage'&&body===undefined)return{reviews:(window as any).reviews};
    if(route==='/background/gmail-triage'){const review={id:'11111111-1111-4111-8111-111111111111',agentId:7,authorityAgentId:7,query:body.query,folder:body.folder,pageSize:body.pageSize,maxPages:body.maxPages,maxItems:body.maxItems,timeBudgetMs:body.timeBudgetMs,status:'active',pagesProcessed:2,itemsScanned:40,uniqueMessages:38,uniqueThreads:35,duplicateMessages:2,duplicateThreads:3,omittedCount:0,elapsedMs:1250,hasMore:true,completionReason:null,errorMessage:null,processing:false,counts:{missed:1,unanswered:2,follow_up:1,total:35},results:[{threadId:'thread_1',messageId:'message_1',subject:'TEST renewal question',from:'client@example.test',recipients:{to:['owner@example.test'],cc:[]},observedAt:1700000000000,labels:['INBOX','UNREAD'],sourceId:'gmail-mailbox:test',sourceRevision:'a'.repeat(64),evidenceUrl:'https://mail.google.com/mail/u/0/#all/thread_1',missed:true,unanswered:true,followUp:false,rationale:'latest inbound message is unread'}],resultsTruncated:false,createdAt:1,updatedAt:2};(window as any).reviews=[review];return{review};}
    const match=route.match(/^\\/background\\/gmail-triage\\/([^/]+)\\/(pause|resume|cancel)$/);if(match){const review=(window as any).reviews[0];review.status=match[2]==='pause'?'paused':match[2]==='resume'?'active':'canceled';return{review};}throw new Error('Unexpected route '+route);}`;
  const mockConnection=`import React,{useEffect}from'react';export function NativeGmailConnection({onStatus}:any){useEffect(()=>onStatus({configured:true,connected:true,historyConnected:true,mailboxReadConnected:true,capabilities:['send','history','mailbox_read']}),[onStatus]);return <p>Gmail mailbox read connected</p>;}`;
  const plugin={name:'triage-fixtures',setup(builder){builder.onResolve({filter:/assistantWorkspaceApi$/},()=>({path:'api',namespace:'fixture'}));builder.onResolve({filter:/NativeGmailConnection$/},()=>({path:'gmail',namespace:'fixture'}));builder.onResolve({filter:/nativeWorkState$/},()=>({path:'state',namespace:'fixture'}));builder.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path==='api'?mockApi:args.path==='gmail'?mockConnection:`export function useNativeWorkState(){}`,loader:'tsx',resolveDir:path.resolve('.')}));}};
  await build({entryPoints:[entry],bundle:true,platform:'browser',format:'iife',jsx:'automatic',nodePaths:[path.resolve('node_modules')],plugins:[plugin],outfile:path.join(directory,'fixture.js')});
  fs.writeFileSync(path.join(directory,'index.html'),'<!doctype html><div id="root"></div><script src="fixture.js"></script>');
  fs.writeFileSync(path.join(directory,'main.cjs'),`const{app,BrowserWindow}=require('electron');app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,webPreferences:{contextIsolation:false}});await w.loadFile(${JSON.stringify(path.join(directory,'index.html'))});});`);
  app=await electron.launch({executablePath:require('electron'),args:[path.join(directory,'main.cjs')]});page=await app.firstWindow();
});
after(async()=>{await app?.close().catch(()=>{});fs.rmSync(directory,{recursive:true,force:true});});

test('native comprehensive Gmail review submits bounded controls, renders durable progress, and opens evidence without a mailbox write',async()=>{
  await page.getByLabel('Comprehensive Gmail review').waitFor();
  await page.getByLabel('Exact Gmail triage query').fill('is:unread newer_than:30d');
  await page.getByLabel('Gmail review folder').selectOption('all');
  await page.getByLabel('Gmail review maximum pages').fill('30');
  await page.getByLabel('Gmail review maximum items').fill('600');
  await page.getByLabel('Gmail review time budget').fill('90');
  await page.getByRole('button',{name:'Start comprehensive review'}).click();
  await page.getByText('2/30 pages').waitFor();
  const calls=await page.evaluate(()=>window.calls);const create=calls.find(call=>call.route==='/background/gmail-triage'&&call.body);
  assert.deepEqual({...create.body,requestId:'<uuid>'},{requestId:'<uuid>',query:'is:unread newer_than:30d',folder:'all',pageSize:20,maxPages:30,maxItems:600,timeBudgetMs:90000});
  assert.match(create.body.requestId,/^[\da-f-]{36}$/i);
  assert.equal(calls.some(call=>/send|draft|label|archive|mark-read/i.test(call.route)),false);
  assert.match(await page.getByText(/Missed 1/).innerText(),/Unanswered 2/);
  await page.getByRole('button',{name:'Open Gmail evidence'}).click();
  assert.equal(await page.evaluate(()=>window.opened),'https://mail.google.com/mail/u/0/#all/thread_1');
  await page.getByRole('button',{name:'Pause'}).click();await page.getByText('Paused',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Resume'}).click();await page.getByText('Reviewing',{exact:true}).waitFor();
});
