import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudService, configuration, errorResponse } from '../src/service.js';
import { snapshot, restore, seal, unseal } from '../src/state.js';
import { secret } from '../../demo/model.js';
import { commit } from '../src/persistence.js';

function fixture(storage = null) {
  let time = Date.now();
  const env = { PUBLIC_ORIGIN: 'https://pilot.example.com', OWNER_CREDENTIAL: secret(), ENROLLMENT_CODE: secret(), STATE_ENCRYPTION_KEY: secret() };
  const service = new CloudService(env, () => time);
  async function call(route, value, options = {}) {
    const method = options.method || (value === undefined ? 'GET' : 'POST');
    const headers = { 'CF-Connecting-IP': options.client || '192.0.2.1', ...options.headers };
    if (method === 'POST') {
      headers['Content-Type'] = options.type || 'application/json';
      headers['X-Demo-Request'] = '1';
    }
    if (options.owner) { headers.Cookie = options.owner.cookie; headers['X-CSRF-Token'] = options.owner.csrfToken; headers.Origin = env.PUBLIC_ORIGIN; }
    if (options.token) headers.Authorization = 'Bearer ' + options.token;
    if (options.enroll) headers['X-Enrollment-Code'] = env.ENROLLMENT_CODE;
    if (options.origin !== undefined) headers.Origin = options.origin;
    const request = new Request((options.url || env.PUBLIC_ORIGIN) + route, { method, headers, body: method === 'POST' ? JSON.stringify(value) : undefined });
    let response;
    try { response = storage ? await commit(service, request, storage, env.STATE_ENCRYPTION_KEY) : await service.handle(request); }
    catch (error) { response = errorResponse(error); }
    return { status: response.status, value: await response.json(), cookie: response.headers.get('set-cookie') };
  }
  async function login() {
    const response = await call('/api/owner/login', { credential: env.OWNER_CREDENTIAL }, { origin: env.PUBLIC_ORIGIN });
    assert.equal(response.status, 200);
    return { ...response.value, cookie: response.cookie.split(';')[0] };
  }
  async function enrolled() {
    const response = await call('/api/displays', { name: 'Synthetic display' }, { enroll: true });
    assert.equal(response.status, 201);
    return response.value;
  }
  async function granted(scopes = ['display:read', 'content:write']) {
    const owner = await login();
    const display = await enrolled();
    assert.equal((await call('/api/owner/claim', { code: display.pairing.code, sessionId: display.pairing.sessionId }, { owner })).status, 200);
    const requested = await call('/api/agent/requests', { deviceId: display.deviceId, label: 'Synthetic client', scopes, ttlSeconds: 900 });
    assert.equal(requested.status, 201);
    assert.equal((await call('/api/owner/requests/' + requested.value.requestId + '/approve', { approved: true }, { owner })).status, 200);
    const approved = await call('/api/agent/requests/' + requested.value.requestId, undefined, { token: requested.value.requestToken });
    return { owner, display, grant: approved.value };
  }
  return { env, service, call, login, enrolled, granted, advance: duration => { time += duration; } };
}

test('one screen code claims only after owner authentication and never approves an agent', async () => {
  const { call, login, enrolled, env } = fixture();
  const display = await enrolled();
  assert.equal((await call('/api/owner/claim', { code: display.pairing.code })).status, 403);
  assert.equal((await call('/api/owner/claim', { code: display.pairing.code }, { origin: env.PUBLIC_ORIGIN })).status, 401);
  const owner = await login();
  assert.equal((await call('/api/owner/claim', { code: display.pairing.code }, { owner: { ...owner, csrfToken: 'wrong' } })).status, 403);
  assert.equal((await call('/api/owner/claim', { code: display.pairing.code.toLowerCase() }, { owner })).status, 200);
  const state = await call('/api/owner/state', undefined, { owner });
  assert.equal(state.value.devices[0].deviceId, display.deviceId);
  assert.deepEqual(state.value.grants, []);
  assert.equal((await call('/api/owner/claim', { code: display.pairing.code }, { owner })).status, 409);
});

test('screen codes reject expiry, ambiguity and unrelated fields', async () => {
  const { call, login, enrolled, advance, service } = fixture();
  const owner = await login();
  const first = await enrolled();
  const second = await enrolled();
  service.model.devices.get(second.deviceId).pairing.code = first.pairing.code;
  assert.equal((await call('/api/owner/claim', { code: first.pairing.code }, { owner })).status, 400);
  assert.equal((await call('/api/owner/claim', { code: first.pairing.code, approved: true }, { owner })).status, 400);
  service.model.devices.get(second.deviceId).pairing.code = '111111111111';
  advance(120001);
  assert.equal((await call('/api/owner/claim', { code: first.pairing.code }, { owner })).status, 410);
});

test('configuration rejects HTTP, placeholders, malformed origins and missing secrets', () => {
  const { env } = fixture();
  assert.equal(configuration(env), env.PUBLIC_ORIGIN);
  for (const origin of ['http://pilot.example.com', 'https://unconfigured.invalid', env.PUBLIC_ORIGIN + '/', env.PUBLIC_ORIGIN + '?secret']) assert.throws(() => configuration({ ...env, PUBLIC_ORIGIN: origin }));
  for (const key of ['OWNER_CREDENTIAL', 'ENROLLMENT_CODE', 'STATE_ENCRYPTION_KEY']) assert.throws(() => configuration({ ...env, [key]: '' }));
});

test('HTTPS origin, cross-origin and URL credential boundaries', async () => {
  const { call, env } = fixture();
  assert.equal((await call('/api/health', undefined, { url: 'http://pilot.example.com' })).status, 403);
  assert.equal((await call('/api/health', undefined, { url: 'https://other.example.com' })).status, 403);
  assert.equal((await call('/api/health', undefined, { origin: 'null' })).status, 403);
  assert.equal((await call('/api/health?token=secret')).status, 400);
  assert.equal((await call('/api/health', undefined, { origin: env.PUBLIC_ORIGIN })).status, 200);
});

test('owner cookies are secure and login requires exact Origin', async () => {
  const { call, env } = fixture();
  for (const origin of [undefined, 'null', 'https://evil.example.com']) assert.equal((await call('/api/owner/login', { credential: env.OWNER_CREDENTIAL }, { origin })).status, 403);
  const response = await call('/api/owner/login', { credential: env.OWNER_CREDENTIAL }, { origin: env.PUBLIC_ORIGIN });
  assert.match(response.cookie, /^__Host-desk_owner=/);
  for (const flag of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/']) assert.ok(response.cookie.includes(flag));
  assert.ok(!response.cookie.includes('Domain='));
});

test('private enrollment and separate claim/approval prevent ambient agent access', async () => {
  const { call, enrolled, login } = fixture();
  assert.equal((await call('/api/displays', { name: 'Uninvited' })).status, 401);
  const display = await enrolled();
  const request = { deviceId: display.deviceId, label: 'Synthetic agent', scopes: ['content:write'], ttlSeconds: 600 };
  assert.equal((await call('/api/agent/requests', request)).status, 409);
  const owner = await login();
  assert.equal((await call('/api/owner/claim', { code: display.pairing.code, sessionId: display.pairing.sessionId }, { owner: { ...owner, csrfToken: secret() } })).status, 403);
  assert.equal((await call('/api/owner/claim', { code: display.pairing.code, sessionId: display.pairing.sessionId }, { owner, origin: 'null' })).status, 403);
  assert.equal((await call('/api/owner/claim', { code: display.pairing.code, sessionId: display.pairing.sessionId }, { owner })).status, 200);
  const pending = await call('/api/agent/requests', request);
  assert.equal((await call('/api/agent/requests/' + pending.value.requestId, undefined, { token: pending.value.requestToken })).value.status, 'pending');
  assert.equal((await call('/api/agent/devices/' + display.deviceId + '/capabilities', undefined, { token: pending.value.requestToken })).status, 401);
});

test('publish, idempotency, download, nonce ACK and durable restart', async () => {
  const { granted, call, service, env } = fixture();
  const { display, grant, owner } = await granted();
  const route = '/api/agent/devices/' + display.deviceId + '/content';
  const content = { expectedRevision: 0, ttlSeconds: 600, cards: [{ title: 'Synthetic reminder', text: 'Dinner at six.' }] };
  const options = { token: grant.grantToken, headers: { 'Idempotency-Key': 'cloud_test_001' } };
  assert.equal((await call(route, content, options)).value.status, 'accepted');
  assert.equal((await call(route, content, options)).value.revision, 1);
  assert.equal((await call(route, { ...content, cards: [{ title: 'Changed', text: 'Different' }] }, options)).status, 409);
  const poll = await call('/api/devices/' + display.deviceId + '/poll', undefined, { token: display.deviceToken });
  assert.ok(poll.value.delivery.deliveryNonce);
  const persisted = await seal(snapshot(service), env.STATE_ENCRYPTION_KEY);
  assert.ok(!JSON.stringify(persisted).includes(grant.grantToken));
  const restarted = new CloudService(env, service.now);
  restore(restarted, await unseal(persisted, env.STATE_ENCRYPTION_KEY));
  assert.equal(restarted.model.transport(display.deviceId, display.deviceToken).revision, 1);
  restore(service, snapshot(restarted));
  assert.equal((await call('/api/owner/state', undefined, { owner })).status, 200);
  assert.equal((await call('/api/devices/' + display.deviceId + '/ack', { revision: 1, deliveryNonce: secret() }, { token: display.deviceToken })).status, 400);
  assert.equal((await call('/api/devices/' + display.deviceId + '/ack', { revision: 1, deliveryNonce: poll.value.delivery.deliveryNonce }, { token: display.deviceToken })).value.status, 'rendered');
});

test('read-only grants, wrong device and display-token misuse are rejected', async () => {
  const { granted, call, enrolled } = fixture();
  const { display, grant } = await granted(['display:read']);
  const other = await enrolled();
  assert.equal((await call('/api/agent/devices/' + other.deviceId + '/capabilities', undefined, { token: grant.grantToken })).status, 403);
  assert.equal((await call('/api/agent/devices/' + display.deviceId + '/content', { expectedRevision: 0, ttlSeconds: 600, cards: [{ title: 'Test', text: 'Test' }] }, { token: grant.grantToken, headers: { 'Idempotency-Key': 'readonly_001' } })).status, 403);
  assert.equal((await call('/api/agent/devices/' + display.deviceId + '/capabilities', undefined, { token: display.deviceToken })).status, 401);
});

test('revocation and logout survive snapshot restoration', async () => {
  const { granted, call, service } = fixture();
  const { display, grant, owner } = await granted();
  assert.equal((await call('/api/owner/grants/' + grant.grantId + '/revoke', {}, { owner })).status, 200);
  assert.equal((await call('/api/agent/requests/' + [...service.model.requests.keys()][0], undefined, { token: [...service.model.requests.values()][0].token })).value.status, 'revoked');
  assert.equal((await call('/api/owner/logout', {}, { owner })).status, 200);
  restore(service, snapshot(service));
  assert.equal((await call('/api/owner/state', undefined, { owner })).status, 401);
  assert.equal((await call('/api/agent/devices/' + display.deviceId + '/capabilities', undefined, { token: grant.grantToken })).status, 401);
});

test('owner rotation and session expiry invalidate existing sessions', async () => {
  const { login, call, env, advance } = fixture();
  const owner = await login();
  env.OWNER_CREDENTIAL = secret();
  assert.equal((await call('/api/owner/state', undefined, { owner })).status, 401);
  const replacement = await login();
  advance(3600001);
  assert.equal((await call('/api/owner/state', undefined, { owner: replacement })).status, 401);
});

test('rate limits persist and expire; pending request flooding is bounded', async () => {
  const { call, env, service, advance, granted } = fixture();
  for (let index = 0; index < 10; index++) assert.equal((await call('/api/owner/login', { credential: secret() }, { origin: env.PUBLIC_ORIGIN })).status, 401);
  restore(service, snapshot(service));
  assert.equal((await call('/api/owner/login', { credential: env.OWNER_CREDENTIAL }, { origin: env.PUBLIC_ORIGIN })).status, 429);
  advance(60001);
  const { display } = await granted();
  const value = { deviceId: display.deviceId, label: 'Synthetic request', scopes: ['display:read'], ttlSeconds: 600 };
  for (let index = 0; index < 5; index++) assert.equal((await call('/api/agent/requests', value)).status, 201);
  assert.equal((await call('/api/agent/requests', value)).status, 429);
  advance(300001);
  assert.equal((await call('/api/agent/requests', value)).status, 201);
});

test('body bytes, JSON content-type and plain text limits', async () => {
  const { call } = fixture();
  assert.equal((await call('/api/owner/login', { credential: 'x'.repeat(9000) }, { origin: 'https://pilot.example.com' })).status, 413);
  assert.equal((await call('/api/owner/login', {}, { origin: 'https://pilot.example.com', type: 'text/plain' })).status, 415);
});

test('anonymous bucket exhaustion does not block authenticated owner recovery', async () => {
  const { call, granted } = fixture();
  const { owner, grant } = await granted();
  for (let index = 0; index < 70; index++) await call('/api/health', undefined, { client: '192.0.2.' + (index + 20) });
  assert.equal((await call('/api/owner/grants/' + grant.grantId + '/revoke', {}, { owner, client: '198.51.100.1' })).status, 200);
  assert.equal((await call('/api/owner/logout', {}, { owner, client: '198.51.100.2' })).status, 200);
});

test('authenticated encryption rejects tampering, wrong keys and oversized Unicode state', async () => {
  const key = secret();
  const encoded = await seal('synthetic state', key);
  assert.notEqual((await seal('synthetic state', key)).nonce, encoded.nonce);
  await assert.rejects(() => unseal(encoded, secret()));
  await assert.rejects(() => unseal({ ...encoded, ciphertext: 'AAAA' }, key));
  await assert.rejects(() => unseal({ ...encoded, version: 2 }, key));
  await assert.rejects(() => seal('界'.repeat(30000), key));
  const maximum = await seal('x'.repeat(80000), key);
  assert.ok(Buffer.byteLength(JSON.stringify(maximum)) < 128 * 1024);
});

test('every persisted mutation rolls back on write failure without reporting success', async () => {
  let failing = false;
  const storage = { put: async () => { if (failing) throw new Error('Injected storage failure'); } };
  const { call, env, service, granted } = fixture(storage);
  failing = true;
  assert.equal((await call('/api/owner/login', { credential: env.OWNER_CREDENTIAL }, { origin: env.PUBLIC_ORIGIN })).status, 503);
  assert.equal(service.sessions.size, 0);
  assert.equal((await call('/api/displays', { name: 'Failed enrollment' }, { enroll: true })).status, 503);
  assert.equal(service.model.devices.size, 0);
  failing = false;
  const { display, grant, owner } = await granted();
  const content = { expectedRevision: 0, ttlSeconds: 600, cards: [{ title: 'Synthetic', text: 'Failure fixture.' }] };
  const route = '/api/agent/devices/' + display.deviceId + '/content';
  failing = true;
  assert.equal((await call(route, content, { token: grant.grantToken, headers: { 'Idempotency-Key': 'failure_test_001' } })).status, 503);
  assert.equal(service.model.device(display.deviceId).revision, 0);
  failing = false;
  assert.equal((await call(route, content, { token: grant.grantToken, headers: { 'Idempotency-Key': 'failure_test_001' } })).status, 200);
  failing = true;
  assert.equal((await call('/api/devices/' + display.deviceId + '/poll', undefined, { token: display.deviceToken })).status, 503);
  assert.equal(service.model.device(display.deviceId).revisions.get(1).downloadedAt, null);
  failing = false;
  const poll = await call('/api/devices/' + display.deviceId + '/poll', undefined, { token: display.deviceToken });
  failing = true;
  assert.equal((await call('/api/devices/' + display.deviceId + '/ack', { revision: 1, deliveryNonce: poll.value.delivery.deliveryNonce }, { token: display.deviceToken })).status, 503);
  assert.equal(service.model.device(display.deviceId).revisions.get(1).renderedAt, null);
  assert.equal((await call('/api/owner/grants/' + grant.grantId + '/revoke', {}, { owner })).status, 503);
  assert.equal(service.model.grants.get(grant.grantId).revoked, false);
  assert.equal((await call('/api/owner/logout', {}, { owner })).status, 503);
  assert.equal(service.sessions.size, 1);
});

test('growth capacity reserves space for owner logout and revocation', async () => {
  const storage = { put: async () => {} };
  const { granted, service, call } = fixture(storage);
  const { display, grant, owner } = await granted();
  const device = service.model.device(display.deviceId);
  device.publishes.set('capacity-fixture', { fingerprint: 'x'.repeat(60000), revision: 0 });
  assert.equal((await call('/api/agent/devices/' + display.deviceId + '/content', { expectedRevision: 0, ttlSeconds: 600, cards: [{ title: 'Test', text: 'Test' }] }, { token: grant.grantToken, headers: { 'Idempotency-Key': 'capacity_test_001' } })).status, 429);
  assert.equal(service.model.device(display.deviceId).revision, 0);
  assert.equal((await call('/api/owner/grants/' + grant.grantId + '/revoke', {}, { owner })).status, 200);
  assert.equal((await call('/api/owner/logout', {}, { owner })).status, 200);
});

test('unauthenticated owner traffic is throttled and unchanged rejections do not write', async () => {
  let writes = 0;
  const { call } = fixture({ put: async () => { writes++; } });
  for (let index = 0; index < 605; index++) assert.equal((await call('/api/owner/state')).status, index < 300 ? 401 : 429);
  assert.equal(writes, 300);
  assert.equal((await call('/api/health?token=bad')).status, 400);
  assert.equal(writes, 300);
});

test('authenticated display and agent traffic survives anonymous budget exhaustion', async () => {
  const { granted, call } = fixture();
  const { display, grant, owner } = await granted();
  for (let index = 0; index < 305; index++) await call('/api/health');
  assert.equal((await call('/api/health')).status, 429);
  assert.equal((await call('/api/devices/' + display.deviceId + '/poll', undefined, { token: display.deviceToken })).status, 200);
  assert.equal((await call('/api/agent/devices/' + display.deviceId + '/capabilities', undefined, { token: grant.grantToken })).status, 200);
  assert.equal((await call('/api/owner/grants/' + grant.grantId + '/revoke', {}, { owner })).status, 200);
});

test('unapproved request polling cannot exhaust an approved grant budget', async () => {
  const { granted, call } = fixture();
  const { display, grant } = await granted();
  const pending = await call('/api/agent/requests', { deviceId: display.deviceId, label: 'Unapproved fixture', scopes: ['display:read'], ttlSeconds: 600 });
  assert.equal(pending.status, 201);
  const route = '/api/agent/requests/' + pending.value.requestId;
  for (let index = 0; index < 600; index++) assert.equal((await call(route, undefined, { token: pending.value.requestToken })).status, 200);
  assert.equal((await call(route, undefined, { token: pending.value.requestToken })).status, 429);
  assert.equal((await call('/api/agent/devices/' + display.deviceId + '/capabilities', undefined, { token: grant.grantToken })).status, 200);
});
