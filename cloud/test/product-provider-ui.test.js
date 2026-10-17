import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Script } from 'node:vm';
import { validateSnapshot } from '../src/product/family.js';

const source = await readFile(new URL('../product-public/providers.js', import.meta.url), 'utf8');
const common = await readFile(new URL('../product-public/common.js', import.meta.url), 'utf8');
const origin = 'https://sources.example.com';
const attribution = 'Google Maps';

test('source module parses and exposes only the owner mount without credential or unsafe DOM APIs', () => {
  assert.doesNotThrow(() => new Script(source));
  assert.match(source, /window\.DisplayOSSources = \{ mount: mount \}/);
  assert.match(source, /home\.role !== 'owner'/);
  assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function|geolocation|localStorage|sessionStorage|client_secret|access_token|refresh_token/i);
  assert.doesNotMatch(source, /\bstyle\s*:/);
  assert.match(source, /Math\.min\(current\.snapshot\.expiresAt, now \+ 3600000\)/);
  assert.match(source, /url\.origin !== 'https:\/\/accounts\.google\.com'/);
});

test('weather attribution accepts only the fixed provider wording', () => {
  const now = Date.now();
  const value = { schemaVersion: 1, timezone: 'UTC', generatedAt: now, expiresAt: now + 3600000, briefing: { title: 'Today', text: 'Your chosen plans' }, weatherAttribution: 'Weather data by Open-Meteo' };
  assert.equal(validateSnapshot(value, now).weatherAttribution, 'Weather data by Open-Meteo');
  for (const invalid of ['Google Maps', 'https://fake.example.com', 'A different provider', '<b>Weather</b>', null]) assert.throws(() => validateSnapshot({ ...value, weatherAttribution: invalid }, now));
});

async function withBrowser(callback) {
  const modulePath = process.env.PLAYWRIGHT_MODULE;
  const { chromium } = await import(!modulePath ? 'playwright' : modulePath.startsWith('file:') ? modulePath : pathToFileURL(modulePath).href);
  const browser = await chromium.launch({ headless: true });
  try { return await callback(await browser.newPage()); }
  finally { await browser.close(); }
}

async function mount(page, status, options = {}) {
  const requests = [];
  const commands = [];
  const current = options.current || { revision: 0, snapshot: null };
  let location = { version: 0, location: null, geocodingAvailable: Boolean(status.weatherAvailable || status.nearbyAvailable), weatherAvailable: Boolean(status.weatherAvailable), nearbyAvailable: Boolean(status.nearbyAvailable) };
  await page.route(origin + '/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/') { await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><div id="notice"></div><div id="root"></div></body></html>' }); return; }
    const input = request.postDataJSON();
    requests.push({ path, input });
    let value;
    if (path === '/api/v1/providers/status') value = status;
    else if (path === '/api/v1/providers/sharing') { status = { ...status, sharing: input }; value = status; }
    else if (path === '/api/v1/providers/google/calendar') value = { week: [{ date: '2026-10-10', events: [{ title: options.calendarTitle || 'School concert', time: '16:00', person: 'Family' }] }], sharingAllowed: Boolean(status.sharing?.calendar) };
    else if (path === '/api/v1/providers/google/inbox') value = { reminders: [{ title: 'Lunch note', time: 'Inbox', person: 'You' }], sharingAllowed: Boolean(status.sharing?.inbox) };
    else if (path === '/api/v1/providers/google/start') value = { url: options.googleUrl || 'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic' };
    else if (path === '/api/v1/home') { assert.equal(input.homeId, 'synthetic_home'); assert.equal(input.command, 'home.temperature'); value = { saved: true }; }
    else if (path === '/api/v1/providers/location') value = location;
    else if (path === '/api/v1/providers/location/save') { assert.equal(input.homeId, 'synthetic_home'); location = { ...location, version: location.version + 1, location: input.address ? { address: input.address, weather: input.weather, nearby: input.nearby, savedAt: Date.now() } : null }; value = location; }
    else if (path === '/api/v1/providers/google/weather') {
      const fetchedAt = Date.now() + (options.googleClockOffset || 0);
      value = { available: true, ephemeral: true, thirdPartyAttributions: [], cityLabel: 'Boston, Massachusetts, US', locationVersion: location.version, fetchedAt, expiresAt: fetchedAt + (options.googleTtl ?? 3590000), weather: [{ date: '2026-10-10', label: 'Sat', high: 20, low: 10, condition: 'Clear' }], attribution };
    }
    else if (path === '/api/v1/providers/google/nearby') value = { available: true, ephemeral: true, thirdPartyAttributions: [], cityLabel: 'Boston, Massachusetts, US', locationVersion: location.version, fetchedAt: Date.now(), expiresAt: Date.now() + 3590000, nearby: [{ title: 'City park', when: 'Park' }], attribution };
    else if (path === '/command') {
      commands.push(input);
      if (input.name === 'family.current') value = current;
      else if (input.name === 'family.publish') {
        try { validateSnapshot(input.input.snapshot, Date.now()); }
        catch { await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Invalid family content' }) }); return; }
        value = { revision: current.revision + 1, status: 'accepted' };
      } else throw new Error('Unexpected command ' + input.name);
    } else throw new Error('Unexpected fixture route ' + path);
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
  });
  await page.goto(origin + '/');
  await page.addScriptTag({ content: common });
  await page.addScriptTag({ content: source });
  await page.evaluate(screens => { window.syntheticScreens = screens; }, options.screens || [{ id: 'synthetic_screen', name: 'Kitchen' }]);
  await page.evaluate(role => {
    window.checks = { errors: [], refreshes: 0 };
    var ui = window.DisplayOSUI;
    var context = {
      ui: ui,
      home: { id: 'synthetic_home', role: role, settings: { timezone: 'UTC' }, screens: window.syntheticScreens },
      principal: { csrf: 'synthetic_csrf' },
      api: function (path, body) { return ui.request(path, { method: body === undefined ? 'GET' : 'POST', body: body, csrf: 'synthetic_csrf' }); },
      command: function (name, input) { return ui.request('/command', { method: 'POST', body: { name: name, input: input } }); },
      tell: function (text) { document.getElementById('notice').textContent = text; },
      run: function (action, success) { return Promise.resolve().then(action).then(function (value) { if (success) return success(value); }).catch(function (error) { window.checks.errors.push(error.status); document.getElementById('notice').textContent = ui.message(error); }); },
      refresh: function () { window.checks.refreshes++; return Promise.resolve(); }
    };
    var panel = window.DisplayOSSources.mount(context);
    if (panel) { document.getElementById('root').appendChild(panel); panel.open = true; }
  }, options.role || 'owner');
  if (options.role !== 'member') await page.getByText('Your assistant can already share information you choose.').waitFor();
  return { requests, commands };
}

test('local preview accepts bounded server clock skew without extending the one-hour local deadline', async () => withBrowser(async page => {
  await mount(page, { available: false, weatherAvailable: true, nearbyAvailable: true }, { googleClockOffset: 10000, googleTtl: 3600000 });
  await page.getByRole('textbox', { name: 'Home address or city' }).fill('Boston');
  await page.getByRole('button', { name: 'Use for weather and nearby places' }).click();
  await page.getByText('Weather and nearby places update on connected screens within about 30 seconds. During quiet hours, tap Show full display on the screen to see them.').waitFor();
  await page.evaluate(() => {
    const originalTimeout = window.setTimeout;
    window.setTimeout = function (callback, delay) {
      if (delay >= 1800000) window.previewTimeout = delay;
      return originalTimeout.apply(window, arguments);
    };
  });
  await page.getByRole('button', { name: 'Preview weather' }).click();
  await page.locator('.google-local-preview').waitFor();
  const delay = await page.evaluate(() => window.previewTimeout);
  assert.ok(delay > 3599000 && delay <= 3600000);
}));

test('local preview rejects excessive server skew and provider TTL before rendering', async () => {
  for (const options of [{ googleClockOffset: 60000, googleTtl: 3600000 }, { googleClockOffset: 0, googleTtl: 3600001 }]) {
    await withBrowser(async page => {
      await mount(page, { available: false, weatherAvailable: true, nearbyAvailable: true }, options);
      await page.getByRole('textbox', { name: 'Home address or city' }).fill('Boston');
      await page.getByRole('button', { name: 'Use for weather and nearby places' }).click();
      await page.getByText('Weather and nearby places update on connected screens within about 30 seconds. During quiet hours, tap Show full display on the screen to see them.').waitFor();
      await page.getByRole('button', { name: 'Preview weather' }).click();
      await page.waitForFunction(() => window.checks.errors.includes(400));
      assert.equal(await page.locator('.google-local-preview').count(), 0);
    });
  }
});

test('real browser shows unavailable sources honestly and never fetches for non-owners', async () => withBrowser(async page => {
  const unavailable = await mount(page, { available: false, configured: false, connected: false, weatherAvailable: false });
  assert.equal(await page.getByRole('button', { name: 'Continue with Google' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Preview weather' }).isDisabled(), true);
  assert.match(await page.locator('body').innerText(), /Direct Google connection is not available/);
  assert.doesNotMatch(await page.locator('body').innerText(), /API key|server|backend|client secret/i);
  assert.deepEqual(unavailable.requests.map(request => request.path).sort(), ['/api/v1/providers/location', '/api/v1/providers/status']);
  await page.unrouteAll();
  const member = await mount(page, { available: true }, { role: 'member' });
  assert.equal(await page.locator('.sources-panel').count(), 0);
  assert.equal(member.requests.length, 0);
}));

test('real browser requires explicit Google choices and rejects an untrusted redirect', async () => withBrowser(async page => {
  const value = await mount(page, { available: true, configured: true, connected: false, weatherAvailable: false }, { googleUrl: 'https://evil.example.com/oauth' });
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  assert.equal(value.requests.length, 2);
  await page.getByRole('checkbox', { name: 'My main Google calendar', exact: true }).check();
  assert.equal(await page.getByRole('checkbox', { name: 'Email subjects from my inbox', exact: true }).isChecked(), false);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await page.waitForFunction(() => window.checks.errors.length === 1);
  assert.equal(page.url(), origin + '/');
  assert.deepEqual(value.requests.find(request => request.path.endsWith('/start')).input, { calendar: true, inbox: false, calendarIds: ['primary'] });
}));

test('calendar preview is private, sharing is separate and explicit publish preserves other content and TTL', async () => withBrowser(async page => {
  const now = Date.now();
  const previous = { schemaVersion: 1, timezone: 'UTC', generatedAt: now, expiresAt: now + 600000, briefing: { title: 'A private note', text: 'Existing family briefing' }, kids: [{ name: 'Sam', items: ['Bring a lunch'] }], photos: ['approved_photo_123'], prompts: ['What made you smile?'] };
  const options = { current: { snapshot: previous, revision: 9 }, calendarTitle: '<img src=x onerror=alert(1)>' };
  const value = await mount(page, { available: true, connected: true, calendar: true, inbox: false, weatherAvailable: false, sharing: { calendar: false, inbox: false } }, options);
  await page.getByRole('button', { name: 'Preview my calendar' }).click();
  await page.getByRole('heading', { name: 'Take a look before sharing' }).waitFor();
  assert.equal(value.commands.length, 0);
  assert.equal(await page.getByRole('button', { name: 'Share to DisplayOS' }).isDisabled(), true);
  assert.equal(await page.locator('.source-preview img').count(), 0);
  assert.match(await page.locator('.source-preview').innerText(), /<img src=x onerror=alert\(1\)>/);
  options.calendarTitle = 'School concert';
  await page.getByRole('checkbox', { name: 'Calendar plans may appear on my screens' }).check();
  await page.getByRole('button', { name: 'Save my sharing choices' }).click();
  await page.getByText('Choices saved. Preview the information you want to bring home.').waitFor();
  assert.equal(value.commands.length, 0);
  await page.getByRole('button', { name: 'Preview my calendar' }).click();
  await page.getByRole('button', { name: 'Share to DisplayOS' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Share to DisplayOS' }).isDisabled(), false);
  await page.getByRole('button', { name: 'Share to DisplayOS' }).click();
  await page.getByText('Update sent. Your screen will confirm when it has shown it.').waitFor();
  assert.equal(value.commands.filter(command => command.name === 'family.publish').length, 1);
  const published = value.commands.find(command => command.name === 'family.publish').input;
  assert.equal(published.expectedRevision, 9);
  assert.equal(published.snapshot.expiresAt, previous.expiresAt);
  assert.deepEqual(published.snapshot.briefing, previous.briefing);
  assert.deepEqual(published.snapshot.kids, previous.kids);
  assert.deepEqual(published.snapshot.photos, previous.photos);
  assert.deepEqual(published.snapshot.prompts, previous.prompts);
  assert.equal(published.snapshot.week.length, 1);
  assert.equal(await page.evaluate(() => window.checks.refreshes), 1);
}));

test('one location field requires explicit consent and Google information never enters durable family publication', async () => withBrowser(async page => {
  const value = await mount(page, { available: false, connected: false, weatherAvailable: true, nearbyAvailable: true });
  assert.equal(await page.getByRole('button', { name: 'Preview weather' }).isDisabled(), true);
  await page.getByRole('textbox', { name: 'Home address or city' }).fill('10 Private Road, Boston');
  await page.getByRole('button', { name: 'Use for weather and nearby places' }).click();
  await page.getByText('Location saved. Your screens will show city weather and nearby places when available.').waitFor();
  assert.deepEqual(value.requests.find(request => request.path.endsWith('/save')).input, { homeId: 'synthetic_home', address: '10 Private Road, Boston', weather: true, nearby: true });
  assert.equal(value.requests.filter(request => request.path.endsWith('/weather')).length, 0);
  await page.getByRole('button', { name: 'Preview weather' }).click();
  await page.getByText(attribution, { exact: true }).waitFor();
  assert.equal(value.commands.length, 0);
  assert.deepEqual(value.requests.find(request => request.path.endsWith('/weather')).input, { homeId: 'synthetic_home' });
  assert.equal(await page.getByRole('button', { name: 'Share to DisplayOS' }).count(), 0);
  assert.doesNotMatch(await page.locator('.google-local-preview').innerText(), /Private Road/);
  assert.equal(await page.locator('.google-attribution').getAttribute('translate'), 'no');
  await page.getByText('Source: Includes weather data from Google', { exact: true }).waitFor();
  await page.evaluate(() => window.dispatchEvent(new Event('offline')));
  assert.equal(await page.locator('.google-local-preview').count(), 0);
  await page.getByRole('button', { name: 'Preview nearby places' }).click();
  await page.getByText('City park: Park').waitFor();
  await page.getByRole('button', { name: 'Remove home location' }).click();
  await page.getByText('Home location removed. New weather and nearby updates are stopped.').waitFor();
  assert.equal(await page.locator('.google-local-preview').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Preview weather' }).isDisabled(), true);
  assert.equal(value.commands.length, 0);
}));

test('inbox publication stops if the owner revokes sharing after the preview', async () => withBrowser(async page => {
  const status = { available: true, connected: true, calendar: false, inbox: true, weatherAvailable: false, sharing: { calendar: false, inbox: true } };
  const value = await mount(page, status);
  await page.getByRole('button', { name: 'Preview inbox reminders' }).click();
  await page.getByRole('heading', { name: 'Take a look before sharing' }).waitFor();
  assert.equal(value.commands.length, 0);
  assert.equal(await page.getByRole('button', { name: 'Share to DisplayOS' }).isDisabled(), false);
  status.sharing.inbox = false;
  await page.getByRole('button', { name: 'Share to DisplayOS' }).click();
  await page.getByText('This is not available for your home. Please check and try again.').waitFor();
  assert.equal(value.commands.length, 0);
  assert.equal(await page.evaluate(() => window.checks.refreshes), 0);
}));

test('expired unrelated private content is never revived when adding selected calendar plans', async () => withBrowser(async page => {
  const previous = { schemaVersion: 1, timezone: 'UTC', generatedAt: Date.now() - 10000, expiresAt: Date.now() - 1, briefing: { title: 'Expired', text: 'Do not revive this private content' } };
  const value = await mount(page, { available: true, connected: true, calendar: true, sharing: { calendar: true, inbox: false } }, { current: { snapshot: previous, revision: 3 } });
  await page.getByRole('button', { name: 'Preview my calendar' }).click();
  await page.getByRole('button', { name: 'Share to DisplayOS' }).waitFor();
  await page.getByRole('button', { name: 'Share to DisplayOS' }).click();
  await page.getByText('Something changed. Refresh and try again.').waitFor();
  assert.equal(value.commands.filter(command => command.name === 'family.current').length, 1);
  assert.equal(value.commands.filter(command => command.name === 'family.publish').length, 0);
}));

test('unit buttons save the home preference and convert preview without another Google request', async () => withBrowser(async page => {
  const value = await mount(page, { available: true, weatherAvailable: true, nearbyAvailable: true });
  await page.getByRole('textbox', { name: 'Home address or city' }).fill('Boston, US');
  await page.getByRole('button', { name: 'Use for weather and nearby places' }).click();
  await page.getByRole('button', { name: 'Preview weather' }).click();
  await page.locator('.google-local-preview').getByText('Sat: Clear, 10°C to 20°C', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Fahrenheit °F', exact: true }).click();
  await page.locator('.google-local-preview').getByText('Sat: Clear, 50°F to 68°F', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Fahrenheit °F', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(value.requests.filter(request => request.path === '/api/v1/home').at(-1).input.input.temperatureUnit, 'fahrenheit');
  assert.equal(value.requests.filter(request => request.path === '/api/v1/providers/google/weather').length, 1);
  await page.getByRole('button', { name: 'Celsius °C', exact: true }).click();
  await page.locator('.google-local-preview').getByText('Sat: Clear, 10°C to 20°C', { exact: true }).waitFor();
  assert.equal(value.requests.filter(request => request.path === '/api/v1/providers/google/weather').length, 1);
}));

test('unconfigured Google still saves owner location privately and permits withdrawing consent', async () => withBrowser(async page => {
  const value = await mount(page, { available: false, weatherAvailable: false, nearbyAvailable: false }, { screens: [] });
  await page.getByRole('textbox', { name: 'Home address or city' }).fill('Boston, US');
  await page.getByRole('button', { name: 'Use for weather and nearby places' }).click();
  await page.getByText('Location saved privately. Google information is not available in this trial yet.').waitFor();
  assert.equal(value.requests.filter(request => request.path.includes('/google/')).length, 0);
  await page.getByRole('button', { name: 'Save privately' }).click();
  await page.getByText('Home location saved privately. It is not being used on your screens.').waitFor();
  assert.deepEqual(value.requests.filter(request => request.path.endsWith('/save')).at(-1).input, { homeId: 'synthetic_home', address: 'Boston, US', weather: false, nearby: false });
  assert.equal(value.commands.length, 0);
}));
