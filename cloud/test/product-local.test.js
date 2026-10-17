import test from 'node:test';
import assert from 'node:assert/strict';
import { localMetadata, loadLocal } from '../src/product/local.js';

const NOW = Date.parse('2026-10-10T06:00:00Z');

function fixture() {
  const device = { id: 'screen', homeId: 'home', epoch: 3, state: 'owned', tokenHash: 'verified' };
  let latest = structuredClone(device);
  let source = { version: 2, location: { address: 'Private street address', weather: true, nearby: true }, weatherAvailable: true, nearbyAvailable: true };
  let attached = true;
  const calls = [];
  const data = () => ({ available: true, locationVersion: source.version, cityLabel: 'Chosen city', attribution: 'Google Maps', thirdPartyAttributions: [], expiresAt: NOW + 3600000, ephemeral: true });
  const adapter = {
    async location(homeId) { calls.push(['location', homeId]); return structuredClone(source); },
    async googleWeather(homeId, timezone) { calls.push(['weather', homeId, timezone]); return { ...data(), weatherSourceAttribution: 'Source: Includes weather data from Google', weather: [{ date: '2026-10-10', label: 'Sat', low: 10, high: 20, condition: 'Sunny' }] }; },
    async nearby(homeId) { calls.push(['nearby', homeId]); return { ...data(), nearby: [{ title: 'City park', when: 'Park' }] }; }
  };
  const store = { async get(key) { assert.equal(key, 'device:screen'); return structuredClone(latest); }, async put() { assert.fail('Ephemeral local output must not be persisted'); } };
  const homeCall = async (homeId, principal, command) => {
    assert.equal(homeId, 'home'); assert.deepEqual(principal, { system: true }); assert.equal(command, 'home.get');
    return { settings: { timezone: 'America/New_York' }, screens: attached ? [{ id: 'screen', epoch: 3 }] : [] };
  };
  return {
    adapter, calls, load: () => loadLocal({ device, store, adapter, homeCall, finalize: callback => callback(), now: () => NOW }),
    updateDevice: patch => { latest = { ...latest, ...patch }; },
    updateSource: patch => { source = { ...source, ...patch }; }, detach: () => { attached = false; }
  };
}

test('local metadata shares consent and version but never an address or coordinates', async () => {
  const state = fixture();
  assert.deepEqual(await localMetadata(state.adapter, 'home'), { localRevision: 2, localEnabled: { weather: true, nearby: true } });
});

test('configured Google local information stays ephemeral and does not become family content or a receipt', async () => {
  const state = fixture(); const result = await state.load();
  assert.equal(result.ephemeral, true); assert.equal(result.localRevision, 2); assert.equal(result.weather.length, 1); assert.equal(result.nearby.length, 1);
  assert.equal(result.attribution, 'Google Maps');
  for (const field of ['address', 'latitude', 'longitude', 'snapshot', 'revision', 'nonce', 'deviceToken']) assert.equal(Object.hasOwn(result, field), false);
  assert.equal(JSON.stringify(result).includes('Private street address'), false);
});

test('missing Google configuration does not perform provider requests', async () => {
  const state = fixture(); state.updateSource({ weatherAvailable: false, nearbyAvailable: false });
  assert.deepEqual(await state.load(), { available: false, localRevision: 2, localEnabled: { weather: false, nearby: false } });
  assert.equal(state.calls.some(call => call[0] === 'weather' || call[0] === 'nearby'), false);
});

test('disabled sharing does not perform provider requests', async () => {
  const state = fixture(); state.updateSource({ location: { address: 'Private street address', weather: false, nearby: false } });
  assert.equal((await state.load()).available, false);
  assert.equal(state.calls.some(call => call[0] === 'weather' || call[0] === 'nearby'), false);
});

for (const patch of [{ state: 'erase' }, { homeId: 'different-home' }, { epoch: 4 }, { tokenHash: 'rotated' }]) {
  test('local information denies stale device authority ' + Object.keys(patch)[0], async () => {
    const state = fixture(); state.updateDevice(patch);
    await assert.rejects(state.load(), { status: 403 });
    assert.equal(state.calls.length, 0);
  });
}

test('local information requires current household attachment', async () => {
  const state = fixture(); state.detach(); await assert.rejects(state.load(), { status: 403 }); assert.equal(state.calls.length, 0);
});

test('reset during a provider request denies its eventual output', async () => {
  const state = fixture(); const original = state.adapter.googleWeather;
  state.adapter.googleWeather = async (...args) => { const result = await original(...args); state.updateDevice({ state: 'erase', epoch: 4 }); return result; };
  await assert.rejects(state.load(), { status: 403 });
});

test('location or sharing changes during lookup deny stale output', async () => {
  const state = fixture(); const original = state.adapter.nearby;
  state.adapter.nearby = async (...args) => { const result = await original(...args); state.updateSource({ version: 3 }); return result; };
  await assert.rejects(state.load(), { status: 409 });
});

test('one unavailable provider does not invent output or suppress the successful provider', async () => {
  const state = fixture(); state.adapter.nearby = async () => { throw Object.assign(new Error('Unavailable'), { status: 503 }); };
  const result = await state.load(); assert.equal(result.weather.length, 1); assert.deepEqual(result.nearby, []);
});

test('all failed sources return failure rather than example information', async () => {
  const state = fixture(); const failed = async () => { throw Object.assign(new Error('Unavailable'), { status: 503 }); };
  state.adapter.nearby = failed; state.adapter.googleWeather = failed;
  await assert.rejects(state.load(), { status: 503 });
});

for (const patch of [{ expiresAt: NOW }, { expiresAt: NOW + 3600001 }, { ephemeral: false }, { locationVersion: 1 }, { attribution: 'Unknown' }, { thirdPartyAttributions: ['Unsupported link'] }]) {
  test('local output fails closed on unsupported ' + Object.keys(patch)[0], async () => {
    const state = fixture(); const original = state.adapter.googleWeather;
    state.adapter.googleWeather = async (...args) => ({ ...await original(...args), ...patch });
    await assert.rejects(state.load(), { status: 502 });
  });
}
