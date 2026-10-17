import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const common = await readFile(new URL('../product-public/common.js', import.meta.url), 'utf8');
const source = await readFile(new URL('../product-public/home.js', import.meta.url), 'utf8');
const origin = 'https://helpers.example.com';

async function withHome(options, callback) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    const requests = [];
    page.on('pageerror', error => errors.push(error.message));
    const home = {
      id: 'fixture-home', name: 'Fixture family', role: options.role || 'owner', members: [],
      screens: [{ id: 'fixture-screen', name: 'Kitchen', revision: 0 }],
      settings: { timezone: 'UTC', nightStart: '22:00', nightEnd: '07:00', quietAfterSeconds: 300, brightness: 60, orientation: 'auto', showPhotos: false, temperatureUnit: 'celsius' },
      grants: options.grant ? [{ id: 'fixture-grant', label: 'Approved helper', scopes: ['display:read', 'content:write'], expiresAt: Date.now() + 600000 }] : []
    };
    let intents = options.pending ? [{ id: 'fixture-intent', label: 'Fixture helper', scopes: ['display:read', 'content:write'], expiresAt: Date.now() + 600000 }] : [];
    await page.route(origin + '/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/home' || path === '/approved') {
        await route.fulfill({ contentType: 'text/html', body: path === '/home' ? '<!doctype html><html><body><main id="home-root"></main><p id="message" role="status" hidden></p></body></html>' : '<!doctype html><html><body>Fixture approved</body></html>' });
        return;
      }
      const body = request.postDataJSON();
      requests.push({ path, body, method: request.method(), csrf: request.headers()['x-displayos-csrf'] });
      let value;
      if (path === '/api/v1/me') value = { account: { id: 'fixture-account', name: 'Fixture owner' }, csrf: 'fixture-csrf' };
      else if (path === '/api/v1/homes') value = { homes: [{ id: home.id, name: home.name }] };
      else if (path === '/api/v1/home' && body.command === 'home.get') value = home;
      else if (path === '/api/v1/connections/pending') value = { intents };
      else if (path === '/api/v1/connections/approve') value = { redirectUrl: origin + '/approved' };
      else if (path === '/api/v1/connections/deny') { intents = []; value = { cancelled: true }; }
      else if (path === '/api/v1/connections/revoke') { home.grants = []; value = { revoked: true }; }
      else { await route.fulfill({ status: 400, contentType: 'application/json', body: '{}' }); return; }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(value) });
    });
    await page.goto(origin + '/home?source=private-fixture#connect=fixture-intent');
    await page.clock.install();
    await page.evaluate(mode => {
      window.copiedTexts = [];
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: mode === 'missing' ? undefined : {
        writeText: function (value) {
          if (mode === 'reject') return Promise.reject(new Error('Fixture clipboard unavailable'));
          window.copiedTexts.push(value);
          return Promise.resolve();
        }
      } });
    }, options.clipboard || 'success');
    await page.addScriptTag({ content: common });
    await page.addScriptTag({ content: source });
    await page.locator('.home-helper').waitFor();
    await callback({ page, requests });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}

function mutations(requests) {
  return requests.filter(entry => entry.method !== 'GET' && !(entry.path === '/api/v1/home' && entry.body.command === 'home.get'));
}

function assertPublicAddress(value) {
  assert.equal(value, origin + '/mcp');
  assert.equal(new URL(value).search, '');
  assert.equal(new URL(value).hash, '');
  assert.doesNotMatch(value, /fixture|token|cookie|account|connect=/);
}

test('owner sees the official setup link first and honest expandable OAuth, create, install and selection steps', async () => {
  await withHome({}, async ({ page, requests }) => {
    const panel = page.locator('.home-helper');
    const link = panel.getByRole('link', { name: 'Open ChatGPT setup', exact: true });
    assert.equal(await link.getAttribute('href'), 'https://chatgpt.com/plugins');
    assert.equal(await link.getAttribute('target'), '_blank');
    assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(await panel.locator('.actions').first().locator('a, button').first().textContent(), 'Open ChatGPT setup');
    assert.match(await panel.textContent(), /Pasting an invitation does not install it/);
    assert.match(await panel.textContent(), /This pilot uses manual setup/);
    assert.equal(await panel.locator('details').getAttribute('open'), null);
    await panel.getByText('Setup steps', { exact: true }).click();
    const steps = await panel.locator('ol li').allTextContents();
    assert.match(steps[0], /Add custom MCP server/);
    assert.match(steps[2], /Choose OAuth.*not No authentication/);
    assert.match(steps[3], /risk warning.*Create as a plugin/);
    assert.match(steps[4], /install it.*@DisplayOS/);
    assert.match(steps[5], /your own browser.*home, screens and access/);
    assert.match(await panel.textContent(), /may not be available for your ChatGPT account or workspace/);
    assert.match(await panel.textContent(), /Do not sign in there for it or share passkeys, safety codes, tokens or login cookies/);
    const field = panel.getByRole('textbox', { name: 'Server URL', exact: true });
    assertPublicAddress(await field.inputValue());
    assert.equal(await field.getAttribute('readonly'), '');
    assert.deepEqual(mutations(requests), []);
  });
});

test('copy connection address shares only the public MCP URL and never starts authorization', async () => {
  await withHome({ pending: true }, async ({ page, requests }) => {
    await page.getByRole('button', { name: 'Copy connection address', exact: true }).click();
    await page.getByText('Connection address copied. Paste it into Server URL in ChatGPT setup.', { exact: true }).waitFor();
    const copied = await page.evaluate(() => window.copiedTexts);
    assert.equal(copied.length, 1);
    assertPublicAddress(copied[0]);
    assert.deepEqual(mutations(requests), []);
  });
});

for (const clipboard of ['missing', 'reject']) {
  test('connection address stays manually copyable when the clipboard is ' + clipboard, async () => {
    await withHome({ clipboard }, async ({ page, requests }) => {
      await page.getByRole('button', { name: 'Copy connection address', exact: true }).click();
      await page.getByText('Select and copy the Server URL, then paste it into ChatGPT setup.', { exact: true }).waitFor();
      const field = page.getByRole('textbox', { name: 'Server URL', exact: true });
      assert.equal(await field.isVisible(), true);
      assertPublicAddress(await field.inputValue());
      assert.deepEqual(await field.evaluate(input => [document.activeElement === input, input.selectionStart, input.selectionEnd]), [true, 0, (origin + '/mcp').length]);
      assert.deepEqual(mutations(requests), []);
    });
  });
}

function assertSafeInvitation(value) {
  assert.match(value, /^After the DisplayOS plugin is installed and selected in this chat/);
  assert.match(value, /secure connection is unavailable, explain that limitation/);
  assert.match(value, /I will sign in and approve access in my own browser/);
  assert.match(value, /Do not sign in through your cloud browser, approve your own request or ask me to share passkeys, safety codes, tokens or login cookies/);
  assert.ok(value.includes(origin + '/skill.md'));
  assert.doesNotMatch(value, /fixture-(?:home|screen|account|csrf|intent)|private-fixture|connect=/);
}

test('copied invitation requires an installed plugin and keeps owner sign-in and approval separate', async () => {
  await withHome({}, async ({ page, requests }) => {
    await page.getByRole('button', { name: 'Copy an invitation', exact: true }).click();
    await page.getByText('Invitation copied. After installing DisplayOS, select it in your chat and paste this invitation.', { exact: true }).waitFor();
    const copied = await page.evaluate(() => window.copiedTexts);
    assert.equal(copied.length, 1);
    assertSafeInvitation(copied[0]);
    assert.deepEqual(mutations(requests), []);
  });
});

for (const clipboard of ['missing', 'reject']) {
  test('invitation fallback preserves setup and safety instructions when the clipboard is ' + clipboard, async () => {
    await withHome({ clipboard }, async ({ page, requests }) => {
      await page.getByRole('button', { name: 'Copy an invitation', exact: true }).click();
      const invitation = page.getByRole('textbox', { name: 'Invitation for your assistant', exact: true });
      await invitation.waitFor();
      assertSafeInvitation(await invitation.inputValue());
      assert.equal(await invitation.getAttribute('readonly'), '');
      assert.equal(await page.getByText('After DisplayOS is installed, select it in your chat, then copy and send these words. This invitation does not install it.', { exact: true }).isVisible(), true);
      assert.deepEqual(mutations(requests), []);
    });
  });
}

test('member sees helper information but no owner setup, invitation or approval controls', async () => {
  await withHome({ role: 'editor', pending: true, grant: true }, async ({ page, requests }) => {
    for (const name of ['Copy connection address', 'Copy an invitation', 'Allow this assistant', 'Stop this assistant']) assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0);
    assert.equal(await page.getByRole('link', { name: 'Open ChatGPT setup', exact: true }).count(), 0);
    assert.equal(await page.getByText('Approved helper', { exact: true }).isVisible(), true);
    assert.deepEqual(mutations(requests), []);
  });
});

test('owner approval remains explicit and preserves chosen scope, screen, duration and CSRF', async () => {
  await withHome({ pending: true }, async ({ page, requests }) => {
    assert.deepEqual(mutations(requests), []);
    await page.getByRole('checkbox', { name: 'Add family plans and short updates', exact: true }).uncheck();
    await page.getByRole('combobox', { name: 'How long can it help?', exact: true }).selectOption('86400');
    await page.getByRole('button', { name: 'Allow this assistant', exact: true }).click();
    await page.waitForURL(origin + '/approved');
    const writes = mutations(requests);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].path, '/api/v1/connections/approve');
    assert.equal(writes[0].csrf, 'fixture-csrf');
    assert.deepEqual(writes[0].body, { intentId: 'fixture-intent', homeId: 'fixture-home', deviceIds: ['fixture-screen'], scopes: ['display:read'], duration: 86400 });
  });
});

test('owner can still deny a pending request without creating an approval', async () => {
  await withHome({ pending: true }, async ({ page, requests }) => {
    await page.getByRole('button', { name: 'Not now', exact: true }).click();
    await page.getByText('This assistant request has been cancelled.', { exact: true }).waitFor();
    assert.deepEqual(mutations(requests).map(entry => entry.path), ['/api/v1/connections/deny']);
    assert.equal(mutations(requests)[0].csrf, 'fixture-csrf');
    assert.deepEqual(mutations(requests)[0].body, { intentId: 'fixture-intent' });
  });
});

test('owner can still revoke a helper and keep sign-in safety controls', async () => {
  await withHome({ grant: true }, async ({ page, requests }) => {
    await page.getByRole('button', { name: 'Stop this assistant', exact: true }).click();
    await page.getByText('This assistant can no longer update your screen.', { exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Invite your helper', exact: true }).waitFor();
    assert.deepEqual(mutations(requests).map(entry => entry.path), ['/api/v1/connections/revoke']);
    assert.deepEqual(mutations(requests)[0].body, { homeId: 'fixture-home', grantId: 'fixture-grant' });
    assert.equal(mutations(requests)[0].csrf, 'fixture-csrf');
    await page.getByText('Your sign-in and safety', { exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Make safety codes', exact: true }).isVisible(), true);
    assert.equal(await page.getByRole('button', { name: 'Add another sign-in', exact: true }).isVisible(), true);
  });
});
