const {test}=require('node:test');
const assert=require('node:assert/strict');
const {buildSync}=require('esbuild');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'native-notes-state-'));
const entry=`export {ContactNotesDrafts,ContactNotesConflictError} from ${JSON.stringify(path.resolve('src/renderer/services/contactNotesDrafts.ts'))};export {DialerEngine} from ${JSON.stringify(path.resolve('src/core/DialerEngine.ts'))};export {matchesRecordingContact} from ${JSON.stringify(path.resolve('src/renderer/services/nativeRecordingController.ts'))};`;
buildSync({stdin:{contents:entry,loader:'ts',resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',outfile:path.join(temporary,'state.cjs'),define:{'import.meta.env.VITE_API_BASE':'"https://fixture.invalid"'},external:['@telnyx/webrtc']});
// Replace only the SDK module in this isolated process; no signaling or real media is permitted.
const Module=require('node:module'),originalLoad=Module._load;
Module._load=function(name,...rest){if(name==='@telnyx/webrtc')return{TelnyxRTC:class{},SwEvent:{},NOTIFICATION_TYPE:{callUpdate:'callUpdate'}};return originalLoad.call(this,name,...rest);};
const {ContactNotesDrafts,ContactNotesConflictError,DialerEngine,matchesRecordingContact}=require(path.join(temporary,'state.cjs'));
Module._load=originalLoad;
process.on('exit',()=>fs.rmSync(temporary,{recursive:true,force:true}));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};

test('serialized notes preserve typing and AI append received during a save',async()=>{
 const first=deferred(),writes=[];const store=new ContactNotesDrafts(async(id,notes,revision)=>{writes.push({id,notes,revision});if(writes.length===1)return first.promise;return{contactId:id,notes,notesRevision:revision+1};},100000);
 store.receive({contactId:11,notes:'base',notesRevision:0});store.change(11,'manual');const writing=store.flush(11);await Promise.resolve();store.change(11,'manual plus typing');
 first.resolve({contactId:11,notes:'manual\nAI summary',notesRevision:2});assert.equal(await writing,true);assert.equal(store.get(11).draft,'manual plus typing\nAI summary');assert.equal(writes.length,2);assert.equal(writes[1].revision,2);store.dispose();
});
test('conflicting canonical replacement preserves draft until explicit resolution',async()=>{
 const store=new ContactNotesDrafts(async()=>{throw new ContactNotesConflictError({contactId:11,notes:'changed elsewhere',notesRevision:2});},100000);
 store.receive({contactId:11,notes:'base',notesRevision:0});store.change(11,'my draft');assert.equal(await store.flush(11),false);assert.equal(store.get(11).draft,'my draft');assert.equal(store.get(11).status,'conflict');store.resolveConflict(11,'latest');assert.equal(store.get(11).draft,'changed elsewhere');store.dispose();
});
test('disposing account-scoped drafts during an in-flight write cannot restart saving',async()=>{
 const pending=deferred();let writes=0;const store=new ContactNotesDrafts(async()=>{writes++;return pending.promise;},100000);store.receive({contactId:11,notes:'',notesRevision:0});store.change(11,'private');const running=store.flush(11);await Promise.resolve();store.dispose();pending.resolve({contactId:11,notes:'private',notesRevision:1});await running;assert.equal(writes,1);assert.deepEqual(store.getSnapshot(),{});
});
test('recording requires exact phone and contact identity, not an ambiguous name match',()=>{
 const call={remoteNumber:'+12125550123',contactId:11};assert.equal(matchesRecordingContact(call,{id:11,e164:'(212) 555-0123'}),true);assert.equal(matchesRecordingContact(call,{id:12,e164:'+12125550123'}),false);assert.equal(matchesRecordingContact(call,{id:11,e164:'+12125550124'}),false);
});
test('inbound answer passes the acquired stream to the real call and ignores a stale permission result',async()=>{
 let stopped=0,answered=0;const stream={getAudioTracks:()=>[{}],getTracks:()=>[{stop:()=>stopped++}]};const pending=deferred();const oldNavigator=global.navigator;Object.defineProperty(global,'navigator',{value:{mediaDevices:{getUserMedia:()=>pending.promise}},configurable:true});
 const engine=new DialerEngine();const call={id:'inbound',state:'ringing',options:{},answer:async()=>{answered++;assert.equal(call.options.localStream,stream);}};engine._currentCall=call;const answer=engine.answerCall();pending.resolve(stream);await answer;assert.equal(answered,1);assert.equal(stopped,0);
 const second=deferred();global.navigator.mediaDevices.getUserMedia=()=>second.promise;const stale=engine.answerCall();engine._currentCall=null;second.resolve(stream);await stale;assert.equal(answered,1);assert.equal(stopped,1);Object.defineProperty(global,'navigator',{value:oldNavigator,configurable:true});
});
test('active notifications and hold transitions cannot duplicate a registered call',async()=>{
 let registrations=0;const engine=new DialerEngine({onCallLog:async data=>{registrations++;assert.equal(data.direction,'inbound');return{clientCallId:data.clientCallId};}});
 const call={id:'stable-call',state:'active',direction:'inbound',isAudioMuted:false,options:{remoteCallerNumber:'+12125550123'}};engine._currentCall=call;engine._uiState='in_call';await engine.associateRecordingContact({id:11,e164:'+12125550123',name:'Synthetic'});
 engine.handleNotification({type:'callUpdate',call});engine.handleNotification({type:'callUpdate',call});await Promise.resolve();assert.equal(registrations,1);assert.equal(engine.getRecordingCallSnapshot().registeredCallId,'stable-call');
});
