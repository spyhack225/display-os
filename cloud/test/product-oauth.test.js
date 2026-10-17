import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { registerClient } from '@modelcontextprotocol/sdk/client/auth.js';
import { oauthRoute, authenticateAgent } from '../src/product/oauth.js';
import { HttpError, random, digest, publicConnectionRead, publicConnectionResponse } from '../src/product/common.js';
import { validateSnapshot, sampleSnapshot, validateSettings, capabilities } from '../src/product/family.js';
import { RateBudgets } from '../src/product/budgets.js';

class MemoryStore {
  constructor(data = new Map(), root = null) { this.data = data; this.root = root || this; this.fail = null; this.writes = 0; this.lists = 0; }
  async get(key) { const value = this.data.get(key); return value === undefined ? undefined : structuredClone(value); }
  async put(key, value) {
    this.root.writes++;
    if (this.root.fail?.(key, value)) { this.root.fail = null; throw new Error('Injected storage failure'); }
    this.data.set(key, structuredClone(value));
  }
  async delete(key) { this.root.writes++; return this.data.delete(key); }
  async list(prefix, limit = 200) {
    this.root.lists++;
    return new Map([...this.data.entries()].filter(([key]) => key.startsWith(prefix)).sort(([first], [second]) => first.localeCompare(second)).slice(0, limit).map(([key, value]) => [key, structuredClone(value)]));
  }
  async transaction(callback) {
    const transaction = new MemoryStore(structuredClone(this.data), this.root);
    const value = await callback(transaction);
    this.data = transaction.data;
    return value;
  }
}

async function fixture() {
  let now = Date.now();
  let address = 1;
  const origin = 'https://displayos.example.com';
  const store = new MemoryStore();
  const accountId = random(16);
  const otherAccountId = random(16);
  const homeId = random(18);
  const otherHomeId = random(18);
  const deviceId = random(18);
  const secondDeviceId = random(18);
  const otherDeviceId = random(18);
  const homes = new Map([
    [homeId, { owner: accountId, devices: [deviceId, secondDeviceId], grants: new Map(), operations: new Map(), photos: [], revision: 0, timezone: 'UTC' }],
    [otherHomeId, { owner: otherAccountId, devices: [otherDeviceId], grants: new Map(), operations: new Map(), photos: [], revision: 0, timezone: 'UTC' }]
  ]);
  await store.put('account:' + accountId, { id: accountId, status: 'active', authVersion: 1 });
  await store.put('account:' + otherAccountId, { id: otherAccountId, status: 'active', authVersion: 1 });
  const budgets = new Map();
  const calls = [];
  const context = {
    origin, env: {}, store, now: () => now,
    async rate(bucket, limit, window) {
      let entry = budgets.get(bucket);
      if (!entry || entry.until <= now) { entry = { count: 0, until: now + window }; budgets.set(bucket, entry); }
      if (entry.count >= limit) throw new HttpError(429, 'Please wait.');
      entry.count++;
    },
    async authenticate(request) {
      const cookies = request.headers.get('cookie') || '';
      const owner = /(?:^|;\s*)owner=(A|B)(?:;|$)/.exec(cookies)?.[1];
      if (!owner) throw new HttpError(401, 'Sign in.');
      const session = /(?:^|;\s*)session=([a-z]+)(?:;|$)/.exec(cookies)?.[1] || 'first';
      return { accountId: owner === 'A' ? accountId : otherAccountId, sessionId: owner + ':' + session, csrf: 'test-csrf-' + owner, verifiedAt: now };
    },
    async requireBrowser(request) {
      const principal = await this.authenticate(request);
      if (request.headers.get('origin') !== origin || request.headers.get('X-DisplayOS-CSRF') !== principal.csrf) throw new HttpError(403, 'Confirm this change.');
      return principal;
    },
    async homeCall(id, principal, command, input = {}) {
      calls.push({ homeId: id, principal: structuredClone(principal), command, input: structuredClone(input) });
      const home = homes.get(id);
      if (!home) throw new HttpError(404, 'This home is unavailable.');
      if (home.owner !== principal.accountId) throw new HttpError(403, 'This home is unavailable.');
      if (command === 'grant.create') {
        if (input.deviceIds.some(device => !home.devices.includes(device))) throw new HttpError(400, 'Choose screens in this home.');
        const existing = home.operations.get(input.operationId);
        const hash = await digest(JSON.stringify(input));
        if (existing) {
          if (existing.hash !== hash) throw new HttpError(409, 'The permissions cannot change.');
          return structuredClone(home.grants.get(existing.id));
        }
        const value = { id: random(18), accountId: principal.accountId, ...input };
        home.grants.set(value.id, value);
        home.operations.set(input.operationId, { id: value.id, hash });
        return structuredClone(value);
      }
      if (command === 'grant.revoke') { const grant = home.grants.get(input.grantId); if (grant) grant.revokedAt = now; return { stopped: true }; }
      if (command === 'grant.check') {
        assert.equal(principal.grantId, undefined, 'grant.check must use account authority');
        const grant = home.grants.get(input.grantId);
        if (!grant || grant.revokedAt || grant.expiresAt <= now || !grant.deviceIds.length || input.deviceIds?.some(device => !grant.deviceIds.includes(device) || !home.devices.includes(device))) throw new HttpError(403, 'This assistant no longer has access.');
        return structuredClone(grant);
      }
      const grant = home.grants.get(principal.grantId);
      if (!grant || grant.revokedAt || grant.expiresAt <= now || grant.clientId !== principal.clientId || grant.accountId !== principal.accountId) throw new HttpError(403, 'This assistant no longer has access.');
      const scope = { 'screen.list': 'display:read', 'screen.capabilities': 'display:read', 'family.current': 'display:read', 'media.list': 'display:read', 'revision.status': 'display:read', 'family.publish': 'content:write', 'screen.settings': 'settings:write', 'media.upload': 'media:write' }[command];
      if (!scope || !grant.scopes.includes(scope) || !principal.scopes.includes(scope) || input.deviceId && !grant.deviceIds.includes(input.deviceId)) throw new HttpError(403, 'This permission was not approved.');
      if (command === 'screen.list') return { screens: home.devices.filter(device => grant.deviceIds.includes(device)).map(device => ({ id: device, name: 'Synthetic screen', revision: home.revision, timezone: home.timezone })) };
      if (command === 'screen.capabilities') return capabilities();
      if (command === 'family.current') return { snapshot: home.snapshot?.expiresAt > now ? home.snapshot : null, revision: home.revision };
      if (command === 'media.list') return { photos: home.photos };
      if (command === 'family.publish') {
        validateSnapshot(input.snapshot, now);
        if (input.snapshot.timezone !== home.timezone) throw new HttpError(400, 'Use the selected screen timezone.');
        if (input.expectedRevision !== home.revision) throw new HttpError(409, 'Another update arrived first.');
        home.revision++;
        home.snapshot = input.snapshot;
        return { revision: home.revision, status: 'accepted' };
      }
      if (command === 'revision.status') return { revision: input.revision, acceptedAt: now, status: 'accepted' };
      if (command === 'screen.settings') return { saved: true, settings: validateSettings(input.settings) };
      if (command === 'media.upload') { const mediaId = random(18); home.photos.push({ mediaId, mime: input.mime, width: 1, height: 1, approvedAt: now }); return { mediaId }; }
      throw new HttpError(404, 'Not available.');
    }
  };
  function request(path, value, options = {}) {
    const method = options.method || (value === undefined ? 'GET' : 'POST');
    const headers = new Headers(options.headers);
    headers.set('CF-Connecting-IP', options.ip || '192.0.2.1');
    if (options.owner) {
      headers.set('cookie', ['owner=' + options.owner, options.session ? 'session=' + options.session : '', options.cookie || ''].filter(Boolean).join('; '));
      if (method === 'POST') { headers.set('origin', options.origin ?? origin); headers.set('X-DisplayOS-CSRF', options.csrf ?? 'test-csrf-' + options.owner); }
    } else if (options.cookie) headers.set('cookie', options.cookie);
    if (options.origin !== undefined) headers.set('origin', options.origin);
    if (options.token) headers.set('authorization', 'Bearer ' + options.token);
    let body;
    if (method !== 'GET' && method !== 'HEAD') {
      body = options.raw ?? (options.form ? new URLSearchParams(value).toString() : JSON.stringify(value));
      headers.set('content-type', options.type || (options.form ? 'application/x-www-form-urlencoded' : 'application/json'));
    }
    return new Request((options.url || origin) + path, { method, headers, body });
  }
  async function call(path, value, options = {}) {
    const response = await oauthRoute(request(path, value, options), context);
    if (response === null) return null;
    const body = await response.text();
    return { response, status: response.status, value: body ? JSON.parse(body) : null, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  async function register(options = {}) {
    const result = await call('/oauth/register', { client_name: 'Synthetic assistant', redirect_uris: ['https://assistant.example.com/callback'], ...options.value }, { ip: '198.51.100.' + address++, ...options });
    assert.equal(result.status, 201, JSON.stringify(result.value));
    return result.value;
  }
  async function start(options = {}) {
    const registered = options.registered || await register();
    const verifier = random();
    const params = { response_type: 'code', client_id: registered.client_id, redirect_uri: registered.redirect_uris[0], state: random(24), code_challenge_method: 'S256', code_challenge: await digest(verifier), resource: origin + '/mcp', scope: (options.scopes || ['display:read', 'content:write']).join(' '), ...options.params };
    if (options.omitResource) delete params.resource;
    if (options.omitScope) delete params.scope;
    const response = await call('/oauth/authorize?' + new URLSearchParams(params), undefined, options);
    assert.equal(response.status, 302, JSON.stringify(response.value));
    const intentId = new URL(response.response.headers.get('location')).hash.split('=')[1];
    return { registered, verifier, params, intentId, cookie: response.cookie, response };
  }
  async function approve(flow, options = {}) {
    return call('/api/v1/connections/approve', { intentId: flow.intentId, homeId, deviceIds: [deviceId], scopes: flow.params.scope.split(' '), duration: 3600, ...options.value }, { owner: 'A', cookie: flow.cookie, ...options });
  }
  async function granted(options = {}) {
    const flow = await start(options);
    const approval = await approve(flow, options.approval);
    assert.equal(approval.status, 200, JSON.stringify(approval.value));
    const code = new URL(approval.value.redirectUrl).searchParams.get('code');
    const form = { grant_type: 'authorization_code', client_id: flow.registered.client_id, code, code_verifier: flow.verifier, redirect_uri: flow.params.redirect_uri, resource: origin + '/mcp' };
    const result = await call('/oauth/token', form, { form: true });
    assert.equal(result.status, 200, JSON.stringify(result.value));
    const grant = [...homes.get(homeId).grants.values()].find(value => value.clientId === flow.registered.client_id);
    return { ...flow, tokens: result.value, form, grant, approval };
  }
  async function rpc(token, method, params = {}, options = {}) {
    return call('/mcp', { jsonrpc: '2.0', id: 1, method, params, ...options.message }, { token, ...options, headers: { Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25', ...options.headers } });
  }
  function refreshForm(flow, token = flow.tokens.refresh_token) { return { grant_type: 'refresh_token', client_id: flow.registered.client_id, refresh_token: token, resource: origin + '/mcp' }; }
  return { context, store, origin, accountId, otherAccountId, homeId, otherHomeId, deviceId, secondDeviceId, otherDeviceId, homes, budgets, calls, request, call, register, start, approve, granted, rpc, refreshForm, advance: value => { now += value; } };
}

test('MCP scan diagnostics contain fixed protocol metadata, never credentials or supplied content', async () => {
  const setup = await fixture();
  const flow = await setup.granted();
  const logs = [];
  const original = console.info;
  console.info = value => logs.push(JSON.parse(value));
  try {
    await setup.rpc(flow.tokens.access_token, 'initialize', { protocolVersion: 'private-client-value', capabilities: {}, clientInfo: { name: 'private-client-value', version: '1' } }, { message: { id: 'private-request-id' } });
    await setup.rpc(flow.tokens.access_token, 'tools/list');
    await setup.rpc(flow.tokens.access_token, 'private-method-name');
    await setup.rpc(flow.tokens.access_token, 'tools/list', {}, { headers: { 'MCP-Protocol-Version': 'private-header-value' } });
    await setup.rpc(flow.tokens.access_token, 'tools/call', { name: 'screen_list', arguments: {} });
    assert.equal(logs.length, 4);
    assert.deepEqual(logs.map(value => value.method), ['initialize', 'tools/list', 'other', 'other']);
    assert.equal(logs[1].toolCount, 9);
    assert.equal(logs[2].rpcError, -32601);
    assert.equal(logs[3].protocolHeader, 'unsupported');
    assert.equal(logs[3].status, 400);
    for (const value of logs) assert.deepEqual(Object.keys(value), ['event', 'method', 'status', 'protocolHeader', 'rpcError', 'toolCount']);
    const encoded = JSON.stringify(logs);
    for (const privateValue of [flow.tokens.access_token, flow.tokens.refresh_token, flow.registered.client_id, setup.homeId, setup.deviceId, 'private-client-value', 'private-request-id', 'private-method-name', 'private-header-value']) assert.equal(encoded.includes(privateValue), false);
  } finally { console.info = original; }
});

test('authenticated oversized MCP bodies are rejected without diagnostic stream stalls', { timeout: 2000 }, async () => {
  const setup = await fixture();
  const flow = await setup.granted();
  const response = await setup.rpc(flow.tokens.access_token, 'initialize', { padding: 'a'.repeat(150000) });
  assert.equal(response.status, 413);
  assert.equal(response.value.error.code, -32600);
});

test('OAuth and resource discovery advertise the bounded public-client protocol', async () => {
  const setup = await fixture();
  const metadata = await setup.call('/.well-known/oauth-authorization-server');
  assert.equal(metadata.value.issuer, setup.origin);
  assert.deepEqual(metadata.value.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(metadata.value.token_endpoint_auth_methods_supported, ['none']);
  assert.equal(metadata.value.client_id_metadata_document_supported, false);
  assert.equal(metadata.value.authorization_response_iss_parameter_supported, true);
  for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const resource = await setup.call(path);
    assert.equal(resource.value.resource, setup.origin + '/mcp');
    assert.deepEqual(resource.value.authorization_servers, [setup.origin]);
    assert.equal(resource.response.headers.get('cache-control'), 'no-store');
  }
  const unauthorized = await setup.call('/mcp');
  assert.equal(unauthorized.status, 401);
  assert.match(unauthorized.response.headers.get('www-authenticate'), /resource_metadata="https:\/\/displayos.example.com\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.equal(await setup.call('/not-this-module'), null);
});

test('public connection reads cover only exact HTTPS GET instructions and discovery', () => {
  const origin = 'https://displayos.example.com';
  const paths = ['/skill.md', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'];
  for (const path of paths) {
    const request = new Request(origin + path, { headers: { Origin: 'null' } });
    assert.equal(publicConnectionRead(request), true);
    const response = publicConnectionResponse(request, new Response('Public fixture'));
    assert.equal(response.headers.get('access-control-allow-origin'), '*');
    assert.equal(response.headers.get('access-control-allow-credentials'), null);
    assert.equal(response.headers.get('set-cookie'), null);
    const denied = publicConnectionResponse(request, new Response('Denied', { status: 429 }));
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
    for (const method of ['HEAD', 'POST', 'OPTIONS', 'DELETE']) assert.equal(publicConnectionRead(new Request(origin + path, { method })), false);
    for (const suffix of ['/', '?token=synthetic', '#fragment']) assert.equal(publicConnectionRead(new Request(origin + path + suffix)), false);
    assert.equal(publicConnectionRead(new Request('http://displayos.example.com' + path)), false);
    assert.equal(publicConnectionRead({ method: 'GET', url: 'https://user:password@displayos.example.com' + path }), false);
  }
  for (const path of ['/home', '/mcp', '/oauth/token', '/oauth/register', '/product/skill.md', '/pilot/skill.md', '/.well-known/oauth-protected-resource/other']) {
    const request = new Request(origin + path);
    assert.equal(publicConnectionRead(request), false);
    assert.equal(publicConnectionResponse(request, new Response('Private fixture')).headers.get('access-control-allow-origin'), null);
  }
});

test('public connection discovery accepts foreign and null Origins without credentials or state changes', async () => {
  const setup = await fixture();
  const writes = setup.store.writes;
  for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const baseline = await setup.call(path);
    for (const origin of [undefined, setup.origin, 'https://chatgpt.com', 'https://www.meta.ai', 'null']) {
      const result = await setup.call(path, undefined, { origin, owner: 'A', token: 'synthetic-credential-marker' });
      assert.equal(result.status, 200);
      assert.deepEqual(result.value, baseline.value);
      assert.equal(result.response.headers.get('access-control-allow-origin'), '*');
      assert.equal(result.response.headers.get('access-control-allow-credentials'), null);
      assert.equal(result.response.headers.get('set-cookie'), null);
      assert.equal(result.response.headers.get('cache-control'), 'no-store');
      assert.equal(JSON.stringify(result.value).includes('synthetic-credential-marker'), false);
      assert.equal(JSON.stringify(result.value).includes(setup.accountId), false);
    }
  }
  assert.equal(setup.store.writes, writes);
  assert.equal(setup.calls.length, 0);
});

test('public connection exception leaves authenticated MCP and OAuth mutations foreign-Origin denied', async () => {
  const setup = await fixture();
  const flow = await setup.granted();
  const writes = setup.store.writes;
  const calls = setup.calls.length;
  for (const origin of ['https://chatgpt.com', 'null']) {
    for (const [path, body] of [
      ['/mcp', undefined], ['/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }],
      ['/oauth/register', { redirect_uris: ['https://assistant.example.com/callback'] }],
      ['/oauth/token', setup.refreshForm(flow)], ['/oauth/revoke', { token: flow.tokens.refresh_token, client_id: flow.registered.client_id }],
      ['/oauth/authorize', undefined], ['/api/v1/connections/pending', undefined],
      ['/api/v1/connections/approve', {}], ['/api/v1/connections/deny', {}], ['/api/v1/connections/revoke', {}]
    ]) {
      const result = await setup.call(path, body, { origin, owner: 'A', token: flow.tokens.access_token, form: path === '/oauth/token' || path === '/oauth/revoke' });
      assert.equal(result.status, 403, path);
      assert.equal(result.response.headers.get('access-control-allow-origin'), null);
      assert.equal(result.response.headers.get('access-control-allow-credentials'), null);
      assert.equal(result.response.headers.get('set-cookie'), null);
      assert.equal(result.response.headers.get('location'), null);
    }
  }
  assert.equal(setup.store.writes, writes);
  assert.equal(setup.calls.length, calls);
  assert.equal((await setup.rpc(flow.tokens.access_token, 'tools/list')).status, 200);
});

test('public connection discovery does not broaden HEAD, mutation, query or hostname handling', async () => {
  const setup = await fixture();
  for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    for (const method of ['HEAD', 'POST', 'OPTIONS', 'DELETE']) {
      const result = await setup.call(path, undefined, { method, origin: 'null' });
      assert.equal(result.status, 403);
      assert.equal(result.response.headers.get('access-control-allow-origin'), null);
    }
    const head = await setup.call(path, undefined, { method: 'HEAD' });
    assert.equal(head.status, 405);
    assert.equal(head.response.headers.get('access-control-allow-origin'), null);
    const query = await setup.call(path + '?token=synthetic', undefined, { origin: 'null' });
    assert.equal(query.status, 400);
    assert.equal(query.response.headers.get('access-control-allow-origin'), null);
    const hostname = await setup.call(path, undefined, { url: 'https://other.example.com', origin: 'null' });
    assert.equal(hostname.status, 403);
    assert.equal(hostname.response.headers.get('access-control-allow-origin'), null);
  }
});

test('DCR accepts exact HTTPS public clients without secrets or metadata fetching', async () => {
  const setup = await fixture();
  const result = await setup.register({ value: { scope: 'display:read', grant_types: ['authorization_code'], token_endpoint_auth_method: 'none' } });
  assert.ok(result.client_id);
  assert.equal(result.client_secret, undefined);
  assert.deepEqual(result.grant_types, ['authorization_code']);
  assert.equal((await setup.store.get('client:' + result.client_id)).name, 'Synthetic assistant');
  const ignored = await setup.call('/oauth/register', { redirect_uris: ['https://assistant.example.com/callback'], logo_uri: 'http://169.254.169.254/latest/meta-data/' });
  assert.equal(ignored.status, 201);
  assert.equal(ignored.value.logo_uri, undefined);
  assert.equal((await setup.store.get('client:' + ignored.value.client_id)).logo_uri, undefined);
});

test('DCR ignores optional and extension metadata without echo, persistence or network lookup', async testcase => {
  const setup = await fixture();
  const fetches = [];
  testcase.mock.method(globalThis, 'fetch', async (...args) => { fetches.push(args); throw new Error('Unexpected metadata lookup'); });
  const metadata = {
    client_uri: 'https://client.example.com/private-metadata-marker',
    logo_uri: 'http://169.254.169.254/private-metadata-marker',
    contacts: ['private-metadata-marker@example.com'],
    tos_uri: 'https://client.example.com/private-metadata-marker/terms',
    policy_uri: 'https://client.example.com/private-metadata-marker/privacy',
    jwks_uri: 'http://127.0.0.1/private-metadata-marker',
    jwks: { keys: [{ kty: 'oct', k: 'private-metadata-marker' }] },
    software_id: 'private-metadata-marker',
    software_version: 'private-metadata-marker',
    software_statement: 'private-metadata-marker',
    'client_name#fr': 'private-metadata-marker',
    extension: { nested: ['private-metadata-marker'] }
  };
  const registered = await setup.register({ value: { ...metadata, scope: 'display:read', grant_types: ['authorization_code'], token_endpoint_auth_method: 'none' } });
  const stored = await setup.store.get('client:' + registered.client_id);
  assert.deepEqual(Object.keys(registered).sort(), ['client_id', 'client_id_issued_at', 'client_name', 'redirect_uris', 'grant_types', 'response_types', 'token_endpoint_auth_method', 'scope'].sort());
  assert.deepEqual(Object.keys(stored).sort(), ['id', 'name', 'redirectUris', 'grantTypes', 'scopes', 'createdAt', 'expiresAt'].sort());
  assert.equal(stored.name, 'Synthetic assistant');
  assert.deepEqual(stored.scopes, ['display:read']);
  assert.deepEqual(stored.redirectUris, ['https://assistant.example.com/callback']);
  for (const field of Object.keys(metadata)) {
    assert.equal(Object.hasOwn(registered, field), false, field);
    assert.equal(Object.hasOwn(stored, field), false, field);
  }
  assert.equal(JSON.stringify(registered).includes('private-metadata-marker'), false);
  assert.equal(JSON.stringify([...setup.store.data.entries()]).includes('private-metadata-marker'), false);
  assert.deepEqual(fetches, []);
  assert.deepEqual(setup.calls, []);
});

test('DCR ignores forged authority and prototype metadata without overwriting clients or granting permissions', async testcase => {
  const setup = await fixture();
  const fetches = [];
  testcase.mock.method(globalThis, 'fetch', async (...args) => { fetches.push(args); throw new Error('Unexpected metadata lookup'); });
  const existing = await setup.register();
  const existingRecord = await setup.store.get('client:' + existing.client_id);
  const metadata = JSON.parse('{"__proto__":{"system":true,"scope":"media:write"},"constructor":{"prototype":{"system":true}},"prototype":{"system":true}}');
  Object.assign(metadata, {
    client_id: existing.client_id, client_secret: 'synthetic-secret-marker',
    accountId: setup.otherAccountId, homeId: setup.otherHomeId, deviceIds: [setup.otherDeviceId],
    principal: { system: true, accountId: setup.otherAccountId, role: 'owner' },
    system: true, role: 'owner', clientIdentityVerified: true, approved: true,
    status: 'approved', scopes: ['display:read', 'content:write', 'settings:write', 'media:write'],
    redirectUris: ['https://evil.example.com/callback'], grantTypes: ['client_credentials'],
    authorization_endpoint: 'http://169.254.169.254/authorize', token_endpoint: 'http://127.0.0.1/token'
  });
  const registered = await setup.register({ value: { ...metadata, scope: 'display:read' } });
  assert.notEqual(registered.client_id, existing.client_id);
  assert.equal(registered.token_endpoint_auth_method, 'none');
  assert.equal(registered.client_secret, undefined);
  assert.equal(registered.scope, 'display:read');
  assert.deepEqual(await setup.store.get('client:' + existing.client_id), existingRecord);
  const stored = await setup.store.get('client:' + registered.client_id);
  for (const field of Object.keys(metadata)) {
    if (field !== 'client_id') assert.equal(Object.hasOwn(registered, field), false, field);
    if (!['scopes', 'redirectUris', 'grantTypes'].includes(field)) assert.equal(Object.hasOwn(stored, field), false, field);
  }
  assert.deepEqual(stored.scopes, ['display:read']);
  assert.deepEqual(stored.redirectUris, ['https://assistant.example.com/callback']);
  assert.deepEqual(stored.grantTypes, ['authorization_code', 'refresh_token']);
  assert.equal(Object.prototype.system, undefined);
  assert.equal(Object.prototype.scope, undefined);
  assert.equal((await setup.store.list('authorization:')).size, 0);
  assert.equal((await setup.store.list('access:')).size, 0);
  assert.equal(setup.homes.get(setup.homeId).grants.size, 0);
  assert.equal(setup.homes.get(setup.otherHomeId).grants.size, 0);
  assert.deepEqual(setup.calls, []);
  const flow = await setup.start({ registered, scopes: ['display:read'] });
  assert.equal((await setup.approve(flow, { owner: 'B' })).status, 403);
  const granted = await setup.granted({ registered, scopes: ['display:read'] });
  const principal = await authenticateAgent(setup.request('/mcp', undefined, { token: granted.tokens.access_token }), setup.context);
  assert.equal(principal.accountId, setup.accountId);
  assert.equal(principal.homeId, setup.homeId);
  assert.deepEqual(principal.deviceIds, [setup.deviceId]);
  assert.deepEqual(principal.scopes, ['display:read']);
  assert.equal((await setup.rpc(granted.tokens.access_token, 'tools/call', { name: 'family_publish', arguments: {} })).status, 403);
  assert.deepEqual(fetches, []);
});

test('ignored DCR metadata cannot replace critical registration validation', async () => {
  const metadata = { logo_uri: 'http://169.254.169.254/logo', system: true, scopes: ['display:read'], token_endpoint_auth_methods_supported: ['none'], redirectUris: ['https://assistant.example.com/callback'] };
  const cases = [
    { token_endpoint_auth_method: 'client_secret_post' }, { token_endpoint_auth_method: 'client_secret_basic' },
    { token_endpoint_auth_method: 'private_key_jwt' }, { grant_types: ['client_credentials'] },
    { grant_types: ['authorization_code', 'implicit'] }, { grant_types: ['authorization_code', 'authorization_code'] },
    { response_types: ['token'] }, { scope: 'display:read admin:write' }, { scope: 'display:read display:read' },
    { redirect_uris: ['http://assistant.example.com/callback'] }, { redirect_uris: ['https://assistant.example.com/*'] },
    { redirect_uris: ['https://assistant.example.com/callback#fragment'] }, { redirect_uris: [] },
    { redirect_uris: ['https://assistant.example.com/callback', 'https://assistant.example.com/callback'] },
    { client_name: '<img>' }
  ];
  for (const changes of cases) {
    const setup = await fixture();
    const response = await setup.call('/oauth/register', { client_name: 'Synthetic assistant', redirect_uris: ['https://assistant.example.com/callback'], ...metadata, ...changes });
    assert.equal(response.status, 400, JSON.stringify(changes));
    assert.equal(response.response.headers.has('location'), false);
    assert.equal((await setup.store.list('client:')).size, 0);
    assert.deepEqual(setup.calls, []);
  }
});

test('DCR optional metadata leaves Origin, consent, PKCE and exact callback checks intact', async () => {
  const setup = await fixture();
  const metadata = { logo_uri: 'http://169.254.169.254/logo', client_secret: 'synthetic-secret-marker', system: true };
  const registration = { redirect_uris: ['https://assistant.example.com/callback'], scope: 'display:read', ...metadata };
  assert.equal((await setup.call('/oauth/register', registration, { origin: 'https://evil.example.com' })).status, 403);
  assert.equal((await setup.call('/oauth/register', registration, { origin: 'null' })).status, 403);
  assert.equal((await setup.store.list('client:')).size, 0);
  const registered = await setup.register({ value: registration });
  const flow = await setup.start({ registered, scopes: ['display:read'] });
  for (const changes of [{ code_challenge_method: 'plain' }, { redirect_uri: 'https://evil.example.com/callback' }, { resource: setup.origin + '/other' }, { scope: 'content:write' }]) {
    const response = await setup.call('/oauth/authorize?' + new URLSearchParams({ ...flow.params, ...changes }));
    assert.equal(response.status, 400, JSON.stringify(changes));
    assert.equal(response.response.headers.has('location'), false);
  }
  assert.equal((await setup.approve(flow, { origin: 'https://evil.example.com' })).status, 403);
  assert.equal((await setup.approve(flow, { csrf: 'wrong' })).status, 403);
  const approval = await setup.approve(flow);
  assert.equal(approval.status, 200);
  const code = new URL(approval.value.redirectUrl).searchParams.get('code');
  const form = { grant_type: 'authorization_code', client_id: registered.client_id, code, code_verifier: flow.verifier, redirect_uri: flow.params.redirect_uri, resource: setup.origin + '/mcp' };
  for (const changes of [{ code_verifier: random() }, { redirect_uri: form.redirect_uri + '/' }, { resource: setup.origin + '/other' }]) {
    assert.equal((await setup.call('/oauth/token', { ...form, ...changes }, { form: true })).status, 400);
  }
  assert.equal((await setup.call('/oauth/token', form, { form: true, headers: { Authorization: 'Basic synthetic' } })).value.error, 'invalid_client');
  assert.equal((await setup.store.get('code:' + await digest(code))).used, false);
  const issued = await setup.call('/oauth/token', form, { form: true });
  assert.equal(issued.status, 200);
  assert.equal(issued.value.scope, 'display:read');
});

test('ignored DCR metadata stays inside the JSON object and 8 KiB request bounds', async () => {
  for (const raw of ['null', '[]', '"client"', 'true']) {
    const setup = await fixture();
    assert.equal((await setup.call('/oauth/register', undefined, { method: 'POST', raw })).status, 400);
    assert.equal((await setup.store.list('client:')).size, 0);
  }
  const setup = await fixture();
  const response = await setup.call('/oauth/register', { redirect_uris: ['https://assistant.example.com/callback'], extension: 'ignored'.repeat(1400) });
  assert.equal(response.status, 413);
  assert.equal((await setup.store.list('client:')).size, 0);
});

test('authorization without a scope asks for the documented first-connection pair', async () => {
  const setup = await fixture();
  const registered = await setup.register();
  const flow = await setup.start({ registered, omitScope: true });
  const pending = await setup.call('/api/v1/connections/pending', undefined, { owner: 'A', cookie: flow.cookie });
  assert.equal(pending.status, 200);
  assert.deepEqual(pending.value.intents.map(intent => intent.scopes), [['display:read', 'content:write']]);
  const approval = await setup.call('/api/v1/connections/approve', { intentId: flow.intentId, homeId: setup.homeId, deviceIds: [setup.deviceId], scopes: ['display:read', 'content:write'], duration: 3600 }, { owner: 'A', cookie: flow.cookie });
  assert.equal(approval.status, 200, JSON.stringify(approval.value));
  const code = new URL(approval.value.redirectUrl).searchParams.get('code');
  const exchange = await setup.call('/oauth/token', { grant_type: 'authorization_code', client_id: registered.client_id, code, code_verifier: flow.verifier, redirect_uri: flow.params.redirect_uri, resource: setup.origin + '/mcp' }, { form: true });
  assert.equal(exchange.status, 200, JSON.stringify(exchange.value));
  assert.deepEqual(exchange.value.scope.split(' ').sort(), ['content:write', 'display:read']);
  const tools = await setup.rpc(exchange.value.access_token, 'tools/list');
  assert.ok(tools.value.result.tools.some(tool => tool.name === 'family_publish'));
});

test('authorization without a scope never exceeds the assistant registration', async () => {
  const setup = await fixture();
  const registered = await setup.register({ value: { scope: 'display:read' } });
  const flow = await setup.start({ registered, omitScope: true });
  const pending = await setup.call('/api/v1/connections/pending', undefined, { owner: 'A', cookie: flow.cookie });
  assert.equal(pending.status, 200);
  assert.deepEqual(pending.value.intents.map(intent => intent.scopes), [['display:read']]);
});

test('official MCP SDK DCR forwards optional metadata to the real route without metadata URL fetches', async testcase => {
  const setup = await fixture();
  const fetches = [];
  testcase.mock.method(globalThis, 'fetch', async (...args) => { fetches.push(args); throw new Error('Unexpected network lookup'); });
  const requests = [];
  const registered = await registerClient(new URL(setup.origin), {
    metadata: { registration_endpoint: setup.origin + '/oauth/register' },
    clientMetadata: {
      client_name: 'SDK registration fixture', redirect_uris: ['https://assistant.example.com/callback'],
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
      client_uri: 'https://client.example.com', logo_uri: 'https://client.example.com/logo.png', contacts: ['qa@example.com'],
      software_id: 'synthetic-sdk', software_version: '1.0.0'
    },
    scope: 'display:read content:write',
    fetchFn: async (url, options) => {
      const request = new Request(url, options);
      requests.push({ url: request.url, body: await request.clone().json() });
      return oauthRoute(request, setup.context);
    }
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, setup.origin + '/oauth/register');
  assert.equal(requests[0].body.logo_uri, 'https://client.example.com/logo.png');
  assert.equal(registered.client_name, 'SDK registration fixture');
  assert.equal(registered.scope, 'display:read content:write');
  assert.equal(registered.logo_uri, undefined);
  assert.equal(registered.client_uri, undefined);
  assert.equal(registered.client_secret, undefined);
  assert.deepEqual((await setup.store.get('client:' + registered.client_id)).scopes, ['display:read', 'content:write']);
  assert.deepEqual(fetches, []);
});

test('DCR rejects confidential grants and unsafe redirects', async () => {
  const addresses = ['http://assistant.example.com/callback', 'https://user:secret@assistant.example.com/callback', 'https://assistant.example.com/callback#', 'https://assistant.example.com/*', 'https://assistant.example.com/%2A', 'https://assistant.example.com/callback?code=old', 'https://assistant.example.com/callback?state=old', 'https://assistant.example.com/callback?iss=old', 'javascript:alert(1)', 'https://assistant.example.com\\@evil.example.com/', 'https://assistant.example.com/call back'];
  for (const uri of addresses) {
    const setup = await fixture();
    assert.equal((await setup.call('/oauth/register', { redirect_uris: [uri] })).status, 400, uri);
  }
  for (const changes of [{ token_endpoint_auth_method: 'client_secret_post' }, { grant_types: ['client_credentials'] }, { response_types: ['token'] }, { scope: 'admin:write' }, { redirect_uris: [] }, { client_name: '<img>' }, { redirect_uris: ['https://a.example/cb', 'https://a.example/cb'] }]) {
    const setup = await fixture();
    assert.equal((await setup.call('/oauth/register', { redirect_uris: ['https://assistant.example.com/callback'], ...changes })).status, 400, JSON.stringify(changes));
  }
});

test('HTTP loopback redirects require the test-only setting and exact allowed hosts', async () => {
  const setup = await fixture();
  assert.equal((await setup.call('/oauth/register', { redirect_uris: ['http://localhost:4400/callback'] })).status, 400);
  setup.context.env.ALLOW_LOOPBACK_CLIENTS = '1';
  for (const uri of ['http://localhost:4400/callback', 'http://127.0.0.1:4400/callback']) await setup.register({ value: { redirect_uris: [uri] } });
  for (const uri of ['http://127.1:4400/callback', 'http://2130706433/callback', 'http://localhost.evil.example/callback', 'http://localhost./callback', 'http://[::1]/callback']) {
    const isolated = await fixture(); isolated.context.env.ALLOW_LOOPBACK_CLIENTS = '1';
    assert.equal((await isolated.call('/oauth/register', { redirect_uris: [uri] })).status, 400, uri);
  }
});

test('anonymous OAuth intent survives sign-in only through its HttpOnly transaction cookie', async () => {
  const setup = await fixture();
  const flow = await setup.start();
  assert.match(flow.response.response.headers.get('set-cookie'), /__Host-displayos-connect=.*Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600/);
  assert.equal(new URL(flow.response.response.headers.get('location')).pathname, '/home');
  assert.equal((await setup.call('/api/v1/connections/pending', undefined, { cookie: flow.cookie })).status, 401);
  const pending = await setup.call('/api/v1/connections/pending', undefined, { owner: 'A', cookie: flow.cookie });
  assert.equal(pending.value.intents.length, 1);
  assert.equal(pending.value.intents[0].intentId, flow.intentId);
  assert.equal(pending.value.intents[0].clientIdentityVerified, false);
  assert.equal(pending.value.intents[0].redirectOrigin, 'https://assistant.example.com');
  assert.deepEqual((await setup.call('/api/v1/connections/pending', undefined, { owner: 'A' })).value.intents, []);
  assert.equal((await setup.approve(flow, { cookie: '' })).status, 403);
  assert.equal((await setup.approve(flow, { cookie: '__Host-displayos-connect=' + random() })).status, 403);
  const approved = await setup.approve(flow);
  assert.equal(approved.status, 200);
  const redirect = new URL(approved.value.redirectUrl);
  assert.equal(redirect.origin, 'https://assistant.example.com');
  assert.equal(redirect.searchParams.get('state'), flow.params.state);
  assert.equal(redirect.searchParams.get('iss'), setup.origin);
  assert.equal(redirect.searchParams.has('access_token'), false);
});

test('bound intents cannot cross account or session even with a copied handle and cookie', async () => {
  const setup = await fixture();
  const flow = await setup.start();
  assert.equal((await setup.call('/api/v1/connections/pending', undefined, { owner: 'A', cookie: flow.cookie })).value.intents.length, 1);
  for (const options of [{ owner: 'B' }, { owner: 'A', session: 'second' }]) {
    assert.deepEqual((await setup.call('/api/v1/connections/pending', undefined, { cookie: flow.cookie, ...options })).value.intents, []);
    assert.equal((await setup.approve(flow, options)).status, 403);
  }
  const signed = await setup.start({ owner: 'A' });
  assert.equal((await setup.approve(signed, { owner: 'B' })).status, 403);
});

test('consent requires exact Origin and browser CSRF with no scope or home escalation', async () => {
  const setup = await fixture();
  const flow = await setup.start({ scopes: ['display:read'] });
  assert.equal((await setup.approve(flow, { csrf: 'wrong' })).status, 403);
  assert.equal((await setup.approve(flow, { origin: 'https://evil.example.com' })).status, 403);
  assert.equal((await setup.approve(flow, { value: { scopes: ['display:read', 'settings:write'] } })).value.error, 'invalid_scope');
  assert.equal((await setup.approve(flow, { value: { duration: 2592001 } })).status, 400);
  assert.equal((await setup.approve(flow, { value: { deviceIds: [setup.deviceId, setup.deviceId] } })).status, 400);
  assert.equal((await setup.approve(flow, { value: { arbitrary: true } })).status, 400);
  const foreign = await setup.start();
  assert.equal((await setup.approve(foreign, { value: { homeId: setup.otherHomeId, deviceIds: [setup.otherDeviceId] } })).status, 403);
  const wrongScreen = await setup.start();
  assert.equal((await setup.approve(wrongScreen, { value: { deviceIds: [setup.otherDeviceId] } })).status, 400);
  assert.equal(setup.homes.get(setup.homeId).grants.size, 0);
});

test('authorization validation has no open redirect, optional metadata fetch or duplicate parameters', async () => {
  const setup = await fixture();
  const flow = await setup.start();
  const cases = [{ response_type: 'token' }, { redirect_uri: 'https://evil.example.com/callback' }, { redirect_uri: flow.params.redirect_uri + '/' }, { resource: 'https://evil.example.com/mcp' }, { code_challenge_method: 'plain' }, { code_challenge: 'bad' }, { state: '' }, { scope: 'account:delete' }, { client_id: 'https://169.254.169.254/client.json' }];
  for (const changes of cases) {
    const response = await setup.call('/oauth/authorize?' + new URLSearchParams({ ...flow.params, ...changes }), undefined, { ip: '203.0.113.4' });
    assert.equal(response.status, 400, JSON.stringify(changes));
    assert.equal(response.response.headers.has('location'), false);
  }
  const duplicate = await setup.call('/oauth/authorize?' + new URLSearchParams(flow.params) + '&resource=' + encodeURIComponent(setup.origin + '/mcp'));
  assert.equal(duplicate.status, 400);
  const limited = await setup.register({ value: { scope: 'display:read' } });
  const response = await setup.call('/oauth/authorize?' + new URLSearchParams({ ...flow.params, client_id: limited.client_id, scope: 'content:write' }));
  assert.equal(response.value.error, 'invalid_scope');
});

test('host authorization ignores ChatGPT ui_locales and untrusted authority extensions without storing or fetching them', async testcase => {
  const setup = await fixture();
  const fetches = [];
  testcase.mock.method(globalThis, 'fetch', async (...args) => { fetches.push(args); throw new Error('Unexpected authorization extension lookup'); });
  const extensions = {
    ui_locales: 'en-US', prompt: 'none', account_id: setup.otherAccountId, home_id: setup.otherHomeId,
    device_ids: setup.otherDeviceId, scopes: 'media:write', approved: 'true', system: 'true', principal: 'private-authority-marker',
    grant_id: 'private-authority-marker', redirectUrl: 'https://evil.example.com/private-authority-marker',
    request_uri: 'http://169.254.169.254/private-authority-marker', authorization_details: 'private-authority-marker',
    constructor: 'private-authority-marker', prototype: 'private-authority-marker', ['__proto__']: 'private-authority-marker'
  };
  const flow = await setup.start({ scopes: ['display:read'], params: extensions });
  const intent = await setup.store.get('authorization:' + flow.intentId);
  assert.deepEqual(Object.keys(intent).sort(), ['id', 'clientId', 'label', 'redirectUri', 'state', 'challenge', 'resource', 'scopes', 'browserHash', 'status', 'createdAt', 'expiresAt'].sort());
  assert.deepEqual(intent.scopes, ['display:read']);
  assert.equal(intent.resource, setup.origin + '/mcp');
  assert.equal(intent.redirectUri, flow.registered.redirect_uris[0]);
  assert.equal(intent.state, flow.params.state);
  for (const field of Object.keys(extensions)) if (field !== 'scopes') assert.equal(Object.hasOwn(intent, field), false, field);
  assert.equal(intent.accountId, undefined);
  assert.equal(JSON.stringify([...setup.store.data.entries()]).includes('private-authority-marker'), false);
  assert.equal(flow.response.response.headers.get('location').includes('private-authority-marker'), false);
  assert.equal(setup.calls.length, 0);
  assert.equal(setup.homes.get(setup.homeId).grants.size, 0);
  assert.equal(fetches.length, 0);
});

test('host authorization rejects duplicates of every authority field and ignored extension before mutation', async () => {
  const setup = await fixture();
  const flow = await setup.start();
  const writes = setup.store.writes;
  for (const field of [...Object.keys(flow.params), 'ui_locales', 'account_id', '__proto__']) {
    const query = new URLSearchParams(flow.params);
    if (!query.has(field)) query.append(field, 'synthetic-first');
    query.append(field, query.get(field));
    const result = await setup.call('/oauth/authorize?' + query);
    assert.equal(result.status, 400, field);
    assert.equal(result.value.error, 'invalid_request');
    assert.equal(result.response.headers.get('location'), null);
  }
  assert.equal(setup.store.writes, writes);
});

test('host authorization accepts exactly 8192 encoded query bytes but denies larger extension queries', async () => {
  const setup = await fixture();
  const flow = await setup.start();
  const query = new URLSearchParams({ ...flow.params, extension: '' });
  const padding = 8192 - Buffer.byteLength('?' + query.toString(), 'utf8');
  query.set('extension', 'x'.repeat(padding));
  assert.equal(Buffer.byteLength('?' + query.toString(), 'utf8'), 8192);
  const accepted = await setup.call('/oauth/authorize?' + query);
  assert.equal(accepted.status, 302);
  const writes = setup.store.writes;
  for (const value of ['x'.repeat(padding + 1), '\u00e9'.repeat(1500)]) {
    query.set('extension', value);
    assert.ok(Buffer.byteLength('?' + query.toString(), 'utf8') > 8192);
    const result = await setup.call('/oauth/authorize?' + query);
    assert.equal(result.status, 400);
    assert.equal(result.response.headers.get('location'), null);
  }
  assert.equal(setup.store.writes, writes);
});

test('host Muse seven-field authorization and omitted token resources stay bound to explicit owner consent and one MCP target', async () => {
  const setup = await fixture();
  const flow = await setup.start({ omitResource: true, scopes: ['display:read'] });
  assert.equal(Object.keys(flow.params).length, 7);
  assert.equal((await setup.store.get('authorization:' + flow.intentId)).resource, setup.origin + '/mcp');
  assert.equal(setup.homes.get(setup.homeId).grants.size, 0);
  assert.equal((await setup.call('/api/v1/connections/approve', { intentId: flow.intentId, homeId: setup.homeId, deviceIds: [setup.deviceId], scopes: ['display:read'] }, { cookie: flow.cookie })).status, 401);
  const approval = await setup.approve(flow);
  assert.equal(approval.status, 200);
  const callback = new URL(approval.value.redirectUrl);
  assert.equal(callback.origin, new URL(flow.registered.redirect_uris[0]).origin);
  assert.equal(callback.searchParams.get('state'), flow.params.state);
  const form = { grant_type: 'authorization_code', code: callback.searchParams.get('code'), code_verifier: flow.verifier, client_id: flow.registered.client_id, redirect_uri: flow.params.redirect_uri };
  const exchanged = await setup.call('/oauth/token', form, { form: true });
  assert.equal(exchanged.status, 200);
  const refresh = { grant_type: 'refresh_token', refresh_token: exchanged.value.refresh_token, client_id: flow.registered.client_id };
  const renewed = await setup.call('/oauth/token', refresh, { form: true });
  assert.equal(renewed.status, 200);
  for (const result of [exchanged, renewed]) {
    assert.equal(result.value.resource, setup.origin + '/mcp');
    assert.equal(result.value.scope, 'display:read');
    const access = await setup.store.get('access:' + await digest(result.value.access_token));
    assert.equal(access.resource, setup.origin + '/mcp');
    assert.equal(access.issuer, setup.origin);
    const principal = await authenticateAgent(setup.request('/mcp', undefined, { token: result.value.access_token }), setup.context);
    assert.equal(principal.accountId, setup.accountId);
    assert.equal(principal.homeId, setup.homeId);
    assert.deepEqual(principal.deviceIds, [setup.deviceId]);
    assert.deepEqual(principal.scopes, ['display:read']);
  }
  assert.equal((await setup.rpc(renewed.value.access_token, 'tools/call', { name: 'family_publish', arguments: {} })).status, 403);
  assert.equal(setup.homes.get(setup.otherHomeId).grants.size, 0);
});

test('host authorization-code exchange defaults omitted resource without bypassing PKCE', async () => {
  const setup = await fixture();
  const flow = await setup.start();
  const approval = await setup.approve(flow);
  assert.equal(approval.status, 200);
  const code = new URL(approval.value.redirectUrl).searchParams.get('code');
  const form = { grant_type: 'authorization_code', code, code_verifier: flow.verifier, client_id: flow.registered.client_id, redirect_uri: flow.params.redirect_uri };
  const wrong = await setup.call('/oauth/token', { ...form, code_verifier: random() }, { form: true });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.value.error, 'invalid_grant');
  assert.equal((await setup.store.get('code:' + await digest(code))).used, false);
  const result = await setup.call('/oauth/token', form, { form: true });
  assert.equal(result.status, 200);
  assert.equal(result.value.resource, setup.origin + '/mcp');
});

test('host refresh exchange defaults omitted resource without expanding approved scopes', async () => {
  const setup = await fixture();
  const flow = await setup.granted({ scopes: ['display:read'] });
  const form = setup.refreshForm(flow);
  delete form.resource;
  assert.equal((await setup.call('/oauth/token', { ...form, scope: 'display:read content:write' }, { form: true })).value.error, 'invalid_scope');
  const result = await setup.call('/oauth/token', form, { form: true });
  assert.equal(result.status, 200);
  assert.equal(result.value.resource, setup.origin + '/mcp');
  assert.equal(result.value.scope, 'display:read');
  assert.notEqual(result.value.refresh_token, flow.tokens.refresh_token);
});

test('host compatibility still rejects explicit empty foreign and duplicate resource targets', async () => {
  const setup = await fixture();
  const flow = await setup.granted();
  for (const resource of ['', 'https://evil.example.com/mcp', setup.origin + '/mcp/']) {
    const authorization = await setup.call('/oauth/authorize?' + new URLSearchParams({ ...flow.params, resource }));
    assert.equal(authorization.status, 400);
    assert.equal(authorization.value.error, 'invalid_target');
    assert.equal(authorization.response.headers.get('location'), null);
    for (const form of [flow.form, setup.refreshForm(flow)]) {
      const result = await setup.call('/oauth/token', { ...form, resource }, { form: true });
      assert.equal(result.status, 400);
      assert.equal(result.value.error, 'invalid_target');
    }
  }
  for (const form of [flow.form, setup.refreshForm(flow)]) {
    const duplicate = new URLSearchParams(form);
    duplicate.append('resource', setup.origin + '/mcp');
    const result = await setup.call('/oauth/token', form, { form: true, raw: duplicate.toString() });
    assert.equal(result.status, 400);
    assert.equal(result.value.error, 'invalid_request');
  }
  assert.equal((await setup.rpc(flow.tokens.access_token, 'tools/list')).status, 200);
});

test('host compatibility leaves unknown token-form extensions rejected without consuming credentials', async () => {
  const setup = await fixture();
  const flow = await setup.granted();
  const writes = setup.store.writes;
  for (const form of [flow.form, setup.refreshForm(flow)]) {
    for (const extension of [{ ui_locales: 'en-US' }, { account_id: setup.otherAccountId }]) {
      const result = await setup.call('/oauth/token', { ...form, ...extension }, { form: true });
      assert.equal(result.status, 400);
      assert.equal(result.value.error, 'invalid_request');
    }
  }
  assert.equal(setup.store.writes, writes);
  assert.equal((await setup.rpc(flow.tokens.access_token, 'tools/list')).status, 200);
});

test('expired anonymous intents and missing exact consent scopes fail closed', async () => {
  const setup = await fixture();
  const flow = await setup.start();
  assert.equal((await setup.approve(flow, { value: { scopes: [] } })).status, 400);
  const omitted = await setup.call('/api/v1/connections/approve', { intentId: flow.intentId, homeId: setup.homeId, deviceIds: [setup.deviceId] }, { owner: 'A', cookie: flow.cookie });
  assert.equal(omitted.status, 400);
  setup.advance(600001);
  assert.equal((await setup.approve(flow)).status, 403);
  assert.equal(await setup.store.get('authorization:' + flow.intentId), undefined);
});

test('approval journals survive lost writes and replay the same grant and redirect', async () => {
  const setup = await fixture();
  const flow = await setup.start();
  setup.store.fail = key => key.startsWith('code:');
  const failed = await setup.approve(flow);
  assert.equal(failed.status, 503);
  const journal = await setup.store.get('authorization:' + flow.intentId);
  assert.equal(journal.status, 'approving');
  assert.ok(journal.code);
  assert.equal(setup.homes.get(setup.homeId).grants.size, 1);
  assert.equal((await setup.approve(flow, { value: { deviceIds: [setup.secondDeviceId] } })).status, 409);
  assert.equal((await setup.approve(flow, { value: { duration: 7200 } })).status, 409);
  const recovered = await setup.approve(flow);
  assert.equal(recovered.status, 200);
  assert.equal(new URL(recovered.value.redirectUrl).searchParams.get('code'), journal.code);
  const completed = await setup.store.get('authorization:' + flow.intentId);
  assert.equal(completed.status, 'approved');
  assert.equal(completed.code, undefined);
  const retry = await setup.approve(flow);
  assert.equal(retry.value.redirectUrl, recovered.value.redirectUrl);
  assert.equal(setup.homes.get(setup.homeId).grants.size, 1);
  assert.equal(setup.calls.filter(value => value.command === 'grant.create').length, 2);
});

test('approval journals survive lost household replies without duplicating consent', async () => {
  const setup = await fixture();
  const flow = await setup.start({ scopes: ['display:read', 'content:write', 'settings:write'] });
  const original = setup.context.homeCall;
  let lost = true;
  setup.context.homeCall = async (...args) => {
    const result = await original(...args);
    if (args[2] === 'grant.create' && lost) { lost = false; throw new Error('Lost household response'); }
    return result;
  };
  assert.equal((await setup.approve(flow)).status, 503);
  assert.equal((await setup.approve(flow, { value: { scopes: ['display:read'] } })).status, 409);
  assert.equal((await setup.approve(flow, { value: { homeId: setup.otherHomeId } })).status, 409);
  const response = await setup.approve(flow);
  assert.equal(response.status, 200);
  assert.equal(setup.homes.get(setup.homeId).grants.size, 1);
});

test('normalized consent retry does not change permissions or create another grant', async () => {
  const setup = await fixture();
  const flow = await setup.start({ scopes: ['display:read', 'content:write'] });
  const first = await setup.approve(flow, { value: { deviceIds: [setup.deviceId, setup.secondDeviceId] } });
  const retry = await setup.approve(flow, { value: { deviceIds: [setup.secondDeviceId, setup.deviceId], scopes: ['content:write', 'display:read'] } });
  assert.equal(retry.status, 200);
  assert.equal(first.value.redirectUrl, retry.value.redirectUrl);
  assert.equal(setup.homes.get(setup.homeId).grants.size, 1);
});

test('valid PKCE exchange issues bounded resource-bound tokens stored only by hash', async () => {
  const setup = await fixture();
  const flow = await setup.granted();
  assert.equal(flow.tokens.token_type, 'Bearer');
  assert.equal(flow.tokens.expires_in, 900);
  assert.equal(flow.tokens.resource, setup.origin + '/mcp');
  const access = await setup.store.get('access:' + await digest(flow.tokens.access_token));
  assert.equal(access.accountAuthVersion, 1);
  assert.equal(access.issuer, setup.origin);
  const records = JSON.stringify([...setup.store.data.entries()]);
  assert.equal(records.includes(flow.tokens.access_token), false);
  assert.equal(records.includes(flow.tokens.refresh_token), false);
  const principal = await authenticateAgent(setup.request('/mcp', undefined, { token: flow.tokens.access_token }), setup.context);
  assert.deepEqual(principal, { accountId: setup.accountId, homeId: setup.homeId, deviceIds: [setup.deviceId], scopes: ['content:write', 'display:read'], grantId: flow.grant.id, clientId: flow.registered.client_id });
});

test('wrong PKCE, redirect, client or resource cannot consume the authorization code', async () => {
  const setup = await fixture();
  const flow = await setup.start();
  const approved = await setup.approve(flow);
  const code = new URL(approved.value.redirectUrl).searchParams.get('code');
  const other = await setup.register();
  const form = { grant_type: 'authorization_code', client_id: flow.registered.client_id, code, code_verifier: flow.verifier, redirect_uri: flow.params.redirect_uri, resource: setup.origin + '/mcp' };
  for (const changes of [{ code_verifier: random() }, { code_verifier: 'a'.repeat(42) }, { code_verifier: 'a'.repeat(129) }, { redirect_uri: form.redirect_uri + '/' }, { client_id: other.client_id }, { resource: setup.origin + '/other' }]) {
    const response = await setup.call('/oauth/token', { ...form, ...changes }, { form: true });
    assert.equal(response.status, 400, JSON.stringify(changes));
  }
  assert.equal((await setup.store.get('code:' + await digest(code))).used, false);
  assert.equal((await setup.call('/oauth/token', form, { form: true })).status, 200);
});

test('replayed authorization code revokes its token family, not another connection', async () => {
  const setup = await fixture();
  const flow = await setup.granted();
  const unaffected = await setup.granted();
  assert.equal((await setup.call('/oauth/token', flow.form, { form: true })).value.error, 'invalid_grant');
  assert.equal((await setup.rpc(flow.tokens.access_token, 'tools/list')).status, 401);
  assert.equal((await setup.call('/oauth/token', setup.refreshForm(flow), { form: true })).value.error, 'invalid_grant');
  assert.equal((await setup.rpc(unaffected.tokens.access_token, 'tools/list')).status, 200);
});

test('refresh tokens rotate and reuse revokes the entire family including newer access', async () => {
  const setup = await fixture();
  const flow = await setup.granted();
  const rotated = await setup.call('/oauth/token', setup.refreshForm(flow), { form: true });
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.value.access_token, flow.tokens.access_token);
  assert.notEqual(rotated.value.refresh_token, flow.tokens.refresh_token);
  assert.equal((await setup.rpc(rotated.value.access_token, 'tools/list')).status, 200);
  const reused = await setup.call('/oauth/token', setup.refreshForm(flow), { form: true });
  assert.equal(reused.value.error, 'invalid_grant');
  assert.equal((await setup.rpc(rotated.value.access_token, 'tools/list')).status, 401);
  assert.equal((await setup.rpc(flow.tokens.access_token, 'tools/list')).status, 401);
  assert.equal((await setup.call('/oauth/token', setup.refreshForm(flow, rotated.value.refresh_token), { form: true })).value.error, 'invalid_grant');
});

test('refresh cannot cross client/resource or expand approved scopes', async () => {
  const setup = await fixture();
  const flow = await setup.granted();
  const other = await setup.register();
  for (const changes of [{ client_id: other.client_id }, { resource: 'https://other.example/mcp' }, { scope: 'display:read settings:write' }, { scope: 'display:read display:read' }]) {
    assert.equal((await setup.call('/oauth/token', { ...setup.refreshForm(flow), ...changes }, { form: true })).status, 400);
  }
  const narrow = await setup.call('/oauth/token', { ...setup.refreshForm(flow), scope: 'display:read' }, { form: true });
  assert.equal(narrow.status, 200);
  assert.equal(narrow.value.scope, 'display:read');
  const tools = await setup.rpc(narrow.value.access_token, 'tools/list');
  assert.deepEqual(tools.value.result.tools.map(tool => tool.name), ['screen_list', 'screen_capabilities', 'family_read', 'media_list', 'revision_status', 'voice_list', 'voice_get']);
  assert.equal((await setup.call('/oauth/token', { ...setup.refreshForm(flow, narrow.value.refresh_token), scope: 'content:write' }, { form: true })).value.error, 'invalid_scope');
});

test('read-only and no-refresh client approvals never mint unapproved tokens', async () => {
  const setup = await fixture();
  const registered = await setup.register({ value: { grant_types: ['authorization_code'], scope: 'display:read' } });
  const flow = await setup.granted({ registered, scopes: ['display:read'] });
  assert.equal(flow.tokens.refresh_token, undefined);
  assert.equal((await setup.call('/oauth/token', setup.refreshForm(flow, random()), { form: true })).value.error, 'unauthorized_client');
  const denied = await setup.rpc(flow.tokens.access_token, 'tools/call', { name: 'family_publish', arguments: {} });
  assert.equal(denied.status, 403);
  assert.match(denied.response.headers.get('www-authenticate'), /insufficient_scope.*content:write/);
});

test('expired codes/access/refresh and revoked current household grants are denied', async () => {
  const setup = await fixture();
  const unexchanged = await setup.start();
  const approval = await setup.approve(unexchanged);
  const flow = await setup.granted();
  setup.advance(120001);
  const expired = await setup.call('/oauth/token', { grant_type: 'authorization_code', client_id: unexchanged.registered.client_id, code: new URL(approval.value.redirectUrl).searchParams.get('code'), code_verifier: unexchanged.verifier, redirect_uri: unexchanged.params.redirect_uri, resource: setup.origin + '/mcp' }, { form: true });
  assert.equal(expired.value.error, 'invalid_grant');
  setup.advance(780001);
  assert.equal((await setup.rpc(flow.tokens.access_token, 'tools/list')).status, 401);
  assert.equal((await setup.call('/oauth/token', setup.refreshForm(flow), { form: true })).status, 200);
  flow.grant.revokedAt = setup.context.now();
  assert.equal((await setup.call('/oauth/token', setup.refreshForm(flow), { form: true })).value.error, 'invalid_grant');
  setup.advance(3600001);
  assert.equal((await setup.call('/oauth/token', setup.refreshForm(flow), { form: true })).value.error, 'invalid_grant');
  await setup.call('/api/v1/connections/pending', undefined, { owner: 'A' });
  assert.equal((await setup.store.list('refresh:')).size, 0);
});

async function saturatePublic(setup) {
  const budgets = new RateBudgets({ now: setup.context.now, capacity: 16 });
  for (let index = 0; index < 16; index++) await budgets.take('oauth:entry:unproven-' + index, 1, 60000);
  setup.context.rate = (bucket, limit, window) => budgets.take(bucket, limit, window);
  return budgets;
}

test('owner pending, approval and revocation bypass saturated public admission only after proof', async () => {
  const setup = await fixture(); const flow = await setup.start();
  const budgets = await saturatePublic(setup);
  assert.equal((await setup.call('/api/v1/connections/pending')).status, 429);
  assert.equal((await setup.approve(flow, { csrf: 'bad' })).status, 429);
  assert.equal(budgets.groups.has('family'), false);
  assert.equal((await setup.call('/api/v1/connections/pending', undefined, { owner: 'A', cookie: flow.cookie })).status, 200);
  assert.equal((await setup.approve(flow)).status, 200);
  const grant = [...setup.homes.get(setup.homeId).grants.values()][0];
  assert.equal((await setup.call('/api/v1/connections/revoke', { homeId: setup.homeId, grantId: grant.id }, { owner: 'A' })).status, 200);
  assert.ok(budgets.groups.get('family').has('oauth:owner:entry:' + setup.accountId));
  assert.equal(budgets.groups.get('public').size, 16);
});

test('MCP reserves only fully verified grants and performs the initial grant check once', async () => {
  const setup = await fixture(); const flow = await setup.granted();
  const budgets = await saturatePublic(setup);
  const lists = setup.store.lists;
  assert.equal((await setup.rpc(random(), 'ping')).status, 429);
  assert.equal(budgets.groups.has('assistants'), false);
  assert.equal(setup.store.lists, lists);
  const checks = setup.calls.filter(value => value.command === 'grant.check').length;
  assert.equal((await setup.rpc(flow.tokens.access_token, 'ping')).status, 200);
  assert.equal(setup.calls.filter(value => value.command === 'grant.check').length - checks, 1);
  assert.ok(budgets.groups.get('assistants').has('oauth:mcp-grant:' + flow.grant.id));
  flow.grant.revokedAt = setup.context.now();
  const before = budgets.groups.get('assistants').get('oauth:mcp-grant:' + flow.grant.id).count;
  assert.equal((await setup.rpc(flow.tokens.access_token, 'ping')).status, 429);
  assert.equal(budgets.groups.get('assistants').get('oauth:mcp-grant:' + flow.grant.id).count, before);
});

test('PKCE-proven codes and current refresh grants survive public saturation without trusting client_id', async () => {
  const setup = await fixture(); const flow = await setup.start(); const approval = await setup.approve(flow);
  const code = new URL(approval.value.redirectUrl).searchParams.get('code');
  const form = { grant_type: 'authorization_code', client_id: flow.registered.client_id, code, code_verifier: flow.verifier, redirect_uri: flow.params.redirect_uri, resource: setup.origin + '/mcp' };
  const budgets = await saturatePublic(setup);
  assert.equal((await setup.call('/oauth/token', { ...form, code_verifier: random() }, { form: true })).status, 429);
  assert.equal(budgets.groups.has('assistants'), false);
  assert.equal((await setup.store.get('code:' + await digest(code))).used, false);
  const exchanged = await setup.call('/oauth/token', form, { form: true });
  assert.equal(exchanged.status, 200);
  const refresh = { grant_type: 'refresh_token', client_id: form.client_id, refresh_token: exchanged.value.refresh_token, resource: setup.origin + '/mcp' };
  assert.equal((await setup.call('/oauth/token', { ...refresh, refresh_token: random() }, { form: true })).status, 429);
  const rotated = await setup.call('/oauth/token', refresh, { form: true });
  assert.equal(rotated.status, 200);
  assert.notEqual(rotated.value.refresh_token, refresh.refresh_token);
  const grant = [...setup.homes.get(setup.homeId).grants.values()][0];
  assert.equal(budgets.groups.get('assistants').get('oauth:mcp-grant:' + grant.id + ':token').count, 2);
  assert.equal(budgets.groups.get('public').size, 16);
});

test('Not now cancels only a cookie/session-bound pending intent and releases its active slot', async () => {
  const setup = await fixture(); const first = await setup.start();
  for (let index = 1; index < 8; index++) await setup.start({ registered: first.registered, cookie: first.cookie });
  await setup.call('/api/v1/connections/pending', undefined, { owner: 'A', cookie: first.cookie });
  const denied = await setup.call('/api/v1/connections/deny', { intentId: first.intentId }, { owner: 'A', cookie: first.cookie });
  assert.equal(denied.status, 200);
  assert.equal(denied.value.cancelled, true);
  const redirect = new URL(denied.value.redirectUrl);
  assert.equal(redirect.origin + redirect.pathname, first.params.redirect_uri);
  assert.deepEqual(Object.fromEntries(redirect.searchParams), { error: 'access_denied', state: first.params.state, iss: setup.origin });
  const receipt = await setup.store.get('authorization:' + first.intentId);
  assert.equal(receipt.status, 'denied');
  assert.equal(receipt.challenge, undefined);
  assert.equal(receipt.scopes, undefined);
  assert.equal((await setup.call('/api/v1/connections/pending', undefined, { owner: 'A', cookie: first.cookie })).value.intents.length, 7);
  assert.equal((await setup.approve(first)).status, 403);
  assert.deepEqual((await setup.call('/api/v1/connections/deny', { intentId: first.intentId }, { owner: 'A', cookie: first.cookie })).value, denied.value);
  await setup.start({ registered: first.registered, cookie: first.cookie });
  assert.equal((await setup.call('/api/v1/connections/pending', undefined, { owner: 'A', cookie: first.cookie })).value.intents.length, 8);
  assert.equal(setup.homes.get(setup.homeId).grants.size, 0);
  assert.equal((await setup.store.list('code:')).size, 0);
});

test('denial requires Origin, CSRF and transaction possession, cannot cross sessions or stop an approved grant', async () => {
  const setup = await fixture(); const flow = await setup.start();
  await setup.call('/api/v1/connections/pending', undefined, { owner: 'A', cookie: flow.cookie });
  for (const options of [{ csrf: 'bad' }, { origin: 'https://evil.example' }, { cookie: '' }, { cookie: '__Host-displayos-connect=' + random() }, { owner: 'B' }, { session: 'second' }]) {
    assert.equal((await setup.call('/api/v1/connections/deny', { intentId: flow.intentId }, { owner: 'A', cookie: flow.cookie, ...options })).status, 403);
  }
  assert.equal((await setup.call('/api/v1/connections/deny', { intentId: flow.intentId, approved: true }, { owner: 'A', cookie: flow.cookie })).status, 400);
  assert.equal((await setup.approve(flow)).status, 200);
  assert.equal((await setup.call('/api/v1/connections/deny', { intentId: flow.intentId }, { owner: 'A', cookie: flow.cookie })).status, 403);
  assert.equal([...setup.homes.get(setup.homeId).grants.values()][0].revokedAt, undefined);
});

test('denial rolls back on storage failure and authenticated dismissal survives public saturation', async () => {
  const setup = await fixture(); const flow = await setup.start();
  setup.store.fail = (key, value) => key === 'authorization:' + flow.intentId && value.status === 'denied';
  const budgets = await saturatePublic(setup);
  assert.equal((await setup.call('/api/v1/connections/deny', { intentId: flow.intentId }, { owner: 'A', cookie: flow.cookie })).status, 503);
  assert.equal((await setup.store.get('authorization:' + flow.intentId)).status, 'pending');
  assert.equal((await setup.call('/api/v1/connections/deny', { intentId: flow.intentId }, { owner: 'A', cookie: flow.cookie })).status, 200);
  assert.equal((await setup.store.get('authorization:' + flow.intentId)).status, 'denied');
  assert.ok(budgets.groups.get('family').size);
});

test('denial callback preserves the exact stored state and registered query without issuing credentials', async () => {
  const setup = await fixture();
  const registered = await setup.register({ value: { redirect_uris: ['https://assistant.example.com/callback?tenant=family%20one'] } });
  const state = 'opaque&code=not-a-code#state=other + / é';
  const flow = await setup.start({ registered, params: { state } });
  const denied = await setup.call('/api/v1/connections/deny', { intentId: flow.intentId }, { owner: 'A', cookie: flow.cookie });
  assert.equal(denied.status, 200);
  const redirect = new URL(denied.value.redirectUrl);
  assert.equal(redirect.searchParams.get('tenant'), 'family one');
  assert.equal(redirect.searchParams.get('state'), state);
  assert.equal(redirect.searchParams.get('error'), 'access_denied');
  assert.equal(redirect.searchParams.get('iss'), setup.origin);
  assert.equal(redirect.hash, '');
  assert.equal(redirect.searchParams.size, 4);
  assert.equal(denied.response.headers.get('location'), null);
  assert.equal(denied.response.headers.get('cache-control'), 'no-store');
  for (const prefix of ['code:', 'access:', 'refresh:']) assert.equal((await setup.store.list(prefix)).size, 0);
  assert.equal(setup.calls.length, 0);
});

test('denial retry is bound to the original browser/account/session and never extends its expiry', async () => {
  const setup = await fixture(); const flow = await setup.start();
  const expiry = (await setup.store.get('authorization:' + flow.intentId)).expiresAt;
  const denied = await setup.call('/api/v1/connections/deny', { intentId: flow.intentId }, { owner: 'A', cookie: flow.cookie });
  for (const options of [{ csrf: 'bad' }, { origin: 'https://evil.example' }, { cookie: '' }, { cookie: '__Host-displayos-connect=' + random() }, { owner: 'B' }, { session: 'second' }]) {
    const retry = await setup.call('/api/v1/connections/deny', { intentId: flow.intentId }, { owner: 'A', cookie: flow.cookie, ...options });
    assert.equal(retry.status, 403);
    assert.equal(retry.value.redirectUrl, undefined);
  }
  setup.advance(60001);
  assert.deepEqual((await setup.call('/api/v1/connections/deny', { intentId: flow.intentId }, { owner: 'A', cookie: flow.cookie })).value, denied.value);
  assert.equal((await setup.store.get('authorization:' + flow.intentId)).expiresAt, expiry);
  assert.equal((await setup.approve(flow)).status, 403);
  setup.advance(600000);
  const expired = await setup.call('/api/v1/connections/deny', { intentId: flow.intentId }, { owner: 'A', cookie: flow.cookie });
  assert.deepEqual(expired.value, { cancelled: true });
  assert.equal(await setup.store.get('authorization:' + flow.intentId), undefined);
  assert.deepEqual((await setup.call('/api/v1/connections/deny', { intentId: random() }, { owner: 'A', cookie: flow.cookie })).value, { cancelled: true });
});

test('denial accepts no caller callback and revalidates the stored URI against the current registration', async () => {
  for (const uri of ['https://evil.example/cb', 'https://user@assistant.example.com/callback', 'https://assistant.example.com/callback#fragment', 'https://assistant.example.com/*', 'http://localhost/callback']) {
    const setup = await fixture(); const flow = await setup.start();
    const key = 'authorization:' + flow.intentId;
    const intent = await setup.store.get(key);
    await setup.store.put(key, { ...intent, redirectUri: uri });
    const denied = await setup.call('/api/v1/connections/deny', { intentId: flow.intentId }, { owner: 'A', cookie: flow.cookie });
    assert.equal(denied.status, 400);
    assert.equal(denied.value.redirectUrl, undefined);
    assert.equal((await setup.store.get(key)).status, 'pending');
  }
  const setup = await fixture(); const flow = await setup.start();
  for (const key of ['redirectUri', 'redirect_uri', 'redirectUrl', 'state', 'iss']) {
    const response = await setup.call('/api/v1/connections/deny', { intentId: flow.intentId, [key]: 'https://evil.example' }, { owner: 'A', cookie: flow.cookie });
    assert.equal(response.status, 400);
    assert.equal(response.value.redirectUrl, undefined);
  }
  const denied = await setup.call('/api/v1/connections/deny', { intentId: flow.intentId }, { owner: 'A', cookie: flow.cookie });
  assert.ok(denied.value.redirectUrl);
  const registered = await setup.store.get('client:' + flow.registered.client_id);
  await setup.store.put('client:' + registered.id, { ...registered, redirectUris: ['https://other.example/callback'] });
  const retry = await setup.call('/api/v1/connections/deny', { intentId: flow.intentId }, { owner: 'A', cookie: flow.cookie });
  assert.equal(retry.status, 400);
  assert.equal(retry.value.redirectUrl, undefined);
});

test('denial cannot replace an approving journal or an approved callback', async () => {
  const setup = await fixture(); const flow = await setup.start();
  setup.store.fail = key => key.startsWith('code:');
  assert.equal((await setup.approve(flow)).status, 503);
  assert.equal((await setup.store.get('authorization:' + flow.intentId)).status, 'approving');
  const denied = await setup.call('/api/v1/connections/deny', { intentId: flow.intentId }, { owner: 'A', cookie: flow.cookie });
  assert.equal(denied.status, 403);
  assert.equal(denied.value.redirectUrl, undefined);
  const approved = await setup.approve(flow);
  assert.equal(approved.status, 200);
  const denial = await setup.call('/api/v1/connections/deny', { intentId: flow.intentId }, { owner: 'A', cookie: flow.cookie });
  assert.equal(denial.status, 403);
  assert.equal(denial.value.redirectUrl, undefined);
  assert.equal((await setup.store.get('authorization:' + flow.intentId)).redirectUrl, approved.value.redirectUrl);
  assert.equal([...setup.homes.get(setup.homeId).grants.values()][0].revokedAt, undefined);
});

test('every access and refresh rechecks active account and recovery auth version', async () => {
  for (const mutation of [account => { account.status = 'deleting'; }, account => { account.authVersion++; }, account => { account.status = 'deleted'; }]) {
    const setup = await fixture();
    const flow = await setup.granted();
    const account = await setup.store.get('account:' + setup.accountId);
    mutation(account);
    await setup.store.put('account:' + setup.accountId, account);
    assert.equal((await setup.rpc(flow.tokens.access_token, 'tools/list')).status, 401);
    assert.equal((await setup.call('/oauth/token', setup.refreshForm(flow), { form: true })).value.error, 'invalid_grant');
  }
  const setup = await fixture(); const flow = await setup.granted();
  await setup.store.delete('account:' + setup.accountId);
  await assert.rejects(authenticateAgent(setup.request('/mcp', undefined, { token: flow.tokens.access_token }), setup.context), error => error.status === 401);
});

test('current household membership, client and screen assignments fence old access', async () => {
  for (const mutation of [home => { home.owner = random(16); }, (home, flow) => { home.devices = []; }, (home, flow) => { flow.grant.clientId = random(); }, (home, flow) => { flow.grant.deviceIds = []; }, (home, flow) => { flow.grant.scopes = ['display:read']; }]) {
    const setup = await fixture(); const flow = await setup.granted();
    mutation(setup.homes.get(setup.homeId), flow);
    assert.equal((await setup.rpc(flow.tokens.access_token, 'tools/list')).status, 401);
    assert.equal((await setup.call('/oauth/token', setup.refreshForm(flow), { form: true })).status, 400);
  }
});

test('owner revocation checks home authority and stops all tokens of the selected grant', async () => {
  const setup = await fixture(); const flow = await setup.granted();
  const unrelated = await setup.granted();
  assert.equal((await setup.call('/api/v1/connections/revoke', { homeId: setup.homeId, grantId: flow.grant.id }, { owner: 'B' })).status, 403);
  assert.equal((await setup.call('/api/v1/connections/revoke', { homeId: setup.homeId, grantId: flow.grant.id }, { owner: 'A', csrf: 'bad' })).status, 403);
  assert.equal((await setup.call('/api/v1/connections/revoke', { homeId: setup.homeId, grantId: flow.grant.id }, { owner: 'A' })).status, 200);
  assert.equal((await setup.rpc(flow.tokens.access_token, 'tools/list')).status, 401);
  assert.equal((await setup.call('/oauth/token', setup.refreshForm(flow), { form: true })).value.error, 'invalid_grant');
  assert.equal((await setup.rpc(unrelated.tokens.access_token, 'tools/list')).status, 200);
});

test('RFC token revocation is non-disclosing and cannot revoke another client family', async () => {
  const setup = await fixture(); const flow = await setup.granted(); const other = await setup.register();
  assert.equal((await setup.call('/oauth/revoke', { client_id: other.client_id, token: flow.tokens.refresh_token }, { form: true })).status, 200);
  assert.equal((await setup.rpc(flow.tokens.access_token, 'tools/list')).status, 200);
  assert.equal((await setup.call('/oauth/revoke', { client_id: flow.registered.client_id, token: random() }, { form: true })).status, 200);
  assert.equal((await setup.call('/oauth/revoke', { client_id: flow.registered.client_id, token: flow.tokens.access_token, token_type_hint: 'access_token' }, { form: true })).status, 200);
  assert.equal((await setup.rpc(flow.tokens.access_token, 'tools/list')).status, 401);
});

test('token persistence failure does not consume the code or report false success', async () => {
  const setup = await fixture(); const flow = await setup.start(); const approved = await setup.approve(flow);
  const code = new URL(approved.value.redirectUrl).searchParams.get('code');
  const form = { grant_type: 'authorization_code', client_id: flow.registered.client_id, code, code_verifier: flow.verifier, redirect_uri: flow.params.redirect_uri, resource: setup.origin + '/mcp' };
  setup.store.fail = key => key.startsWith('access:');
  assert.equal((await setup.call('/oauth/token', form, { form: true })).status, 503);
  assert.equal((await setup.store.get('code:' + await digest(code))).used, false);
  assert.equal((await setup.store.list('refresh:')).size, 0);
  assert.equal((await setup.call('/oauth/token', form, { form: true })).status, 200);
});

test('refresh storage failure preserves the old refresh token for a safe retry', async () => {
  const setup = await fixture(); const flow = await setup.granted();
  setup.store.fail = key => key.startsWith('refresh:token:');
  assert.equal((await setup.call('/oauth/token', setup.refreshForm(flow), { form: true })).status, 503);
  assert.equal((await setup.store.get('refresh:token:' + await digest(flow.tokens.refresh_token))).used, false);
  assert.equal((await setup.call('/oauth/token', setup.refreshForm(flow), { form: true })).status, 200);
});

test('registration capacity, per-IP admission and per-browser intent counts are bounded', async () => {
  const setup = await fixture();
  for (let index = 0; index < 128; index++) await setup.store.put('client:' + random(), { expiresAt: setup.context.now() + 60000 });
  assert.equal((await setup.call('/oauth/register', { redirect_uris: ['https://assistant.example.com/cb'] })).status, 429);
  setup.advance(60001);
  await setup.register();
  const limited = await fixture();
  for (let index = 0; index < 5; index++) await limited.register({ ip: '203.0.113.42' });
  assert.equal((await limited.call('/oauth/register', { redirect_uris: ['https://assistant.example.com/cb'] }, { ip: '203.0.113.42' })).status, 429);
  const bounded = await fixture(); const first = await bounded.start();
  for (let index = 1; index < 8; index++) await bounded.start({ registered: first.registered, cookie: first.cookie });
  const denied = await bounded.call('/oauth/authorize?' + new URLSearchParams(first.params), undefined, { cookie: first.cookie });
  assert.equal(denied.status, 429);
  assert.equal((await bounded.store.list('authorization:')).size, 8);
});

test('read-only polls avoid storage writes and pruning scans are rate-gated and periodic', async () => {
  const setup = await fixture(); const flow = await setup.start();
  await setup.call('/api/v1/connections/pending', undefined, { owner: 'A', cookie: flow.cookie });
  const writes = setup.store.writes;
  const lists = setup.store.lists;
  for (let index = 0; index < 5; index++) await setup.call('/api/v1/connections/pending', undefined, { owner: 'A', cookie: flow.cookie });
  assert.equal(setup.store.writes, writes);
  assert.equal(setup.store.lists - lists, 5);
  const admissionBucket = 'oauth:entry:' + await digest('192.0.2.1');
  setup.budgets.set(admissionBucket, { count: 360, until: setup.context.now() + 60000 });
  setup.advance(60001);
  setup.budgets.set(admissionBucket, { count: 360, until: setup.context.now() + 60000 });
  const before = setup.store.lists;
  assert.equal((await setup.call('/.well-known/oauth-authorization-server')).status, 429);
  assert.equal(setup.store.lists, before);
});

test('MCP supports explicit versions, initialization, notification, ping and stateless methods', async () => {
  const setup = await fixture(); const flow = await setup.granted();
  for (const version of ['2025-11-25', '2025-06-18', '2025-03-26']) {
    const initialized = await setup.rpc(flow.tokens.access_token, 'initialize', { protocolVersion: version, clientInfo: { name: 'Synthetic client', version: '1' }, capabilities: {} }, { headers: { 'MCP-Protocol-Version': version } });
    assert.equal(initialized.value.result.protocolVersion, version);
    assert.equal(initialized.value.result.serverInfo.name, 'DisplayOS');
  }
  const negotiated = await setup.rpc(flow.tokens.access_token, 'initialize', { protocolVersion: '2026-07-28', clientInfo: { name: 'Synthetic client', version: '1' }, capabilities: {} });
  assert.equal(negotiated.value.result.protocolVersion, '2025-11-25');
  assert.equal((await setup.rpc(flow.tokens.access_token, 'ping')).status, 200);
  const notification = await setup.rpc(flow.tokens.access_token, 'notifications/initialized', {}, { message: { id: undefined } });
  assert.equal(notification.status, 202);
  assert.equal(notification.value, null);
  const cancelled = await setup.rpc(flow.tokens.access_token, 'notifications/cancelled', { requestId: 1 }, { message: { id: undefined } });
  assert.equal(cancelled.status, 202);
  for (const method of ['GET', 'DELETE']) {
    const result = await setup.call('/mcp', undefined, { token: flow.tokens.access_token, method });
    assert.equal(result.status, 405);
    assert.equal(result.response.headers.get('allow'), 'POST');
  }
});

test('MCP rejects invalid framing, batching, methods, unknown keys and unsupported headers', async () => {
  const setup = await fixture(); const flow = await setup.granted();
  assert.equal((await setup.rpc(flow.tokens.access_token, 'ping', {}, { headers: { 'MCP-Protocol-Version': '2026-07-28' } })).status, 400);
  assert.equal((await setup.call('/mcp', { jsonrpc: '2.0', id: 1, method: 'ping' }, { token: flow.tokens.access_token, headers: { Accept: 'application/json' } })).status, 406);
  for (const raw of ['{', '[{"jsonrpc":"2.0","id":1,"method":"ping"}]', '{"jsonrpc":"1.0","id":1,"method":"ping"}', '{"jsonrpc":"2.0","id":null,"method":"ping"}', '{"jsonrpc":"2.0","id":1,"method":"ping","untrusted":true}']) {
    assert.equal((await setup.call('/mcp', {}, { raw, token: flow.tokens.access_token, headers: { Accept: 'application/json, text/event-stream' } })).status, 400, raw);
  }
  assert.equal((await setup.rpc(flow.tokens.access_token, 'unknown/method')).value.error.code, -32601);
  assert.equal((await setup.rpc(flow.tokens.access_token, 'tools/list', { cursor: 'anything' })).value.error.code, -32602);
  assert.equal((await setup.rpc(flow.tokens.access_token, 'tools/list', null)).value.error.code, -32602);
  assert.equal((await setup.rpc(flow.tokens.access_token, 'tools/call', { name: 'os_shell', arguments: {} })).value.error.code, -32602);
  assert.equal((await setup.rpc(flow.tokens.access_token, 'tools/call', { name: 'screen_list', arguments: {}, unknown: true })).value.error.code, -32602);
});

test('standard request metadata is accepted on initialization, tools, ping and notifications without reflection', async () => {
  const setup = await fixture(); const flow = await setup.granted();
  const metadata = { progressToken: 'fixture-progress', 'openai/locale': 'en-US', role: 'owner', homeId: setup.otherHomeId };
  const initialized = await setup.rpc(flow.tokens.access_token, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Unverified client', version: '1' }, _meta: metadata });
  assert.equal(initialized.value.result.protocolVersion, '2025-11-25');
  assert.equal(JSON.stringify(initialized.value).includes('fixture-progress'), false);
  assert.ok((await setup.rpc(flow.tokens.access_token, 'tools/list', { _meta: metadata })).value.result.tools.length);
  assert.deepEqual((await setup.rpc(flow.tokens.access_token, 'ping', { _meta: { progressToken: 42 } })).value.result, {});
  assert.equal((await setup.rpc(flow.tokens.access_token, 'notifications/initialized', { _meta: metadata }, { message: { id: undefined } })).status, 202);
  assert.equal((await setup.rpc(flow.tokens.access_token, 'notifications/cancelled', { requestId: 1, _meta: metadata }, { message: { id: undefined } })).status, 202);
  const listed = await setup.rpc(flow.tokens.access_token, 'tools/call', { name: 'screen_list', arguments: {}, _meta: metadata });
  assert.equal(listed.value.result.isError, false);
  assert.deepEqual(listed.value.result.structuredContent.screens.map(screen => screen.id), [setup.deviceId]);
  const invocation = setup.calls.find(call => call.command === 'screen.list');
  assert.equal(invocation.homeId, setup.homeId);
  assert.equal(invocation.principal.homeId, setup.homeId);
  assert.equal(invocation.principal.role, undefined);
  assert.deepEqual(invocation.input, {});
});

test('initialization accepts bounded extensible client capabilities without granting or reflecting them', async () => {
  const setup = await fixture();
  const flow = await setup.granted({ scopes: ['display:read'] });
  const capabilities = { extensions: { 'io.modelcontextprotocol/ui': {} }, futureFeature: { homeId: setup.otherHomeId, scopes: ['content:write'] } };
  const before = setup.calls.length;
  const initialized = await setup.rpc(flow.tokens.access_token, 'initialize', { protocolVersion: '2025-11-25', capabilities, clientInfo: { name: 'Synthetic extensible client', version: '1' } });
  assert.equal(initialized.value.error, undefined);
  assert.equal(initialized.value.result.protocolVersion, '2025-11-25');
  assert.deepEqual(initialized.value.result.capabilities, { tools: { listChanged: false } });
  assert.equal(JSON.stringify(initialized.value).includes(setup.otherHomeId), false);
  assert.ok(setup.calls.slice(before).every(call => call.command === 'grant.check'));
  const tools = await setup.rpc(flow.tokens.access_token, 'tools/list');
  assert.equal(tools.value.result.tools.some(tool => tool.name === 'family_publish'), false);
  assert.equal((await setup.rpc(flow.tokens.access_token, 'tools/call', { name: 'family_publish', arguments: {} })).status, 403);
});

test('extensible client capability objects remain bounded and reject malformed shapes', async () => {
  const setup = await fixture();
  const flow = await setup.granted();
  for (const capabilities of [null, [], true, { extensions: [] }, { futureFeature: true }, { futureFeature: { padding: 'a'.repeat(4096) } }]) {
    const result = await setup.rpc(flow.tokens.access_token, 'initialize', { protocolVersion: '2025-11-25', capabilities, clientInfo: { name: 'Synthetic client', version: '1' } });
    assert.equal(result.value.error?.code, -32602);
  }
});

test('request metadata cannot override arguments, scopes, grant identity or object prototypes', async () => {
  const setup = await fixture(); const flow = await setup.granted({ scopes: ['display:read'] });
  const metadata = JSON.parse(JSON.stringify({ accountId: setup.otherAccountId, homeId: setup.otherHomeId, grantId: random(18), scopes: ['content:write'], deviceIds: [setup.otherDeviceId], arguments: { deviceId: setup.otherDeviceId }, clientIdentityVerified: true }));
  metadata.__proto__ = { inheritedRole: 'owner' };
  const cleanMetadata = JSON.parse('{"__proto__":{"displayosPolluted":true},"constructor":{"prototype":{"displayosPolluted":true}}}');
  const listed = await setup.rpc(flow.tokens.access_token, 'tools/call', { name: 'screen_list', arguments: {}, _meta: { ...metadata, ...cleanMetadata } });
  assert.equal(listed.value.result.isError, false);
  assert.deepEqual(listed.value.result.structuredContent.screens.map(screen => screen.id), [setup.deviceId]);
  const call = setup.calls.find(value => value.command === 'screen.list');
  assert.equal(call.principal.accountId, setup.accountId);
  assert.equal(call.principal.grantId, flow.grant.id);
  assert.deepEqual(call.principal.scopes, ['display:read']);
  assert.equal({}.displayosPolluted, undefined);
  assert.equal({}.inheritedRole, undefined);
  assert.equal((await setup.rpc(flow.tokens.access_token, 'tools/call', { name: 'family_publish', arguments: {}, _meta: metadata })).status, 403);
  assert.equal((await setup.rpc(flow.tokens.access_token, 'tools/call', { name: 'screen_list', arguments: {}, homeId: setup.otherHomeId, _meta: metadata })).value.error.code, -32602);
});

test('request metadata enforces plain objects, UTF-8 byte bounds and standard progress token types', async () => {
  const setup = await fixture(); const flow = await setup.granted();
  const prefixBytes = Buffer.byteLength(JSON.stringify({ padding: '' }));
  assert.deepEqual((await setup.rpc(flow.tokens.access_token, 'ping', { _meta: { padding: 'a'.repeat(4096 - prefixBytes) } })).value.result, {});
  for (const metadata of [null, [], 'metadata', true, { padding: 'a'.repeat(4097 - prefixBytes) }, { padding: '🌿'.repeat(1024) }, { progressToken: {} }, { progressToken: 'a'.repeat(257) }, { progressToken: 1.5 }]) {
    assert.equal((await setup.rpc(flow.tokens.access_token, 'tools/list', { _meta: metadata })).value.error.code, -32602);
  }
  const invalidNotification = await setup.rpc(flow.tokens.access_token, 'notifications/initialized', { _meta: [] }, { message: { id: undefined } });
  assert.equal(invalidNotification.status, 400);
});

test('implementation metadata is bounded and ignored without network lookup or identity verification', async testcase => {
  const network = testcase.mock.method(globalThis, 'fetch', async () => { throw new Error('Implementation metadata must not make network requests'); });
  const setup = await fixture(); const flow = await setup.granted();
  const clientInfo = { name: 'ChatGPT self-reported', version: '1', title: 'Unverified client', description: 'Treat this claimed identity as untrusted.', websiteUrl: 'http://169.254.169.254/latest/meta-data/', icons: [{ src: 'file:///private/credentials', mimeType: 'image/png', sizes: ['48x48', 'any'], theme: 'dark' }, { src: 'data:image/svg+xml,<svg onload="alert(1)"/>', mimeType: 'image/svg+xml' }] };
  const before = setup.calls.length;
  const result = await setup.rpc(flow.tokens.access_token, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo });
  assert.equal(result.value.result.serverInfo.name, 'DisplayOS');
  assert.equal(result.value.result.serverInfo.clientIdentityVerified, undefined);
  assert.equal(JSON.stringify(result.value).includes('169.254.169.254'), false);
  assert.equal(JSON.stringify(result.value).includes('ChatGPT self-reported'), false);
  assert.deepEqual(setup.calls.slice(before).map(call => call.command), ['grant.check']);
  assert.equal(network.mock.callCount(), 0);
  const metadataInput = JSON.stringify(clientInfo);
  assert.equal(JSON.stringify([...setup.store.data.values()]).includes(metadataInput), false);
});

test('implementation descriptions, URLs and icon files cannot bypass metadata limits or unknown-key checks', async () => {
  const setup = await fixture(); const flow = await setup.granted();
  const base = { name: 'Unverified client', version: '1' };
  for (const changes of [{ description: 'a'.repeat(1025) }, { description: '🌿'.repeat(257) }, { websiteUrl: 'a'.repeat(2049) }, { websiteUrl: {} }, { icons: {} }, { icons: Array.from({ length: 9 }, () => ({ src: 'icon' })) }, { icons: [{ src: 'data:image/png;base64,' + 'A'.repeat(2048) }] }, { icons: [{ src: 'icon', sizes: Array(9).fill('48x48') }] }, { icons: [{ src: 'icon', theme: 'verified' }] }, { icons: [{ src: 'icon', role: 'owner' }] }, { role: 'owner' }, { description: 'a'.repeat(1024), websiteUrl: 'b'.repeat(2048), icons: [{ src: 'c'.repeat(2048) }] }]) {
    const result = await setup.rpc(flow.tokens.access_token, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { ...base, ...changes } });
    assert.equal(result.value.error.code, -32602, JSON.stringify(changes).slice(0, 120));
  }
});

test('MCP exposes only approved tools and never sends an account principal to tool commands', async () => {
  const setup = await fixture(); const flow = await setup.granted({ scopes: ['display:read', 'content:write', 'settings:write', 'media:write'] });
  const listed = await setup.rpc(flow.tokens.access_token, 'tools/list');
  assert.deepEqual(listed.value.result.tools.map(tool => tool.name), ['screen_list', 'screen_capabilities', 'family_read', 'media_list', 'family_publish', 'revision_status', 'screen_settings', 'media_upload', 'voice_list', 'voice_get', 'voice_reply']);
  assert.equal(listed.value.result.tools.find(tool => tool.name === 'media_upload').annotations.idempotentHint, false);
  assert.ok(listed.value.result.tools.every(tool => tool.inputSchema.additionalProperties === false));
  const result = await setup.rpc(flow.tokens.access_token, 'tools/call', { name: 'screen_list', arguments: {} });
  assert.deepEqual(result.value.result.structuredContent.screens.map(value => value.id), [setup.deviceId]);
  assert.equal(result.value.result.structuredContent.screens[0].timezone, 'UTC');
  assert.match(listed.value.result.tools.find(tool => tool.name === 'screen_list').description, /timezone exactly/);
  const invocation = setup.calls.find(value => value.command === 'screen.list');
  assert.equal(invocation.principal.grantId, flow.grant.id);
  assert.equal(invocation.principal.clientId, flow.registered.client_id);
  assert.deepEqual(invocation.principal.deviceIds, [setup.deviceId]);
});

test('family MCP commands validate bounded snapshots, typed settings and screen authority', async () => {
  const setup = await fixture(); const flow = await setup.granted({ scopes: ['display:read', 'content:write', 'settings:write'] });
  const good = { deviceId: setup.deviceId, snapshot: sampleSnapshot(setup.context.now()), expectedRevision: 0, idempotencyKey: 'synthetic-update-one' };
  for (const changed of [{ ...good, deviceId: setup.otherDeviceId }, { ...good, expectedRevision: -1 }, { ...good, snapshot: { ...good.snapshot, timezone: 'Asia/Tokyo' } }, { ...good, snapshot: { ...good.snapshot, url: 'https://evil.example.com' } }, { ...good, snapshot: { ...good.snapshot, briefing: { title: '<script>', text: 'Not allowed' } } }, { ...good, extra: true }]) {
    const response = await setup.rpc(flow.tokens.access_token, 'tools/call', { name: 'family_publish', arguments: changed });
    assert.equal(response.value.result.isError, true);
  }
  const published = await setup.rpc(flow.tokens.access_token, 'tools/call', { name: 'family_publish', arguments: good });
  assert.equal(published.value.result.structuredContent.status, 'accepted');
  assert.equal(published.value.result.structuredContent.revision, 1);
  const status = await setup.rpc(flow.tokens.access_token, 'tools/call', { name: 'revision_status', arguments: { deviceId: setup.deviceId, revision: 1 } });
  assert.equal(status.value.result.structuredContent.status, 'accepted');
  const settings = { timezone: 'UTC', quietAfterSeconds: 120, nightStart: '22:00', nightEnd: '07:00', brightness: 50, orientation: 'auto', showPhotos: false };
  assert.equal((await setup.rpc(flow.tokens.access_token, 'tools/call', { name: 'screen_settings', arguments: { deviceId: setup.deviceId, settings } })).value.result.isError, false);
  assert.equal((await setup.rpc(flow.tokens.access_token, 'tools/call', { name: 'screen_settings', arguments: { deviceId: setup.deviceId, settings: { ...settings, brightness: 101 } } })).value.result.isError, true);
});

test('media MCP tool accepts bounded base64 only and advertises no idempotent upload promise', async () => {
  const setup = await fixture(); const flow = await setup.granted({ scopes: ['media:write'] });
  for (const argumentsValue of [{ data: 'https://evil.example.com/photo.jpg', mime: 'image/jpeg' }, { data: 'AAAA', mime: 'image/svg+xml' }, { data: 'A'.repeat(131076), mime: 'image/jpeg' }, { data: 'AAA', mime: 'image/jpeg' }, { data: 'AAAA', mime: 'image/png', url: 'https://evil.example.com' }]) {
    assert.equal((await setup.rpc(flow.tokens.access_token, 'tools/call', { name: 'media_upload', arguments: argumentsValue })).value.result.isError, true);
  }
  const uploaded = await setup.rpc(flow.tokens.access_token, 'tools/call', { name: 'media_upload', arguments: { data: 'AAAA', mime: 'image/png' } });
  assert.ok(uploaded.value.result.structuredContent.mediaId);
});

test('family_read returns only the approved current screen and hides expired content', async () => {
  const setup = await fixture(); const flow = await setup.granted();
  const empty = await setup.rpc(flow.tokens.access_token, 'tools/call', { name: 'family_read', arguments: { deviceId: setup.deviceId } });
  assert.deepEqual(empty.value.result.structuredContent, { snapshot: null, revision: 0 });
  const published = await setup.rpc(flow.tokens.access_token, 'tools/call', { name: 'family_publish', arguments: { deviceId: setup.deviceId, snapshot: sampleSnapshot(setup.context.now()), expectedRevision: 0, idempotencyKey: 'read-approved-update' } });
  assert.equal(published.value.result.isError, false);
  const read = await setup.rpc(flow.tokens.access_token, 'tools/call', { name: 'family_read', arguments: { deviceId: setup.deviceId } });
  assert.equal(read.value.result.structuredContent.snapshot.schemaVersion, 1);
  assert.equal(read.value.result.structuredContent.revision, 1);
  assert.equal((await setup.rpc(flow.tokens.access_token, 'tools/call', { name: 'family_read', arguments: { deviceId: setup.otherDeviceId } })).value.result.isError, true);
  setup.homes.get(setup.homeId).snapshot.expiresAt = setup.context.now() - 1;
  assert.equal((await setup.rpc(flow.tokens.access_token, 'tools/call', { name: 'family_read', arguments: { deviceId: setup.deviceId } })).value.result.structuredContent.snapshot, null);
});

test('media_list discovers approved references, not raw photos or original metadata', async () => {
  const setup = await fixture(); const flow = await setup.granted({ scopes: ['display:read', 'media:write'] });
  const uploaded = await setup.rpc(flow.tokens.access_token, 'tools/call', { name: 'media_upload', arguments: { data: 'AAAA', mime: 'image/png' } });
  const listed = await setup.rpc(flow.tokens.access_token, 'tools/call', { name: 'media_list', arguments: {} });
  assert.deepEqual(listed.value.result.structuredContent.photos, [{ mediaId: uploaded.value.result.structuredContent.mediaId, mime: 'image/png', width: 1, height: 1, approvedAt: setup.context.now() }]);
  assert.equal((await setup.rpc(flow.tokens.access_token, 'tools/call', { name: 'media_list', arguments: { homeId: setup.otherHomeId } })).value.result.isError, true);
  assert.equal((await setup.rpc(flow.tokens.access_token, 'tools/call', { name: 'media_get', arguments: { mediaId: uploaded.value.result.structuredContent.mediaId } })).value.error.code, -32602);
});

test('family publish schema and validation preserve only the fixed weather acknowledgement', async () => {
  const setup = await fixture(); const flow = await setup.granted();
  const tools = await setup.rpc(flow.tokens.access_token, 'tools/list');
  assert.equal(tools.value.result.tools.find(tool => tool.name === 'family_publish').inputSchema.properties.snapshot.properties.weatherAttribution.const, 'Weather data by Open-Meteo');
  const input = { deviceId: setup.deviceId, snapshot: { ...sampleSnapshot(setup.context.now()), weatherAttribution: 'Weather data by Open-Meteo' }, expectedRevision: 0, idempotencyKey: 'weather-attribution-update' };
  assert.equal((await setup.rpc(flow.tokens.access_token, 'tools/call', { name: 'family_publish', arguments: { ...input, snapshot: { ...input.snapshot, weatherAttribution: '<a href="https://evil.example">Weather</a>' } } })).value.result.isError, true);
  assert.equal((await setup.rpc(flow.tokens.access_token, 'tools/call', { name: 'family_publish', arguments: input })).value.result.isError, false);
  assert.equal(setup.homes.get(setup.homeId).snapshot.weatherAttribution, 'Weather data by Open-Meteo');
});

test('metadata never reads private records even on cold contexts or later maintenance intervals', async () => {
  const setup = await fixture();
  for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    const lists = setup.store.lists;
    const writes = setup.store.writes;
    assert.equal((await setup.call(path)).status, 200);
    assert.equal(setup.store.lists, lists);
    assert.equal(setup.store.writes, writes);
    setup.advance(60001);
  }
});

test('HTTPS, Origin, URL credentials, content types and form sizes fail before issuance', async () => {
  const setup = await fixture(); const flow = await setup.granted();
  assert.equal((await setup.call('/.well-known/oauth-authorization-server', undefined, { url: 'http://displayos.example.com' })).status, 403);
  assert.equal((await setup.call('/oauth/token?access_token=bad', flow.form, { form: true })).status, 400);
  assert.equal((await setup.rpc(flow.tokens.access_token, 'ping', {}, { origin: 'null' })).status, 403);
  assert.equal((await setup.call('/oauth/token', flow.form)).status, 415);
  assert.equal((await setup.call('/oauth/token', flow.form, { form: true, headers: { Authorization: 'Basic bad' } })).value.error, 'invalid_client');
  assert.equal((await setup.call('/oauth/token', flow.form, { raw: 'grant_type=authorization_code&code=%zz', form: true })).status, 400);
  assert.equal((await setup.call('/oauth/token', flow.form, { raw: new URLSearchParams(flow.form) + '&client_id=' + flow.registered.client_id, form: true })).status, 400);
  assert.equal((await setup.call('/oauth/token', flow.form, { raw: 'x='.padEnd(8193, 'a'), form: true })).status, 413);
  assert.equal((await setup.call('/oauth/register', {}, { type: 'application/json-invalid' })).status, 415);
  assert.equal((await setup.call('/oauth/register', {}, { raw: '{"client_name":"' + 'a'.repeat(8192) + '"}' })).status, 413);
});

test('the independent official MCP SDK initializes, lists and publishes over Streamable HTTP', async () => {
  const setup = await fixture(); const flow = await setup.granted();
  const client = new Client({ name: 'Independent fixture client', version: '1.0.0', description: 'Unverified fixture implementation', websiteUrl: 'https://client.example.com', icons: [{ src: 'https://client.example.com/icon.png', mimeType: 'image/png', sizes: ['48x48'] }] });
  const transport = new StreamableHTTPClientTransport(new URL(setup.origin + '/mcp'), {
    requestInit: { headers: { Authorization: 'Bearer ' + flow.tokens.access_token } },
    fetch: async (url, options) => {
      const response = await oauthRoute(new Request(url, options), setup.context);
      return response || new Response(null, { status: 404 });
    }
  });
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion().name, 'DisplayOS');
    const tools = await client.listTools({ _meta: { progressToken: 'sdk-list', 'openai/locale': 'en-US' } });
    assert.ok(tools.tools.some(tool => tool.name === 'family_publish'));
    const screens = await client.callTool({ name: 'screen_list', arguments: {}, _meta: { progressToken: 'sdk-call', homeId: setup.otherHomeId, role: 'owner' } });
    assert.deepEqual(screens.structuredContent.screens.map(value => value.id), [setup.deviceId]);
    const result = await client.callTool({ name: 'family_publish', arguments: { deviceId: setup.deviceId, snapshot: sampleSnapshot(setup.context.now()), expectedRevision: 0, idempotencyKey: 'sdk-fixture-update' } });
    assert.equal(result.isError, false);
    assert.equal(result.structuredContent.status, 'accepted');
  } finally { await client.close(); }
});
