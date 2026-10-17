import { HttpError, reject, json, random, digest, readJson, bearer, text, exact, publicConnectionRead, publicConnectionResponse } from './common.js';
import { validateSnapshot, validateSettings } from './family.js';

const SCOPES = ['display:read', 'content:write', 'settings:write', 'media:write'];
const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const COOKIE = '__Host-displayos-connect';
const INTENT_TTL = 600000;
const CODE_TTL = 120000;
const ACCESS_TTL = 900000;
const CLIENT_TTL = 7776000000;
const LIMITS = { 'client:': 128, 'authorization:': 256, 'code:': 256, 'access:': 1024, 'refresh:': 2048 };
const CONNECTIONS = new Set(['/api/v1/connections/pending', '/api/v1/connections/approve', '/api/v1/connections/revoke', '/api/v1/connections/deny']);
const pruning = new WeakMap();

class OAuthError extends HttpError {
  constructor(status, code, message) { super(status, message); this.code = code; }
}

function invalid(code = 'invalid_request', message = 'This connection request is not supported.', status = 400) {
  throw new OAuthError(status, code, message);
}

function tokenId(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value); }
function identifier(value) { return typeof value === 'string' && /^[A-Za-z0-9_-]{16,80}$/.test(value); }
function noStore(response) {
  response.headers.set('Cache-Control', 'no-store');
  response.headers.set('Pragma', 'no-cache');
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

function method(request, expected) {
  if (request.method !== expected) throw Object.assign(new OAuthError(405, 'invalid_request', 'This method is not supported.'), { allow: expected });
}

function scopeList(value, fallback = ['display:read']) {
  if (value === undefined) {
    if (!fallback.length) invalid('invalid_scope', 'Choose the permissions to approve.');
    return [...fallback];
  }
  if (typeof value === 'string') {
    if (!value || value.length > 200 || !/^[a-z:]+(?: [a-z:]+)*$/.test(value)) invalid('invalid_scope', 'Choose supported permissions.');
    value = value.split(' ');
  }
  if (!Array.isArray(value) || !value.length || value.length > SCOPES.length || value.some(scope => !SCOPES.includes(scope)) || new Set(value).size !== value.length) invalid('invalid_scope', 'Choose supported permissions.');
  return [...value];
}

function parameters(parameters, allowed, ignoreUnknown = false) {
  const result = {};
  const seen = new Set();
  for (const [key, value] of parameters) {
    if (seen.has(key)) invalid();
    seen.add(key);
    if (!allowed.includes(key)) {
      if (ignoreUnknown) continue;
      invalid();
    }
    result[key] = value;
  }
  return result;
}

function connectionResource(value, context) {
  const resource = context.origin + '/mcp';
  if (value !== undefined && value !== resource) invalid('invalid_target', 'This connection is for DisplayOS only.');
  return resource;
}

async function readObject(request, maxBytes) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') || '')) reject(415, 'Please send JSON.');
  return readJson(request, maxBytes);
}

function redirectUri(value, context) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\u0000-\u001f\u007f#*\\]|%2a/i.test(value)) invalid('invalid_redirect_uri', 'Use an exact, secure return address.');
  let url;
  try { url = new URL(value); } catch { invalid('invalid_redirect_uri', 'Use an exact, secure return address.'); }
  const loopback = context.env.ALLOW_LOOPBACK_CLIENTS === '1' && /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d{1,5})?(?:\/|$)/i.test(value);
  if (url.username || url.password || (url.protocol !== 'https:' && !loopback) || !url.hostname || url.hash || ['code', 'state', 'iss', 'error', 'error_description'].some(key => url.searchParams.has(key))) invalid('invalid_redirect_uri', 'Use an exact, secure return address.');
  return value;
}

function transactionCookie(request) {
  const cookies = (request.headers.get('cookie') || '').split(';').map(value => value.trim()).filter(value => value.startsWith(COOKIE + '='));
  if (cookies.length !== 1) return null;
  const value = cookies[0].slice(COOKIE.length + 1);
  return tokenId(value) ? value : null;
}

async function browserHash(request) {
  const value = transactionCookie(request);
  return value ? digest(value) : null;
}

async function admission(request, context, operation, limit = 30, window = 60000) {
  const address = (request.headers.get('CF-Connecting-IP') || 'unknown').slice(0, 80);
  await context.rate('oauth:' + operation + ':' + await digest(address), limit, window);
}

async function prune(store, now) {
  for (const [prefix, limit] of Object.entries(LIMITS)) {
    for (const [key, value] of await store.list(prefix, limit + 1)) {
      if ((value.retainUntil ?? value.expiresAt) <= now) await store.delete(key);
    }
  }
}

async function maybePrune(context) {
  const previous = pruning.get(context);
  const now = context.now();
  if (previous !== undefined && now >= previous && now - previous < 60000) return;
  await context.store.transaction(store => prune(store, now));
  pruning.set(context, now);
}

async function room(store, prefix, count = 1) {
  if ((await store.list(prefix, LIMITS[prefix] + 1)).size + count > LIMITS[prefix]) invalid('temporarily_unavailable', 'Please try this connection again later.', 429);
}

async function activeAccount(context, accountId, authVersion) {
  const account = await context.store.get('account:' + accountId);
  if (!account || account.status !== 'active' || !Number.isSafeInteger(account.authVersion) || (authVersion !== undefined && account.authVersion !== authVersion)) invalid('invalid_grant', 'Please reconnect your assistant.', 401);
  return account;
}

async function client(context, clientId) {
  if (!tokenId(clientId)) invalid('invalid_client', 'This assistant needs to reconnect.');
  const value = await context.store.get('client:' + clientId);
  if (!value || value.expiresAt <= context.now()) invalid('invalid_client', 'This assistant needs to reconnect.');
  return value;
}

async function checkedGrant(context, record) {
  await activeAccount(context, record.accountId, record.accountAuthVersion);
  let grant;
  try {
    grant = await context.homeCall(record.homeId, { accountId: record.accountId }, 'grant.check', { grantId: record.grantId, deviceIds: record.deviceIds });
  } catch (error) {
    if ([401, 403, 404, 410].includes(error.status)) invalid('invalid_grant', 'This assistant no longer has access.', 401);
    throw error;
  }
  if (!grant || grant.id !== record.grantId || grant.accountId !== record.accountId || grant.clientId !== record.clientId || grant.revokedAt || grant.expiresAt <= context.now() || !Array.isArray(grant.scopes) || !Array.isArray(grant.deviceIds) || record.scopes.some(scope => !grant.scopes.includes(scope)) || record.deviceIds.some(id => !grant.deviceIds.includes(id))) invalid('invalid_grant', 'This assistant no longer has access.', 401);
  return grant;
}

async function register(request, context) {
  method(request, 'POST');
  await admission(request, context, 'register', 5, 3600000);
  const submitted = await readObject(request, 8192);
  const value = {};
  for (const field of ['client_name', 'redirect_uris', 'grant_types', 'response_types', 'token_endpoint_auth_method', 'scope']) {
    if (Object.hasOwn(submitted, field)) value[field] = submitted[field];
  }
  if (value.token_endpoint_auth_method !== undefined && value.token_endpoint_auth_method !== 'none') invalid('invalid_client_metadata', 'Only public assistant connections are supported.');
  const grants = value.grant_types ?? ['authorization_code', 'refresh_token'];
  const responses = value.response_types ?? ['code'];
  if (!Array.isArray(grants) || !grants.includes('authorization_code') || grants.length > 2 || new Set(grants).size !== grants.length || grants.some(grant => !['authorization_code', 'refresh_token'].includes(grant)) || !Array.isArray(responses) || responses.length !== 1 || responses[0] !== 'code') invalid('invalid_client_metadata', 'Use authorization code with PKCE.');
  if (!Array.isArray(value.redirect_uris) || !value.redirect_uris.length || value.redirect_uris.length > 5 || new Set(value.redirect_uris).size !== value.redirect_uris.length) invalid('invalid_client_metadata', 'Use a small list of exact return addresses.');
  const redirects = value.redirect_uris.map(uri => redirectUri(uri, context));
  const scopes = scopeList(value.scope, SCOPES);
  const name = value.client_name === undefined ? 'Your assistant' : text(value.client_name, 80);
  const now = context.now();
  const clientId = random();
  await context.store.transaction(async store => {
    await room(store, 'client:');
    await store.put('client:' + clientId, { id: clientId, name, redirectUris: redirects, grantTypes: grants, scopes, createdAt: now, expiresAt: now + CLIENT_TTL });
  });
  return json({ client_id: clientId, client_id_issued_at: Math.floor(now / 1000), client_name: name, redirect_uris: redirects, grant_types: grants, response_types: ['code'], token_endpoint_auth_method: 'none', scope: scopes.join(' ') }, 201);
}

async function authorize(request, context) {
  method(request, 'GET');
  await admission(request, context, 'authorize', 20);
  const url = new URL(request.url);
  if (Buffer.byteLength(url.search, 'utf8') > 8192) invalid();
  const value = parameters(url.searchParams, ['response_type', 'client_id', 'redirect_uri', 'state', 'code_challenge_method', 'code_challenge', 'resource', 'scope'], true);
  const registered = await client(context, value.client_id);
  if (value.response_type !== 'code') invalid('unsupported_response_type', 'Use authorization code with PKCE.');
  if (!registered.redirectUris.includes(value.redirect_uri)) invalid('invalid_redirect_uri', 'The return address does not match this assistant.');
  const resource = connectionResource(value.resource, context);
  if (value.code_challenge_method !== 'S256' || !tokenId(value.code_challenge)) invalid('invalid_request', 'A valid S256 PKCE challenge is required.');
  if (typeof value.state !== 'string' || !value.state || value.state.length > 512 || /[\u0000-\u001f\u007f]/.test(value.state)) invalid();
  // An assistant that omits scope asks for the documented first-connection pair, still bounded by its registration.
  const scopes = scopeList(value.scope, ['display:read', 'content:write'].filter(scope => registered.scopes.includes(scope)));
  if (scopes.some(scope => !registered.scopes.includes(scope))) invalid('invalid_scope', 'Choose permissions registered for this assistant.');
  const cookie = transactionCookie(request) || random();
  const cookieHash = await digest(cookie);
  let principal;
  try { principal = await context.authenticate(request); } catch (error) { if (error.status !== 401) throw error; }
  if (principal) await activeAccount(context, principal.accountId);
  const now = context.now();
  const intentId = random();
  await context.store.transaction(async store => {
    await room(store, 'authorization:');
    const existing = await store.list('authorization:', LIMITS['authorization:'] + 1);
    if ([...existing.values()].filter(record => record.browserHash === cookieHash && record.status === 'pending').length >= 8) invalid('temporarily_unavailable', 'Please finish your open connections first.', 429);
    await store.put('authorization:' + intentId, { id: intentId, clientId: registered.id, label: registered.name, redirectUri: value.redirect_uri, state: value.state, challenge: value.code_challenge, resource, scopes, browserHash: cookieHash, ...(principal ? { accountId: principal.accountId, sessionId: principal.sessionId } : {}), status: 'pending', createdAt: now, expiresAt: now + INTENT_TTL });
    await store.put('client:' + registered.id, { ...registered, expiresAt: now + CLIENT_TTL });
  });
  return new Response(null, { status: 302, headers: { Location: context.origin + '/home#connect=' + intentId, 'Set-Cookie': COOKIE + '=' + cookie + '; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600' } });
}

async function bindIntent(store, intent, principal, hash, now, statuses = ['pending']) {
  if (!intent || !statuses.includes(intent.status) || intent.expiresAt <= now || !hash || intent.browserHash !== hash || (intent.accountId && (intent.accountId !== principal.accountId || intent.sessionId !== principal.sessionId))) invalid('invalid_request', 'Start this connection again.', 403);
  if (!intent.accountId) {
    intent = { ...intent, accountId: principal.accountId, sessionId: principal.sessionId };
    await store.put('authorization:' + intent.id, intent);
  }
  return intent;
}

async function pending(request, context, principal) {
  method(request, 'GET');
  await context.rate('oauth:owner:' + principal.accountId, 120, 60000);
  await maybePrune(context);
  const hash = await browserHash(request);
  const intents = await context.store.transaction(async store => {
    const result = [];
    for (const intent of (await store.list('authorization:', LIMITS['authorization:'] + 1)).values()) {
      if (!hash || intent.browserHash !== hash || !['pending', 'approving'].includes(intent.status) || intent.expiresAt <= context.now() || (intent.accountId && (intent.accountId !== principal.accountId || intent.sessionId !== principal.sessionId))) continue;
      const bound = await bindIntent(store, intent, principal, hash, context.now(), ['pending', 'approving']);
      result.push({ id: bound.id, intentId: bound.id, label: bound.label, clientIdentityVerified: false, redirectOrigin: new URL(bound.redirectUri).origin, scopes: bound.scopes, expiresAt: bound.expiresAt });
    }
    return result;
  });
  return json({ intents });
}

async function approve(request, context, principal, account) {
  method(request, 'POST');
  await context.rate('oauth:approval:' + principal.accountId, 20, 60000);
  await maybePrune(context);
  const value = exact(await readObject(request, 8192), ['intentId', 'homeId', 'deviceIds', 'scopes', 'duration']);
  if (!tokenId(value.intentId) || !identifier(value.homeId) || !Array.isArray(value.deviceIds) || !value.deviceIds.length || value.deviceIds.length > 8 || value.deviceIds.some(id => !identifier(id)) || new Set(value.deviceIds).size !== value.deviceIds.length) invalid();
  const scopes = scopeList(value.scopes, []);
  const duration = value.duration ?? 86400;
  if (!Number.isSafeInteger(duration) || duration < 300 || duration > 2592000) invalid('invalid_request', 'Choose access lasting from five minutes to 30 days.');
  const consent = { homeId: value.homeId, deviceIds: [...value.deviceIds].sort(), scopes: [...scopes].sort(), duration };
  const consentHash = await digest(JSON.stringify(consent));
  const intent = await context.store.transaction(async store => {
    const bound = await bindIntent(store, await store.get('authorization:' + value.intentId), principal, await browserHash(request), context.now(), ['pending', 'approving', 'approved']);
    if (scopes.some(scope => !bound.scopes.includes(scope))) invalid('invalid_scope', 'Only the requested permissions can be approved.');
    if (bound.consentHash && (bound.consentHash !== consentHash || bound.accountAuthVersion !== account.authVersion)) invalid('invalid_request', 'The approved home, screens and permissions cannot change.', 409);
    if (bound.status !== 'pending') return bound;
    await room(store, 'code:');
    const journal = { ...bound, status: 'approving', consent, consentHash, accountAuthVersion: account.authVersion, code: random(), grantExpiresAt: context.now() + duration * 1000, expiresAt: context.now() + duration * 1000 };
    await store.put('authorization:' + bound.id, journal);
    return journal;
  });
  await client(context, intent.clientId);
  if (intent.status === 'approved') {
    if (intent.codeExpiresAt <= context.now()) invalid('invalid_grant', 'Start this connection again.', 410);
    return json({ redirectUrl: intent.redirectUrl });
  }
  const grant = await context.homeCall(consent.homeId, { accountId: principal.accountId }, 'grant.create', { clientId: intent.clientId, label: intent.label, deviceIds: consent.deviceIds, scopes: consent.scopes, expiresAt: intent.grantExpiresAt, operationId: intent.id });
  const redirect = new URL(intent.redirectUri);
  redirect.searchParams.set('code', intent.code);
  redirect.searchParams.set('state', intent.state);
  redirect.searchParams.set('iss', context.origin);
  const codeExpiresAt = Math.min(context.now() + CODE_TTL, intent.grantExpiresAt);
  await context.store.transaction(async store => {
    const current = await bindIntent(store, await store.get('authorization:' + intent.id), principal, await browserHash(request), context.now(), ['approving']);
    if (current.consentHash !== consentHash) invalid('invalid_request', 'The approved permissions cannot change.', 409);
    await room(store, 'code:');
    await activeAccount({ ...context, store }, principal.accountId, account.authVersion);
    await store.put('code:' + await digest(intent.code), { clientId: intent.clientId, redirectUri: intent.redirectUri, resource: intent.resource, challenge: intent.challenge, scopes: consent.scopes, deviceIds: consent.deviceIds, accountId: principal.accountId, accountAuthVersion: account.authVersion, homeId: consent.homeId, grantId: grant.id, grantExpiresAt: intent.grantExpiresAt, expiresAt: codeExpiresAt, used: false });
    const completed = { ...current, status: 'approved', redirectUrl: redirect.href, codeExpiresAt, expiresAt: codeExpiresAt };
    delete completed.code;
    await store.put('authorization:' + intent.id, completed);
  });
  return json({ redirectUrl: redirect.href });
}

async function revokeFamily(context, familyId) {
  const family = await context.store.transaction(async store => {
    const record = await store.get('refresh:family:' + familyId);
    if (!record) return null;
    await store.put('refresh:family:' + familyId, { ...record, revoked: true });
    return record;
  });
  if (family) await context.homeCall(family.homeId, { accountId: family.accountId }, 'grant.revoke', { grantId: family.grantId }).catch(() => {});
}

async function revoke(request, context, principal) {
  method(request, 'POST');
  await context.rate('oauth:approval:' + principal.accountId, 20, 60000);
  await maybePrune(context);
  const value = exact(await readObject(request, 8192), ['homeId', 'grantId']);
  if (!identifier(value.homeId) || !identifier(value.grantId)) invalid();
  const result = await context.homeCall(value.homeId, { accountId: principal.accountId }, 'grant.revoke', { grantId: value.grantId });
  await context.store.transaction(async store => {
    for (const [key, family] of await store.list('refresh:family:', LIMITS['refresh:'] + 1)) {
      if (family.homeId === value.homeId && family.grantId === value.grantId) await store.put(key, { ...family, revoked: true });
    }
  });
  return json(result);
}

async function deny(request, context, principal) {
  method(request, 'POST');
  await context.rate('oauth:approval:' + principal.accountId, 20, 60000);
  await maybePrune(context);
  const value = exact(await readObject(request, 8192), ['intentId']);
  if (!tokenId(value.intentId)) invalid();
  const hash = await browserHash(request);
  if (!hash) invalid('invalid_request', 'Start this connection again.', 403);
  const result = await context.store.transaction(async store => {
    const key = 'authorization:' + value.intentId;
    const intent = await store.get(key);
    if (!intent) return { cancelled: true };
    const bound = await bindIntent(store, intent, principal, hash, context.now(), ['pending', 'denied']);
    const registered = await client({ ...context, store }, bound.clientId);
    const uri = redirectUri(bound.redirectUri, context);
    if (!registered.redirectUris.includes(uri)) invalid('invalid_redirect_uri', 'The return address does not match this assistant.');
    const redirect = new URL(uri);
    redirect.searchParams.set('error', 'access_denied');
    redirect.searchParams.set('state', bound.state);
    redirect.searchParams.set('iss', context.origin);
    if (bound.status !== 'denied') await store.put(key, { id: bound.id, clientId: bound.clientId, redirectUri: uri, state: bound.state, browserHash: bound.browserHash, accountId: bound.accountId, sessionId: bound.sessionId, status: 'denied', expiresAt: bound.expiresAt });
    return { cancelled: true, redirectUrl: redirect.href };
  });
  return json(result);
}

async function readForm(request) {
  if (!/^application\/x-www-form-urlencoded(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') || '')) invalid('invalid_request', 'Send a form-encoded token request.', 415);
  if (!request.body || Number(request.headers.get('content-length')) > 8192) invalid('invalid_request', 'The token request is too large.', 413);
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  let timer;
  const deadline = new Promise((resolve, rejectPromise) => { timer = setTimeout(() => rejectPromise(new OAuthError(408, 'invalid_request', 'Please try again.')), 5000); });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 8192) invalid('invalid_request', 'The token request is too large.', 413);
      chunks.push(part.value);
    }
    const value = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    if (/%(?![0-9a-f]{2})/i.test(value)) invalid();
    return new URLSearchParams(value);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    invalid();
  } finally { clearTimeout(timer); await reader.cancel().catch(() => {}); }
}

function familyBinding(record, family) {
  return family && !family.revoked && ['clientId', 'accountId', 'accountAuthVersion', 'homeId', 'grantId', 'resource'].every(key => record[key] === family[key]) && record.scopes.every(scope => family.scopes.includes(scope)) && record.deviceIds.every(id => family.deviceIds.includes(id));
}

async function issueTokens(context, record, registered, sourceKey, refreshing = false) {
  const now = context.now();
  const access = random();
  const refresh = registered.grantTypes.includes('refresh_token') ? random() : null;
  const familyId = record.familyId || random();
  const expiresAt = Math.min(now + ACCESS_TTL, record.grantExpiresAt);
  const base = { clientId: record.clientId, accountId: record.accountId, accountAuthVersion: record.accountAuthVersion, homeId: record.homeId, grantId: record.grantId, deviceIds: record.deviceIds, scopes: record.scopes, resource: record.resource, issuer: context.origin, familyId, grantExpiresAt: record.grantExpiresAt };
  await context.store.transaction(async store => {
    await room(store, 'access:');
    await room(store, 'refresh:', (refresh ? 1 : 0) + (refreshing ? 0 : 1));
    const current = await store.get(sourceKey);
    if (!current || current.used) invalid('invalid_grant', 'Please reconnect your assistant.');
    await activeAccount({ ...context, store }, record.accountId, record.accountAuthVersion);
    if (refreshing) {
      const family = await store.get('refresh:family:' + familyId);
      if (!familyBinding(record, family) || family.expiresAt <= now) invalid('invalid_grant', 'Please reconnect your assistant.');
    } else await store.put('refresh:family:' + familyId, { ...base, expiresAt: record.grantExpiresAt, revoked: false });
    await store.put('access:' + await digest(access), { ...base, expiresAt });
    if (refresh) await store.put('refresh:token:' + await digest(refresh), { ...base, expiresAt: record.grantExpiresAt, used: false });
    await store.put(sourceKey, { ...current, used: true, familyId, retainUntil: record.grantExpiresAt });
    await store.put('client:' + registered.id, { ...registered, expiresAt: now + CLIENT_TTL });
  });
  return json({ access_token: access, token_type: 'Bearer', expires_in: Math.floor((expiresAt - now) / 1000), ...(refresh ? { refresh_token: refresh } : {}), scope: record.scopes.join(' '), resource: record.resource });
}

async function exchange(request, context) {
  let verified = false;
  try {
    return await tokenExchange(request, context, async record => {
      await checkedGrant(context, record);
      verified = true;
      await context.rate('oauth:mcp-grant:' + record.grantId + ':token', 60, 60000);
      await maybePrune(context);
    });
  } catch (error) {
    if (!verified) {
      await admission(request, context, 'entry', 360);
      await admission(request, context, 'token');
    }
    throw error;
  }
}

async function tokenExchange(request, context, proven) {
  method(request, 'POST');
  if (request.headers.has('authorization')) invalid('invalid_client', 'Public clients use client_id and PKCE, not a client secret.');
  const form = await readForm(request);
  const grantType = form.get('grant_type');
  const allowed = grantType === 'authorization_code' ? ['grant_type', 'code', 'code_verifier', 'client_id', 'redirect_uri', 'resource'] : grantType === 'refresh_token' ? ['grant_type', 'refresh_token', 'client_id', 'resource', 'scope'] : null;
  if (!allowed) invalid('unsupported_grant_type', 'Use authorization code or refresh token.');
  const value = parameters(form, allowed);
  const registered = await client(context, value.client_id);
  const resource = connectionResource(value.resource, context);
  if (!registered.grantTypes.includes(grantType)) invalid('unauthorized_client', 'This grant type was not registered.');
  const refreshing = grantType === 'refresh_token';
  const token = refreshing ? value.refresh_token : value.code;
  if (!tokenId(token)) invalid('invalid_grant', 'Please reconnect your assistant.');
  const key = (refreshing ? 'refresh:token:' : 'code:') + await digest(token);
  let record = await context.store.get(key);
  if (!record || record.clientId !== registered.id || record.resource !== resource) invalid('invalid_grant', 'Please reconnect your assistant.');
  if (!refreshing) {
    if (value.redirect_uri !== record.redirectUri || !registered.redirectUris.includes(value.redirect_uri) || typeof value.code_verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(value.code_verifier) || await digest(value.code_verifier) !== record.challenge) invalid('invalid_grant', 'Please reconnect your assistant.');
  }
  if (record.used) {
    const family = record.familyId && await context.store.get('refresh:family:' + record.familyId);
    if (!familyBinding(record, family) || family.expiresAt <= context.now()) invalid('invalid_grant', 'Please reconnect your assistant.');
    await proven(record);
    await revokeFamily(context, record.familyId);
    invalid('invalid_grant', 'This token was already used. Please reconnect your assistant.');
  }
  if (record.expiresAt <= context.now() || record.grantExpiresAt <= context.now()) invalid('invalid_grant', 'Please reconnect your assistant.');
  if (refreshing) {
    const family = await context.store.get('refresh:family:' + record.familyId);
    if (!familyBinding(record, family) || family.expiresAt <= context.now()) invalid('invalid_grant', 'Please reconnect your assistant.');
    if (value.scope !== undefined) {
      const requested = scopeList(value.scope);
      if (requested.some(scope => !record.scopes.includes(scope))) invalid('invalid_scope', 'A refresh cannot add permissions.');
      record = { ...record, scopes: requested };
    }
  }
  await proven(record);
  return issueTokens(context, record, registered, key, refreshing);
}

export async function authenticateAgent(request, context) {
  let token;
  try { token = bearer(request); } catch { invalid('invalid_token', 'Please connect your assistant.', 401); }
  if (!tokenId(token)) invalid('invalid_token', 'Please connect your assistant.', 401);
  const record = await context.store.get('access:' + await digest(token));
  if (!record || record.expiresAt <= context.now() || record.issuer !== context.origin || record.resource !== context.origin + '/mcp') invalid('invalid_token', 'Please reconnect your assistant.', 401);
  const family = await context.store.get('refresh:family:' + record.familyId);
  if (!familyBinding(record, family) || family.expiresAt <= context.now()) invalid('invalid_token', 'Please reconnect your assistant.', 401);
  try { await client(context, record.clientId); await checkedGrant(context, record); }
  catch (error) { if (error.status === 401 || error.code === 'invalid_client') invalid('invalid_token', 'Please reconnect your assistant.', 401); throw error; }
  return { accountId: record.accountId, homeId: record.homeId, deviceIds: [...record.deviceIds], scopes: [...record.scopes], grantId: record.grantId, clientId: record.clientId };
}

const shortText = { type: 'string', minLength: 1, maxLength: 80 };
const paragraph = { ...shortText, maxLength: 240 };
const dateSchema = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const idSchema = { type: 'string', pattern: '^[A-Za-z0-9_-]{16,80}$' };
function objectSchema(properties, required = Object.keys(properties)) { return { type: 'object', properties, required, additionalProperties: false }; }
function arraySchema(items, maxItems) { return { type: 'array', items, maxItems }; }
const personSchema = objectSchema({ title: shortText, time: shortText, person: shortText });
const peopleSchema = objectSchema({ name: shortText, items: arraySchema(paragraph, 3) }, ['name']);
const listId = { type: 'string', pattern: '^[A-Za-z0-9_-]{8,64}$' };
const listItemSchema = objectSchema({ id: listId, text: shortText, person: shortText, done: { type: 'boolean' } }, ['id', 'text']);
const familyListSchema = objectSchema({ id: listId, title: { type: 'string', minLength: 1, maxLength: 40 }, kind: { type: 'string', enum: ['groceries', 'todo'] }, items: arraySchema(listItemSchema, 12) }, ['id', 'title', 'kind', 'items']);
const voiceId = { type: 'string', pattern: '^[A-Za-z0-9_-]{8,64}$' };
const sceneRowSchema = objectSchema({ label: shortText, value: shortText, tone: { type: 'string', enum: ['plain', 'good', 'warn'] } }, ['label', 'value']);
const sceneBarSchema = objectSchema({ label: { type: 'string', minLength: 1, maxLength: 40 }, value: { type: 'number', minimum: 0, maximum: 1 } });
const sceneBlockSchema = { oneOf: [
  objectSchema({ type: { type: 'string', const: 'text' }, text: paragraph }, ['type', 'text']),
  objectSchema({ type: { type: 'string', const: 'rows' }, rows: { ...arraySchema(sceneRowSchema, 6), minItems: 1 } }, ['type', 'rows']),
  objectSchema({ type: { type: 'string', const: 'chips' }, chips: { ...arraySchema(shortText, 8), minItems: 1 } }, ['type', 'chips']),
  objectSchema({ type: { type: 'string', const: 'steps' }, steps: { ...arraySchema(shortText, 6), minItems: 1 } }, ['type', 'steps']),
  objectSchema({ type: { type: 'string', const: 'bars' }, bars: { ...arraySchema(sceneBarSchema, 6), minItems: 1 } }, ['type', 'bars'])
] };
const displaySceneSchema = objectSchema({ id: voiceId, kind: { type: 'string', enum: ['answer', 'plan', 'list', 'compare', 'steps', 'note', 'timer'] }, title: shortText, subtitle: paragraph, blocks: { ...arraySchema(sceneBlockSchema, 6), minItems: 1 }, ttlSeconds: { type: 'integer', minimum: 30, maximum: 3600 } }, ['id', 'kind', 'title', 'blocks', 'ttlSeconds']);
const voiceAckSchema = objectSchema({ id: voiceId, state: { type: 'string', enum: ['received', 'heard', 'acted', 'failed'] }, heard: paragraph, agentName: { type: 'string', minLength: 1, maxLength: 40 } }, ['id', 'state']);
const snapshotSchema = objectSchema({
  schemaVersion: { type: 'integer', const: 1 }, timezone: shortText, generatedAt: { type: 'integer' }, expiresAt: { type: 'integer' },
  briefing: objectSchema({ title: shortText, text: paragraph }),
  weather: arraySchema(objectSchema({ date: dateSchema, label: shortText, high: { type: 'number', minimum: -100, maximum: 100 }, low: { type: 'number', minimum: -100, maximum: 100 }, condition: shortText }), 7),
  weatherAttribution: { type: 'string', const: 'Weather data by Open-Meteo' },
  week: arraySchema(objectSchema({ date: dateSchema, events: arraySchema(personSchema, 2) }, ['date']), 7),
  reminders: arraySchema(personSchema, 4), kids: arraySchema(peopleSchema, 3), parents: arraySchema(peopleSchema, 3),
  news: arraySchema(objectSchema({ title: shortText, summary: paragraph }), 2), prompts: arraySchema(paragraph, 3),
  nearby: arraySchema(objectSchema({ title: shortText, when: shortText }), 3), photos: { ...arraySchema(idSchema, 20), uniqueItems: true }, lists: arraySchema(familyListSchema, 4),
  displayScene: displaySceneSchema, voiceAck: voiceAckSchema
}, ['schemaVersion', 'timezone', 'generatedAt', 'expiresAt', 'briefing']);
const settingsSchema = objectSchema({ timezone: shortText, quietAfterSeconds: { type: 'integer', minimum: 30, maximum: 1800 }, nightStart: { type: 'string', pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$' }, nightEnd: { type: 'string', pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$' }, brightness: { type: 'integer', minimum: 10, maximum: 100 }, orientation: { type: 'string', enum: ['auto', 'portrait', 'landscape'] }, showPhotos: { type: 'boolean' } });
settingsSchema.properties.temperatureUnit = { type: 'string', enum: ['celsius', 'fahrenheit'] };
const TOOLS = [
  { name: 'screen_list', title: 'Family screens', description: 'List only approved family screens, their current revisions and their configured timezone. Read this before publishing; a family update must use the selected screen timezone exactly.', scope: 'display:read', command: 'screen.list', inputSchema: objectSchema({}), read: true },
  { name: 'screen_capabilities', title: 'What the screen can show', description: 'Read the supported family fields, bounds, expiry rules, settings and photo formats. Dates use YYYY-MM-DD, timestamps use Unix milliseconds and temperatures use Celsius.', scope: 'display:read', command: 'screen.capabilities', inputSchema: objectSchema({}), read: true },
  { name: 'family_read', title: 'Read the current family screen', description: 'Read the current approved family update and revision for an approved screen before making a change. Expired content is not returned.', scope: 'display:read', command: 'family.current', inputSchema: objectSchema({ deviceId: idSchema }), read: true },
  { name: 'media_list', title: 'Available family photos', description: 'List references and dimensions of photos the family has approved in this home. No original files, photo metadata or private albums are returned. Use approved mediaId references in family updates.', scope: 'display:read', command: 'media.list', inputSchema: objectSchema({}), read: true },
  { name: 'family_publish', title: 'Update the family screen', description: 'Publish a bounded update using exactly the selected screen timezone returned by screen_list. Include only family-agreed information. Content expires within 24 hours. Use the current expectedRevision and a new idempotencyKey; keep that key for retries. Accepted is not yet visibly rendered.', scope: 'content:write', command: 'family.publish', inputSchema: objectSchema({ deviceId: idSchema, snapshot: snapshotSchema, expectedRevision: { type: 'integer', minimum: 0 }, idempotencyKey: { type: 'string', minLength: 1, maxLength: 100 } }), read: false },
  { name: 'revision_status', title: 'Check the screen update', description: 'Distinguish accepted, delivered and visibly rendered updates. The screen alone acknowledges visible rendering.', scope: 'display:read', command: 'revision.status', inputSchema: objectSchema({ deviceId: idSchema, revision: { type: 'integer', minimum: 1 } }), read: true },
  { name: 'screen_settings', title: 'Change screen preferences', description: 'Set an approved screen time zone, quiet hours, brightness, orientation, photo preference and optional display temperature unit. This cannot change the operating system or account.', scope: 'settings:write', command: 'screen.settings', inputSchema: objectSchema({ deviceId: idSchema, settings: settingsSchema }), read: false },
  { name: 'media_upload', title: 'Add an agreed family photo', description: 'Upload only a family-approved JPEG or PNG as base64, at most 96 KiB decoded. No links or SVGs. Returned mediaId can be referenced in a family update, not displayed without that update.', scope: 'media:write', command: 'media.upload', inputSchema: objectSchema({ data: { type: 'string', minLength: 1, maxLength: 131072 }, mime: { type: 'string', enum: ['image/jpeg', 'image/png'] } }), read: false },
  { name: 'voice_list', title: 'Family voice messages', description: 'List the family display\'s recent spoken requests with each transcript when one is available, its state and time. The audio is not included here and is fetched separately.', scope: 'display:read', command: 'voice.list', inputSchema: objectSchema({}), read: true },
  { name: 'voice_get', title: 'Listen to a voice message', description: 'Fetch one spoken request as base64 webm audio together with its transcript when one is available, and mark it heard. If no transcript is present, transcribe the audio yourself. Do not ask the person to paste the audio into the chat.', scope: 'display:read', command: 'voice.get', inputSchema: objectSchema({ messageId: voiceId }), read: true },
  { name: 'voice_reply', title: 'Answer a voice message', description: 'Publish a short answer card for the screen and mark the spoken request answered. The displayScene kind is one of answer, plan, list, compare, steps, note or timer, and its blocks are plain text only. Set voiceAck.state to acted and voiceAck.agentName to your own name.', scope: 'content:write', command: 'voice.reply', inputSchema: objectSchema({ deviceId: idSchema, messageId: voiceId, displayScene: displaySceneSchema, voiceAck: voiceAckSchema }), read: false }
];

function rpcError(id, code, message, status = 200) { return json({ jsonrpc: '2.0', id, error: { code, message } }, status); }
function rpcResult(id, result) { return json({ jsonrpc: '2.0', id, result }); }
function requestId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 128 || typeof value === 'number' && Number.isSafeInteger(value); }

function boundedMetadata(value) {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) reject(400, 'Use a small metadata object.');
  let encoded;
  try { encoded = JSON.stringify(value); } catch { reject(400, 'Use a small metadata object.'); }
  if (Buffer.byteLength(encoded, 'utf8') > 4096) reject(400, 'Metadata is too large.');
}

function ignoredString(value, maxBytes) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > maxBytes) reject(400, 'Use bounded implementation metadata.');
}

function methodParams(value) {
  if (Object.hasOwn(value, '_meta')) {
    boundedMetadata(value._meta);
    if (Object.hasOwn(value._meta, 'progressToken')) {
      const token = value._meta.progressToken;
      if (typeof token === 'string') ignoredString(token, 256);
      else if (typeof token !== 'number' || !Number.isSafeInteger(token)) reject(400, 'Use a valid progress token.');
    }
  }
  const result = { ...value };
  delete result._meta;
  return result;
}

function implementationMetadata(value) {
  exact(value, ['name', 'version', 'title', 'description', 'websiteUrl', 'icons']);
  boundedMetadata(value);
  text(value.name, 80); text(value.version, 80);
  if (value.title !== undefined) text(value.title, 80);
  if (value.description !== undefined) ignoredString(value.description, 1024);
  if (value.websiteUrl !== undefined) ignoredString(value.websiteUrl, 2048);
  if (value.icons !== undefined) {
    if (!Array.isArray(value.icons) || value.icons.length > 8) reject(400, 'Use a small icon list.');
    for (const icon of value.icons) {
      exact(icon, ['src', 'mimeType', 'sizes', 'theme']);
      ignoredString(icon.src, 2048);
      if (icon.mimeType !== undefined) ignoredString(icon.mimeType, 128);
      if (icon.theme !== undefined && !['light', 'dark'].includes(icon.theme)) reject(400, 'Use a supported icon theme.');
      if (icon.sizes !== undefined) {
        if (!Array.isArray(icon.sizes) || icon.sizes.length > 8) reject(400, 'Use a small icon size list.');
        for (const size of icon.sizes) ignoredString(size, 32);
      }
    }
  }
}

function toolInput(tool, input, context, principal) {
  exact(input, Object.keys(tool.inputSchema.properties));
  if (tool.inputSchema.required.some(key => !Object.hasOwn(input, key))) reject(400, 'Include the required fields.');
  if (input.deviceId !== undefined && (!identifier(input.deviceId) || !principal.deviceIds.includes(input.deviceId))) reject(403, 'This screen was not approved for the assistant.');
  if (tool.name === 'family_publish') {
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) reject(400, 'Use a current revision.');
    return { ...input, snapshot: validateSnapshot(input.snapshot, context.now()), idempotencyKey: text(input.idempotencyKey, 100) };
  }
  if (tool.name === 'revision_status' && (!Number.isSafeInteger(input.revision) || input.revision < 1)) reject(400, 'Use a valid revision.');
  if (tool.name === 'screen_settings') return { ...input, settings: validateSettings(input.settings) };
  if (tool.name === 'media_upload' && (!['image/jpeg', 'image/png'].includes(input.mime) || typeof input.data !== 'string' || !input.data.length || input.data.length > 131072 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.data) || Buffer.from(input.data, 'base64').length > 98304)) reject(400, 'Use a small, approved JPEG or PNG photo.');
  return input;
}

function challenge(context, code = 'invalid_token', scope) {
  return 'Bearer resource_metadata="' + context.origin + '/.well-known/oauth-protected-resource/mcp", error="' + code + '", scope="' + (scope || 'display:read') + '"';
}

async function connectionDiagnostic(request, response, received) {
  try {
    const methods = ['server/discover', 'initialize', 'ping', 'tools/list', 'tools/call', 'resources/list', 'resources/templates/list', 'prompts/list', 'notifications/initialized', 'notifications/cancelled'];
    const methodName = methods.includes(received?.method) ? received.method : 'other';
    const value = response.status === 202 ? null : await response.clone().json();
    if (!value?.error && !['initialize', 'tools/list'].includes(methodName)) return;
    const header = request.headers.get('MCP-Protocol-Version');
    console.info(JSON.stringify({ event: 'displayos_mcp_scan', method: methodName, status: response.status, protocolHeader: header === null ? 'absent' : VERSIONS.includes(header) ? header : 'unsupported', rpcError: Number.isInteger(value?.error?.code) ? value.error.code : null, toolCount: Array.isArray(value?.result?.tools) ? value.result.tools.length : null }));
  } catch {}
}

async function mcp(request, context, principal, diagnostic) {
  await context.rate('oauth:mcp-grant:' + principal.grantId, 120, 60000);
  await maybePrune(context);
  method(request, 'POST');
  const protocol = request.headers.get('MCP-Protocol-Version') || '2025-03-26';
  if (!VERSIONS.includes(protocol)) return rpcError(null, -32600, 'Unsupported MCP protocol version.', 400);
  const accept = request.headers.get('accept') || '';
  if (!accept.split(',').some(value => /^application\/json(?:\s*;|\s*$)/i.test(value.trim())) || !accept.split(',').some(value => /^text\/event-stream(?:\s*;|\s*$)/i.test(value.trim()))) return rpcError(null, -32600, 'Accept application/json and text/event-stream.', 406);
  let message;
  try {
    message = await readObject(request, 150000);
    diagnostic.message = message;
    message = exact(message, ['jsonrpc', 'id', 'method', 'params']);
  }
  catch (error) { return rpcError(null, error.status === 400 ? -32700 : -32600, 'Use a single bounded JSON-RPC request.', error.status || 400); }
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string' || message.method.length > 80 || (Object.hasOwn(message, 'id') && !requestId(message.id))) return rpcError(null, -32600, 'Invalid JSON-RPC request.', 400);
  const notification = !Object.hasOwn(message, 'id');
  const received = message.params === undefined ? {} : message.params;
  if (!received || typeof received !== 'object' || Array.isArray(received)) return rpcError(notification ? null : message.id, -32602, 'Use an object for method parameters.', notification ? 400 : 200);
  let params;
  try { params = methodParams(received); }
  catch { return rpcError(notification ? null : message.id, -32602, 'Use bounded standard metadata.', notification ? 400 : 200); }
  if (notification) {
    try {
      if (message.method === 'notifications/initialized') exact(params, []);
      else if (message.method === 'notifications/cancelled') { exact(params, ['requestId', 'reason']); if (!requestId(params.requestId) || (params.reason !== undefined && (typeof params.reason !== 'string' || params.reason.length > 240))) reject(400, 'Invalid notification.'); }
      else return rpcError(null, -32600, 'Unsupported notification.', 400);
    } catch { return rpcError(null, -32600, 'Invalid notification.', 400); }
    return new Response(null, { status: 202 });
  }
  if (message.method === 'initialize') {
    let stage = 'parameters';
    try {
      exact(params, ['protocolVersion', 'capabilities', 'clientInfo']);
      stage = 'version';
      if (typeof params.protocolVersion !== 'string' || params.protocolVersion.length > 32) reject(400, 'Invalid version.');
      stage = 'capabilities';
      boundedMetadata(params.capabilities);
      for (const capability of Object.values(params.capabilities)) if (!capability || typeof capability !== 'object' || Array.isArray(capability)) reject(400, 'Invalid capabilities.');
      stage = 'client-metadata';
      implementationMetadata(params.clientInfo);
    } catch {
      console.info(JSON.stringify({ event: 'displayos_mcp_scan_rejected', stage }));
      return rpcError(message.id, -32602, 'Invalid initialization parameters.');
    }
    return rpcResult(message.id, { protocolVersion: VERSIONS.includes(params.protocolVersion) ? params.protocolVersion : VERSIONS[0], capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'DisplayOS', title: 'DisplayOS', version: '1.0.0' }, instructions: 'Use only approved family information. Read screen capabilities before publishing. Content expires within 24 hours. Accepted, delivered and rendered are different states. This connection cannot operate the tablet OS or administer family accounts.' });
  }
  if (message.method === 'ping') {
    try { exact(params, []); } catch { return rpcError(message.id, -32602, 'Invalid ping parameters.'); }
    return rpcResult(message.id, {});
  }
  if (message.method === 'tools/list') {
    try { exact(params, []); } catch { return rpcError(message.id, -32602, 'This server does not paginate tools.'); }
    return rpcResult(message.id, { tools: TOOLS.filter(tool => principal.scopes.includes(tool.scope)).map(({ name, title, description, inputSchema, read, scope }) => ({ name, title, description, inputSchema, annotations: { readOnlyHint: read, destructiveHint: !read, idempotentHint: name !== 'media_upload', openWorldHint: false }, securitySchemes: [{ type: 'oauth2', scopes: [scope] }] })) });
  }
  if (message.method !== 'tools/call') return rpcError(message.id, -32601, 'This method is not supported.');
  try { exact(params, ['name', 'arguments']); } catch { return rpcError(message.id, -32602, 'Use a supported tool and its arguments.'); }
  const tool = TOOLS.find(value => value.name === params.name);
  if (!tool) return rpcError(message.id, -32602, 'This tool is not available.');
  if (!principal.scopes.includes(tool.scope)) return json({ error: 'This permission was not approved.' }, 403, { 'WWW-Authenticate': challenge(context, 'insufficient_scope', tool.scope) });
  try {
    const input = toolInput(tool, params.arguments === undefined ? {} : params.arguments, context, principal);
    const result = await context.homeCall(principal.homeId, principal, tool.command, input);
    return rpcResult(message.id, { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result, isError: false });
  } catch (error) {
    const messageText = error.status && error.status < 500 ? error.message : 'We could not save this change. Please try again.';
    return rpcResult(message.id, { content: [{ type: 'text', text: messageText }], isError: true });
  }
}

async function revokeToken(request, context) {
  method(request, 'POST');
  await admission(request, context, 'token-revoke');
  if (request.headers.has('authorization')) invalid('invalid_client', 'Public clients use client_id.');
  const value = parameters(await readForm(request), ['client_id', 'token', 'token_type_hint', 'resource']);
  const registered = await client(context, value.client_id);
  if (value.resource !== undefined && value.resource !== context.origin + '/mcp') invalid('invalid_target');
  if (value.token_type_hint !== undefined && !['access_token', 'refresh_token'].includes(value.token_type_hint)) invalid('unsupported_token_type');
  if (!tokenId(value.token)) return new Response(null, { status: 200 });
  const hash = await digest(value.token);
  const record = await context.store.get('refresh:token:' + hash) || await context.store.get('access:' + hash);
  if (record?.clientId === registered.id) await revokeFamily(context, record.familyId);
  return new Response(null, { status: 200 });
}

export async function oauthRoute(request, context) {
  const url = new URL(request.url);
  const path = url.pathname;
  const metadata = path === '/.well-known/oauth-authorization-server' || path === '/.well-known/oauth-protected-resource' || path === '/.well-known/oauth-protected-resource/mcp';
  if (!metadata && !path.startsWith('/oauth/') && path !== '/mcp' && !CONNECTIONS.has(path)) return null;
  try {
    if (url.origin !== context.origin || url.protocol !== 'https:' || url.username || url.password || url.hash) reject(403, 'Use the secure DisplayOS address.');
    if (url.search && path !== '/oauth/authorize') invalid();
    const origin = request.headers.get('origin');
    if (origin !== null && origin !== context.origin && !publicConnectionRead(request)) reject(403, 'This page cannot access the connection.');
    let principal;
    let account;
    if (CONNECTIONS.has(path)) {
      try {
        principal = path === '/api/v1/connections/pending' ? await context.authenticate(request) : await context.requireBrowser(request);
        account = await activeAccount(context, principal.accountId);
      } catch (error) {
        await admission(request, context, 'entry', 360);
        throw error;
      }
      await context.rate('oauth:owner:entry:' + principal.accountId, 360, 60000);
    } else if (path === '/mcp') {
      try { principal = await authenticateAgent(request, context); }
      catch (error) {
        await admission(request, context, 'entry', 360);
        await admission(request, context, 'mcp', 180);
        throw error;
      }
    } else if (path !== '/oauth/token') {
      await admission(request, context, 'entry', 360);
      if (['/oauth/register', '/oauth/authorize', '/oauth/revoke'].includes(path)) await maybePrune(context);
    }
    let response;
    if (metadata) {
      method(request, 'GET');
      await admission(request, context, 'metadata', 120);
      response = path === '/.well-known/oauth-authorization-server'
        ? json({ issuer: context.origin, authorization_endpoint: context.origin + '/oauth/authorize', token_endpoint: context.origin + '/oauth/token', registration_endpoint: context.origin + '/oauth/register', revocation_endpoint: context.origin + '/oauth/revoke', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], token_endpoint_auth_methods_supported: ['none'], revocation_endpoint_auth_methods_supported: ['none'], code_challenge_methods_supported: ['S256'], scopes_supported: SCOPES, authorization_response_iss_parameter_supported: true, client_id_metadata_document_supported: false })
        : json({ resource: context.origin + '/mcp', authorization_servers: [context.origin], scopes_supported: SCOPES, bearer_methods_supported: ['header'], resource_name: 'DisplayOS' });
    } else if (path === '/oauth/register') response = await register(request, context);
    else if (path === '/oauth/authorize') response = await authorize(request, context);
    else if (path === '/oauth/token') response = await exchange(request, context);
    else if (path === '/oauth/revoke') response = await revokeToken(request, context);
    else if (path === '/api/v1/connections/pending') response = await pending(request, context, principal);
    else if (path === '/api/v1/connections/approve') response = await approve(request, context, principal, account);
    else if (path === '/api/v1/connections/revoke') response = await revoke(request, context, principal);
    else if (path === '/api/v1/connections/deny') response = await deny(request, context, principal);
    else if (path === '/mcp') {
      const diagnostic = {};
      response = await mcp(request, context, principal, diagnostic);
      await connectionDiagnostic(request, response, diagnostic.message);
    }
    else response = json({ error: 'This connection route is not available.' }, 404);
    return noStore(publicConnectionResponse(request, response));
  } catch (error) {
    const status = path === '/oauth/token' && error.code === 'invalid_grant' && error.status === 401 ? 400 : error.status || 503;
    const headers = {};
    if (error.allow) headers.Allow = error.allow;
    if (path === '/mcp' && status === 401) headers['WWW-Authenticate'] = challenge(context);
    const code = error.code || (status === 401 ? 'invalid_token' : status === 429 ? 'temporarily_unavailable' : status >= 500 ? 'server_error' : 'invalid_request');
    return noStore(json({ error: code, error_description: error.status ? error.message : 'Please try this connection again.' }, status, headers));
  }
}
