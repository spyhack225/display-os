import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderAdapters } from '../src/product/providers.js';

const ACCOUNT = 'synthetic_owner';
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';
const INBOX_SCOPE = 'https://www.googleapis.com/auth/gmail.metadata';
const NOW = Date.parse('2026-10-10T12:00:00Z');
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });

function memoryStore() {
  const values = new Map();
  let queue = Promise.resolve();
  const operations = map => ({ get: async key => structuredClone(map.get(key)), put: async (key, value) => { map.set(key, structuredClone(value)); }, delete: async key => { map.delete(key); }, list: async (prefix, limit) => new Map([...map].filter(([key]) => key.startsWith(prefix)).slice(0, limit)) });
  const store = operations(values);
  store.transaction = async callback => {
    const pending = queue.then(async () => {
      const copy = structuredClone(values);
      const result = await callback(operations(copy));
      values.clear(); for (const [key, value] of copy) values.set(key, value);
      return result;
    });
    queue = pending.catch(() => {});
    return pending;
  };
  return store;
}

function fixture(overrides = {}) {
  let now = NOW;
  const store = memoryStore();
  const calls = [];
  let response = async url => {
    if (url.pathname === '/token') return json({ access_token: 'synthetic_access_token', refresh_token: 'synthetic_refresh_token', expires_in: 3600, token_type: 'Bearer', scope: CALENDAR_SCOPE });
    if (url.pathname === '/revoke') return new Response(null, { status: 200 });
    if (url.pathname.endsWith('/events')) return json({ items: [] });
    if (url.pathname.endsWith('/messages')) return json({ messages: [] });
    return json({ daily: { time: ['2026-10-10'], temperature_2m_max: [20], temperature_2m_min: [10], weather_code: [0] } });
  };
  const env = { GOOGLE_CLIENT_ID: 'synthetic-client-id', GOOGLE_CLIENT_SECRET: 'synthetic-client-secret', OPEN_METEO_NONCOMMERCIAL_DEMO: 'true', ...overrides };
  const adapters = createProviderAdapters({ env, store, origin: 'https://displayos.example.com', now: () => now, fetch: async (url, options) => { const parsed = new URL(url); calls.push({ url: parsed, options }); assert.equal(options.redirect, 'manual'); return response(parsed, options); } });
  async function connect(input = { calendar: true, inbox: false, calendarIds: ['primary'] }, id = ACCOUNT) {
    const begin = await adapters.beginGoogle(id, input);
    const state = new URL(begin.url).searchParams.get('state');
    return adapters.finishGoogle(id, { state, code: 'synthetic_google_code' });
  }
  return { adapters, calls, store, env, connect, setResponse: callback => { response = callback; }, advance: milliseconds => { now += milliseconds; } };
}

test('unconfigured Google fails honestly without network or claiming connection', async () => {
  const value = fixture({ GOOGLE_CLIENT_SECRET: '' });
  assert.equal((await value.adapters.status(ACCOUNT)).connected, false);
  await assert.rejects(value.connect(), error => error.status === 503);
  assert.equal(value.calls.length, 0);
});

test('OAuth fixes endpoints, selected read-only scopes, return address, PKCE and state', async () => {
  const value = fixture();
  const result = await value.adapters.beginGoogle(ACCOUNT, { calendar: true, inbox: false, calendarIds: ['primary'] });
  const url = new URL(result.url);
  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('scope'), CALENDAR_SCOPE);
  assert.equal(url.searchParams.get('redirect_uri'), 'https://displayos.example.com/api/v1/providers/google/callback');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('include_granted_scopes'), 'false');
  assert.match(url.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(result.url.includes('synthetic-client-secret'), false);
  for (const input of [{ calendar: true, inbox: false }, { calendar: true, inbox: false, calendarIds: ['primary'], redirectUri: 'https://evil.example.com' }, { calendar: true, inbox: false, calendarIds: ['https://evil.example.com'] }, { calendar: false, inbox: false }, { calendar: true, inbox: false, calendarIds: ['..'] }]) await assert.rejects(value.adapters.beginGoogle(ACCOUNT, input));
});

test('OAuth states expire, cannot cross accounts, replay or overfill pending challenges', async () => {
  const value = fixture();
  const begin = await value.adapters.beginGoogle(ACCOUNT, { calendar: true, inbox: false, calendarIds: ['primary'] });
  const state = new URL(begin.url).searchParams.get('state');
  await assert.rejects(value.adapters.finishGoogle('another_owner', { state, code: 'synthetic_code' }), error => error.status === 403);
  await value.adapters.finishGoogle(ACCOUNT, { state, code: 'synthetic_code' });
  await assert.rejects(value.adapters.finishGoogle(ACCOUNT, { state, code: 'synthetic_code' }));
  const expired = await value.adapters.beginGoogle(ACCOUNT, { calendar: true, inbox: false, calendarIds: ['primary'] });
  value.advance(300001);
  await assert.rejects(value.adapters.finishGoogle(ACCOUNT, { state: new URL(expired.url).searchParams.get('state'), code: 'synthetic_code' }));
  for (let index = 0; index < 4; index++) await value.adapters.beginGoogle(ACCOUNT, { calendar: true, inbox: false, calendarIds: ['primary'] });
  await assert.rejects(value.adapters.beginGoogle(ACCOUNT, { calendar: true, inbox: false, calendarIds: ['primary'] }), error => error.status === 429);
});

test('successful OAuth stores tokens only in the vault and display sharing remains off', async () => {
  const value = fixture();
  const result = await value.connect();
  assert.equal(result.connected, true);
  assert.deepEqual(result.sharing, { calendar: false, inbox: false });
  assert.equal(JSON.stringify(result).includes('synthetic_access_token'), false);
  assert.equal(JSON.stringify(result).includes('synthetic_refresh_token'), false);
  const request = value.calls.find(call => call.url.pathname === '/token');
  const body = new URLSearchParams(request.options.body);
  assert.equal(body.get('client_secret'), 'synthetic-client-secret');
  assert.match(body.get('code_verifier'), /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await value.store.get('provider:vault:' + ACCOUNT)).accessToken, 'synthetic_access_token');
});

test('scope expansion, missing refresh and malformed tokens cannot produce connected success', async () => {
  for (const changes of [{ scope: CALENDAR_SCOPE + ' https://www.googleapis.com/auth/gmail.modify' }, { scope: '' }, { refresh_token: undefined }, { scope: undefined }, { expires_in: Infinity }, { access_token: 'bad' }]) {
    const value = fixture();
    value.setResponse(async () => json({ access_token: 'synthetic_access_token', refresh_token: 'synthetic_refresh_token', expires_in: 3600, token_type: 'Bearer', scope: CALENDAR_SCOPE, ...changes }));
    await assert.rejects(value.connect());
    assert.equal((await value.adapters.status(ACCOUNT)).connected, false);
  }
});

test('selected calendars return seven bounded days in chosen timezone without descriptions or publishing', async () => {
  const value = fixture(); await value.connect();
  value.setResponse(async () => json({ items: [{ summary: '<b>School concert</b> https://private.example.com', start: { dateTime: '2026-10-10T20:00:00Z' }, description: 'PRIVATE BODY' }, { summary: 'Dinner', start: { date: '2026-10-10' } }, { summary: 'Extra event', start: { dateTime: '2026-10-10T21:00:00Z' } }] }));
  const result = await value.adapters.calendar(ACCOUNT, { timezone: 'America/New_York', calendarIds: ['primary'] });
  assert.equal(result.week.length, 7);
  assert.equal(result.week[0].events.length, 2);
  assert.equal(result.week[0].events.find(event => event.title.startsWith('School')).time, '16:00');
  assert.equal(JSON.stringify(result).includes('PRIVATE BODY'), false);
  assert.equal(JSON.stringify(result).includes('private.example'), false);
  assert.equal(result.sharingAllowed, false);
  await assert.rejects(value.adapters.calendar(ACCOUNT, { timezone: 'UTC', calendarIds: ['unapproved@example.com'] }), error => error.status === 403);
  assert.equal(value.calls.at(-1).url.origin, 'https://www.googleapis.com');
  assert.equal(value.calls.at(-1).url.searchParams.get('fields'), 'items(summary,start,status)');
});

test('inbox requires separate opt-in and only reads metadata subject headers, never raw bodies', async () => {
  const value = fixture(); await value.connect();
  const before = value.calls.length;
  await assert.rejects(value.adapters.inbox(ACCOUNT), error => error.status === 403);
  assert.equal(value.calls.length, before);
  value.setResponse(async url => url.pathname === '/token' ? json({ access_token: 'synthetic_access_token', refresh_token: 'synthetic_refresh_token', expires_in: 3600, token_type: 'Bearer', scope: INBOX_SCOPE }) : url.pathname.endsWith('/messages') ? json({ messages: [{ id: 'message1' }] }) : json({ payload: { headers: [{ name: 'Subject', value: '<b>Lunch reminder</b>' }], body: { data: 'PRIVATE_EMAIL_BODY' } }, snippet: 'PRIVATE_SNIPPET' }));
  await value.connect({ calendar: false, inbox: true });
  const result = await value.adapters.inbox(ACCOUNT);
  assert.deepEqual(result.reminders, [{ title: 'Lunch reminder', time: 'Inbox', person: 'You' }]);
  assert.equal(result.sharingAllowed, false);
  assert.equal(JSON.stringify(result).includes('PRIVATE'), false);
  const request = value.calls.at(-1).url;
  assert.equal(request.origin, 'https://gmail.googleapis.com');
  assert.equal(request.searchParams.get('format'), 'metadata');
  assert.equal(request.searchParams.get('metadataHeaders'), 'Subject');
  assert.equal(request.searchParams.get('fields'), 'payload(headers)');
  assert.equal(value.calls.find(call => call.url.pathname.endsWith('/messages')).url.searchParams.has('q'), false);
});

test('display sharing is a separate persisted choice and cannot expand provider scopes', async () => {
  const value = fixture(); await value.connect();
  await assert.rejects(value.adapters.setSharing(ACCOUNT, { calendar: true, inbox: true }), error => error.status === 403);
  const status = await value.adapters.setSharing(ACCOUNT, { calendar: true, inbox: false });
  assert.deepEqual(status.sharing, { calendar: true, inbox: false });
  assert.equal((await value.adapters.calendar(ACCOUNT, { timezone: 'UTC' })).sharingAllowed, true);
  assert.equal((await value.adapters.status('another_owner')).connected, false);
});

test('expired access tokens refresh server-side without changing sharing or selected calendars', async () => {
  const value = fixture(); await value.connect();
  await value.adapters.setSharing(ACCOUNT, { calendar: true, inbox: false });
  value.advance(3600000);
  value.setResponse(async (url, options) => {
    if (url.pathname !== '/token') return json({ items: [] });
    const body = new URLSearchParams(options.body);
    assert.equal(body.get('grant_type'), 'refresh_token');
    assert.equal(body.get('refresh_token'), 'synthetic_refresh_token');
    return json({ access_token: 'synthetic_new_access_token', expires_in: 3600, token_type: 'Bearer' });
  });
  assert.equal((await value.adapters.calendar(ACCOUNT, { timezone: 'UTC' })).sharingAllowed, true);
  assert.equal(value.calls.at(-1).options.headers.Authorization, 'Bearer synthetic_new_access_token');
});

test('disconnect cannot be undone by an in-flight callback or refresh and provider revoke errors are honest', async () => {
  const value = fixture();
  const begin = await value.adapters.beginGoogle(ACCOUNT, { calendar: true, inbox: false, calendarIds: ['primary'] });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  let release;
  value.setResponse(async () => { entered(); await new Promise(resolve => { release = resolve; }); return json({ access_token: 'synthetic_access_token', refresh_token: 'synthetic_refresh_token', expires_in: 3600, token_type: 'Bearer', scope: CALENDAR_SCOPE }); });
  const finishing = value.adapters.finishGoogle(ACCOUNT, { code: 'synthetic_code', state: new URL(begin.url).searchParams.get('state') });
  await started;
  await value.adapters.disconnect(ACCOUNT);
  release();
  await assert.rejects(finishing, error => error.status === 409);
  assert.equal((await value.adapters.status(ACCOUNT)).connected, false);
  const other = fixture(); await other.connect();
  other.advance(3600000);
  let refreshEntered;
  const refreshing = new Promise(resolve => { refreshEntered = resolve; });
  let finishRefresh;
  other.setResponse(async url => {
    if (url.pathname === '/revoke') throw new Error('offline');
    refreshEntered(); await new Promise(resolve => { finishRefresh = resolve; });
    return json({ access_token: 'synthetic_new_access_token', expires_in: 3600, token_type: 'Bearer' });
  });
  const calendar = other.adapters.calendar(ACCOUNT, { timezone: 'UTC' });
  await refreshing;
  assert.deepEqual(await other.adapters.disconnect(ACCOUNT), { disconnected: true, revokedAtProvider: false });
  finishRefresh();
  await assert.rejects(calendar, error => error.status === 409);
  assert.equal((await other.adapters.status(ACCOUNT)).connected, false);
});

test('redirects, excessive responses and malformed provider payloads fail closed', async () => {
  const value = fixture(); await value.connect();
  for (const response of [new Response(null, { status: 302, headers: { Location: 'https://evil.example.com' } }), new Response(JSON.stringify({ items: [] }), { headers: { 'Content-Type': 'application/json', 'Content-Length': '999999' } }), json({ items: [null] }), json({ items: Array(101).fill({}) }), json({ items: [{ start: { dateTime: 'not a date' } }] }), json({ items: [], unused: 'x'.repeat(270000) })]) {
    value.setResponse(async () => response);
    await assert.rejects(value.adapters.calendar(ACCOUNT, { timezone: 'UTC' }), error => error.status === 502);
  }
});

test('weather needs location consent and an explicit noncommercial demo or commercial configuration', async () => {
  const value = fixture({ OPEN_METEO_NONCOMMERCIAL_DEMO: undefined });
  const input = { latitude: 40.7, longitude: -74, timezone: 'America/New_York', consent: true };
  await assert.rejects(value.adapters.weather(input), error => error.status === 503);
  assert.equal(value.calls.length, 0);
  const demo = fixture();
  for (const changes of [{ consent: false }, { latitude: 91 }, { longitude: Infinity }, { url: 'https://evil.example.com' }, { timezone: 'Invalid/Zone' }]) await assert.rejects(demo.adapters.weather({ ...input, ...changes }));
  assert.equal(demo.calls.length, 0);
  const result = await demo.adapters.weather(input);
  assert.deepEqual(result.weather, [{ date: '2026-10-10', label: 'Sat', high: 20, low: 10, condition: 'Clear' }]);
  assert.equal(demo.calls[0].url.origin, 'https://api.open-meteo.com');
  assert.equal(demo.calls[0].url.searchParams.get('forecast_days'), '7');
  assert.equal(result.attribution, 'Weather data by Open-Meteo');
  const commercial = fixture({ OPEN_METEO_API_KEY: 'synthetic_weather_key' });
  await commercial.adapters.weather(input);
  assert.equal(commercial.calls[0].url.origin, 'https://customer-api.open-meteo.com');
  assert.equal(commercial.calls[0].url.searchParams.get('apikey'), 'synthetic_weather_key');
});

test('weather rejects invalid arrays, duplicate dates, temperatures and unknown conditions', async () => {
  const value = fixture();
  for (const daily of [{ time: ['2026-02-30'], temperature_2m_max: [20], temperature_2m_min: [10], weather_code: [0] }, { time: ['2026-10-10'], temperature_2m_max: [null], temperature_2m_min: [10], weather_code: [0] }, { time: ['2026-10-10'], temperature_2m_max: [20], temperature_2m_min: [10], weather_code: [999] }, { time: ['2026-10-10', '2026-10-10'], temperature_2m_max: [20, 20], temperature_2m_min: [10, 10], weather_code: [0, 0] }, { time: ['2026-10-10'], temperature_2m_max: [], temperature_2m_min: [10], weather_code: [0] }]) {
    value.setResponse(async () => json({ daily }));
    await assert.rejects(value.adapters.weather({ latitude: 40, longitude: -70, timezone: 'UTC', consent: true }), error => error.status === 502);
  }
});

const LOCAL_ENV = { GOOGLE_GEOCODING_API_KEY: 'synthetic_geocode', GOOGLE_WEATHER_API_KEY: 'synthetic_weather', GOOGLE_PLACES_API_KEY: 'synthetic_places' };
const CITY = { status: 'OK', results: [{ types: ['locality', 'political'], address_components: [{ long_name: 'Boston', types: ['locality'] }, { long_name: 'Massachusetts', types: ['administrative_area_level_1'] }, { short_name: 'US', types: ['country'] }], geometry: { location: { lat: 42.36, lng: -71.06 } } }] };
const FORECAST = { forecastDays: [{ displayDate: { year: 2026, month: 10, day: 10 }, maxTemperature: { degrees: 20, unit: 'CELSIUS' }, minTemperature: { degrees: 10, unit: 'CELSIUS' }, daytimeForecast: { weatherCondition: { description: { text: 'Clear' } } } }] };

function localFixture() {
  const value = fixture(LOCAL_ENV);
  value.setResponse(async url => json(url.hostname === 'maps.googleapis.com' ? CITY : url.hostname === 'weather.googleapis.com' ? FORECAST : { places: [{ displayName: { text: 'City park' }, primaryTypeDisplayName: { text: 'Park' }, attributions: [] }] }));
  return value;
}

test('home location saves privately without keys, isolates homes and increments version on every save and clear', async () => {
  const value = fixture();
  assert.deepEqual(await value.adapters.location('home_a'), { version: 0, location: null, geocodingAvailable: false, weatherAvailable: false, nearbyAvailable: false });
  for (const expected of [1, 2]) assert.equal((await value.adapters.saveLocation('home_a', { address: '10 Private Road, Boston', weather: true, nearby: true })).version, expected);
  assert.equal((await value.adapters.location('home_b')).location, null);
  await assert.rejects(value.adapters.googleWeather('home_a', 'UTC'), error => error.status === 503);
  assert.equal((await value.adapters.saveLocation('home_a', { address: '', weather: false, nearby: false })).version, 3);
  assert.equal((await value.adapters.location('home_a')).location, null);
  assert.equal(value.calls.length, 0);
  for (const input of [{ address: 'x'.repeat(241), weather: false, nearby: false }, { address: '<b>Boston</b>', weather: true, nearby: true }, { address: 'https://evil.example', weather: true, nearby: true }, { address: '', weather: true, nearby: false }, { address: 'Boston', weather: 'true', nearby: true }, { address: 'Boston', weather: true, nearby: true, url: 'anything' }]) await assert.rejects(value.adapters.saveLocation('home_a', input), error => error.status === 400);
});

test('Google uses city coordinates, fixed minimal endpoints, transient bounded results and no derived storage', async () => {
  const value = localFixture();
  await value.adapters.saveLocation('home_a', { address: '10 Private Road, Boston', weather: true, nearby: true });
  value.setResponse(async url => {
    if (url.hostname === 'maps.googleapis.com') {
      const result = structuredClone(CITY);
      if (url.searchParams.get('address').startsWith('10 ')) { result.results[0].types = ['street_address']; result.results[0].geometry.location = { lat: 42.111, lng: -71.111 }; }
      return json(result);
    }
    return json(url.hostname === 'weather.googleapis.com' ? FORECAST : { places: [{ displayName: { text: '<b>City park</b>' }, attributions: [] }] });
  });
  const weather = await value.adapters.googleWeather('home_a', 'America/New_York');
  const nearby = await value.adapters.nearby('home_a');
  assert.equal(weather.expiresAt - weather.fetchedAt, 3600000);
  assert.equal(weather.locationVersion, 1);
  assert.equal(weather.weatherSourceAttribution, 'Source: Includes weather data from Google');
  assert.equal(weather.attribution, 'Google Maps');
  assert.equal(nearby.nearby[0].title, 'City park');
  assert.equal(JSON.stringify([weather, nearby]).includes('Private Road'), false);
  assert.equal(JSON.stringify([weather, nearby]).includes('latitude'), false);
  const request = value.calls.find(call => call.url.hostname === 'weather.googleapis.com').url;
  assert.equal(request.searchParams.get('location.latitude'), '42.36');
  assert.equal(request.searchParams.get('days'), '7');
  assert.equal(request.searchParams.get('pageSize'), '7');
  const places = value.calls.find(call => call.url.hostname === 'places.googleapis.com');
  assert.equal(places.options.headers['X-Goog-FieldMask'], 'places.displayName,places.primaryTypeDisplayName,places.attributions');
  assert.equal(JSON.parse(places.options.body).locationRestriction.circle.center.latitude, 42.36);
  const records = await value.store.list('provider:', 20);
  assert.deepEqual([...records.keys()].sort(), ['provider:google-budget', 'provider:location:home_a']);
  assert.equal(JSON.stringify([...records.values()]).includes('City park'), false);
  assert.equal((await value.store.get('provider:google-budget')).count, 6);
});

test('Google local rejects missing consent, ambiguity, malformed forecasts and unsupported attribution', async () => {
  const value = localFixture();
  await value.adapters.saveLocation('home_a', { address: 'Boston, US', weather: false, nearby: false });
  await assert.rejects(value.adapters.nearby('home_a'), error => error.status === 403);
  assert.equal(value.calls.length, 0);
  await value.adapters.saveLocation('home_a', { address: 'Boston, US', weather: true, nearby: true });
  for (const forecast of [{ forecastDays: [] }, { forecastDays: [null] }, { forecastDays: [{ ...FORECAST.forecastDays[0], displayDate: { year: 2026, month: 2, day: 30 } }] }, { forecastDays: [{ ...FORECAST.forecastDays[0], daytimeForecast: { weatherCondition: { description: { text: '<b></b>' } } } }] }]) {
    value.setResponse(async url => json(url.hostname === 'maps.googleapis.com' ? CITY : forecast));
    await assert.rejects(value.adapters.googleWeather('home_a', 'UTC'), error => error.status === 502);
  }
  value.setResponse(async url => json(url.hostname === 'maps.googleapis.com' ? CITY : { places: [{ displayName: { text: 'Park' }, attributions: [{ provider: 'Provider', providerUri: 'https://outside.example' }] }] }));
  await assert.rejects(value.adapters.nearby('home_a'), error => error.status === 503);
  value.setResponse(async () => json({ status: 'OK', results: [CITY.results[0], CITY.results[0]] }));
  await assert.rejects(value.adapters.nearby('home_a'), error => error.status === 400);
});

test('changed location or withdrawn consent prevents late Google data from returning', async () => {
  const value = localFixture();
  await value.adapters.saveLocation('home_a', { address: 'Boston', weather: true, nearby: true });
  let entered;
  let release;
  const started = new Promise(resolve => { entered = resolve; });
  value.setResponse(async url => {
    if (url.hostname === 'maps.googleapis.com') return json(CITY);
    entered(); await new Promise(resolve => { release = resolve; }); return json(FORECAST);
  });
  const pending = value.adapters.googleWeather('home_a', 'UTC');
  await started;
  await value.adapters.saveLocation('home_a', { address: '', weather: false, nearby: false });
  release();
  await assert.rejects(pending, error => error.status === 409);
});

test('Google request budget is durable, atomic across adapters and counts failures before actual network', async () => {
  const value = localFixture();
  await value.adapters.saveLocation('home_a', { address: 'Boston', weather: true, nearby: true });
  await value.store.put('provider:google-budget', { day: '2026-10-10', count: 298 });
  const restarted = createProviderAdapters({ env: LOCAL_ENV, store: value.store, origin: 'https://displayos.example.com', now: () => NOW, fetch: async () => { throw new Error('network failed'); } });
  const attempts = await Promise.allSettled([restarted.nearby('home_a'), value.adapters.nearby('home_a'), value.adapters.googleWeather('home_a', 'UTC')]);
  assert.equal((await value.store.get('provider:google-budget')).count, 300);
  assert.equal(attempts.every(result => result.status === 'rejected'), true);
  assert.equal(attempts.some(result => result.reason.status === 429), true);
  assert.equal(value.calls.length, 1);
  await assert.rejects(restarted.nearby('home_a'), error => error.status === 429);
  value.advance(86400000);
  await value.adapters.nearby('home_a');
  assert.deepEqual(await value.store.get('provider:google-budget'), { day: '2026-10-11', count: 2 });
});

test('future or corrupt Google budget fails closed without network or resetting on clock rollback', async () => {
  const value = localFixture();
  await value.adapters.saveLocation('home_a', { address: 'Boston', weather: true, nearby: true });
  for (const budget of [{ day: '2026-10-11', count: 1 }, { day: '2026-10-10', count: -1 }, { day: 'bad', count: 2 }]) {
    await value.store.put('provider:google-budget', budget);
    await assert.rejects(value.adapters.nearby('home_a'), error => error.status === 503);
    assert.deepEqual(await value.store.get('provider:google-budget'), budget);
  }
  assert.equal(value.calls.length, 0);
});
