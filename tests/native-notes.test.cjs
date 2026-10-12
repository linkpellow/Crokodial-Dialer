const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { _electron: electron } = require('playwright');
const { hideNativeWindows } = require('./fixtures/hide-native-windows.cjs');

(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crokodial-notes-test-'));
  const project = process.cwd();
  const entry = `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {NotesWorkspace} from ${JSON.stringify(path.join(project,'src/renderer/components/NotesWorkspace.tsx'))};
    import {ContactNotesDrafts} from ${JSON.stringify(path.join(project,'src/renderer/services/contactNotesDrafts.ts'))};
    import {NativeRecordingController} from ${JSON.stringify(path.join(project,'src/renderer/services/nativeRecordingController.ts'))};
    import {notesApi} from ${JSON.stringify(path.join(project,'src/renderer/services/notesApiService.ts'))};
    import ${JSON.stringify(path.join(project,'src/renderer/index.css'))};
    localStorage.setItem('crokodial_auth_token','isolated-notes-token');
    navigator.mediaDevices.getUserMedia = () => { throw new Error('A real microphone must never be requested by the recorder'); };
    const context = new AudioContext(); await context.resume();
    const streams = [440,660].map(frequency => { const oscillator = context.createOscillator(); oscillator.frequency.value = frequency; const output = context.createMediaStreamDestination(); oscillator.connect(output); oscillator.start(); return output.stream; });
    let current = { callId:'synthetic-call', registeredCallId:'registered-synthetic-call', state:'in_call', remoteNumber:'+12125550123',contactId:11,localStream:streams[0],remoteStream:streams[1],isMuted:false,isOnHold:false };
    const engine = {getRecordingCallSnapshot:()=>current, associateRecordingContact:async contact=>{if(contact.id!==11)throw Error('Wrong call contact');}};
    const store = new ContactNotesDrafts(notesApi.save,100);
    const controller = new NativeRecordingController(notesApi,()=>current,job=>{if(job.notes!==undefined)store.receive({contactId:job.contactId,notes:job.notes,notesRevision:job.notesRevision});},1200);
    window.testNotes={store,controller,streams,setMuted:value=>current.isMuted=value,endCall:()=>{current=null;},newCall:()=>{current={callId:'new-call',registeredCallId:'registered-new-call',state:'in_call',remoteNumber:'+12125550123',contactId:11,localStream:streams[0],remoteStream:streams[1],isMuted:false,isOnHold:false};},dispose:()=>{controller.dispose();store.dispose();context.close();}};
    function Harness(){const [tab,setTab]=useState('notes');return <div className='unified-shell'><div className='workspace-container'><section className='workspace-panel' hidden={tab!=='notes'}><NotesWorkspace engine={engine} store={store} recording={controller} onReturnToCall={()=>setTab('dialer')}/></section><section hidden={tab!=='dialer'}>Synthetic connected call<audio id='call-audio'/></section></div><nav className='workspace-nav'><button onClick={()=>setTab('dialer')}>Dialer</button><button onClick={()=>setTab('notes')}>Notes</button></nav></div>;}createRoot(document.getElementById('root')).render(<Harness/>);
  `;
  buildSync({stdin:{contents:entry,resolveDir:project,sourcefile:'native-notes-fixture.tsx',loader:'tsx'},bundle:true,jsx:'automatic',format:'esm',platform:'browser',target:'chrome140',outfile:path.join(directory,'fixture.js'),define:{'import.meta.env.VITE_API_BASE':'"https://fixture.invalid"'},loader:{'.css':'css'}});
  const cssPath=path.join(directory,'fixture.css');
  const css=await require('postcss')([require('tailwindcss')(path.join(project,'tailwind.config.js')),require('autoprefixer')]).process(fs.readFileSync(cssPath,'utf8'),{from:cssPath});
  fs.writeFileSync(cssPath,css.css);
  fs.writeFileSync(path.join(directory,'index.html'),'<html><head><link rel="stylesheet" href="fixture.css"></head><body style="margin:0;background:#152319"><div id="root" style="height:100vh"></div><script type="module" src="fixture.js"></script></body></html>');
  const bootstrap = `
    const {app,BrowserWindow,ipcMain}=require('electron');
    app.setPath('userData',${JSON.stringify(path.join(directory,'profile'))}); app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
    const notes={11:{notes:'Original note',notesRevision:0},12:{notes:'Other contact',notesRevision:0}};const sessions={};global.sessions=sessions;global.clips=[];global.failUpload=false;global.createDelay=0;global.requests=[];
    const reply=(data,status=200)=>({ok:status<400,status,statusText:'Fixture',headers:{'content-type':'application/json'},body:JSON.stringify(status<400?{success:true,data}:{success:false,error:{message:data}})});
    ipcMain.handle('api-fetch',async(_,payload)=>{const url=new URL(payload.url),p=url.pathname,b=payload.body?JSON.parse(payload.body):{};global.requests.push({path:p,method:payload.method,body:b});
      if(p==='/api/contacts/workspace')return reply({contacts:[{id:11,name:'Synthetic Call',firstName:'Synthetic',lastName:'Call',phone:'+12125550123',clientStatus:null},{id:12,name:'Other Contact',firstName:'Other',lastName:'Contact',phone:'+12125550124',clientStatus:null}],hasMore:false,nextCursor:null});
      if(p==='/api/contacts')return reply({contacts:[{id:11,e164:'+12125550123',firstName:'Synthetic',lastName:'Call'},{id:12,e164:'+12125550124',firstName:'Other',lastName:'Contact'}],pagination:{}});
      if(p==='/api/appointments')return reply([11,12].map(id=>({id:100+id,contact_id:id,contact:{id,firstName:id===11?'Synthetic':'Other',lastName:id===11?'Call':'Contact'},scheduled_at:new Date().toISOString(),duration:30,status:'scheduled',appointment_type:'Fixture consultation',follow_up_appointments:[]})));
      if(p==='/api/dialer/dispositions')return reply({dispositions:[{id:1,name:'Appointment'}]});
      if(p==='/api/dialer/recordings/capabilities')return reply({available:true,maxBytes:67108864,maxDurationSeconds:7200,notesMaxCharacters:200000});
      const lead=p.match(/leads\\/(\\d+)$/);if(lead){const id=Number(lead[1]);return reply({id,e164:id===11?'+12125550123':'+12125550124',firstName:id===11?'Synthetic':'Other',lastName:id===11?'Call':'Contact',call_notes:notes[id].notes,notes_revision:notes[id].notesRevision});}
      const saved=p.match(/contacts\\/(\\d+)\\/notes$/);if(saved){const id=Number(saved[1]);notes[id]={notes:b.notes,notesRevision:notes[id].notesRevision+1};return reply({contactId:id,...notes[id]});}
      const collection=p.match(/contacts\\/(\\d+)\\/recording-sessions$/);if(collection){if(payload.method==='POST'){await new Promise(r=>setTimeout(r,global.createDelay));sessions[b.sessionId]={sessionId:b.sessionId,contactId:Number(collection[1]),source:'dialer',callId:b.callId,startedAt:b.startedAt,retainAudio:b.retainAudio,status:'active',segments:[],segmentCount:0,audioAvailable:false,draftNotes:'',totalDurationSeconds:0,totalBytes:0,retryable:false};return reply(sessions[b.sessionId],201);}return reply({sessions:Object.values(sessions).filter(s=>s.contactId===Number(collection[1]))});}
      const resource=p.match(/recording-sessions\\/([^/]+)(.*)$/);if(resource){const s=sessions[resource[1]];if(!s)return reply('Missing fixture session',404);if(resource[2]==='/finalize'){assertMetadata(s,b);s.status='completed';s.endedAt=b.endedAt;s.summary='Final AI summary';notes[s.contactId]={notes:notes[s.contactId].notes+'\\nFinal AI summary',notesRevision:notes[s.contactId].notesRevision+1};Object.assign(s,notes[s.contactId]);}if(resource[2]==='/cancel')s.status='canceled';if(resource[2].endsWith('/retry')){const sequence=Number(resource[2].split('/')[2]);s.segments[sequence].status='completed';s.segments[sequence].retryable=false;}return reply(s);}
      return reply('Unexpected fixture request '+p,404);
    });
    function assertMetadata(s,b){if(b.expectedSegments!==s.segments.length)throw Error('Finalized missing segment');const end=s.segments.at(-1).endOffsetMs;if(Math.abs(Date.parse(b.endedAt)-Date.parse(s.startedAt)-end)>1000)throw Error('Inaccurate capture timestamps');}
    ipcMain.handle('recording-upload-segment',async(_,payload)=>{if(global.failUpload)return reply('Synthetic upload interruption',503);const s=sessions[payload.sessionId];const bytes=Buffer.from(payload.audio);global.clips.push({sequence:payload.sequence,sessionId:payload.sessionId,startOffsetMs:payload.startOffsetMs,endOffsetMs:payload.endOffsetMs,bytes});if(payload.sequence!==s.segments.length)throw Error('Out of order segment');s.segments.push({sequence:payload.sequence,startOffsetMs:payload.startOffsetMs,endOffsetMs:payload.endOffsetMs,status:'completed',summary:'Live synthetic draft',audioAvailable:true,retryable:false});s.segmentCount=s.segments.length;s.audioAvailable=true;s.draftNotes='Live synthetic draft';s.totalBytes+=bytes.length;s.totalDurationSeconds=payload.endOffsetMs/1000;return reply(s,202);});
    // Use the actual preload channel names; handler aliases are installed below by the test.
    ipcMain.handle('window-show',()=>{});ipcMain.handle('window-resize',()=>{});
    app.whenReady().then(()=>{const win=new BrowserWindow({width:380,height:820,show:false,webPreferences:{preload:${JSON.stringify(path.join(project,'dist/main/preload.js'))},contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});win.loadFile(${JSON.stringify(path.join(directory,'index.html'))});});
  `;
  // Keep names in sync with the actual preload implementation, not an invented bridge.
  const preloadSource=fs.readFileSync('src/preload/preload.ts','utf8');
  const uploadChannel=preloadSource.match(/uploadRecordingSegment:[\s\S]*?ipcRenderer.invoke\('([^']+)'/)[1];
  fs.writeFileSync(path.join(directory,'main.cjs'),bootstrap.replace("'recording-upload-segment'",JSON.stringify(uploadChannel)));
  const app=await electron.launch({args:[path.join(directory,'main.cjs')],env:{...process.env}});
  try {
    await hideNativeWindows(app);
    const page=await app.firstWindow();const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')console.error('Fixture renderer:',m.text());});
    const openRecordingDetails = async () => { const toggle = page.getByRole('button', { name: 'Recording details', exact: true }); if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click(); };
    await page.getByRole('button',{name:'Use current call contact',exact:true}).click();
    await page.getByLabel('Notes',{exact:true}).fill('Manual note before recording');
    await page.waitForFunction(()=>window.testNotes.store.get(11)?.status==='saved');
    // Creation latency must not create an offset/timestamp gap.
    await app.evaluate(()=>global.createDelay=1400);
    await page.getByRole('button',{name:'Record call',exact:true}).click();
    await page.getByText('Live synthetic draft',{exact:true}).waitFor({timeout:15000}).catch(async error=>{console.error('Live draft diagnostics',await page.locator('body').innerText(),await page.evaluate(()=>window.testNotes.controller.getSnapshot()),errors);throw error;});
    const recordingSession = await page.evaluate(()=>window.testNotes.controller.getSnapshot().sessionId);
    await page.getByRole('button',{name:'Back to appointments',exact:true}).click();
    await page.locator('[data-appointment-id="112"] .appointment-select').click();
    await page.waitForFunction(()=>document.querySelector('#contact-notes')?.value==='Other contact');
    assert.equal(await page.getByRole('button',{name:'Record call',exact:true}).isDisabled(),true);
    assert.equal(await page.evaluate(()=>window.testNotes.controller.getSnapshot().contact.id),11);
    assert.equal(await page.evaluate(()=>window.testNotes.controller.getSnapshot().sessionId),recordingSession);
    await page.getByRole('button',{name:'Open recording contact',exact:true}).click();
    await openRecordingDetails();
    await page.waitForFunction(()=>document.querySelector('#contact-notes')?.value==='Manual note before recording');
    await page.getByRole('button',{name:'Dialer',exact:true}).click();
    await page.getByRole('button',{name:'Notes',exact:true}).click();
    assert.equal(await page.getByLabel('Notes',{exact:true}).inputValue(),'Manual note before recording');
    await page.getByLabel('Notes',{exact:true}).fill('Manual note edited during recording');
    await page.waitForFunction(()=>window.testNotes.store.get(11)?.status==='saved');
    await page.getByRole('button',{name:'Stop and finish notes',exact:true}).click();
    await page.getByText('Final AI summary',{exact:true}).waitFor({timeout:15000});
    assert.equal(await page.getByLabel('Notes',{exact:true}).inputValue(),'Manual note edited during recording\nFinal AI summary');
    assert.deepEqual(await page.evaluate(()=>window.testNotes.streams.map(s=>s.getTracks()[0].readyState)),['live','live']);
    const clips=await app.evaluate(()=>global.clips.map(c=>({...c,bytes:[...c.bytes]})));
    assert.ok(clips.length>=2,'Multiple independently decodable segments are required');
    fs.mkdirSync('artifacts/native-notes',{recursive:true});
    for(let i=0;i<clips.length;i++){assert.ok(clips[i].bytes.length>0);fs.writeFileSync('artifacts/native-notes/segment-'+i+'.webm',Buffer.from(clips[i].bytes));if(i)assert.ok(clips[i].startOffsetMs<=clips[i-1].endOffsetMs&&clips[i-1].endOffsetMs-clips[i].startOffsetMs<=1000,'No inter-segment gap');}
    fs.writeFileSync('artifacts/native-notes/segment-metadata.json',JSON.stringify(clips.map(({bytes,...metadata})=>({...metadata,byteLength:bytes.length})),null,2));
    await page.screenshot({path:'artifacts/native-notes/notes-completed.png'});
    // Upload failure must stop capture, retain its clip, and retry with the same pinned session.
    await page.evaluate(()=>window.testNotes.newCall());
    await app.evaluate(()=>{global.createDelay=0;global.failUpload=true;});
    await page.getByRole('button',{name:'Record call',exact:true}).click();
    await page.getByText('Synthetic upload interruption',{exact:true}).waitFor({timeout:15000}).catch(async error=>{console.error('Capture retry diagnostics',await page.locator('body').innerText(),await page.evaluate(()=>window.testNotes.controller.getSnapshot()),errors);throw error;});
    assert.equal(await page.evaluate(()=>window.testNotes.controller.hasUnsavedAudio()),true);
    await app.evaluate(()=>global.failUpload=false);
    await page.getByRole('button',{name:'Retry recording work',exact:true}).click();
    await page.waitForFunction(()=>window.testNotes.controller.getSnapshot().phase==='complete',{timeout:15000});
    assert.equal(await page.evaluate(()=>window.testNotes.controller.hasUnsavedAudio()),false);
    const source=await page.evaluate(()=>({tracks:window.testNotes.streams.map(s=>s.getTracks()[0].readyState),phase:window.testNotes.controller.getSnapshot().phase}));
    assert.deepEqual(source,{tracks:['live','live'],phase:'complete'});
    // Muting removes the local side from capture; ending the call finalizes automatically.
    await page.evaluate(()=>window.testNotes.newCall());
    await app.evaluate(()=>global.clips=[]);
    await page.getByRole('button',{name:'Record call',exact:true}).click();
    await page.waitForFunction(()=>window.testNotes.controller.getSnapshot().phase==='recording');
    await page.waitForTimeout(1500);
    await page.evaluate(()=>window.testNotes.setMuted(true));
    await page.waitForTimeout(2500);
    await page.evaluate(()=>window.testNotes.endCall());
    await page.waitForFunction(()=>window.testNotes.controller.getSnapshot().phase==='complete');
    const muted=await app.evaluate(()=>global.clips.map(c=>({...c,bytes:[...c.bytes]})));
    assert.ok(muted.length>=3);
    fs.writeFileSync('artifacts/native-notes/muted-segment.webm',Buffer.from(muted[2].bytes));
    assert.deepEqual(await page.evaluate(()=>window.testNotes.streams.map(s=>s.getTracks()[0].readyState)),['live','live']);
    // Persisted needs-review jobs remain recoverable independently of the capture controller.
    await app.evaluate(()=>{const session=Object.values(global.sessions)[0];session.status='needs_review';session.retryable=true;session.segments[0].status='needs_review';session.segments[0].retryable=true;});
    await openRecordingDetails();
    await page.getByRole('button',{name:'Refresh contact notes',exact:true}).click();
    await page.locator('.notes-history').filter({hasText:'needs review'}).click();
    await page.getByRole('button',{name:'Retry part 1',exact:true}).click();
    await page.getByRole('button',{name:'Retry final notes',exact:true}).click();
    await page.getByRole('heading',{name:'Final AI notes',exact:true}).waitFor();
    assert.deepEqual(errors,[]);
    console.log('PASS native Notes: real two-source MediaRecorder segments, exact timestamps despite slow create, live draft, contact/manual draft across tabs, final summary reconciliation, call-track preservation, bounded upload failure and explicit same-session retry.');
    await page.evaluate(()=>window.testNotes.dispose());
  } finally {await app.close();fs.rmSync(directory,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
