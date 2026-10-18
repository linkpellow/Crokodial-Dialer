const { test, after, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build } = require('esbuild');
const { _electron: electron } = require('playwright');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'crokodial-sheet-handoff-'));
let helpers;
before(async () => {
  await build({ entryPoints: ['src/renderer/services/sheetAppendPreparation.ts', 'src/renderer/services/whatsAppSalesExtraction.ts'], bundle: true,
    platform: 'node', format: 'cjs', outdir: directory, outbase: 'src/renderer/services' });
  helpers = { ...require(path.join(directory, 'sheetAppendPreparation.js')), ...require(path.join(directory, 'whatsAppSalesExtraction.js')) };
});
after(() => fs.rmSync(directory, { recursive: true, force: true }));

test('screenshot and reviewed WhatsApp sales sources produce only explicitly mapped exact rows', async () => {
  const screenshot = helpers.screenshotSheetSource({ id: 'record-1', filename: 'sale.png', updatedAt: 10,
    fields: { planName: 'OCR value' }, identity: { name: 'TEST Person', email: 'test@example.test' }, preview: null, receipt: null },
  { planName: 'Reviewed Plan', monthlyPremium: '125.50' });
  assert.deepEqual(helpers.exactSheetValues(screenshot, helpers.parseSheetColumnMapping('clientName, planName, monthlyPremium', Object.keys(screenshot.rows[0]))),
    [['TEST Person', 'Reviewed Plan', 125.5]]);
  assert.throws(() => helpers.parseSheetColumnMapping('clientName, guessedField', Object.keys(screenshot.rows[0])), /not available/);
  const blankPremium = helpers.screenshotSheetSource({ id: 'record-2', filename: 'blank.png', updatedAt: 11,
    fields: {}, identity: {}, preview: null, receipt: null }, { monthlyPremium: '   ' });
  assert.equal(blankPremium.rows[0].monthlyPremium, null);

  const draft = helpers.extractWhatsAppSaleDraft({ id: 'wa-1', threadId: 'thread-1', threadTitle: 'TEST Sales', sender: 'TEST Sender',
    text: 'Client: TEST Person\nPlan: TEST Plan A\nPlan: TEST Plan B\nPremium: $125.50/month\nUnlabelled number 999', fromMe: false, sentAt: '2026-10-18T08:00:00Z' });
  assert.deepEqual(helpers.initialWhatsAppSaleValues(draft), { clientName: 'TEST Person', monthlyPremium: '125.50' });
  assert.deepEqual(draft.conflictFields, ['planName']);
  assert.throws(() => helpers.finalizeWhatsAppSaleReview(draft, { values: { clientName: 'TEST Person', planName: 'TEST Plan A', monthlyPremium: '125.50' }, conflictResolutions: {}, confirmed: true }), /Resolve the conflicting plan name/);
  assert.throws(() => helpers.finalizeWhatsAppSaleReview(draft, { values: { clientName: 'TEST Person', planName: 'Invented Plan', monthlyPremium: '125.50' }, conflictResolutions: { planName: 'selected' }, confirmed: true }), /Select one exact plan name candidate/);
  assert.throws(() => helpers.finalizeWhatsAppSaleReview(draft, { values: { clientName: 'TEST Person', clientEmail: 'not-an-email', planName: 'TEST Plan A' }, conflictResolutions: { planName: 'selected' }, confirmed: true }), /valid client email/);
  const reviewed = helpers.finalizeWhatsAppSaleReview(draft, { values: { clientName: 'TEST Person', planName: 'TEST Plan A', monthlyPremium: '125.50' },
    conflictResolutions: { planName: 'selected' }, confirmed: true }, '2026-10-18T09:00:00Z');
  assert.equal(reviewed.monthlyPremium, 125.5);
  assert.equal(reviewed.clientEmail, null, 'Missing values must remain unknown');
  assert.equal(JSON.parse(reviewed.fieldProvenance).planName.mode, 'owner_selected_candidate');
  assert.equal(JSON.parse(reviewed.fieldProvenance).clientName.confidence, 'explicit_label');
  const whatsapp = helpers.whatsAppSalesSheetSource('saved-turn', 'sales', 12, [reviewed]);
  assert.deepEqual(helpers.exactSheetValues(whatsapp, ['sourceSentAt', 'sourceThreadTitle', 'sourceSender', 'clientName', 'planName', 'monthlyPremium']),
    [['2026-10-18T08:00:00Z', 'TEST Sales', 'TEST Sender', 'TEST Person', 'TEST Plan A', 125.5]]);
  assert.equal(whatsapp.observedAt, 12);
  const context = await helpers.sheetAppendReviewContext(whatsapp, ['clientName', 'planName', 'monthlyPremium']);
  assert.match(context.sourceDigest, /^[a-f0-9]{64}$/);
  assert.equal(context.provenance[0].observationId, 'wa-1');
  const changed = { ...whatsapp, rows: [{ ...whatsapp.rows[0], sourceExactText: `${whatsapp.rows[0].sourceExactText} changed` }] };
  assert.notEqual((await helpers.sheetAppendReviewContext(changed, ['clientName'])).sourceDigest, context.sourceDigest, 'Exact-source changes must change the durable provenance digest');

  const prose = helpers.extractWhatsAppSaleDraft({ id: 'wa-2', threadId: 'thread-1', threadTitle: 'TEST Sales', sender: 'TEST Sender',
    text: 'Closed TEST sale for maybe $999', fromMe: false, sentAt: null });
  assert.deepEqual(helpers.initialWhatsAppSaleValues(prose), {}, 'Unlabelled prose must never become a structured fact');
  assert.throws(() => helpers.finalizeWhatsAppSaleReview(prose, { values: {}, conflictResolutions: {}, confirmed: true }), /at least one structured sales field/);
});

test('native WhatsApp flow requires structured review before it prepares exact RAW values', async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'crokodial-sheet-ui-'));
  fs.writeFileSync(path.join(fixture, 'entry.tsx'), `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { NativeWhatsAppSalesExtraction } from ${JSON.stringify(path.resolve('src/renderer/components/NativeWhatsAppSalesExtraction.tsx'))};
    (window as any).calls=[];(window as any).states=[];
    const observations=[{id:'wa-1',threadId:'thread-1',threadTitle:'TEST Sales',sender:'TEST Sender',text:'Client: TEST Person\\nPlan: TEST Plan A\\nPlan: TEST Plan B\\nPremium: $125.50/month',fromMe:false,sentAt:'2026-10-18T08:00:00Z'}];
    const prepareRequest=async(agentId:any,input:any)=>{(window as any).calls.push({agentId,input});return {kind:'grant',grant:{id:'11111111-1111-4111-8111-111111111111'}} as any};
    createRoot(document.getElementById('root')!).render(<NativeWhatsAppSalesExtraction agentId={7} turnId="saved-turn" query="sales" observedAt={10} observations={observations as any} prepareRequest={prepareRequest} onStateChange={state=>(window as any).states.push(state)}/>);
  `);
  await build({ entryPoints: [path.join(fixture, 'entry.tsx')], bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
    nodePaths: [path.resolve('node_modules')], outfile: path.join(fixture, 'fixture.js') });
  fs.writeFileSync(path.join(fixture, 'index.html'), '<!doctype html><div id="root"></div><script src="fixture.js"></script>');
  fs.writeFileSync(path.join(fixture, 'main.cjs'), `const{app,BrowserWindow}=require('electron');app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,webPreferences:{contextIsolation:false}});await w.loadFile(${JSON.stringify(path.join(fixture, 'index.html'))});});`);
  const app = await electron.launch({ executablePath: require('electron'), args: [path.join(fixture, 'main.cjs')] });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Array.isArray(window.calls) && Array.isArray(window.states));
    assert.deepEqual(await page.evaluate(() => window.calls), []);
    assert.equal(await page.getByLabel('Exact spreadsheet ID').count(), 0, 'Sheet preparation must remain unavailable before structured sales review');
    assert.equal(await page.getByLabel('Client name').inputValue(), 'TEST Person');
    assert.equal(await page.getByLabel('Monthly premium').inputValue(), '125.50');
    await page.getByLabel('Resolve Plan name').selectOption('TEST Plan A');
    await page.getByLabel('Confirm WhatsApp sales review').check();
    await page.getByRole('button', { name: 'Stage this reviewed sales row' }).click();
    await page.getByText('1 reviewed row staged').waitFor();
    await page.getByLabel('Exact spreadsheet ID').fill('owner_sheet_123');
    await page.getByLabel('Exact A1 append range').fill('Sales!A:E');
    await page.getByLabel('Sheet column mapping').fill('clientName, planName, monthlyPremium, sourceObservationId, fieldProvenance');
    assert.deepEqual((await page.evaluate(() => window.states)).at(-1), { dirty: true, busy: false });
    await page.getByRole('button', { name: 'Prepare exact append review' }).click();
    await page.getByText(/Prepared review 11111111/).waitFor();
    const calls = await page.evaluate(() => window.calls);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].input.args.values[0].slice(0, 4), ['TEST Person', 'TEST Plan A', 125.5, 'wa-1']);
    assert.equal(JSON.parse(calls[0].input.args.values[0][4]).planName.mode, 'owner_selected_candidate');
    assert.deepEqual({ ...calls[0].input.args.reviewContext, sourceDigest: undefined, provenance: undefined }, {
      source: 'native_whatsapp_sales_review', sourceId: 'saved-turn',
      columnMapping: ['clientName', 'planName', 'monthlyPremium', 'sourceObservationId', 'fieldProvenance'], rowCount: 1, observedAt: 10,
      sourceDigest: undefined, provenance: undefined });
    assert.match(calls[0].input.args.reviewContext.sourceDigest, /^[a-f0-9]{64}$/);
    assert.equal(calls[0].input.args.reviewContext.provenance.length, 1);
    assert.deepEqual(calls[0].input.args.reviewContext.provenance[0].fields, [
      { field: 'clientName', mode: 'explicit_label', confidence: 'explicit_label' },
      { field: 'planName', mode: 'owner_selected_candidate', confidence: 'owner_reviewed' },
      { field: 'monthlyPremium', mode: 'explicit_label', confidence: 'explicit_label' },
    ]);
    assert.match(calls[0].input.args.reviewContext.provenance[0].sourceTextDigest, /^[a-f0-9]{64}$/);
    assert.match(calls[0].input.args.reviewContext.provenance[0].fieldProvenanceDigest, /^[a-f0-9]{64}$/);
    assert.deepEqual(calls[0].input.args.reviewContext.provenance[0].resolvedConflicts, [{ field: 'planName', resolution: 'selected' }]);
    assert.equal(calls[0].input.args.spreadsheetId, 'owner_sheet_123');
    assert.equal(calls[0].input.args.range, 'Sales!A:E');
    assert.equal(calls[0].input.args.valueInputOption, 'RAW');
    assert.equal(await page.getByRole('button', { name: /approve|execute/i }).count(), 0);
    assert.deepEqual((await page.evaluate(() => window.states)).at(-1), { dirty: false, busy: false });
  } finally { await app.close().catch(() => {}); fs.rmSync(fixture, { recursive: true, force: true }); }
});

test('both source workflows mount the same reviewed append path and Gmail recipe stays in durable tasks', () => {
  const screenshot = fs.readFileSync('src/renderer/components/assistant-workspace/NativeScreenshotWorkflow.tsx', 'utf8');
  const mac = fs.readFileSync('src/renderer/components/InlineMacRequestCard.tsx', 'utf8');
  const assistant = fs.readFileSync('src/renderer/components/PersonalAssistant.tsx', 'utf8');
  const tasks = fs.readFileSync('src/renderer/components/assistant-workspace/NativeBackgroundTasks.tsx', 'utf8');
  assert.match(screenshot, /screenshotSheetSource\(record, fields\)/);
  assert.match(mac, /<NativeWhatsAppSalesExtraction[\s\S]*observedAt=\{whatsAppResult\.observedAt\}[\s\S]*observations=\{whatsAppResult\.observations\}/);
  assert.match(mac, /onStateChange=\{onSheetStateChange\}/);
  assert.match(assistant, /onPendingStateChange=\{onInlineWorkStateChange\}/);
  assert.match(assistant, /inlineWorkState\.dirty \|\| inlineWorkState\.busy/);
  assert.match(screenshot, /useNativeDiscardGuard\(dirty \|\| sheetState\.dirty, busy \|\| sheetState\.busy\)/);
  assert.match(tasks, /Start comprehensive review/);
  assert.match(tasks, /maxPages:triagePages,maxItems:triageItems,timeBudgetMs:triageSeconds\*1000/);
  assert.match(tasks, /Open Gmail evidence/);
  assert.match(tasks, /NativeGmailConnection required=\{\['mailbox_read'\]\}/);
});
