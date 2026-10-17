import { reject } from './common.js';

export async function localMetadata(adapter, homeId) {
  const source = await adapter.location(homeId);
  if (!Number.isSafeInteger(source.version) || source.version < 0) reject(503, 'Your home location is not ready yet.');
  return {
    localRevision: source.version,
    localEnabled: {
      weather: Boolean(source.location?.weather && source.weatherAvailable),
      nearby: Boolean(source.location?.nearby && source.nearbyAvailable)
    }
  };
}

export async function loadLocal({ device, store, adapter, homeCall, finalize, now = Date.now }) {
  if (typeof finalize !== 'function') reject(503, 'Local information is not ready yet.');
  const homeId = device.homeId;
  const epoch = device.epoch;
  async function current() {
    const latest = await store.get('device:' + device.id);
    if (!latest || latest.state !== 'owned' || latest.homeId !== homeId || latest.epoch !== epoch || latest.tokenHash !== device.tokenHash) reject(403, 'This screen is no longer in that home.');
    const home = await homeCall(homeId, { system: true }, 'home.get');
    if (!home.screens.some(screen => screen.id === device.id && screen.epoch === epoch)) reject(403, 'This screen is no longer in that home.');
    return home;
  }
  const home = await current();
  const metadata = await localMetadata(adapter, homeId);
  async function deliver(build) {
    return finalize(async () => {
      const fresh = await localMetadata(adapter, homeId);
      await current();
      if (fresh.localRevision !== metadata.localRevision || JSON.stringify(fresh.localEnabled) !== JSON.stringify(metadata.localEnabled)) reject(409, 'Your home location choices changed. Please try again.');
      return build(fresh);
    });
  }
  if (!metadata.localEnabled.weather && !metadata.localEnabled.nearby) return deliver(fresh => ({ available: false, ...fresh }));
  const requests = [];
  if (metadata.localEnabled.weather) requests.push(adapter.googleWeather(homeId, home.settings.timezone));
  if (metadata.localEnabled.nearby) requests.push(adapter.nearby(homeId));
  const settled = await Promise.allSettled(requests);
  const results = settled.filter(result => result.status === 'fulfilled').map(result => result.value);
  if (!results.length) throw settled[0].reason;
  return deliver(fresh => {
    if (results.some(result => result.locationVersion !== metadata.localRevision || result.ephemeral !== true || result.attribution !== 'Google Maps' || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= now() || result.expiresAt > now() + 3600000 || !Array.isArray(result.thirdPartyAttributions) || result.thirdPartyAttributions.length)) reject(502, 'Local information is not ready yet.');
    const weather = results.find(result => Array.isArray(result.weather));
    const nearby = results.find(result => Array.isArray(result.nearby));
    if (weather?.weather.length && weather.weatherSourceAttribution !== 'Source: Includes weather data from Google') reject(502, 'Weather information is not ready yet.');
    return {
      available: true,
      ...fresh,
      weather: weather?.weather || [],
      nearby: nearby?.nearby || [],
      cityLabel: results[0].cityLabel,
      attribution: 'Google Maps',
      ...(weather?.weather.length ? { weatherSourceAttribution: weather.weatherSourceAttribution } : {}),
      thirdPartyAttributions: [],
      expiresAt: Math.min(...results.map(result => result.expiresAt)),
      ephemeral: true
    };
  });
}
