import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const argumentsList = process.argv.slice(2);
const shapes = argumentsList.filter(value => value.startsWith('--connection-shape='));
if (argumentsList.filter(value => value === '--synthetic-home').length !== 1 || shapes.length > 1 || argumentsList.some(value => value !== '--synthetic-home' && !/^--connection-shape=(chatgpt|muse)$/.test(value))) throw new Error('This optional live journey requires --synthetic-home and optionally --connection-shape=chatgpt or --connection-shape=muse. It creates and deletes its own disposable QA home.');
const connectionShape = shapes.length ? shapes[0].split('=')[1] : 'standard';
const config = JSON.parse(await readFile(new URL('../wrangler.json', import.meta.url), 'utf8'));
const origin = config.vars.PUBLIC_ORIGIN;
const connectionResource = connectionShape === 'muse' ? {} : { resource: origin + '/mcp' };
const evidence = new URL('../../diagnostics/displayos-product-live/', import.meta.url);
const tag = randomBytes(5).toString('hex');
let browser;
let client;
let owner;
let registered = false;
let deleted = false;
let trialToken;
let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; }
async function api(path, body) {
  return owner.evaluate(async ({ path, body }) => {
    const me = await fetch('/api/v1/me').then(response => response.json());
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-DisplayOS-CSRF': me.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  }, { path, body });
}
async function command(homeId, name, input = {}) {
  const response = await api('/api/v1/home', { homeId, command: name, input });
  check(response.status === 200, 'Disposable home command failed: ' + name);
  return response.value;
}
async function protocol(path, body, form = false) {
  const response = await fetch(origin + path, { method: 'POST', headers: { 'Content-Type': form ? 'application/x-www-form-urlencoded' : 'application/json' }, body: form ? new URLSearchParams(body).toString() : JSON.stringify(body), redirect: 'manual', signal: AbortSignal.timeout(15000) });
  return { status: response.status, value: await response.json() };
}

try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  context.setDefaultTimeout(45000);
  owner = await context.newPage();
  await owner.goto(origin + '/home');
  const authenticator = await context.newCDPSession(owner);
  await authenticator.send('WebAuthn.enable');
  await authenticator.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await owner.locator('#your-name').fill('Disposable QA ' + tag);
  await owner.getByRole('button', { name: 'Get started', exact: true }).click();
  await owner.locator('#home-name').waitFor(); registered = true; checks++;
  await owner.locator('#home-name').fill('Disposable QA home ' + tag);
  await owner.getByRole('button', { name: 'Make my home', exact: true }).click();
  await owner.locator('#screen-code').waitFor(); checks++;
  const homes = await api('/api/v1/homes');
  check(homes.status === 200 && homes.value.homes.length === 1, 'Disposable home not isolated');
  const homeId = homes.value.homes[0].id;
  const home = await command(homeId, 'home.get');
  await command(homeId, 'home.update', { settings: { ...home.settings, timezone: 'UTC', nightStart: '00:00', nightEnd: '00:00' } });
  const display = await context.newPage();
  await display.setViewportSize({ width: 1280, height: 800 });
  await display.goto(origin + '/home');
  await display.getByText('Try it on this computer', { exact: true }).click();
  await display.getByRole('button', { name: 'Try this screen', exact: true }).click();
  await display.waitForURL(origin + '/screen');
  await display.locator('.qr svg').waitFor(); checks++;
  trialToken = await display.evaluate(() => sessionStorage.getItem('displayos-demo-device-token'));
  check(typeof trialToken === 'string' && trialToken.length > 20, 'Disposable screen identity missing');
  const code = (await display.locator('.pair-code').innerText()).replace(/\s/g, '');
  check(/^[0-9]{6}$/.test(code), 'Live six-number manual fallback missing');
  await owner.locator('#screen-code').fill(code);
  await owner.getByRole('button', { name: 'This is my screen', exact: true }).click();
  await owner.getByRole('heading', { name: 'One last tap on your screen.', exact: true }).waitFor(); checks++;
  check((await command(homeId, 'home.get')).screens.length === 0, 'Claim completed without on-screen confirmation');
  await display.getByRole('button', { name: 'Yes, this is my home', exact: true }).click();
  await owner.getByRole('heading', { name: 'Invite your helper', exact: true }).waitFor(); checks++;
  const owned = await command(homeId, 'home.get');
  check(owned.screens.length === 1, 'Live browser trial did not attach');
  const deviceId = owned.screens[0].id;
  const redirectUri = 'https://displayos-qa.example.invalid/return';
  const registration = await protocol('/oauth/register', { client_name: 'Disposable DisplayOS QA ' + tag, redirect_uris: [redirectUri], token_endpoint_auth_method: 'none', scope: 'display:read content:write', client_uri: 'https://displayos-qa.example.invalid/', logo_uri: 'https://displayos-qa.example.invalid/logo.png', contacts: ['qa@example.invalid'], software_id: 'displayos-live-qa', software_version: '1.0.0', 'client_name#en': 'DisplayOS QA', displayos_extension: { ignored: true } });
  check(registration.status === 201, 'Live OAuth registration failed');
  check(['client_uri', 'logo_uri', 'contacts', 'software_id', 'software_version', 'client_name#en', 'displayos_extension'].every(field => !Object.hasOwn(registration.value, field)), 'Ignored app metadata was echoed by registration');
  const verifier = randomBytes(32).toString('base64url');
  const state = randomBytes(24).toString('base64url');
  const authorization = new URL(origin + '/oauth/authorize');
  Object.entries({ response_type: 'code', client_id: registration.value.client_id, redirect_uri: redirectUri, state, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'), ...connectionResource, scope: 'display:read content:write', ...(connectionShape === 'chatgpt' ? { ui_locales: 'en-US' } : {}) }).forEach(([key, value]) => authorization.searchParams.set(key, value));
  let callback;
  await context.route('https://displayos-qa.example.invalid/**', async route => {
    callback = new URL(route.request().url());
    await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Disposable QA callback</title><p>Synthetic test connection only.</p>' });
  });
  await owner.goto(authorization.href);
  await owner.getByRole('button', { name: 'Allow this assistant', exact: true }).waitFor(); checks++;
  check((await command(homeId, 'home.get')).grants.length === 0, 'Live authorization silently grants access');
  await owner.getByLabel('How long can it help?', { exact: true }).selectOption('86400');
  await owner.getByRole('button', { name: 'Allow this assistant', exact: true }).click();
  await owner.waitForURL('https://displayos-qa.example.invalid/**');
  check(callback.searchParams.get('state') === state && callback.searchParams.get('iss') === origin && callback.searchParams.has('code'), 'Live callback binding failed');
  check(!callback.searchParams.has('ui_locales'), 'Ignored locale is echoed in the live callback');
  await owner.goto(origin + '/home');
  const consented = await command(homeId, 'home.get');
  check(consented.grants.length === 1 && consented.grants[0].deviceIds.length === 1 && consented.grants[0].deviceIds[0] === deviceId && JSON.stringify(consented.grants[0].scopes.slice().sort()) === JSON.stringify(['content:write', 'display:read']), 'Connection shape changes explicit QA screen or scope consent');
  const exchange = await protocol('/oauth/token', { grant_type: 'authorization_code', client_id: registration.value.client_id, redirect_uri: redirectUri, code: callback.searchParams.get('code'), code_verifier: verifier, ...connectionResource }, true);
  check(exchange.status === 200 && exchange.value.expires_in <= 900, 'Live PKCE exchange failed');
  check(exchange.value.resource === origin + '/mcp' && JSON.stringify(exchange.value.scope.split(' ').sort()) === JSON.stringify(['content:write', 'display:read']), 'Live exchange changes the DisplayOS audience or approved scopes');
  const refresh = await protocol('/oauth/token', { grant_type: 'refresh_token', client_id: registration.value.client_id, refresh_token: exchange.value.refresh_token, ...connectionResource }, true);
  check(refresh.status === 200 && refresh.value.expires_in > 0 && refresh.value.expires_in <= 900 && typeof refresh.value.refresh_token === 'string' && refresh.value.refresh_token !== exchange.value.refresh_token, 'Live refresh rotation failed');
  check(refresh.value.resource === origin + '/mcp' && refresh.value.scope === exchange.value.scope, 'Live refresh changes the DisplayOS audience or permissions');
  client = new Client({ name: 'DisplayOS disposable live QA', version: '1.0.0' }, { capabilities: {} });
  await client.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + refresh.value.access_token } } })); checks++;
  async function tool(name, args = {}) {
    const result = await client.callTool({ name, arguments: args });
    check(!result.isError, 'Live QA tool failed: ' + name);
    return result.structuredContent;
  }
  const screens = await tool('screen_list');
  check(screens.screens.length === 1 && screens.screens[0].id === deviceId, 'MCP returned another home');
  await tool('screen_capabilities');
  const now = Date.now();
  const title = 'A live disposable test ' + tag;
  const publication = await tool('family_publish', { deviceId, expectedRevision: 0, idempotencyKey: randomBytes(24).toString('base64url'), snapshot: { schemaVersion: 1, timezone: 'UTC', generatedAt: now, expiresAt: now + 120000, briefing: { title, text: 'Synthetic information only. No personal account or tablet is used.' }, prompts: ['What made you smile today?'] } });
  check(publication.revision === 1, 'Live revision not committed');
  await display.mouse.click(18, 16);
  await display.getByRole('heading', { name: title, exact: true }).waitFor(); checks++;
  let rendered = false;
  for (let attempt = 0; attempt < 12; attempt++) {
    const receipt = await tool('revision_status', { deviceId, revision: 1 });
    if (receipt.status === 'rendered') { rendered = true; break; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  check(rendered, 'Live browser render receipt not confirmed');
  await owner.goto(origin + '/home');
  const current = await command(homeId, 'home.get');
  await command(homeId, 'grant.revoke', { grantId: current.grants[0].id });
  const revoked = await fetch(origin + '/mcp', { headers: { Authorization: 'Bearer ' + refresh.value.access_token }, signal: AbortSignal.timeout(15000) });
  check([401, 403].includes(revoked.status), 'Revoked live connection retains access');
  const deletion = await api('/auth/account/delete', {});
  check(deletion.status === 200, 'Disposable account cleanup failed'); deleted = true;
  check((await api('/api/v1/me')).status === 401, 'Deleted live account retains a session');
  const response = await fetch(origin + '/device/v1/poll', { headers: { Authorization: 'Bearer ' + trialToken }, signal: AbortSignal.timeout(15000) });
  check(response.status === 401, 'Deleted trial credential remains usable');
  await mkdir(evidence, { recursive: true });
  await writeFile(new URL('synthetic-flow' + (connectionShape === 'standard' ? '' : '-' + connectionShape) + '.json', evidence), JSON.stringify({ origin, verifiedAt: new Date().toISOString(), connectionShape, checks, syntheticAccountDeleted: deleted, desktopRendered: true, personalAssistantConnected: false, personalProviderConsent: false, hardwareVerified: false, temporaryPublicClientRegistration: true }, null, 2) + '\n');
  console.log(checks + ' live synthetic-home checks passed for ' + connectionShape + ': passkey, QR trial, explicit QA consent, refresh rotation, official MCP client, publish, desktop render, revocation and deletion. Not personal-assistant or tablet proof.');
} finally {
  await client?.close().catch(() => {});
  if (registered && !deleted && owner) {
    try {
      await owner.goto(origin + '/home');
      const cleanup = await api('/auth/account/delete', {});
      if (cleanup.status !== 200) throw new Error('Deletion returned ' + cleanup.status);
      console.log('Disposable QA account removed after a failed journey.');
    } catch { console.error('Disposable QA cleanup did not pass. Inspect the test account named Disposable QA ' + tag + '; do not remove other accounts.'); }
  }
  await browser?.close();
}
