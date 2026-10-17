import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare, Log, LogLevel, convertV4MiniflareOptions } from 'miniflare';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ORIGIN = 'https://provider-races.example.test';
const BUNDLE = path.join(ROOT, '.wrangler', 'bundle', 'worker.js');
const WEATHER_MARKER = 'Synthetic race weather';
const PLACE_MARKER = 'Synthetic race park';
const DEADLINE = 3000;
const random = bytes => randomBytes(bytes).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('base64url');
const settings = { timezone: 'UTC', quietAfterSeconds: 120, nightStart: '22:00', nightEnd: '07:00', brightness: 70, orientation: 'auto', showPhotos: true };

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function bounded(promise, label, timeout = DEADLINE) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' did not finish before provider release')), timeout);
    })]);
  } finally { clearTimeout(timer); }
}

function entryModule() {
  return `
import worker, { ProductRegistry, HouseholdState, PilotState } from './bundle.js';
export { PilotState };
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.origin === env.PUBLIC_ORIGIN && url.pathname === '/__race/fixture' && request.method === 'POST') {
      const input = await request.json();
      const namespace = input.homeId ? env.HOMES : env.REGISTRY;
      const target = namespace.get(namespace.idFromName(input.homeId || 'displayos-identity-v1'));
      if (input.operation === 'seed') {
        await target.seedRecords(input.records);
        return Response.json({ seeded: true });
      }
      if (input.operation === 'evidence') return Response.json(await target.evidence(input.locationHomeId));
      return Response.json({ error: 'Unknown fixture operation' }, { status: 400 });
    }
    return worker.fetch(request, env, ctx);
  }
};
export class RaceRegistry extends ProductRegistry {
  async seedRecords(records) {
    await this.ctx.blockConcurrencyWhile(() => this.records.transaction(async store => {
      for (const [key, value] of records) await store.put(key, value);
    }));
  }
  async evidence(homeId) {
    return this.ctx.blockConcurrencyWhile(async () => ({
      budget: await this.records.get('provider:google-budget'),
      location: await this.records.get('provider:location:' + homeId)
    }));
  }
}
export class RaceHome extends HouseholdState {
  async seedRecords(records) {
    await this.ctx.blockConcurrencyWhile(() => this.records.transaction(async store => {
      for (const [key, value] of records) await store.put(key, value);
    }));
  }
  async evidence() {
    return this.ctx.blockConcurrencyWhile(async () => ({
      contents: (await this.records.list('content:', 9)).size,
      receipts: (await this.records.list('receipt:', 25)).size
    }));
  }
}
`;
}

export async function verifyProductProviderRaces() {
  const bundle = await readFile(BUNDLE, 'utf8');
  const bundleSha256 = createHash('sha256').update(bundle).digest('hex');
  const bindings = Object.fromEntries(['OWNER_CREDENTIAL', 'ENROLLMENT_CODE', 'STATE_ENCRYPTION_KEY', 'PRODUCT_STATE_KEY', 'FACTORY_CREDENTIAL'].map(name => [name, randomBytes(32).toString('hex')]));
  Object.assign(bindings, { PUBLIC_ORIGIN: ORIGIN, GOOGLE_GEOCODING_API_KEY: 'synthetic-geocoding-only', GOOGLE_WEATHER_API_KEY: 'synthetic-weather-only', GOOGLE_PLACES_API_KEY: 'synthetic-places-only' });
  let checks = 0;
  let cases = 0;
  let providerCalls = 0;
  let deniedOutbound = 0;
  let hold = null;
  let runtime;
  function check(actual, expected, label) { assert.deepEqual(actual, expected, label); checks++; }
  function requireTrue(value, label) { assert.ok(value, label); checks++; }
  const forecast = {
    forecastDays: [{ displayDate: { year: 2026, month: 10, day: 10 }, maxTemperature: { degrees: 20, unit: 'CELSIUS' }, minTemperature: { degrees: 10, unit: 'CELSIUS' }, daytimeForecast: { weatherCondition: { description: { text: WEATHER_MARKER } } } }]
  };
  async function outbound(request) {
    const url = new URL(request.url);
    const geocoding = url.protocol === 'https:' && url.origin === 'https://maps.googleapis.com' && url.pathname === '/maps/api/geocode/json' && request.method === 'GET' && url.searchParams.get('key') === bindings.GOOGLE_GEOCODING_API_KEY;
    const weather = url.protocol === 'https:' && url.origin === 'https://weather.googleapis.com' && url.pathname === '/v1/forecast/days:lookup' && request.method === 'GET' && url.searchParams.get('key') === bindings.GOOGLE_WEATHER_API_KEY;
    const nearby = url.protocol === 'https:' && url.origin === 'https://places.googleapis.com' && url.pathname === '/v1/places:searchNearby' && request.method === 'POST' && request.headers.get('X-Goog-Api-Key') === bindings.GOOGLE_PLACES_API_KEY;
    if (url.username || url.password || !geocoding && !weather && !nearby) {
      deniedOutbound++;
      return Response.json({ error: 'Unrecognized outbound request denied by synthetic gate' }, { status: 502 });
    }
    providerCalls++;
    if (geocoding) return Response.json({ status: 'OK', results: [{ types: ['locality'], address_components: [{ long_name: 'Race City', types: ['locality'] }, { long_name: 'United States', short_name: 'US', types: ['country'] }], geometry: { location: { lat: 40, lng: -75 } } }] });
    const kind = weather ? 'weather' : 'nearby';
    if (nearby) {
      check(request.headers.get('X-Goog-FieldMask'), 'places.displayName,places.primaryTypeDisplayName,places.attributions', 'Places requests use the minimal field mask');
      const body = await request.json();
      check(body.locationRestriction.circle.center, { latitude: 40, longitude: -75 }, 'Places uses synthetic city coordinates');
      check(body.maxResultCount, 3);
    }
    const pending = hold;
    if (!pending || pending.kind !== kind) {
      deniedOutbound++;
      return Response.json({ error: 'Provider request has no matching test barrier' }, { status: 502 });
    }
    pending.requests++;
    pending.entered.resolve();
    await pending.release.promise;
    return Response.json(weather ? forecast : { places: [{ displayName: { text: PLACE_MARKER }, primaryTypeDisplayName: { text: 'Park' }, attributions: [] }] });
  }
  try {
    runtime = new Miniflare(convertV4MiniflareOptions({
      host: '127.0.0.1',
      port: 0,
      cf: false,
      log: new Log(LogLevel.ERROR),
      telemetry: { enabled: false },
      workers: [{
        name: 'isolated-provider-races',
        routes: [new URL(ORIGIN).hostname + '/*'],
        modulesRoot: ROOT,
        modules: [
          { type: 'ESModule', path: path.join(ROOT, 'race-entry.js'), contents: entryModule() },
          { type: 'ESModule', path: path.join(ROOT, 'bundle.js'), contents: bundle }
        ],
        compatibilityDate: '2026-10-09',
        compatibilityFlags: ['nodejs_compat'],
        bindings,
        durableObjects: { REGISTRY: { className: 'RaceRegistry', useSQLite: true }, HOMES: { className: 'RaceHome', useSQLite: true }, PILOT: { className: 'PilotState', useSQLite: true } },
        unsafeRegisterWorker: false,
        outboundService: outbound,
        serviceBindings: { ASSETS: () => new Response('No assets are served by this API-only gate', { status: 404 }) }
      }]
    }));
    const worker = await runtime.getWorker();
    async function request(route, body, headers = {}) {
      const response = await worker.fetch(ORIGIN + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Origin: ORIGIN, 'CF-Connecting-IP': '192.0.2.70', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual'
      });
      return { status: response.status, headers: response.headers, data: await response.json() };
    }
    async function fixtureRequest(body) {
      const response = await request('/__race/fixture', body);
      check(response.status, 200, 'Disposable fixture operation succeeded');
      return response.data;
    }
    const registry = {
      seedRecords: records => fixtureRequest({ operation: 'seed', records }),
      evidence: locationHomeId => fixtureRequest({ operation: 'evidence', locationHomeId })
    };
    async function fixture(kind) {
      const now = Date.now();
      const accountId = random(16);
      const homeId = random(24);
      const deviceId = random(24);
      const token = random(32);
      const sessionToken = random(32);
      const sessionId = hash(sessionToken);
      const csrf = random(32);
      const grantId = random(18);
      const home = {
        seedRecords: records => fixtureRequest({ operation: 'seed', homeId, records }),
        evidence: () => fixtureRequest({ operation: 'evidence', homeId })
      };
      await registry.seedRecords([
        ['account:' + accountId, { id: accountId, name: 'Synthetic race owner', credentialIds: ['synthetic-passkey'], recoveryHashes: [], authVersion: 1, status: 'active', createdAt: now }],
        ['session:' + accountId + ':' + sessionId, { accountId, sessionId, csrf, verifiedAt: now, createdAt: now, expiresAt: now + 3600000, authVersion: 1 }],
        ['account-homes:' + accountId, { homes: [homeId] }],
        ['device:' + deviceId, { id: deviceId, name: 'Synthetic race screen', homeId, ownerAccountId: accountId, state: 'owned', epoch: 1, tokenHash: hash(token), deviceToken: token }],
        ['device-token:' + hash(token), { id: deviceId }],
        ['provider:location:' + homeId, { address: 'Synthetic Race City, US', weather: kind === 'weather', nearby: kind === 'nearby', version: 1, savedAt: now }]
      ]);
      await home.seedRecords([
        ['home', { id: homeId, name: 'Synthetic race home', members: [{ accountId, name: 'Synthetic race owner', role: 'owner' }], screens: [{ id: deviceId, name: 'Synthetic race screen', epoch: 1, revision: 0, settings }], settings, createdAt: now }],
        ['grant:' + grantId, { id: grantId, accountId, clientId: random(32), label: 'Synthetic race grant', deviceIds: [deviceId], scopes: ['display:read'], expiresAt: now + 3600000 }]
      ]);
      const ownerHeaders = { Cookie: '__Host-displayos=' + accountId + '.' + sessionToken, 'X-DisplayOS-CSRF': csrf };
      const deviceHeaders = { Authorization: 'Bearer ' + token };
      const owner = (route, body) => request(route, body, ownerHeaders);
      const command = (name, input = {}) => owner('/api/v1/home', { homeId, command: name, input });
      const poll = () => request('/device/v1/poll', undefined, deviceHeaders);
      const initial = await bounded(poll(), 'Initial owned poll');
      check(initial.status, 200);
      check(initial.data.state, 'owned');
      check(initial.data.snapshot, null, 'Fixture has no personal family content');
      check(Object.hasOwn(initial.data, 'nonce'), false, 'Empty content has no receipt');
      return { accountId, homeId, deviceId, grantId, home, owner, command, poll, deviceHeaders };
    }
    async function mutation(state, action) {
      if (action === 'withdraw' || action === 'change') {
        const result = await bounded(state.owner('/api/v1/providers/location/save', { homeId: state.homeId, address: action === 'change' ? 'Changed Synthetic Race City, US' : 'Synthetic Race City, US', weather: action === 'change', nearby: action === 'change' }), action);
        check(result.status, 200, action + ' completes while Google is held');
      } else if (action === 'reset') {
        check((await bounded(state.owner('/api/v1/screens/reset', { homeId: state.homeId, deviceId: state.deviceId }), action)).status, 200);
      } else if (action === 'deleteHome') {
        check((await bounded(state.command('home.delete'), action)).status, 200);
      } else if (action === 'logout') {
        check((await bounded(state.owner('/auth/logout', {}), action)).status, 200);
      } else if (action === 'deleteAccount') {
        check((await bounded(state.owner('/auth/account/delete', {}), action)).status, 200);
      } else if (action === 'revoke') {
        check((await bounded(state.command('grant.revoke', { grantId: state.grantId }), action)).status, 200, 'Repeated revocation is idempotent');
      }
    }
    function inspectSuccess(result, audience, kind) {
      check(result.status, 200);
      check(result.headers.get('cache-control'), 'no-store');
      check(result.data.ephemeral, true);
      check(result.data.attribution, 'Google Maps');
      check(result.data.thirdPartyAttributions, []);
      check(result.data[kind].length, 1);
      check(result.data[kind][0][kind === 'weather' ? 'condition' : 'title'], kind === 'weather' ? WEATHER_MARKER : PLACE_MARKER);
      if (kind === 'weather') check(result.data.weatherSourceAttribution, 'Source: Includes weather data from Google');
      if (audience === 'device') check(result.data.localRevision, 1);
      for (const field of ['address', 'latitude', 'longitude', 'snapshot', 'nonce', 'deviceToken']) check(Object.hasOwn(result.data, field), false, 'Ephemeral data excludes ' + field);
    }
    for (const audience of ['device', 'owner']) {
      for (const kind of ['weather', 'nearby']) {
        for (const action of ['baseline', 'withdraw', 'change', 'reset', 'deleteHome', 'logout', 'deleteAccount', 'revoke']) {
          const label = audience + '/' + kind + '/' + action;
          const state = await fixture(kind);
          const startCalls = providerCalls;
          hold = { kind, entered: deferred(), release: deferred(), requests: 0 };
          let settled = false;
          const pending = (audience === 'device'
            ? request('/device/v1/local', undefined, state.deviceHeaders)
            : state.owner('/api/v1/providers/google/' + kind, { homeId: state.homeId })).then(result => { settled = true; return result; });
          pending.catch(() => {});
          try {
            await bounded(hold.entered.promise, label + ' provider entry');
            check(settled, false, label + ' response is actually pending');
            check((await bounded(state.poll(), label + ' concurrent poll')).status, 200, label + ' poll finishes before release');
            const stopped = await bounded(state.command('grant.revoke', { grantId: state.grantId }), label + ' concurrent grant revocation');
            check(stopped.status, 200);
            check(stopped.data.stopped, true);
            const current = await bounded(state.command('home.get'), label + ' revocation proof');
            check(current.status, 200);
            check(current.data.grants.length, 0, label + ' revocation committed before release');
            await mutation(state, action);
            check(settled, false, label + ' provider remains held after mutation');
          } finally { hold.release.resolve(); }
          const result = await bounded(pending, label + ' final response', 8000);
          const denied = ['withdraw', 'change', 'deleteHome', 'deleteAccount'].includes(action) || audience === 'device' && action === 'reset' || audience === 'owner' && action === 'logout';
          if (denied) {
            const allowed = action === 'logout' ? [401] : action === 'reset' ? [403] : [401, 403, 404, 409];
            requireTrue(allowed.includes(result.status), label + ' must deny stale authority, got ' + result.status);
            requireTrue(typeof result.data.error === 'string', label + ' returns a structured error');
            const body = JSON.stringify(result.data);
            requireTrue(!body.includes(WEATHER_MARKER) && !body.includes(PLACE_MARKER), label + ' never releases synthetic private output');
            for (const field of ['weather', 'nearby', 'cityLabel', 'snapshot', 'deviceToken']) check(Object.hasOwn(result.data, field), false);
          } else inspectSuccess(result, audience, kind);
          check(hold.requests, 1, label + ' delayed exactly one provider response');
          check(providerCalls - startCalls, 2, label + ' counts geocode and provider fetch separately');
          const stored = await bounded(state.home.evidence(), label + ' ephemeral storage proof');
          check(stored.contents, 0);
          check(stored.receipts, 0);
          const privateRecords = await bounded(registry.evidence(state.homeId), label + ' registry storage proof');
          check(privateRecords.budget.count, providerCalls, label + ' durable admission counted every synthetic fetch');
          if (['deleteHome', 'deleteAccount'].includes(action)) check(privateRecords.location, undefined, label + ' deletion removes private location');
          else {
            check(Object.keys(privateRecords.location).sort(), ['address', 'nearby', 'savedAt', 'version', 'weather'], label + ' location persists only owner inputs and version');
            const location = JSON.stringify(privateRecords.location);
            requireTrue(!location.includes(WEATHER_MARKER) && !location.includes(PLACE_MARKER), label + ' derived Google rows never enter registry location storage');
          }
          cases++;
          console.log('PASS ' + label + ': poll and revocation completed before synthetic Google release');
          hold = null;
        }
      }
    }
    const capped = await fixture('weather');
    await registry.seedRecords([['provider:google-budget', { day: new Date().toISOString().slice(0, 10), count: 298 }]]);
    hold = { kind: 'weather', entered: deferred(), release: deferred(), requests: 0 };
    hold.release.resolve();
    const beforeCap = providerCalls;
    inspectSuccess(await request('/device/v1/local', undefined, capped.deviceHeaders), 'device', 'weather');
    check(providerCalls - beforeCap, 2);
    check((await registry.evidence(capped.homeId)).budget.count, 300);
    const full = await request('/device/v1/local', undefined, capped.deviceHeaders);
    check(full.status, 429, 'Persistent cap denies before any further outbound request');
    check(providerCalls - beforeCap, 2, 'Cap exhaustion never invokes the synthetic provider');
    check((await capped.poll()).status, 200, 'Daily provider exhaustion leaves screen polling available');
    hold = null;
    check(deniedOutbound, 0, 'No unrecognized or unmatched outbound requests occurred');
    check(createHash('sha256').update(await readFile(BUNDLE, 'utf8')).digest('hex'), bundleSha256, 'Bundle stayed unchanged during this gate');
    const result = { checks, cases, providerCalls, deniedOutbound, bundleSha256, runtime: 'real Miniflare/workerd Durable Object scheduler', provider: 'synthetic fixed Google endpoints only', authority: 'test-only RPC-seeded encrypted fixtures, not WebAuthn or hardware proof', externalNetwork: false };
    console.log(JSON.stringify(result));
    return result;
  } finally {
    hold?.release.resolve();
    await runtime?.dispose();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) throw new Error('This isolated synthetic gate accepts no live origin, credentials or command-line options.');
  await verifyProductProviderRaces();
}
