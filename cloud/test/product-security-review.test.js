import test from 'node:test';
import assert from 'node:assert/strict';
import { oauthRoute } from '../src/product/oauth.js';
import { authenticate, identityRoute } from '../src/product/identity.js';
import { random, digest } from '../src/product/common.js';
import { RateBudgets } from '../src/product/budgets.js';
import { loadLocal } from '../src/product/local.js';

const ORIGIN = 'https://security-review.example.com';
const NOW = Date.parse('2026-10-10T12:00:00Z');

function fixture(realAuthentication = false) {
  const records = new Map();
  const lists = [];
  const grants = [];
  const store = {
    async get(key) { return structuredClone(records.get(key)); },
    async put(key, value) { records.set(key, structuredClone(value)); },
    async delete(key) { return records.delete(key); },
    async list(prefix, limit = 200) {
      lists.push(prefix);
      return new Map([...records].filter(([key]) => key.startsWith(prefix)).sort(([first], [second]) => first.localeCompare(second)).slice(0, limit).map(([key, value]) => [key, structuredClone(value)]));
    },
    async transaction(callback) {
      const before = structuredClone(records);
      try { return await callback(store); }
      catch (error) { records.clear(); for (const [key, value] of before) records.set(key, value); throw error; }
    },
  };
  const accountId = random(16);
  const principal = { accountId, sessionId: random(), csrf: random(), verifiedAt: NOW };
  records.set('account:' + accountId, { id: accountId, status: 'active', authVersion: 1 });
  const context = {
    origin: ORIGIN, env: {}, store, now: () => NOW,
    rate: async () => {},
    requireBrowser: async () => principal,
    homeCall: async (homeId, actor, command, input) => {
      if (command === 'grant.create') {
        const grant = { ...input, id: random(18), accountId: actor.accountId, homeId };
        grants.push(grant);
        return grant;
      }
      if (command === 'grant.revoke') return { stopped: true };
      throw new Error('Unexpected household command');
    },
  };
  context.authenticate = realAuthentication ? request => authenticate(request, context) : async () => principal;
  return { context, records, lists, grants };
}

function post(path, body, headers = {}) {
  return new Request(ORIGIN + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

async function registered(context) {
  const response = await oauthRoute(post('/oauth/register', { client_name: 'Disposable review client', redirect_uris: ['https://assistant-review.example.com/callback'], scope: 'display:read content:write' }), context);
  assert.equal(response.status, 201);
  return response.json();
}

async function authorizationUrl(client) {
  const url = new URL(ORIGIN + '/oauth/authorize');
  url.search = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: client.redirect_uris[0], state: 'review-state', code_challenge_method: 'S256', code_challenge: await digest(random()), resource: ORIGIN + '/mcp', scope: 'display:read content:write' }).toString();
  return url;
}

test('external top-level assistant authorization reaches consent without weakening POST origin checks', async () => {
  const { context } = fixture(true);
  const client = await registered(context);
  const response = await oauthRoute(new Request(await authorizationUrl(client), { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' } }), context);
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /^https:\/\/security-review\.example\.com\/home#connect=/);
  await assert.rejects(identityRoute(post('/auth/register/options', { name: 'Synthetic person' }, { Origin: 'https://attacker.example.com', 'Sec-Fetch-Site': 'cross-site' }), context), error => error.status === 403);
});

test('external Google callback navigation can inspect a session but cross-site API reads cannot', async () => {
  const { context } = fixture(true);
  const navigation = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  await assert.rejects(authenticate(new Request(ORIGIN + '/api/v1/providers/google/callback?code=synthetic&state=synthetic', { headers: navigation }), context), error => error.status === 401);
  await assert.rejects(authenticate(new Request(ORIGIN + '/api/v1/me', { headers: navigation }), context), error => error.status === 403);
});

test('public OAuth metadata does not scan encrypted credential and token records', async () => {
  const { context, lists } = fixture();
  const response = await oauthRoute(new Request(ORIGIN + '/.well-known/oauth-authorization-server'), context);
  assert.equal(response.status, 200);
  assert.deepEqual(lists.filter(prefix => ['authorization:', 'code:', 'access:', 'refresh:'].includes(prefix)), []);
});

test('lost approval response can be retried without minting another grant or code', async () => {
  const { context, grants } = fixture();
  const client = await registered(context);
  const authorization = await oauthRoute(new Request(await authorizationUrl(client)), context);
  assert.equal(authorization.status, 302);
  const cookie = authorization.headers.get('set-cookie').split(';')[0];
  const intentId = new URL(authorization.headers.get('location')).hash.split('=')[1];
  const body = { intentId, homeId: random(24), deviceIds: [random(24)], scopes: ['display:read', 'content:write'], duration: 3600 };
  const first = await oauthRoute(post('/api/v1/connections/approve', body, { Cookie: cookie, Origin: ORIGIN }), context);
  assert.equal(first.status, 200);
  const original = await first.json();
  const retried = await oauthRoute(post('/api/v1/connections/approve', body, { Cookie: cookie, Origin: ORIGIN }), context);
  assert.equal(retried.status, 200);
  assert.deepEqual(await retried.json(), original);
  assert.equal(grants.length, 1);
});

async function exhaustedPublicBudgets(context) {
  const budgets = new RateBudgets({ now: () => NOW, capacity: 2 });
  await budgets.take('oauth:entry:synthetic-attacker-one', 1, 60000);
  await budgets.take('oauth:entry:synthetic-attacker-two', 1, 60000);
  context.rate = (bucket, limit, windowMs) => budgets.take(bucket, limit, windowMs);
  return budgets;
}

test('authenticated owner connection checks survive a full public admission map', async () => {
  const { context } = fixture();
  const budgets = await exhaustedPublicBudgets(context);
  const response = await oauthRoute(new Request(ORIGIN + '/api/v1/connections/pending'), context);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { intents: [] });
  assert.ok(budgets.groups.get('family')?.size > 0);
});

test('verified assistant MCP requests survive a full public admission map', async () => {
  const { context, records } = fixture();
  const accountId = [...records.values()][0].id;
  const accessToken = random();
  const clientId = random();
  const grantId = random(18);
  const homeId = random(24);
  const familyId = random();
  const deviceIds = [random(24)];
  const scopes = ['display:read'];
  const expiresAt = NOW + 600000;
  const record = { accountId, accountAuthVersion: 1, clientId, grantId, homeId, familyId, deviceIds, scopes, resource: ORIGIN + '/mcp', issuer: ORIGIN, grantExpiresAt: expiresAt, expiresAt };
  records.set('client:' + clientId, { id: clientId, expiresAt });
  records.set('access:' + await digest(accessToken), record);
  records.set('refresh:family:' + familyId, { ...record, revoked: false });
  const callHome = context.homeCall;
  context.homeCall = async (requestedHome, principal, command, input) => command === 'grant.check'
    ? { id: grantId, accountId, clientId, deviceIds, scopes, expiresAt }
    : callHome(requestedHome, principal, command, input);
  const budgets = await exhaustedPublicBudgets(context);
  const response = await oauthRoute(post('/mcp', { jsonrpc: '2.0', id: 1, method: 'ping', params: {} }, { Authorization: 'Bearer ' + accessToken, Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' }), context);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { jsonrpc: '2.0', id: 1, result: {} });
  assert.ok(budgets.groups.get('assistants')?.has('oauth:mcp-grant:' + grantId));
});

async function refreshFixture() {
  const result = fixture();
  const { context, records } = result;
  const accountId = [...records.values()][0].id;
  const refreshToken = random();
  const clientId = random();
  const grantId = random(18);
  const familyId = random();
  const deviceIds = [random(24)];
  const scopes = ['display:read'];
  const expiresAt = NOW + 600000;
  const record = { accountId, accountAuthVersion: 1, clientId, grantId, homeId: random(24), familyId, deviceIds, scopes, resource: ORIGIN + '/mcp', issuer: ORIGIN, grantExpiresAt: expiresAt, expiresAt, used: false };
  records.set('client:' + clientId, { id: clientId, grantTypes: ['authorization_code', 'refresh_token'], expiresAt });
  const refreshKey = 'refresh:token:' + await digest(refreshToken);
  records.set(refreshKey, record);
  records.set('refresh:family:' + familyId, { ...record, revoked: false });
  const callHome = context.homeCall;
  context.homeCall = async (homeId, principal, command, input) => command === 'grant.check'
    ? { id: grantId, accountId, clientId, deviceIds, scopes, expiresAt }
    : callHome(homeId, principal, command, input);
  return { ...result, record, refreshKey, refreshToken, clientId };
}

function refreshRequest(clientId, refreshToken) {
  return new Request(ORIGIN + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: refreshToken, resource: ORIGIN + '/mcp' }).toString() });
}

test('verified refresh rotates through approved admission while public capacity is exhausted', async () => {
  const { context, records, record, refreshKey, refreshToken, clientId } = await refreshFixture();
  const budgets = await exhaustedPublicBudgets(context);
  const response = await oauthRoute(refreshRequest(clientId, refreshToken), context);
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.match(result.access_token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(result.refresh_token, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(result.refresh_token, refreshToken);
  assert.equal(result.scope, 'display:read');
  assert.equal(result.resource, ORIGIN + '/mcp');
  assert.equal(records.get(refreshKey).used, true);
  assert.equal(records.get('refresh:family:' + record.familyId).revoked, false);
  assert.ok(budgets.groups.get('assistants')?.size > 0);
});

test('registered client without a valid refresh proof cannot enter approved admission', async () => {
  const { context, records, clientId, refreshKey } = await refreshFixture();
  const budgets = await exhaustedPublicBudgets(context);
  const response = await oauthRoute(refreshRequest(clientId, random()), context);
  assert.ok([400, 401, 429].includes(response.status));
  assert.equal((await response.json()).access_token, undefined);
  assert.equal(budgets.groups.get('assistants')?.size || 0, 0);
  assert.equal(records.get(refreshKey).used, false);
});

function localReviewFixture(enabled = true) {
  const device = { id: 'review-screen', homeId: 'review-home', epoch: 3, state: 'owned', tokenHash: 'verified' };
  let latest = { ...device };
  let reads = 0;
  const input = {
    device,
    now: () => NOW,
    store: { async get() { return { ...latest }; } },
    homeCall: async () => ({ settings: { timezone: 'UTC' }, screens: [{ id: device.id, epoch: 3 }] }),
    adapter: {
      async location() {
        reads++;
        return { version: 1, location: { weather: enabled, nearby: false }, weatherAvailable: true, nearbyAvailable: false };
      },
      async googleWeather() {
        return { locationVersion: 1, ephemeral: true, attribution: 'Google Maps', thirdPartyAttributions: [], expiresAt: NOW + 1000, cityLabel: 'Synthetic city', weather: [] };
      }
    }
  };
  return { input, reads: () => reads, reset: () => { latest = { ...latest, state: 'erase', epoch: 4, tokenHash: 'rotated' }; } };
}

test('local delivery requires an explicit serialized finalizer before reading authority or requesting providers', async () => {
  const state = localReviewFixture();
  await assert.rejects(loadLocal(state.input), { status: 503 });
  assert.equal(state.reads(), 0);
});

for (const enabled of [true, false]) {
  test('final local metadata await cannot return after reset, including sharing enabled=' + enabled, async () => {
    const state = localReviewFixture(enabled);
    const location = state.input.adapter.location;
    state.input.adapter.location = async () => {
      const source = await location();
      if (state.reads() === 2) state.reset();
      return source;
    };
    state.input.finalize = callback => callback();
    await assert.rejects(loadLocal(state.input), { status: 403 });
    assert.equal(state.reads(), 2);
  });
}

test('local finalizer constructs the response after final proof and never encloses the Google request', async () => {
  const state = localReviewFixture();
  let held = false;
  let finalized = 0;
  const weather = state.input.adapter.googleWeather;
  state.input.adapter.googleWeather = async () => { assert.equal(held, false); return weather(); };
  const location = state.input.adapter.location;
  state.input.adapter.location = async () => {
    const source = await location();
    assert.equal(held, state.reads() === 2);
    return source;
  };
  state.input.finalize = async callback => {
    held = true;
    try {
      const response = Response.json(await callback());
      assert.equal(held, true);
      finalized++;
      return response;
    } finally { held = false; }
  };
  const response = await loadLocal(state.input);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).available, true);
  assert.equal(finalized, 1);
  assert.equal(held, false);
});
