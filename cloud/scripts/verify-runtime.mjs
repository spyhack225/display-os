import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createTestHarness } from 'wrangler';
import { secret } from '../../demo/model.js';

const origin = 'https://runtime.example.com';
const secrets = { OWNER_CREDENTIAL: secret(), ENROLLMENT_CODE: secret(), STATE_ENCRYPTION_KEY: secret() };
const config = JSON.parse(await readFile(new URL('../wrangler.json', import.meta.url), 'utf8'));
config.main = '.wrangler/bundle/worker.js';
const options = { workers: [{ config, vars: { PUBLIC_ORIGIN: origin }, secrets }] };
const server = createTestHarness(options);
let checks = 0;
async function call(route, value, auth = {}) {
  const headers = { 'CF-Connecting-IP': '192.0.2.99' };
  const method = value === undefined ? 'GET' : 'POST';
  if (method === 'POST') { headers['Content-Type'] = 'application/json'; headers['X-Demo-Request'] = '1'; }
  if (auth.owner) { headers.Cookie = auth.owner.cookie; headers['X-CSRF-Token'] = auth.owner.csrfToken; headers.Origin = origin; }
  if (auth.login) headers.Origin = origin;
  if (auth.enroll) headers['X-Enrollment-Code'] = secrets.ENROLLMENT_CODE;
  if (auth.token) headers.Authorization = 'Bearer ' + auth.token;
  if (auth.key) headers['Idempotency-Key'] = auth.key;
  return server.getWorker().fetch(origin + route, { method, headers, body: method === 'POST' ? JSON.stringify(value) : undefined });
}
function check(actual, expected) { assert.equal(actual, expected); checks++; }

try {
  await server.listen();
  check((await call('/api/health')).status, 200);
  const displayPage = await call('/pilot/display');
  check(displayPage.status, 200);
  assert.ok((await displayPage.text()).includes('DisplayOS | Your home'));
  assert.ok(displayPage.headers.get('content-security-policy').includes("img-src 'none'")); checks += 2;
  for (const route of ['/pilot/setup', '/agent', '/operator', '/app.js', '/owner.js', '/style.css', '/pilot/skill.md', '/api-contract.json']) check((await call(route)).status, 200);
  check((await call('/setup.html')).status, 404);
  check((await call('/api/owner/state')).status, 401);
  check((await call('/api/displays', { name: 'Uninvited' })).status, 401);
  const login = await call('/api/owner/login', { credential: secrets.OWNER_CREDENTIAL }, { login: true });
  check(login.status, 200);
  const owner = { ...await login.json(), cookie: login.headers.get('set-cookie').split(';')[0] };
  const enrolled = await call('/api/displays', { name: 'Runtime fixture' }, { enroll: true });
  check(enrolled.status, 201);
  const display = await enrolled.json();
  check((await call('/api/owner/claim', { code: display.pairing.code, sessionId: display.pairing.sessionId }, { owner })).status, 200);
  const pending = await call('/api/agent/requests', { deviceId: display.deviceId, label: 'Runtime fixture', scopes: ['display:read', 'content:write'], ttlSeconds: 600 });
  check(pending.status, 201);
  const requested = await pending.json();
  check((await call('/api/owner/requests/' + requested.requestId + '/approve', { approved: true }, { owner })).status, 200);
  const grant = await (await call('/api/agent/requests/' + requested.requestId, undefined, { token: requested.requestToken })).json();
  const content = { expectedRevision: 0, ttlSeconds: 600, cards: [{ title: 'Synthetic runtime', text: 'Real Worker and Durable Object transport.' }] };
  const publishRoute = '/api/agent/devices/' + display.deviceId + '/content';
  check((await call(publishRoute, content, { token: grant.grantToken, key: 'runtime_test_001' })).status, 200);
  const delivery = await (await call('/api/devices/' + display.deviceId + '/poll', undefined, { token: display.deviceToken })).json();
  await server.update({ workers: [{ config, vars: { PUBLIC_ORIGIN: origin, TEST_RELOAD: '2' }, secrets }] });
  check((await call('/api/owner/state', undefined, { owner })).status, 200);
  const restored = await (await call('/api/devices/' + display.deviceId + '/poll', undefined, { token: display.deviceToken })).json();
  check(restored.delivery.deliveryNonce, delivery.delivery.deliveryNonce);
  const ack = await call('/api/devices/' + display.deviceId + '/ack', { revision: 1, deliveryNonce: restored.delivery.deliveryNonce }, { token: display.deviceToken });
  check((await ack.json()).status, 'rendered');
  check((await call('/api/owner/grants/' + grant.grantId + '/revoke', {}, { owner })).status, 200);
  check((await call('/api/owner/logout', {}, { owner })).status, 200);
  await server.update({ workers: [{ config, vars: { PUBLIC_ORIGIN: origin, TEST_RELOAD: '3' }, secrets }] });
  check((await call('/api/owner/state', undefined, { owner })).status, 401);
  check((await call('/api/agent/devices/' + display.deviceId + '/capabilities', undefined, { token: grant.grantToken })).status, 401);
  console.log(checks + ' retained-pilot local workerd runtime checks passed. Test-only owner and ACK, not physical tablet proof.');
} finally { await server.close(); }
