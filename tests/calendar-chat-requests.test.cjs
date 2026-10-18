const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { buildSync } = require('esbuild');

const cache = path.join(process.cwd(), 'node_modules', '.cache');
fs.mkdirSync(cache, { recursive: true });
const directory = fs.mkdtempSync(path.join(cache, 'crokodial-calendar-chat-'));
buildSync({ entryPoints: ['src/renderer/services/calendarChatRequest.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: path.join(directory, 'request.cjs') });
buildSync({ entryPoints: ['src/renderer/components/InlineGoogleCalendarCard.tsx'], bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', external: ['react', 'react/jsx-runtime'], define: { 'import.meta.env.VITE_API_BASE': '""' }, outfile: path.join(directory, 'card.cjs') });
const { parseCalendarChatRequest } = require(path.join(directory, 'request.cjs'));
const { InlineGoogleCalendarCard } = require(path.join(directory, 'card.cjs'));
after(() => fs.rmSync(directory, { recursive: true, force: true }));

test('calendar chat parsing requires an explicit service and keeps ambiguous Google requests in conversation', () => {
  assert.equal(parseCalendarChatRequest('Connect Google'), null);
  assert.equal(parseCalendarChatRequest('Schedule my client appointment'), null);
  assert.deepEqual(parseCalendarChatRequest('Show my Google Calendar'), { kind: 'google-calendar', mode: 'read' });
  assert.deepEqual(parseCalendarChatRequest('Create a Google Calendar event titled "Fixture review"'), { kind: 'google-calendar', mode: 'create', summary: 'Fixture review' });
  assert.deepEqual(parseCalendarChatRequest('Update Google Calendar event abcde titled "Revised fixture"'), { kind: 'google-calendar', mode: 'update', eventId: 'abcde', summary: 'Revised fixture' });
  assert.deepEqual(parseCalendarChatRequest('Delete Google Calendar event id: fixture_123'), { kind: 'google-calendar', mode: 'delete', eventId: 'fixture_123' });
});

test('saved explicit requests reconstruct an in-chat review form and never execute on render', () => {
  const create = renderToStaticMarkup(React.createElement(InlineGoogleCalendarCard, {
    turnId: 'saved-calendar-turn', requestId: '11111111-1111-4111-8111-111111111111', persisted: true, agentId: 7,
    text: 'Create a Google Calendar event titled "Fixture review"',
  }));
  assert.match(create, /Google Calendar request for saved message/);
  assert.match(create, /Fixture review/);
  assert.match(create, /Review exact event creation/);
  assert.doesNotMatch(create, /Approve exact calendar change/, 'provider execution appears only after a durable grant is prepared');

  const read = renderToStaticMarkup(React.createElement(InlineGoogleCalendarCard, {
    turnId: 'saved-calendar-read', persisted: true, agentId: 7, text: 'Show my Google Calendar',
  }));
  assert.match(read, /Review exact date range/);
  assert.equal(renderToStaticMarkup(React.createElement(InlineGoogleCalendarCard, { turnId: 'other', persisted: true, agentId: 7, text: 'Connect Google' })), '');
});

test('relative Calendar requests resolve in an explicit timezone and preserve ambiguity for review', () => {
  const context = { now: Date.parse('2026-10-18T12:00:00.000Z'), timeZone: 'America/New_York' };
  assert.deepEqual(parseCalendarChatRequest('Create a Google Calendar event titled "Fixture review" tomorrow at 2 pm for one hour', context), {
    kind: 'google-calendar', mode: 'create', summary: 'Fixture review', start: '2026-10-19T18:00:00.000Z', end: '2026-10-19T19:00:00.000Z', timeZone: 'America/New_York',
  });
  const ambiguous = parseCalendarChatRequest('Create a Google Calendar event titled "Fixture review" tomorrow at 2 for one hour', context);
  assert.equal(ambiguous.start, undefined);
  assert.match(ambiguous.needsClarification, /AM or PM/);
  assert.deepEqual(parseCalendarChatRequest('Show my Google Calendar tomorrow', context), {
    kind: 'google-calendar', mode: 'read', start: '2026-10-19T04:00:00.000Z', end: '2026-10-20T04:00:00.000Z', timeZone: 'America/New_York',
  });
});

test('the permanent conversation mounts the calendar companion beside saved user turns', () => {
  const source = fs.readFileSync('src/renderer/components/PersonalAssistant.tsx', 'utf8');
  assert.match(source, /<InlineGoogleCalendarCard turnId=\{entry\.turn\.id\}/);
  assert.match(source, /persisted=\{entry\.turn\.sequence !== undefined && !entry\.turn\.id\.startsWith\('received:'\)\}/);
});
