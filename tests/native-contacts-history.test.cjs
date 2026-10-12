const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build } = require('esbuild');
const { _electron: electron } = require('playwright');
const { hideNativeWindows } = require('./fixtures/hide-native-windows.cjs');

// Mount the real shell and useDialer bridge. Replace only the telephony engine:
// fixtures must never load a Telnyx client, request microphone access, or call out.
const engineFixture = `
export class DialerEngine {
  listeners = new Map(); calls = []; hangups = 0; connectionStatus = 'disconnected'; uiState = 'idle'; isMuted = false; isOnHold = false; currentCall = null; connectedAt = null;
  constructor() { window.fixtureDialer = this; }
  on(type, fn) { const items = this.listeners.get(type) || []; items.push(fn); this.listeners.set(type, items); return this; }
  off(type, fn) { this.listeners.set(type, (this.listeners.get(type) || []).filter(item => item !== fn)); return this; }
  emit(type, payload) { for (const fn of this.listeners.get(type) || []) fn(payload); }
  status() { this.emit('statusUpdate', { connectionStatus:this.connectionStatus, uiState:this.uiState, isMuted:this.isMuted, isOnHold:this.isOnHold, connectionErrorMessage:null }); }
  initializeTelnyxClient() { this.connectionStatus='registered'; this.status(); }
  disconnectTelnyxClient() { this.connectionStatus='disconnected'; }
  async startCall(destinationNumber, callerNumber, callerName, leadContext) {
    if (this.failNextCall) { this.failNextCall=false; throw Error('Fixture call could not start.'); }
    if (['dialing','ringing','in_call','held'].includes(this.uiState)) throw Error('Fixture already has an active call');
    this.calls.push({destinationNumber, callerNumber, callerName, leadContext});
    this.currentCall={id:'fixture-call-'+this.calls.length,direction:'outbound'};
    this.leadContext=leadContext; this.destinationNumber=destinationNumber; this.transition('dialing');
  }
  transition(uiState) {
    this.uiState=uiState;
    if(uiState==='in_call' && this.connectedAt===null)this.connectedAt=Date.now();
    if(['idle','ended'].includes(uiState)){this.currentCall=null;this.connectedAt=null;}
    this.emit('callStateChange',{uiState,currentCall:this.currentCall});this.status();
  }
  hangupCall(){this.hangups++;this.transition('ended');}
  answerCall(){this.transition('in_call');}
  resetToIdle(){this.transition('idle');}
  toggleMute(){this.isMuted=!this.isMuted;this.status();}
  toggleHold(){this.isOnHold=!this.isOnHold;this.transition(this.isOnHold?'held':'in_call');}
  sendDTMF(){} async sendDTMFSequence(){}
  getRecordingCallSnapshot(){return this.currentCall ? {callId:this.currentCall.id,registeredCallId:this.currentCall.id,state:this.uiState,remoteNumber:this.destinationNumber,contactId:Number(this.leadContext?.leadId)||null,localStream:null,remoteStream:null,isMuted:this.isMuted,isOnHold:this.isOnHold}:null;}
  async associateRecordingContact(contact){if(String(contact.id)!==this.leadContext?.leadId)throw Error('Fixture cannot reassign current call');}
}
`;

// Runs inside the isolated fixture main process and only answers local test data.
function installFixture(ipcMain) {
  global.fixture = { requests: [], failContacts: false, failHistory: false, prependHistory: false, holdContacts: false, pendingContacts: [], notes: {}, revisions: {}, contactVersions: {}, contactIndicators: {}, extraContact: false, extraContactCount: 0, deletedContactIds: [] };
  const reply = (data, status = 200) => ({ ok: status < 400, status, statusText: 'Fixture', headers: { 'content-type': 'application/json' }, body: JSON.stringify(status < 400 ? { success: true, data } : { success: false, error: { message: data } }) });
  const contact = id => ({ id, firstName: 'Fixture', lastName: String(id).padStart(3, '0'), e164: '+1212555' + String(id).padStart(4, '0'), last_call_disposition: null, client_status: id % 2 === 0 ? 'active' : null, call_notes: global.fixture.notes[id] || `Canonical note for ${id}.`, notes_revision: global.fixture.revisions[id] || 0 });
  ipcMain.handle('api-fetch', async (_, payload) => {
    const url = new URL(payload.url), p = url.pathname, q = url.searchParams, b = payload.body ? JSON.parse(payload.body) : {}, state = global.fixture;
    state.requests.push({ path: p, query: Object.fromEntries(q), method: payload.method, body: b });
    if (p === '/api/dialer/voice-session') return reply({ loginToken: 'fixture-never-used-by-telephony', expiresAt: new Date(Date.now() + 3600000).toISOString(), loginAfterMs: 0 });
    if (p === '/api/phone-numbers') return reply([{ e164: '+12125550999' }]);
    if (p === '/api/dialer/filter-options') return reply({ dispositions: [], states: [], timezones: [], sources: [] });
    if (p === '/api/dialer/dispositions') return reply({ dispositions: [{ id: 1, name: 'Appointment' }, { id: 2, name: 'Follow Up' }] });
    if (p === '/api/appointments') return reply([]);
    if (p === '/api/ai-agents') return reply([]);
    if (p === '/api/insurance-plans') return reply({ plans: [] });
    if (p === '/api/contacts/workspace/filter-options') return reply({ states:['FL','TX'], dispositions:['Follow Up','Closed'], vendors:['nextgen','self gen'], timezones:['America/New_York','America/Chicago'] });
    if (p === '/api/contacts/workspace') {
      if (state.holdContacts) await new Promise(resolve => state.pendingContacts.push(resolve));
      if (state.failContacts) return reply('Fixture contacts unavailable.', 503);
      const limit = Number(q.get('limit') || 50), offset = Number((q.get('cursor') || '').split('-').pop()) || 0, search = q.get('search') || '', filter = q.get('filter') || 'all';
      let contacts = Array.from({ length: 160 }, (_, index) => {
        const item = contact(index + 1);
        return { id:item.id, name:state.contactVersions[item.id] || item.firstName+' '+item.lastName, firstName:item.firstName, lastName:item.lastName, phone:item.e164, email:`fixture-${item.id}@example.test`, state:item.id%3===0?'TX':'FL', vendor:item.id%2===0?'nextgen':'self gen', timezone:item.id%3===0?'America/Chicago':'America/New_York', clientStatus:item.id%2===0?'client':null, disposition:item.id%5===0?'Follow Up':null, hasAppointment:item.id%5===0, appointmentIndicator:state.contactIndicators[item.id] || (item.id%5===0?(item.id%3===0?'no_show':'follow_up_needed'):null) };
      });
      if(state.extraContact) contacts.push({ ...contacts[0], id:161, name:state.contactVersions[161] || 'Fixture 161', phone:'+12125550161', clientStatus:null, hasAppointment:false, appointmentIndicator:null });
      for(let i=0; i<state.extraContactCount; i++) { const id=162+i; contacts.push({ ...contacts[0], id, name:'Fixture '+id, phone:'+12125550'+id, clientStatus:null, hasAppointment:false, appointmentIndicator:null }); }
      contacts = contacts.filter(item => !state.deletedContactIds.includes(item.id));
      const appliedFilters = {sort:q.get('sort')||'newest',state:q.get('state')||'',disposition:q.get('disposition')||'',vendor:q.get('vendor')||'',timezone:q.get('timezone')||''};
      contacts.forEach(item => { item.sortKey = item.name.toLowerCase(); });
      contacts.sort((a,b) => appliedFilters.sort==='oldest'?a.id-b.id:appliedFilters.sort.startsWith('name_')?((a.sortKey<b.sortKey?-1:a.sortKey>b.sortKey?1:0)*(appliedFilters.sort==='name_desc'?-1:1)||b.id-a.id):b.id-a.id);
      contacts=contacts.filter(item=>['state','disposition','vendor','timezone'].every(key=>!appliedFilters[key]||(appliedFilters[key]==='__none__'?!item[key]:item[key]===appliedFilters[key])));
      if (filter === 'clients') contacts = contacts.filter(item => item.clientStatus === 'client');
      if (filter === 'leads') contacts = contacts.filter(item => item.clientStatus === null);
      if (search) contacts = contacts.filter(item => (item.name+' '+item.phone+' '+item.email).toLowerCase().includes(search.toLowerCase()));
      const selected = contacts.slice(offset, offset + limit), hasMore = offset + limit < contacts.length;
      return reply({ contacts:selected, hasMore, nextCursor:hasMore?'contacts-'+(offset+limit):null, appliedFilters });
    }
    const activity = p.match(/^\/api\/contacts\/workspace\/(\d+)\/activity$/);
    if (activity) {
      if (state.failHistory) return reply('Fixture history unavailable.', 503);
      const contactId = Number(activity[1]), filter = q.get('filter') || 'all', offset = Number((q.get('cursor') || '').split('-').pop()) || 0, limit = Number(q.get('limit') || 50);
      const now = new Date(); now.setHours(14,0,0,0);
      let items = Array.from({length:80},(_,index)=>{
        const occurredAt = new Date(now.getTime() - index * 2 * 3600000).toISOString();
        return index%3===0 ? {id:'appointment:'+index,kind:'appointment',appointmentId:index,occurredAt,scheduledAt:occurredAt,status:'completed',title:'Fixture consultation '+index,durationMinutes:30} : {id:'call:'+index,kind:'call',callLogId:index,occurredAt,direction:index%2===0?'inbound':'outbound',status:'completed',outcome:'Answered',disposition:index%2===0?null:'Follow Up',durationSeconds:60+index,verified:true,source:'telnyx'};
      });
      if(state.prependHistory)items.unshift({id:'call:1000',kind:'call',callLogId:1000,occurredAt:new Date(now.getTime()+60000).toISOString(),direction:'outbound',status:'completed',outcome:'Answered',disposition:'Follow Up',durationSeconds:120,verified:true,source:'telnyx'});
      if(filter==='calls')items=items.filter(item=>item.kind==='call');
      if(filter==='appointments')items=items.filter(item=>item.kind==='appointment');
      const selected=items.slice(offset,offset+limit),hasMore=offset+limit<items.length;
      return reply({contactId,items:selected,hasMore,nextCursor:hasMore?'activity-'+(offset+limit):null});
    }
    if (p === '/api/contacts') {
      if (state.failContacts) return reply('Fixture contacts unavailable.', 503);
      const page = Number(q.get('page') || 1), limit = Number(q.get('limit') || 25), search = q.get('search') || '';
      let contacts = Array.from({ length: 80 }, (_, index) => contact(index + 1));
      if (search) contacts = contacts.filter(item => (item.firstName + ' ' + item.lastName + ' ' + item.e164).toLowerCase().includes(search.toLowerCase()));
      const total = contacts.length;
      return reply({ contacts: contacts.slice((page - 1) * limit, page * limit), pagination: { page, limit, total, totalPages: Math.ceil(total / limit), hasMore: page * limit < total } });
    }
    const lead = p.match(/^\/api\/dialer\/leads\/(\d+)$/);
    if (lead) return reply(contact(Number(lead[1])));
    const save = p.match(/^\/api\/dialer\/contacts\/(\d+)\/notes$/);
    if (save) { const id = Number(save[1]); state.notes[id] = b.notes; state.revisions[id] = (state.revisions[id] || 0) + 1; return reply({ contactId: id, notes: state.notes[id], notesRevision: state.revisions[id] }); }
    if (p.endsWith('/recording-sessions')) return reply({ sessions: [] });
    return reply('Unexpected fixture request ' + p, 404);
  });
  ipcMain.handle('window-show', () => {});
  ipcMain.handle('window-resize', () => {});
  ipcMain.handle('compass-request', () => ({ plans: [] }));
}

(async () => {
  const project = process.cwd();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-contacts-history-'));
  const entry = `import React from 'react';import{createRoot}from'react-dom/client';import{DialerShell}from${JSON.stringify(path.join(project, 'src/renderer/components/DialerShell.tsx'))};import${JSON.stringify(path.join(project, 'src/renderer/index.css'))};
    localStorage.setItem('crokodial_auth_token','fixture-only');localStorage.setItem('crokodial_auth_user',JSON.stringify({id:11,tenant_id:9}));
    navigator.mediaDevices.getUserMedia=()=>{throw Error('A fixture must never request microphone access');};
    createRoot(document.getElementById('root')).render(<DialerShell onLogout={()=>{throw Error('Unexpected fixture logout');}}/>);`;
  await build({ stdin: { contents: entry, resolveDir: project, sourcefile: 'native-contacts-history.tsx', loader: 'tsx' }, bundle: true, jsx: 'automatic', format: 'esm', platform: 'browser', target: 'chrome140', outfile: path.join(directory, 'fixture.js'), define: { 'import.meta.env.VITE_API_BASE': '"https://fixture.invalid"' }, loader: { '.css': 'css' }, plugins: [{ name: 'fixture-engine-only', setup(bundle) { bundle.onResolve({ filter: /(?:^@|\/src)\/core\/DialerEngine(?:\.ts)?$/ }, () => ({ path: 'fixture-engine', namespace: 'fixture' })); bundle.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: engineFixture, loader: 'ts' })); } }] });
  const cssPath = path.join(directory, 'fixture.css');
  const css = await require('postcss')([require('tailwindcss')(path.join(project, 'tailwind.config.js')), require('autoprefixer')]).process(fs.readFileSync(cssPath, 'utf8'), { from: cssPath });
  fs.writeFileSync(cssPath, css.css);
  fs.writeFileSync(path.join(directory, 'index.html'), '<html><head><link rel="stylesheet" href="fixture.css"></head><body style="margin:0;background:#152319"><div id="root" style="height:100vh"></div><script type="module" src="fixture.js"></script></body></html>');
  fs.writeFileSync(path.join(directory, 'main.cjs'), `const{app,BrowserWindow,ipcMain}=require('electron');app.setPath('userData',${JSON.stringify(path.join(directory, 'profile'))});(${installFixture.toString()})(ipcMain);app.whenReady().then(()=>{const win=new BrowserWindow({width:356,height:750,show:false,webPreferences:{preload:${JSON.stringify(path.join(project, 'dist/main/preload.js'))},contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});win.loadFile(${JSON.stringify(path.join(directory, 'index.html'))});});`);
  const app = await electron.launch({ args: [path.join(directory, 'main.cjs')], env: { ...process.env } });
  try {
    await hideNativeWindows(app);
    const page = await app.firstWindow(), errors = [];
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    const eventually = async (condition, message) => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) { if (await condition()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
      assert.fail(message);
    };
    const workspace = page.getByRole('tablist', { name: 'Crokodial workspaces', exact: true });
    await workspace.waitFor();
    assert.deepEqual(await workspace.getByRole('tab').evaluateAll(items => items.map(item => item.getAttribute('aria-label'))), ['Dialer', 'Contacts', 'Assistant', 'Notes', 'Settings']);
    await page.waitForFunction(() => window.fixtureDialer?.connectionStatus === 'registered');
    assert.equal((await app.evaluate(() => global.fixture.requests.filter(item => item.path === '/api/contacts/workspace'))).length, 0, 'Hidden Contacts must not load before first activation');
    await workspace.getByRole('tab', { name: 'Contacts', exact: true }).click();
    const contacts = page.locator('.workspace-contacts'), contactRows = contacts.locator('.workspace-contact-row');
    const search = page.locator('#workspace-contact-search'), contactList = page.locator('.workspace-contacts-list');
    const contactFilters = page.getByRole('tablist', { name: 'Contact type', exact: true });
    await contactRows.first().waitFor();
    await eventually(async () => await contactRows.count() === 50, 'Contacts must use the first canonical cursor page');
    assert.deepEqual(await contactRows.evaluateAll(items=>items.map(item=>Number(item.dataset.contactId))), Array.from({length:50},(_,index)=>160-index), 'Contacts fixture follows canonical ID-descending keyset order');
    assert.equal(await search.isVisible(), false, 'Search field starts collapsed');
    assert.equal(await contacts.getByRole('button', { name: 'Refresh contacts', exact: true }).count(), 0);
    assert.equal(await contacts.locator('.workspace-contact-badge').count(), 0, 'Text badges must be replaced by subtle strips');
    assert.equal(await contacts.locator('[data-contact-id="159"] .workspace-contact-indicator').count(), 0, 'A lead with no appointment has no status tab');
    assert.equal(await contacts.locator('[data-contact-id="160"] .workspace-contact-indicator.client').count(), 1);
    assert.equal(await contacts.locator('[data-contact-id="155"] .workspace-contact-indicator.follow-up').count(), 1);
    assert.equal(await contacts.locator('[data-contact-id="135"] .workspace-contact-indicator.no-show').count(), 1);
    await contacts.getByRole('button', { name: 'Search', exact: true }).click();
    await search.waitFor({ state: 'visible' });
    assert.equal(await search.evaluate(element => document.activeElement === element), true, 'Expanded search receives keyboard focus');
    assert.equal(await search.getAttribute('placeholder'), 'Name or phone');
    await search.press('Escape');
    await search.waitFor({ state: 'hidden' });
    // The filter dialog is a draft: Apply changes the entire server query, not
    // just the current page. Dismissal and Reset must never silently apply edits.
    const filterTrigger = contacts.getByRole('button', { name: /^Filter and sort contacts/ });
    const filterDialog = page.getByRole('dialog', { name: 'Filter & sort', exact: true });
    await filterTrigger.click();
    await filterDialog.waitFor();
    await eventually(async()=>await filterDialog.getByLabel('State',{exact:true}).locator('option').count()>1,'Scoped filter options load');
    const unfilteredIds = await contactRows.evaluateAll(items=>items.map(item=>item.dataset.contactId));
    await filterDialog.getByLabel('Sort by',{exact:true}).selectOption('name_asc');
    await filterDialog.getByLabel('State',{exact:true}).selectOption('FL');
    await filterDialog.getByLabel('Disposition',{exact:true}).selectOption('Follow Up');
    await filterDialog.getByLabel('Vendor',{exact:true}).selectOption('nextgen');
    await filterDialog.getByLabel('Timezone',{exact:true}).selectOption('America/New_York');
    assert.deepEqual(await contactRows.evaluateAll(items=>items.map(item=>item.dataset.contactId)),unfilteredIds,'Draft selections do not change contacts');
    await filterDialog.getByRole('button',{name:'Apply',exact:true}).click();
    await filterDialog.waitFor({state:'hidden'});
    await eventually(async()=>await contactRows.first().getAttribute('data-contact-id')==='10','Combined filters and name sort apply');
    assert.match(await filterTrigger.getAttribute('aria-label'),/4 filters applied/);
    assert.ok((await contactRows.evaluateAll(items=>items.map(item=>Number(item.dataset.contactId)))).every(id=>id%10===0&&id%3!==0));
    await filterTrigger.click();
    await filterDialog.waitFor({state:'visible'});
    fs.mkdirSync('artifacts/native-contacts-history',{recursive:true});
    await page.screenshot({path:'artifacts/native-contacts-history/filter-sort.png',animations:'disabled'});
    const filterBounds=await filterDialog.boundingBox();
    assert.ok(filterBounds.x>=0 && filterBounds.x+filterBounds.width<=356 && filterBounds.y+filterBounds.height<=750,'Popover stays within narrow viewport');
    await filterDialog.getByRole('button',{name:'Reset',exact:true}).click();
    await filterDialog.getByRole('button',{name:'Close filter and sort',exact:true}).click();
    assert.match(await filterTrigger.getAttribute('aria-label'),/4 filters applied/,'Dismissing a reset draft keeps applied filters');
    await filterTrigger.click();
    await filterDialog.getByRole('button',{name:'Reset',exact:true}).click();
    await filterDialog.getByLabel('Sort by',{exact:true}).selectOption('name_asc');
    await filterDialog.getByRole('button',{name:'Apply',exact:true}).click();
    await eventually(async()=>await contactRows.first().getAttribute('data-contact-id')==='1','Name sort covers all contacts after reset');
    await contactList.evaluate(element=>{element.scrollTop=element.scrollHeight;});
    await eventually(async()=>await contactRows.count()>=100,'Name ordering supports older cursor pages');
    const sortedAnchor=contacts.locator('[data-contact-id="85"]');
    await sortedAnchor.scrollIntoViewIfNeeded();
    const sortedOffset=(await sortedAnchor.boundingBox()).y-(await contactList.boundingBox()).y;
    await app.evaluate(()=>{global.fixture.extraContact=true;global.fixture.contactVersions[161]='Fixture 000';});
    await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});window.dispatchEvent(new Event('focus'));});
    await eventually(async()=>await contactRows.first().getAttribute('data-contact-id')==='161','Sorted automatic refresh discovers a name inserted at the beginning');
    assert.ok(Math.abs((await sortedAnchor.boundingBox()).y-(await contactList.boundingBox()).y-sortedOffset)<=1,'Name refresh preserves the visible anchor');
    await filterTrigger.click();
    await filterDialog.getByLabel('Sort by',{exact:true}).selectOption('oldest');
    await filterDialog.getByRole('button',{name:'Apply',exact:true}).click();
    await eventually(async()=>await contactRows.first().getAttribute('data-contact-id')==='1','Oldest sort starts with earliest contact');
    await contacts.getByRole('button',{name:'Search',exact:true}).click();
    await filterTrigger.click();
    await filterDialog.getByLabel('Sort by',{exact:true}).selectOption('name_desc');
    await filterDialog.getByLabel('Sort by',{exact:true}).press('Escape');
    await filterDialog.waitFor({state:'hidden'});
    assert.equal(await search.isVisible(),true,'Escape dismisses the popover without also closing search');
    await search.press('Escape');
    await app.evaluate(()=>{global.fixture.extraContact=false;delete global.fixture.contactVersions[161];});
    await filterTrigger.click();
    await filterDialog.getByRole('button',{name:'Reset',exact:true}).click();
    await filterDialog.getByRole('button',{name:'Apply',exact:true}).click();
    await eventually(async()=>await contactRows.count()===50&&await contactRows.first().getAttribute('data-contact-id')==='160','Reset and Apply restore defaults');
    assert.equal(await filterTrigger.getAttribute('aria-label'),'Filter and sort contacts');
    assert.equal(await contactRows.first().evaluate(element => getComputedStyle(element).backgroundColor), 'rgba(0, 0, 0, 0)', 'Fixture must include production Tailwind preflight instead of native button backgrounds');
    await contactFilters.getByRole('tab', { name: 'Clients', exact: true }).click();
    await eventually(async () => (await contactRows.first().getAttribute('data-contact-id')) === '160', 'Client filter must refresh the list');
    assert.ok((await contactRows.evaluateAll(items => items.map(item => Number(item.dataset.contactId)))).every(id => id % 2 === 0));
    await contactFilters.getByRole('tab', { name: 'All', exact: true }).click();
    await eventually(async () => await contactRows.count() === 50 && await contactRows.nth(1).getAttribute('data-contact-id') === '159', 'All filter must restore both leads and clients');
    await contacts.getByRole('button', { name: 'Search', exact: true }).click();
    await search.fill('Fi');
    await eventually(() => app.evaluate(() => global.fixture.requests.some(item => item.path === '/api/contacts/workspace' && item.query.search === 'Fi')), 'Short search must reach the canonical workspace endpoint');
    await search.fill('Fixture');
    await eventually(() => app.evaluate(() => global.fixture.requests.some(item => item.path === '/api/contacts/workspace' && item.query.search === 'Fixture')), 'Search must refresh after debounce');
    await contactFilters.getByRole('tab', { name: 'All', exact: true }).click();
    await eventually(async () => await contactRows.count() === 50 && await contactRows.nth(1).getAttribute('data-contact-id') === '159', 'All filter must restore all contacts');
    // Scrolling loads the next opaque cursor without replacing or duplicating rows.
    await contactList.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await eventually(async () => await contactRows.count() >= 100, 'Contacts must load the next cursor page');
    const ids = await contactRows.evaluateAll(items => items.map(item => item.dataset.contactId));
    assert.equal(new Set(ids).size, ids.length);
    const contactRequests = await app.evaluate(() => global.fixture.requests.filter(item => item.path === '/api/contacts/workspace'));
    assert.ok(contactRequests.some(item => item.query.cursor === 'contacts-50' && item.query.filter === 'all' && item.query.search === 'Fixture'));
    const chosen = page.locator('.workspace-contact-row[data-contact-id="85"]');
    await chosen.scrollIntoViewIfNeeded();
    const contactScroll = await contactList.evaluate(element => { element.dataset.fixturePreserved = 'yes'; return element.scrollTop; });
    assert.ok(contactScroll > 0);
    fs.mkdirSync('artifacts/native-contacts-history', { recursive: true });
    await page.screenshot({ path: 'artifacts/native-contacts-history/contacts.png' });
    // Automatic focus/visibility refresh keeps loaded pages and the visible anchor.
    await app.evaluate(() => { global.fixture.extraContact = true; global.fixture.contactVersions[160] = 'Fixture Updated 160'; global.fixture.contactVersions[85] = 'Fixture Updated 085'; global.fixture.contactIndicators[85] = 'no_show'; });
    const refreshCount = await app.evaluate(() => global.fixture.requests.filter(item => item.path === '/api/contacts/workspace').length);
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); window.dispatchEvent(new Event('focus')); });
    await eventually(async () => await contactRows.first().getAttribute('data-contact-id') === '161', 'Focus automatically discovers a new contact');
    assert.match(await contacts.locator('[data-contact-id="160"]').innerText(), /Updated 160/);
    assert.match(await contacts.locator('[data-contact-id="85"]').innerText(), /Updated 085/, 'Automatic refresh includes older loaded cursor pages');
    assert.equal(await contacts.locator('[data-contact-id="85"] .workspace-contact-indicator.no-show').count(), 1, 'Older loaded contact status changes automatically');
    assert.ok(await contactRows.count() >= 101, 'Automatic refresh preserves loaded older pages');
    assert.equal(await search.inputValue(), 'Fixture');
    let refreshedContactScroll = await contactList.evaluate(element => element.scrollTop);
    assert.ok(refreshedContactScroll >= contactScroll, 'New head does not jump to the start');
    const originalOffset = (await chosen.boundingBox()).y - (await contactList.boundingBox()).y;
    await app.evaluate(() => { global.fixture.extraContactCount = 60; global.fixture.deletedContactIds = [160]; });
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await eventually(async () => await contactRows.first().getAttribute('data-contact-id') === '221', 'A non-overlapping fresh head reconciles through the existing loaded window');
    assert.equal(await contacts.locator('[data-contact-id="160"]').count(), 0, 'Deleted contacts disappear on automatic refresh');
    assert.ok(await chosen.count() === 1, 'Older selected contact remains present across non-overlap');
    assert.ok(Math.abs((await chosen.boundingBox()).y - (await contactList.boundingBox()).y - originalOffset) <= 1, 'New and deleted rows preserve the exact visible contact anchor');
    refreshedContactScroll = await contactList.evaluate(element => element.scrollTop);
    // Visibility and focus cannot create concurrent duplicate list requests.
    await app.evaluate(() => { global.fixture.holdContacts = true; });
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
    await eventually(() => app.evaluate(() => global.fixture.pendingContacts.length === 1), 'Repeated events share one in-flight refresh');
    assert.equal(await app.evaluate(() => global.fixture.pendingContacts.length), 1);
    await app.evaluate(() => { global.fixture.holdContacts = false; global.fixture.pendingContacts.pop()(); });
    await eventually(async () => (await app.evaluate(() => global.fixture.requests.filter(item => item.path === '/api/contacts/workspace').length)) > refreshCount, 'Automatic refresh issued a scoped request');
    await eventually(async () => await contacts.getAttribute('aria-busy') === 'false', 'Background contact refresh completes before selecting');
    await chosen.click();
    const notes = page.locator('#contact-notes');
    await page.waitForFunction(() => document.querySelector('#contact-notes')?.value === 'Canonical note for 85.');
    assert.equal(await contacts.isVisible(), false);
    assert.equal(await notes.evaluate(element => getComputedStyle(element).fontFamily), await page.locator('.notes-detail-body').evaluate(element => getComputedStyle(element).fontFamily), 'Fixture textarea must inherit the production font');
    assert.equal(await page.getByRole('button', { name: 'Back to contacts', exact: true }).isVisible(), true);
    const noteText = Array.from({length:45}, (_,index) => `Contact 85 draft line ${index+1}.`).join('\n');
    await notes.fill(noteText);
    await page.getByRole('button', { name: 'Back to contacts', exact: true }).click();
    await contactRows.first().waitFor();
    assert.equal(await search.inputValue(), 'Fixture');
    assert.equal(await contactFilters.getByRole('tab', { name: 'All', exact: true }).getAttribute('aria-selected'), 'true');
    assert.equal(await contactList.getAttribute('data-fixture-preserved'), 'yes');
    assert.ok(Math.abs((await contactList.evaluate(element => element.scrollTop)) - refreshedContactScroll) <= 1, 'Back must retain the contact scroll position');
    assert.ok(await contactRows.count() >= 100, 'Back must retain the loaded cursor pages');
    await eventually(async () => (await app.evaluate(() => global.fixture.notes[85])) === noteText, 'Back must autosave only the selected contact');
    await chosen.click();
    await page.waitForFunction(text => document.querySelector('#contact-notes')?.value === text, noteText);
    const editorPosition = await notes.evaluate(element => { element.focus(); element.setSelectionRange(75,90,'forward'); element.scrollTop=200; return {start:element.selectionStart,end:element.selectionEnd,scrollTop:element.scrollTop}; });
    // History shares this contact, preserving the note draft and originating list.
    await page.getByRole('button', { name: 'History', exact: true }).click();
    const history = page.locator('.contact-history'), historyList = history.locator('.contact-history-list');
    const events = history.locator('[data-history-id]'), historyFilters = page.getByRole('tablist', { name: 'History type', exact: true });
    await events.first().waitFor();
    assert.equal(await history.getByRole('button', { name: 'Refresh history', exact: true }).count(), 0);
    assert.equal(await events.first().getAttribute('data-history-id'), 'appointment:0');
    await history.getByText('Today', { exact: true }).waitFor();
    await history.getByText('Yesterday', { exact: true }).waitFor();
    await historyFilters.getByRole('tab', { name: 'Calls', exact: true }).click();
    await eventually(async () => await events.first().getAttribute('data-history-id') === 'call:1', 'Calls filter must reset history cursor');
    assert.ok((await events.evaluateAll(items => items.map(item => item.dataset.historyType))).every(type => type === 'call'));
    await historyList.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await eventually(async () => await events.count() === 53, 'Calls history must load its next cursor');
    assert.equal(await events.last().getAttribute('data-history-id'), 'call:79');
    await historyFilters.getByRole('tab', { name: 'Appointments', exact: true }).click();
    await eventually(async () => await events.count() === 27, 'Appointments filter must have a fresh first page');
    assert.ok((await events.evaluateAll(items => items.map(item => item.dataset.historyType))).every(type => type === 'appointment'));
    await historyFilters.getByRole('tab', { name: 'All', exact: true }).click();
    await eventually(async () => await events.count() === 50, 'All history must reset its cursor');
    await historyList.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await eventually(async () => await events.count() === 80, 'Mixed history must load all older events');
    const historyIds = await events.evaluateAll(items => items.map(item => Number(item.dataset.historyId.split(':')[1])));
    assert.deepEqual(historyIds, Array.from({length:80},(_,index)=>index), 'Timeline must remain newest-first across cursor pages');
    await history.locator('[data-history-id="call:64"]').scrollIntoViewIfNeeded();
    const historyScroll = await historyList.evaluate(element => element.scrollTop);
    const anchorOffset = (await history.locator('[data-history-id="call:64"]').boundingBox()).y - (await historyList.boundingBox()).y;
    assert.ok(historyScroll > 0);
    await page.screenshot({ path: 'artifacts/native-contacts-history/history.png' });
    await page.getByRole('button', { name: 'Back to notes', exact: true }).click();
    assert.equal(await notes.inputValue(), noteText);
    assert.deepEqual(await notes.evaluate(element=>({start:element.selectionStart,end:element.selectionEnd,scrollTop:element.scrollTop})), editorPosition, 'History back must restore note caret/selection and editor scroll');
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await events.first().waitFor();
    assert.equal(await events.count(), 80, 'History must retain loaded cursor pages on return');
    assert.ok(Math.abs((await historyList.evaluate(element => element.scrollTop)) - historyScroll) <= 1, 'History must restore its scroll position');
    await page.getByRole('button', { name: 'Back to notes', exact: true }).click();
    await app.evaluate(() => { global.fixture.prependHistory = true; });
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await eventually(async () => await events.count() === 81, 'Reopening history must refresh recent activity without discarding older cursor pages');
    assert.equal(await events.first().getAttribute('data-history-id'), 'call:1000');
    const refreshedOffset = (await history.locator('[data-history-id="call:64"]').boundingBox()).y - (await historyList.boundingBox()).y;
    assert.ok(Math.abs(refreshedOffset-anchorOffset) <= 1, 'A new history entry must preserve the visible older activity anchor');
    await page.getByRole('button', { name: 'Back to notes', exact: true }).click();
    // Calls drive the actual useDialer bridge but the engine is a fixture only.
    const call = page.getByRole('button', { name: 'Call', exact: true });
    await eventually(async () => await call.isEnabled(), 'Assigned fixture caller ID and registered engine must enable Call');
    await call.click();
    await page.getByRole('button', { name: 'End Call', exact: true }).waitFor();
    const calls = await page.evaluate(() => window.fixtureDialer.calls);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].destinationNumber, '+12125550085');
    assert.equal(calls[0].callerNumber, '+12125550999');
    assert.equal(calls[0].leadContext.leadId, '85');
    assert.equal(calls[0].leadContext.leadName, 'Fixture 085');
    await page.evaluate(() => window.fixtureDialer.transition('in_call'));
    const duration = page.getByLabel('Call duration', { exact: true });
    await duration.waitFor();
    await eventually(async () => /0:0[1-9]/.test(await duration.innerText()), 'Connected call timer must advance');
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await page.getByRole('button', { name: 'Back to notes', exact: true }).click();
    assert.equal(await page.evaluate(() => window.fixtureDialer.calls.length), 1);
    await page.getByRole('button', { name: 'Back to contacts', exact: true }).click();
    await page.locator('.workspace-contact-row[data-contact-id="84"]').click();
    await page.waitForFunction(() => document.querySelector('#contact-notes')?.value === 'Canonical note for 84.');
    const endOther = page.getByRole('button', { name: 'End Call', exact: true });
    assert.match(await endOther.getAttribute('title'), /\+12125550085/, 'End Call must identify the actual active call when viewing another contact');
    assert.equal(await page.getByRole('button', { name: 'Call', exact: true }).count(), 0, 'Another contact must never expose a second call action while a call is active');
    assert.equal(await page.evaluate(() => window.fixtureDialer.calls.length), 1);
    assert.equal(await page.evaluate(() => window.fixtureDialer.leadContext.leadId), '85');
    await endOther.click();
    await call.waitFor();
    assert.equal(await page.evaluate(() => window.fixtureDialer.hangups), 1);
    assert.equal(await page.evaluate(() => window.fixtureDialer.uiState), 'ended');
    assert.equal(await page.getByRole('button', { name: 'Record call', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', {name:'Skip',exact:true}).count(), 0, 'Contact calls use the inline disposition and must not show a blocking global modal');
    // Startup failure surfaces through useDialer without a rejected UI promise.
    await page.evaluate(() => { window.fixtureDialer.failNextCall = true; });
    await call.click();
    await page.getByRole('alert').filter({hasText:'Fixture call could not start.'}).waitFor();
    assert.equal(await page.evaluate(() => window.fixtureDialer.calls.length), 1);
    await page.getByRole('button', {name:'Dismiss',exact:true}).click();
    await page.screenshot({ path: 'artifacts/native-contacts-history/contact-notes.png' });
    // History failure/retry stays scoped to the newly selected contact.
    await app.evaluate(() => { global.fixture.failHistory = true; });
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await history.getByRole('alert').filter({hasText:'Fixture history unavailable.'}).waitFor();
    assert.equal(await events.count(), 0, 'A new contact must never display the previous contact history');
    await app.evaluate(() => { global.fixture.failHistory = false; });
    await history.getByRole('button', { name: 'Retry', exact: true }).click();
    await events.first().waitFor();
    assert.ok((await app.evaluate(() => global.fixture.requests.filter(item=>item.path==='/api/contacts/workspace/84/activity'))).length >= 2);
    await page.getByRole('button', { name: 'Back to notes', exact: true }).click();
    await page.getByRole('button', { name: 'Back to contacts', exact: true }).click();
    await eventually(async () => await contacts.getAttribute('aria-busy') === 'false', 'Return refresh settles before testing failure');
    await app.evaluate(() => { global.fixture.failContacts = true; });
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')); });
    await contacts.getByRole('alert').filter({hasText:'Fixture contacts unavailable.'}).waitFor();
    await app.evaluate(() => { global.fixture.failContacts = false; });
    await page.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await eventually(async () => await contacts.getByRole('alert').count() === 0, 'Automatic refresh recovers from a transient list error');
    await contactRows.first().waitFor();
    // Delayed old search cannot replace a newer filter response.
    await app.evaluate(() => { global.fixture.holdContacts = true; });
    await search.fill('Fixture 0');
    await eventually(() => app.evaluate(() => global.fixture.pendingContacts.length === 1), 'Old search must be waiting in the fixture');
    await contactFilters.getByRole('tab', { name: 'Clients', exact: true }).click();
    await eventually(() => app.evaluate(() => global.fixture.pendingContacts.length === 2), 'New filter must issue its own request');
    await app.evaluate(() => { global.fixture.holdContacts = false; global.fixture.pendingContacts.pop()(); });
    await eventually(async () => await contactRows.first().getAttribute('data-contact-id') === '98', 'New filter response must arrive first');
    await app.evaluate(() => global.fixture.pendingContacts.pop()());
    // Allow the released IPC response through two render frames before negative assertions.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.ok((await contactRows.evaluateAll(items=>items.map(item=>Number(item.dataset.contactId)))).every(id=>id%2===0), 'A stale All response must not replace Clients');
    assert.equal(await search.inputValue(), 'Fixture 0');
    assert.equal(await contactFilters.getByRole('tab', {name:'Clients',exact:true}).getAttribute('aria-selected'), 'true');
    // Existing dialer-origin calls retain their disposition workflow.
    await workspace.getByRole('tab', {name:'Dialer',exact:true}).click();
    await page.evaluate(() => window.fixtureDialer.resetToIdle());
    await page.getByPlaceholder('Enter number', {exact:true}).fill('+12125550084');
    await page.getByPlaceholder('Enter number', {exact:true}).press('Enter');
    await page.waitForFunction(() => window.fixtureDialer.calls.length === 2);
    await page.evaluate(() => window.fixtureDialer.transition('in_call'));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(() => window.fixtureDialer.hangupCall());
    await page.getByRole('button', {name:'Skip',exact:true}).waitFor();
    await page.getByRole('button', {name:'Skip',exact:true}).click();
    const writes = await app.evaluate(() => global.fixture.requests.filter(item => ['POST','PUT','PATCH','DELETE'].includes(item.method)));
    assert.ok(writes.every(item => item.path === '/api/dialer/voice-session' || item.path === '/api/dialer/contacts/85/notes'), 'Browsing Contacts and History must not create contacts, appointments, calls, or messages');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    console.log('PASS Contacts/History: canonical filters/search/cursors, notes back autosave and scroll retention, grouped newest-first history with persistent cursors, real shell/useDialer contextual call and timer through fixture-only engine.');
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some(window => window.isVisible() || window.isFocusable())), false);
    assert.deepEqual(errors, []);
  } catch (error) {
    try { const page = await app.firstWindow(); console.error(await page.locator('body').innerText()); fs.mkdirSync('artifacts/native-contacts-history', { recursive: true }); await page.screenshot({ path: 'artifacts/native-contacts-history/failure.png' }); } catch {}
    throw error;
  } finally {
    await app.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.destroy(); }).catch(() => {});
    await app.close().catch(() => {}); fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
