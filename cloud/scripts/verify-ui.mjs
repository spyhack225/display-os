import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createTestHarness } from 'wrangler';
import { secret } from '../../demo/model.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const origin = 'https://ui.example.com';
const secrets = { OWNER_CREDENTIAL: secret(), ENROLLMENT_CODE: secret(), STATE_ENCRYPTION_KEY: secret() };
const config = JSON.parse(await readFile(new URL('../wrangler.json', import.meta.url), 'utf8'));
config.main = '.wrangler/bundle/worker.js';
const server = createTestHarness({ workers: [{ config, vars: { PUBLIC_ORIGIN: origin }, secrets }] });
const screenshots = new URL('../../diagnostics/displayos-ui/', import.meta.url);
let checks = 0;
let browser;
const errors = [];
function check(value, message) { assert.ok(value, message); checks++; }
async function visible(page, selector, expected = true) {
  await page.locator(selector).first().waitFor({ state: expected ? 'visible' : 'hidden' }); checks++;
}
async function words(page) {
  check(!/\b(API|backend|VPS|server|credential|grant|token|session|revision)\b|owner key|enrollment code|display ID/i.test(await page.locator('body').innerText()), 'Developer language leaked into family UI');
}
async function fits(page) {
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Horizontal overflow');
}

try {
  await mkdir(screenshots, { recursive: true });
  await server.listen();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.route(origin + '/**', async route => {
    const request = route.request();
    const headers = { ...request.headers(), 'CF-Connecting-IP': '192.0.2.80' };
    delete headers['content-length']; delete headers.host;
    const response = await server.getWorker().fetch(request.url(), { method: request.method(), headers, body: request.postData() || undefined });
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: Buffer.from(await response.arrayBuffer()) });
  });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const display = await context.newPage();
  await display.goto(origin + '/pilot/display');
  await visible(display, '.card');
  check(await display.locator('.card').count() === 4, 'Preview cards missing');
  await visible(display, '#enrollment', false); await words(display); await fits(display);
  check(await display.evaluate(() => document.documentElement.scrollHeight <= innerHeight), 'Sample home needs scrolling on the landscape display');
  check(await display.locator('#dashboard-clock').innerText() !== '', 'Clock missing');
  await display.screenshot({ path: new URL('our-day.png', screenshots).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true });
  await display.getByRole('button', { name: 'Quiet view', exact: true }).click();
  await visible(display, '#standby-view'); await visible(display, '#dashboard-view', false);
  check(await display.locator('.month-calendar .today').count() === 1, 'Today not marked');
  await words(display); await fits(display);
  await display.screenshot({ path: new URL('quiet-view.png', screenshots).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true });
  for (const viewport of [{ width: 800, height: 1280 }, { width: 390, height: 844 }]) {
    await display.setViewportSize(viewport); await fits(display);
    await display.getByRole('button', { name: 'Our day', exact: true }).click(); await fits(display);
    await display.screenshot({ path: new URL('our-day-' + viewport.width + '.png', screenshots).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true });
    await display.getByRole('button', { name: 'Quiet view', exact: true }).click(); await fits(display);
  }
  await display.setViewportSize({ width: 1280, height: 800 });
  await display.getByRole('button', { name: 'Our day', exact: true }).click();
  await display.getByRole('button', { name: 'Set up my screen' }).click();
  await visible(display, '#enrollment'); await words(display);
  await display.getByRole('button', { name: 'Back to our day' }).click(); await visible(display, '#enrollment', false);

  const owner = await context.newPage();
  await owner.goto(origin + '/pilot/setup'); await visible(owner, '#login-panel'); await words(owner); await fits(owner);
  check(await owner.locator('input[type="password"]').count() === 0, 'Family setup asks for a technical credential');
  await owner.screenshot({ path: new URL('welcome.png', screenshots).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true });
  await owner.goto(origin + '/operator');
  await owner.locator('#owner-credential').fill(secrets.OWNER_CREDENTIAL);
  await owner.getByRole('button', { name: 'Prepare owner access' }).click();
  await owner.waitForURL(origin + '/pilot/setup'); await visible(owner, '#claim-panel'); await words(owner);
  await owner.locator('#claim-ticket').fill('invalid'); await owner.getByRole('button', { name: 'This is my screen' }).click();
  await owner.getByText('Enter all 12 letters and numbers from your screen.').waitFor(); checks++;

  await display.goto(origin + '/operator');
  await display.locator('#enrollment-code').fill(secrets.ENROLLMENT_CODE);
  await display.getByRole('button', { name: 'Prepare this screen' }).click();
  await display.waitForURL(origin + '/pilot/display'); await visible(display, '#pairing'); await words(display);
  await display.waitForFunction(() => document.getElementById('pair-ticket').value.length === 12);
  const code = await display.locator('#pair-ticket').inputValue();
  await owner.locator('#claim-ticket').fill(code); await owner.getByRole('button', { name: 'This is my screen' }).click();
  await visible(owner, '#agent-panel'); await visible(owner, '#claim-panel', false); await words(owner);
  await visible(display, '#pairing', false);
  check(await display.locator('.card').count() === 0, 'Sample notes survived connection as real content');
  await owner.screenshot({ path: new URL('invite-assistant.png', screenshots).pathname.replace(/^\/(\w:)/, '$1'), fullPage: true });
  await owner.getByRole('button', { name: 'Add another screen' }).click(); await visible(owner, '#claim-panel');
  await owner.getByRole('button', { name: 'Back to my screens' }).click(); await visible(owner, '#claim-panel', false);

  const agent = await context.newPage();
  await agent.goto(origin + await owner.locator('#test-agent').getAttribute('href')); await words(agent);
  check(await agent.locator('#agent-device').inputValue() !== '', 'Invitation did not choose the screen');
  await agent.getByRole('button', { name: 'Ask to connect' }).click();
  await owner.getByRole('button', { name: 'Yes, let it help' }).waitFor(); checks++;
  await visible(agent, '#publish-panel', false);
  await words(owner);
  await owner.getByRole('button', { name: 'Yes, let it help' }).click(); await visible(agent, '#publish-panel');
  await agent.locator('#card-title').fill('<img src=x onerror=alert(1)>');
  await agent.locator('#card-text').fill('This made-up note came from the sample assistant.');
  await agent.getByRole('button', { name: 'Send my note' }).click();
  await agent.getByText('That did not look right. Please check and try again.', { exact: true }).waitFor(); checks++;
  check(await display.locator('#cards img').count() === 0, 'Markup rendered');
  await agent.locator('#card-title').fill('A note from your assistant');
  await agent.getByRole('button', { name: 'Send my note' }).click();
  await display.getByRole('heading', { name: 'A note from your assistant', exact: true }).waitFor(); checks++;
  await agent.getByText('Your screen sent confirmation.', { exact: true }).waitFor(); checks++;
  await display.getByRole('button', { name: 'Quiet view', exact: true }).click();
  check(await display.locator('#standby-title').innerText() === 'A note from your assistant', 'Quiet view did not use delivered content');
  await owner.locator('#permissions-panel summary').click();
  await owner.getByRole('button', { name: 'Stop updates', exact: true }).click();
  await agent.locator('#card-title').fill('Not allowed'); await agent.getByRole('button', { name: 'Send my note' }).click();
  await agent.getByText('This connection has ended. Please reconnect.', { exact: true }).waitFor(); checks++;
  await owner.getByRole('button', { name: 'Sign out' }).click(); await visible(owner, '#login-panel'); await visible(owner, '#owner-controls', false);
  await words(owner); check(errors.length === 0, 'Browser errors: ' + errors.join(', '));
  console.log(checks + ' retained-pilot browser checks passed against disposable local workerd state. Screenshots: diagnostics/displayos-ui. No live owner or hardware actions.');
} finally { if (browser) await browser.close(); await server.close(); }
