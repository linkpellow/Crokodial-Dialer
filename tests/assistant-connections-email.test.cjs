const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {buildSync}=require('esbuild');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'workspace-connections-email-'));
for(const name of ['assistantConnections','assistantEmailState'])buildSync({entryPoints:[`src/renderer/services/${name}.ts`],bundle:true,platform:'node',format:'cjs',outfile:path.join(directory,`${name}.cjs`)});
const {parseConnectionRequired,connectionProviderLabel,gmailCapabilityDisclosure,gmailConnectionReady,gmailConnectionLabel,normalizeGmailCapabilities,normalizeGoogleWorkspaceCapabilities,normalizeGoogleContactsCapabilities}=require(path.join(directory,'assistantConnections.cjs'));
const {emailDraftContent,parseOwnerEmailRecipients,exactEmailRevision,validateEmailBatchReview,validateEmailBatchResults}=require(path.join(directory,'assistantEmailState.cjs'));
after(()=>fs.rmSync(directory,{recursive:true,force:true}));
test('connection requirements are typed and never guessed from reply wording',()=>{
 const requirement={provider:'gmail',capabilities:['history','mailbox_read','history'],resumePolicy:'prepare_only',reason:'Read the selected mailbox.'};
 assert.deepEqual(parseConnectionRequired(requirement),{...requirement,capabilities:['send','history','mailbox_read']});
 assert.equal(parseConnectionRequired(undefined),null);
 for(const value of ['connect gmail',{...requirement,provider:'unknown'},{...requirement,capabilities:[]},{...requirement,capabilities:['admin']},{...requirement,resumePolicy:'send_automatically'}])assert.throws(()=>parseConnectionRequired(value),/invalid connection/);
});
test('every OAuth connector restores a typed least-scope continuation requirement',()=>{
 const fixtures=[
  [{provider:'google_workspace',capabilities:['sheets_write'],resumePolicy:'prepare_only',reason:'Sheet review.'},['sheets_read','sheets_write']],
  [{provider:'google_contacts',capabilities:['contacts_write'],resumePolicy:'prepare_only',reason:'Contact review.'},['contacts_read','contacts_write']],
  [{provider:'google_calendar',capabilities:['calendar_access'],resumePolicy:'prepare_only'},['calendar_access']],
  [{provider:'calendly',capabilities:['scheduling_access'],resumePolicy:'prepare_only'},['scheduling_access']],
 ];
 for(const [value,capabilities] of fixtures)assert.deepEqual(parseConnectionRequired(value),{...value,capabilities});
 assert.equal(connectionProviderLabel('google_workspace'),'Google Workspace');
 assert.equal(connectionProviderLabel('google_contacts'),'Google Contacts');
 assert.equal(connectionProviderLabel('google_calendar'),'Google Calendar');
 assert.equal(connectionProviderLabel('calendly'),'Calendly');
 assert.deepEqual(normalizeGoogleWorkspaceCapabilities(['sheets_write']),['sheets_read','sheets_write']);
 assert.deepEqual(normalizeGoogleContactsCapabilities(['contacts_write']),['contacts_read','contacts_write']);
 for(const value of [
  {provider:'google_workspace',capabilities:['contacts_read'],resumePolicy:'prepare_only'},
  {provider:'google_calendar',capabilities:['calendar_access','scheduling_access'],resumePolicy:'prepare_only'},
  {provider:'calendly',capabilities:['calendar_access'],resumePolicy:'prepare_only'},
 ])assert.throws(()=>parseConnectionRequired(value),/invalid connection/);
});
test('status never grants mailbox search from linked-history or cached/send-only permission',()=>{
 const status={configured:true,connected:true,historyConnected:false};
 assert.equal(gmailConnectionReady(status,['send']),true);
 assert.equal(gmailConnectionReady(status,['history']),false);
 assert.equal(gmailConnectionReady({...status,historyConnected:true},['mailbox_read']),false);
 assert.equal(gmailConnectionReady({...status,historyConnected:true,mailboxReadConnected:true},['send','history','mailbox_read']),true);
 assert.equal(gmailConnectionReady({...status,connected:false,historyConnected:true,mailboxReadConnected:true},['send']),false);
 assert.equal(gmailConnectionReady(null,['send']),false);
 assert.equal(gmailConnectionLabel(['mailbox_read'],status),'Connect Gmail send, search and history');
 assert.deepEqual(normalizeGmailCapabilities(['mailbox_read']),['send','history','mailbox_read']);
 assert.match(gmailCapabilityDisclosure(['mailbox_read']),/account identity, Gmail send, and Gmail read-only/);
 assert.match(gmailCapabilityDisclosure(['send']),/account identity and Gmail send/);
});
test('editable draft preserves recipient provenance, fixed attachment bytes and subject while shedding template rerender metadata',()=>{
 const draft={id:'original',contactId:4,email:'client@example.test',subject:'TEST',text:'Text',html:'<p>Text</p>',template:{id:'name',version:3},recipients:{to:[{email:'client@example.test',source:'contact',contactId:4}],cc:[{email:'support@example.test',source:'support_contact',supportContact:{planId:'plan',id:'dept'}}],bcc:[{email:'owner@example.test',name:'Owner',source:'owner_provided'}]},attachments:[{name:'plan.pdf',contentType:'application/pdf',base64:'UEZERg==',sha256:'hash',byteSize:4}],replyThreadId:'thread',revision:2,contentHash:'a'.repeat(64)};
 const content=emailDraftContent(draft);
 assert.deepEqual(content.to,[{contactId:4}]);assert.deepEqual(content.cc,[{supportContact:{planId:'plan',id:'dept'}}]);assert.deepEqual(content.bcc,[{email:'owner@example.test',name:'Owner'}]);
 assert.deepEqual(content.attachments,[{name:'plan.pdf',contentType:'application/pdf',base64:'UEZERg=='}]);assert.equal(content.template,undefined);assert.equal(content.replyThreadId,'thread');
 assert.deepEqual(exactEmailRevision(draft),{draftId:'original',expectedRevision:2,contentHash:'a'.repeat(64)});
 const direct=emailDraftContent({...draft,contactId:null,email:'vendor@example.test',recipients:{to:[{email:'vendor@example.test',name:'Vendor',source:'owner_provided'}],cc:[],bcc:[]}});
 assert.equal('contactId' in direct,false);assert.deepEqual(direct.to,[{email:'vendor@example.test',name:'Vendor'}]);
});
test('owner recipient input rejects header injection, incomplete addresses, duplicates and oversized batches',()=>{
 assert.deepEqual(parseOwnerEmailRecipients('one@example.test; two@example.test'),[{email:'one@example.test'},{email:'two@example.test'}]);
 for(const input of ['one@example.test\r\nBcc: other@example.test','Missing','Owner <one@example.test>','one@example.test,ONE@example.test',Array.from({length:21},(_,i)=>`test${i}@example.test`).join(',')])assert.throws(()=>parseOwnerEmailRecipients(input));
 assert.deepEqual(parseOwnerEmailRecipients(''),[]);
});

test('batch manifest verifies the exact selected set, revision and digest before showing approval',()=>{
 const first={id:'one',revision:1,contentHash:'a'.repeat(64)},second={id:'two',revision:2,contentHash:'b'.repeat(64)};
 assert.deepEqual(validateEmailBatchReview([first,second],[second,first]),[second,first]);
 for(const reviewed of [[first],[first,first],[first,{...second,revision:3}],[first,{...second,contentHash:'c'.repeat(64)}],[first,{...second,id:'three'}]])assert.throws(()=>validateEmailBatchReview([first,second],reviewed),/reviewed set changed/);
 assert.throws(()=>validateEmailBatchReview([first,first],[first,first]),/reviewed set changed/);
});
test('partial or malformed batch receipts cannot claim success or cause a new submission',()=>{
 const selected=[{id:'one'},{id:'two'}];const outcomes=[{draftId:'one',status:'submitted'},{draftId:'two',status:'unknown'}];
 assert.deepEqual(validateEmailBatchResults(selected,outcomes),outcomes);
 for(const results of [[outcomes[0]],[outcomes[0],outcomes[0]],[outcomes[0],{draftId:'two',status:'delivered'}],[outcomes[0],{draftId:'other',status:'submitted'}]])assert.throws(()=>validateEmailBatchResults(selected,results),/receipt is incomplete/);
});
