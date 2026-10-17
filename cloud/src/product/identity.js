import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { isoBase64URL, decodeAttestationObject } from '@simplewebauthn/server/helpers';
import { reject, json, random, digest, readJson, exact } from './common.js';

const SESSION_COOKIE = '__Host-displayos';
const CHALLENGE_COOKIE = '__Host-displayos-challenge';
const SESSION_TTL = 12 * 60 * 60 * 1000;
const CHALLENGE_TTL = 5 * 60 * 1000;
const RECENT_TTL = 5 * 60 * 1000;
const RECOVERY_TTL = 365 * 24 * 60 * 60 * 1000;
const MAX_ACCOUNTS = 128;
const MAX_PASSKEYS = 8;
const MAX_SESSIONS = 8;
const MAX_CHALLENGES = 128;
const RECOVERY_COUNT = 8;
const ALGORITHMS = [-7, -257];
const ROUTES = new Set([
  '/auth/register/options', '/auth/register/verify', '/auth/login/options', '/auth/login/verify',
  '/auth/passkey/options', '/auth/passkey/verify', '/auth/recovery/create', '/auth/recovery/use',
  '/auth/logout', '/auth/account/delete', '/api/v1/me',
]);
const RECOVERY_ROUTES = new Set(['/api/v1/me', '/auth/passkey/options', '/auth/passkey/verify', '/auth/logout', '/auth/account/delete']);
const EXTERNAL_NAVIGATIONS = new Set(['/oauth/authorize', '/api/v1/providers/google/callback']);

function boundary(request, context) {
  let configured;
  try { configured = new URL(context.origin); } catch { reject(503, 'Identity is not configured'); }
  if (configured.protocol !== 'https:' || configured.origin !== context.origin || configured.username || configured.password) reject(503, 'Identity is not configured');
  const url = new URL(request.url);
  if (url.origin !== context.origin || url.username || url.password) reject(403, 'Origin rejected');
  const origin = request.headers.get('Origin');
  if ((request.method === 'POST' || origin !== null) && origin !== context.origin) reject(403, 'Origin rejected');
  const externalNavigation = request.method === 'GET' && EXTERNAL_NAVIGATIONS.has(url.pathname)
    && request.headers.get('Sec-Fetch-Mode') === 'navigate' && request.headers.get('Sec-Fetch-Dest') === 'document';
  if (request.headers.get('Sec-Fetch-Site') === 'cross-site' && !externalNavigation) reject(403, 'Origin rejected');
  return { url, rpID: configured.hostname };
}

function cookie(request, name) {
  const header = request.headers.get('Cookie') || '';
  if (header.length > 8192) reject(400, 'Invalid cookie');
  const values = header.split(';').map(part => part.trim()).filter(part => part.startsWith(name + '='));
  if (values.length > 1) reject(400, 'Invalid cookie');
  return values.length ? values[0].slice(name.length + 1) : null;
}

function cookieValue(name, value, ttl) {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(ttl / 1000)}`;
}

function reply(value, cookies = []) {
  const response = json(value, 200, { 'Cache-Control': 'no-store', 'Vary': 'Cookie' });
  for (const value of cookies) response.headers.append('Set-Cookie', value);
  return response;
}

function equal(first, second) {
  if (typeof first !== 'string' || typeof second !== 'string' || first.length !== second.length) return false;
  let difference = 0;
  for (let index = 0; index < first.length; index++) difference |= first.charCodeAt(index) ^ second.charCodeAt(index);
  return difference === 0;
}

async function sessionKey(request) {
  const value = cookie(request, SESSION_COOKIE);
  if (!value || !/^[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/.test(value)) return null;
  const [accountId, token] = value.split('.');
  return `session:${accountId}:${await digest(token)}`;
}

export async function authenticate(request, context) {
  const { url } = boundary(request, context);
  const key = await sessionKey(request);
  const session = key && await context.store.get(key);
  if (!session || session.expiresAt <= context.now()) {
    await limited(context, request, null);
    reject(401, 'Sign in required');
  }
  const account = await context.store.get('account:' + session.accountId);
  if (!account || session.authVersion !== account.authVersion || (account.status !== 'active' && !(account.status === 'deleting' && url.pathname === '/auth/account/delete'))) {
    await limited(context, request, null);
    reject(401, 'Sign in required');
  }
  if (!account.credentialIds.length && !RECOVERY_ROUTES.has(url.pathname)) reject(403, 'Add a new passkey to finish recovery');
  return { accountId: account.id, sessionId: session.sessionId, csrf: session.csrf, verifiedAt: session.verifiedAt };
}

export async function requireBrowser(request, context) {
  const principal = await authenticate(request, context);
  if (request.method === 'POST' && !equal(request.headers.get('X-DisplayOS-CSRF'), principal.csrf)) reject(403, 'Browser confirmation required');
  return principal;
}

function recent(principal, now) {
  if (!Number.isFinite(principal.verifiedAt) || principal.verifiedAt > now || now - principal.verifiedAt > RECENT_TTL) reject(403, 'Verify your passkey again');
}

async function limited(context, request, principal) {
  if (principal) return context.rate('identity:account:' + principal.accountId, 120, 60000);
  await context.rate('identity:public', 300, 60000);
  const client = await digest(request.headers.get('CF-Connecting-IP') || 'unknown');
  await context.rate('identity:client:' + client, 30, 60000);
}

async function prune(store, now) {
  for (const [prefix, limit] of [['challenge:', MAX_CHALLENGES], ['session:', MAX_ACCOUNTS * MAX_SESSIONS], ['recovery:', MAX_ACCOUNTS * RECOVERY_COUNT]]) {
    const records = await store.list(prefix, limit + 1);
    if (records.size > limit) reject(503, 'Identity capacity unavailable');
    for (const [key, record] of records) if (record.expiresAt <= now) await store.delete(key);
  }
}

function name(value) {
  if (typeof value !== 'string') reject(400, 'Choose a name');
  const result = value.trim().normalize('NFC');
  if (!result || result.length > 80 || /[<>\u0000-\u001f\u007f]/u.test(result)) reject(400, 'Choose a name');
  return result;
}

function encoded(value, maximum) {
  if (typeof value !== 'string' || !value || value.length > maximum || !/^[A-Za-z0-9_-]+$/.test(value)) reject(400, 'Passkey verification failed');
  let bytes;
  try { bytes = isoBase64URL.toBuffer(value); } catch { reject(400, 'Passkey verification failed'); }
  if (isoBase64URL.fromBuffer(bytes) !== value) reject(400, 'Passkey verification failed');
  return bytes;
}

function webauthnResponse(value, registration, origin) {
  exact(value, ['id', 'rawId', 'type', 'response', 'clientExtensionResults', 'authenticatorAttachment']);
  encoded(value.id, 1400);
  if (value.rawId !== value.id || value.type !== 'public-key') reject(400, 'Passkey verification failed');
  exact(value.response, registration
    ? ['clientDataJSON', 'attestationObject', 'transports', 'publicKeyAlgorithm', 'publicKey', 'authenticatorData']
    : ['clientDataJSON', 'authenticatorData', 'signature', 'userHandle']);
  const bytes = encoded(value.response.clientDataJSON, 4096);
  let client;
  try { client = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { reject(400, 'Passkey verification failed'); }
  if (!client || typeof client !== 'object' || Array.isArray(client) || client.origin !== origin || (client.crossOrigin !== undefined && client.crossOrigin !== false) || client.topOrigin !== undefined) reject(400, 'Passkey verification failed');
  if (registration) {
    let attestation;
    try { attestation = decodeAttestationObject(encoded(value.response.attestationObject, 24000)); } catch { reject(400, 'Passkey verification failed'); }
    if (!(attestation instanceof Map) || attestation.get('fmt') !== 'none' || !(attestation.get('attStmt') instanceof Map) || attestation.get('attStmt').size) reject(400, 'Passkey verification failed');
    const transports = value.response.transports;
    if (transports !== undefined && (!Array.isArray(transports) || transports.length > 8 || transports.some(value => typeof value !== 'string' || value.length > 16))) reject(400, 'Passkey verification failed');
    if (value.clientExtensionResults?.credProps?.rk === false) reject(400, 'A discoverable passkey is required');
  } else {
    encoded(value.response.authenticatorData, 8192);
    encoded(value.response.signature, 4096);
    encoded(value.response.userHandle, 86);
  }
  return value;
}

async function challengeKey(request) {
  const value = cookie(request, CHALLENGE_COOKIE);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? 'challenge:' + await digest(value) : null;
}

async function issueChallenge(request, context, record, options) {
  const binding = random();
  const key = 'challenge:' + await digest(binding);
  const previous = await challengeKey(request);
  await context.store.transaction(async store => {
    await prune(store, context.now());
    if (previous) await store.delete(previous);
    const challenges = await store.list('challenge:', MAX_CHALLENGES + 1);
    const group = [...challenges.values()].filter(value => Boolean(value.sessionId) === Boolean(record.sessionId));
    if (group.length >= MAX_CHALLENGES / 2 || challenges.size >= MAX_CHALLENGES) reject(429, 'Try again shortly');
    if (record.sessionId && group.filter(value => value.accountId === record.accountId).length >= 4) reject(429, 'Finish an existing verification first');
    if (record.kind === 'register' && (await store.list('account:', MAX_ACCOUNTS + 1)).size >= MAX_ACCOUNTS) reject(429, 'Registration unavailable');
    await store.put(key, { ...record, challenge: options.challenge, createdAt: context.now(), expiresAt: context.now() + CHALLENGE_TTL });
  });
  return reply(options, [cookieValue(CHALLENGE_COOKIE, binding, CHALLENGE_TTL)]);
}

async function consumeChallenge(request, context, kind) {
  const key = await challengeKey(request);
  if (!key) reject(400, 'Start verification again');
  const challenge = await context.store.transaction(async store => {
    const record = await store.get(key);
    if (record) await store.delete(key);
    return record;
  });
  if (!challenge || challenge.kind !== kind || challenge.expiresAt <= context.now()) reject(400, 'Start verification again');
  return challenge;
}

async function newSession(store, request, account, now) {
  const existing = await sessionKey(request);
  if (existing) await store.delete(existing);
  const sessions = await store.list('session:' + account.id + ':', MAX_SESSIONS + 1);
  const ordered = [...sessions].sort((first, second) => first[1].createdAt - second[1].createdAt || first[0].localeCompare(second[0]));
  while (ordered.length >= MAX_SESSIONS) await store.delete(ordered.shift()[0]);
  const token = random();
  const session = { accountId: account.id, sessionId: await digest(token), csrf: random(), verifiedAt: now, createdAt: now, expiresAt: now + SESSION_TTL, authVersion: account.authVersion };
  await store.put(`session:${account.id}:${session.sessionId}`, session);
  return { value: { account: { name: account.name }, csrf: session.csrf, ...(!account.credentialIds.length ? { needsPasskey: true } : {}) }, cookies: [cookieValue(SESSION_COOKIE, account.id + '.' + token, SESSION_TTL), cookieValue(CHALLENGE_COOKIE, '', 0)] };
}

async function optionsRoute(request, context, kind, rpID) {
  const value = await readJson(request, 32768);
  exact(value, kind === 'register' ? ['name'] : []);
  const principal = kind === 'passkey' ? await requireBrowser(request, context) : null;
  if (principal) recent(principal, context.now());
  await limited(context, request, principal);
  if (kind === 'login') {
    const options = await generateAuthenticationOptions({ rpID, timeout: CHALLENGE_TTL, userVerification: 'required', allowCredentials: [] });
    return issueChallenge(request, context, { kind }, options);
  }
  const account = principal ? await context.store.get('account:' + principal.accountId) : { id: random(16), name: name(value.name), userHandle: random(), credentialIds: [] };
  if (account.credentialIds.length >= MAX_PASSKEYS) reject(409, 'Passkey limit reached');
  const options = await generateRegistrationOptions({
    rpName: 'DisplayOS', rpID, userName: account.name, userDisplayName: account.name,
    userID: isoBase64URL.toBuffer(account.userHandle), timeout: CHALLENGE_TTL, attestationType: 'none',
    supportedAlgorithmIDs: ALGORITHMS, excludeCredentials: account.credentialIds.map(id => ({ id })),
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
  });
  return issueChallenge(request, context, {
    kind, accountId: account.id, name: account.name, userHandle: account.userHandle,
    ...(principal ? { sessionId: principal.sessionId, authVersion: account.authVersion } : {}),
  }, options);
}

async function registration(request, context, kind, rpID) {
  const principal = kind === 'passkey' ? await requireBrowser(request, context) : null;
  if (principal) recent(principal, context.now());
  await limited(context, request, principal);
  const response = webauthnResponse(await readJson(request, 32768), true, context.origin);
  const challenge = await consumeChallenge(request, context, kind);
  if (principal && (challenge.accountId !== principal.accountId || challenge.sessionId !== principal.sessionId)) reject(400, 'Passkey verification failed');
  let verification;
  try {
    verification = await verifyRegistrationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: context.origin, expectedRPID: rpID, requireUserPresence: true, requireUserVerification: true, supportedAlgorithmIDs: ALGORITHMS });
  } catch { reject(400, 'Passkey verification failed'); }
  if (!verification.verified || !verification.registrationInfo.userVerified || verification.registrationInfo.credential.id !== response.id) reject(400, 'Passkey verification failed');
  const information = verification.registrationInfo;
  const session = await context.store.transaction(async store => {
    await prune(store, context.now());
    if (await store.get('credential:' + response.id)) reject(400, 'Passkey verification failed');
    let account = await store.get('account:' + challenge.accountId);
    if (kind === 'register') {
      if (account || (await store.list('account:', MAX_ACCOUNTS + 1)).size >= MAX_ACCOUNTS) reject(400, 'Registration unavailable');
      account = { id: challenge.accountId, name: challenge.name, userHandle: challenge.userHandle, credentialIds: [], recoveryHashes: [], authVersion: 1, status: 'active', createdAt: context.now() };
    } else if (!account || account.status !== 'active' || account.authVersion !== challenge.authVersion || account.credentialIds.length >= MAX_PASSKEYS) reject(400, 'Passkey verification failed');
    await store.put('credential:' + response.id, {
      id: response.id, accountId: account.id, publicKey: isoBase64URL.fromBuffer(information.credential.publicKey),
      counter: information.credential.counter, transports: information.credential.transports || [],
      deviceType: information.credentialDeviceType, backedUp: information.credentialBackedUp, createdAt: context.now(),
    });
    account.credentialIds.push(response.id);
    await store.put('account:' + account.id, account);
    return newSession(store, request, account, context.now());
  });
  return reply(session.value, session.cookies);
}

async function login(request, context, rpID) {
  await limited(context, request, null);
  const response = webauthnResponse(await readJson(request, 32768), false, context.origin);
  const challenge = await consumeChallenge(request, context, 'login');
  const credential = await context.store.get('credential:' + response.id);
  const account = credential && await context.store.get('account:' + credential.accountId);
  if (!account || account.status !== 'active' || !account.credentialIds.includes(response.id) || response.response.userHandle !== account.userHandle || (account.sessionsInvalidatedAt !== undefined && challenge.createdAt <= account.sessionsInvalidatedAt)) reject(400, 'Passkey verification failed');
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response, expectedChallenge: challenge.challenge, expectedOrigin: context.origin, expectedRPID: rpID,
      credential: { id: credential.id, publicKey: isoBase64URL.toBuffer(credential.publicKey), counter: credential.counter, transports: credential.transports },
      requireUserVerification: true,
    });
  } catch { reject(400, 'Passkey verification failed'); }
  if (!verification.verified || !verification.authenticationInfo.userVerified) reject(400, 'Passkey verification failed');
  const session = await context.store.transaction(async store => {
    await prune(store, context.now());
    const current = await store.get('credential:' + response.id);
    const currentAccount = await store.get('account:' + account.id);
    if (!current || !currentAccount || currentAccount.status !== 'active' || currentAccount.authVersion !== account.authVersion || current.counter !== credential.counter) reject(400, 'Passkey verification failed');
    current.counter = verification.authenticationInfo.newCounter;
    current.deviceType = verification.authenticationInfo.credentialDeviceType;
    current.backedUp = verification.authenticationInfo.credentialBackedUp;
    await store.put('credential:' + current.id, current);
    return newSession(store, request, currentAccount, context.now());
  });
  return reply(session.value, session.cookies);
}

function recoveryCode(value) {
  if (typeof value !== 'string' || value.length > 80 || !/^[0-9a-fA-F\s-]+$/.test(value)) reject(400, 'Recovery verification failed');
  const normalized = value.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[0-9A-F]{32}$/.test(normalized)) reject(400, 'Recovery verification failed');
  return normalized;
}

async function eraseSessions(store, accountId) {
  for (const key of (await store.list('session:' + accountId + ':', MAX_SESSIONS + 1)).keys()) await store.delete(key);
  for (const [key, challenge] of await store.list('challenge:', MAX_CHALLENGES + 1)) if (challenge.accountId === accountId) await store.delete(key);
}

async function createRecovery(request, context, principal) {
  recent(principal, context.now());
  const codes = Array.from({ length: RECOVERY_COUNT }, () => [...isoBase64URL.toBuffer(random(16))].map(byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase().match(/.{8}/g).join('-'));
  const hashes = await Promise.all(codes.map(code => digest('displayos-recovery-v1:' + recoveryCode(code))));
  await context.store.transaction(async store => {
    await prune(store, context.now());
    const account = await store.get('account:' + principal.accountId);
    for (const hash of account.recoveryHashes) await store.delete('recovery:' + hash);
    account.recoveryHashes = hashes;
    for (const hash of hashes) {
      if (await store.get('recovery:' + hash)) reject(409, 'Create recovery codes again');
      await store.put('recovery:' + hash, { accountId: account.id, createdAt: context.now(), expiresAt: context.now() + RECOVERY_TTL });
    }
    await store.put('account:' + account.id, account);
  });
  return reply({ codes });
}

async function useRecovery(request, context) {
  await limited(context, request, null);
  const value = await readJson(request, 1024);
  exact(value, ['code']);
  const normalized = recoveryCode(value.code);
  await consumeChallenge(request, context, 'login');
  const hash = await digest('displayos-recovery-v1:' + normalized);
  const session = await context.store.transaction(async store => {
    await prune(store, context.now());
    const recovery = await store.get('recovery:' + hash);
    const account = recovery && await store.get('account:' + recovery.accountId);
    if (!account || account.status !== 'active' || !account.recoveryHashes.includes(hash)) reject(400, 'Recovery verification failed');
    await store.delete('recovery:' + hash);
    account.recoveryHashes = account.recoveryHashes.filter(value => value !== hash);
    for (const id of account.credentialIds) await store.delete('credential:' + id);
    account.credentialIds = [];
    account.authVersion++;
    account.sessionsInvalidatedAt = context.now();
    await eraseSessions(store, account.id);
    await store.put('account:' + account.id, account);
    return newSession(store, request, account, context.now());
  });
  return reply(session.value, session.cookies);
}

async function removeAccount(request, context, principal) {
  const existing = await context.store.get('account:' + principal.accountId);
  if (existing.status !== 'deleting') recent(principal, context.now());
  if (typeof context.deleteAccount !== 'function') reject(503, 'Account deletion unavailable');
  await context.store.transaction(async store => {
    const account = await store.get('account:' + principal.accountId);
    account.status = 'deleting';
    await store.put('account:' + account.id, account);
  });
  await context.deleteAccount(principal.accountId);
  await context.store.transaction(async store => {
    const account = await store.get('account:' + principal.accountId);
    await eraseSessions(store, account.id);
    for (const id of account.credentialIds) await store.delete('credential:' + id);
    for (const hash of account.recoveryHashes) await store.delete('recovery:' + hash);
    await store.delete('account:' + account.id);
  });
  return reply({ deleted: true }, [cookieValue(SESSION_COOKIE, '', 0), cookieValue(CHALLENGE_COOKIE, '', 0)]);
}

export async function identityRoute(request, context) {
  const path = new URL(request.url).pathname;
  if (!ROUTES.has(path)) return null;
  const { url, rpID } = boundary(request, context);
  if (url.search || url.hash) reject(400, 'Query parameters are not accepted');
  if (request.method !== (path === '/api/v1/me' ? 'GET' : 'POST')) reject(405, 'Method not allowed');
  if (path === '/api/v1/me') {
    const principal = await authenticate(request, context);
    await limited(context, request, principal);
    const account = await context.store.get('account:' + principal.accountId);
    return reply({ account: { name: account.name }, csrf: principal.csrf, signedIn: true, ...(!account.credentialIds.length ? { needsPasskey: true } : {}) });
  }
  for (const kind of ['register', 'login', 'passkey']) {
    if (path === `/auth/${kind}/options`) return optionsRoute(request, context, kind, rpID);
    if (path === `/auth/${kind}/verify`) return kind === 'login' ? login(request, context, rpID) : registration(request, context, kind, rpID);
  }
  if (path === '/auth/recovery/use') return useRecovery(request, context);
  const principal = await requireBrowser(request, context);
  await limited(context, request, principal);
  exact(await readJson(request, 1024), []);
  if (path === '/auth/recovery/create') return createRecovery(request, context, principal);
  if (path === '/auth/account/delete') return removeAccount(request, context, principal);
  await context.store.transaction(async store => {
    await store.delete(`session:${principal.accountId}:${principal.sessionId}`);
    const challenge = await challengeKey(request);
    if (challenge) await store.delete(challenge);
  });
  return reply({ signedIn: false }, [cookieValue(SESSION_COOKIE, '', 0), cookieValue(CHALLENGE_COOKIE, '', 0)]);
}
