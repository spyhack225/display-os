import test from 'node:test';
import assert from 'node:assert/strict';
import { oauthRoute } from '../src/product/oauth.js';
import { HttpError, random, digest } from '../src/product/common.js';
import { validateSnapshot, sampleSnapshot, capabilities } from '../src/product/family.js';

class MemoryStore {
  constructor(data = new Map(), root = null) { this.data = data; this.root = root || this; }
  async get(key) { const value = this.data.get(key); return value === undefined ? undefined : structuredClone(value); }
  async put(key, value) { this.data.set(key, structuredClone(value)); }
  async delete(key) { return this.data.delete(key); }
  async list(prefix, limit = 200) {
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
  const now = Date.now();
  const origin = 'https://displayos.example.com';
  const store = new MemoryStore();
  const accountId = random(16);
  const homeId = random(18);
  const deviceId = random(18);
  const otherDeviceId = random(18);
  const homes = new Map([[homeId, { owner: accountId, devices: [deviceId, otherDeviceId], grants: new Map(), operations: new Map(), revision: 0, timezone: 'UTC' }]]);
  await store.put('account:' + accountId, { id: accountId, status: 'active', authVersion: 1 });
  const calls = [];
  const context = {
    origin, env: {}, store, now: () => now,
    async rate() {},
    async authenticate(request) {
      if (!/(?:^|;\s*)owner=A(?:;|$)/.test(request.headers.get('cookie') || '')) throw new HttpError(401, 'Sign in.');
      return { accountId, sessionId: 'A:first', csrf: 'test-csrf-A', verifiedAt: now };
    },
    async requireBrowser(request) {
      const principal = await this.authenticate(request);
      if (request.headers.get('origin') !== origin || request.headers.get('X-DisplayOS-CSRF') !== principal.csrf) throw new HttpError(403, 'Confirm this change.');
      return principal;
    },
    async homeCall(id, principal, command, input = {}) {
      calls.push({ homeId: id, command, input: structuredClone(input) });
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
      if (command === 'grant.check') {
        assert.equal(principal.grantId, undefined, 'grant.check must use account authority');
        const grant = home.grants.get(input.grantId);
        if (!grant || grant.revokedAt || grant.expiresAt <= now || !grant.deviceIds.length || input.deviceIds?.some(device => !grant.deviceIds.includes(device) || !home.devices.includes(device))) throw new HttpError(403, 'This assistant no longer has access.');
        return structuredClone(grant);
      }
      const grant = home.grants.get(principal.grantId);
      if (!grant || grant.revokedAt || grant.expiresAt <= now || grant.clientId !== principal.clientId || grant.accountId !== principal.accountId) throw new HttpError(403, 'This assistant no longer has access.');
      const scope = { 'screen.list': 'display:read', 'screen.capabilities': 'display:read', 'family.current': 'display:read', 'media.list': 'display:read', 'revision.status': 'display:read', 'family.publish': 'content:write', 'screen.settings': 'settings:write', 'media.upload': 'media:write', 'voice.list': 'display:read', 'voice.get': 'display:read', 'voice.reply': 'content:write' }[command];
      if (!scope || !grant.scopes.includes(scope) || !principal.scopes.includes(scope) || input.deviceId && !grant.deviceIds.includes(input.deviceId)) throw new HttpError(403, 'This permission was not approved.');
      if (command === 'screen.capabilities') return capabilities();
      if (command === 'family.publish') {
        validateSnapshot(input.snapshot, now);
        if (input.snapshot.timezone !== home.timezone) throw new HttpError(400, 'Use the selected screen timezone.');
        if (input.expectedRevision !== home.revision) throw new HttpError(409, 'Another update arrived first.');
        home.revision++;
        home.snapshot = input.snapshot;
        return { revision: home.revision, status: 'accepted' };
      }
      if (command === 'voice.list') return { messages: [] };
      if (command === 'voice.get') return { id: input.messageId, mime: 'audio/webm', data: 'AAAA', durationMs: 1000 };
      if (command === 'voice.reply') return { revision: home.revision, status: 'acted' };
      throw new HttpError(404, 'Not available.');
    }
  };
  function request(path, value, options = {}) {
    const method = options.method || (value === undefined ? 'GET' : 'POST');
    const headers = new Headers(options.headers);
    headers.set('CF-Connecting-IP', options.ip || '192.0.2.1');
    if (options.owner) {
      headers.set('cookie', ['owner=' + options.owner, options.cookie || ''].filter(Boolean).join('; '));
      if (method === 'POST') { headers.set('origin', options.origin ?? origin); headers.set('X-DisplayOS-CSRF', options.csrf ?? 'test-csrf-' + options.owner); }
    } else if (options.cookie) headers.set('cookie', options.cookie);
    if (options.token) headers.set('authorization', 'Bearer ' + options.token);
    let body;
    if (method !== 'GET' && method !== 'HEAD') {
      body = options.form ? new URLSearchParams(value).toString() : JSON.stringify(value);
      headers.set('content-type', options.form ? 'application/x-www-form-urlencoded' : 'application/json');
    }
    return new Request(origin + path, { method, headers, body });
  }
  async function call(path, value, options = {}) {
    const response = await oauthRoute(request(path, value, options), context);
    if (response === null) return null;
    const body = await response.text();
    return { response, status: response.status, value: body ? JSON.parse(body) : null, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  async function register() {
    const result = await call('/oauth/register', { client_name: 'Synthetic assistant', redirect_uris: ['https://assistant.example.com/callback'] });
    assert.equal(result.status, 201, JSON.stringify(result.value));
    return result.value;
  }
  async function start() {
    const registered = await register();
    const verifier = random();
    const params = { response_type: 'code', client_id: registered.client_id, redirect_uri: registered.redirect_uris[0], state: random(24), code_challenge_method: 'S256', code_challenge: await digest(verifier), resource: origin + '/mcp', scope: 'display:read content:write' };
    const response = await call('/oauth/authorize?' + new URLSearchParams(params));
    assert.equal(response.status, 302, JSON.stringify(response.value));
    return { registered, verifier, params, intentId: new URL(response.response.headers.get('location')).hash.split('=')[1], cookie: response.cookie };
  }
  async function granted() {
    const flow = await start();
    const approval = await call('/api/v1/connections/approve', { intentId: flow.intentId, homeId, deviceIds: [deviceId], scopes: flow.params.scope.split(' '), duration: 3600 }, { owner: 'A', cookie: flow.cookie });
    assert.equal(approval.status, 200, JSON.stringify(approval.value));
    const code = new URL(approval.value.redirectUrl).searchParams.get('code');
    const result = await call('/oauth/token', { grant_type: 'authorization_code', client_id: flow.registered.client_id, code, code_verifier: flow.verifier, redirect_uri: flow.params.redirect_uri, resource: origin + '/mcp' }, { form: true });
    assert.equal(result.status, 200, JSON.stringify(result.value));
    return { ...flow, tokens: result.value };
  }
  async function rpc(token, method, params = {}) {
    return call('/mcp', { jsonrpc: '2.0', id: 1, method, params }, { token, headers: { Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' } });
  }
  return { context, origin, homeId, deviceId, otherDeviceId, homes, calls, granted, rpc };
}

function scene(overrides = {}) {
  return {
    id: 'voice-scene-0001',
    kind: 'answer',
    title: 'Milk is on the list',
    subtitle: 'Anything else for the shop?',
    blocks: [
      { type: 'text', text: 'Added milk to your groceries.' },
      { type: 'rows', rows: [{ label: 'Milk', value: 'Added', tone: 'good' }] },
      { type: 'chips', chips: ['Milk', 'Eggs'] },
      { type: 'steps', steps: ['Say the item', 'I add it'] },
      { type: 'bars', bars: [{ label: 'Week', value: 0.5 }] }
    ],
    ttlSeconds: 300,
    ...overrides
  };
}

function ack(overrides = {}) {
  return { id: 'voice-ack-000001', state: 'acted', heard: 'add milk to groceries', agentName: 'Maya', ...overrides };
}

test('screen capabilities advertise scene kinds, voice states and audio', async () => {
  const setup = await fixture();
  const flow = await setup.granted();
  const result = await setup.rpc(flow.tokens.access_token, 'tools/call', { name: 'screen_capabilities', arguments: {} });
  assert.equal(result.value.result.isError, false);
  const value = result.value.result.structuredContent;
  assert.deepEqual(value.sceneKinds, ['answer', 'plan', 'list', 'compare', 'steps', 'note', 'timer']);
  assert.deepEqual(value.voiceStates, ['received', 'heard', 'acted', 'failed']);
  assert.deepEqual(value.audio, { formats: ['audio/webm'], maxBytes: 262144, maxSeconds: 120 });
  assert.deepEqual(value.media, capabilities().media);
});

test('tools list includes the voice tools with their scopes and bounded inputs', async () => {
  const setup = await fixture();
  const flow = await setup.granted();
  const listed = await setup.rpc(flow.tokens.access_token, 'tools/list');
  const tools = Object.fromEntries(listed.value.result.tools.map(tool => [tool.name, tool]));
  assert.deepEqual(Object.keys(tools).filter(name => name.startsWith('voice_')), ['voice_list', 'voice_get', 'voice_reply']);
  assert.deepEqual(tools.voice_list.securitySchemes, [{ type: 'oauth2', scopes: ['display:read'] }]);
  assert.deepEqual(tools.voice_get.securitySchemes, [{ type: 'oauth2', scopes: ['display:read'] }]);
  assert.deepEqual(tools.voice_reply.securitySchemes, [{ type: 'oauth2', scopes: ['content:write'] }]);
  assert.deepEqual(tools.voice_list.inputSchema, { type: 'object', properties: {}, required: [], additionalProperties: false });
  assert.deepEqual(Object.keys(tools.voice_get.inputSchema.properties), ['messageId']);
  assert.deepEqual(tools.voice_get.inputSchema.required, ['messageId']);
  assert.deepEqual(Object.keys(tools.voice_reply.inputSchema.properties), ['deviceId', 'messageId', 'displayScene', 'voiceAck']);
  assert.deepEqual(tools.voice_reply.inputSchema.required, ['deviceId', 'messageId', 'displayScene', 'voiceAck']);
  assert.equal(tools.voice_reply.inputSchema.additionalProperties, false);
  assert.equal(tools.voice_reply.annotations.readOnlyHint, false);
  assert.equal(tools.voice_list.annotations.readOnlyHint, true);
  assert.match(tools.voice_get.description, /transcribe the audio yourself/);
  assert.match(tools.voice_get.description, /paste the audio/);
  assert.match(tools.voice_reply.description, /answer, plan, list, compare, steps, note or timer/);
  assert.match(tools.voice_reply.description, /voiceAck\.state.*acted/);
  const snapshot = tools.family_publish.inputSchema.properties.snapshot;
  assert.ok(snapshot.properties.displayScene && snapshot.properties.voiceAck);
  assert.deepEqual(snapshot.required, ['schemaVersion', 'timezone', 'generatedAt', 'expiresAt', 'briefing']);
  assert.deepEqual(snapshot.properties.displayScene.properties.kind.enum, ['answer', 'plan', 'list', 'compare', 'steps', 'note', 'timer']);
  assert.equal(snapshot.properties.displayScene.properties.blocks.minItems, 1);
  assert.equal(snapshot.properties.displayScene.properties.blocks.maxItems, 6);
  assert.equal(snapshot.properties.displayScene.properties.blocks.items.oneOf.length, 5);
  assert.equal(snapshot.properties.displayScene.properties.ttlSeconds.minimum, 30);
  assert.equal(snapshot.properties.displayScene.properties.ttlSeconds.maximum, 3600);
  assert.deepEqual(snapshot.properties.voiceAck.properties.state.enum, ['received', 'heard', 'acted', 'failed']);
  assert.deepEqual(snapshot.properties.voiceAck.required, ['id', 'state']);
});

test('family publish accepts a display scene and rejects malformed scenes', async () => {
  const setup = await fixture();
  const flow = await setup.granted();
  const base = () => ({ deviceId: setup.deviceId, snapshot: { ...sampleSnapshot(setup.context.now()), displayScene: scene(), voiceAck: ack() }, expectedRevision: 0, idempotencyKey: 'voice-scene-publish' });
  for (const change of [
    value => { value.snapshot.displayScene.kind = 'mystery'; },
    value => { value.snapshot.displayScene.title = 'https://example.com'; },
    value => { value.snapshot.displayScene.blocks = Array(7).fill({ type: 'text', text: 'Line' }); },
    value => { value.snapshot.displayScene.blocks = [{ type: 'bars', bars: [{ label: 'Share', value: 2 }] }]; },
    value => { value.snapshot.voiceAck.state = 'maybe'; }
  ]) {
    const next = base();
    change(next);
    const response = await setup.rpc(flow.tokens.access_token, 'tools/call', { name: 'family_publish', arguments: next });
    assert.equal(response.value.result.isError, true);
    assert.equal(setup.homes.get(setup.homeId).revision, 0);
  }
  const published = await setup.rpc(flow.tokens.access_token, 'tools/call', { name: 'family_publish', arguments: base() });
  assert.equal(published.value.result.isError, false);
  assert.deepEqual(published.value.result.structuredContent, { revision: 1, status: 'accepted' });
  assert.equal(setup.homes.get(setup.homeId).snapshot.displayScene.kind, 'answer');
  assert.equal(setup.homes.get(setup.homeId).snapshot.voiceAck.state, 'acted');
});

test('voice reply requires its four fields and an approved screen', async () => {
  const setup = await fixture();
  const flow = await setup.granted();
  const complete = () => ({ deviceId: setup.deviceId, messageId: 'voice-message-0001', displayScene: scene({ kind: 'note', title: 'Heard you' }), voiceAck: ack() });
  for (const argumentsValue of [
    { ...complete(), extra: true },
    { deviceId: setup.deviceId, messageId: 'voice-message-0001', displayScene: scene() },
    { deviceId: setup.deviceId, messageId: 'voice-message-0001', voiceAck: ack() },
    { deviceId: setup.deviceId, displayScene: scene(), voiceAck: ack() },
    { messageId: 'voice-message-0001', displayScene: scene(), voiceAck: ack() },
    { ...complete(), deviceId: setup.otherDeviceId }
  ]) {
    const response = await setup.rpc(flow.tokens.access_token, 'tools/call', { name: 'voice_reply', arguments: argumentsValue });
    assert.equal(response.value.result.isError, true);
    assert.equal(setup.calls.filter(entry => entry.command === 'voice.reply').length, 0);
  }
  const answered = await setup.rpc(flow.tokens.access_token, 'tools/call', { name: 'voice_reply', arguments: complete() });
  assert.equal(answered.value.result.isError, false);
  assert.deepEqual(answered.value.result.structuredContent, { revision: 0, status: 'acted' });
  const invocation = setup.calls.find(entry => entry.command === 'voice.reply');
  assert.ok(invocation);
  assert.equal(invocation.input.messageId, 'voice-message-0001');
  assert.deepEqual(invocation.input.voiceAck, ack());
});
