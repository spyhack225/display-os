import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createTestHarness } from 'wrangler';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { sampleSnapshot } from '../src/product/family.js';
import { random, digest } from '../src/product/common.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const origin = 'https://product.example.com';
const secret = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex');
const secrets = { OWNER_CREDENTIAL: secret(), ENROLLMENT_CODE: secret(), STATE_ENCRYPTION_KEY: secret(), PRODUCT_STATE_KEY: secret(), FACTORY_CREDENTIAL: secret() };
const config = JSON.parse(await readFile(new URL('../wrangler.json', import.meta.url), 'utf8'));
config.main = '.wrangler/bundle/worker.js';
const options = version => ({ workers: [{ config, vars: { PUBLIC_ORIGIN: origin, TEST_RELOAD: String(version) }, secrets }] });
const server = createTestHarness(options(1));
let checks = 0;
let browser;
let client;
function check(actual, expected, message) { assert.deepEqual(actual, expected, message); checks++; }
async function direct(path, value, headers = {}) {
  return server.getWorker().fetch(origin + path, { method: value === undefined ? 'GET' : 'POST', headers: { 'CF-Connecting-IP': '192.0.2.10', ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: value === undefined ? undefined : JSON.stringify(value) });
}
async function jsonOk(response, status = 200) { const result = await response.json(); check(response.status, status, 'Unexpected response: ' + JSON.stringify(result)); return result; }
async function form(value) { return server.getWorker().fetch(origin + '/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '192.0.2.12' }, body: new URLSearchParams(value).toString() }); }
async function publicConnectionReads() {
  const paths = ['/skill.md', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'];
  for (const path of paths) {
    const baseline = await direct(path);
    check(baseline.status, 200, path);
    check(baseline.headers.get('access-control-allow-origin'), '*');
    check(baseline.headers.get('access-control-allow-credentials'), null);
    check(baseline.headers.get('set-cookie'), null);
    const content = await baseline.text();
    for (const requester of [origin, 'https://chatgpt.com', 'https://www.meta.ai', 'null']) {
      const response = await direct(path, undefined, { Origin: requester, Authorization: 'Bearer synthetic-public-read-marker', Cookie: 'synthetic-public-cookie-marker' });
      check(response.status, 200, path + ' ' + requester);
      check(response.headers.get('access-control-allow-origin'), '*');
      check(response.headers.get('access-control-allow-credentials'), null);
      check(response.headers.get('set-cookie'), null);
      check(response.headers.get('cache-control'), 'no-store');
      const body = await response.text();
      check(body, content, 'Public response varies with caller credentials');
      check(/synthetic-public-(read|cookie)-marker/.test(body), false);
    }
    const post = await direct(path, {}, { Origin: 'null' });
    check(post.status, 403, 'Public POST is not permitted');
    check(post.headers.get('access-control-allow-origin'), null);
    const query = await direct(path + '?token=synthetic');
    check(query.status, 400, 'Public query is not permitted');
    check(query.headers.get('access-control-allow-origin'), null);
    const head = await server.getWorker().fetch(origin + path, { method: 'HEAD', headers: { 'CF-Connecting-IP': '192.0.2.10' } });
    check(head.status, path === '/skill.md' ? 404 : 405, 'Public HEAD support must not expand');
    check(head.headers.get('access-control-allow-origin'), null);
  }
  for (const requester of ['https://chatgpt.com', 'null']) {
    for (const [path, body] of [['/home', undefined], ['/mcp', undefined], ['/api/v1/me', undefined], ['/device/v1/poll', undefined], ['/oauth/register', {}], ['/oauth/token', {}], ['/auth/register/options', {}]]) {
      const response = await direct(path, body, { Origin: requester });
      check(response.status, 403, 'Foreign private route remains denied: ' + path);
      check(response.headers.get('access-control-allow-origin'), null);
      check(response.headers.get('access-control-allow-credentials'), null);
      check(response.headers.get('set-cookie'), null);
    }
  }
}
async function phone(name) {
  const context = await browser.newContext();
  await context.route(origin + '/**', async route => {
    const request = route.request();
    const headers = { ...request.headers(), 'CF-Connecting-IP': name === 'Alex' ? '192.0.2.20' : '192.0.2.21' };
    delete headers.host; delete headers['content-length'];
    const response = await server.getWorker().fetch(request.url(), { method: request.method(), headers, body: request.postData() || undefined, redirect: 'manual' });
    const resultHeaders = Object.fromEntries(response.headers);
    const cookies = response.headers.getSetCookie();
    if (cookies.length) resultHeaders['set-cookie'] = cookies.join('\n');
    await route.fulfill({ status: response.status, headers: resultHeaders, body: Buffer.from(await response.arrayBuffer()) });
  });
  const page = await context.newPage();
  await page.goto(origin + '/welcome');
  await page.addScriptTag({ url: origin + '/product/webauthn.js' });
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const account = await page.evaluate(async name => {
    async function call(path, value) { const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) }); const result = await response.json(); if (!response.ok) throw new Error(path + ': ' + JSON.stringify(result)); return result; }
    const optionsJSON = await call('/auth/register/options', { name });
    const response = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON });
    return call('/auth/register/verify', response);
  }, name);
  check(account.account.name, name);
  async function api(path, value, csrf = account.csrf) {
    return page.evaluate(async ({ path, value, csrf }) => { const response = await fetch(path, { method: value === undefined ? 'GET' : 'POST', headers: value === undefined ? {} : { 'Content-Type': 'application/json', 'X-DisplayOS-CSRF': csrf }, body: value === undefined ? undefined : JSON.stringify(value) }); return { status: response.status, result: await response.json() }; }, { path, value, csrf });
  }
  return { context, page, account, api };
}

try {
  await server.listen();
  await publicConnectionReads();
  browser = await chromium.launch({ headless: true });
  check((await direct('/api/health')).status, 200, 'Legacy service remains healthy');
  check((await direct('/api/v1/me')).status, 401);
  check((await direct('/api/v1/homes?token=not-a-secret')).status, 400);
  check((await direct('/auth/register/options', { name: 'Foreign' }, { Origin: 'https://evil.example.com' })).status, 403);
  const alice = await phone('Alex');
  const bob = await phone('Sam');
  const created = await alice.api('/api/v1/homes', { name: 'Our home' });
  check(created.status, 201, JSON.stringify(created.result));
  const homeId = created.result.home.id;
  const other = await bob.api('/api/v1/homes', { name: 'Another home' });
  check(other.status, 201);
  check((await bob.api('/api/v1/home', { homeId, command: 'home.get' })).status, 403);
  check((await alice.api('/api/v1/home', { homeId, command: 'home.update', input: { name: 'Rejected' } }, 'wrong')).status, 403);
  async function owner(command, input = {}) { const value = await alice.api('/api/v1/home', { homeId, command, input }); check(value.status, 200, command + ': ' + JSON.stringify(value.result)); return value.result; }
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = await crypto.subtle.exportKey('jwk', keys.publicKey);
  check((await direct('/factory/v1/tickets', { serial: 'runtime-one', hardwareProfile: 'browser-demo', publicKey })).status, 401);
  const ticket = await jsonOk(await direct('/factory/v1/tickets', { serial: 'runtime-one', hardwareProfile: 'browser-demo', publicKey }, { Authorization: 'Bearer ' + secrets.FACTORY_CREDENTIAL }), 201);
  const signature = Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(ticket.ticket))).toString('base64url');
  const enrollment = { ticket: ticket.ticket, publicKey, signature };
  const screen = await jsonOk(await direct('/device/v1/enroll', enrollment), 201);
  check((await jsonOk(await direct('/device/v1/enroll', enrollment))).deviceToken, screen.deviceToken, 'Same-key enrollment retry converges');
  const auth = { Authorization: 'Bearer ' + screen.deviceToken };
  const pairing = await jsonOk(await direct('/device/v1/pairing', {}, auth));
  check(/^[A-F0-9]{32}$/.test(pairing.code), true, 'QR connection has a separate 128-bit code');
  check(/^[0-9]{6}$/.test(pairing.manualCode), true, 'Manual pairing uses six numbers');
  check((await direct('/api/v1/claim', { code: pairing.manualCode, homeId }, { Origin: origin })).status, 401, 'Short manual code is not authentication');
  const claim = await alice.api('/api/v1/claim', { code: pairing.manualCode.slice(0, 3) + ' ' + pairing.manualCode.slice(3), homeId });
  check(claim.status, 200);
  check((await owner('home.get')).screens.length, 0, 'Copied QR alone never owns the screen');
  check((await direct('/device/v1/confirm', { phrase: claim.result.phrase })).status, 401);
  check((await bob.api('/api/v1/claim', { code: pairing.code, homeId: other.result.home.id })).status, 410);
  check((await bob.api('/api/v1/claim', { code: pairing.manualCode, homeId: other.result.home.id })).status, 410, 'Manual and QR aliases are both consumed');
  check((await jsonOk(await direct('/device/v1/poll', undefined, auth))).state, 'confirm');
  check((await jsonOk(await direct('/device/v1/confirm', { phrase: claim.result.phrase }, auth))).owned, true);
  check((await owner('home.get')).screens.length, 1);
  for (let attempt = 0; attempt < 3; attempt++) {
    const waiting = await jsonOk(await direct('/device/v1/poll', undefined, auth));
    check(waiting.state, 'owned', 'A connected screen stays owned before its first family update');
    check(waiting.snapshot, null, 'No family update is an empty screen, not expired private content');
    check(waiting.screenIdentifier, screen.deviceId.slice(-6).toUpperCase(), 'The phone and connected screen share a stable readable identifier');
    check(Object.hasOwn(waiting, 'nonce'), false, 'An empty screen has no render receipt to acknowledge');
  }
  const renamed = await owner('screen.rename', { deviceId: screen.deviceId, name: 'Kitchen' });
  check(renamed.saved, true);
  check((await owner('home.get')).screens[0].name, 'Kitchen');
  check((await jsonOk(await direct('/device/v1/poll', undefined, auth))).screenName, 'Kitchen', 'The physical screen identifies its own chosen name');
  check((await bob.api('/api/v1/home', { homeId, command: 'screen.rename', input: { deviceId: screen.deviceId, name: 'Wrong home' } })).status, 403);
  check((await direct('/mcp')).status, 401);
  const metadata = await jsonOk(await direct('/.well-known/oauth-authorization-server'));
  check(metadata.code_challenge_methods_supported, ['S256']);
  const redirectUri = 'https://client.example.com/callback';
  const registration = await jsonOk(await direct('/oauth/register', { client_name: 'Runtime assistant', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'display:read content:write settings:write media:write' }), 201);
  const verifier = random(32);
  const authorization = new URL(origin + '/oauth/authorize');
  authorization.search = new URLSearchParams({ response_type: 'code', client_id: registration.client_id, redirect_uri: redirectUri, state: random(24), code_challenge_method: 'S256', code_challenge: await digest(verifier), resource: origin + '/mcp', scope: 'display:read content:write settings:write media:write', ui_locales: 'en-US' }).toString();
  const ownerCookies = (await alice.context.cookies(origin)).map(cookie => cookie.name + '=' + cookie.value).join('; ');
  const duplicateLocale = new URL(authorization);
  duplicateLocale.searchParams.append('ui_locales', 'en-US');
  check((await server.getWorker().fetch(duplicateLocale.href, { redirect: 'manual', headers: { Cookie: ownerCookies, 'CF-Connecting-IP': '192.0.2.20' } })).status, 400, 'Ignored authorization parameters still reject duplicate names');
  const oversized = new URL(authorization);
  oversized.searchParams.set('ignored_extension', 'x'.repeat(8193));
  check((await server.getWorker().fetch(oversized.href, { redirect: 'manual', headers: { Cookie: ownerCookies, 'CF-Connecting-IP': '192.0.2.20' } })).status, 400, 'Ignored authorization parameters remain bounded');
  const authorizationResponse = await server.getWorker().fetch(authorization.href, { redirect: 'manual', headers: { Cookie: ownerCookies, 'CF-Connecting-IP': '192.0.2.20' } });
  if (authorizationResponse.status !== 302) throw new Error('Authorization navigation: ' + authorizationResponse.status + ' ' + await authorizationResponse.text());
  checks++;
  for (const value of authorizationResponse.headers.getSetCookie()) { const [name, cookieValue] = value.split(';')[0].split('='); await alice.context.addCookies([{ name, value: cookieValue, url: origin, secure: true, httpOnly: true, sameSite: 'Lax' }]); }
  await alice.page.goto(authorizationResponse.headers.get('location'));
  const pending = await alice.api('/api/v1/connections/pending');
  check(pending.status, 200);
  check(pending.result.intents.length, 1, JSON.stringify(pending.result));
  check(Object.hasOwn(pending.result.intents[0], 'ui_locales'), false, 'Ignored locale is not exposed in the permission request');
  check((await owner('home.get')).grants.length, 0, 'ChatGPT-shaped authorization does not grant access before consent');
  const approved = await alice.api('/api/v1/connections/approve', { intentId: pending.result.intents[0].id, homeId, deviceIds: [screen.deviceId], scopes: ['display:read', 'content:write', 'settings:write', 'media:write'], duration: 3600 });
  check(approved.status, 200, JSON.stringify(approved.result));
  const code = new URL(approved.result.redirectUrl).searchParams.get('code');
  check(new URL(approved.result.redirectUrl).searchParams.has('ui_locales'), false, 'Ignored locale is not echoed in the callback');
  const exchange = { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: registration.client_id, redirect_uri: redirectUri, resource: origin + '/mcp' };
  check((await form({ ...exchange, code_verifier: random(32) })).status, 400);
  const tokens = await jsonOk(await form(exchange));
  check(tokens.resource, origin + '/mcp', 'ChatGPT-shaped exchange retains the DisplayOS audience');
  check(tokens.scope.split(' ').sort(), ['display:read', 'content:write', 'settings:write', 'media:write'].sort());
  client = new Client({ name: 'Independent runtime client', version: '1.0.0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(origin + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + tokens.access_token } }, fetch: (url, init) => server.getWorker().fetch(String(url), init) });
  await client.connect(transport);
  const tools = await client.listTools();
  check(tools.tools.length, 11);
  async function tool(name, args = {}) { const value = await client.callTool({ name, arguments: args }); check(value.isError, false, JSON.stringify(value)); return value.structuredContent; }
  const listed = await tool('screen_list');
  check(listed.screens[0].id, screen.deviceId);
  const png = new PNG({ width: 1, height: 1 }); png.data.set([100, 150, 200, 255]);
  const pngPhoto = await tool('media_upload', { data: PNG.sync.write(png).toString('base64'), mime: 'image/png' });
  check(Boolean(pngPhoto.mediaId), true, 'PNG normalization runs inside actual workerd');
  const photo = jpeg.encode({ width: 2, height: 2, data: Buffer.from([250, 180, 150, 255, 250, 180, 150, 255, 150, 180, 250, 255, 150, 180, 250, 255]) }, 70).data.toString('base64');
  const media = await tool('media_upload', { data: photo, mime: 'image/jpeg' });
  check((await tool('media_list')).photos.length, 2);
  check((await bob.api('/api/v1/home', { homeId: other.result.home.id, command: 'media.get', input: { mediaId: media.mediaId } })).status, 404);
  const snapshot = sampleSnapshot(); snapshot.photos = [media.mediaId];
  const update = { deviceId: screen.deviceId, expectedRevision: 0, idempotencyKey: 'runtime-family-one', snapshot };
  const published = await tool('family_publish', update);
  check(published.revision, 1);
  check((await tool('family_publish', update)).revision, 1);
  check((await client.callTool({ name: 'family_publish', arguments: { ...update, idempotencyKey: 'stale-one' } })).isError, true);
  const delivery = await jsonOk(await direct('/device/v1/poll', undefined, auth));
  check(delivery.revision, 1);
  check((await direct('/device/v1/media/' + media.mediaId, undefined, auth)).status, 200);
  check((await tool('revision_status', { deviceId: screen.deviceId, revision: 1 })).status, 'delivered');
  check((await direct('/device/v1/ack', { revision: 1, nonce: 'wrong' }, auth)).status, 403);
  await server.update(options(2));
  const restored = await jsonOk(await direct('/device/v1/poll', undefined, auth));
  check(restored.nonce, delivery.nonce, 'Encrypted actor restart preserves exact delivery');
  check((await jsonOk(await direct('/device/v1/ack', { revision: 1, nonce: restored.nonce }, auth))).rendered, true);
  check((await tool('revision_status', { deviceId: screen.deviceId, revision: 1 })).status, 'rendered');
  await owner('media.delete', { mediaId: media.mediaId });
  const removed = await jsonOk(await direct('/device/v1/poll', undefined, auth));
  check(removed.revision, 2); check(removed.snapshot.photos, []);
  check((await direct('/device/v1/media/' + media.mediaId, undefined, auth)).status, 404);
  const home = await owner('home.get');
  await owner('home.update', { settings: { ...home.settings, showPhotos: false } });
  check((await jsonOk(await direct('/device/v1/poll', undefined, auth))).settings.showPhotos, false);
  const expiring = sampleSnapshot(); expiring.expiresAt = Date.now() + 1000;
  await tool('family_publish', { deviceId: screen.deviceId, snapshot: expiring, expectedRevision: 2, idempotencyKey: 'runtime-expiry' });
  await new Promise(resolve => setTimeout(resolve, 1800));
  check((await jsonOk(await direct('/device/v1/poll', undefined, auth))).snapshot, null);
  check((await tool('family_read', { deviceId: screen.deviceId })).snapshot, null);
  const exportHome = await owner('home.export');
  check(exportHome.home.screens[0].content, undefined, 'Server alarm removes the expired private snapshot');
  const refresh = { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: registration.client_id };
  const rotated = await jsonOk(await form(refresh));
  check(Boolean(rotated.refresh_token), true);
  check(rotated.resource, origin + '/mcp', 'Omitted refresh resource defaults to DisplayOS only');
  check(rotated.scope, tokens.scope, 'Defaulted refresh resource does not expand permissions');
  check((await form(refresh)).status, 400);
  check((await form(exchange)).status, 400);
  check((await direct('/mcp', undefined, { Authorization: 'Bearer ' + rotated.access_token })).status, 401, 'Refresh reuse revokes the whole token family');
  const museRegistration = await jsonOk(await direct('/oauth/register', { client_name: 'Runtime Muse compatibility', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: 'display:read content:write settings:write media:write' }), 201);
  const museVerifier = random(32);
  const museState = random(24);
  const museAuthorization = new URL(origin + '/oauth/authorize');
  museAuthorization.search = new URLSearchParams({ response_type: 'code', client_id: museRegistration.client_id, redirect_uri: redirectUri, state: museState, code_challenge_method: 'S256', code_challenge: await digest(museVerifier), scope: 'display:read content:write settings:write media:write' }).toString();
  const museCookies = (await alice.context.cookies(origin)).map(cookie => cookie.name + '=' + cookie.value).join('; ');
  for (const resource of ['', origin + '/another-resource']) {
    const invalidAuthorization = new URL(museAuthorization);
    invalidAuthorization.searchParams.set('resource', resource);
    const invalidResponse = await server.getWorker().fetch(invalidAuthorization.href, { redirect: 'manual', headers: { Cookie: museCookies, 'CF-Connecting-IP': '192.0.2.20' } });
    check(invalidResponse.status, 400, 'Explicit wrong or empty authorization resource remains denied');
    check((await invalidResponse.json()).error, 'invalid_target');
  }
  const museNavigation = await server.getWorker().fetch(museAuthorization.href, { redirect: 'manual', headers: { Cookie: museCookies, 'CF-Connecting-IP': '192.0.2.20' } });
  check(museNavigation.status, 302, 'Muse-shaped authorization accepts an omitted resource');
  for (const rawCookie of museNavigation.headers.getSetCookie()) {
    const cookie = rawCookie.split(';')[0]; const separator = cookie.indexOf('=');
    await alice.context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: origin, secure: true, httpOnly: true, sameSite: 'Lax' }]);
  }
  await alice.page.goto(museNavigation.headers.get('location'));
  const musePending = await alice.api('/api/v1/connections/pending');
  check(musePending.status, 200);
  check(musePending.result.intents.length, 1);
  const beforeMuseConsent = await owner('home.get');
  check(beforeMuseConsent.grants.some(grant => grant.label === 'Runtime Muse compatibility'), false, 'Omitted resource does not approve the assistant automatically');
  const museConsent = await alice.api('/api/v1/connections/approve', { intentId: musePending.result.intents[0].id, homeId, deviceIds: [screen.deviceId], scopes: ['display:read', 'content:write'], duration: 3600 });
  check(museConsent.status, 200);
  const museCallback = new URL(museConsent.result.redirectUrl);
  check(museCallback.searchParams.get('state'), museState);
  check(museCallback.searchParams.get('iss'), origin);
  const museExchange = { grant_type: 'authorization_code', code: museCallback.searchParams.get('code'), code_verifier: museVerifier, client_id: museRegistration.client_id, redirect_uri: redirectUri };
  for (const resource of ['', origin + '/another-resource']) check((await form({ ...museExchange, resource })).status, 400, 'Explicit invalid exchange resource remains denied');
  check((await form({ ...museExchange, code_verifier: random(32) })).status, 400, 'Defaulted resource still requires the original PKCE verifier');
  const museTokens = await jsonOk(await form(museExchange));
  check(museTokens.resource, origin + '/mcp');
  check(museTokens.scope.split(' ').sort(), ['content:write', 'display:read']);
  const museRefresh = { grant_type: 'refresh_token', refresh_token: museTokens.refresh_token, client_id: museRegistration.client_id };
  for (const resource of ['', origin + '/another-resource']) check((await form({ ...museRefresh, resource })).status, 400, 'Explicit invalid refresh resource remains denied');
  check((await form({ ...museRefresh, client_id: registration.client_id })).status, 400, 'Defaulted refresh resource remains bound to its client');
  const museRotated = await jsonOk(await form(museRefresh));
  check(museRotated.resource, origin + '/mcp');
  check(museRotated.scope, museTokens.scope);
  check(museRotated.refresh_token !== museTokens.refresh_token, true);
  const museClient = new Client({ name: 'Independent Muse-shape runtime client', version: '1.0.0' }, { capabilities: {} });
  try {
    await museClient.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + museRotated.access_token } }, fetch: (url, init) => server.getWorker().fetch(String(url), init) }));
    const museScreens = await museClient.callTool({ name: 'screen_list', arguments: {} });
    check(museScreens.isError, false);
    check(museScreens.structuredContent.screens.map(value => value.id), [screen.deviceId], 'Defaulted audience never exposes another home');
    const museTools = await museClient.listTools();
    check(museTools.tools.some(value => value.name === 'screen_settings' || value.name === 'media_upload'), false, 'Defaulted audience does not advertise unchecked permissions');
    const deniedSettings = await direct('/mcp', { jsonrpc: '2.0', id: 'muse-denied-settings', method: 'tools/call', params: { name: 'screen_settings', arguments: { deviceId: screen.deviceId, settings: home.settings } } }, { Authorization: 'Bearer ' + museRotated.access_token, Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' });
    check(deniedSettings.status, 403, 'Omitted resource does not grant unchecked settings access');
  } finally { await museClient.close().catch(() => {}); }
  check((await form(museRefresh)).status, 400, 'Omitted-resource refresh still detects reuse');
  check((await direct('/mcp', undefined, { Authorization: 'Bearer ' + museRotated.access_token })).status, 401, 'Refresh reuse revokes the default-audience token family');
  const reset = await alice.api('/api/v1/screens/reset', { homeId, deviceId: screen.deviceId });
  check(reset.status, 200);
  check((await jsonOk(await direct('/device/v1/poll', undefined, auth))).state, 'erase');
  await jsonOk(await direct('/device/v1/erase', {}, auth));
  check((await direct('/device/v1/poll', undefined, auth)).status, 401, 'Old credential cannot return after reset');
  const recovery = await jsonOk(await direct('/device/v1/recover/start', { deviceId: screen.deviceId, publicKey }));
  const recoverySignature = Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(recovery.message))).toString('base64url');
  const recovered = await jsonOk(await direct('/device/v1/recover/verify', { deviceId: screen.deviceId, challenge: recovery.challenge, signature: recoverySignature }));
  check((await jsonOk(await direct('/device/v1/poll', undefined, { Authorization: 'Bearer ' + recovered.deviceToken }))).state, 'unclaimed', 'Same-key recovery survives a lost erase response');
  check((await direct('/device/v1/recover/verify', { deviceId: screen.deviceId, challenge: recovery.challenge, signature: recoverySignature })).status, 403);
  const newAuth = { Authorization: 'Bearer ' + recovered.deviceToken };
  const transferPair = await jsonOk(await direct('/device/v1/pairing', {}, newAuth));
  const transferred = await bob.api('/api/v1/claim', { code: transferPair.code, homeId: other.result.home.id });
  check(transferred.status, 200);
  await jsonOk(await direct('/device/v1/confirm', { phrase: transferred.result.phrase }, newAuth));
  check((await bob.api('/api/v1/home', { homeId: other.result.home.id, command: 'home.get' })).result.screens.length, 1);
  const practice = await alice.api('/api/v1/demo-screen', {}); check(practice.status, 201);
  const practiceAuth = { Authorization: 'Bearer ' + practice.result.deviceToken };
  const practicePair = await jsonOk(await direct('/device/v1/pairing', {}, practiceAuth));
  check((await bob.api('/api/v1/claim', { code: practicePair.code, homeId: other.result.home.id })).status, 403, 'Extractable browser trial keys may not cross account ownership');
  const source = await alice.api('/api/v1/providers/status');
  check(source.status, 200); check(source.result.configured, false);
  const invitation = await owner('member.invite');
  const joined = await bob.api('/api/v1/invitations/accept', { code: invitation.code, homeId });
  check(joined.status, 200);
  check((await bob.api('/api/v1/home', { homeId, command: 'home.get' })).status, 200);
  check((await bob.api('/api/v1/home', { homeId, command: 'home.delete' })).status, 403);
  const joinedHome = await owner('home.get');
  const invitedMember = joinedHome.members.find(member => member.name === 'Sam');
  await owner('member.remove', { accountId: invitedMember.accountId });
  check((await bob.api('/api/v1/home', { homeId, command: 'home.get' })).status, 403);
  check((await bob.api('/api/v1/invitations/accept', { code: invitation.code, homeId })).status, 410);
  const deletion = await alice.api('/auth/account/delete', {});
  check(deletion.status, 200);
  check((await alice.api('/api/v1/me')).status, 401);
  check((await direct('/device/v1/poll', undefined, practiceAuth)).status, 401, 'Deleted trial account cannot keep a usable trial transport');
  check((await jsonOk(await direct('/device/v1/poll', undefined, newAuth))).state, 'owned', 'A physically transferred screen survives the previous owner account deletion');
  check((await bob.api('/api/v1/home', { homeId: other.result.home.id, command: 'home.get' })).status, 200, 'Deleting one account leaves another home intact');
  console.log(checks + ' product runtime checks passed: real WebAuthn, encrypted workerd restart, independent MCP client and two-home controls. Synthetic identities, not physical tablet or personal provider proof.');
} finally { await client?.close().catch(() => {}); await browser?.close(); await server.close(); }
