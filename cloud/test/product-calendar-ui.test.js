import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const root = new URL('../product-public/', import.meta.url);
const assets = Object.fromEntries(await Promise.all(['common.js', 'screen.js', 'design-system.css', 'style.css', 'details.css', 'pairing.css'].map(async filename => [filename, await readFile(new URL(filename, root), 'utf8')])));
const origin = 'https://calendar.example.com';
const now = Date.parse('2026-10-10T16:00:00Z');
const dates = Array.from({ length: 7 }, (unused, index) => '2026-10-' + String(10 + index));
const settings = { timezone: 'UTC', nightStart: '07:00', nightEnd: '07:00', quietAfterSeconds: 1800, showPhotos: false, temperatureUnit: 'celsius' };

async function withCalendar(options, callback) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 600, height: 480 } });
    page.setDefaultTimeout(4000);
    const requests = [];
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let pollStatus = 200;
    let envelope = {
      state: 'owned', revision: options.family ? 1 : 0, nonce: 'fixture-nonce', homeName: 'Fixture home', screenName: 'Kitchen', screenIdentifier: 'ABC123',
      settings, localRevision: 1, localEnabled: { weather: !options.family, nearby: false },
      snapshot: options.family ? {
        schemaVersion: 1, timezone: 'UTC', generatedAt: now, expiresAt: now + 60000,
        briefing: { title: 'Shared family plans', text: 'Approved for this screen' },
        week: dates.map((date, index) => ({ date, events: [
          { time: '09:00', title: 'Shared morning event ' + index + ' ' + 'W'.repeat(45), person: 'Family' },
          { time: '18:00', title: 'Shared evening event ' + index + ' ' + 'W'.repeat(45), person: 'Family' }
        ] }))
      } : null
    };
    await page.route(origin + '/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/screen') {
        await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/product/design-system.css"><link rel="stylesheet" href="/product/style.css"><link rel="stylesheet" href="/product/details.css"><link rel="stylesheet" href="/product/pairing.css"></head><body class="display"><main id="screen-root"></main><p id="screen-status" role="status"></p></body></html>' });
        return;
      }
      if (path.startsWith('/product/')) {
        const filename = path.slice('/product/'.length);
        await route.fulfill({ contentType: filename.endsWith('.css') ? 'text/css' : 'text/javascript', body: assets[filename] });
        return;
      }
      requests.push({ path, method: request.method(), body: request.postDataJSON() });
      if (path === '/device/v1/poll') await route.fulfill({ status: pollStatus, contentType: 'application/json', body: JSON.stringify(pollStatus === 200 ? envelope : {}) });
      else if (path === '/device/v1/local') await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
        available: true, ephemeral: true, localRevision: envelope.localRevision, localEnabled: envelope.localEnabled,
        attribution: 'Google Maps', weatherSourceAttribution: 'Source: Includes weather data from Google', thirdPartyAttributions: [],
        expiresAt: now + (options.localLifetimeMs || 60000), cityLabel: 'Fixture town', nearby: [],
        weather: dates.map(date => ({ date, label: date, low: 10, high: 20, condition: 'W'.repeat(80) }))
      }) });
      else if (path === '/device/v1/ack') await route.fulfill({ contentType: 'application/json', body: '{}' });
      else { await route.fulfill({ status: 400, contentType: 'application/json', body: '{}' }); }
    });
    await page.goto(origin + '/screen');
    await page.clock.install({ time: new Date(now) });
    await page.evaluate(() => sessionStorage.setItem('displayos-demo-device-token', 'fixture-display-token'));
    await page.addScriptTag({ content: assets['common.js'] });
    await page.addScriptTag({ content: assets['screen.js'] });
    await page.getByRole('button', { name: 'See all This week', exact: true }).waitFor();
    if (!options.family) await page.getByText('W'.repeat(80), { exact: true }).first().waitFor({ state: 'attached' });
    async function poll() {
      const response = page.waitForResponse(origin + '/device/v1/poll');
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await (await response).finished();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
    await callback({ page, requests, poll, change: value => { envelope = { ...envelope, ...value }; }, fail: status => { pollStatus = status; } });
    assert.deepEqual(errors, []);
    assert.ok(requests.every(request => ['/device/v1/poll', '/device/v1/local', '/device/v1/ack'].includes(request.path)), 'Calendar interaction must not enroll, confirm, reset or change credentials');
  } finally {
    await browser.close();
  }
}

test('local-only calendar See all survives the immediate pointerdown poll and subsequent unchanged polls', async () => {
  await withCalendar({}, async ({ page, poll }) => {
    const control = page.getByRole('button', { name: 'See all This week', exact: true });
    const bounds = await control.boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    const response = page.waitForResponse(origin + '/device/v1/poll');
    await page.mouse.down();
    await (await response).finished();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.mouse.up();
    const dialog = page.getByRole('dialog', { name: 'This week', exact: true });
    await dialog.waitFor();
    assert.equal(await dialog.locator('.week-day').count(), 7);
    await poll();
    assert.equal(await dialog.isVisible(), true);
  });
});

test('valid calendar expands all fourteen shared events and keeps keyboard focus across unchanged polls', async () => {
  await withCalendar({ family: true }, async ({ page, poll }) => {
    const control = page.getByRole('button', { name: 'See all This week', exact: true });
    await control.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'This week', exact: true });
    await dialog.waitFor();
    assert.equal(await dialog.locator('.week-day p').count(), 14);
    assert.match(await dialog.textContent(), /Shared evening event 6/);
    assert.equal(await page.locator('#screen-root').getAttribute('aria-hidden'), 'true');
    await poll();
    assert.equal(await dialog.isVisible(), true);
    await page.keyboard.press('Tab');
    assert.equal(await dialog.locator('.screen-sheet-body').evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await dialog.getByRole('button', { name: 'Back to our day', exact: true }).evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('Escape');
    assert.equal(await dialog.count(), 0);
    assert.equal(await control.evaluate(element => element === document.activeElement), true);
    assert.equal(await page.locator('#screen-root').getAttribute('aria-hidden'), null);
  });
});

test('expired shared events close the reading sheet even while polling fails', async () => {
  await withCalendar({ family: true }, async ({ page, fail, poll }) => {
    await page.getByRole('button', { name: 'See all This week', exact: true }).click();
    await page.getByRole('dialog', { name: 'This week', exact: true }).waitFor();
    fail(503); await poll();
    await page.clock.fastForward(61000);
    await page.waitForFunction(() => !document.querySelector('.screen-sheet'));
    assert.doesNotMatch(await page.locator('body').textContent(), /Shared (?:morning|evening) event/);
  });
});

test('expired local-only calendar closes without retaining an indefinitely frozen copy', async () => {
  await withCalendar({ localLifetimeMs: 3000 }, async ({ page }) => {
    await page.getByRole('button', { name: 'See all This week', exact: true }).click();
    await page.getByRole('dialog', { name: 'This week', exact: true }).waitFor();
    assert.match(await page.getByRole('dialog').textContent(), /W{80}/);
    await page.clock.fastForward(3100);
    await page.waitForFunction(() => !document.querySelector('.screen-sheet'));
    assert.doesNotMatch(await page.locator('body').textContent(), /W{80}/);
  });
});

for (const status of [401, 403]) {
  test('device authorization HTTP ' + status + ' clears an expanded calendar', async () => {
    await withCalendar({ family: true }, async ({ page, fail, poll }) => {
      await page.getByRole('button', { name: 'See all This week', exact: true }).click();
      await page.getByRole('dialog', { name: 'This week', exact: true }).waitFor();
      fail(status); await poll();
      assert.equal(await page.getByRole('dialog').count(), 0);
      assert.doesNotMatch(await page.locator('body').textContent(), /Shared (?:morning|evening) event/);
      assert.equal(await page.getByRole('heading', { name: 'Your screen needs a hand.', exact: true }).isVisible(), true);
    });
  });
}

test('night entry closes expanded events and preserves the private quiet view', async () => {
  await withCalendar({ family: true }, async ({ page, change, poll }) => {
    await page.getByRole('button', { name: 'See all This week', exact: true }).click();
    await page.getByRole('dialog', { name: 'This week', exact: true }).waitFor();
    change({ settings: { ...settings, nightStart: '12:00', nightEnd: '18:00' } }); await poll();
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.doesNotMatch(await page.locator('body').textContent(), /Shared (?:morning|evening) event/);
    assert.equal(await page.locator('body').evaluate(element => element.classList.contains('night')), true);
  });
});

test('changed local authority clears the reading sheet instead of preserving revoked local data', async () => {
  await withCalendar({}, async ({ page, change, poll }) => {
    await page.getByRole('button', { name: 'See all This week', exact: true }).click();
    await page.getByRole('dialog', { name: 'This week', exact: true }).waitFor();
    change({ localRevision: 2, localEnabled: { weather: false, nearby: false } }); await poll();
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.doesNotMatch(await page.locator('body').textContent(), /W{80}/);
  });
});

test('returning to unclaimed clears the calendar and retains the existing six-digit pairing screen', async () => {
  await withCalendar({ family: true }, async ({ page, change, poll }) => {
    await page.getByRole('button', { name: 'See all This week', exact: true }).click();
    await page.getByRole('dialog', { name: 'This week', exact: true }).waitFor();
    change({ state: 'unclaimed', pairing: { code: 'A'.repeat(32), manualCode: '123456', expiresAt: now + 120000 } }); await poll();
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.doesNotMatch(await page.locator('body').textContent(), /Shared (?:morning|evening) event/);
    assert.equal(await page.locator('.pair-code').textContent(), '123 456');
  });
});
