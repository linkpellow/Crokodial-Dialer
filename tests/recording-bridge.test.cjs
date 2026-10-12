const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRecordingBridge, CLIP_MAX_BYTES, JSON_MAX_BYTES, allowWorkspaceMicrophone } = require('../dist/main/recordingBridge');
const identity = { contactId: 7, sessionId: '42e756a5-754e-45bb-afb9-56af5e7b5a12', sequence: 0, authorization: 'Bearer isolated-test-token' };
const clip = { ...identity, mimeType: 'audio/webm;codecs=opus', audio: new Uint8Array([1, 2, 3]).buffer, startOffsetMs: 0, endOffsetMs: 55000 };
test('uploads binary multipart to the fixed authenticated contact endpoint', async () => {
  let count = 0;
  const bridge = createRecordingBridge('https://crokodial.example', async (url, options) => {
    count++;
    assert.equal(url, `https://crokodial.example/api/dialer/contacts/7/recording-sessions/${identity.sessionId}/segments/0`);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, identity.authorization);
    assert.equal(options.headers['x-crokodial-contract-version'], '2026-02-26.1');
    assert.equal(options.body.get('startOffsetMs'), '0');
    assert.equal(options.body.get('endOffsetMs'), '55000');
    assert.equal(options.body.get('audio').type, 'audio/webm');
    assert.deepEqual(new Uint8Array(await options.body.get('audio').arrayBuffer()), new Uint8Array([1, 2, 3]));
    return new Response(JSON.stringify({ success: true }), { status: 202 });
  });
  assert.equal((await bridge.upload(clip)).status, 202);
  assert.equal(count, 1);
});
test('rejects malformed identities, credentials, offsets and oversized clips before network use', async () => {
  let count = 0;
  const bridge = createRecordingBridge('https://crokodial.example', async () => { count++; throw new Error('Unexpected fetch'); });
  for (const patch of [{ contactId: 0 }, { contactId: 2.5 }, { sessionId: '../secret' }, { sequence: -1 }, { sequence: 240 }, { authorization: 'Bearer token\r\nX-Injected: yes' }, { audio: new ArrayBuffer(0) }, { audio: new ArrayBuffer(CLIP_MAX_BYTES + 1) }, { audio: new Uint8Array(2) }, { mimeType: 'text/html' }, { startOffsetMs: -1 }, { endOffsetMs: 60001 }, { endOffsetMs: 0 }]) {
    const result = await bridge.upload({ ...clip, ...patch });
    assert.equal(result.ok, false);
    assert.equal(result.status, 0);
  }
  assert.equal(count, 0);
  assert.throws(() => createRecordingBridge('http://other.example'));
  assert.throws(() => createRecordingBridge('https://crokodial.example/path'));
});
test('playback returns binary audio and keeps errors separate from audio', async () => {
  const bridge = createRecordingBridge('https://crokodial.example', async () => new Response(new Uint8Array([4, 5]), { headers: { 'Content-Type': 'audio/webm' } }));
  const result = await bridge.download(identity);
  assert.equal(result.ok, true);
  assert.deepEqual(new Uint8Array(result.body), new Uint8Array([4, 5]));
  assert.equal(result.headers['content-type'], 'audio/webm');
  const denied = createRecordingBridge('https://crokodial.example', async () => new Response('{"error":{"message":"No access"}}', { status: 403 }));
  const error = await denied.download(identity);
  assert.equal(error.status, 403);
  assert.equal(JSON.parse(error.errorBody).error.message, 'No access');
});
test('bounds streamed responses even without Content-Length and rejects HTML playback', async () => {
  const oversized = createRecordingBridge('https://crokodial.example', async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(CLIP_MAX_BYTES)); controller.enqueue(new Uint8Array(1)); controller.close(); } }), { headers: { 'Content-Type': 'audio/webm' } }));
  assert.match((await oversized.download(identity)).statusText, /size limit/);
  const wrongType = createRecordingBridge('https://crokodial.example', async () => new Response('<html>Login</html>', { headers: { 'Content-Type': 'text/html' } }));
  assert.equal((await wrongType.download(identity)).ok, false);
  const longJson = createRecordingBridge('https://crokodial.example', async () => new Response('{}', { headers: { 'Content-Length': String(JSON_MAX_BYTES + 1) } }));
  assert.match((await longJson.upload(clip)).statusText, /size limit/);
});
test('accepts a complete long-call response with drafts and saved notes', async () => {
  const body = JSON.stringify({ data: { draftNotes: 'n'.repeat(1024 * 1024), notes: 'm'.repeat(200000) } });
  const bridge = createRecordingBridge('https://crokodial.example', async () => new Response(body));
  assert.equal((await bridge.upload(clip)).body, body);
});
test('limits simultaneous transfers and releases the slot after failure', async () => {
  const resolvers = [];
  const bridge = createRecordingBridge('https://crokodial.example', () => new Promise(resolve => resolvers.push(resolve)));
  const requests = Array.from({ length: 3 }, () => bridge.upload(clip));
  assert.match((await bridge.upload(clip)).statusText, /busy/);
  for (const resolve of resolvers) resolve(new Response('{}'));
  assert.equal((await Promise.all(requests)).every(result => result.ok), true);
  const next = bridge.upload(clip);
  resolvers.at(-1)(new Response('{}'));
  assert.equal((await next).ok, true);
});
test('microphone permission is limited to audio in the trusted top-level workspace', () => {
  const url = 'file:///app/index.html';
  const details = { isMainFrame: true, requestingUrl: url, mediaType: 'audio' };
  assert.equal(allowWorkspaceMicrophone(true, url, 'media', details), true);
  assert.equal(allowWorkspaceMicrophone(true, url, 'media', { ...details, mediaTypes: ['audio'] }), true);
  for (const change of [{ isMainFrame: false }, { requestingUrl: 'https://other.example' }, { mediaType: 'video' }, { mediaType: 'unknown' }, { mediaTypes: ['audio', 'video'] }, { mediaTypes: [] }]) assert.equal(allowWorkspaceMicrophone(true, url, 'media', { ...details, ...change }), false);
  assert.equal(allowWorkspaceMicrophone(false, url, 'media', details), false);
  assert.equal(allowWorkspaceMicrophone(true, url, 'display-capture', details), false);
});
