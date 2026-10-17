import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, content, smoke } from '../scripts/http-check.js';
import { DisplayModel, secret } from '../model.js';
import { configuration } from '../server.js';

async function withFixture(run) {
  const context = await fixture();
  try { await run(context); } finally { await context.close(); }
}

async function ready(context, scopes, ttl) {
  await context.login();
  const display = await context.enroll();
  await context.claim(display);
  const grant = await context.grant(display, scopes, ttl);
  return { display, grant, route: '/api/agent/devices/' + display.deviceId + '/content' };
}

test('complete real HTTP smoke flow', async () => {
  assert.ok(await smoke() >= 40);
});

test('Host, Origin, custom request header and preflight reject browser cross-origin attempts', async () => withFixture(async context => {
  const wrongHost = await new Promise((resolve, reject) => {
    const request = http.get(context.origin + '/api/health', { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
  });
  assert.equal(wrongHost, 403);
  await context.call('POST', '/api/displays', { body: { name: 'Synthetic' }, headers: { Origin: 'https://evil.example' }, expected: 403 });
  await context.call('POST', '/api/displays', { body: { name: 'Synthetic' }, headers: { 'X-Demo-Request': '' }, expected: 403 });
  await context.call('OPTIONS', '/api/displays', { expected: 405 });
  await context.call('GET', '/api/health?token=anything', { expected: 400 });
}));

test('owner session cookie, CSRF, session expiry and logout', async () => withFixture(async context => {
  const login = await context.login();
  const cookie = login.response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly; SameSite=Strict; Path=\/api\/owner; Max-Age=3600/);
  const display = await context.enroll();
  await context.call('POST', '/api/owner/claim', { body: { code: display.pairing.code, sessionId: display.pairing.sessionId }, headers: { Cookie: cookie.split(';')[0] }, expected: 403 });
  await context.call('POST', '/api/owner/logout', { owner: true });
  await context.call('GET', '/api/owner/state', { owner: true, expected: 401 });
  await context.login();
  context.advance(3600000);
  await context.call('GET', '/api/owner/state', { owner: true, expected: 401 });
}));

test('JSON shape, media type, malformed data and body size limits', async () => withFixture(async context => {
  await context.call('POST', '/api/displays', { raw: '{', expected: 400 });
  await context.call('POST', '/api/owner/login', { body: null, expected: 400 });
  await context.call('POST', '/api/displays', { body: [], expected: 400 });
  await context.call('POST', '/api/displays', { body: { name: 'Synthetic' }, headers: { 'Content-Type': 'text/plain' }, expected: 415 });
  await context.call('POST', '/api/displays', { raw: JSON.stringify({ name: 'x'.repeat(9000) }), expected: 413 });
}));

test('markup, remote resources, shell fields and unbounded cards cannot be published', async () => withFixture(async context => {
  const { grant, route } = await ready(context);
  const invalidBodies = [
    { ...content(), html: '<script>alert(1)</script>' },
    { ...content(), shell: 'anything' },
    { ...content(), cards: [{ title: 'Synthetic', text: 'Text', image: 'https://example.com/test.png' }] },
    { ...content(), cards: [{ title: '<img src=x>', text: 'Text' }] },
    { ...content(), cards: [{ title: 'Synthetic', text: 'x'.repeat(601) }] },
    { ...content(), cards: [{ title: 'Synthetic', text: 'bad\u0000text' }] },
    { ...content(), cards: [] },
    { ...content(), cards: Array(5).fill({ title: 'Synthetic', text: 'Text' }) },
    { ...content(), ttlSeconds: 86401 },
    { ...content(), expectedRevision: '0' }
  ];
  for (let index = 0; index < invalidBodies.length; index++) {
    await context.call('POST', route, { body: invalidBodies[index], token: grant.grantToken, headers: { 'Idempotency-Key': 'invalid_' + index }, expected: 400 });
  }
}));

test('scope narrowing rejects unapproved operations', async () => withFixture(async context => {
  const { display, grant, route } = await ready(context, ['display:read']);
  await context.call('POST', route, { body: content(), token: grant.grantToken, headers: { 'Idempotency-Key': 'read_only_01' }, expected: 403 });
  const writeOnly = await context.grant(display, ['content:write']);
  await context.call('GET', '/api/agent/devices/' + display.deviceId + '/capabilities', { token: writeOnly.grantToken, expected: 403 });
  await context.call('POST', route, { body: content(), token: writeOnly.grantToken, headers: { 'Idempotency-Key': 'write_only_01' } });
}));

test('unsupported and duplicate scopes cannot be requested', async () => withFixture(async context => {
  const { display } = await ready(context);
  for (const scopes of [['settings:write'], ['display:read', 'display:read'], [], ['shell:execute']]) {
    await context.call('POST', '/api/agent/requests', { body: { deviceId: display.deviceId, label: 'Bad scopes', scopes, ttlSeconds: 900 }, expected: 400 });
  }
}));

test('model separates owners as well as devices', () => {
  const model = new DisplayModel();
  const display = model.enroll({ name: 'Owned synthetic display' });
  model.claim('owner-one', { code: display.pairing.code, sessionId: display.pairing.sessionId });
  const request = model.requestGrant({ deviceId: display.deviceId, label: 'Synthetic client', scopes: ['display:read'], ttlSeconds: 900 });
  assert.throws(() => model.approve('owner-two', request.requestId, { approved: true }), error => error.status === 403);
  const grant = model.approve('owner-one', request.requestId, { approved: true });
  assert.throws(() => model.revoke('owner-two', grant.grantId), error => error.status === 403);
  assert.equal(model.ownerView('owner-two').devices.length, 0);
  assert.equal(model.ownerView('owner-two').grants.length, 0);
});

test('pairing rotation invalidates the prior session and does not extend a spent code', async () => withFixture(async context => {
  await context.login();
  const display = await context.enroll();
  const rotated = (await context.call('POST', '/api/devices/' + display.deviceId + '/pairing', { token: display.deviceToken })).body;
  await context.call('POST', '/api/owner/claim', { owner: true, body: { code: display.pairing.code, sessionId: display.pairing.sessionId }, expected: 400 });
  await context.call('POST', '/api/owner/claim', { owner: true, body: { code: rotated.code, sessionId: display.pairing.sessionId }, expected: 400 });
  await context.call('POST', '/api/owner/claim', { owner: true, body: { code: rotated.code, sessionId: rotated.sessionId } });
  await context.call('POST', '/api/devices/' + display.deviceId + '/pairing', { token: display.deviceToken, expected: 409 });
}));

test('pending request credentials never confer content access and requests expire', async () => withFixture(async context => {
  const { display, route } = await ready(context);
  const request = (await context.call('POST', '/api/agent/requests', { body: { deviceId: display.deviceId, label: 'Pending', scopes: ['content:write'], ttlSeconds: 900 }, expected: 201 })).body;
  assert.equal((await context.call('GET', '/api/agent/requests/' + request.requestId, { token: request.requestToken })).body.status, 'pending');
  await context.call('GET', '/api/agent/requests/' + request.requestId, { token: secret(), expected: 401 });
  await context.call('POST', route, { body: content(), token: request.requestToken, headers: { 'Idempotency-Key': 'pending_01' }, expected: 401 });
  context.advance(300000);
  await context.call('GET', '/api/agent/requests/' + request.requestId, { token: request.requestToken, expected: 410 });
  await context.call('POST', '/api/owner/requests/' + request.requestId + '/approve', { owner: true, body: { approved: true }, expected: 410 });
}));

test('transport, request, owner and agent credentials are not interchangeable', async () => withFixture(async context => {
  const { display, grant, route } = await ready(context);
  await context.call('GET', '/api/devices/' + display.deviceId + '/poll', { token: grant.grantToken, expected: 401 });
  await context.call('POST', route, { body: content(), token: display.deviceToken, headers: { 'Idempotency-Key': 'wrong_token_01' }, expected: 401 });
  await context.call('GET', '/api/owner/state', { token: context.credential, expected: 401 });
  await context.call('POST', '/api/owner/login', { body: { credential: grant.grantToken }, expected: 401 });
}));

test('render receipts require download nonce, matching device, fresh revision and unexpired content', async () => withFixture(async context => {
  const { display, grant, route } = await ready(context);
  await context.call('POST', route, { body: content(0, 1), token: grant.grantToken, headers: { 'Idempotency-Key': 'ack_test_01' } });
  const polled = (await context.call('GET', '/api/devices/' + display.deviceId + '/poll', { token: display.deviceToken })).body;
  const ack = { revision: 1, deliveryNonce: polled.delivery.deliveryNonce };
  await context.call('POST', '/api/devices/' + display.deviceId + '/ack', { token: display.deviceToken, body: { ...ack, deliveryNonce: secret() }, expected: 400 });
  await context.call('POST', '/api/devices/' + display.deviceId + '/ack', { token: display.deviceToken, body: { ...ack, revision: '1' }, expected: 400 });
  const other = await context.enroll('Other receipt display');
  await context.call('POST', '/api/devices/' + other.deviceId + '/ack', { token: other.deviceToken, body: ack, expected: 400 });
  const first = (await context.call('POST', '/api/devices/' + display.deviceId + '/ack', { token: display.deviceToken, body: ack })).body;
  context.advance(500);
  const duplicate = (await context.call('POST', '/api/devices/' + display.deviceId + '/ack', { token: display.deviceToken, body: ack })).body;
  assert.equal(first.renderedAt, duplicate.renderedAt);
  context.advance(500);
  await context.call('POST', '/api/devices/' + display.deviceId + '/ack', { token: display.deviceToken, body: ack, expected: 410 });
}));

test('idempotency keys are bound to the grant and content, not shared across agents', async () => withFixture(async context => {
  const { display, grant, route } = await ready(context);
  const second = await context.grant(display);
  await context.call('POST', route, { body: content(), token: grant.grantToken, headers: { 'Idempotency-Key': 'shared_key_01' } });
  const result = (await context.call('POST', route, { body: content(1), token: second.grantToken, headers: { 'Idempotency-Key': 'shared_key_01' } })).body;
  assert.equal(result.revision, 2);
  await context.call('POST', route, { body: content(2), token: grant.grantToken, headers: { 'Idempotency-Key': 'short' }, expected: 400 });
}));

test('rate limits reject repeated owner credential guesses', async () => withFixture(async context => {
  for (let attempt = 0; attempt < 10; attempt++) await context.call('POST', '/api/owner/login', { body: { credential: secret() }, expected: 401 });
  await context.call('POST', '/api/owner/login', { body: { credential: secret() }, expected: 429 });
  context.advance(60000);
  await context.login();
}));

test('memory limits bound public enrollment and revision accumulation', () => {
  const model = new DisplayModel();
  let first;
  for (let index = 0; index < 32; index++) {
    const display = model.enroll({ name: 'Synthetic ' + index });
    if (!first) first = display;
  }
  assert.throws(() => model.enroll({ name: 'Overflow' }), error => error.status === 429);
  model.claim('local-owner', { code: first.pairing.code, sessionId: first.pairing.sessionId });
  const request = model.requestGrant({ deviceId: first.deviceId, label: 'Synthetic', scopes: ['content:write'], ttlSeconds: 900 });
  model.approve('local-owner', request.requestId, { approved: true });
  const grant = model.requestStatus(request.requestId, request.requestToken);
  for (let index = 0; index < 100; index++) model.publish(first.deviceId, grant.grantToken, content(index), 'revision_' + index);
  assert.throws(() => model.publish(first.deviceId, grant.grantToken, content(100), 'revision_100'), error => error.status === 429);
});

test('default binding is loopback and LAN mode requires explicit warning opt-in and exact origin', () => {
  const defaults = configuration({});
  assert.equal(defaults.host, '127.0.0.1');
  assert.equal(defaults.port, 8765);
  assert.equal(defaults.lan, false);
  assert.throws(() => configuration({ HOST: '0.0.0.0' }));
  assert.throws(() => configuration({ HOST: '0.0.0.0', ALLOW_INSECURE_LAN: '1' }));
  assert.throws(() => configuration({ PORT: '0' }));
  assert.throws(() => configuration({ DEMO_ORIGIN: 'http://evil.example:8765' }));
  assert.throws(() => configuration({ HOST: '0.0.0.0', ALLOW_INSECURE_LAN: '1', DEMO_ORIGIN: 'https://example.com:8765' }));
  const lan = configuration({ HOST: '0.0.0.0', ALLOW_INSECURE_LAN: '1', DEMO_ORIGIN: 'http://192.168.1.50:8765' });
  assert.equal(lan.lan, true);
});

test('static UI has restrictive headers and no remote assets or arbitrary file access', async () => withFixture(async context => {
  for (const route of ['/display', '/setup', '/agent', '/app.js', '/style.css']) {
    const result = await context.call('GET', route);
    assert.match(result.response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(result.response.headers.get('cache-control'), 'no-store');
    assert.equal(result.response.headers.get('x-content-type-options'), 'nosniff');
    assert.doesNotMatch(result.body, /https?:\/\/|innerHTML|eval\(/);
  }
  await context.call('GET', '/.runtime/owner-credential.txt', { expected: 404 });
  await context.call('GET', '/model.js', { expected: 404 });
  await context.call('GET', '/missing', { expected: 404 });
}));

test('served skill and machine-readable contract name the actual API and honest connector boundaries', async () => withFixture(async context => {
  const skill = (await context.call('GET', '/skill.md')).body;
  assert.match(skill, /does not.*implement OAuth/);
  assert.match(skill, /QR pairing is not implemented/);
  assert.match(skill, /agent-client\.js run DISPLAY_ID/);
  const contract = (await context.call('GET', '/api-contract.json')).body;
  assert.equal(contract.contractVersion, 1);
  assert.equal(contract.qrImplemented, false);
  assert.equal(contract.routes.length, 16);
  for (const route of contract.routes) {
    assert.ok(['GET', 'POST'].includes(route.method));
    if (route.requestSchema) assert.ok(contract.schemas[route.requestSchema]);
  }
  assert.equal(contract.schemas.publish.properties.cards.maxItems, 4);
  assert.equal(contract.schemas.publish.additionalProperties, false);
}));

test('fresh service state cannot reuse old display credentials or grants', async () => {
  const first = await fixture();
  let display;
  let grant;
  try { ({ display, grant } = await ready(first)); } finally { await first.close(); }
  await withFixture(async second => {
    await second.call('GET', '/api/devices/' + display.deviceId + '/poll', { token: display.deviceToken, expected: 404 });
    await second.call('GET', '/api/agent/devices/' + display.deviceId + '/capabilities', { token: grant.grantToken, expected: 401 });
  });
});

test('separate Codex HTTP process waits for owner approval, publishes and observes ACK without logging secrets', async () => withFixture(async context => {
  const { display } = await ready(context);
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const child = spawn(process.execPath, [path.join(root, 'scripts', 'agent-client.js'), 'run', display.deviceId], { cwd: root, windowsHide: true, env: { ...process.env, PORT: String(new URL(context.origin).port) } });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const completion = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  try {
    async function waitUntil(check) {
      const deadline = Date.now() + 10000;
      while (!check()) {
        if (Date.now() > deadline) throw new Error('External client did not reach expected step.');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    await waitUntil(() => /Pending request/.test(output));
    assert.equal(context.model.device(display.deviceId).revision, 0);
    const requestId = /Pending request ([a-f0-9]{24})/.exec(output)[1];
    await context.call('POST', '/api/owner/requests/' + requestId + '/approve', { owner: true, body: { approved: true } });
    await waitUntil(() => /Revision 1: accepted/.test(output));
    const delivery = (await context.call('GET', '/api/devices/' + display.deviceId + '/poll', { token: display.deviceToken })).body.delivery;
    await context.call('POST', '/api/devices/' + display.deviceId + '/ack', { token: display.deviceToken, body: { revision: delivery.revision, deliveryNonce: delivery.deliveryNonce } });
    assert.equal(await completion, 0);
    assert.match(output, /rendered/);
    const request = context.model.requests.get(requestId);
    const grant = context.model.grants.get(request.grantId);
    for (const token of [request.token, grant.token, context.credential, display.deviceToken]) assert.ok(!output.includes(token));
  } finally { if (child.exitCode === null) child.kill(); }
}));
