import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { digest, random, internalRequest } from '../src/product/common.js';

const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }', shortCircuit: true };
    return next(specifier, context);
  }
});
const { ProductRegistry } = await import('../src/product/registry.js');
const { HouseholdState } = await import('../src/product/household.js');
hooks.deregister();

const ORIGIN = 'https://preview.example.com';
const PATH = '/api/v1/providers/google/';

function storage() {
  const records = new Map();
  return {
    async get(key) { return structuredClone(records.get(key)); },
    async put(key, value) { records.set(key, structuredClone(value)); },
    async delete(key) { return records.delete(key); },
    async list({ prefix, limit }) { return new Map([...records].filter(([key]) => key.startsWith(prefix)).sort(([first], [second]) => first.localeCompare(second)).slice(0, limit)); },
    async transaction(callback) {
      const previous = structuredClone(records);
      try { return await callback(this); }
      catch (error) { records.clear(); for (const [key, value] of previous) records.set(key, value); throw error; }
    },
    async deleteAlarm() {},
    async setAlarm() {}
  };
}

function context(id) {
  let queue = Promise.resolve();
  return {
    id: { toString: () => id }, storage: storage(), locked: false, blocks: 0, beforeBlock: null,
    blockConcurrencyWhile(callback) {
      const pending = queue.then(async () => {
        this.locked = true;
        this.blocks++;
        try { await this.beforeBlock?.(this.blocks); return await callback(); }
        finally { this.locked = false; }
      });
      queue = pending.catch(() => {});
      return pending;
    }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const registryContext = context('registry');
  const homeContext = context('home');
  const homeId = random(24);
  const accountId = random(16);
  const deviceId = random(24);
  const token = random();
  const sessionId = await digest(token);
  const csrf = random();
  const env = { PUBLIC_ORIGIN: ORIGIN, PRODUCT_STATE_KEY: 'ab'.repeat(32), FACTORY_CREDENTIAL: random(), GOOGLE_GEOCODING_API_KEY: 'fixture-geocoding', GOOGLE_WEATHER_API_KEY: 'fixture-weather', GOOGLE_PLACES_API_KEY: 'fixture-places' };
  const household = new HouseholdState(homeContext, env);
  env.HOMES = { idFromName: value => value, get: value => {
    assert.equal(value, homeId);
    return household;
  } };
  const registry = new ProductRegistry(registryContext, env);
  await registry.records.put('account:' + accountId, { id: accountId, name: 'Fixture owner', status: 'active', authVersion: 1, credentialIds: ['fixture-passkey'], recoveryHashes: [] });
  await registry.records.put('session:' + accountId + ':' + sessionId, { accountId, sessionId, csrf, authVersion: 1, expiresAt: Date.now() + 3600000, verifiedAt: Date.now() });
  await registry.records.put('account-homes:' + accountId, { homes: [homeId] });
  await registry.homeCall(homeId, { system: true }, 'home.create', { id: homeId, accountId, name: 'Fixture home', accountName: 'Fixture owner' });
  await registry.homeCall(homeId, { system: true }, 'screen.attach', { deviceId, epoch: 1, name: 'Fixture screen' });
  const deviceToken = random();
  const tokenHash = await digest(deviceToken);
  await registry.records.put('device:' + deviceId, { id: deviceId, homeId, ownerAccountId: accountId, epoch: 1, state: 'owned', tokenHash });
  await registry.records.put('device-token:' + tokenHash, { id: deviceId });
  await registry.records.put('provider:location:' + homeId, { version: 1, address: 'Toronto, CA', weather: true, nearby: true, savedAt: Date.now() });
  const headers = { Origin: ORIGIN, Cookie: '__Host-displayos=' + accountId + '.' + token, 'X-DisplayOS-CSRF': csrf, 'Content-Type': 'application/json' };
  function request(path, body = { homeId }, overrides = {}) {
    const method = overrides.method || 'POST';
    return new Request(overrides.url || ORIGIN + path, { method, headers: { ...headers, ...overrides.headers }, body: method === 'POST' ? JSON.stringify(body) : undefined });
  }
  return { registry, registryContext, household, homeId, accountId, deviceId, deviceToken, sessionId, request, env };
}

function mockGoogle(fixture, options = {}) {
  const original = globalThis.fetch;
  const entered = deferred();
  const released = deferred();
  const calls = [];
  globalThis.fetch = async address => {
    assert.equal(fixture.registryContext.locked, false, 'Google network must never run in the registry critical section');
    const url = new URL(address);
    calls.push(url.hostname);
    if (url.hostname !== 'maps.googleapis.com') {
      entered.resolve();
      if (options.delay) await released.promise;
      if (options.fail) return Response.json({ error: 'fixture failure' }, { status: 503 });
    }
    if (url.hostname === 'maps.googleapis.com') return Response.json({ status: 'OK', results: [{ types: ['locality'], address_components: [{ long_name: 'Toronto', types: ['locality'] }, { short_name: 'CA', types: ['country'] }], geometry: { location: { lat: 43.65, lng: -79.38 } } }] });
    if (url.hostname === 'weather.googleapis.com') return Response.json({ forecastDays: [{ displayDate: { year: 2026, month: 10, day: 10 }, maxTemperature: { unit: 'CELSIUS', degrees: 18 }, minTemperature: { unit: 'CELSIUS', degrees: 9 }, daytimeForecast: { weatherCondition: { description: { text: 'Sunny' } } } }] });
    if (url.hostname === 'places.googleapis.com') return Response.json({ places: [{ displayName: { text: 'Fixture park' }, primaryTypeDisplayName: { text: 'Park' } }] });
    throw new Error('Unexpected network request');
  };
  return { entered: entered.promise, release: released.resolve, calls, restore() { released.resolve(); globalThis.fetch = original; } };
}

async function completesBeforeRelease(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Owner action waited for Google')), 1500); })]); }
  finally { clearTimeout(timer); }
}

for (const kind of ['weather', 'nearby']) {
  test(kind + ' preview keeps real browser, owner, rate and provider checks and finishes under serialization', async context => {
    const fixtureValue = await fixture();
    const google = mockGoogle(fixtureValue);
    context.after(() => google.restore());
    const response = await fixtureValue.registry.fetch(fixtureValue.request(PATH + kind));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.locationVersion, 1);
    assert.equal(result.ephemeral, true);
    assert.equal(result.attribution, 'Google Maps');
    assert.equal(result[kind].length, 1);
    assert.equal(fixtureValue.registryContext.blocks, 2);
    assert.equal(google.calls.length, 2);
    assert.equal((await fixtureValue.registry.records.get('provider:google-budget')).count, 2);
    assert.equal(fixtureValue.registry.budgets.groups.get('family').has('account:local:' + fixtureValue.accountId), true);
  });

  test(kind + ' preview rejects boundary, CSRF, session, body and non-owner failures before Google', async context => {
    const fixtureValue = await fixture();
    const google = mockGoogle(fixtureValue);
    context.after(() => google.restore());
    for (const [body, overrides, status] of [
      [{ homeId: fixtureValue.homeId }, { headers: { Origin: 'https://other.example' } }, 403],
      [{ homeId: fixtureValue.homeId }, { headers: { 'X-DisplayOS-CSRF': 'wrong' } }, 403],
      [{ homeId: fixtureValue.homeId }, { headers: { Cookie: '' } }, 401],
      [{ homeId: fixtureValue.homeId }, { headers: { 'Sec-Fetch-Site': 'cross-site' } }, 403],
      [{ homeId: fixtureValue.homeId, accountId: fixtureValue.accountId }, {}, 400],
      [{ homeId: fixtureValue.homeId }, { method: 'GET' }, 405],
      [{ homeId: fixtureValue.homeId }, { url: ORIGIN + PATH + kind + '?private=1' }, 400],
      [{ homeId: fixtureValue.homeId }, { url: ORIGIN + PATH + kind + '#private' }, 400],
      [{ homeId: fixtureValue.homeId }, { url: 'https://other.example' + PATH + kind }, 403],
      [{ homeId: 'invalid' }, {}, 400]
    ]) assert.equal((await fixtureValue.registry.fetch(fixtureValue.request(PATH + kind, body, overrides))).status, status);
    assert.throws(() => fixtureValue.registry.customerAddress({ url: 'https://user@preview.example.com' + PATH + kind, headers: new Headers() }), error => error.status === 400);
    const home = await fixtureValue.household.records.get('home');
    home.members[0].role = 'member';
    await fixtureValue.household.records.put('home', home);
    assert.equal((await fixtureValue.registry.fetch(fixtureValue.request(PATH + kind))).status, 403);
    assert.deepEqual(google.calls, []);
  });

  for (const action of ['withdraw', 'location', 'reset', 'home-delete', 'logout', 'account-delete']) {
    test(kind + ' delayed preview does not block ' + action + ' and rejects withdrawn authority', async context => {
      const fixtureValue = await fixture();
      const google = mockGoogle(fixtureValue, { delay: true });
      context.after(() => google.restore());
      const preview = fixtureValue.registry.fetch(fixtureValue.request(PATH + kind));
      await google.entered;
      let actionRequest;
      if (action === 'withdraw' || action === 'location') actionRequest = fixtureValue.request('/api/v1/providers/location/save', { homeId: fixtureValue.homeId, address: action === 'location' ? 'Ottawa, CA' : 'Toronto, CA', weather: action !== 'withdraw', nearby: action !== 'withdraw' });
      if (action === 'reset') actionRequest = fixtureValue.request('/api/v1/screens/reset', { homeId: fixtureValue.homeId, deviceId: fixtureValue.deviceId });
      if (action === 'home-delete') actionRequest = fixtureValue.request('/api/v1/home', { homeId: fixtureValue.homeId, command: 'home.delete' });
      if (action === 'logout') actionRequest = fixtureValue.request('/auth/logout', {});
      if (action === 'account-delete') actionRequest = fixtureValue.request('/auth/account/delete', {});
      const actionResponse = await completesBeforeRelease(fixtureValue.registry.fetch(actionRequest));
      assert.equal(actionResponse.status, 200, await actionResponse.text());
      google.release();
      const response = await preview;
      const expected = { withdraw: 409, location: 409, reset: 200, 'home-delete': 409, logout: 401, 'account-delete': 409 };
      assert.equal(response.status, expected[action]);
      const result = await response.json();
      if (action !== 'reset') assert.equal(result[kind], undefined, 'No provider content after revocation');
      else assert.equal((await fixtureValue.registry.records.get('device:' + fixtureValue.deviceId)).state, 'erase');
    });
  }
}

for (const change of ['session', 'account-version', 'account-deleting', 'owner', 'timezone', 'location-version', 'consent']) {
  test('serialized finalizer rejects ' + change + ' changed after the provider last checked consent', async context => {
    const fixtureValue = await fixture();
    const google = mockGoogle(fixtureValue);
    context.after(() => google.restore());
    fixtureValue.registryContext.beforeBlock = async count => {
      if (count !== 2) return;
      if (change === 'session') {
        const key = 'session:' + fixtureValue.accountId + ':' + fixtureValue.sessionId;
        const session = await fixtureValue.registry.records.get(key);
        await fixtureValue.registry.records.put(key, { ...session, sessionId: random() });
      }
      if (change.startsWith('account-')) {
        const key = 'account:' + fixtureValue.accountId;
        const account = await fixtureValue.registry.records.get(key);
        await fixtureValue.registry.records.put(key, { ...account, ...(change === 'account-version' ? { authVersion: 2 } : { status: 'deleting' }) });
      }
      if (change === 'owner' || change === 'timezone') {
        const home = await fixtureValue.household.records.get('home');
        if (change === 'owner') home.members[0].role = 'member';
        else home.settings.timezone = 'America/Toronto';
        await fixtureValue.household.records.put('home', home);
      }
      if (change === 'location-version' || change === 'consent') {
        const key = 'provider:location:' + fixtureValue.homeId;
        const location = await fixtureValue.registry.records.get(key);
        await fixtureValue.registry.records.put(key, { ...location, ...(change === 'consent' ? { weather: false } : { version: 2 }) });
      }
    };
    const response = await fixtureValue.registry.fetch(fixtureValue.request(PATH + 'weather'));
    assert.equal(response.status, change.startsWith('account-') || change === 'session' ? 401 : change === 'owner' ? 403 : 409);
    assert.equal((await response.json()).weather, undefined);
  });
}

test('owner preview rate exhaustion and missing configuration do not perform network requests', async context => {
  const fixtureValue = await fixture();
  const google = mockGoogle(fixtureValue);
  context.after(() => google.restore());
  delete fixtureValue.env.GOOGLE_WEATHER_API_KEY;
  assert.equal((await fixtureValue.registry.fetch(fixtureValue.request(PATH + 'weather'))).status, 503);
  fixtureValue.env.GOOGLE_WEATHER_API_KEY = 'fixture-weather';
  for (let index = 0; index < 11; index++) await fixtureValue.registry.rate('account:local:' + fixtureValue.accountId, 12, 3600000);
  assert.equal((await fixtureValue.registry.fetch(fixtureValue.request(PATH + 'weather'))).status, 429);
  assert.deepEqual(google.calls, []);
});

test('provider failure releases serialization for location changes', async context => {
  const fixtureValue = await fixture();
  const google = mockGoogle(fixtureValue, { delay: true, fail: true });
  context.after(() => google.restore());
  const preview = fixtureValue.registry.fetch(fixtureValue.request(PATH + 'weather'));
  await google.entered;
  const save = await completesBeforeRelease(fixtureValue.registry.fetch(fixtureValue.request('/api/v1/providers/location/save', { homeId: fixtureValue.homeId, address: 'Ottawa, CA', weather: false, nearby: false })));
  assert.equal(save.status, 200);
  google.release();
  assert.equal((await preview).status, 502);
});

test('legacy provider dispatcher cannot bypass the preview finalizer', async () => {
  const fixtureValue = await fixture();
  await assert.rejects(fixtureValue.registry.providers(fixtureValue.request(PATH + 'weather'), { accountId: fixtureValue.accountId }, { homeId: fixtureValue.homeId }), error => error.status === 404);
  const home = await fixtureValue.household.fetch(internalRequest(ORIGIN, 'home.get', {}, { accountId: fixtureValue.accountId }, fixtureValue.env.FACTORY_CREDENTIAL));
  assert.equal(home.status, 200);
});
