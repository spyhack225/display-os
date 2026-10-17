import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';

if (process.argv.slice(2).join(' ') !== '--synthetic-location') throw new Error('Use --synthetic-location to create and delete one test home and request real Google results for a public test city.');
const config = JSON.parse(await readFile(new URL('../wrangler.json', import.meta.url), 'utf8'));
const origin = config.vars.PUBLIC_ORIGIN;
if (!/^https:\/\//.test(origin)) throw new Error('wrangler.json PUBLIC_ORIGIN must be an HTTPS origin.');
const tag = randomBytes(5).toString('hex');
let browser;
let owner;
let registered = false;
let deleted = false;
let checks = 0;
let phase = 'sign-in';
let failed = false;
let trialToken;
let screenVerified = false;
function check(value, message) { assert.ok(value, message); checks++; }
async function api(route, body) {
  return owner.evaluate(async ({ route, body }) => {
    const me = await fetch('/api/v1/me', { signal: AbortSignal.timeout(15000) }).then(response => response.json());
    const response = await fetch(route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-DisplayOS-CSRF': me.csrf },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(35000)
    });
    return { status: response.status, serverAt: Date.parse(response.headers.get('date')), value: await response.json() };
  }, { route, body });
}

try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  context.setDefaultTimeout(45000);
  owner = await context.newPage();
  await owner.goto(origin + '/home');
  const authenticator = await context.newCDPSession(owner);
  await authenticator.send('WebAuthn.enable');
  await authenticator.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await owner.locator('#your-name').fill('Google QA ' + tag);
  await owner.getByRole('button', { name: 'Get started', exact: true }).click();
  await owner.locator('#home-name').waitFor();
  registered = true;
  await owner.locator('#home-name').fill('Google QA home ' + tag);
  await owner.getByRole('button', { name: 'Make my home', exact: true }).click();
  await owner.locator('#screen-code').waitFor();
  const homes = await api('/api/v1/homes');
  check(homes.status === 200 && homes.value.homes.length === 1, 'Test home creation failed.');
  const homeId = homes.value.homes[0].id;
  phase = 'configuration';
  const location = await api('/api/v1/providers/location', { homeId });
  check(location.status === 200 && location.value.geocodingAvailable && location.value.weatherAvailable && location.value.nearbyAvailable, 'Google service configuration is unavailable.');
  check(location.value.location === null, 'Test home is not empty.');
  phase = 'test-city-consent';
  const saved = await api('/api/v1/providers/location/save', { homeId, address: 'New York, NY, USA', weather: true, nearby: true });
  check(saved.status === 200 && saved.value.location.weather && saved.value.location.nearby, 'Test city consent could not be saved.');
  await owner.reload();
  await owner.getByText('Things to bring home', { exact: true }).click();
  await owner.getByRole('textbox', { name: 'Home address or city', exact: true }).waitFor();
  for (const kind of ['weather', 'nearby']) {
    phase = kind;
    const pending = owner.waitForResponse(response => response.url() === origin + '/api/v1/providers/google/' + kind, { timeout: 35000 });
    await owner.getByRole('button', { name: kind === 'weather' ? 'Preview weather' : 'Preview nearby places', exact: true }).click();
    const response = await pending;
    const result = { status: response.status(), serverAt: Date.parse((await response.allHeaders()).date), value: await response.json() };
    check(result.status === 200, 'Real Google ' + kind + ' returned HTTP ' + result.status + '.');
    check(result.value.available === true && result.value.ephemeral === true && result.value.locationVersion === saved.value.version, 'Google result is not transient and bound to current consent.');
    check(result.value.attribution === 'Google Maps' && Array.isArray(result.value.thirdPartyAttributions) && result.value.thirdPartyAttributions.length === 0, 'Unsupported Google attribution.');
    check(typeof result.value.cityLabel === 'string' && result.value.cityLabel.length > 0 && !('address' in result.value) && !('latitude' in result.value) && !('longitude' in result.value), 'Provider result exposes an address or coordinates.');
    check(Number.isSafeInteger(result.value.fetchedAt) && Number.isSafeInteger(result.value.expiresAt) && result.value.expiresAt > result.serverAt && result.value.expiresAt - result.value.fetchedAt > 0 && result.value.expiresAt - result.value.fetchedAt <= 3600000, 'Google result expiry is invalid.');
    if (kind === 'weather') {
      check(Array.isArray(result.value.weather) && result.value.weather.length > 0 && result.value.weather.length <= 7, 'Forecast is missing.');
      check(result.value.weather.every(day => Number.isFinite(day.high) && Number.isFinite(day.low) && typeof day.condition === 'string'), 'Forecast values are invalid.');
      check(result.value.weatherSourceAttribution === 'Source: Includes weather data from Google', 'Weather source acknowledgement is missing.');
    } else check(Array.isArray(result.value.nearby) && result.value.nearby.length > 0 && result.value.nearby.length <= 3, 'Nearby public places are missing.');
    await owner.locator('.google-local-preview h3').filter({ hasText: result.value.cityLabel }).waitFor();
    await owner.locator('.google-local-preview li').filter({ hasText: kind === 'weather' ? result.value.weather[0].condition : result.value.nearby[0].title }).first().waitFor();
    check(await owner.locator('.google-local-preview .google-attribution').isVisible(), 'Real Google preview attribution is not visible.');
    if (kind === 'weather') {
      const before = result.value.weather[0];
      await owner.getByRole('button', { name: 'Fahrenheit °F', exact: true }).click();
      const range = Math.round(before.low * 9 / 5 + 32) + '°F to ' + Math.round(before.high * 9 / 5 + 32) + '°F';
      await owner.locator('.google-local-preview li').filter({ hasText: range }).first().waitFor();
      check(await owner.getByRole('button', { name: 'Fahrenheit °F', exact: true }).getAttribute('aria-pressed') === 'true', 'Real weather preview does not select Fahrenheit.');
      check((await api('/api/v1/home', { homeId, command: 'home.get', input: {} })).value.settings.temperatureUnit === 'fahrenheit', 'Fahrenheit preference was not saved.');
      await owner.getByRole('button', { name: 'Celsius °C', exact: true }).click();
      await owner.locator('.google-local-preview li').filter({ hasText: Math.round(before.low) + '°C to ' + Math.round(before.high) + '°C' }).first().waitFor();
      check(await owner.getByRole('button', { name: 'Celsius °C', exact: true }).getAttribute('aria-pressed') === 'true', 'Real weather preview cannot restore Celsius.');
    }
  }
  phase = 'screen-local-information';
  const home = await api('/api/v1/home', { homeId, command: 'home.get', input: {} });
  check(home.status === 200, 'Test home settings could not be read.');
  check((await api('/api/v1/home', { homeId, command: 'home.update', input: { settings: { ...home.value.settings, timezone: 'UTC', nightStart: '00:00', nightEnd: '23:59' } } })).status === 200, 'Test quiet hours could not be set.');
  const display = await context.newPage();
  await display.setViewportSize({ width: 1280, height: 800 });
  await display.goto(origin + '/home');
  await display.getByText('Try it on this computer', { exact: true }).click();
  await display.getByRole('button', { name: 'Try this screen', exact: true }).click();
  await display.waitForURL(origin + '/screen');
  await display.locator('.pair-code').waitFor();
  trialToken = await display.evaluate(() => sessionStorage.getItem('displayos-demo-device-token'));
  check(typeof trialToken === 'string' && trialToken.length > 20, 'Test screen identity is missing.');
  const code = (await display.locator('.pair-code').innerText()).replace(/\s/g, '');
  check(/^[0-9]{6}$/.test(code), 'Test screen code is missing.');
  const claim = await api('/api/v1/claim', { homeId, code });
  check(claim.status === 200 && claim.value.pending === true, 'Test screen claim did not start.');
  await display.evaluate(() => window.dispatchEvent(new Event('online')));
  await display.getByRole('button', { name: 'Yes, this is my home', exact: true }).click();
  await display.getByRole('button', { name: 'Show full display', exact: true }).waitFor();
  check(await display.locator('.local-attribution').count() === 0, 'Test quiet hours expose local information.');
  const localResponse = display.waitForResponse(origin + '/device/v1/local', { timeout: 45000 });
  await display.getByRole('button', { name: 'Show full display', exact: true }).click();
  const local = await localResponse;
  const localValue = await local.json();
  check(local.status() === 200 && localValue.available === true && localValue.ephemeral === true, 'Real Google screen-local response failed.');
  check(localValue.localRevision === saved.value.version && localValue.localEnabled.weather && localValue.localEnabled.nearby, 'Test screen local consent changed.');
  check(localValue.weather.length > 0 && localValue.nearby.length > 0, 'Real Google screen-local weather or places are missing.');
  await display.locator('.week-day .local-forecast').first().waitFor();
  await display.locator('.family-tile').filter({ has: display.getByRole('heading', { name: 'Around town', exact: true }) }).getByText(localValue.nearby[0].title, { exact: false }).waitFor();
  check(await display.locator('.local-attribution').count() > 0, 'Real Google screen attribution is missing.');
  check(!/could not be loaded/.test(await display.locator('body').innerText()), 'Successful screen-local request still shows an error.');
  await display.getByRole('button', { name: 'Settings' }).click();
  await display.getByRole('button', { name: 'Back to quiet hours' }).click();
  check(await display.locator('.local-attribution,.local-forecast').count() === 0, 'Returning to quiet hours leaves real Google information visible.');
  screenVerified = true;
  phase = 'export';
  const exported = await api('/api/v1/home', { homeId, command: 'home.export', input: {} });
  check(exported.status === 200 && !/forecastDays|cityLabel|thirdPartyAttributions|weatherSourceAttribution/.test(JSON.stringify(exported.value)), 'Google-derived results reached durable export.');
  phase = 'withdrawal';
  const stopped = await api('/api/v1/providers/location/save', { homeId, address: 'New York, NY, USA', weather: false, nearby: false });
  check(stopped.status === 200, 'Test consent withdrawal failed.');
  for (const kind of ['weather', 'nearby']) check((await api('/api/v1/providers/google/' + kind, { homeId })).status === 403, 'Withdrawn test consent still permits Google ' + kind + '.');
} catch (error) {
  failed = true;
  console.error('Google live verification failed at ' + phase + '.' + (error instanceof assert.AssertionError ? ' ' + error.message : ' Request or browser operation did not complete.'));
} finally {
  if (owner && !registered) {
    try { registered = (await api('/api/v1/me')).status === 200; } catch {}
  }
  if (registered && owner) {
    try {
      deleted = (await api('/auth/account/delete', {})).status === 200;
      check(deleted, 'Test account deletion failed.');
      check((await api('/api/v1/me')).status === 401, 'Deleted test account remains signed in.');
      if (trialToken) check((await fetch(origin + '/device/v1/poll', { headers: { Authorization: 'Bearer ' + trialToken }, signal: AbortSignal.timeout(15000) })).status === 401, 'Deleted test screen remains connected.');
    } catch {
      failed = true;
      console.error('Google test cleanup failed for Google QA ' + tag + '. Do not remove other accounts.');
    }
  }
  await browser?.close();
}
if (failed) process.exitCode = 1;
else console.log(JSON.stringify({ checks, verifiedAt: new Date().toISOString(), realGoogleWeather: true, realGoogleNearby: true, realGoogleBrowserDisplay: screenVerified, explicitQuietHoursExitVerified: screenVerified, syntheticCity: true, syntheticAccountDeleted: deleted, syntheticBrowserTrialDeleted: Boolean(trialToken && deleted), customerHomeChanged: false, personalGoogleAccountConnected: false, physicalScreenPrepared: false }));
