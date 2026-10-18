const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createAssistantFiles,SCREENSHOT_MAX_BYTES}=require('../dist/main/assistantFiles');
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5eoAAAAASUVORK5CYII=','base64');
const identity={agentId:7,token:'fixture-token',requestId:'00000000-0000-4000-8000-000000000001',recordId:'00000000-0000-4000-8000-000000000002'};
const upload={...identity,filename:'screenshot.png',base64:png.toString('base64')};
test('uploads exact screenshot bytes and retry UUID to fixed authenticated native endpoint',async()=>{
 let calls=0;
 const bridge=createAssistantFiles('https://fixture.invalid',async(url,options)=>{
  calls++;assert.equal(url,'https://fixture.invalid/api/ai-agents/7/screenshot-records');assert.equal(options.method,'POST');assert.equal(options.redirect,'error');
  assert.equal(options.headers.Authorization,'Bearer fixture-token');assert.equal(options.headers['x-crokodial-desktop-client'],'crokodial-sms-desktop');
  assert.equal(options.body.get('requestId'),identity.requestId);assert.equal(options.body.get('screenshot').type,'image/png');
  assert.deepEqual(Buffer.from(await options.body.get('screenshot').arrayBuffer()),png);
  return new Response(JSON.stringify({data:{id:identity.recordId}}));
 });
 const result=await bridge.upload(upload);assert.equal(result.ok,true);assert.equal(JSON.parse(result.body).data.id,identity.recordId);assert.equal(calls,1);
});
test('rejects untrusted identifiers, paths, credentials, formats and oversized images before fetch',async()=>{
 let calls=0;const bridge=createAssistantFiles('https://fixture.invalid',async()=>{calls++;throw Error('unexpected');});
 for(const patch of [{agentId:0},{agentId:1.5},{requestId:'../user'},{token:'x\r\nHeader:y'},{filename:'../secret.png'},{base64:'AAAA'},{base64:png.toString('base64')+'!'},{base64:Buffer.alloc(SCREENSHOT_MAX_BYTES+1).toString('base64')}])assert.equal((await bridge.upload({...upload,...patch})).ok,false);
 assert.equal((await bridge.read({...identity,recordId:'../other'})).ok,false);assert.equal(calls,0);
 assert.throws(()=>createAssistantFiles('http://external.invalid'));assert.throws(()=>createAssistantFiles('https://fixture.invalid/path'));
});
test('downloads bounded authenticated PNG without corrupting bytes; errors remain structured',async()=>{
 const bridge=createAssistantFiles('https://fixture.invalid',async(url)=>{assert.equal(url,`https://fixture.invalid/api/ai-agents/7/screenshot-records/${identity.recordId}/image`);return new Response(png,{headers:{'Content-Type':'image/png'}});});
 const result=await bridge.read(identity);assert.equal(result.ok,true);assert.equal(result.base64,png.toString('base64'));
 const denied=createAssistantFiles('https://fixture.invalid',async()=>new Response(JSON.stringify({error:{message:'No access'}}),{status:403}));
 const error=await denied.read(identity);assert.equal(error.status,403);assert.equal(JSON.parse(error.errorBody).error.message,'No access');assert.equal(error.base64,'');
 for(const response of [new Response('<html/>',{headers:{'content-type':'text/html'}}),new Response('bad',{headers:{'content-type':'image/png'}}),new Response(png,{headers:{'content-type':'image/png','content-length':String(40*1024*1024)}})])assert.equal((await createAssistantFiles('https://fixture.invalid',async()=>response).read(identity)).ok,false);
});
test('limits parallel transfers and releases slots after completion',async()=>{
 const waiting=[];const bridge=createAssistantFiles('https://fixture.invalid',()=>new Promise(resolve=>waiting.push(resolve)));
 const first=bridge.upload(upload),second=bridge.upload(upload);assert.equal((await bridge.upload(upload)).status,0);assert.equal(waiting.length,2);
 waiting.splice(0).forEach(resolve=>resolve(new Response('{}')));assert.equal((await first).ok,true);assert.equal((await second).ok,true);
 const third=bridge.upload(upload);waiting.shift()(new Response('{}'));assert.equal((await third).ok,true);
});
