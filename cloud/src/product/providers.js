import { reject, exact, random, digest } from './common.js';

const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';
const INBOX_SCOPE = 'https://www.googleapis.com/auth/gmail.metadata';
const DAY = 86400000;

function account(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(value)) reject(400, 'Choose a supported account.');
  return value;
}

function timezone(value) {
  if (typeof value !== 'string' || value.length > 80) reject(400, 'Choose a valid time zone.');
  try { new Intl.DateTimeFormat('en', { timeZone: value }).format(0); }
  catch { reject(400, 'Choose a valid time zone.'); }
  return value;
}

function safeTitle(value, fallback = 'A calendar plan') {
  if (typeof value !== 'string') return fallback;
  const cleaned = value.slice(0, 4096).replace(/<[^>]*>|[<>\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/(?:https?:\/\/|www\.)\S+|(?:javascript|data|file):\S*|&(?:lt|gt|#0*60|#0*62|#x0*3[ce]);/gi, '').replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 80) || fallback;
}

function localDate(timestamp, zone) {
  const values = new Intl.DateTimeFormat('en', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(timestamp);
  const part = name => values.find(value => value.type === name).value;
  return part('year') + '-' + part('month') + '-' + part('day');
}

function calendarIds(value) {
  if (!Array.isArray(value) || !value.length || value.length > 3 || value.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_.@+-]{1,160}$/.test(id) || ['.', '..'].includes(id)) || new Set(value).size !== value.length) reject(400, 'Choose up to three calendars yourself.');
  return [...value];
}

function validateTokens(value, scopes, requireRefresh) {
  if (!value || typeof value.access_token !== 'string' || value.access_token.length < 16 || value.access_token.length > 4096 || /\s/.test(value.access_token) || !Number.isInteger(value.expires_in) || value.expires_in < 1 || value.expires_in > 86400 || value.token_type?.toLowerCase() !== 'bearer') reject(502, 'Google did not return a usable connection.');
  if (value.scope !== undefined) {
    const granted = typeof value.scope === 'string' ? value.scope.split(' ').filter(Boolean) : [];
    if (scopes.some(scope => !granted.includes(scope)) || granted.some(scope => !scopes.includes(scope))) reject(403, 'Google permissions did not match your choices.');
  } else if (requireRefresh) reject(403, 'Google did not confirm your chosen permissions.');
  if ((requireRefresh && typeof value.refresh_token !== 'string') || (value.refresh_token !== undefined && (typeof value.refresh_token !== 'string' || value.refresh_token.length < 16 || value.refresh_token.length > 4096 || /\s/.test(value.refresh_token)))) reject(502, 'Please reconnect Google and allow access again.');
  return value;
}

const CONDITIONS = { 0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Cloudy', 45: 'Fog', 48: 'Freezing fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain', 71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Rain showers', 81: 'Rain showers', 82: 'Heavy showers', 85: 'Snow showers', 86: 'Snow showers', 95: 'Thunderstorms', 96: 'Thunderstorms with hail', 99: 'Thunderstorms with hail' };

export function createProviderAdapters({ env = {}, store, fetch: fetcher = globalThis.fetch, now = () => Date.now(), origin }) {
  const parsedOrigin = new URL(origin);
  if (parsedOrigin.protocol !== 'https:' || parsedOrigin.origin !== origin) throw new Error('Providers require an exact HTTPS origin.');
  const callback = origin + '/api/v1/providers/google/callback';
  const configured = () => typeof env.GOOGLE_CLIENT_ID === 'string' && !!env.GOOGLE_CLIENT_ID && typeof env.GOOGLE_CLIENT_SECRET === 'string' && !!env.GOOGLE_CLIENT_SECRET;
  const vaultKey = id => 'provider:vault:' + account(id);
  const epochKey = id => 'provider:epoch:' + account(id);
  const challengePrefix = id => 'provider:challenge:' + account(id) + ':';
  const locationKey = id => 'provider:location:' + account(id);
  const googleCapabilities = () => ({ geocodingAvailable: Boolean(env.GOOGLE_GEOCODING_API_KEY), weatherAvailable: Boolean(env.GOOGLE_GEOCODING_API_KEY && env.GOOGLE_WEATHER_API_KEY), nearbyAvailable: Boolean(env.GOOGLE_GEOCODING_API_KEY && env.GOOGLE_PLACES_API_KEY) });

  function needConfiguration() {
    if (!configured()) reject(503, 'Google connection is not available yet. Your assistant can still share plans you approve.');
  }

  async function remote(url, options = {}, maxBytes = 262144) {
    const endpoint = new URL(url);
    if (['maps.googleapis.com', 'weather.googleapis.com', 'places.googleapis.com'].includes(endpoint.hostname)) {
      await store.transaction(async transaction => {
        const key = 'provider:google-budget';
        const day = new Date(now()).toISOString().slice(0, 10);
        const record = await transaction.get(key);
        if (record && (typeof record.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(record.day) || !Number.isSafeInteger(record.count) || record.count < 0 || record.count > 300 || record.day > day)) reject(503, 'Google information is temporarily unavailable.');
        const count = record && record.day === day ? record.count : 0;
        if (count >= 300) reject(429, 'Today\'s Google information limit has been reached. Please try again tomorrow.');
        await transaction.put(key, { day, count: count + 1 });
      });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let reader;
    try {
      const response = await fetcher(url, { ...options, redirect: 'manual', signal: controller.signal });
      if (!response.ok || response.status >= 300 || Number(response.headers.get('content-length')) > maxBytes) reject(502, 'The provider could not be reached. Please try again.');
      if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json') || !response.body) reject(502, 'The provider returned unsupported information.');
      reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > maxBytes) reject(502, 'The provider returned too much information.');
        chunks.push(part.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (!value || typeof value !== 'object' || Array.isArray(value)) reject(502, 'The provider returned unsupported information.');
      return value;
    } catch (error) {
      if (error?.status) throw error;
      reject(502, 'The provider could not be reached. Please try again.');
    } finally { clearTimeout(timeout); if (reader) await reader.cancel().catch(() => {}); }
  }

  async function tokenRequest(values) {
    return remote('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, ...values }).toString() }, 16384);
  }

  async function status(id) {
    const vault = await store.get(vaultKey(id));
    return { available: configured(), configured: configured(), ...googleCapabilities(), connected: Boolean(configured() && vault), calendar: Boolean(configured() && vault?.consent.calendar), inbox: Boolean(configured() && vault?.consent.inbox), calendarIds: vault?.consent.calendarIds || [], sharing: vault?.sharing || { calendar: false, inbox: false } };
  }

  async function beginGoogle(id, input) {
    needConfiguration();
    exact(input, ['calendar', 'inbox', 'calendarIds', 'redirectUri']);
    if (typeof input.calendar !== 'boolean' || typeof input.inbox !== 'boolean' || (!input.calendar && !input.inbox)) reject(400, 'Choose calendar or inbox access.');
    if (input.redirectUri !== undefined && input.redirectUri !== callback) reject(400, 'Use the DisplayOS return address.');
    const selectedIds = input.calendar ? calendarIds(input.calendarIds) : [];
    if (!input.calendar && input.calendarIds !== undefined && (!Array.isArray(input.calendarIds) || input.calendarIds.length)) reject(400, 'Choose calendar access before selecting calendars.');
    const state = random();
    const verifier = random();
    const stateHash = await digest(state);
    const consent = { calendar: input.calendar, inbox: input.inbox, calendarIds: selectedIds };
    const scopes = [input.calendar && CALENDAR_SCOPE, input.inbox && INBOX_SCOPE].filter(Boolean);
    await store.transaction(async transaction => {
      const prefix = challengePrefix(id);
      const pending = await transaction.list(prefix, 6);
      for (const [key, value] of pending) if (value.expiresAt <= now()) await transaction.delete(key);
      if ([...pending.values()].filter(value => value.expiresAt > now()).length >= 4) reject(429, 'Please finish the connection you already started.');
      await transaction.put(prefix + stateHash, { consent, scopes, verifier, epoch: await transaction.get(epochKey(id)) || 0, expiresAt: now() + 300000 });
    });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: callback, response_type: 'code', scope: scopes.join(' '), state, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false', code_challenge: await digest(verifier), code_challenge_method: 'S256' }).toString();
    return { url: url.href, expiresAt: now() + 300000 };
  }

  async function finishGoogle(id, input) {
    needConfiguration();
    exact(input, ['code', 'state']);
    if (typeof input.state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(input.state) || typeof input.code !== 'string' || !input.code.length || input.code.length > 2048 || /[\s<>]/.test(input.code)) reject(400, 'Please start the Google connection again.');
    const key = challengePrefix(id) + await digest(input.state);
    const challenge = await store.transaction(async transaction => {
      const value = await transaction.get(key);
      if (!value || value.expiresAt <= now() || value.epoch !== (await transaction.get(epochKey(id)) || 0)) reject(403, 'This Google connection has expired. Start again.');
      await transaction.delete(key);
      return value;
    });
    const tokens = validateTokens(await tokenRequest({ grant_type: 'authorization_code', code: input.code, redirect_uri: callback, code_verifier: challenge.verifier }), challenge.scopes, true);
    await store.transaction(async transaction => {
      if (challenge.epoch !== (await transaction.get(epochKey(id)) || 0)) reject(409, 'The connection was stopped. Please start again.');
      await transaction.put(vaultKey(id), { version: random(18), consent: challenge.consent, scopes: challenge.scopes, accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: now() + tokens.expires_in * 1000, sharing: { calendar: false, inbox: false }, connectedAt: now() });
    });
    return status(id);
  }

  async function access(id, kind) {
    needConfiguration();
    const key = vaultKey(id);
    const vault = await store.get(key);
    if (!vault || !vault.consent[kind]) reject(403, kind === 'inbox' ? 'Allow inbox access yourself before reading inbox reminders.' : 'Connect a calendar and choose which calendars to use.');
    if (vault.expiresAt > now() + 60000) return vault;
    const tokens = validateTokens(await tokenRequest({ grant_type: 'refresh_token', refresh_token: vault.refreshToken }), vault.scopes, false);
    return store.transaction(async transaction => {
      const current = await transaction.get(key);
      if (!current || current.version !== vault.version) reject(409, 'The connection changed. Please try again.');
      const updated = { ...current, accessToken: tokens.access_token, refreshToken: tokens.refresh_token || current.refreshToken, expiresAt: now() + tokens.expires_in * 1000 };
      await transaction.put(key, updated);
      return updated;
    });
  }

  async function calendar(id, input) {
    exact(input, ['timezone', 'calendarIds']);
    const zone = timezone(input.timezone);
    const vault = await access(id, 'calendar');
    const selected = input.calendarIds === undefined ? vault.consent.calendarIds : calendarIds(input.calendarIds);
    if (!selected.length || selected.some(value => !vault.consent.calendarIds.includes(value))) reject(403, 'Use only the calendars you selected during connection.');
    const today = localDate(now(), zone);
    const start = Date.parse(today + 'T00:00:00Z');
    const week = Array.from({ length: 7 }, (_, index) => ({ date: new Date(start + index * DAY).toISOString().slice(0, 10), events: [] }));
    const events = [];
    for (const calendarId of selected) {
      const url = new URL('https://www.googleapis.com/calendar/v3/calendars/' + encodeURIComponent(calendarId) + '/events');
      url.search = new URLSearchParams({ timeMin: new Date(now()).toISOString(), timeMax: new Date(now() + 7 * DAY).toISOString(), timeZone: zone, singleEvents: 'true', orderBy: 'startTime', maxResults: '100', fields: 'items(summary,start,status)' }).toString();
      const result = await remote(url.href, { headers: { Authorization: 'Bearer ' + vault.accessToken } });
      if (!Array.isArray(result.items) || result.items.length > 100 || result.items.some(item => !item || typeof item !== 'object' || Array.isArray(item))) reject(502, 'Google returned unsupported calendar information.');
      events.push(...result.items);
    }
    events.sort((left, right) => String(left.start?.dateTime || left.start?.date || '').localeCompare(String(right.start?.dateTime || right.start?.date || '')));
    for (const event of events) {
      if (!event || event.status === 'cancelled') continue;
      if (!event.start || (event.start.dateTime !== undefined && (typeof event.start.dateTime !== 'string' || !Number.isFinite(Date.parse(event.start.dateTime)))) || (event.start.date !== undefined && (typeof event.start.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(event.start.date))) || (!event.start.dateTime && !event.start.date)) reject(502, 'Google returned unsupported calendar information.');
      const timestamp = event.start?.dateTime ? Date.parse(event.start.dateTime) : NaN;
      const day = Number.isFinite(timestamp) ? localDate(timestamp, zone) : event.start?.date;
      const target = week.find(value => value.date === day);
      if (!target || target.events.length >= 2) continue;
      const time = Number.isFinite(timestamp) ? new Intl.DateTimeFormat('en', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(timestamp) : 'All day';
      target.events.push({ title: safeTitle(event.summary), time, person: 'Family' });
    }
    return { week, sharingAllowed: vault.sharing.calendar, fetchedAt: now() };
  }

  async function inbox(id, input = {}) {
    exact(input, ['timezone']);
    if (input.timezone !== undefined) timezone(input.timezone);
    const vault = await access(id, 'inbox');
    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    url.search = new URLSearchParams({ labelIds: 'INBOX', maxResults: '4', fields: 'messages(id)' }).toString();
    const result = await remote(url.href, { headers: { Authorization: 'Bearer ' + vault.accessToken } }, 16384);
    const messages = result.messages === undefined ? [] : result.messages;
    if (!Array.isArray(messages) || messages.length > 4 || messages.some(message => !message || typeof message.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(message.id))) reject(502, 'Google returned unsupported inbox information.');
    const reminders = [];
    for (const message of messages) {
      const detail = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages/' + message.id);
      detail.search = new URLSearchParams({ format: 'metadata', metadataHeaders: 'Subject', fields: 'payload(headers)' }).toString();
      const value = await remote(detail.href, { headers: { Authorization: 'Bearer ' + vault.accessToken } }, 16384);
      const headers = value.payload?.headers;
      if (!Array.isArray(headers) || headers.length > 20) reject(502, 'Google returned unsupported inbox information.');
      const subject = headers.find(header => typeof header?.name === 'string' && header.name.toLowerCase() === 'subject');
      reminders.push({ title: safeTitle(subject?.value, 'Check your inbox'), time: 'Inbox', person: 'You' });
    }
    return { reminders, sharingAllowed: vault.sharing.inbox, fetchedAt: now() };
  }

  async function setSharing(id, input) {
    exact(input, ['calendar', 'inbox']);
    if (typeof input.calendar !== 'boolean' || typeof input.inbox !== 'boolean') reject(400, 'Choose what may appear on your family screen.');
    await store.transaction(async transaction => {
      const key = vaultKey(id);
      const vault = await transaction.get(key);
      if (!vault || (input.calendar && !vault.consent.calendar) || (input.inbox && !vault.consent.inbox)) reject(403, 'Connect the information yourself before sharing it.');
      await transaction.put(key, { ...vault, sharing: { calendar: input.calendar, inbox: input.inbox } });
    });
    return status(id);
  }

  async function disconnect(id) {
    const removed = await store.transaction(async transaction => {
      const key = vaultKey(id);
      const vault = await transaction.get(key);
      await transaction.delete(key);
      await transaction.put(epochKey(id), (await transaction.get(epochKey(id)) || 0) + 1);
      for (const key of (await transaction.list(challengePrefix(id), 6)).keys()) await transaction.delete(key);
      return vault;
    });
    let revokedAtProvider = !removed;
    if (removed) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const result = await fetcher('https://oauth2.googleapis.com/revoke', { method: 'POST', redirect: 'manual', signal: controller.signal, headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: removed.refreshToken }).toString() });
        revokedAtProvider = result.ok;
        await result.body?.cancel();
      } catch { revokedAtProvider = false; }
      finally { clearTimeout(timeout); }
    }
    return { disconnected: true, revokedAtProvider };
  }

  async function weather(input) {
    exact(input, ['latitude', 'longitude', 'timezone', 'consent']);
    if (input.consent !== true) reject(403, 'Allow the use of your chosen location for weather.');
    if (typeof input.latitude !== 'number' || !Number.isFinite(input.latitude) || Math.abs(input.latitude) > 90 || typeof input.longitude !== 'number' || !Number.isFinite(input.longitude) || Math.abs(input.longitude) > 180) reject(400, 'Choose a valid weather location.');
    const zone = timezone(input.timezone);
    if (!env.OPEN_METEO_API_KEY && env.OPEN_METEO_NONCOMMERCIAL_DEMO !== 'true') reject(503, 'Weather is not configured for this service yet.');
    const url = new URL(env.OPEN_METEO_API_KEY ? 'https://customer-api.open-meteo.com/v1/forecast' : 'https://api.open-meteo.com/v1/forecast');
    url.search = new URLSearchParams({ latitude: String(input.latitude), longitude: String(input.longitude), timezone: zone, daily: 'temperature_2m_max,temperature_2m_min,weather_code', forecast_days: '7', temperature_unit: 'celsius', ...(env.OPEN_METEO_API_KEY ? { apikey: env.OPEN_METEO_API_KEY } : {}) }).toString();
    const result = await remote(url.href, {}, 32768);
    const daily = result.daily;
    if (!daily || !Array.isArray(daily.time) || !daily.time.length || daily.time.length > 7 || ['temperature_2m_max', 'temperature_2m_min', 'weather_code'].some(field => !Array.isArray(daily[field]) || daily[field].length !== daily.time.length)) reject(502, 'The weather provider returned unsupported information.');
    const seen = new Set();
    const weather = daily.time.map((date, index) => {
      const timestamp = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(date + 'T00:00:00Z') : NaN;
      const high = daily.temperature_2m_max[index];
      const low = daily.temperature_2m_min[index];
      const code = daily.weather_code[index];
      if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date || seen.has(date) || typeof high !== 'number' || !Number.isFinite(high) || typeof low !== 'number' || !Number.isFinite(low) || low > high || low < -100 || high > 100 || !Number.isInteger(code) || !Object.hasOwn(CONDITIONS, code)) reject(502, 'The weather provider returned unsupported information.');
      seen.add(date);
      return { date, label: new Intl.DateTimeFormat('en', { timeZone: 'UTC', weekday: 'short' }).format(timestamp), high, low, condition: CONDITIONS[code] };
    });
    return { weather, fetchedAt: now(), attribution: 'Weather data by Open-Meteo' };
  }

  async function location(homeId) {
    const record = await store.get(locationKey(homeId));
    return { version: record?.version || 0, location: record?.address ? { address: record.address, weather: record.weather, nearby: record.nearby, savedAt: record.savedAt } : null, ...googleCapabilities() };
  }

  async function saveLocation(homeId, input) {
    exact(input, ['address', 'weather', 'nearby']);
    if (typeof input.address !== 'string' || input.address.length > 240 || /[<>\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]|:\/\/|www\.|(?:javascript|data|file):/i.test(input.address) || typeof input.weather !== 'boolean' || typeof input.nearby !== 'boolean') reject(400, 'Use a short home address or city and choose whether it may be used.');
    const address = input.address.trim();
    if ((address && address.length < 3) || (!address && (input.weather || input.nearby))) reject(400, 'Enter your home address or city before allowing its use.');
    await store.transaction(async transaction => {
      const key = locationKey(homeId);
      const previous = await transaction.get(key);
      const version = (previous?.version || 0) + 1;
      if (!Number.isSafeInteger(version)) reject(409, 'This home location needs to be reset by support.');
      await transaction.put(key, { address, weather: input.weather, nearby: input.nearby, version, savedAt: now() });
    });
    return location(homeId);
  }

  async function chosenLocation(homeId, kind) {
    const record = await store.get(locationKey(homeId));
    if (!record?.address || record[kind] !== true) reject(403, 'Allow this home location for weather or nearby places first.');
    if (!googleCapabilities()[kind === 'weather' ? 'weatherAvailable' : 'nearbyAvailable']) reject(503, 'Google information is not available for this home yet. Your location has been saved privately.');
    return record;
  }

  async function checkLocation(homeId, record, kind) {
    const current = await store.get(locationKey(homeId));
    if (!current?.address || current.version !== record.version || current[kind] !== true) reject(409, 'The home location or its sharing choice changed. Please try again.');
  }

  async function geocodeCity(address) {
    async function lookup(query, country) {
      const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
      url.search = new URLSearchParams({ address: query, language: 'en', key: env.GOOGLE_GEOCODING_API_KEY, ...(country ? { components: 'country:' + country } : {}) }).toString();
      const result = await remote(url.href, {}, 131072);
      if (result.status === 'ZERO_RESULTS') reject(400, 'We could not find that location. Try a city with its country.');
      if (result.status !== 'OK') reject(503, 'Google location lookup is not available right now. Your saved location is unchanged.');
      if (!Array.isArray(result.results) || result.results.length !== 1 || result.results[0]?.partial_match) reject(400, 'That location is unclear. Add the city, region or country.');
      const place = result.results[0];
      if (!place || !Array.isArray(place.address_components) || place.address_components.length > 32 || !Array.isArray(place.types) || place.types.length > 12 || place.address_components.some(value => !value || !Array.isArray(value.types) || value.types.length > 10)) reject(502, 'Google returned unsupported location information.');
      const component = type => place.address_components.find(value => value.types.includes(type));
      const city = component('locality') || component('postal_town') || component('administrative_area_level_2');
      const nation = component('country');
      const region = component('administrative_area_level_1');
      if (!city || !nation || typeof nation.short_name !== 'string' || !/^[A-Z]{2}$/.test(nation.short_name) || typeof city.long_name !== 'string') reject(400, 'Try a city and country instead of an exact street address.');
      const cityName = safeTitle(city.long_name, '');
      const regionName = safeTitle(region?.long_name, '');
      if (!cityName) reject(502, 'Google returned unsupported location information.');
      return { place, cityName, regionName, country: nation.short_name };
    }
    let found = await lookup(address);
    const cityTypes = ['locality', 'postal_town', 'administrative_area_level_2'];
    if (!found.place.types.some(type => cityTypes.includes(type))) {
      const original = found;
      found = await lookup(original.cityName + (original.regionName ? ', ' + original.regionName : ''), original.country);
      if (!found.place.types.some(type => cityTypes.includes(type)) || found.cityName !== original.cityName || found.country !== original.country) reject(400, 'We could not confirm the city. Try the city and country directly.');
    }
    const coordinates = found.place.geometry?.location;
    if (!coordinates || typeof coordinates.lat !== 'number' || !Number.isFinite(coordinates.lat) || Math.abs(coordinates.lat) > 90 || typeof coordinates.lng !== 'number' || !Number.isFinite(coordinates.lng) || Math.abs(coordinates.lng) > 180) reject(502, 'Google returned unsupported city coordinates.');
    return { latitude: coordinates.lat, longitude: coordinates.lng, cityLabel: safeTitle(found.cityName + (found.regionName ? ', ' + found.regionName : '') + ', ' + found.country, '') };
  }

  async function googleWeather(homeId, zone) {
    timezone(zone);
    const record = await chosenLocation(homeId, 'weather');
    const city = await geocodeCity(record.address);
    await checkLocation(homeId, record, 'weather');
    const url = new URL('https://weather.googleapis.com/v1/forecast/days:lookup');
    url.search = new URLSearchParams({ key: env.GOOGLE_WEATHER_API_KEY, 'location.latitude': String(city.latitude), 'location.longitude': String(city.longitude), days: '7', pageSize: '7', unitsSystem: 'METRIC', languageCode: 'en' }).toString();
    const result = await remote(url.href, {}, 131072);
    if (!Array.isArray(result.forecastDays) || !result.forecastDays.length || result.forecastDays.length > 7 || result.nextPageToken) reject(502, 'Google returned unsupported forecast information.');
    const seen = new Set();
    const weather = result.forecastDays.map(day => {
      const display = day?.displayDate;
      if (!display || !Number.isInteger(display.year) || display.year < 1000 || display.year > 9999 || !Number.isInteger(display.month) || !Number.isInteger(display.day)) reject(502, 'Google returned an unsupported forecast date.');
      const date = String(display.year) + '-' + String(display.month).padStart(2, '0') + '-' + String(display.day).padStart(2, '0');
      const timestamp = Date.parse(date + 'T00:00:00Z');
      const high = day.maxTemperature?.degrees;
      const low = day.minTemperature?.degrees;
      const description = day.daytimeForecast?.weatherCondition?.description?.text;
      if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date || seen.has(date) || day.maxTemperature?.unit !== 'CELSIUS' || day.minTemperature?.unit !== 'CELSIUS' || typeof high !== 'number' || !Number.isFinite(high) || typeof low !== 'number' || !Number.isFinite(low) || low > high || low < -100 || high > 100 || typeof description !== 'string' || !description.trim()) reject(502, 'Google returned unsupported forecast information.');
      seen.add(date);
      const condition = safeTitle(description, '');
      if (!condition) reject(502, 'Google returned unsupported forecast information.');
      return { date, label: new Intl.DateTimeFormat('en', { weekday: 'short', timeZone: 'UTC' }).format(timestamp), high, low, condition };
    });
    await checkLocation(homeId, record, 'weather');
    return { available: true, weather, cityLabel: city.cityLabel, attribution: 'Google Maps', weatherSourceAttribution: 'Source: Includes weather data from Google', thirdPartyAttributions: [], locationVersion: record.version, fetchedAt: now(), expiresAt: now() + 3600000, ephemeral: true };
  }

  async function nearby(homeId) {
    const record = await chosenLocation(homeId, 'nearby');
    const city = await geocodeCity(record.address);
    await checkLocation(homeId, record, 'nearby');
    const result = await remote('https://places.googleapis.com/v1/places:searchNearby', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': env.GOOGLE_PLACES_API_KEY, 'X-Goog-FieldMask': 'places.displayName,places.primaryTypeDisplayName,places.attributions' }, body: JSON.stringify({ includedTypes: ['park', 'library', 'museum'], maxResultCount: 3, rankPreference: 'DISTANCE', languageCode: 'en', locationRestriction: { circle: { center: { latitude: city.latitude, longitude: city.longitude }, radius: 5000 } } }) }, 32768);
    const places = result.places === undefined ? [] : result.places;
    if (!Array.isArray(places) || places.length > 3) reject(502, 'Google returned unsupported nearby information.');
    const nearby = places.map(place => {
      if (!place || typeof place.displayName?.text !== 'string' || !place.displayName.text.trim() || (place.attributions !== undefined && !Array.isArray(place.attributions))) reject(502, 'Google returned unsupported nearby information.');
      if (place.attributions?.length) reject(503, 'These places need additional provider acknowledgements that are not supported in this trial yet.');
      const title = safeTitle(place.displayName.text, '');
      if (!title) reject(502, 'Google returned unsupported nearby information.');
      return { title, when: typeof place.primaryTypeDisplayName?.text === 'string' ? safeTitle(place.primaryTypeDisplayName.text, 'Nearby place') : 'Nearby place' };
    });
    await checkLocation(homeId, record, 'nearby');
    return { available: true, nearby, cityLabel: city.cityLabel, attribution: 'Google Maps', thirdPartyAttributions: [], locationVersion: record.version, fetchedAt: now(), expiresAt: now() + 3600000, ephemeral: true };
  }

  return { status, beginGoogle, finishGoogle, calendar, inbox, setSharing, weather, disconnect, location, saveLocation, googleWeather, nearby };
}
