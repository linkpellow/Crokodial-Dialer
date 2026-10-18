const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { buildSync } = require('esbuild');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-session-api-'));
buildSync({ entryPoints: ['src/renderer/services/assistantApiService.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(directory, 'api.cjs'), define: { 'import.meta.env.VITE_API_BASE': '"https://fixture.invalid"' } });
const apiModule = require(path.join(directory, 'api.cjs'));
const { resumeAssistantConnection, cancelAssistantConnection, readAssistantSessionSettings, assistantSessionUsesOwnerContext, startAssistantSession, sendAssistantMessage, readAssistantConversation } = apiModule;
after(() => fs.rmSync(directory, { recursive: true, force: true }));
global.localStorage = { getItem: () => 'synthetic-token' };
let requests = [], response;
global.window = { dialer: { apiFetch: async (url, options) => { requests.push({ path: new URL(url).pathname, ...options, body: options.body && JSON.parse(options.body) }); return typeof response === 'function' ? response(url,options) : response; } } };
const serve = (data, status = 200) => { requests = []; response = { status, statusText: 'Test', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(status < 400 ? { data } : { error: { message: data } }) }; };

test('environment comes from the server, and missing or malformed status cannot claim sandbox', async () => {
  for (const environment of ['sandbox', 'production']) {
    serve({ environment, memoryEnabled: true, planningEnabled: false, memoryMode: 'persistent' });
    assert.equal((await readAssistantSessionSettings(7)).environment, environment);
    assert.equal(requests[0].path, '/api/ai-agents/7/intelligence/status');
  }
  for (const value of [{}, { environment: 'sandbox' }, { environment: 'unknown', memoryEnabled: true, planningEnabled: true }]) {
    serve(value); await assert.rejects(readAssistantSessionSettings(7), /unavailable/);
  }
});
test('the native API exposes no client-generated conversation-key or reset side channel', () => {
  assert.equal(apiModule.assistantConversationKey, undefined);
  assert.equal(apiModule.forgetAssistantConversationKey, undefined);
  assert.equal(apiModule.disposeAssistantSession, undefined);
});

const storage = () => { const values = new Map(); return { get length() { return values.size; }, key: index => [...values.keys()][index] ?? null, getItem: key => values.get(key) ?? null, setItem: (key,value) => values.set(key,value), removeItem: key => values.delete(key) }; };
const authenticate = () => { global.localStorage=storage();global.sessionStorage=storage();localStorage.setItem('crokodial_auth_token','TEST-token');localStorage.setItem('crokodial_auth_user',JSON.stringify({id:11,tenant_id:9}));requests=[]; };
const reply = (data,status=200,code) => ({status,statusText:'Test',headers:{'Content-Type':'application/json'},body:JSON.stringify(status<400?{data}:{error:{message:data,code}})});
const settings = {environment:'production',memoryEnabled:false,planningEnabled:false,memoryMode:'conversation'};
const unavailable = () => reply('API endpoint not found',404,'NOT_FOUND');

test('chooses current owner conversation after a read-only capability check and retains its route',async()=>{
 authenticate();response=(url,options)=>{const pathname=new URL(url).pathname;
  if(pathname.endsWith('/intelligence/status'))return reply(settings);
  if(pathname.endsWith('/conversation/session'))return reply({sessionId:'current-session',conversationKey:'main:11:9:production'});
  if(options.method==='DELETE')return reply({deleted:true});
  return reply({success:true,message:'Verified current response'});
 };
 const session=await startAssistantSession(7);assert.equal(session,'current-session');
 assert.equal(assistantSessionUsesOwnerContext(7,session),true);
 assert.equal(requests[0].method??'GET','GET');assert.equal(requests[0].path,'/api/ai-agents/7/intelligence/status');
 assert.equal(requests[1].path,'/api/ai-agents/7/conversation/session');assert.deepEqual(requests[1].body,{});
 await sendAssistantMessage(7,session,'Review my meeting');assert.equal(requests[2].path,'/api/ai-agents/7/conversation/message');assert.match(requests[2].body.requestId,/^[a-f0-9-]{36}$/);assert.equal(requests[2].body.audience,undefined);
 assert.equal(requests.length,3);
});
test('a missing owner-conversation capability fails closed without creating a legacy preview session',async()=>{
 authenticate();response=unavailable();
 await assert.rejects(startAssistantSession(7),/API endpoint not found/);
 assert.equal(requests.length,1);assert.equal(requests[0].path,'/api/ai-agents/7/intelligence/status');
 assert.equal(requests.some(request=>request.path.includes('/test/')),false);
});
test('a session without the canonical server conversation identity is never bound',async()=>{
 authenticate();response=url=>new URL(url).pathname.endsWith('/intelligence/status')?reply(settings):reply({sessionId:'orphan-execution-session'});
 await assert.rejects(startAssistantSession(7),/identify the main conversation/);
 assert.throws(()=>assistantSessionUsesOwnerContext(7,'orphan-execution-session'),/Reopen/);
});
for(const failure of [
 ['permission denied',reply('Access denied',403,'FORBIDDEN')],['invalid session',reply('Unauthorized',401,'UNAUTHORIZED')],
 ['missing agent',reply('AI agent not found',404,'NOT_FOUND')],['missing capability code',reply('API endpoint not found',404)],
 ['missing capability endpoint',unavailable()],['generic not found',reply('Not found',404,'NOT_FOUND')],['server unavailable',reply('Temporary outage',503,'UNAVAILABLE')],
 ['malformed status',reply({})],['unrecognized memory mode',reply({...settings,memoryMode:'unknown'})],
 ['transport error',()=>{throw new Error('TEST network interrupted');}],
])test(`does not downgrade on ${failure[0]}`,async()=>{
 authenticate();response=failure[1];await assert.rejects(startAssistantSession(7));assert.equal(requests.length,1);assert.equal(requests[0].path,'/api/ai-agents/7/intelligence/status');assert.notEqual(requests[0].method,'POST');
});
test('never retries a failed canonical session POST through another route',async()=>{
 authenticate();response=url=>new URL(url).pathname.endsWith('/intelligence/status')?reply(settings):unavailable();
 await assert.rejects(startAssistantSession(7),/API endpoint not found/);assert.equal(requests.length,2);assert.equal(requests.filter(item=>item.method==='POST').length,1);
 assert.equal(requests[1].path,'/api/ai-agents/7/conversation/session');assert.equal(requests.some(item=>item.path.includes('/test/')),false);
});
test('never probes, falls back or retries a failed canonical message POST',async()=>{
 authenticate();const sessionId='current-error';response=url=>new URL(url).pathname.endsWith('/intelligence/status')?reply(settings):reply({sessionId,conversationKey:'main:11:9:production'});await startAssistantSession(7);
 response=unavailable();await assert.rejects(sendAssistantMessage(7,sessionId,'Send authorized work'),/API endpoint not found/);
 assert.equal(requests.length,3);assert.equal(requests.filter(item=>item.path.endsWith('/message')).length,1);assert.equal(requests[2].path,'/api/ai-agents/7/conversation/message');assert.equal(requests.some(item=>item.path.includes('/test/')),false);
});
test('an account change during capability discovery stops before POST',async()=>{
 authenticate();response=()=>{localStorage.setItem('crokodial_auth_user',JSON.stringify({id:12,tenant_id:9}));return reply(settings);};await assert.rejects(startAssistantSession(7),/account changed/);assert.equal(requests.length,1);
});
test('session route binding cannot be reused by a different signed-in owner or agent',async()=>{
 authenticate();response=url=>new URL(url).pathname.endsWith('/intelligence/status')?reply(settings):reply({sessionId:'owned-session',conversationKey:'main:11:9:production'});await startAssistantSession(7);const count=requests.length;
 assert.throws(()=>assistantSessionUsesOwnerContext(8,'owned-session'),/Reopen/);
 await assert.rejects(sendAssistantMessage(8,'owned-session','Hello'),/Reopen/);localStorage.setItem('crokodial_auth_user',JSON.stringify({id:12,tenant_id:9}));
 assert.throws(()=>assistantSessionUsesOwnerContext(7,'owned-session'),/Reopen/);
 await assert.rejects(sendAssistantMessage(7,'owned-session','Hello'),/Reopen/);assert.equal(requests.length,count);
});
const actionReceipt = (state='submitted') => reply({success:true,message:`TEST action ${state}`,confirmedOutcomes:[{actionId:'00000000-0000-4000-8000-000000000001',state}]});
const journalKey = (conversationKey='main:11:9:production', environment='production') => `crokodial_assistant_conversation:https://fixture.invalid:9:11:unresolved:${environment}:${encodeURIComponent(conversationKey)}`;
const journal = (conversationKey, environment) => JSON.parse(localStorage.getItem(journalKey(conversationKey, environment)) ?? '[]');
async function openCurrentSession(id='retry-session',status=settings,api={startAssistantSession}) {
 response=url=>new URL(url).pathname.endsWith('/intelligence/status')?reply(status):reply({sessionId:id,conversationKey:`main:11:9:${status.environment}`});
 return api.startAssistantSession(7);
}
test('response loss then explicit retry uses one immutable request UUID and no automatic resend',async()=>{
 authenticate();const session=await openCurrentSession();let effects=0;const accepted=new Set();
 response=(_url,options)=>{const id=JSON.parse(options.body).requestId;if(!accepted.has(id)){accepted.add(id);effects++;throw new Error('TEST response lost after submission');}return actionReceipt();};
 await assert.rejects(sendAssistantMessage(7,session,'Email my test client with subject "TEST private" and message "TEST private body"'));
 const original=requests.at(-1).body.requestId;assert.equal(effects,1);assert.equal(accepted.size,1);assert.equal(journal().length,1);
 assert.deepEqual(Object.keys(journal()[0]).sort(),['conversationKey','createdAt','messageHash','requestId']);assert.equal(JSON.stringify(journal()).includes('private'),false);
 await sendAssistantMessage(7,session,'Email my test client with subject "TEST private" and message "TEST private body"');
 assert.equal(requests.at(-1).body.requestId,original);assert.equal(effects,1);assert.equal(journal().length,0);
});
test('changed text gets its own request while earlier uncertainty remains recoverable',async()=>{
 authenticate();const session=await openCurrentSession();response=()=>{throw new Error('TEST interruption');};
 await assert.rejects(sendAssistantMessage(7,session,'Send TEST first'));const first=requests.at(-1).body.requestId;
 await assert.rejects(sendAssistantMessage(7,session,'Send TEST second'));const second=requests.at(-1).body.requestId;
 assert.notEqual(first,second);assert.equal(journal().length,2);
 await assert.rejects(sendAssistantMessage(7,session,'Send TEST first'));assert.equal(requests.at(-1).body.requestId,first);assert.equal(journal().length,2);
});
test('app restart and replacement server session preserve the logical conversation request, even when plan context changed',async()=>{
 authenticate();const firstSession=await openCurrentSession('before-restart');response=()=>{throw new Error('TEST lost response');};
 await assert.rejects(sendAssistantMessage(7,firstSession,'Send him the TEST quote',['Old client plan']));const first=requests.at(-1).body.requestId;
 delete require.cache[require.resolve(path.join(directory,'api.cjs'))];const restarted=require(path.join(directory,'api.cjs'));
 const nextSession=await openCurrentSession('after-restart',settings,restarted);response=actionReceipt();
 await restarted.sendAssistantMessage(7,nextSession,'Send him the TEST quote',['Different client plan']);
 assert.equal(requests.at(-1).body.requestId,first);assert.equal(requests.at(-1).body.sessionId,'after-restart');assert.equal(journal().length,0);
});
test('upgrading to the canonical main chat migrates uncertain request receipts from the legacy local key',async()=>{
 authenticate();const legacy=crypto.randomUUID(),message='Send the TEST upgrade-safe request';
 const legacyKey='crokodial_assistant_conversation:https://fixture.invalid:9:11:7';localStorage.setItem(legacyKey,legacy);
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(message)),messageHash=Array.from(new Uint8Array(bytes),value=>value.toString(16).padStart(2,'0')).join(''),requestId=crypto.randomUUID();
 localStorage.setItem('crokodial_assistant_conversation:https://fixture.invalid:9:11:7:unresolved:production',JSON.stringify([{requestId,messageHash,conversationKey:legacy,createdAt:1}]));
 const session=await openCurrentSession('canonical-session');assert.equal(journal()[0].conversationKey,'main:11:9:production');assert.equal(localStorage.getItem(legacyKey),null);response=actionReceipt();
 await sendAssistantMessage(7,session,message);assert.equal(requests.at(-1).body.requestId,requestId);assert.equal(journal().length,0);
});
test('the continuous conversation keeps an uncertain request across a replacement execution session',async()=>{
 authenticate();let session=await openCurrentSession('old-execution-session');response=()=>{throw new Error('TEST lost');};
 await assert.rejects(sendAssistantMessage(7,session,'Email my test client'));const original=requests.at(-1).body.requestId;
 session=await openCurrentSession('replacement-execution-session');response=()=>{throw new Error('TEST lost again');};await assert.rejects(sendAssistantMessage(7,session,'Email my test client'));
 assert.equal(requests.at(-1).body.requestId,original);assert.equal(journal().length,1);assert.equal(journal()[0].conversationKey,'main:11:9:production');
});
test('replacement Personal Assistant reuses the prior agent request identity after response loss',async()=>{
 authenticate();response=url=>new URL(url).pathname.endsWith('/intelligence/status')?reply(settings):reply({sessionId:'agent-a-session',conversationKey:'main:11:9:production'});
 const first=await startAssistantSession(7);response=()=>{throw new Error('TEST accepted but response lost');};
 await assert.rejects(sendAssistantMessage(7,first,'Send TEST replacement-safe action'));const original=requests.at(-1).body.requestId;
 response=url=>new URL(url).pathname.endsWith('/intelligence/status')?reply(settings):reply({sessionId:'agent-b-session',conversationKey:'main:11:9:production'});
 const replacement=await startAssistantSession(8);response=actionReceipt();await sendAssistantMessage(8,replacement,'Send TEST replacement-safe action');
 assert.equal(requests.at(-1).body.requestId,original);assert.equal(journal().length,0);
});
test('replacement agent migrates a legacy agent-scoped unresolved journal',async()=>{
 authenticate();const message='Send TEST legacy replacement-safe action',requestId=crypto.randomUUID();
 const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(message)),messageHash=Array.from(new Uint8Array(bytes),value=>value.toString(16).padStart(2,'0')).join('');
 localStorage.setItem('crokodial_assistant_conversation:https://fixture.invalid:9:11:7:unresolved:production',JSON.stringify([{requestId,messageHash,conversationKey:'main:11:9:production',createdAt:1}]));
 response=url=>new URL(url).pathname.endsWith('/intelligence/status')?reply(settings):reply({sessionId:'legacy-agent-b-session',conversationKey:'main:11:9:production'});
 const replacement=await startAssistantSession(8);response=actionReceipt();await sendAssistantMessage(8,replacement,message);
 assert.equal(requests.at(-1).body.requestId,requestId);assert.equal(localStorage.getItem('crokodial_assistant_conversation:https://fixture.invalid:9:11:7:unresolved:production'),null);assert.equal(journal().length,0);
});
test('replacement migration over capacity preserves source receipts and dispatches no message',async()=>{
 authenticate();const sourceKey='crokodial_assistant_conversation:https://fixture.invalid:9:11:7:unresolved:production',conversationKey='main:11:9:production';
 const target=Array.from({length:100},(_,index)=>({requestId:crypto.randomUUID(),messageHash:index.toString(16).padStart(64,'0'),conversationKey,createdAt:index+1}));
 const source=[{requestId:crypto.randomUUID(),messageHash:'f'.repeat(64),conversationKey,createdAt:101}];
 localStorage.setItem(journalKey(),JSON.stringify(target));localStorage.setItem(sourceKey,JSON.stringify(source));
 response=url=>new URL(url).pathname.endsWith('/intelligence/status')?reply(settings):reply({sessionId:'capacity-agent-b',conversationKey});
 await assert.rejects(startAssistantSession(8),/Too many assistant requests/);
 assert.deepEqual(JSON.parse(localStorage.getItem(sourceKey)),source);assert.deepEqual(journal(),target);
 await assert.rejects(sendAssistantMessage(8,'capacity-agent-b','Send TEST capacity action'),/Reopen/);
 assert.equal(requests.filter(item=>item.path.endsWith('/conversation/message')).length,0);
});
for(const failure of ['quota','verification mismatch'])test(`replacement migration ${failure} preserves source receipts and dispatches no message`,async()=>{
 authenticate();const sourceKey='crokodial_assistant_conversation:https://fixture.invalid:9:11:7:unresolved:production',conversationKey='main:11:9:production';
 const source=[{requestId:crypto.randomUUID(),messageHash:'e'.repeat(64),conversationKey,createdAt:1}];localStorage.setItem(sourceKey,JSON.stringify(source));
 const originalSet=localStorage.setItem.bind(localStorage),targetKey=journalKey(),sessionId=failure==='quota'?'quota-agent-b':'mismatch-agent-b';
 localStorage.setItem=(key,value)=>{if(key===targetKey){if(failure==='quota')throw new Error('TEST quota');return;}return originalSet(key,value);};
 response=url=>new URL(url).pathname.endsWith('/intelligence/status')?reply(settings):reply({sessionId,conversationKey});
 try { await assert.rejects(startAssistantSession(8),/could not preserve this request/); }
 finally { localStorage.setItem=originalSet; }
 assert.deepEqual(JSON.parse(localStorage.getItem(sourceKey)),source);assert.equal(localStorage.getItem(targetKey),null);
 await assert.rejects(sendAssistantMessage(8,sessionId,'Send TEST migration failure action'),/Reopen/);
 assert.equal(requests.filter(item=>item.path.endsWith('/conversation/message')).length,0);
});
test('owner, tenant, environment and server conversation isolate pending identities while replacement agents share them',async()=>{
 authenticate();const ids=[];
 for(const [user,tenant,agent,environment] of [[11,9,7,'production'],[12,9,7,'production'],[11,10,7,'production'],[11,9,8,'production'],[11,9,7,'sandbox']]) {
  localStorage.setItem('crokodial_auth_user',JSON.stringify({id:user,tenant_id:tenant}));response=url=>new URL(url).pathname.endsWith('/intelligence/status')?reply({...settings,environment}):reply({sessionId:'same-server-id',conversationKey:`main:${user}:${tenant}:${environment}`});
  await startAssistantSession(agent);response=()=>{throw new Error('TEST lost');};await assert.rejects(sendAssistantMessage(agent,'same-server-id','Send TEST hello'));ids.push(requests.at(-1).body.requestId);
 }
 assert.equal(new Set(ids).size,4);assert.equal(ids[3],ids[0]);
 localStorage.setItem('crokodial_auth_user',JSON.stringify({id:11,tenant_id:9}));const session=await openCurrentSession('same-server-id');response=()=>{throw new Error('TEST lost');};await assert.rejects(sendAssistantMessage(7,session,'Send TEST hello'));assert.equal(requests.at(-1).body.requestId,ids[0]);
});
test('uncertain and malformed outcomes retain UUID; a definitive receipt alone clears it',async()=>{
 authenticate();const session=await openCurrentSession();let original;
 for(const serverResponse of [reply('TEST provider unknown',500,'INTERNAL_ERROR'),reply({success:true}),actionReceipt('unknown'),actionReceipt('executing'),reply({success:true,message:'TEST invalid receipt',confirmedOutcomes:[{state:'submitted'}]}),reply({success:true,message:'TEST malformed receipts',confirmedOutcomes:{state:'submitted'}}),reply({success:true,message:'Original accepted; outcome unverified'})]) {
  response=serverResponse;await sendAssistantMessage(7,session,'Send TEST unresolved').catch(()=>{});original??=requests.at(-1).body.requestId;
  assert.equal(requests.at(-1).body.requestId,original);assert.equal(journal().length,1);
 }
 response=actionReceipt();await sendAssistantMessage(7,session,'Send TEST unresolved');assert.equal(journal().length,0);
 response=actionReceipt();await sendAssistantMessage(7,session,'Send TEST unresolved');assert.notEqual(requests.at(-1).body.requestId,original);
});
for(const status of ['queued','running','unknown'])test(`${status} goal retains the original UUID until a stable saved goal receipt is returned`,async()=>{
 authenticate();const session=await openCurrentSession();const goal={id:'00000000-0000-4000-8000-000000000002',status};response=reply({success:true,message:`TEST goal ${status}`,goal});
 await sendAssistantMessage(7,session,'Prepare TEST goal');const original=requests.at(-1).body.requestId,count=requests.length;assert.equal(journal().length,1);assert.equal(requests.length,count);
 await sendAssistantMessage(7,session,'Prepare TEST goal');assert.equal(requests.at(-1).body.requestId,original);assert.equal(journal().length,1);
 response=reply({success:true,message:'TEST invalid goal receipt',goal:{status:'waiting_approval'}});await sendAssistantMessage(7,session,'Prepare TEST goal');assert.equal(journal().length,1);
 response=reply({success:true,message:'TEST saved waiting goal',goal:{...goal,status:'waiting_approval'}});await sendAssistantMessage(7,session,'Prepare TEST goal');assert.equal(requests.at(-1).body.requestId,original);assert.equal(journal().length,0);
});
test('old uncertain keys never expire into duplicate actions and storage failure blocks only the outgoing message',async()=>{
 authenticate();const session=await openCurrentSession();response=()=>{throw new Error('TEST lost');};await assert.rejects(sendAssistantMessage(7,session,'Send TEST old'));const original=requests.at(-1).body.requestId;
 const key=journalKey(),rows=journal();rows[0].createdAt=1;localStorage.setItem(key,JSON.stringify(rows));
 response=actionReceipt();await sendAssistantMessage(7,session,'Send TEST old');assert.equal(requests.at(-1).body.requestId,original);
 const set=localStorage.setItem;localStorage.setItem=(key,value)=>{if(key.includes(':unresolved:'))throw new Error('TEST quota');set(key,value);};const count=requests.length;
 await assert.rejects(sendAssistantMessage(7,session,'Send TEST new'),/preserve this request/);assert.equal(requests.length,count);
 response=reply(settings);assert.equal((await readAssistantSessionSettings(7)).environment,'production');localStorage.setItem=set;
});
test('an account change during delivery does not acknowledge or display another owner response',async()=>{
 authenticate();const session=await openCurrentSession();response=()=>{localStorage.setItem('crokodial_auth_user',JSON.stringify({id:12,tenant_id:9}));return actionReceipt();};
 await assert.rejects(sendAssistantMessage(7,session,'Send TEST account-bound'),/account changed/);assert.equal(journal().length,1);
});
test('journal capacity never evicts an uncertain receipt and read-only status stays available',async()=>{
 authenticate();const session=await openCurrentSession();const conversationKey='main:11:9:production',records=Array.from({length:100},(_,index)=>({requestId:crypto.randomUUID(),messageHash:index.toString(16).padStart(64,'0'),conversationKey,createdAt:1}));
 localStorage.setItem(journalKey(),JSON.stringify(records));const count=requests.length;
 await assert.rejects(sendAssistantMessage(7,session,'Send TEST overflow'),/unresolved outcomes/);assert.equal(requests.length,count);assert.deepEqual(journal(),records);
 response=reply(settings);assert.equal((await readAssistantSessionSettings(7)).environment,'production');
});
for(const mode of ['none','session'])test(`${mode} memory keeps safe retry identity in the canonical continuous conversation`,async()=>{
 authenticate();const firstSession=await openCurrentSession('before-boundary',{...settings,memoryMode:mode});response=()=>{throw new Error('TEST lost');};await assert.rejects(sendAssistantMessage(7,firstSession,'TEST sensitive text'));const original=requests.at(-1).body.requestId;
 global.sessionStorage=storage();const nextSession=await openCurrentSession('after-boundary',{...settings,memoryMode:mode});response=()=>{throw new Error('TEST lost');};await assert.rejects(sendAssistantMessage(7,nextSession,'TEST sensitive text'));
 assert.equal(requests.at(-1).body.requestId,original);assert.equal(journal().length,1);assert.equal(journal()[0].conversationKey,'main:11:9:production');assert.equal(JSON.stringify(journal()).includes('sensitive'),false);
});

test('restores the authoritative owner transcript without changing route on read failure', async () => {
 authenticate(); const session=await openCurrentSession('saved-conversation');
 const messages=[{sequence:1,id:'user-1',role:'user',content:'TEST user',createdAt:123},{sequence:2,id:'assistant-1',role:'assistant',content:'TEST answer',createdAt:124}];
 response=reply({sessionId:session,messages,hasMore:false});assert.deepEqual((await readAssistantConversation(7,session)).messages,messages);
 assert.equal(requests.at(-1).path,'/api/ai-agents/7/conversation/session/saved-conversation');
 response=reply('Unavailable',503,'UNAVAILABLE');const before=requests.length;
 await assert.rejects(readAssistantConversation(7,session),/Unavailable/);assert.equal(requests.length,before+1);assert.equal(assistantSessionUsesOwnerContext(7,session),true);
 for(const malformed of [{sessionId:'other',messages},{sessionId:session,messages:[{role:'assistant',content:'unsafe'}]}]) {response=reply(malformed);await assert.rejects(readAssistantConversation(7,session),/saved conversation/);}
});
test('progress observation receives the persisted UUID before its message POST and reuses it after response loss', async () => {
 authenticate();const session=await openCurrentSession('progress-session');const observed=[];
 response=()=>{throw new Error('TEST response lost');};
 const observe=requestId=>{assert.equal(journal().at(-1).requestId,requestId);observed.push(requestId);};
 await assert.rejects(sendAssistantMessage(7,session,'TEST progress',[],observe));
 await assert.rejects(sendAssistantMessage(7,session,'TEST progress',[],observe));
 assert.equal(observed.length,2);assert.equal(observed[0],observed[1]);assert.equal(requests.at(-1).body.requestId,observed[0]);
});


test('connection requests restore from server history only, scoped to the selected session',async()=>{
 authenticate();const session=await openCurrentSession('connection-session');const id=crypto.randomUUID();
 const pending={id,originalRequest:'TEST private original request',connectionRequired:{provider:'gmail',capabilities:['mailbox_read'],resumePolicy:'prepare_only'},state:'waiting_connection',createdAt:123};
 response=reply({sessionId:session,messages:[],pendingConnections:[pending],hasMore:false});
 assert.deepEqual((await readAssistantConversation(7,session)).pendingConnections,[{...pending,connectionRequired:{...pending.connectionRequired,capabilities:['send','history','mailbox_read']}}]);
 assert.equal(journal().length,0);
 for(const value of [{...pending,id:'not-a-uuid'},{...pending,state:'send_now'},{...pending,connectionRequired:{...pending.connectionRequired,capabilities:['unknown']}}]){response=reply({sessionId:session,messages:[],pendingConnections:[value],hasMore:false});await assert.rejects(readAssistantConversation(7,session));}
});
test('all OAuth connector continuations survive a native restart with one opaque resume route',async()=>{
 authenticate();const session=await openCurrentSession('connector-restart');
 const requirements=[
  {provider:'google_workspace',capabilities:['sheets_write'],resumePolicy:'prepare_only'},
  {provider:'google_contacts',capabilities:['contacts_read'],resumePolicy:'prepare_only'},
  {provider:'google_calendar',capabilities:['calendar_access'],resumePolicy:'prepare_only'},
  {provider:'calendly',capabilities:['scheduling_access'],resumePolicy:'prepare_only'},
 ];
 const saved=requirements.map((connectionRequired,index)=>({id:crypto.randomUUID(),originalRequest:`TEST connector ${index}`,connectionRequired,state:index===0?'ready':'waiting_connection',createdAt:123+index}));
 response=reply({sessionId:session,messages:[],pendingConnections:saved,hasMore:false});
 const restored=(await readAssistantConversation(7,session)).pendingConnections;
 assert.deepEqual(restored.map(item=>item.connectionRequired.provider),requirements.map(item=>item.provider));
 assert.deepEqual(restored[0].connectionRequired.capabilities,['sheets_read','sheets_write']);
 response=actionReceipt();await resumeAssistantConnection(7,session,restored[0].id);
 assert.equal(requests.at(-1).path,`/api/ai-agents/7/conversation/session/${session}/connections/${restored[0].id}/resume`);
 assert.equal(journal().length,0);
});
test('explicit connection continuation uses opaque retry metadata and stable UUID after response loss',async()=>{
 authenticate();const session=await openCurrentSession('connection-resume');const id=crypto.randomUUID();const observed=[];
 response=()=>{throw new Error('TEST lost resume response');};
 await assert.rejects(resumeAssistantConnection(7,session,id,requestId=>observed.push(requestId)),/lost resume/);
 await assert.rejects(resumeAssistantConnection(7,session,id,requestId=>observed.push(requestId)),/lost resume/);
 assert.equal(observed[0],observed[1]);assert.deepEqual(requests.at(-1).body,{requestId:observed[0]});assert.equal(requests.at(-1).path,`/api/ai-agents/7/conversation/session/connection-resume/connections/${id}/resume`);
 assert.deepEqual(Object.keys(journal()[0]).sort(),['conversationKey','createdAt','messageHash','requestId']);
 assert.equal(JSON.stringify(journal()).includes(id),false);
 response=actionReceipt();await resumeAssistantConnection(7,session,id);assert.equal(journal().length,0);
 response=reply({canceled:true});await cancelAssistantConnection(7,session,id);assert.equal(requests.at(-1).method,'DELETE');
});
test('malformed continuation IDs never invoke a resume endpoint',async()=>{
 authenticate();const session=await openCurrentSession('connection-invalid');const before=requests.length;
 await assert.rejects(resumeAssistantConnection(7,session,'not-a-uuid'),/saved connection/);assert.equal(requests.length,before);
});
