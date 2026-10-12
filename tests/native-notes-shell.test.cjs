const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {_electron:electron}=require('playwright');
const {hideNativeWindows}=require('./fixtures/hide-native-windows.cjs');
(async()=>{
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'native-notes-shell-'));
 const app=await electron.launch({executablePath:process.env.CROKODIAL_APP_EXECUTABLE||require('electron'),args:[path.resolve('.')],env:{...process.env,CROKODIAL_USER_DATA_DIR:profile,CROKODIAL_RENDERER_URL:''}});
 try{
  await hideNativeWindows(app);
  const page=await app.firstWindow();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await app.evaluate(({ipcMain,BrowserWindow})=>{
   for(const window of BrowserWindow.getAllWindows())window.hide();
   global.notesText='Saved native fixture';global.notesRevision=0;global.contactName='Synthetic';global.contactPhone='+12125550123';global.contactReads=0;
   ipcMain.removeHandler('api-fetch');ipcMain.handle('api-fetch',async(_,payload)=>{
    const p=new URL(payload.url).pathname,b=payload.body?JSON.parse(payload.body):{};let data={},status=200;
    if(p==='/api/auth/me')data={id:11,name:'Native Notes fixture',tenant_id:9};
    else if(p==='/api/contacts/workspace')data={contacts:[{id:11,name:'Synthetic Contact',firstName:'Synthetic',lastName:'Contact',phone:'+12125550123',clientStatus:null}],hasMore:false,nextCursor:null};
    else if(p==='/api/contacts')data={contacts:[{id:11,firstName:'Synthetic',lastName:'Contact',e164:'+12125550123'}],pagination:{}};
    else if(p==='/api/appointments')data=[];
    else if(p==='/api/dialer/dispositions')data={dispositions:[{id:1,name:'Appointment'}]};
    else if(p==='/api/dialer/leads/11'){global.contactReads++;data={id:11,firstName:global.contactName,lastName:'Contact',e164:global.contactPhone,call_notes:global.notesText,notes_revision:global.notesRevision};}
    else if(p==='/api/dialer/contacts/11/notes'){global.notesText=b.notes;global.notesRevision++;data={contactId:11,notes:global.notesText,notesRevision:global.notesRevision};}
    else if(p==='/api/dialer/contacts/11/recording-sessions')data={sessions:[]};
    else if(p==='/api/dialer/voice-session'){status=403;data={error:{message:'Calling disabled in isolated native Notes test'}};}
    else if(p==='/api/ai-agents')data=[];
    else if(p==='/api/insurance-plans')data={plans:[]};
    else if(p==='/api/phone-numbers')data=[];
    return{ok:status<400,status,statusText:'Fixture',headers:{'Content-Type':'application/json'},body:JSON.stringify(status<400?{success:true,data}:{success:false,...data})};
   });
  });
  await page.evaluate(()=>{localStorage.setItem('crokodial_auth_token','isolated-notes-shell');localStorage.setItem('crokodial_auth_user',JSON.stringify({id:11,name:'Native Notes fixture',tenant_id:9}));});
  await page.reload();
  await page.getByRole('tab',{name:'Notes',exact:true}).click();
  await page.locator('.workspace-appointments').getByRole('button',{name:'Search',exact:true}).click();
  await page.locator('#notes-contact-search').fill('Synthetic');
  await page.getByRole('button',{name:'Synthetic Contact +12125550123',exact:true}).click();
  assert.equal(await page.locator('#contact-notes').inputValue(),'Saved native fixture');
  await page.locator('#contact-notes').fill('An in-app note that survives workspace navigation.');
  await page.getByRole('tab',{name:'Dialer',exact:true}).click();
  await page.getByRole('tab',{name:'Assistant',exact:true}).click();
  await page.getByRole('tab',{name:'Notes',exact:true}).click();
  assert.equal(await page.locator('#contact-notes').inputValue(),'An in-app note that survives workspace navigation.');
  const saveDeadline=Date.now()+10000;
  while(Date.now()<saveDeadline && (await app.evaluate(()=>global.notesText))!=='An in-app note that survives workspace navigation.') await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(await page.getByRole('button',{name:'Save notes',exact:true}).count(),0);
  assert.equal(await page.getByText('Saved',{exact:true}).count(),0);
  assert.equal(await app.evaluate(()=>global.notesText),'An in-app note that survives workspace navigation.');
  // Background refresh incorporates remote notes and canonical identity without moving the caret.
  await page.locator('#contact-notes').focus();
  await page.locator('#contact-notes').evaluate(editor=>editor.setSelectionRange(4,9,'forward'));
  await app.evaluate(()=>{global.contactName='Updated';global.contactPhone='+12125550999';global.notesText+='\nAppended elsewhere.';global.notesRevision++;});
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});window.dispatchEvent(new Event('focus'));delete document.hidden;});
  await page.waitForFunction(()=>document.querySelector('#contact-notes')?.value.endsWith('Appended elsewhere.'));
  await page.waitForFunction(()=>document.querySelector('.notes-detail-header strong')?.textContent==='Updated Contact');
  assert.match(await page.locator('.notes-detail-header small').innerText(),/999/);
  assert.deepEqual(await page.locator('#contact-notes').evaluate(editor=>[editor.selectionStart,editor.selectionEnd]),[4,9]);
  assert.equal(await page.getByRole('button',{name:/Refresh/}).count(),0);
  fs.mkdirSync('artifacts/native-notes',{recursive:true});await page.screenshot({path:'artifacts/native-notes/built-shell-notes.png'});
  assert.deepEqual(errors,[]);console.log('PASS actual built native Shell: Notes tab/contact search/scoped notes save, mounted navigation preservation, no renderer errors; isolated fixtures, calling disabled.');
 }finally{await app.close();fs.rmSync(profile,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});
