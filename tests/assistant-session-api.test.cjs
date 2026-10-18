const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { buildSync } = require('esbuild');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-session-api-'));
buildSync({ entryPoints: ['src/renderer/services/assistantApiService.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(directory, 'api.cjs'), define: { 'import.meta.env.VITE_API_BASE': '"https://fixture.invalid"' } });
const { readAssistantSessionSettings, assistantConversationKey, assistantSessionUsesOwnerContext, forgetAssistantConversationKey, startAssistantSession, sendAssistantMessage, disposeAssistantSession, readAssistantConversation } = require(path.join(directory, 'api.cjs'));
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
test('conversation keys contain no transcript and respect owner, agent, explicit reset and memory lifetime', () => {
  const storage = () => { const values = new Map(); return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; };
  global.localStorage = storage(); global.sessionStorage = storage();
  localStorage.setItem('crokodial_auth_user', JSON.stringify({ id: 11, tenant_id: 9 }));
  const persistent = assistantConversationKey(7, true, 'persistent');
  assert.equal(assistantConversationKey(7, true, 'persistent'), persistent);
  assert.notEqual(assistantConversationKey(8, true, 'persistent'), persistent);
  const sessionOnly = assistantConversationKey(7, true, 'session');
  assert.notEqual(sessionOnly, persistent);
  global.sessionStorage = storage();
  assert.notEqual(assistantConversationKey(7, true, 'session'), sessionOnly);
  assert.equal(assistantConversationKey(7, true, 'persistent'), persistent);
  forgetAssistantConversationKey(7); assert.equal(assistantConversationKey(7), null);
  assert.notEqual(assistantConversationKey(7, true, 'persistent'), persistent);
  assert.equal(assistantConversationKey(7, true, 'none'), null);
  assert.equal(assistantConversationKey(7), null);
  localStorage.setItem('crokodial_auth_user', JSON.stringify({ id: 12, tenant_id: 9 }));
  assert.equal(assistantConversationKey(7), null);
});

const storage = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key,value) => values.set(key,value), removeItem: key => values.delete(key) }; };
const authenticate = () => { global.localStorage=storage();global.sessionStorage=storage();localStorage.setItem('crokodial_auth_token','TEST-token');localStorage.setItem('crokodial_auth_user',JSON.stringify({id:11,tenant_id:9}));requests=[]; };
const reply = (data,status=200,code) => ({status,statusText:'Test',headers:{'Content-Type':'application/json'},body:JSON.stringify(status<400?{data}:{error:{message:data,code}})});
const settings = {environment:'production',memoryEnabled:false,planningEnabled:false,memoryMode:'conversation'};
const unavailable = () => reply('API endpoint not found',404,'NOT_FOUND');

test('chooses current owner conversation after a read-only capability check and retains its route',async()=>{
 authenticate();response=(url,options)=>{const pathname=new URL(url).pathname;
  if(pathname.endsWith('/intelligence/status'))return reply(settings);
  if(pathname.endsWith('/conversation/session'))return reply({sessionId:'current-session'});
  if(options.method==='DELETE')return reply({deleted:true});
  return reply({success:true,message:'Verified current response'});
 };
 const session=await startAssistantSession(7);assert.equal(session,'current-session');
 assert.equal(assistantSessionUsesOwnerContext(7,session),true);
 assert.equal(requests[0].method??'GET','GET');assert.equal(requests[0].path,'/api/ai-agents/7/intelligence/status');
 assert.equal(requests[1].path,'/api/ai-agents/7/conversation/session');assert.match(requests[1].body.conversationKey,/^[a-f0-9-]{36}$/);
 await sendAssistantMessage(7,session,'Review my meeting');assert.equal(requests[2].path,'/api/ai-agents/7/conversation/message');assert.match(requests[2].body.requestId,/^[a-f0-9-]{36}$/);assert.equal(requests[2].body.audience,undefined);
 await disposeAssistantSession(7,session);assert.equal(requests[3].path,'/api/ai-agents/7/conversation/session/current-session');assert.equal(requests.length,4);
});
test('only exact unavailable capability selects private legacy preview before any POST',async()=>{
 authenticate();response=(url,options)=>{const pathname=new URL(url).pathname;
  if(pathname.endsWith('/intelligence/status'))return unavailable();
  if(pathname.endsWith('/test/session'))return reply({sessionId:'legacy-session'});
  if(options.method==='DELETE')return reply({deleted:true});
  return reply({success:true,message:'Private preview prepared.',confirmedOutcomes:[{state:'succeeded'}],appointmentBooked:true,proposedActions:[{name:'message.sms',executed:true}]});
 };
 const session=await startAssistantSession(7);assert.equal(requests.length,2);assert.equal(requests[1].path,'/api/ai-agents/7/test/session');assert.deepEqual(requests[1].body,{});
 assert.equal(assistantSessionUsesOwnerContext(7,session),false);
 const answer=await sendAssistantMessage(7,session,'Draft a message',['Known plan']);assert.equal(requests[2].path,'/api/ai-agents/7/test/message');assert.deepEqual(requests[2].body,{sessionId:session,message:'Draft a message',workspacePlanHistory:['Known plan'],audience:'agent'});
 assert.equal(answer.confirmedOutcomes,undefined);assert.equal(answer.appointmentBooked,undefined);assert.equal(answer.proposedActions[0].executed,undefined);
 await disposeAssistantSession(7,session);assert.equal(requests[3].path,'/api/ai-agents/7/test/session/legacy-session');assert.equal(requests.length,4);
});
for(const failure of [
 ['permission denied',reply('Access denied',403,'FORBIDDEN')],['invalid session',reply('Unauthorized',401,'UNAUTHORIZED')],
 ['missing agent',reply('AI agent not found',404,'NOT_FOUND')],['missing capability code',reply('API endpoint not found',404)],
 ['generic not found',reply('Not found',404,'NOT_FOUND')],['server unavailable',reply('Temporary outage',503,'UNAVAILABLE')],
 ['malformed status',reply({})],['unrecognized memory mode',reply({...settings,memoryMode:'unknown'})],
 ['transport error',()=>{throw new Error('TEST network interrupted');}],
])test(`does not downgrade on ${failure[0]}`,async()=>{
 authenticate();response=failure[1];await assert.rejects(startAssistantSession(7));assert.equal(requests.length,1);assert.equal(requests[0].path,'/api/ai-agents/7/intelligence/status');assert.notEqual(requests[0].method,'POST');
});
for(const legacy of [false,true])test(`never retries a failed ${legacy?'legacy':'current'} session POST through another route`,async()=>{
 authenticate();response=url=>new URL(url).pathname.endsWith('/intelligence/status')?(legacy?unavailable():reply(settings)):unavailable();
 await assert.rejects(startAssistantSession(7),/API endpoint not found/);assert.equal(requests.length,2);assert.equal(requests.filter(item=>item.method==='POST').length,1);
 assert.equal(requests[1].path,`/api/ai-agents/7/${legacy?'test':'conversation'}/session`);
});
for(const legacy of [false,true])test(`never probes, falls back or retries a failed ${legacy?'legacy':'current'} message POST`,async()=>{
 authenticate();const sessionId=legacy?'legacy-error':'current-error';response=url=>new URL(url).pathname.endsWith('/intelligence/status')?(legacy?unavailable():reply(settings)):reply({sessionId});await startAssistantSession(7);
 response=unavailable();await assert.rejects(sendAssistantMessage(7,sessionId,'Send authorized work'),/API endpoint not found/);
 assert.equal(requests.length,3);assert.equal(requests.filter(item=>item.path.endsWith('/message')).length,1);assert.equal(requests[2].path,`/api/ai-agents/7/${legacy?'test':'conversation'}/message`);
});
test('an account change during capability discovery stops before POST',async()=>{
 authenticate();response=()=>{localStorage.setItem('crokodial_auth_user',JSON.stringify({id:12,tenant_id:9}));return reply(settings);};await assert.rejects(startAssistantSession(7),/account changed/);assert.equal(requests.length,1);
});
test('session route binding cannot be reused by a different signed-in owner or agent',async()=>{
 authenticate();response=url=>new URL(url).pathname.endsWith('/intelligence/status')?reply(settings):reply({sessionId:'owned-session'});await startAssistantSession(7);const count=requests.length;
 assert.throws(()=>assistantSessionUsesOwnerContext(8,'owned-session'),/Reopen/);
 await assert.rejects(sendAssistantMessage(8,'owned-session','Hello'),/Reopen/);localStorage.setItem('crokodial_auth_user',JSON.stringify({id:12,tenant_id:9}));
 assert.throws(()=>assistantSessionUsesOwnerContext(7,'owned-session'),/Reopen/);
 await assert.rejects(sendAssistantMessage(7,'owned-session','Hello'),/Reopen/);assert.equal(requests.length,count);
});
for(const legacy of [false,true])test(`reset accepts only the exact ${legacy?'legacy':'current'} missing-session error`,async()=>{
 authenticate();const sessionId=legacy?'legacy-reset':'current-reset';response=url=>new URL(url).pathname.endsWith('/intelligence/status')?(legacy?unavailable():reply(settings)):reply({sessionId});await startAssistantSession(7);
 response=reply('AI agent not found',404,'NOT_FOUND');await assert.rejects(disposeAssistantSession(7,sessionId),/AI agent not found/);
 response=reply(legacy?'Test session not found':'Assistant conversation not found',404,'NOT_FOUND');await disposeAssistantSession(7,sessionId);
 await assert.rejects(sendAssistantMessage(7,sessionId,'Hello'),/Reopen/);
});

const actionReceipt = (state='submitted') => reply({success:true,message:`TEST action ${state}`,confirmedOutcomes:[{actionId:'00000000-0000-4000-8000-000000000001',state}]});
const journal = () => JSON.parse(localStorage.getItem('crokodial_assistant_conversation:https://fixture.invalid:9:11:7:unresolved:production') ?? '[]');
async function openCurrentSession(id='retry-session',status=settings,api={startAssistantSession}) {
 response=url=>new URL(url).pathname.endsWith('/intelligence/status')?reply(status):reply({sessionId:id});
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
test('explicit new conversation never reuses another context request and preserves the old uncertain metadata',async()=>{
 authenticate();let session=await openCurrentSession('old-client-context');response=()=>{throw new Error('TEST lost');};
 await assert.rejects(sendAssistantMessage(7,session,'Email my test client'));const original=requests.at(-1).body.requestId,oldKey=journal()[0].conversationKey;
 response=reply({deleted:true});await disposeAssistantSession(7,session);forgetAssistantConversationKey(7);
 session=await openCurrentSession('new-client-context');response=()=>{throw new Error('TEST lost again');};await assert.rejects(sendAssistantMessage(7,session,'Email my test client'));
 assert.notEqual(requests.at(-1).body.requestId,original);assert.equal(journal().length,2);assert.equal(journal()[0].conversationKey,oldKey);assert.notEqual(journal()[1].conversationKey,oldKey);
});
test('owner, tenant, agent and server environment isolate pending request identities',async()=>{
 authenticate();const ids=[];
 for(const [user,tenant,agent,environment] of [[11,9,7,'production'],[12,9,7,'production'],[11,10,7,'production'],[11,9,8,'production'],[11,9,7,'sandbox']]) {
  localStorage.setItem('crokodial_auth_user',JSON.stringify({id:user,tenant_id:tenant}));response=url=>new URL(url).pathname.endsWith('/intelligence/status')?reply({...settings,environment}):reply({sessionId:'same-server-id'});
  await startAssistantSession(agent);response=()=>{throw new Error('TEST lost');};await assert.rejects(sendAssistantMessage(agent,'same-server-id','Send TEST hello'));ids.push(requests.at(-1).body.requestId);
 }
 assert.equal(new Set(ids).size,5);
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
 const key='crokodial_assistant_conversation:https://fixture.invalid:9:11:7:unresolved:production',rows=journal();rows[0].createdAt=1;localStorage.setItem(key,JSON.stringify(rows));
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
 authenticate();const session=await openCurrentSession();const conversationKey=assistantConversationKey(7),records=Array.from({length:100},(_,index)=>({requestId:crypto.randomUUID(),messageHash:index.toString(16).padStart(64,'0'),conversationKey,createdAt:1}));
 localStorage.setItem('crokodial_assistant_conversation:https://fixture.invalid:9:11:7:unresolved:production',JSON.stringify(records));const count=requests.length;
 await assert.rejects(sendAssistantMessage(7,session,'Send TEST overflow'),/unresolved outcomes/);assert.equal(requests.length,count);assert.deepEqual(journal(),records);
 response=reply(settings);assert.equal((await readAssistantSessionSettings(7)).environment,'production');
});
for(const mode of ['none','session'])test(`${mode} memory stores only retry metadata without restoring a conversation across its boundary`,async()=>{
 authenticate();const firstSession=await openCurrentSession('before-boundary',{...settings,memoryMode:mode});response=()=>{throw new Error('TEST lost');};await assert.rejects(sendAssistantMessage(7,firstSession,'TEST sensitive text'));const original=requests.at(-1).body.requestId;
 global.sessionStorage=storage();const nextSession=await openCurrentSession('after-boundary',{...settings,memoryMode:mode});response=()=>{throw new Error('TEST lost');};await assert.rejects(sendAssistantMessage(7,nextSession,'TEST sensitive text'));
 assert.notEqual(requests.at(-1).body.requestId,original);assert.equal(journal().length,2);assert.equal(JSON.stringify(journal()).includes('sensitive'),false);
});

test('restores the authoritative owner transcript without changing route on read failure', async () => {
 authenticate(); const session=await openCurrentSession('saved-conversation');
 const messages=[{id:'user-1',role:'user',content:'TEST user',createdAt:123},{id:'assistant-1',role:'assistant',content:'TEST answer',createdAt:124}];
 response=reply({sessionId:session,messages});assert.deepEqual((await readAssistantConversation(7,session)).messages,messages);
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
