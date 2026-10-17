import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { createTestHarness } from 'wrangler';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const origin = 'https://displayos-ui.example.com';
const hex = () => randomBytes(32).toString('hex');
const config = JSON.parse(await readFile(new URL('../wrangler.json', import.meta.url), 'utf8'));
config.main = process.env.DISPLAYOS_UI_BUNDLE || '.wrangler/bundle/worker.js';
const server = createTestHarness({ workers: [{ config, vars: { PUBLIC_ORIGIN: origin }, secrets: { OWNER_CREDENTIAL: hex(), ENROLLMENT_CODE: hex(), STATE_ENCRYPTION_KEY: hex(), PRODUCT_STATE_KEY: hex(), FACTORY_CREDENTIAL: hex() } }] });
const screenshots = new URL('../../diagnostics/displayos-product/', import.meta.url);
let browser;
let checks = 0;
const errors = [];
let nextOwnerRequestAt = 0;
let ownerRequestDelay = 700;
const check = (value, message) => { assert.ok(value, message); checks++; };
const shown = async (page, selector) => { await page.locator(selector).first().waitFor({ state: 'visible' }); checks++; };
async function fits(page, noScroll = false) {
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Horizontal page overflow');
  if (noScroll) check(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight), 'Tablet view overflows vertically');
}
async function words(page) {
  check(!/\b(API|backend|VPS|server|credential|grant|token|session|revision)\b|owner key|enrollment code|display ID/i.test(await page.locator('body').innerText()), 'Technical language in family UI');
}
async function wake(page) { await page.mouse.click(18, 16); }
async function within(promise, label, timeoutMs = 8000) {
  let timeout;
  try { return await Promise.race([promise, new Promise((resolve, reject) => { timeout = setTimeout(() => reject(new Error(label + ' timed out')), timeoutMs); })]); }
  finally { clearTimeout(timeout); }
}
async function settled(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }
async function screenLabel(page, identifier) {
  const label = page.locator('.screen-identity');
  await label.waitFor({ state: 'visible' });
  check(await label.innerText() === 'Screen ' + identifier, 'Screen label does not match the ordinary home label');
  check(await label.evaluate(element => { const rect = element.getBoundingClientRect(); return rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight && parseFloat(getComputedStyle(element).fontSize) >= 16; }), 'Screen label is clipped or too small to read');
}
async function nightActionBounds(page) {
  const action = page.getByRole('button', { name: 'Show full display', exact: true });
  check(await action.evaluate(button => {
    const bounds = button.getBoundingClientRect();
    const clock = button.parentElement.getBoundingClientRect();
    return Math.abs((bounds.left + bounds.right) / 2 - (clock.left + clock.right) / 2) <= 1 && bounds.width >= 44 && bounds.height >= 42 && bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight;
  }), 'Quiet-hours action is not centered beneath the clock or leaves its visible touch area');
}
async function locationBounds(page) {
  const section = page.locator('.source-location');
  await section.getByRole('button', { name: 'Remove home location', exact: true }).waitFor();
  check(await section.evaluate(element => {
    const primary = element.querySelector('.location-primary-actions');
    const secondary = element.querySelector('.location-secondary-actions');
    const preview = element.querySelector('.location-preview-actions');
    if (!primary || !secondary || !preview) return false;
    const buttons = Array.from(primary.querySelectorAll('button')).map(button => button.getBoundingClientRect());
    const removal = secondary.querySelector('button').getBoundingClientRect();
    const parent = primary.getBoundingClientRect();
    return buttons.length === 2 && getComputedStyle(primary).display === 'grid' && buttons[1].top - buttons[0].bottom >= 11.5 && removal.top - buttons[1].bottom >= 12 && buttons.every(button => Math.abs(button.width - parent.width) <= 1);
  }), 'Location actions touch or primary actions are not full width');
  check(await section.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return Array.from(element.querySelectorAll('button')).every(button => { const bounds = button.getBoundingClientRect(); return bounds.left >= rect.left && bounds.right <= rect.right && bounds.right <= innerWidth && bounds.left >= 0; });
  }), 'Location actions overflow their card or viewport');
  await fits(page);
}
async function identifierViews(page) {
  const now = Date.now();
  const currentSettings = { timezone: 'UTC', quietAfterSeconds: 120, nightStart: '00:00', nightEnd: '00:00', showPhotos: false };
  const snapshot = { schemaVersion: 1, timezone: 'UTC', generatedAt: now, expiresAt: now + 3600000, briefing: { title: 'A private family plan', text: 'For this renderer fixture only.' }, photos: [] };
  let value = { state: 'owned', homeName: 'Private home name', screenName: 'Private kitchen name', screenIdentifier: 'ABC123', settings: currentSettings, snapshot: null, localEnabled: { weather: false, nearby: false }, localRevision: 0 };
  await page.route(origin + '/device/v1/poll', route => route.fulfill({ json: value }));
  await page.route(origin + '/device/v1/ack', route => route.fulfill({ json: { saved: true } }));
  await page.goto(origin + '/screen');
  await screenLabel(page, 'ABC123');
  async function refresh() {
    const response = page.waitForResponse(origin + '/device/v1/poll', { timeout: 8000 });
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await (await response).finished(); await settled(page);
  }
  value = { ...value, snapshot, revision: 1, nonce: 'fixture-render-only' };
  await refresh();
  await page.getByRole('heading', { name: snapshot.briefing.title, exact: true }).waitFor();
  await screenLabel(page, 'ABC123');
  await page.getByRole('button', { name: 'Quiet view', exact: true }).click();
  await shown(page, '.quiet-shell'); await screenLabel(page, 'ABC123');
  value = { ...value, settings: { ...currentSettings, nightEnd: '23:59' } };
  await refresh(); await page.locator('body.night').waitFor();
  await screenLabel(page, 'ABC123');
  check(!/Private home name|Private kitchen name|A private family plan/.test(await page.locator('body').innerText()), 'Night screen label exposes a private room or family name');
  await page.screenshot({ path: fileURLToPath(new URL('identifier-night-landscape.png', screenshots)), fullPage: true });
  await page.setViewportSize({ width: 800, height: 1280 }); await screenLabel(page, 'ABC123');
  await page.screenshot({ path: fileURLToPath(new URL('identifier-night-portrait.png', screenshots)), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await screenLabel(page, 'ABC123');
  value = { ...value, screenIdentifier: 'A'.repeat(32) };
  await refresh(); await screenLabel(page, 'ABC123');
  check(await page.locator('.screen-identity').innerText() !== 'Screen ' + value.screenIdentifier, 'Screen label displays an unsafe long identifier');
}
async function localClockBounds(page) {
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  const now = await page.evaluate(() => Date.now());
  let revision = 1;
  let mode = 'ahead';
  let requests = 0;
  let held;
  let release;
  const localUrl = origin + '/device/v1/local';
  await page.route(origin + '/device/v1/poll', route => route.fulfill({ json: { state: 'owned', homeName: 'Fixture home', screenIdentifier: 'ABC123', snapshot: null, settings: { timezone: 'UTC', quietAfterSeconds: 7200, nightStart: '00:00', nightEnd: '00:00' }, localEnabled: { weather: true, nearby: false }, localRevision: revision } }));
  await page.route(localUrl, async route => {
    requests++;
    if (mode === 'hold-expired') {
      await within(new Promise(resolve => { release = resolve; held(); }), 'Clock fixture response release');
      await route.fulfill({ json: { available: false, localRevision: revision, localEnabled: { weather: true, nearby: false } } }); return;
    }
    const current = await page.evaluate(() => Date.now());
    const expiresAt = current + 3600000 + (mode === 'over-bound' ? 30001 : 10000);
    await route.fulfill({ json: { available: true, ephemeral: true, localRevision: revision, localEnabled: { weather: true, nearby: false }, cityLabel: 'Fixture town', weather: [{ date: new Date(current).toISOString().slice(0, 10), label: 'Today', high: 21, low: 14, condition: 'Clock fixture sunshine' }], nearby: [], attribution: 'Google Maps', weatherSourceAttribution: 'Source: Includes weather data from Google', thirdPartyAttributions: [], expiresAt: mode === 'wrong-type' ? String(expiresAt) : expiresAt } });
  });
  await page.goto(origin + '/screen');
  await page.getByText('Clock fixture sunshine', { exact: false }).first().waitFor();
  check(requests === 1, 'A ten-second server clock lead is rejected or repeatedly fetched');
  mode = 'hold-expired';
  const started = new Promise(resolve => { held = resolve; });
  await page.clock.setSystemTime(new Date(now + 3600000));
  await page.clock.fastForward(1000);
  await within(started, 'Clock fixture refresh start');
  check(await page.getByText('Clock fixture sunshine', { exact: false }).count() === 0, 'Server clock lead extends local retention beyond one hour');
  const expired = page.waitForResponse(localUrl, { timeout: 8000 });
  release(); await (await expired).finished(); await page.clock.runFor(32);
  for (const next of ['over-bound', 'wrong-type']) {
    mode = next; revision++;
    const response = page.waitForResponse(localUrl, { timeout: 8000 });
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await (await response).finished(); await page.clock.runFor(32);
    check(await page.getByText('Clock fixture sunshine', { exact: false }).count() === 0, 'Local expiry accepts excessive clock lead or a nonnumeric deadline: ' + next);
  }
}
async function isolatedClockBounds() {
  const isolated = await browser.newContext();
  try {
    await bridge(isolated);
    const page = await isolated.newPage();
    await page.setViewportSize({ width: 1280, height: 800 });
    await localClockBounds(page);
  } finally { await isolated.close(); }
}
async function delayedLocalResponse() {
  const isolated = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    await bridge(isolated);
    await isolated.addInitScript(() => {
      window.fixtureTimeouts = [];
      const open = XMLHttpRequest.prototype.open;
      const send = XMLHttpRequest.prototype.send;
      XMLHttpRequest.prototype.open = function (method, path) { this.fixturePath = path; return open.apply(this, arguments); };
      XMLHttpRequest.prototype.send = function () { window.fixtureTimeouts.push({ path: this.fixturePath, timeout: this.timeout }); return send.apply(this, arguments); };
    });
    const page = await isolated.newPage();
    let requests = 0;
    let acknowledgements = 0;
    let elapsed = 0;
    await page.route(origin + '/device/v1/poll', route => route.fulfill({ json: { state: 'owned', screenIdentifier: 'ABC123', snapshot: null, settings: { timezone: 'UTC', quietAfterSeconds: 7200, nightStart: '00:00', nightEnd: '00:00' }, localEnabled: { weather: true, nearby: false }, localRevision: 1 } }));
    await page.route(origin + '/device/v1/ack', route => { acknowledgements++; return route.fulfill({ json: { saved: true } }); });
    await page.route(origin + '/device/v1/local', async route => {
      requests++;
      const started = Date.now();
      await within(new Promise(resolve => setTimeout(resolve, 13000)), 'Slow local response', 20000);
      const now = Date.now();
      elapsed = now - started;
      await route.fulfill({ json: { available: true, ephemeral: true, localRevision: 1, localEnabled: { weather: true, nearby: false }, cityLabel: 'Fixture town', weather: [{ date: new Date(now).toISOString().slice(0, 10), label: 'Today', condition: 'Slow fixture sunshine', high: 22, low: 15 }], nearby: [], attribution: 'Google Maps', weatherSourceAttribution: 'Source: Includes weather data from Google', thirdPartyAttributions: [], expiresAt: now + 3600000 } });
    });
    for (const path of ['/api/v1/providers/google/weather', '/api/v1/providers/google/nearby']) await page.route(origin + path, route => route.fulfill({ json: { available: false } }));
    const response = page.waitForResponse(origin + '/device/v1/local', { timeout: 30000 });
    await page.goto(origin + '/screen');
    await (await response).finished();
    await page.getByText('Slow fixture sunshine', { exact: false }).first().waitFor({ timeout: 8000 });
    check(elapsed >= 13000 && requests === 1 && acknowledgements === 0, 'A real thirteen-second local response times out, retries or creates a family receipt');
    await page.evaluate(async () => {
      await window.DisplayOSUI.request('/api/v1/providers/google/weather');
      await window.DisplayOSUI.request('/api/v1/providers/google/nearby');
    });
    check(await page.evaluate(() => {
      const local = ['/device/v1/local', '/api/v1/providers/google/weather', '/api/v1/providers/google/nearby'];
      return local.every(path => window.fixtureTimeouts.some(value => value.path === path && value.timeout === 45000)) && window.fixtureTimeouts.some(value => value.path === '/device/v1/poll' && value.timeout === 12000);
    }), 'Longer provider timeout changes the ordinary screen-poll request budget');
  } finally { await isolated.close(); }
}
async function standbyAndWorst(page) {
  await page.clock.install();
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const longText = 'A family note to read together. '.repeat(8).slice(0, 240);
  const longTitle = 'A family plan with everyone included and time to enjoy the day together. Have fun!'.slice(0, 80);
  const snapshot = { schemaVersion: 1, timezone: 'UTC', generatedAt: now, expiresAt: now + 3600000, briefing: { title: longTitle, text: longText }, kids: Array.from({ length: 3 }, (_, index) => ({ name: 'Child ' + (index + 1), items: [longText, longText, index === 2 ? longText.slice(0, 230) + ' LAST NOTE' : longText] })), parents: Array.from({ length: 3 }, (_, index) => ({ name: 'Parent ' + index, items: [longText, longText, longText] })), news: [{ title: longTitle, summary: longText }, { title: longTitle, summary: longText }], prompts: [longText, longText, longText], reminders: Array.from({ length: 4 }, () => ({ title: longTitle, time: longTitle, person: longTitle })), nearby: Array.from({ length: 3 }, () => ({ title: longTitle, when: longTitle })), week: Array.from({ length: 7 }, (_, index) => ({ date: new Date(now + index * 86400000).toISOString().slice(0, 10), events: [{ title: longTitle, time: longTitle, person: longTitle }, { title: longTitle, time: longTitle, person: longTitle }] })), photos: [] };
  let value = { state: 'owned', homeName: 'Private fixture home', screenName: 'Private fixture kitchen', screenIdentifier: 'ABC123', settings: { timezone: 'UTC', quietAfterSeconds: 30, nightStart: '00:00', nightEnd: '00:00', showPhotos: false }, revision: 1, nonce: 'fixture-only', snapshot, localEnabled: { weather: false, nearby: false }, localRevision: 1 };
  let localRequests = 0;
  const heldPolls = [];
  function holdPoll() {
    let release;
    let started;
    const ready = new Promise(resolve => { started = resolve; });
    heldPolls.push({ started, wait: new Promise(resolve => { release = resolve; }) });
    return { ready, release };
  }
  await page.route(origin + '/device/v1/poll', async route => {
    const response = value;
    const held = heldPolls.shift();
    if (held) { held.started(); await within(held.wait, 'Full display response release'); }
    await route.fulfill({ json: response });
  });
  await page.route(origin + '/device/v1/ack', route => route.fulfill({ json: { saved: true } }));
  await page.route(origin + '/device/v1/local', async route => {
    localRequests++;
    const fetched = await page.evaluate(() => Date.now());
    await route.fulfill({ json: { available: true, ephemeral: true, localRevision: value.localRevision, localEnabled: value.localEnabled, cityLabel: 'Private fixture city', attribution: 'Google Maps', weatherSourceAttribution: 'Source: Includes weather data from Google', thirdPartyAttributions: [], expiresAt: fetched + 3600000, weather: [{ date: today, label: 'Today', condition: 'Approved fixture sunshine', high: 22, low: 15 }], nearby: [{ title: 'Approved fixture library', when: 'Nearby place' }] } });
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(origin + '/screen');
  await page.getByRole('button', { name: 'See all For the kids', exact: true }).waitFor({ timeout: 8000 });
  await isolatedClockBounds();
  await within(page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve))), 'Main renderer animation frame after isolated clock', 2000);
  check(true, 'Isolated boundary clock freezes the main renderer');
  for (const viewport of [{ width: 1280, height: 800 }, { width: 800, height: 1280 }]) {
    await page.setViewportSize(viewport); await wake(page); await fits(page, true);
    await page.getByRole('button', { name: 'See all For the kids', exact: true }).click({ timeout: 8000 });
    await shown(page, '[role=dialog]');
    check((await page.locator('[role=dialog]').innerText()).includes('LAST NOTE'), 'Worst bounded note disappears from the reading sheet');
    await page.locator('.screen-sheet-body').evaluate(element => { element.scrollTop = element.scrollHeight; });
    check(await page.locator('.screen-sheet-body').evaluate(element => element.scrollTop > 0 && element.scrollTop + element.clientHeight >= element.scrollHeight - 2), 'Worst-case reading sheet cannot reach its final note');
    await page.screenshot({ path: fileURLToPath(new URL('standby-worst-' + viewport.width + '.png', screenshots)), fullPage: true });
    const leaving = page.waitForResponse(origin + '/device/v1/poll', { timeout: 8000 });
    await page.keyboard.press('Escape');
    await (await leaving).finished(); await settled(page);
  }
  const short = { ...snapshot, briefing: { title: 'Private fixture family plan', text: 'Approved family information.' }, week: [{ date: today, events: [{ title: 'Walk after lunch', time: '23:58', person: 'Our family' }] }], reminders: [], kids: [], parents: [], news: [], prompts: [], nearby: [] };
  value = { ...value, snapshot: short, revision: 2, localEnabled: { weather: true, nearby: true }, localRevision: 2 };
  const local = page.waitForResponse(origin + '/device/v1/local', { timeout: 8000 });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await (await local).finished(); await settled(page);
  await page.getByRole('button', { name: 'Quiet view', exact: true }).click();
  for (const viewport of [{ width: 1280, height: 800 }, { width: 800, height: 1280 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport); await fits(page, viewport.width > 400);
    check(await page.locator('.quiet-local-weather').isVisible() && await page.locator('.quiet-local-place').isVisible(), 'Approved local information is missing from daytime standby');
    check(await page.locator('.quiet-next').innerText().then(text => text.includes('Walk after lunch') && text.includes('Google Maps') && text.includes('Source: Includes weather data from Google')), 'Standby loses approved family plans or mandatory attribution');
    await screenLabel(page, 'ABC123');
    await page.screenshot({ path: fileURLToPath(new URL('richer-standby-' + viewport.width + '.png', screenshots)), fullPage: true });
  }
  const unitRequests = localRequests;
  check(/22\s*\u00b0C/.test(await page.locator('.quiet-local-weather').innerText()), 'Standby does not default to Celsius');
  value = { ...value, settings: { ...value.settings, temperatureUnit: 'fahrenheit' } };
  let unitsPolled = page.waitForResponse(origin + '/device/v1/poll', { timeout: 8000 });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await (await unitsPolled).finished(); await settled(page);
  check(/72\s*\u00b0F/.test(await page.locator('.quiet-local-weather').innerText()) && /59\s*\u00b0F/.test(await page.locator('.quiet-local-weather').innerText()), 'Standby Fahrenheit does not convert approved Celsius data');
  check(localRequests === unitRequests, 'Changing temperature units fetches paid provider information');
  value = { ...value, localEnabled: { weather: false, nearby: false }, localRevision: 3 };
  let polled = page.waitForResponse(origin + '/device/v1/poll', { timeout: 8000 });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await (await polled).finished(); await settled(page);
  check(await page.locator('.quiet-local').count() === 0, 'Stopping local sharing leaves information in standby');
  value = { ...value, localEnabled: { weather: true, nearby: true }, localRevision: 4, settings: { ...value.settings, nightEnd: '23:59' } };
  polled = page.waitForResponse(origin + '/device/v1/poll', { timeout: 8000 });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await (await polled).finished(); await settled(page);
  const nightCalls = localRequests;
  for (const viewport of [{ width: 1280, height: 800 }, { width: 800, height: 1280 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport); await fits(page, viewport.width > 400);
    await nightActionBounds(page);
    check(await page.locator('.quiet-date').isVisible() && await page.locator('.calendar-grid .today').count() === 1, 'Night standby does not show its public date and calendar');
    check(await page.locator('.quiet-local,.frame-photo,.quiet-next,.briefing,.screen-name,.screen-bar,.local-attribution').count() === 0 && !/Private fixture|Walk after lunch|Approved fixture/.test(await page.locator('body').innerText()), 'Night standby exposes private family or local information');
    await screenLabel(page, 'ABC123');
    await page.screenshot({ path: fileURLToPath(new URL('richer-night-' + viewport.width + '.png', screenshots)), fullPage: true });
  }
  const legacyFlex = await page.evaluate(() => {
    const sheet = Array.from(document.styleSheets).find(value => value.href && value.href.endsWith('/product/style.css'));
    return sheet.insertRule('.screen-shell,.screen-bar,.button,.quiet-shell:not(.night-ambient){row-gap:normal!important;column-gap:normal!important}', sheet.cssRules.length);
  });
  for (const viewport of [{ width: 1280, height: 800 }, { width: 800, height: 1280 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport); await nightActionBounds(page); await fits(page, viewport.width > 400);
    check(await page.locator('.night-ambient').evaluate(element => ['32px', '44px'].includes(getComputedStyle(element).rowGap) && getComputedStyle(element.querySelector('.calendar-grid')).rowGap === '8px'), 'Older flex-gap fallback removes supported clock or calendar grid spacing');
  }
  await page.evaluate(index => Array.from(document.styleSheets).find(value => value.href && value.href.endsWith('/product/style.css')).deleteRule(index), legacyFlex);
  await page.clock.fastForward(65 * 60000);
  check(localRequests === nightCalls, 'Night standby fetches paid local information');
  await page.setViewportSize({ width: 1280, height: 800 });
  const current = await page.evaluate(() => Date.now());
  value = { ...value, snapshot: { ...short, generatedAt: current, expiresAt: current + 3600000, briefing: { title: 'Pre-gesture private family update', text: 'Started before the explicit request.' } }, revision: 3 };
  const previous = holdPoll();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await within(previous.ready, 'Pre-gesture poll start');
  const required = holdPoll();
  await page.evaluate(() => {
    window.fixtureFamilyLeak = false;
    window.fixtureFamilyObserver = new MutationObserver(records => {
      if (records.some(record => Array.from(record.addedNodes).some(node => /Pre-gesture private family update|Private fixture family plan|Walk after lunch/.test(node.textContent)))) window.fixtureFamilyLeak = true;
    });
    window.fixtureFamilyObserver.observe(document.getElementById('screen-root'), { childList: true, subtree: true });
  });
  await page.getByRole('button', { name: 'Show full display', exact: true }).click({ timeout: 8000 });
  check(!/Pre-gesture private family update|Private fixture family plan|Fresh authorised family update|Walk after lunch/.test(await page.locator('body').innerText()), 'Full display reveals cached family information before its fresh authorized response');
  value = { ...value, snapshot: { ...short, generatedAt: current, expiresAt: current + 3600000, briefing: { title: 'Fresh authorised family update', text: 'Delivered only after the explicit request.' } }, revision: 3 };
  const outdated = page.waitForResponse(origin + '/device/v1/poll', { timeout: 8000 });
  previous.release(); await (await outdated).finished();
  await within(required.ready, 'Required post-gesture poll start'); await settled(page);
  check(localRequests === nightCalls && !/Pre-gesture private family update|Fresh authorised family update|Walk after lunch/.test(await page.locator('body').innerText()), 'Pre-gesture response reveals private content or starts a paid request');
  check(await page.evaluate(() => { window.fixtureFamilyObserver.disconnect(); return !window.fixtureFamilyLeak; }), 'Pre-gesture family information flashes before the fresh response');
  const fresh = page.waitForResponse(origin + '/device/v1/poll', { timeout: 8000 });
  const weather = page.waitForResponse(origin + '/device/v1/local', { timeout: 8000 });
  required.release(); await (await fresh).finished(); await (await weather).finished(); await settled(page);
  await page.getByRole('heading', { name: 'Fresh authorised family update', exact: true }).waitFor({ timeout: 8000 });
  check(await page.locator('.family-grid').isVisible() && (await page.locator('body').innerText()).includes('Approved fixture library'), 'Explicit full display does not show fresh family and approved local information');
  check(/72\s*\u00b0F/.test(await page.locator('.weather-now').innerText()), 'Full display ignores the saved Fahrenheit preference');
  await page.getByRole('button', { name: 'Back to quiet hours', exact: true }).click({ timeout: 8000 });
  await page.getByRole('button', { name: 'Show full display', exact: true }).waitFor({ timeout: 8000 });
  check(await page.locator('.family-grid,.frame-photo,.quiet-next,.briefing,.quiet-local,.screen-name,.local-attribution').count() === 0 && !/Private fixture|Fresh authorised family update|Walk after lunch|Approved fixture/.test(await page.locator('body').innerText()), 'Returning to quiet hours leaves private family or local information visible');
  check(value.settings.nightEnd === '23:59', 'Full-display choice changes household quiet-hour settings');
  const closedCalls = localRequests;
  await page.clock.fastForward(65 * 60000);
  check(localRequests === closedCalls, 'Closing the full display continues paid night fetches');
  await delayedLocalResponse();
}
async function temperaturePreference(owner, display, homeId) {
  let localRequests = 0;
  const localRequest = request => { if (request.url() === origin + '/device/v1/local') localRequests++; };
  display.on('request', localRequest);
  try {
    const before = await command(owner, homeId, 'family.current', { deviceId: (await command(owner, homeId, 'home.get')).screens[0].id });
    await owner.getByRole('button', { name: 'Fahrenheit \u00b0F', exact: true }).click();
    await owner.getByText('Temperature choice saved for your screens.', { exact: true }).waitFor();
    check((await command(owner, homeId, 'home.get')).settings.temperatureUnit === 'fahrenheit', 'The owner temperature preference is not persisted');
    let polled = display.waitForResponse(origin + '/device/v1/poll', { timeout: 8000 });
    await wake(display); const result = await polled; await result.finished(); await settled(display);
    check((await result.json()).settings.temperatureUnit === 'fahrenheit' && /72\s*\u00b0F/.test(await display.locator('.weather-now').innerText()), 'The actual service does not propagate Fahrenheit to its screen');
    await owner.reload();
    await owner.getByRole('button', { name: 'Fahrenheit \u00b0F', exact: true }).waitFor();
    check(await owner.getByRole('button', { name: 'Fahrenheit \u00b0F', exact: true }).getAttribute('aria-pressed') === 'true', 'The saved temperature choice is lost after reload');
    await owner.getByRole('button', { name: 'Celsius \u00b0C', exact: true }).click();
    await owner.getByText('Temperature choice saved for your screens.', { exact: true }).waitFor();
    check((await command(owner, homeId, 'home.get')).settings.temperatureUnit === 'celsius', 'Celsius cannot be restored');
    polled = display.waitForResponse(origin + '/device/v1/poll', { timeout: 8000 });
    await wake(display); const restored = await polled; await restored.finished(); await settled(display);
    check((await restored.json()).settings.temperatureUnit === 'celsius' && /22\s*\u00b0C/.test(await display.locator('.weather-now').innerText()), 'The screen does not restore Celsius');
    const after = await command(owner, homeId, 'family.current', { deviceId: (await command(owner, homeId, 'home.get')).screens[0].id });
    check(after.revision === before.revision && after.snapshot.weather[0].high === 22 && localRequests === 0, 'Changing display units alters canonical family data or calls a provider');
  } finally { display.off('request', localRequest); }
}
async function heldRequest(page, path) {
  let release;
  let started;
  let finished;
  let startedAt;
  let captured = false;
  const ready = new Promise(resolve => { started = resolve; });
  const released = new Promise(resolve => { finished = resolve; });
  const handler = async route => {
    if (captured) { await deliver(route); return; }
    captured = true;
    let timeout;
    try {
      await new Promise((resolve, reject) => {
        release = resolve;
        startedAt = Date.now();
        timeout = setTimeout(() => reject(new Error('Held request was not released: ' + path)), 10000);
        started();
      });
      await deliver(route);
    } finally { clearTimeout(timeout); finished(); }
  };
  await page.route(origin + path, handler);
  return {
    async wait() {
      let timeout;
      try { await Promise.race([ready, new Promise((resolve, reject) => { timeout = setTimeout(() => reject(new Error('Held request did not start: ' + path)), 8000); })]); }
      finally { clearTimeout(timeout); }
    },
    async release() { assert.ok(release, 'Held request has not started'); console.log('Recovery gate: release', path, Date.now() - startedAt, 'ms after capture.'); release(); await within(released, 'Held response delivery'); await page.unroute(origin + path, handler); }
  };
}
async function recoveryRace(owner) {
  const previousDelay = ownerRequestDelay;
  ownerRequestDelay = 100;
  nextOwnerRequestAt = Date.now();
  try {
  await owner.getByText('Your sign-in and safety', { exact: true }).click();
  await owner.getByRole('button', { name: 'Make safety codes', exact: true }).click();
  await shown(owner, '.safety-codes');
  const safetyCode = await owner.locator('.safety-codes > div').first().innerText();
  check(await owner.locator('.safety-codes > div').count() > 0, 'Safety codes not shown after deliberate creation');
  await owner.getByRole('button', { name: 'I have saved them', exact: true }).click();
  await owner.locator('.safety-codes').waitFor({ state: 'hidden' });
  await settled(owner);
  console.log('Recovery gate: safety codes saved.');
  const oldRefresh = await heldRequest(owner, '/api/v1/home');
  await owner.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await oldRefresh.wait();
  console.log('Recovery gate: old screen request held.');
  const oldHomes = await heldRequest(owner, '/api/v1/homes');
  await owner.evaluate(() => { location.hash = 'returning-home'; });
  await oldHomes.wait();
  console.log('Recovery gate: old home list held.');
  await owner.getByRole('button', { name: 'Sign out', exact: true }).click();
  await shown(owner, '#your-name');
  console.log('Recovery gate: signed out.');
  await owner.getByText('Lost access to your phone?', { exact: true }).click();
  await owner.locator('#safety-code').fill(safetyCode);
  await owner.getByRole('button', { name: 'Use my safety code', exact: true }).click();
  await owner.getByRole('button', { name: 'Save a new sign-in', exact: true }).waitFor(); checks++;
  console.log('Recovery gate: one-use code restored sign-in.');
  await owner.getByRole('button', { name: 'Save a new sign-in', exact: true }).click();
  await owner.getByText('Your new sign-in is saved.', { exact: true }).waitFor();
  await owner.getByRole('heading', { name: 'The green house', exact: true }).waitFor();
  console.log('Recovery gate: replacement sign-in and home ready.');
  const lateRefresh = owner.waitForResponse(response => response.url() === origin + '/api/v1/home' && [401, 403].includes(response.status()), { timeout: 10000 });
  const lateHomes = owner.waitForResponse(response => response.url() === origin + '/api/v1/homes' && [401, 403].includes(response.status()), { timeout: 10000 });
  await Promise.all([oldRefresh.release(), oldHomes.release()]);
  const responses = await Promise.all([lateRefresh, lateHomes]);
  for (const response of responses) { check([401, 403].includes(response.status()), 'Old sign-in is not rejected after recovery'); await response.finished(); }
  await settled(owner);
  check(await owner.getByRole('heading', { name: 'The green house', exact: true }).isVisible(), 'Late old response replaces the recovered home');
  check(await owner.locator('#your-name').count() === 0, 'Late old response restores the signed-out form');
  check((await ownerApi(owner, '/api/v1/me')).status === 200, 'Late response from the old sign-in replaces the recovered sign-in');
  } finally { ownerRequestDelay = previousDelay; }
}
async function screenPairing(page) {
  return page.evaluate(async () => {
    const response = await fetch('/device/v1/pairing', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + sessionStorage.getItem('displayos-demo-device-token') }, body: '{}' });
    if (!response.ok) throw new Error('The actual practice screen cannot get its pairing code');
    return response.json();
  });
}
async function bridge(context) {
  await context.route(origin + '/**', deliver);
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
}
async function deliver(route) {
    const request = route.request();
    const headers = { ...request.headers(), 'CF-Connecting-IP': '192.0.2.93' };
    delete headers.host; delete headers['content-length'];
    delete headers['sec-fetch-site'];
    if (new URL(request.url()).pathname.startsWith('/api/v1/')) {
      const readyAt = Math.max(Date.now(), nextOwnerRequestAt);
      nextOwnerRequestAt = readyAt + ownerRequestDelay;
      if (readyAt > Date.now()) await new Promise(resolve => setTimeout(resolve, readyAt - Date.now()));
    }
    const response = await server.getWorker().fetch(request.url(), { method: request.method(), headers, body: request.postData() || undefined, redirect: 'manual' });
    const responseHeaders = Object.fromEntries(response.headers);
    const rawCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
    if (rawCookies.length) responseHeaders['set-cookie'] = rawCookies.join('\n');
    try { await route.fulfill({ status: response.status, headers: responseHeaders, body: Buffer.from(await response.arrayBuffer()) }); }
    catch (error) { console.error('Bridge delivery failed:', request.url(), request.postData(), error.message); errors.push(error.message); }
}
async function ownerApi(page, path, body) {
  return page.evaluate(async ({ path, body }) => {
    const me = await fetch('/api/v1/me').then(response => response.json());
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-DisplayOS-CSRF': me.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  }, { path, body });
}
async function command(page, homeId, name, input = {}) {
  const result = await ownerApi(page, '/api/v1/home', { homeId, command: name, input });
  assert.equal(result.status, 200, 'Home command failed: ' + name + ' ' + JSON.stringify(result.value));
  return result.value;
}
async function protocol(path, body, headers = {}) {
  const response = await server.getWorker().fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.94', ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  return { status: response.status, value: await response.json() };
}
async function localOverlay(page, owner, homeId, deviceId, homeSettings) {
  let flags = { weather: false, nearby: false };
  let sourceRevision = 10;
  let mode = 'ok';
  let requests = 0;
  let acknowledgements = 0;
  let failPoll = false;
  let release;
  let held;
  let expiry = 3600000;
  const localUrl = origin + '/device/v1/local';
  const pollUrl = origin + '/device/v1/poll';
  const countAck = request => { if (request.url() === origin + '/device/v1/ack') acknowledgements++; };
  page.on('request', countAck);
  await page.route(pollUrl, async route => {
    if (failPoll) { failPoll = false; await route.fulfill({ status: 403, json: { error: 'Synthetic transport rejection' } }); return; }
    const headers = { ...route.request().headers(), 'CF-Connecting-IP': '192.0.2.93' };
    delete headers.host; delete headers['sec-fetch-site'];
    const response = await server.getWorker().fetch(pollUrl, { headers, redirect: 'manual' });
    const value = await response.json();
    if (response.ok && value.state === 'owned') Object.assign(value, { localEnabled: { ...flags }, localRevision: sourceRevision });
    await route.fulfill({ status: response.status, json: value });
  });
  await page.route(localUrl, async route => {
    requests++;
    const now = await page.evaluate(() => Date.now());
    const response = { available: true, localEnabled: { ...flags }, localRevision: sourceRevision, weather: [{ date: new Date(now).toISOString().slice(0, 10), label: 'Today', condition: 'Local fixture sunshine', high: 23, low: 14 }], nearby: [{ title: mode === 'hold' ? 'Stale fixture place' : 'Local fixture library', when: 'Nearby place', url: 'https://untrusted.example.test/' }], cityLabel: 'Fixture town', attribution: 'Google Maps', weatherSourceAttribution: 'Source: Includes weather data from Google', thirdPartyAttributions: [], expiresAt: now + expiry, ephemeral: true, address: 'DO NOT DISPLAY PRIVATE ADDRESS', coordinates: [1, 2] };
    if (mode === 'hold') { held = true; await within(new Promise(resolve => { release = resolve; }), 'Local response release'); }
    else if (mode === 'error') { await route.fulfill({ status: 503, json: { error: 'Synthetic bounded provider failure' } }); return; }
    else if (mode === 'unavailable') response.available = false;
    else if (mode === 'third-party') response.thirdPartyAttributions = ['Unsupported attribution'];
    await route.fulfill({ json: response });
  });
  async function poll() {
    const response = page.waitForResponse(pollUrl);
    await wake(page); await response;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  }
  async function day() {
    const button = page.getByRole('button', { name: 'Our day', exact: true });
    if (await button.count()) await button.click();
  }
  async function refresh(nextMode = 'ok') {
    mode = nextMode; sourceRevision++;
    const response = page.waitForResponse(localUrl);
    await poll();
    const delivered = await response;
    await delivered.finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await day();
    return delivered;
  }
  await poll();
  check(requests === 0, 'Unconsented local content makes a provider request');
  flags = { weather: true, nearby: true };
  await refresh();
  await page.getByText('Local fixture library', { exact: false }).waitFor(); checks++;
  check((await command(owner, homeId, 'family.current', { deviceId })).snapshot === null, 'Local overlay invents a family snapshot');
  check(acknowledgements === 0, 'Local-only content sends a family rendering receipt');
  check(await page.locator('.local-attribution [translate=no]').count() >= 5, 'Google sources are not associated with local weather and nearby content');
  check(await page.locator('.week-tile').innerText().then(text => text.includes('Source: Includes weather data from Google')), 'Weather omits its required source line');
  check(await page.locator('.local-attribution span').first().evaluate(element => { const style = getComputedStyle(element); return style.fontSize === '12px' && style.fontWeight === '400' && style.whiteSpace === 'nowrap' && style.color === 'rgb(255, 255, 255)'; }), 'Google Maps text attribution is not legible or preserved');
  check(!(await page.locator('body').innerText()).includes('DO NOT DISPLAY PRIVATE ADDRESS') && await page.locator('[href*="untrusted"],[src*="untrusted"]').count() === 0, 'Local overlay uses a full address or unchecked external URL');
  check(await page.evaluate(() => !JSON.stringify([Object.entries(sessionStorage), Object.entries(localStorage)]).includes('Fixture town')), 'Local Google content is persisted in browser storage');
  await fits(page, true); await words(page);
  await page.screenshot({ path: fileURLToPath(new URL('local-landscape.png', screenshots)), fullPage: true });
  await page.setViewportSize({ width: 800, height: 1280 });
  await fits(page, true);
  check(await page.locator('.week-tile .local-attribution').isVisible(), 'Portrait weather hides its source attribution');
  await page.screenshot({ path: fileURLToPath(new URL('local-portrait.png', screenshots)), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.clock.fastForward(54 * 60000);
  await poll();
  check(requests === 1, 'Owned screen refreshes paid local sources before its hourly window');
  const hourly = page.waitForResponse(localUrl);
  await page.clock.fastForward(2 * 60000); await hourly;
  check(requests === 2, 'Hourly local refresh never runs');
  await day();
  await page.getByText('Local fixture library', { exact: false }).waitFor();
  await contextOffline(true);
  check(!(await page.locator('body').innerText()).includes('Local fixture'), 'Local Google content survives offline');
  const offlineCount = requests;
  await page.clock.fastForward(60 * 60000);
  check(requests === offlineCount, 'Offline screen requests paid local content');
  await contextOffline(false);
  await refresh();
  await page.getByText('Local fixture library', { exact: false }).waitFor();
  await command(owner, homeId, 'home.update', { settings: { ...homeSettings, nightStart: '00:00', nightEnd: '23:59' } });
  await poll();
  await page.locator('body.night').waitFor();
  check(await page.locator('.local-attribution').count() === 0 && !(await page.locator('body').innerText()).includes('Fixture town'), 'Night view leaks local weather, places or city');
  const nightCount = requests;
  await page.clock.fastForward(60 * 60000);
  check(requests === nightCount, 'Night screen calls paid local sources');
  await command(owner, homeId, 'home.update', { settings: { ...homeSettings, quietAfterSeconds: 30, nightStart: '00:00', nightEnd: '00:00' } });
  await refresh();
  await page.getByText('Local fixture library', { exact: false }).waitFor();
  flags = { weather: false, nearby: false }; sourceRevision++;
  const beforeStop = requests;
  await poll();
  check(requests === beforeStop && await page.locator('.local-attribution').count() === 0, 'Consent removal does not clear local content without another paid request');
  flags = { weather: true, nearby: true };
  expiry = 2000;
  const expiringLocal = await refresh();
  await page.getByText('Local fixture library', { exact: false }).waitFor();
  const localDeadline = (await expiringLocal.json()).expiresAt;
  await page.clock.fastForward(Math.max(0, localDeadline - await page.evaluate(() => Date.now())) + 2000);
  await page.waitForFunction(() => !document.querySelector('.local-attribution'));
  check(await page.locator('.local-attribution').count() === 0, 'Local content survives its own expiry');
  expiry = 3600000;
  await refresh('error');
  check(await page.locator('.local-attribution').count() === 0, 'Provider failure keeps stale local content');
  const firstFailure = requests;
  await page.clock.fastForward(4 * 60000);
  check(requests === firstFailure, 'Local errors retry before five minutes');
  let retried = page.waitForResponse(localUrl);
  await page.clock.fastForward(61000); await retried;
  check(requests === firstFailure + 1, 'First local retry does not run after five minutes');
  await page.clock.fastForward(9 * 60000);
  check(requests === firstFailure + 1, 'Repeated local errors do not increase retry backoff');
  retried = page.waitForResponse(localUrl);
  await page.clock.fastForward(61000); await retried;
  check(requests === firstFailure + 2, 'Second local retry does not run after ten minutes');
  await refresh('unavailable');
  check(await page.locator('.local-attribution').count() === 0, 'Unavailable local service presents a working connection');
  await refresh('third-party');
  check(await page.locator('.local-attribution').count() === 0, 'Unsupported third-party attribution is silently discarded');
  mode = 'hold'; held = false; sourceRevision++;
  await poll();
  await page.waitForFunction(() => true);
  for (let attempt = 0; !held && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
  check(held && typeof release === 'function', 'Late-response fixture did not begin');
  flags = { weather: false, nearby: false }; sourceRevision++;
  await poll(); release();
  await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 50)));
  check(!(await page.locator('body').innerText()).includes('Stale fixture place'), 'Late local response survives consent revision change');
  flags = { weather: true, nearby: true };
  await refresh();
  await page.getByText('Local fixture library', { exact: false }).waitFor();
  failPoll = true;
  await poll();
  check(await page.locator('.local-attribution').count() === 0, 'Transport authorization failure keeps local data');
  check(acknowledgements === 0 && (await command(owner, homeId, 'family.current', { deviceId })).revision === 0, 'Local refresh changes family revision or rendering receipt');
  await page.unroute(pollUrl); await page.unroute(localUrl);
  page.off('request', countAck);
  await page.clock.setSystemTime(new Date());
  await poll(); await day();
  async function contextOffline(value) { await page.context().setOffline(value); await page.evaluate(value => window.dispatchEvent(new Event(value ? 'offline' : 'online')), value); }
}
async function pairingCountdown(page) {
  const expiry = await page.evaluate(() => Date.now() + 2500);
  const legacy = { code: 'ABCDEF123456', expiresAt: expiry };
  let release;
  let started;
  const pending = new Promise(resolve => { started = resolve; });
  await page.route(origin + '/device/v1/poll', route => route.fulfill({ json: { state: 'unclaimed', pairing: legacy } }), { times: 1 });
  await page.route(origin + '/device/v1/pairing', async route => {
    started(); await within(new Promise(resolve => { release = resolve; }), 'Pairing response release');
    await route.fulfill({ json: { code: 'A'.repeat(32), manualCode: '001234', expiresAt: await page.evaluate(() => Date.now() + 120000) } });
  }, { times: 1 });
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.getByText(legacy.code, { exact: true }).waitFor(); checks++;
  check(await page.locator('.pair-countdown').getAttribute('role') === 'timer' && await page.locator('.pair-countdown').getAttribute('aria-live') === 'off', 'Code countdown interrupts screen readers');
  check(await page.evaluate(expiry => { const seconds = Math.max(0, Math.ceil((expiry - Date.now()) / 1000)); return document.querySelector('.pair-countdown').textContent === 'This code changes in ' + Math.floor(seconds / 60) + ':' + ('0' + seconds % 60).slice(-2) + '.'; }, expiry), 'Legacy code countdown does not follow expiresAt');
  await page.clock.fastForward(3500); await within(pending, 'Pairing request start');
  check(await page.locator('.pair-code,.qr').count() === 0 && !(await page.locator('body').innerText()).includes(legacy.code), 'Expired code or QR remains usable while its replacement is pending');
  release();
  await page.getByText('001 234', { exact: true }).waitFor(); checks++;
  check(await page.locator('.pair-code').getAttribute('aria-label') === 'Six numbers on your screen: 0 0 1 2 3 4', 'Regenerated six-digit code drops leading zeros');
  await page.clock.setSystemTime(new Date());
  await page.reload(); await shown(page, '.qr svg');
}
try {
  await mkdir(screenshots, { recursive: true });
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  context.setDefaultTimeout(45000);
  await bridge(context);
  const owner = await context.newPage();
  owner.on('requestfailed', request => console.error('Browser request failed:', request.url(), request.failure()));
  owner.on('dialog', dialog => dialog.accept());
  const cdp = await context.newCDPSession(owner);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  if (process.env.DISPLAYOS_UI_STANDBY_ONLY === '1') {
    await standbyAndWorst(owner);
    check(errors.length === 0, 'Browser errors: ' + errors.join('; '));
    console.log(checks + ' targeted standby and worst-case reading checks passed with actual product assets and fixture content. No paid Google or physical tablet proof.');
  } else if (process.env.DISPLAYOS_UI_LOCATION_ONLY === '1') {
    await owner.goto(origin + '/home');
    await owner.locator('#your-name').fill('Morgan');
    await owner.getByRole('button', { name: 'Get started', exact: true }).click();
    await owner.locator('#home-name').fill('The green house');
    await owner.getByRole('button', { name: 'Make my home', exact: true }).click();
    await shown(owner, '#screen-code');
    await owner.getByText('Things to bring home', { exact: true }).click();
    await owner.getByRole('textbox', { name: 'Home address or city', exact: true }).fill('Boston, MA, USA');
    await owner.getByRole('button', { name: 'Save privately', exact: true }).click();
    await owner.getByText('Home location saved privately. It is not being used on your screens.', { exact: true }).waitFor();
    for (const width of [1440, 800, 390]) {
      await owner.setViewportSize({ width, height: 900 });
      await locationBounds(owner);
      await owner.screenshot({ path: fileURLToPath(new URL('location-actions-' + width + '.png', screenshots)), fullPage: true });
    }
    check(errors.length === 0, 'Browser errors: ' + errors.join('; '));
    console.log(checks + ' targeted location action layout checks passed with actual workerd and disposable WebAuthn. No paid Google calls.');
  } else if (process.env.DISPLAYOS_UI_IDENTIFIER_ONLY === '1') {
    await owner.setViewportSize({ width: 1280, height: 800 });
    await identifierViews(owner);
    await isolatedClockBounds();
    check(errors.length === 0, 'Browser errors: ' + errors.join('; '));
    console.log(checks + ' targeted screen identifier renderer checks passed using fixture content and actual product assets. No physical tablet proof.');
  } else if (process.env.DISPLAYOS_UI_AUTH_ONLY === '1') {
    await owner.goto(origin + '/home');
    await owner.locator('#your-name').fill('Morgan');
    await owner.getByRole('button', { name: 'Get started', exact: true }).click();
    await owner.locator('#home-name').fill('The green house');
    await owner.getByRole('button', { name: 'Make my home', exact: true }).click();
    await shown(owner, '#screen-code');
    await recoveryRace(owner);
    check(errors.length === 0, 'Browser errors: ' + errors.join('; '));
    console.log(checks + ' targeted real workerd recovery checks passed.');
  } else {
  await owner.goto(origin + '/home');
  await shown(owner, '#your-name'); await words(owner); await fits(owner);
  await owner.screenshot({ path: fileURLToPath(new URL('welcome-phone.png', screenshots)), fullPage: true });
  await owner.locator('#your-name').fill('Morgan');
  await owner.getByRole('button', { name: 'Get started', exact: true }).click();
  await shown(owner, '#home-name');
  check(await owner.locator('input[type=password]').count() === 0, 'Family sign-in asks for a password');
  await owner.locator('#home-name').fill('The green house');
  await owner.getByRole('button', { name: 'Make my home', exact: true }).click();
  await shown(owner, '#screen-code'); await words(owner);
  const homeList = await ownerApi(owner, '/api/v1/homes');
  const homeId = homeList.value.homes[0].id;
  const home = await command(owner, homeId, 'home.get');
  home.settings.timezone = 'UTC';
  await command(owner, homeId, 'home.update', { settings: { ...home.settings, quietAfterSeconds: 30, nightStart: '00:00', nightEnd: '00:00' } });
  await owner.getByText('Things to bring home', { exact: true }).click();
  await owner.getByRole('textbox', { name: 'Home address or city', exact: true }).waitFor(); checks++;
  await owner.getByRole('textbox', { name: 'Home address or city', exact: true }).fill('Boston, MA, USA');
  await owner.getByRole('button', { name: 'Save privately', exact: true }).click();
  await owner.getByText('Home location saved privately. It is not being used on your screens.', { exact: true }).waitFor(); checks++;
  const privateLocation = await ownerApi(owner, '/api/v1/providers/location', { homeId });
  check(privateLocation.value.location.address === 'Boston, MA, USA' && !privateLocation.value.location.weather && !privateLocation.value.location.nearby, 'A home without a screen cannot save its location without Google consent');
  await locationBounds(owner);
  await owner.getByText('Things to bring home', { exact: true }).click();
  const display = await context.newPage();
  await display.clock.install();
  await display.addInitScript(() => { delete Promise.prototype.finally; });
  await display.setViewportSize({ width: 1280, height: 800 });
  await display.goto(origin + '/home');
  await display.getByText('Try it on this computer', { exact: true }).click();
  await display.getByRole('button', { name: 'Try this screen', exact: true }).click();
  await display.waitForURL(origin + '/screen');
  await shown(display, '.qr svg');
  await pairingCountdown(display);
  check(await display.evaluate(async () => {
    let runs = 0;
    const value = await Promise.resolve('kept').finally(() => { runs++; return Promise.resolve(); });
    let rejection;
    try { await Promise.reject('kept error').finally(() => { runs++; }); } catch (error) { rejection = error; }
    let cleanupError;
    try { await Promise.resolve().finally(() => { throw 'cleanup error'; }); } catch (error) { cleanupError = error; }
    return value === 'kept' && rejection === 'kept error' && cleanupError === 'cleanup error' && runs === 2;
  }), 'Legacy Promise.finally fallback breaks settled values or cleanup');
  const pairing = await screenPairing(display);
  const code = (await display.locator('.pair-code').innerText()).replace(/\s/g, '');
  check(/^[0-9]{6}$/.test(code) && code === pairing.manualCode, 'Live six-number screen code missing');
  check((await display.locator('.pair-code').innerText()) === code.slice(0, 3) + ' ' + code.slice(3), 'Manual code is not grouped three and three');
  check(/^[A-F0-9]{32}$/.test(pairing.code) && pairing.code !== code, 'QR does not have its separate strong code');
  check(await display.evaluate(strongCode => {
    const matrix = window.qrcode(0, 'M'); matrix.addData(location.origin + '/home#claim=' + encodeURIComponent(strongCode)); matrix.make();
    let path = '';
    for (let row = 0; row < matrix.getModuleCount(); row++) for (let column = 0; column < matrix.getModuleCount(); column++) if (matrix.isDark(row, column)) path += 'M' + column + ',' + row + 'h1v1h-1z';
    return document.querySelector('.qr path').getAttribute('d') === path;
  }, pairing.code), 'Displayed QR uses the short manual code instead of its strong code');
  check(await display.locator('.pair-code').getAttribute('aria-label') === 'Six numbers on your screen: ' + code.split('').join(' '), 'Screen reader cannot read individual code digits');
  await words(display); await fits(display, true);
  await display.screenshot({ path: fileURLToPath(new URL('pair-screen.png', screenshots)), fullPage: true });
  let hashRefresh = owner.waitForResponse(response => response.url() === origin + '/api/v1/home' && response.request().postDataJSON().command === 'home.get');
  await owner.evaluate(code => { location.hash = 'pair=' + code; }, pairing.code);
  await hashRefresh;
  await owner.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await owner.waitForFunction(() => !document.getElementById('screen-code')); checks++;
  check((await command(owner, homeId, 'home.get')).screens.length === 0, 'Returning QR fragment claims the screen automatically');
  check(!(await owner.locator('body').innerText()).includes(pairing.code), 'Phone exposes the long scanned code as a manual task');
  hashRefresh = owner.waitForResponse(response => response.url() === origin + '/api/v1/home' && response.request().postDataJSON().command === 'home.get');
  await owner.evaluate(() => { location.hash = ''; });
  await hashRefresh;
  await owner.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await shown(owner, '#screen-code');
  check(await owner.getByLabel('Six numbers on your screen', { exact: true }).getAttribute('inputmode') === 'numeric', 'Manual code does not use a numeric keyboard');
  await owner.locator('#screen-code').fill('12345');
  await owner.getByRole('button', { name: 'This is my screen', exact: true }).click();
  await owner.getByText('Enter the six numbers shown on your screen.', { exact: true }).waitFor(); checks++;
  const zeroProbe = code === '012345' ? '012346' : '012345';
  await owner.locator('#screen-code').fill(zeroProbe.slice(0, 3) + '-' + zeroProbe.slice(3));
  check(await owner.locator('#screen-code').count() === 1 && await owner.locator('.pair-slots span').count() === 6, 'Manual code is split into multiple input fields');
  check((await owner.locator('.pair-slots').innerText()).replace(/\s/g, '') === zeroProbe, 'Six-slot entry changes pasted numbers or leading zeros');
  check(await owner.locator('.pair-slots').getAttribute('aria-hidden') === 'true' && await owner.locator('#screen-code').getAttribute('aria-describedby') === 'screen-code-hint', 'Single code field duplicates screen-reader digit announcements');
  const zeroResponse = owner.waitForResponse(response => response.url() === origin + '/api/v1/claim');
  await owner.getByRole('button', { name: 'This is my screen', exact: true }).click();
  const rejectedZero = await zeroResponse;
  check(rejectedZero.request().postDataJSON().code === zeroProbe && !rejectedZero.ok(), 'Manual normalization loses a leading zero');
  check((await command(owner, homeId, 'home.get')).screens.length === 0, 'Incorrect manual code unexpectedly claims a screen');
  await owner.locator('#screen-code').fill(code.slice(0, 3) + ' - ' + code.slice(3));
  const manualClaim = owner.waitForResponse(response => response.url() === origin + '/api/v1/claim');
  await owner.getByRole('button', { name: 'This is my screen', exact: true }).click();
  check((await manualClaim).request().postDataJSON().code === code, 'Grouped manual code is not normalized before claiming');
  await owner.getByRole('heading', { name: 'One last tap on your screen.', exact: true }).waitFor(); checks++;
  await display.getByRole('button', { name: 'Yes, this is my home', exact: true }).waitFor(); checks++;
  check((await command(owner, homeId, 'home.get')).screens.length === 0, 'Phone claim bypasses physical possession confirmation');
  await display.getByRole('button', { name: 'Yes, this is my home', exact: true }).click();
  await owner.getByRole('heading', { name: 'Invite your helper', exact: true }).waitFor(); checks++;
  const connectedHome = await command(owner, homeId, 'home.get');
  const deviceId = connectedHome.screens[0].id;
  await shown(owner, '.home-screens .screen-card');
  check(await owner.getByText('Screen ' + deviceId.slice(-6).toUpperCase(), { exact: true }).isVisible(), 'Identical screen names cannot be told apart');
  check(await owner.locator('.home-sources[open]').count() === 1 && await owner.locator('details:not(.home-sources)[open]').count() === 0, 'Home opens all secondary settings instead of a calm main view');
  await owner.getByLabel('Screen name', { exact: true }).fill('Kitchen');
  await owner.getByRole('button', { name: 'Save screen name', exact: true }).click();
  await owner.getByRole('heading', { name: 'Kitchen', exact: true }).waitFor(); checks++;
  check((await command(owner, homeId, 'home.get')).screens[0].name === 'Kitchen', 'Screen name is not saved by the actual service');
  check((await command(owner, homeId, 'family.current', { deviceId })).revision === 0, 'Renaming creates family content or changes its revision');
  await owner.reload();
  await owner.getByRole('heading', { name: 'Kitchen', exact: true }).waitFor(); checks++;
  await wake(display);
  await display.locator('.screen-name').filter({ hasText: 'Kitchen' }).waitFor(); checks++;
  await screenLabel(display, deviceId.slice(-6).toUpperCase());
  let currentRevision = 0;
  await owner.getByRole('textbox', { name: 'Home address or city', exact: true }).waitFor(); checks++;
  await words(owner); await fits(owner);
  await owner.screenshot({ path: fileURLToPath(new URL('home-phone.png', screenshots)), fullPage: true });
  await localOverlay(display, owner, homeId, deviceId, home.settings);
  await isolatedClockBounds();
  await delayedLocalResponse();
  for (const viewport of [{ width: 1280, height: 800, columns: 3 }, { width: 1440, height: 900, columns: 3 }, { width: 800, height: 1280, columns: 2 }, { width: 390, height: 844, columns: 1 }]) {
    await owner.setViewportSize({ width: viewport.width, height: viewport.height });
    await locationBounds(owner);
    await owner.getByText('Make it feel like home', { exact: true }).click();
    await fits(owner);
    const layout = await owner.evaluate(() => {
      const root = document.getElementById('home-root');
      const cards = Array.from(root.children).filter(element => element.matches('.sheet,details'));
      return { width: root.getBoundingClientRect().width, columns: getComputedStyle(root).gridTemplateColumns.split(' ').length, right: Math.max(...cards.map(card => card.getBoundingClientRect().right)), cardWidth: Math.min(...cards.map(card => card.getBoundingClientRect().width)), formWidth: Math.max(...Array.from(root.querySelectorAll('.field input,.field select')).map(field => field.getBoundingClientRect().width)) };
    });
    check(layout.width >= viewport.width - 2, 'My home is still restricted to a narrow centered column');
    check(layout.columns === viewport.columns, 'My home does not use the expected responsive card grid');
    check(layout.right >= viewport.width - (viewport.width >= 1200 ? 34 : viewport.width >= 760 ? 26 : 22), 'Home cards leave unused desktop width');
    check(layout.cardWidth >= 280 && layout.formWidth <= 600, 'Home cards or forms are not readable at this width');
    await owner.screenshot({ path: fileURLToPath(new URL('home-' + viewport.width + '.png', screenshots)), fullPage: true });
    await owner.getByText('Make it feel like home', { exact: true }).click();
  }
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const snapshot = { schemaVersion: 1, timezone: 'UTC', generatedAt: now, expiresAt: now + 3600000, briefing: { title: 'A little more time together', text: 'A quiet start, then a walk after school.' }, weather: [{ date: today, label: 'At home', high: 22, low: 15, condition: 'A little sunshine' }], week: Array.from({ length: 7 }, (_, index) => ({ date: new Date(now + index * 86400000).toISOString().slice(0, 10), events: index ? [] : [{ title: 'Walk in the park', time: '18:00', person: 'Everyone' }] })), reminders: [{ title: 'Water the plants', time: 'After breakfast', person: 'Morgan' }], kids: [{ name: 'Alex', items: ['Bring a library book'] }], parents: [{ name: 'Morgan', items: ['Choose a weekend plan'] }], news: [{ title: 'The local library is open', summary: 'A small story for this disposable test.' }], prompts: ['What made you smile today?'], nearby: [{ title: 'Market morning', when: 'Saturday' }], photos: [] };
  await command(owner, homeId, 'family.publish', { deviceId, snapshot, expectedRevision: 0, idempotencyKey: randomBytes(24).toString('base64url') });
  currentRevision = 1;
  await wake(display);
  await display.getByRole('heading', { name: snapshot.briefing.title, exact: true }).waitFor(); checks++;
  await screenLabel(display, deviceId.slice(-6).toUpperCase());
  await temperaturePreference(owner, display, homeId);
  check(await display.locator('.family-tile').count() === 8, 'Family modules missing');
  await words(display); await fits(display, true);
  check(await display.locator('[data-clock]').innerText() !== '', 'Local clock missing');
  await display.screenshot({ path: fileURLToPath(new URL('day-landscape.png', screenshots)), fullPage: true });
  await assert.doesNotReject(async () => {
    await display.waitForFunction(async ({ homeId, deviceId }) => {
      const me = await fetch('/api/v1/me').then(response => response.json());
      const receipt = await fetch('/api/v1/home', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DisplayOS-CSRF': me.csrf }, body: JSON.stringify({ homeId, command: 'revision.status', input: { deviceId, revision: 1 } }) }).then(response => response.json());
      return receipt.status === 'rendered';
    }, { homeId, deviceId }, { polling: 1000 });
  }); checks++;
  for (const viewport of [{ width: 800, height: 1280 }, { width: 390, height: 844 }]) {
    await display.setViewportSize(viewport); await fits(display, viewport.width > 400);
    await display.screenshot({ path: fileURLToPath(new URL('day-' + viewport.width + '.png', screenshots)), fullPage: true });
  }
  await display.setViewportSize({ width: 1280, height: 800 });
  const longText = 'A family note to read together. '.repeat(8).slice(0, 240);
  const longTitle = 'A family plan with everyone included and time to enjoy the day together. Have fun!'.slice(0, 80);
  check(longText.length === 240 && longTitle.length === 80, 'Worst-case fixture does not reach schema text limits');
  const worst = { ...snapshot, generatedAt: Date.now(), expiresAt: Date.now() + 3600000, briefing: { title: longTitle, text: longText }, kids: Array.from({ length: 3 }, (_, index) => ({ name: 'Child ' + (index + 1), items: [longText, longText, index === 2 ? longText.slice(0, 230) + ' LAST NOTE' : longText] })), parents: Array.from({ length: 3 }, (_, index) => ({ name: 'Grown-up ' + (index + 1), items: [longText, longText, longText] })), news: [{ title: longTitle, summary: longText }, { title: longTitle, summary: longText }], prompts: [longText, longText, longText], reminders: Array.from({ length: 4 }, () => ({ title: longTitle, time: longTitle, person: longTitle })), nearby: Array.from({ length: 3 }, () => ({ title: longTitle, when: longTitle })), week: snapshot.week.map(day => ({ date: day.date, events: [{ title: longTitle, time: longTitle, person: longTitle }, { title: longTitle, time: longTitle, person: longTitle }] })) };
  await command(owner, homeId, 'family.publish', { deviceId, snapshot: worst, expectedRevision: currentRevision, idempotencyKey: randomBytes(24).toString('base64url') }); currentRevision++;
  await wake(display);
  await display.getByRole('heading', { name: longTitle, exact: true }).first().waitFor();
  for (const viewport of [{ width: 1280, height: 800 }, { width: 800, height: 1280 }]) {
    await display.setViewportSize(viewport); await fits(display, true);
    await display.getByRole('button', { name: 'See all For the kids', exact: true }).click();
    await shown(display, '[role=dialog]');
    check((await display.locator('[role=dialog]').innerText()).includes('LAST NOTE'), 'Maximum bounded family note is lost');
    await display.locator('.screen-sheet-body').evaluate(element => { element.scrollTop = element.scrollHeight; });
    check(await display.locator('.screen-sheet-body').evaluate(element => element.scrollTop > 0 && element.scrollTop + element.clientHeight >= element.scrollHeight - 2), 'Full-card sheet cannot scroll to the final note');
    await display.screenshot({ path: fileURLToPath(new URL('long-notes-' + viewport.width + '.png', screenshots)), fullPage: true });
    await display.keyboard.press('Escape'); await display.locator('[role=dialog]').waitFor({ state: 'hidden' }); checks++;
  }
  await command(owner, homeId, 'family.publish', { deviceId, snapshot: { ...snapshot, generatedAt: Date.now(), expiresAt: Date.now() + 3600000 }, expectedRevision: currentRevision, idempotencyKey: randomBytes(24).toString('base64url') }); currentRevision++;
  await wake(display);
  await display.setViewportSize({ width: 1280, height: 800 });
  await display.getByRole('heading', { name: snapshot.briefing.title, exact: true }).waitFor();
  await display.getByRole('button', { name: 'Quiet view', exact: true }).click();
  await shown(display, '.quiet-shell');
  await screenLabel(display, deviceId.slice(-6).toUpperCase());
  check(await display.locator('.calendar-grid .today').count() === 1, 'Today missing from local calendar');
  await words(display); await fits(display, true);
  await display.screenshot({ path: fileURLToPath(new URL('quiet-landscape.png', screenshots)), fullPage: true });
  await display.getByRole('button', { name: 'Our day', exact: true }).click();
  const invitation = await command(owner, homeId, 'member.invite');
  await owner.evaluate(({ code, homeId }) => { location.hash = 'invite=' + encodeURIComponent(code) + '&home=' + encodeURIComponent(homeId); }, { code: invitation.code, homeId });
  await owner.getByRole('button', { name: 'Join this home', exact: true }).waitFor(); checks++;
  check((await command(owner, homeId, 'home.get')).members.length === 1, 'Invitation fragment accepts membership automatically');
  const invitedRefresh = Promise.all([owner.waitForResponse(response => response.url() === origin + '/api/v1/home' && response.request().postDataJSON().command === 'home.get'), owner.waitForResponse(response => response.url() === origin + '/api/v1/connections/pending')]);
  await owner.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await invitedRefresh;
  await owner.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  check(await owner.getByRole('button', { name: 'Join this home', exact: true }).isVisible(), 'Foreground refresh replaces explicit invitation confirmation');
  await owner.goto(origin + '/home');
  const client = await protocol('/oauth/register', { client_name: 'The test helper', redirect_uris: ['https://assistant.example.test/return'], token_endpoint_auth_method: 'none', scope: 'display:read content:write settings:write media:write' });
  check(client.status === 201, 'OAuth client registration failed');
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(24).toString('base64url');
  const authorization = new URL('/oauth/authorize', origin);
  Object.entries({ response_type: 'code', client_id: client.value.client_id, redirect_uri: 'https://assistant.example.test/return', state, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), resource: origin + '/mcp', scope: 'display:read content:write settings:write media:write' }).forEach(([key, value]) => authorization.searchParams.set(key, value));
  let callback;
  await context.route('https://assistant.example.test/**', async route => { callback = new URL(route.request().url()); await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Test helper</title><p>Returned to the disposable test helper.</p>' }); });
  const ownerCookies = (await context.cookies(origin)).map(cookie => cookie.name + '=' + cookie.value).join('; ');
  let requestedConnection = await server.getWorker().fetch(authorization.href, { redirect: 'manual', headers: { Cookie: ownerCookies, 'CF-Connecting-IP': '192.0.2.93' } });
  check(requestedConnection.status === 302, 'Authorization does not redirect to the family approval page');
  for (const rawCookie of requestedConnection.headers.getSetCookie()) {
    const cookie = rawCookie.split(';')[0]; const separator = cookie.indexOf('=');
    await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), domain: new URL(origin).hostname, path: '/', httpOnly: true, secure: true, sameSite: 'Lax' }]);
  }
  const deniedLocation = requestedConnection.headers.get('location');
  const deniedIntentId = new URLSearchParams(new URL(deniedLocation).hash.slice(1)).get('connect');
  async function requestConnection() {
    const cookies = (await context.cookies(origin)).map(cookie => cookie.name + '=' + cookie.value).join('; ');
    authorization.searchParams.set('state', randomBytes(24).toString('base64url'));
    return server.getWorker().fetch(authorization.href, { redirect: 'manual', headers: { Cookie: cookies, 'CF-Connecting-IP': '192.0.2.93' } });
  }
  for (let index = 0; index < 7; index++) check((await requestConnection()).status === 302, 'Actual pending connection capacity is unavailable early');
  check((await requestConnection()).status === 429, 'Actual pending capacity does not fill at eight requests');
  await owner.goto(deniedLocation);
  await owner.waitForFunction(() => Array.from(document.querySelectorAll('button')).filter(button => button.textContent === 'Not now').length === 1); checks++;
  await owner.getByRole('button', { name: 'Not now', exact: true }).waitFor();
  await context.route(origin + '/api/v1/connections/deny', route => route.abort('failed'), { times: 1 });
  await owner.getByRole('button', { name: 'Not now', exact: true }).click();
  await owner.getByText('We cannot connect right now. Please try again.', { exact: true }).waitFor(); checks++;
  check(await owner.getByRole('button', { name: 'Allow this assistant', exact: true }).isVisible(), 'Failed denial hides the permission panel');
  check((await ownerApi(owner, '/api/v1/connections/pending')).value.intents.length === 8, 'Failed denial changes actual pending connections');
  check(!callback, 'Failed denial returns to the assistant');
  await owner.getByRole('button', { name: 'Not now', exact: true }).click();
  await owner.waitForURL('https://assistant.example.test/**'); checks++;
  check(callback.searchParams.get('error') === 'access_denied' && callback.searchParams.get('state') === state && callback.searchParams.get('iss') === origin && !callback.searchParams.has('code'), 'Denied assistant callback loses OAuth error, state or issuer');
  await owner.goto(deniedLocation);
  await owner.reload();
  await owner.getByRole('heading', { name: 'Invite your helper', exact: true }).waitFor();
  const afterDenial = (await ownerApi(owner, '/api/v1/connections/pending')).value.intents;
  check(afterDenial.length === 7 && !afterDenial.some(intent => intent.id === deniedIntentId), 'Not now does not cancel the actual server intent');
  check(await owner.getByRole('button', { name: 'Allow this assistant', exact: true }).count() === 0, 'Denied request returns after reloading its original link');
  check((await ownerApi(owner, '/api/v1/connections/approve', { intentId: deniedIntentId, homeId, deviceIds: [deviceId], scopes: ['display:read', 'content:write'], duration: 86400 })).status === 403, 'A denied intent can still be approved');
  check((await requestConnection()).status === 302, 'Denial does not free actual pending connection capacity');
  await owner.goto(origin + '/home');
  await owner.getByRole('button', { name: 'Not now', exact: true }).first().click();
  await owner.getByText('This assistant request has been cancelled.', { exact: true }).waitFor(); checks++;
  check(owner.url() === origin + '/home' && (await ownerApi(owner, '/api/v1/connections/pending')).value.intents.length === 7, 'Pending-list denial redirects unexpectedly or fails to cancel');
  for (const intent of (await ownerApi(owner, '/api/v1/connections/pending')).value.intents) {
    check((await ownerApi(owner, '/api/v1/connections/deny', { intentId: intent.id })).value.cancelled === true, 'Pending test connection cannot be cancelled');
  }
  check((await ownerApi(owner, '/api/v1/connections/pending')).value.intents.length === 0, 'Cancelled requests persist on the server');
  authorization.searchParams.set('state', state);
  const approvalCookies = (await context.cookies(origin)).map(cookie => cookie.name + '=' + cookie.value).join('; ');
  requestedConnection = await server.getWorker().fetch(authorization.href, { redirect: 'manual', headers: { Cookie: approvalCookies, 'CF-Connecting-IP': '192.0.2.93' } });
  check(requestedConnection.status === 302, 'A fresh connection cannot begin after cancellation');
  await owner.goto(requestedConnection.headers.get('location'));
  await owner.waitForFunction(() => Array.from(document.querySelectorAll('button')).filter(button => button.textContent === 'Allow this assistant').length === 1); checks++;
  await owner.getByRole('button', { name: 'Allow this assistant', exact: true }).waitFor(); checks++;
  check(await owner.getByLabel('How long can it help?', { exact: true }).inputValue() === '2592000', 'Assistant approval does not default to 30 days');
  check(!(await owner.getByLabel('Change the screen view and quiet hours', { exact: true }).isChecked()), 'Settings changes start approved');
  check(!(await owner.getByLabel('Add photos for this home', { exact: true }).isChecked()), 'Photo sharing starts approved');
  await owner.getByLabel('How long can it help?', { exact: true }).selectOption({ label: 'For today' });
  await owner.getByText('It can help for today. Stop it anytime.', { exact: true }).waitFor(); checks++;
  await owner.getByLabel('How long can it help?', { exact: true }).selectOption({ label: 'For 30 days' });
  await owner.getByText('It can help for 30 days. Stop it anytime.', { exact: true }).waitFor(); checks++;
  await words(owner);
  check((await command(owner, homeId, 'home.get')).grants.length === 0, 'Connection request grants access without approval');
  await owner.getByRole('button', { name: 'Allow this assistant', exact: true }).click();
  await owner.waitForURL('https://assistant.example.test/**');
  check(callback.searchParams.get('state') === state, 'OAuth callback state changed');
  const exchange = await protocol('/oauth/token', new URLSearchParams({ grant_type: 'authorization_code', client_id: client.value.client_id, redirect_uri: 'https://assistant.example.test/return', code: callback.searchParams.get('code'), code_verifier: verifier, resource: origin + '/mcp' }).toString(), { 'Content-Type': 'application/x-www-form-urlencoded' });
  check(exchange.status === 200 && typeof exchange.value.access_token === 'string', 'Approved OAuth exchange failed');
  check(exchange.value.expires_in <= 900 && typeof exchange.value.refresh_token === 'string', 'Finite consent does not use short-lived renewable access');
  const mcpHeaders = { Authorization: 'Bearer ' + exchange.value.access_token, Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' };
  const initialized = await protocol('/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Product UI test helper', version: '1.0.0' } } }, mcpHeaders);
  check(initialized.status === 200 && initialized.value.result.serverInfo.name === 'DisplayOS', 'Real MCP initialization failed');
  const published = await protocol('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'family_publish', arguments: { deviceId, snapshot: { ...snapshot, generatedAt: Date.now(), expiresAt: Date.now() + 3600000, briefing: { title: 'Your helper brought the day home', text: 'A real authorized test helper sent this family update.' } }, expectedRevision: currentRevision, idempotencyKey: randomBytes(24).toString('base64url') } } }, mcpHeaders);
  check(published.status === 200 && published.value.result.isError === false, 'Authorized helper cannot publish');
  currentRevision++;
  await wake(display);
  await display.getByRole('heading', { name: 'Your helper brought the day home', exact: true }).waitFor(); checks++;
  await owner.goto(origin + '/home');
  await owner.getByRole('button', { name: 'Stop this assistant', exact: true }).waitFor();
  const approved = (await command(owner, homeId, 'home.get')).grants[0];
  check(approved.expiresAt - Date.now() > 2591900000 && approved.expiresAt - Date.now() <= 2592000000, 'Actual consent does not last 30 days');
  check(approved.scopes.length === 2 && approved.scopes.includes('content:write') && approved.scopes.includes('display:read'), 'Unchecked permissions were approved');
  check((await owner.locator('.status-pill').allTextContents()).some(text => /Allowed until .*\d{4}.*\d.*:/.test(text)), 'Assistant end time omits its calendar date');
  await owner.getByRole('button', { name: 'Stop this assistant', exact: true }).click();
  await owner.getByText('This assistant can no longer update your screen.', { exact: true }).waitFor(); checks++;
  await owner.getByRole('button', { name: 'Stop this assistant', exact: true }).waitFor({ state: 'hidden' });
  const stopped = await protocol('/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, mcpHeaders);
  check([401, 403].includes(stopped.status), 'Stopped helper retains access');
  await owner.getByText('Favorite faces', { exact: true }).click();
  const photoBytes = await owner.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 853;
    const context = canvas.getContext('2d'); const pixels = context.createImageData(canvas.width, canvas.height);
    let seed = 123456;
    for (let index = 0; index < pixels.data.length; index += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      pixels.data[index] = seed & 255; pixels.data[index + 1] = (seed >>> 8) & 255; pixels.data[index + 2] = (seed >>> 16) & 255; pixels.data[index + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    return canvas.toDataURL('image/jpeg', .9).split(',')[1];
  });
  const choosingPhoto = owner.waitForEvent('filechooser');
  await owner.getByRole('button', { name: 'Choose photos', exact: true }).click();
  await (await choosingPhoto).setFiles({ name: 'private-test-photo.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(photoBytes, 'base64') });
  await owner.getByText('Your chosen photo has been sent to your screens.', { exact: true }).waitFor(); checks++;
  const exported = await command(owner, homeId, 'home.export');
  check(exported.photos.length === 1, 'Selected photo upload did not reach actual home storage');
  const mediaId = exported.photos[0].id || exported.photos[0].mediaId;
  const savedImage = await command(owner, homeId, 'media.get', { mediaId });
  check(exported.photos[0].data === savedImage.data && exported.photos[0].mime === 'image/jpeg', 'Export omits normalized image bytes');
  check(!JSON.stringify(exported.photos).includes('chunks') && Buffer.from(exported.photos[0].data, 'base64').subarray(0, 2).equals(Buffer.from([255, 216])), 'Image export contains storage chunks instead of an actual JPEG');
  const afterPhoto = await command(owner, homeId, 'family.current', { deviceId });
  currentRevision = afterPhoto.revision;
  check(afterPhoto.snapshot.briefing.title === 'Your helper brought the day home', 'Adding a chosen photo replaced the existing family briefing');
  await owner.reload();
  await owner.getByText('Favorite faces', { exact: true }).click();
  await shown(owner, '.photo-catalog img');
  check(await owner.getByRole('button', { name: 'Remove this photo', exact: true }).count() === 1, 'Chosen photo cannot be managed after reload');
  await command(owner, homeId, 'family.publish', { deviceId, snapshot: { ...snapshot, generatedAt: Date.now(), expiresAt: Date.now() + 3600000, photos: [mediaId] }, expectedRevision: currentRevision, idempotencyKey: randomBytes(24).toString('base64url') });
  currentRevision++;
  await display.getByRole('button', { name: 'Quiet view', exact: true }).click();
  await shown(display, '.frame-photo.is-visible');
  check((await display.locator('.frame-photo.is-visible').getAttribute('src')).startsWith('blob:'), 'Photo uses an unapproved remote location');
  await command(owner, homeId, 'home.update', { settings: { ...home.settings, nightStart: '00:00', nightEnd: '23:59' } });
  await wake(display);
  await display.locator('body.night').waitFor(); checks++;
  await screenLabel(display, deviceId.slice(-6).toUpperCase());
  check(!(await display.locator('body').innerText()).includes('Kitchen'), 'Night label shows the private screen name');
  check(await display.locator('.frame-photo,.quiet-next,.briefing,.quiet-local,.screen-name,.screen-bar,.local-attribution').count() === 0, 'Private family items remain in the night DOM');
  check(await display.locator('.quiet-date').isVisible() && await display.locator('.calendar-grid .today').count() === 1, 'Public night date or calendar is missing');
  check(!(await display.locator('body').innerText()).includes(snapshot.briefing.title), 'Night view leaks the briefing');
  await command(owner, homeId, 'home.update', { settings: { ...home.settings, quietAfterSeconds: 30, nightStart: '00:00', nightEnd: '00:00' } });
  await wake(display);
  await display.locator('body:not(.night)').waitFor();
  await owner.goto(origin + '/home');
  await recoveryRace(owner);
  if (!(await owner.locator('.home-sources').evaluate(element => element.open))) await owner.getByText('Things to bring home', { exact: true }).click();
  await owner.getByText('Direct Google connection is not available in this trial yet. Your assistant can still share approved family plans.', { exact: true }).waitFor(); checks++;
  check(await owner.getByRole('button', { name: 'Continue with Google', exact: true }).count() === 0, 'Unconfigured Google offers an apparently working connection');
  check(await owner.getByRole('button', { name: 'Preview weather', exact: true }).isDisabled(), 'Unconfigured weather offers a working action');
  await words(owner); await fits(owner);
  const fresh = Date.now();
  const privateExpiry = fresh + 120000;
  await command(owner, homeId, 'family.publish', { deviceId, snapshot: { ...snapshot, generatedAt: fresh, expiresAt: privateExpiry }, expectedRevision: currentRevision, idempotencyKey: randomBytes(24).toString('base64url') });
  await display.getByRole('button', { name: 'Our day', exact: true }).click();
  await wake(display);
  await display.getByRole('heading', { name: snapshot.briefing.title, exact: true }).waitFor();
  await display.waitForFunction(async ({ homeId, deviceId, revision }) => {
    const me = await fetch('/api/v1/me').then(response => response.json());
    const receipt = await fetch('/api/v1/home', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DisplayOS-CSRF': me.csrf }, body: JSON.stringify({ homeId, command: 'revision.status', input: { deviceId, revision } }) }).then(response => response.json());
    return receipt.status === 'rendered';
  }, { homeId, deviceId, revision: currentRevision + 1 }, { polling: 500 });
  await context.setOffline(true);
  await display.clock.fastForward(Math.max(0, privateExpiry - await display.evaluate(() => Date.now())) + 2000);
  await display.getByRole('heading', { name: snapshot.briefing.title, exact: true }).waitFor({ state: 'hidden' }); checks++;
  check(await display.locator('.frame-photo').count() === 0, 'Expired photo survives offline');
  check(await display.evaluate(() => !Object.keys(sessionStorage).some(key => /snapshot|family|photo|cache/i.test(key))), 'Browser saves private family content');
  await display.clock.setSystemTime(new Date());
  await context.setOffline(false);
  await owner.goto(origin + '/home');
  await owner.getByText('Your screens', { exact: true }).click();
  await owner.getByRole('button', { name: 'Remove this screen', exact: true }).click();
  await wake(display);
  await shown(display, '.pair-code');
  check((await command(owner, homeId, 'home.get')).screens.length === 0, 'Removed screen remains attached');
  check(await display.locator('.family-tile,.frame-photo').count() === 0, 'Reset leaves family content visible');
  await words(display);
  const newPairing = await screenPairing(display);
  await owner.evaluate(code => { location.hash = 'pair=' + code; }, newPairing.code);
  await owner.waitForFunction(() => !document.getElementById('screen-code')); checks++;
  const qrClaim = owner.waitForResponse(response => response.url() === origin + '/api/v1/claim');
  await owner.getByRole('button', { name: 'This is my screen', exact: true }).click();
  check((await qrClaim).request().postDataJSON().code === newPairing.code, 'QR claim does not use its strong code');
  await display.getByRole('button', { name: 'Yes, this is my home', exact: true }).waitFor(); checks++;
  check((await command(owner, homeId, 'home.get')).screens.length === 0, 'QR claim skips physical confirmation');
  await display.getByRole('button', { name: 'Yes, this is my home', exact: true }).click();
  await owner.getByRole('heading', { name: 'Invite your helper', exact: true }).waitFor();
  check((await command(owner, homeId, 'home.get')).screens.length === 1, 'Strong QR cannot finish pairing');
  await owner.getByText('Your screens', { exact: true }).click();
  await owner.getByRole('button', { name: 'Remove this screen', exact: true }).click();
  await wake(display);
  await shown(display, '.pair-code');
  check((await command(owner, homeId, 'home.get')).screens.length === 0, 'QR trial cleanup leaves an attached screen');
  await owner.goto(origin + '/home');
  await owner.getByText('Your information', { exact: true }).click();
  const downloaded = owner.waitForEvent('download');
  await owner.getByRole('button', { name: 'Download home information', exact: true }).click();
  const download = await downloaded;
  check(download.suggestedFilename() === 'displayos-home.json', 'Information download is not available');
  const downloadedHome = JSON.parse(await readFile(await download.path(), 'utf8'));
  check(downloadedHome.photos[0].data === savedImage.data, 'Downloaded home information loses actual image copies');
  await owner.getByRole('button', { name: 'Delete this home', exact: true }).click();
  await shown(owner, '#home-name');
  check((await ownerApi(owner, '/api/v1/homes')).value.homes.length === 0, 'Deleted home still appears in account');
  await owner.getByText('Your sign-in and safety', { exact: true }).click();
  await owner.getByRole('button', { name: 'Delete my account', exact: true }).click();
  await owner.getByRole('heading', { name: 'Your account has been deleted.', exact: true }).waitFor(); checks++;
  check((await ownerApi(owner, '/api/v1/me')).status === 401, 'Deleted account remains authenticated');
  check(errors.length === 0, 'Browser errors: ' + errors.join('; '));
  console.log(checks + ' DisplayOS product browser checks passed against real local workerd with disposable WebAuthn. Screenshots: diagnostics/displayos-product. No live customer consent or tablet qualification.');
  }
} catch (error) {
  if (browser) for (const context of browser.contexts()) for (const page of context.pages()) {
    if (page.url().startsWith(origin + '/home')) { try { console.error('Family page state:', await page.locator('h1,h2,#message').allTextContents()); } catch {} }
  }
  console.error('Browser errors:', errors);
  throw error;
} finally {
  if (browser) await browser.close();
  await server.close();
}
