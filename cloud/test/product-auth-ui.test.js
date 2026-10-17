import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const common = await readFile(new URL('../product-public/common.js', import.meta.url), 'utf8');
const source = await readFile(new URL('../product-public/home.js', import.meta.url), 'utf8');
const origin = 'https://signin.example.com';
const response = { id: 'synthetic-passkey', response: { userHandle: 'synthetic-owner' } };

async function withSignIn(options, callback) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const requests = [];
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route(origin + '/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/home') {
        await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><main id="home-root"></main><p id="message" role="status" hidden></p></body></html>' });
        return;
      }
      requests.push({ path, method: request.method(), body: request.postDataJSON() });
      let status = 200;
      let value;
      if (path === '/api/v1/me') { status = 401; value = {}; }
      else if (path === '/auth/login/options') {
        status = options.optionsStatus || 200;
        value = { challenge: 'synthetic-challenge-' + requests.filter(entry => entry.path === path).length, rpId: 'signin.example.com', userVerification: 'required', allowCredentials: [] };
      } else if (path === '/auth/login/verify') {
        status = options.verifyStatus || 200;
        value = { account: { name: 'Synthetic owner' }, csrf: 'synthetic-csrf' };
      } else if (path === '/api/v1/homes') value = { homes: [] };
      else { status = 400; value = {}; }
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    });
    await page.goto(origin + '/home');
    await page.clock.install();
    await page.addScriptTag({ content: common });
    await page.evaluate(({ outcomes, response }) => {
      window.ceremonies = [];
      window.SimpleWebAuthnBrowser = {
        startAuthentication: function (input) {
          window.ceremonies.push(input);
          const outcome = outcomes.shift();
          if (outcome && outcome.name) {
            const error = new Error(outcome.message || 'Synthetic ceremony failure');
            error.name = outcome.name;
            error.code = outcome.code;
            if (outcome.synchronous) throw error;
            return Promise.reject(error);
          }
          return Promise.resolve(response);
        }
      };
    }, { outcomes: options.outcomes || [], response });
    await page.addScriptTag({ content: source });
    await page.getByRole('button', { name: 'I already have a home', exact: true }).waitFor();
    await callback({ page, requests });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}

function assertReadOnlyFailure(requests) {
  assert.deepEqual(requests.map(entry => entry.path), ['/api/v1/me', '/auth/login/options']);
  assert.equal(requests[1].method, 'POST');
  assert.deepEqual(requests[1].body, {});
}

async function attempt(page) {
  await page.getByRole('button', { name: 'I already have a home', exact: true }).click();
}

test('NotAllowedError keeps neutral guidance visible beyond the toast deadline without changing the account', async () => {
  await withSignIn({ outcomes: [{ name: 'NotAllowedError', code: 'ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY', message: '<img src=x onerror=alert(1)>private-credential-detail' }] }, async ({ page, requests }) => {
    await page.getByRole('textbox', { name: 'What should we call you?' }).fill('Untouched name');
    await attempt(page);
    await page.getByRole('heading', { name: 'Sign-in did not finish.', exact: true }).waitFor();
    const panel = page.locator('#signin-help');
    assert.equal(await panel.getAttribute('role'), 'status');
    assert.equal(await panel.getAttribute('aria-live'), 'polite');
    assert.match(await panel.textContent(), /phone or computer where you saved your passkey/);
    assert.match(await panel.textContent(), /another device.*if that option is available/);
    assert.match(await panel.textContent(), /Your existing home is unchanged/);
    assert.match(await panel.textContent(), /will not create a new account or reset it/);
    assert.doesNotMatch(await panel.textContent(), /cancelled|no passkey|private-credential-detail|<img/);
    assert.equal(await page.locator('#message').isVisible(), false);
    await page.waitForFunction(() => !document.querySelector('button.secondary').disabled);
    await page.clock.fastForward(9000);
    assert.equal(await panel.isVisible(), true);
    assert.equal(await page.getByRole('button', { name: 'I already have a home', exact: true }).isEnabled(), true);
    assert.equal(await page.getByRole('textbox', { name: 'What should we call you?' }).inputValue(), 'Untouched name');
    assertReadOnlyFailure(requests);
  });
});

test('AbortError gets distinct neutral guidance and remains retryable', async () => {
  await withSignIn({ outcomes: [{ name: 'AbortError' }] }, async ({ page, requests }) => {
    await attempt(page);
    await page.getByRole('heading', { name: 'Sign-in was interrupted.', exact: true }).waitFor();
    assert.doesNotMatch(await page.locator('#signin-help').textContent(), /cancelled|you stopped|you cancelled/);
    assert.equal(await page.locator('#message').isVisible(), false);
    await page.waitForFunction(() => !document.querySelector('button.secondary').disabled);
    assertReadOnlyFailure(requests);
  });
});

test('retry fetches a fresh challenge, verifies once and removes guidance only after successful sign-in', async () => {
  await withSignIn({ outcomes: [{ name: 'NotAllowedError' }, null] }, async ({ page, requests }) => {
    await attempt(page);
    await page.locator('#signin-help').waitFor();
    await attempt(page);
    await page.getByRole('heading', { name: 'A home for your people.', exact: true }).waitFor();
    assert.equal(await page.locator('#signin-help').count(), 0);
    assert.deepEqual(requests.map(entry => entry.path), ['/api/v1/me', '/auth/login/options', '/auth/login/options', '/auth/login/verify', '/api/v1/homes']);
    assert.deepEqual(requests.find(entry => entry.path === '/auth/login/verify').body, response);
    const ceremonies = await page.evaluate(() => window.ceremonies);
    assert.deepEqual(ceremonies.map(entry => entry.optionsJSON.challenge), ['synthetic-challenge-1', 'synthetic-challenge-2']);
    assert.ok(ceremonies.every(entry => entry.optionsJSON.userVerification === 'required' && entry.optionsJSON.rpId === 'signin.example.com'));
  });
});

test('repeated failures replace one persistent panel and synchronous aborts are handled', async () => {
  await withSignIn({ outcomes: [{ name: 'NotAllowedError' }, { name: 'AbortError', synchronous: true }] }, async ({ page, requests }) => {
    await attempt(page);
    await page.getByRole('heading', { name: 'Sign-in did not finish.', exact: true }).waitFor();
    await attempt(page);
    await page.getByRole('heading', { name: 'Sign-in was interrupted.', exact: true }).waitFor();
    assert.equal(await page.locator('#signin-help').count(), 1);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'signin-help');
    assert.deepEqual(requests.map(entry => entry.path), ['/api/v1/me', '/auth/login/options', '/auth/login/options']);
  });
});

test('options rate limiting stays a server error and never starts the browser ceremony', async () => {
  await withSignIn({ optionsStatus: 429 }, async ({ page, requests }) => {
    await attempt(page);
    await page.getByText('Let us pause for a moment. Please try again shortly.', { exact: true }).waitFor();
    assert.equal(await page.locator('#signin-help').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.ceremonies), []);
    assertReadOnlyFailure(requests);
  });
});

for (const status of [400, 401]) {
  test('HTTP ' + status + ' verification rejection preserves the signed-out flow without claiming a ceremony failure', async () => {
    await withSignIn({ verifyStatus: status }, async ({ page, requests }) => {
      await attempt(page);
      await page.getByText(status === 401 ? 'Please sign in again to continue.' : 'That did not work. Please check and try again.', { exact: true }).waitFor();
      assert.equal(await page.locator('#signin-help').count(), 0);
      await page.waitForFunction(() => !document.querySelector('button.secondary').disabled);
      assert.deepEqual(requests.map(entry => entry.path), ['/api/v1/me', '/auth/login/options', '/auth/login/verify']);
    });
  });
}

test('unclassified browser errors are not mislabeled as missing credentials or interruption', async () => {
  await withSignIn({ outcomes: [{ name: 'SecurityError', message: 'Synthetic RP mismatch' }] }, async ({ page, requests }) => {
    await attempt(page);
    await page.getByText('That did not work. Please check and try again.', { exact: true }).waitFor();
    assert.equal(await page.locator('#signin-help').count(), 0);
    assertReadOnlyFailure(requests);
  });
});
