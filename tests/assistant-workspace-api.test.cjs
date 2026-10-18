const {test,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {buildSync}=require('esbuild');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'workspace-workflows-api-'));
buildSync({entryPoints:['src/renderer/services/assistantWorkspaceApi.ts'],bundle:true,platform:'node',format:'cjs',outfile:path.join(temporary,'api.cjs'),define:{'import.meta.env.VITE_API_BASE':'"https://fixture.invalid"'}});
const api=require(path.join(temporary,'api.cjs'));
after(()=>fs.rmSync(temporary,{recursive:true,force:true}));
const response=(data,status=200)=>({ok:status<400,status,statusText:'Test',headers:{'Content-Type':'application/json'},body:JSON.stringify(status<400?{data}:{error:{message:data,code:'TEST_FAILURE'}})});
let requests,serve,events;
beforeEach(()=>{
 const values=new Map([['crokodial_auth_user',JSON.stringify({id:11,tenant_id:9})],['crokodial_auth_token','TEST-token']]);
 global.localStorage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
 requests=[];events=[];serve=response({});
 global.window={dispatchEvent:event=>events.push(event.type),dialer:{apiFetch:async(url,options)=>{requests.push({url,...options,body:options.body&&JSON.parse(options.body)});return typeof serve==='function'?serve(url,options):serve;}}};
});

test('native requests retain desktop bearer and contract headers, same agent paths, and exact email approval revision',async()=>{
 const content={contactId:4,subject:'TEST email',text:'TEST body',html:'<p>TEST body</p>',attachments:[]};
 const revision={expectedRevision:3,contentHash:'a'.repeat(64)};
 await api.updateEmailDraft(7,'saved-draft',content,revision);
 assert.equal(requests[0].url,'https://fixture.invalid/api/ai-agents/7/email-drafts/saved-draft');
 assert.equal(requests[0].method,'PUT');assert.deepEqual(requests[0].body,{content,...revision});
 assert.equal(requests[0].headers.Authorization,'Bearer TEST-token');
 assert.equal(requests[0].headers['x-crokodial-desktop-client'],'crokodial-sms-desktop');
 assert.equal(requests[0].headers['x-crokodial-contract-version'],'2026-02-26.1');
 await api.decideEmailDraft(7,'saved-draft',revision,'approve');
 assert.deepEqual(requests[1].body,{...revision,decision:'approve'});
 serve=response('The preview changed',409);
 await assert.rejects(api.decideEmailDraft(7,'saved-draft',revision,'approve'),/preview changed/);
 assert.equal(requests.length,3); // no retry or alternate approval route
});

test('lost mutation replies are not replayed; supplied request identity stays unchanged',async()=>{
 const input={requestId:'00000000-0000-4000-8000-000000000001',draftId:'draft',expectedRevision:1,contentHash:'b'.repeat(64),dueAt:Date.now()+60000};
 serve=()=>{throw new Error('TEST response lost');};
 await assert.rejects(api.createConditionalFollowUp(7,input),/response lost/);assert.equal(requests.length,1);assert.deepEqual(requests[0].body,input);
 serve=response({followUp:{id:'saved'}});await api.createConditionalFollowUp(7,input);assert.equal(requests[1].body.requestId,input.requestId);
});

test('native Gmail initiation receives only a same-platform one-use link and never opens a web workspace',async()=>{
 const result={authorizationUrl:'https://fixture.invalid/api/auth/google/mail/desktop/authorize?ticket=TEST-opaque',expiresAt:new Date(Date.now()+60000).toISOString()};
 serve=response(result);assert.deepEqual(await api.beginGmailConnection(true),result);
 assert.equal(requests[0].url,'https://fixture.invalid/api/auth/google/mail/desktop/connect');assert.deepEqual(requests[0].body,{history:true});
 assert.equal(result.authorizationUrl.includes('TEST-token'),false);
 for(const authorizationUrl of ['https://evil.invalid/api/auth/google/mail/desktop/authorize?ticket=x','https://fixture.invalid/ai-management','https://fixture.invalid/api/auth/google/mail/desktop/authorize?ticket=x&token=y','https://fixture.invalid/api/auth/google/mail/desktop/authorize?ticket=x&ticket=y','https://fixture.invalid/api/auth/google/mail/desktop/authorize?ticket=x#fragment']){
  serve=response({...result,authorizationUrl});await assert.rejects(api.beginGmailConnection(),/connection link/);
 }
 serve=response({...result,expiresAt:'2000-01-01'});await assert.rejects(api.beginGmailConnection(),/connection link/);
});

test('status failures and account changes never become disconnected or successful stale data',async()=>{
 serve=response({configured:true,connected:false,historyConnected:false});assert.equal((await api.getGmailStatus()).connected,false);
 serve=response({});await assert.rejects(api.getGmailStatus(),/verify the Gmail/);
 serve=response('TEST unavailable',503);await assert.rejects(api.getGmailStatus(),/unavailable/);
 serve=()=>{localStorage.setItem('crokodial_auth_user',JSON.stringify({id:12,tenant_id:9}));return response({items:[{id:'other-owner-data'}]});};
 await assert.rejects(api.listWorkspaceActivity(7),/account changed/);
});

test('path validation blocks leaving the assistant while permitting encoded search text',async()=>{
 for(const route of ['//evil.invalid','/../actions','/%2e%2e/actions','/tools\\other','/tools#fragment'])assert.throws(()=>api.workspaceRequest(7,route),/Invalid/);
 for(const agentId of [-1,0,1.1,NaN])assert.throws(()=>api.workspaceRequest(agentId,'/tools'),/Personal Assistant/);
 assert.equal(requests.length,0);
 await api.searchToolContacts(7,'TEST / name');assert.match(requests[0].url,/query=TEST%20%2F%20name$/);
});

test('screenshot bytes use dedicated IPC and keep their request UUID across explicit retries',async()=>{
 const file=new File([Uint8Array.from([137,80,78,71,13,10,26,10])],'test.png',{type:'image/png'});
 const calls=[];window.dialer.uploadAssistantScreenshot=async payload=>{calls.push(payload);return response({id:'saved-image'});};
 const requestId='00000000-0000-4000-8000-000000000002';
 assert.equal((await api.uploadScreenshot(7,file,requestId)).id,'saved-image');await api.uploadScreenshot(7,file,requestId);
 assert.equal(calls.length,2);assert.equal(calls[0].requestId,calls[1].requestId);assert.equal(calls[0].base64,'iVBORw0KGgo=');assert.equal(calls[0].token,'TEST-token');assert.equal(requests.length,0);
 window.dialer.readAssistantScreenshot=async()=>({ok:true,status:200,statusText:'OK',headers:{},base64:'iVBORw0KGgo=',contentType:'image/png'});
 assert.equal(await api.getScreenshotImage(7,'saved-image'),'data:image/png;base64,iVBORw0KGgo=');
 window.dialer.readAssistantScreenshot=async()=>({ok:true,status:200,statusText:'OK',headers:{},base64:'<script>bad</script>',contentType:'text/html'});
 await assert.rejects(api.getScreenshotImage(7,'saved-image'),/image is invalid/);
 window.dialer.readAssistantScreenshot=async()=>response('TEST expired',401);await assert.rejects(api.getScreenshotImage(7,'saved-image'),/expired/);
 assert.equal(localStorage.getItem('crokodial_auth_token'),null);assert.deepEqual(events,['crokodial:unauthorized']);
});

test('screenshot input errors never invoke native transport',async()=>{
 let calls=0;window.dialer.uploadAssistantScreenshot=async()=>{calls++;return response({});};
 await assert.rejects(api.uploadScreenshot(7,new File(['TEST'],'test.html',{type:'text/html'})),/PNG, JPEG/);
 await assert.rejects(api.uploadScreenshot(7,new File([],'empty.png',{type:'image/png'})),/PNG, JPEG/);
 assert.equal(calls,0);
});

for (const operation of ['upload','read']) test(`late screenshot ${operation} 401 cannot clear a rotated token`,async()=>{
 let release;
 const transport=()=>new Promise(resolve=>{release=resolve;});
 window.dialer.uploadAssistantScreenshot=transport;window.dialer.readAssistantScreenshot=transport;
 const file=new File([Uint8Array.from([137,80,78,71,13,10,26,10])],'test.png',{type:'image/png'});
 const pending=operation==='upload'?api.uploadScreenshot(7,file):api.getScreenshotImage(7,'saved-image');
 for(let turn=0;!release&&turn<10;turn++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(typeof release,'function');
 localStorage.setItem('crokodial_auth_token','TEST-rotated-token');
 release(response('TEST expired',401));
 await assert.rejects(pending,/session changed/);
 assert.equal(localStorage.getItem('crokodial_auth_token'),'TEST-rotated-token');
 assert.deepEqual(events,[]);
});

test('account changes while reading screenshot bytes stop before the native upload',async()=>{
 let calls=0,release;
 window.dialer.uploadAssistantScreenshot=async()=>{calls++;return response({id:'unexpected'});};
 const file=new File(['TEST'],'test.png',{type:'image/png'});
 file.arrayBuffer=()=>new Promise(resolve=>{release=resolve;});
 const pending=api.uploadScreenshot(7,file);
 localStorage.setItem('crokodial_auth_user',JSON.stringify({id:12,tenant_id:9}));
 release(new Uint8Array([137,80,78,71]).buffer);
 await assert.rejects(pending,/account changed/);
 assert.equal(calls,0);assert.deepEqual(events,[]);
});
