import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createService } from '../server.js';
import { secret } from '../model.js';

export async function fixture() {
  let time = Date.now();
  const credential = secret();
  const { server, model } = createService({ ownerCredential: credential, now: () => time });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  let cookie = '';
  let csrf = '';
  let checks = 0;
  async function call(method, route, { body = {}, token, owner = false, headers = {}, expected = 200, raw } = {}) {
    const outgoing = { ...headers };
    if (method === 'POST') {
      outgoing['Content-Type'] = outgoing['Content-Type'] || 'application/json';
      if (outgoing['X-Demo-Request'] === undefined) outgoing['X-Demo-Request'] = '1';
    }
    if (token) outgoing.Authorization = 'Bearer ' + token;
    if (owner) { outgoing.Cookie = cookie; outgoing['X-CSRF-Token'] = csrf; }
    const response = await fetch(origin + route, { method, headers: outgoing, body: method === 'POST' ? raw === undefined ? JSON.stringify(body) : raw : undefined });
    assert.equal(response.status, expected, method + ' ' + route + ' HTTP status');
    checks++;
    const result = response.headers.get('content-type').startsWith('application/json') ? await response.json() : await response.text();
    return { body: result, response };
  }
  async function login() {
    const result = await call('POST', '/api/owner/login', { body: { credential } });
    cookie = result.response.headers.get('set-cookie').split(';')[0];
    csrf = result.body.csrfToken;
    return result;
  }
  async function enroll(name = 'Synthetic desk') {
    return (await call('POST', '/api/displays', { body: { name }, expected: 201 })).body;
  }
  async function claim(device) {
    return call('POST', '/api/owner/claim', { owner: true, body: { code: device.pairing.code, sessionId: device.pairing.sessionId } });
  }
  async function grant(device, scopes = ['display:read', 'content:write'], ttlSeconds = 900) {
    const request = (await call('POST', '/api/agent/requests', { body: { deviceId: device.deviceId, label: 'Smoke client', scopes, ttlSeconds }, expected: 201 })).body;
    await call('POST', '/api/owner/requests/' + request.requestId + '/approve', { owner: true, body: { approved: true } });
    return (await call('GET', '/api/agent/requests/' + request.requestId, { token: request.requestToken })).body;
  }
  return {
    server, model, origin, credential, call, login, enroll, claim, grant,
    advance: milliseconds => { time += milliseconds; }, checks: () => checks,
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  };
}

export function content(expectedRevision = 0, ttlSeconds = 600) {
  return { expectedRevision, ttlSeconds, cards: [{ title: 'Synthetic remote card', text: 'Published over authenticated HTTP, not a static simulation.' }] };
}

export async function smoke() {
  const context = await fixture();
  const { call } = context;
  try {
    await call('GET', '/api/health');
    const display = await context.enroll();
    const other = await context.enroll('Other synthetic display');
    const expired = await context.enroll('Expiry test');
    await call('POST', '/api/owner/claim', { body: display.pairing, expected: 401 });
    await call('POST', '/api/owner/login', { body: { credential: secret() }, expected: 401 });
    const login = await context.login();
    assert.match(login.response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.equal((await call('GET', '/api/owner/state', { owner: true })).body.devices.length, 0);
    await call('POST', '/api/owner/claim', { owner: true, body: { code: display.pairing.code, sessionId: other.pairing.sessionId }, expected: 400 });
    assert.equal((await context.claim(display)).body.agentAccess, false);
    await call('POST', '/api/owner/claim', { owner: true, body: { code: display.pairing.code, sessionId: display.pairing.sessionId }, expected: 409 });
    await context.claim(other);
    await call('GET', '/api/devices/' + display.deviceId + '/poll', { expected: 401 });
    await call('GET', '/api/devices/' + other.deviceId + '/poll', { token: display.deviceToken, expected: 401 });
    const request = (await call('POST', '/api/agent/requests', { expected: 201, body: { deviceId: display.deviceId, label: 'Explicit smoke agent', scopes: ['display:read', 'content:write'], ttlSeconds: 900 } })).body;
    const publishRoute = '/api/agent/devices/' + display.deviceId + '/content';
    const publishHeaders = { 'Idempotency-Key': 'smoke_publish_01' };
    await call('POST', publishRoute, { body: content(), headers: publishHeaders, expected: 401 });
    await call('POST', publishRoute, { body: content(), token: request.requestToken, headers: publishHeaders, expected: 401 });
    await call('POST', '/api/owner/requests/' + request.requestId + '/approve', { body: { approved: true }, expected: 401 });
    await call('POST', '/api/owner/requests/' + request.requestId + '/approve', { owner: true, body: { approved: false }, expected: 400 });
    await call('POST', '/api/owner/requests/' + request.requestId + '/approve', { owner: true, body: { approved: true } });
    await call('POST', '/api/owner/requests/' + request.requestId + '/approve', { owner: true, body: { approved: true }, expected: 409 });
    const grant = (await call('GET', '/api/agent/requests/' + request.requestId, { token: request.requestToken })).body;
    await call('GET', '/api/agent/devices/' + other.deviceId + '/capabilities', { token: grant.grantToken, expected: 403 });
    await call('POST', '/api/agent/devices/' + other.deviceId + '/content', { body: content(), token: grant.grantToken, headers: publishHeaders, expected: 403 });
    const published = (await call('POST', publishRoute, { body: content(), token: grant.grantToken, headers: publishHeaders })).body;
    assert.equal(published.status, 'accepted');
    const repeated = (await call('POST', publishRoute, { body: content(), token: grant.grantToken, headers: publishHeaders })).body;
    assert.equal(repeated.revision, published.revision);
    const changed = content(); changed.cards[0].text = 'Changed payload';
    await call('POST', publishRoute, { body: changed, token: grant.grantToken, headers: publishHeaders, expected: 409 });
    const revisionRoute = '/api/agent/devices/' + display.deviceId + '/revisions/' + published.revision;
    assert.equal((await call('GET', revisionRoute, { token: grant.grantToken })).body.status, 'accepted');
    await call('POST', '/api/devices/' + display.deviceId + '/ack', { body: { revision: 1, deliveryNonce: secret() }, token: display.deviceToken, expected: 400 });
    const poll = (await call('GET', '/api/devices/' + display.deviceId + '/poll', { token: display.deviceToken })).body;
    assert.equal(poll.delivery.cards[0].title, 'Synthetic remote card');
    assert.equal((await call('GET', revisionRoute, { token: grant.grantToken })).body.status, 'downloaded');
    const ack = { revision: published.revision, deliveryNonce: poll.delivery.deliveryNonce };
    assert.equal((await call('POST', '/api/devices/' + display.deviceId + '/ack', { body: ack, token: display.deviceToken })).body.status, 'rendered');
    const rendered = (await call('GET', revisionRoute, { token: grant.grantToken })).body;
    assert.ok(rendered.renderedAt >= rendered.downloadedAt);
    await call('POST', publishRoute, { body: content(), token: grant.grantToken, headers: { 'Idempotency-Key': 'smoke_conflict_01' }, expected: 409 });
    await call('POST', publishRoute, { body: content(1, 1), token: grant.grantToken, headers: { 'Idempotency-Key': 'smoke_publish_02' } });
    await call('POST', '/api/devices/' + display.deviceId + '/ack', { body: ack, token: display.deviceToken, expected: 409 });
    context.advance(120000);
    await call('POST', '/api/owner/claim', { owner: true, body: { code: expired.pairing.code, sessionId: expired.pairing.sessionId }, expected: 410 });
    assert.equal((await call('GET', '/api/devices/' + display.deviceId + '/poll', { token: display.deviceToken })).body.delivery, null);
    assert.equal((await call('GET', '/api/agent/devices/' + display.deviceId + '/revisions/2', { token: grant.grantToken })).body.status, 'expired');
    await call('POST', '/api/owner/grants/' + grant.grantId + '/revoke', { owner: true });
    await call('POST', publishRoute, { body: content(2), token: grant.grantToken, headers: { 'Idempotency-Key': 'smoke_revoked_01' }, expected: 401 });
    await call('GET', revisionRoute, { token: grant.grantToken, expected: 401 });
    assert.equal((await call('GET', '/api/agent/requests/' + request.requestId, { token: request.requestToken })).body.status, 'revoked');
    const shortGrant = await context.grant(other, ['display:read'], 1);
    context.advance(1000);
    await call('GET', '/api/agent/devices/' + other.deviceId + '/capabilities', { token: shortGrant.grantToken, expected: 401 });
    return context.checks();
  } finally { await context.close(); }
}
