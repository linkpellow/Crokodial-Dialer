const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { buildSync } = require('esbuild');

const cache = path.join(process.cwd(), 'node_modules', '.cache');
fs.mkdirSync(cache, { recursive: true });
const directory = fs.mkdtempSync(path.join(cache, 'crokodial-mac-chat-'));
buildSync({ entryPoints: ['src/renderer/services/macChatRequest.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(directory, 'requests.cjs') });
buildSync({ entryPoints: ['src/renderer/components/InlineMacRequestCard.tsx'], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime'], outfile: path.join(directory, 'card.cjs') });
const { parseMacChatRequest, runMacChatRead } = require(path.join(directory, 'requests.cjs'));
const { InlineMacRequestCard } = require(path.join(directory, 'card.cjs'));
after(() => fs.rmSync(directory, { recursive: true, force: true }));

test('saved natural-language turns deterministically reconstruct bounded local read requests', () => {
  assert.deepEqual(parseMacChatRequest('Search WhatsApp for renewal notice'), { kind: 'whatsapp.read', query: 'renewal notice' });
  assert.deepEqual(parseMacChatRequest('Who is +1 (269) 462-1403?'), { kind: 'contacts.search', query: '+1 (269) 462-1403', unknownNumber: true });
  assert.deepEqual(parseMacChatRequest('Find Link Pellow in my iCloud Contacts'), { kind: 'contacts.search', query: 'Link Pellow', unknownNumber: false });
  assert.deepEqual(parseMacChatRequest('Show my Messages thread with Link'), { kind: 'messages.read', query: 'Link' });
  assert.deepEqual(parseMacChatRequest('Read my recent Apple Messages'), { kind: 'messages.read', query: '' });
  assert.deepEqual(parseMacChatRequest('What did Link text me?'), { kind: 'messages.read', query: 'Link' });
  assert.equal(parseMacChatRequest('Can you connect to Google?'), null);
  assert.equal(parseMacChatRequest('Send an email to fixture@example.test saying hello'), null);
  assert.equal(parseMacChatRequest('Find the plan support contacts'), null);
  assert.equal(parseMacChatRequest('What are text messages?'), null);
});

test('send requests retain exact text and distinguish existing-thread review from recipient-only compose', () => {
  assert.deepEqual(parseMacChatRequest('Text Link saying I will call tomorrow!'), { kind: 'messages.send', target: 'Link', text: 'I will call tomorrow!' });
  assert.deepEqual(parseMacChatRequest('Send a message to 2694621403: Hello there.'), { kind: 'messages.send', target: '2694621403', text: 'Hello there.', phone: '2694621403' });
  assert.deepEqual(parseMacChatRequest('Open an unsent SMS draft to 2694621403 saying Hello there.'), { kind: 'sms.compose', phone: '2694621403', text: 'Hello there.' });
  assert.equal(parseMacChatRequest(`Text Link saying ${'x'.repeat(4_001)}`), null, 'Oversized exact content must not be silently truncated');
});

test('read controller calls only the requested read operation and enforces renderer bounds', async () => {
  const calls = [];
  const service = {
    listMessageThreads: async query => { calls.push(['messages', query]); return { threads: Array.from({ length: 70 }, (_, index) => ({ id: `thread-${index}` })) }; },
    searchWhatsApp: async query => { calls.push(['whatsapp', query]); return { observations: Array.from({ length: 140 }, (_, index) => ({ id: `wa-${index}` })) }; },
    searchContacts: async query => { calls.push(['contacts', query]); return { contacts: Array.from({ length: 120 }, (_, index) => ({ id: `contact-${index}` })) }; },
    prepareMessageSend: async () => { throw new Error('a read controller must never prepare a write'); },
    executeMessageSend: async () => { throw new Error('a read controller must never execute a write'); },
  };
  assert.equal((await runMacChatRead({ kind: 'messages.read', query: 'Fixture' }, service)).threads.length, 50);
  assert.equal((await runMacChatRead({ kind: 'messages.send', target: 'Fixture', text: 'Exact' }, service)).threads.length, 50);
  assert.equal((await runMacChatRead({ kind: 'contacts.search', query: '2694621403', unknownNumber: true }, service)).contacts.length, 100);
  assert.equal((await runMacChatRead({ kind: 'whatsapp.read', query: 'renewal' }, service)).observations.length, 100);
  assert.deepEqual(calls, [['messages', 'Fixture'], ['messages', 'Fixture'], ['contacts', '2694621403'], ['whatsapp', 'renewal']]);
});

test('native inline cards are reconstructed from the saved turn and expose no immediate send control', () => {
  const message = 'Text Link saying Exact fixture message!';
  const first = renderToStaticMarkup(React.createElement(InlineMacRequestCard, { turnId: 'saved-turn-1', text: message }));
  const reloaded = renderToStaticMarkup(React.createElement(InlineMacRequestCard, { turnId: 'saved-turn-1', text: message }));
  assert.equal(first, reloaded, 'Reloading the same persisted turn must reconstruct the same card');
  assert.match(first, /data-turn-id="saved-turn-1"/);
  assert.match(first, /Reviewed Messages request/);
  assert.match(first, /Exact fixture message!/);
  assert.match(first, /Find existing Messages thread/);
  assert.doesNotMatch(first, /Submit this exact message once/, 'Execution exists only after a one-use native review is prepared');

  const compose = renderToStaticMarkup(React.createElement(InlineMacRequestCard, { turnId: 'saved-turn-2', text: 'Open an unsent SMS draft to 2694621403 saying Draft fixture.' }));
  assert.match(compose, /recipient-only/);
  assert.match(compose, /Review recipient-only compose handoff/);
  assert.doesNotMatch(compose, /Open recipient-only unsent compose/, 'The system handoff is unavailable until the review step completes');
  assert.equal(renderToStaticMarkup(React.createElement(InlineMacRequestCard, { turnId: 'saved-turn-3', text: 'Explain deductibles' })), '');
});

test('Personal Assistant mounts cards beside persisted user turns in the one permanent transcript', () => {
  const source = fs.readFileSync('src/renderer/components/PersonalAssistant.tsx', 'utf8');
  assert.match(source, /conversationKey && sessionId && entry\.turn\.role === 'user' && <InlineMacRequestCard turnId=\{entry\.turn\.id\} requestId=\{entry\.turn\.requestId\} persisted=\{entry\.turn\.sequence !== undefined/);
  assert.match(source, /agentId=\{agentId\} sessionId=\{sessionId\} conversationKey=\{conversationKey\}/);
  assert.doesNotMatch(source, /new conversation|reset conversation/i);
});

test('manual Mac surface restores the canonical durable receipt inbox without automatic execution', () => {
  const source = fs.readFileSync('src/renderer/components/assistant-workspace/NativeMacConnectors.tsx', 'utf8');
  assert.match(source, /macConnectorService\.listReviewedWrites\(\{ agentId, sessionId \}\)/);
  assert.match(source, /macConnectorService\.restoreReviewedWriteContext\(record\.context, record\.kind, \{ agentId, sessionId \}\)/);
  assert.match(source, /const authority = \{ agentId, sessionId \}/);
  assert.match(source, /I verified it was applied/);
  assert.match(source, /I verified it was not applied/);
  assert.match(source, /This write cannot be replayed while unresolved/);
  assert.match(source, /saved user turn becomes the durable review origin/);
  assert.match(source, /listReviewedWrites\(\{ agentId, sessionId \}, savedWritesNextCursor\)/);
  assert.match(source, /Load older receipts/);
  assert.doesNotMatch(source, /manual-contact:|manual-message:|crypto\.randomUUID\(\)|prepareContactChange\(|prepareMessageSend\(/,
    'the manual surface must not synthesize a write origin outside the permanent saved chat');
  const effect = source.slice(source.indexOf('useEffect(() => {\n    let current = true;'), source.indexOf('\n  function requestAccess'));
  assert.doesNotMatch(effect, /executeContactChange|executeMessageSend|reconcileReviewedWrite/, 'restoration never executes or reconciles a write');
});
