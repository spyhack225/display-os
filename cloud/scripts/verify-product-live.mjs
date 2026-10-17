import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const config = JSON.parse(await readFile(new URL('../wrangler.json', import.meta.url), 'utf8'));
const origin = config.vars.PUBLIC_ORIGIN;
const evidence = new URL('../../diagnostics/displayos-product-live/', import.meta.url);
let checks = 0;
let browser;
const publicConnectionPaths = new Set(['/skill.md', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']);
function check(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
async function call(path, options = {}) {
  return fetch(origin + path, { ...options, redirect: 'manual', signal: AbortSignal.timeout(15000) });
}
function headers(response, publicRead = false) {
  check(response.headers.get('cache-control'), 'no-store');
  check(response.headers.get('x-content-type-options'), 'nosniff');
  check(response.headers.get('x-frame-options'), 'DENY');
  check(response.headers.get('referrer-policy'), 'no-referrer');
  check(response.headers.get('strict-transport-security'), 'max-age=31536000');
  assert.ok(response.headers.get('content-security-policy').includes("frame-ancestors 'none'")); checks++;
  check(response.headers.get('access-control-allow-origin'), publicRead ? '*' : null);
  check(response.headers.get('access-control-allow-credentials'), null);
}

async function publicConnectionReads() {
  for (const path of publicConnectionPaths) {
    const baseline = await call(path);
    check(baseline.status, 200, path);
    headers(baseline, true);
    check(baseline.headers.get('set-cookie'), null);
    const content = await baseline.text();
    for (const requester of [origin, 'https://chatgpt.com', 'https://www.meta.ai', 'null']) {
      const response = await call(path, { headers: { Origin: requester, Authorization: 'Bearer synthetic-public-read-marker', Cookie: 'synthetic-public-cookie-marker' } });
      check(response.status, 200, path + ' ' + requester);
      headers(response, true);
      check(response.headers.get('set-cookie'), null);
      const body = await response.text();
      check(body, content, 'Public response varies with caller credentials');
      check(/synthetic-public-(read|cookie)-marker/.test(body), false);
    }
    for (const [suffix, options, status] of [
      ['', { method: 'POST', headers: { Origin: 'null', 'Content-Type': 'application/json' }, body: '{}' }, 403],
      ['?token=synthetic', {}, 400], ['', { method: 'HEAD' }, path === '/skill.md' ? 404 : 405]
    ]) {
      const response = await call(path + suffix, options);
      check(response.status, status, 'Unsupported public method or query: ' + path);
      headers(response);
      check(response.headers.get('set-cookie'), null);
    }
  }
  for (const requester of ['https://chatgpt.com', 'null']) {
    for (const [path, method] of [['/home', 'GET'], ['/mcp', 'GET'], ['/api/v1/me', 'GET'], ['/device/v1/poll', 'GET'], ['/oauth/register', 'POST'], ['/oauth/token', 'POST'], ['/auth/register/options', 'POST']]) {
      const response = await call(path, { method, headers: { Origin: requester, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) }, ...(method === 'POST' ? { body: '{}' } : {}) });
      check(response.status, 403, 'Foreign private route remains denied: ' + path);
      headers(response);
      check(response.headers.get('set-cookie'), null);
    }
  }
}

try {
  for (const path of ['/', '/welcome', '/home', '/setup', '/screen', '/display', '/privacy', '/skill.md', '/product/common.js', '/product/home.js', '/product/screen.js', '/product/providers.js', '/product/webauthn.js', '/product/qrcode.js', '/product/style.css', '/product/design-system.css', '/product/theme.js', '/product/home-layout.css']) {
    const response = await call(path);
    check(response.status, 200, path);
    headers(response, publicConnectionPaths.has(path));
    assert.ok((await response.text()).length > 100, 'Empty product asset: ' + path); checks++;
  }
  for (const filename of ['home.html', 'home-layout.css', 'home.js', 'screen.js', 'providers.js', 'pairing.css', 'style.css', 'design-system.css', 'theme.js', 'details.css', 'common.js']) {
    const route = filename === 'home.html' ? '/home' : '/product/' + filename;
    const response = await call(route);
    check(response.status, 200, route);
    headers(response);
    const built = await readFile(new URL('../dist/product/' + filename, import.meta.url));
    check(Buffer.from(await response.arrayBuffer()).equals(built), true, 'Published consumer asset differs from the tested build: ' + filename);
  }
  const metadataResponse = await call('/.well-known/oauth-authorization-server');
  check(metadataResponse.status, 200); headers(metadataResponse, true);
  const metadata = await metadataResponse.json();
  check(metadata.issuer, origin);
  check(metadata.authorization_endpoint, origin + '/oauth/authorize');
  check(metadata.token_endpoint, origin + '/oauth/token');
  check(metadata.registration_endpoint, origin + '/oauth/register');
  check(metadata.code_challenge_methods_supported, ['S256']);
  check(metadata.token_endpoint_auth_methods_supported, ['none']);
  const resourceResponse = await call('/.well-known/oauth-protected-resource/mcp');
  check(resourceResponse.status, 200); headers(resourceResponse, true);
  const resource = await resourceResponse.json();
  check(resource.resource, origin + '/mcp');
  check(resource.authorization_servers, [origin]);
  await publicConnectionReads();
  for (const path of ['/api/v1/me', '/api/v1/homes', '/device/v1/poll', '/mcp']) {
    const response = await call(path);
    check(response.status, 401, path); headers(response);
    check(response.headers.get('set-cookie'), null);
    if (path === '/mcp') {
      assert.ok(response.headers.get('www-authenticate').includes(origin + '/.well-known/oauth-protected-resource/mcp')); checks++;
    }
  }
  check((await call('/factory/v1/tickets', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: '{}' })).status, 401);
  check((await call('/api/v1/me', { headers: { Origin: 'https://untrusted.example.com' } })).status, 403);
  check((await call('/home?credential=not-a-secret')).status, 400);
  check((await call('/api/v1/me?credential=not-a-secret')).status, 400);
  check((await call('/auth/register/options', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example.com' }, body: '{}' })).status, 403);
  await mkdir(evidence, { recursive: true });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/welcome');
  await page.getByRole('link', { name: 'Set up my home', exact: true }).click();
  await page.locator('#your-name').waitFor(); checks++;
  check(await page.locator('input[type=password]').count(), 0);
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  check(/\b(API|backend|VPS|server|credential|grant|token|session|revision)\b|owner key|enrollment code|display ID/i.test(await page.locator('body').innerText()), false);
  await page.screenshot({ path: fileURLToPath(new URL('sign-in-phone.png', evidence)), fullPage: true });
  await page.goto(origin + '/screen');
  await page.locator('#screen-root').waitFor(); checks++;
  check(await page.evaluate(() => Object.keys(sessionStorage).length), 0);
  check(errors, []);
  await writeFile(new URL('evidence.json', evidence), JSON.stringify({ origin, verifiedAt: new Date().toISOString(), checks, liveOwnerClaim: false, liveAssistantConsent: false, hardwareVerified: false }, null, 2) + '\n');
  console.log(checks + ' live DisplayOS HTTPS and browser checks passed. No account, screen, grant or provider was created or approved.');
} finally { await browser?.close(); }
