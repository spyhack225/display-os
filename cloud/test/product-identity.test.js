import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import { identityRoute, authenticate, requireBrowser } from '../src/product/identity.js';
import { RecordStore } from '../src/product/store.js';

const ORIGIN = 'https://displayos.example.com';

class Storage {
  constructor(data = new Map(), failures = { put: null }) { this.data = data; this.failures = failures; }
  async get(key) { return structuredClone(this.data.get(key)); }
  async put(key, value) {
    if (this.failures.put?.(key, value)) throw new Error('Simulated durable write failure');
    this.data.set(key, structuredClone(value));
  }
  async delete(key) { return this.data.delete(key); }
  async list({ prefix, limit }) {
    return new Map([...this.data].filter(([key]) => key.startsWith(prefix)).sort(([first], [second]) => first.localeCompare(second)).slice(0, limit).map(([key, value]) => [key, structuredClone(value)]));
  }
  async transaction(callback) {
    const transactional = new Storage(structuredClone(this.data), this.failures);
    const result = await callback(transactional);
    this.data = transactional.data;
    return result;
  }
}

let browserSequence = 0;
function browser() { return { cookies: new Map(), csrf: null, ip: '2001:db8::' + (++browserSequence).toString(16) }; }
function cookies(client) { return [...client.cookies].map(([key, value]) => key + '=' + value).join('; '); }
function hash(value) { return createHash('sha256').update(value).digest(); }
function base64(value) { return Buffer.from(value).toString('base64url'); }

function authenticator() {
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = keys.publicKey.export({ format: 'jwk' });
  const id = base64(randomBytes(32));
  const cose = isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
  let userHandle;
  let counter = 0;
  function data(options, registration, override = {}) {
    return Buffer.from(JSON.stringify({ type: registration ? 'webauthn.create' : 'webauthn.get', challenge: options.challenge, origin: ORIGIN, crossOrigin: false, ...override }));
  }
  function authData(flags, count, rpID = 'displayos.example.com') {
    const countBytes = Buffer.alloc(4);
    countBytes.writeUInt32BE(count);
    return Buffer.concat([hash(rpID), Buffer.from([flags]), countBytes]);
  }
  return {
    id,
    registration(options, overrides = {}) {
      userHandle = options.user.id;
      const identifier = Buffer.from(overrides.id || id, 'base64url');
      const length = Buffer.alloc(2);
      length.writeUInt16BE(identifier.length);
      const attested = Buffer.concat([authData(overrides.flags ?? 0x45, 0, overrides.rpID), Buffer.alloc(16), length, identifier, cose]);
      return {
        id: overrides.id || id, rawId: overrides.id || id, type: 'public-key',
        response: { clientDataJSON: base64(data(options, true, overrides.client)), attestationObject: base64(isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', attested]]))), transports: ['internal'] },
        clientExtensionResults: { credProps: { rk: overrides.resident ?? true } }, authenticatorAttachment: 'platform',
      };
    },
    assertion(options, overrides = {}) {
      counter++;
      const clientData = data(options, false, overrides.client);
      const authenticatorData = authData(overrides.flags ?? 0x05, overrides.counter ?? counter, overrides.rpID);
      const signature = sign('sha256', Buffer.concat([authenticatorData, hash(clientData)]), keys.privateKey);
      return {
        id, rawId: id, type: 'public-key',
        response: { clientDataJSON: base64(clientData), authenticatorData: base64(authenticatorData), signature: base64(signature), userHandle: overrides.userHandle ?? userHandle },
        clientExtensionResults: {}, authenticatorAttachment: 'platform',
      };
    },
  };
}

function fixture() {
  let time = 1900000000000;
  const storage = new Storage();
  const store = new RecordStore(storage, 'a'.repeat(64), 'identity:test');
  const primary = browser();
  const budgets = new Map();
  const context = {
    store, origin: ORIGIN, env: {}, now: () => time,
    authenticate: request => authenticate(request, context),
    requireBrowser: request => requireBrowser(request, context),
    async rate(bucket, limit, windowMs) {
      const current = budgets.get(bucket);
      if (current && current.until > time) {
        if (current.count >= limit) { const error = new Error('Rate limited'); error.status = 429; throw error; }
        current.count++;
      } else budgets.set(bucket, { count: 1, until: time + windowMs });
    },
    async deleteAccount() {},
  };
  async function call(path, value, options = {}) {
    const client = options.browser || primary;
    const method = options.method || (path === '/api/v1/me' ? 'GET' : 'POST');
    const headers = { Cookie: options.cookie ?? cookies(client), 'CF-Connecting-IP': client.ip, ...options.headers };
    if (method === 'POST') {
      headers['Content-Type'] = options.type || 'application/json';
      if (options.origin !== null) headers.Origin = options.origin ?? ORIGIN;
      if (client.csrf && options.csrf !== false) headers['X-DisplayOS-CSRF'] = options.csrf ?? client.csrf;
    }
    const request = new Request((options.base || ORIGIN) + path, { method, headers, body: method === 'POST' ? JSON.stringify(value ?? {}) : undefined });
    let response;
    try { response = await identityRoute(request, context); }
    catch (error) {
      if (!Number.isInteger(error.status) && !error.message.startsWith('Simulated durable')) throw error;
      response = new Response(JSON.stringify({ error: error.status ? error.message : 'Storage unavailable' }), { status: error.status || 503 });
    }
    if (response === null) return { response: null };
    const result = await response.json();
    for (const header of response.headers.getSetCookie()) {
      const [key, ...parts] = header.split(';')[0].split('=');
      const value = parts.join('=');
      if (!value) client.cookies.delete(key); else client.cookies.set(key, value);
    }
    if (result.csrf) client.csrf = result.csrf;
    return { status: response.status, value: result, response, request };
  }
  async function register(client = primary, credential = authenticator(), label = 'Alex') {
    const options = await call('/auth/register/options', { name: label }, { browser: client });
    assert.equal(options.status, 200);
    const response = await call('/auth/register/verify', credential.registration(options.value), { browser: client });
    assert.equal(response.status, 200);
    return credential;
  }
  async function login(credential, client = primary, overrides = {}) {
    const options = await call('/auth/login/options', {}, { browser: client });
    assert.equal(options.status, 200);
    return call('/auth/login/verify', credential.assertion(options.value, overrides), { browser: client });
  }
  return { storage, store, primary, context, budgets, call, register, login, advance: duration => { time += duration; } };
}

test('registration options pin HTTPS origin, RP ID, user verification and discoverable credentials', async () => {
  const { call, store } = fixture();
  const result = await call('/auth/register/options', { name: '  Alex  ' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.value.rp, { id: 'displayos.example.com', name: 'DisplayOS' });
  assert.equal(result.value.user.name, 'Alex');
  assert.equal(Buffer.from(result.value.user.id, 'base64url').length, 32);
  assert.equal(result.value.authenticatorSelection.userVerification, 'required');
  assert.equal(result.value.authenticatorSelection.residentKey, 'required');
  assert.equal(result.value.authenticatorSelection.requireResidentKey, true);
  assert.equal(result.value.attestation, 'none');
  assert.equal((await store.list('account:')).size, 0);
  assert.match(result.response.headers.get('Set-Cookie'), /__Host-displayos-challenge=.*Secure; HttpOnly; SameSite=Lax/);
  assert.equal(result.response.headers.get('Cache-Control'), 'no-store');
});

test('real library verifies registration, persists encrypted records and returns only the public account', async () => {
  const { call, register, storage, store, primary } = fixture();
  const credential = await register();
  const result = await call('/api/v1/me');
  assert.equal(result.status, 200);
  assert.deepEqual(result.value.account, { name: 'Alex' });
  assert.equal(result.value.signedIn, true);
  assert.equal(result.value.csrf.length, 43);
  assert.equal(result.value.accountId, undefined);
  assert.equal((await store.get('credential:' + credential.id)).counter, 0);
  const serialized = JSON.stringify([...storage.data.values()]);
  assert.ok(!serialized.includes('Alex'));
  assert.ok(!serialized.includes(primary.csrf));
  assert.ok(!serialized.includes(primary.cookies.get('__Host-displayos')));
  for (const record of storage.data.values()) assert.equal(record.version, 1);
});

test('registration completion requires the challenge cookie, matching challenge and single use', async () => {
  const { call, primary, store } = fixture();
  const credential = authenticator();
  const options = await call('/auth/register/options', { name: 'Alex' });
  const body = credential.registration(options.value);
  const binding = cookies(primary);
  assert.equal((await call('/auth/register/verify', body, { cookie: '' })).status, 400);
  assert.equal((await call('/auth/register/verify', body)).status, 200);
  assert.equal((await call('/auth/register/verify', body, { cookie: binding })).status, 400);
  assert.equal((await store.list('account:')).size, 1);
});

test('failed cryptographic challenge verification consumes the challenge', async () => {
  const { call, primary, store } = fixture();
  const credential = authenticator();
  const options = await call('/auth/register/options', { name: 'Alex' });
  const binding = cookies(primary);
  const bad = credential.registration(options.value, { client: { challenge: base64(randomBytes(32)) } });
  assert.equal((await call('/auth/register/verify', bad)).status, 400);
  assert.equal((await call('/auth/register/verify', credential.registration(options.value), { cookie: binding })).status, 400);
  assert.equal((await store.list('account:')).size, 0);
});

test('HTTP, absent or mismatched Origin and credential-bearing queries are rejected before storage writes', async () => {
  const { call, storage, context } = fixture();
  for (const options of [{ origin: null }, { origin: 'null' }, { origin: 'https://evil.example' }, { base: 'http://displayos.example.com' }, { base: 'https://other.example.com' }]) {
    assert.equal((await call('/auth/register/options', { name: 'Alex' }, options)).status, 403);
  }
  assert.equal((await call('/auth/login/options?code=secret', {})).status, 400);
  assert.equal(storage.data.size, 0);
  context.origin = 'http://localhost';
  assert.equal((await call('/auth/login/options', {})).status, 503);
});

test('client-data cross-origin, top-origin, RP ID, presence, UV and nondiscoverable registration fail closed', async () => {
  const { call, advance } = fixture();
  for (const override of [{ client: { origin: 'https://evil.example' } }, { client: { crossOrigin: true } }, { client: { topOrigin: ORIGIN } }, { rpID: 'evil.example' }, { flags: 0x41 }, { flags: 0x44 }, { resident: false }]) {
    const credential = authenticator();
    const options = await call('/auth/register/options', { name: 'Alex' });
    assert.equal((await call('/auth/register/verify', credential.registration(options.value, override))).status, 400);
    advance(1);
  }
});

test('unrecognized fields, malformed names, wrong types and noncanonical credential encodings are rejected', async () => {
  const { call, storage } = fixture();
  for (const value of [{ name: '' }, { name: '<script>' }, { name: 'a'.repeat(81) }, { name: 'Alex', accountId: 'supplied' }, { name: ['Alex'] }]) assert.equal((await call('/auth/register/options', value)).status, 400);
  assert.equal(storage.data.size, 0);
  assert.equal((await call('/auth/login/options', { accountId: 'supplied' })).status, 400);
  assert.equal((await call('/auth/login/options', {}, { type: 'text/plain' })).status, 415);
  assert.equal((await call('/auth/register/options', { name: 'a'.repeat(32769) })).status, 413);
  const credential = authenticator();
  const options = await call('/auth/register/options', { name: 'Alex' });
  const body = credential.registration(options.value);
  body.id += '=';
  body.rawId = body.id;
  assert.equal((await call('/auth/register/verify', body)).status, 400);
});

test('account IDs are server generated and existing accounts and credentials cannot be overwritten', async () => {
  const { register, call, store } = fixture();
  const original = await register();
  const [accountKey, originalAccount] = [...await store.list('account:')][0];
  const originalCredential = await store.get('credential:' + original.id);
  const options = await call('/auth/register/options', { name: 'Attacker' });
  const credential = authenticator();
  assert.equal((await call('/auth/register/verify', credential.registration(options.value, { id: original.id }))).status, 400);
  assert.deepEqual(await store.get('credential:' + original.id), originalCredential);
  assert.deepEqual(await store.get(accountKey), originalAccount);
  const secondOptions = await call('/auth/register/options', { name: 'Attacker' });
  const [key, challenge] = [...await store.list('challenge:')][0];
  await store.put(key, { ...challenge, accountId: originalAccount.id });
  assert.equal((await call('/auth/register/verify', credential.registration(secondOptions.value))).status, 400);
  assert.deepEqual(await store.get(accountKey), originalAccount);
  assert.equal((await store.list('account:')).size, 1);
});

test('real signed discoverable authentication rotates session and CSRF, stores counter and denies replay', async () => {
  const { register, call, primary, login, store } = fixture();
  const credential = await register();
  const oldCookie = cookies(primary);
  const oldCSRF = primary.csrf;
  const options = await call('/auth/login/options', {});
  assert.equal(options.value.userVerification, 'required');
  assert.deepEqual(options.value.allowCredentials, []);
  const challengeCookie = cookies(primary);
  const assertion = credential.assertion(options.value);
  const result = await call('/auth/login/verify', assertion);
  assert.equal(result.status, 200);
  assert.notEqual(result.value.csrf, oldCSRF);
  assert.match(result.response.headers.get('Set-Cookie'), /__Host-displayos=.*Max-Age=43200/);
  assert.equal((await store.get('credential:' + credential.id)).counter, 1);
  assert.equal((await call('/api/v1/me', undefined, { cookie: oldCookie })).status, 401);
  assert.equal((await call('/auth/login/verify', assertion, { cookie: challengeCookie })).status, 400);
  assert.equal((await login(credential, primary, { counter: 1 })).status, 400);
});

test('invalid signatures, user handles, UV, presence, RP ID and unknown credentials share generic errors', async () => {
  const { register, call, store, primary } = fixture();
  const credential = await register();
  const errors = [];
  for (const override of [{ userHandle: base64(randomBytes(32)) }, { flags: 1 }, { flags: 4 }, { rpID: 'evil.example' }]) {
    const options = await call('/auth/login/options', {});
    errors.push((await call('/auth/login/verify', credential.assertion(options.value, override))).value.error);
  }
  for (const mutate of [body => { body.response.signature = base64(randomBytes(70)); }, body => { body.id = body.rawId = base64(randomBytes(32)); }]) {
    const options = await call('/auth/login/options', {});
    const body = credential.assertion(options.value);
    mutate(body);
    const result = await call('/auth/login/verify', body);
    assert.equal(result.status, 400);
    errors.push(result.value.error);
  }
  assert.deepEqual(new Set(errors), new Set(['Passkey verification failed']));
  assert.equal((await store.get('credential:' + credential.id)).counter, 0);
  assert.equal((await call('/api/v1/me', undefined, { browser: primary })).status, 200);
});

test('POST browser helpers require exact origin and matching CSRF while GET returns only the principal', async () => {
  const { register, call, context, primary } = fixture();
  await register();
  const request = new Request(ORIGIN + '/api/v1/homes', { method: 'POST', headers: { Cookie: cookies(primary), Origin: ORIGIN, 'X-DisplayOS-CSRF': primary.csrf } });
  const principal = await requireBrowser(request, context);
  assert.equal(principal.accountId.length, 22);
  assert.equal(principal.sessionId.length, 43);
  assert.equal(principal.verifiedAt, context.now());
  assert.equal((await call('/auth/logout', {}, { csrf: false })).status, 403);
  assert.equal((await call('/auth/logout', {}, { csrf: 'wrong' })).status, 403);
  assert.equal((await call('/auth/logout', {}, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('/api/v1/me')).status, 200);
  assert.equal((await call('/auth/logout', {})).status, 200);
  assert.equal((await call('/api/v1/me')).status, 401);
});

test('session expires after twelve hours and stale challenges are pruned without deleting accounts', async () => {
  const { register, call, advance, store } = fixture();
  await register();
  await call('/auth/login/options', {});
  advance(12 * 60 * 60 * 1000);
  assert.equal((await call('/api/v1/me')).status, 401);
  assert.equal((await call('/auth/login/options', {})).status, 200);
  assert.equal((await store.list('session:')).size, 0);
  assert.equal((await store.list('challenge:')).size, 1);
  assert.equal((await store.list('account:')).size, 1);
});

test('expired challenge cannot finish registration', async () => {
  const { call, advance, store } = fixture();
  const credential = authenticator();
  const options = await call('/auth/register/options', { name: 'Alex' });
  advance(300000);
  assert.equal((await call('/auth/register/verify', credential.registration(options.value))).status, 400);
  assert.equal((await store.list('account:')).size, 0);
});

test('adding a passkey requires recent authenticated browser proof and rotates the completing session', async () => {
  const { register, call, primary, advance, login, store } = fixture();
  const original = await register();
  assert.equal((await call('/auth/passkey/options', {}, { browser: browser() })).status, 401);
  assert.equal((await call('/auth/passkey/options', {}, { csrf: false })).status, 403);
  advance(300001);
  assert.equal((await call('/auth/passkey/options', {})).status, 403);
  assert.equal((await login(original)).status, 200);
  const credential = authenticator();
  const options = await call('/auth/passkey/options', {});
  assert.deepEqual(options.value.excludeCredentials.map(value => value.id), [original.id]);
  const oldCookie = cookies(primary);
  assert.equal((await call('/auth/passkey/verify', credential.registration(options.value))).status, 200);
  assert.equal((await call('/api/v1/me', undefined, { cookie: oldCookie })).status, 401);
  assert.equal((await store.list('credential:')).size, 2);
  assert.equal((await login(credential, browser())).status, 200);
});

test('add-passkey challenges cannot move between accounts or sessions', async () => {
  const { register, call, primary, store } = fixture();
  await register();
  const other = browser();
  await register(other, authenticator(), 'Taylor');
  const options = await call('/auth/passkey/options', {});
  const binding = primary.cookies.get('__Host-displayos-challenge');
  other.cookies.set('__Host-displayos-challenge', binding);
  assert.equal((await call('/auth/passkey/verify', authenticator().registration(options.value), { browser: other })).status, 400);
  assert.equal((await store.list('credential:')).size, 2);
});

test('account sessions and passkeys stay bounded and existing independent sessions remain valid', async () => {
  const { register, login, call, store, advance } = fixture();
  const original = await register();
  const firstIndependent = browser();
  assert.equal((await login(original, firstIndependent)).status, 200);
  assert.equal((await call('/api/v1/me')).status, 200);
  for (let index = 0; index < 8; index++) {
    advance(1);
    assert.equal((await login(original, browser())).status, 200);
  }
  assert.equal((await store.list('session:')).size, 8);
  assert.equal((await call('/api/v1/me', undefined, { browser: firstIndependent })).status, 401);
  assert.equal((await login(original)).status, 200);
  for (let index = 1; index < 8; index++) {
    const credential = authenticator();
    const options = await call('/auth/passkey/options', {});
    assert.equal(options.status, 200);
    assert.equal((await call('/auth/passkey/verify', credential.registration(options.value))).status, 200);
  }
  assert.equal((await call('/auth/passkey/options', {})).status, 409);
  assert.equal((await store.list('credential:')).size, 8);
});

test('anonymous challenge exhaustion preserves authenticated admission and expired slots recover', async () => {
  const { register, call, store, advance } = fixture();
  await register();
  for (let index = 0; index < 64; index++) {
    const client = browser(); client.ip = '198.51.100.' + index;
    assert.equal((await call('/auth/login/options', {}, { browser: client })).status, 200);
  }
  assert.equal((await call('/auth/login/options', {}, { browser: browser() })).status, 429);
  assert.equal((await call('/auth/passkey/options', {})).status, 200);
  assert.equal((await store.list('challenge:', 129)).size, 65);
  advance(300001);
  assert.equal((await call('/auth/login/options', {})).status, 200);
  assert.equal((await store.list('challenge:', 129)).size, 1);
});

test('replacing a browser challenge deletes the previous challenge and account capacity does not overwrite records', async () => {
  const { call, store } = fixture();
  for (let index = 0; index < 3; index++) assert.equal((await call('/auth/login/options', {})).status, 200);
  assert.equal((await store.list('challenge:')).size, 1);
  for (let index = 0; index < 128; index++) await store.put('account:reserved-' + index, { id: 'reserved-' + index, name: 'Reserved', status: 'active' });
  assert.equal((await call('/auth/register/options', { name: 'New' })).status, 429);
  assert.equal((await call('/auth/login/options', {})).status, 200);
  assert.equal((await store.list('account:', 129)).size, 128);
});

test('recovery creation is deliberate, recent and stores eight 128-bit code hashes, never the codes', async () => {
  const { register, call, store, storage, advance } = fixture();
  await register();
  assert.equal((await call('/auth/recovery/create', {}, { csrf: false })).status, 403);
  const result = await call('/auth/recovery/create', {});
  assert.equal(result.status, 200);
  assert.equal(result.value.codes.length, 8);
  assert.equal(new Set(result.value.codes).size, 8);
  const records = await store.list('recovery:');
  assert.equal(records.size, 8);
  for (const code of result.value.codes) {
    assert.match(code, /^[A-F0-9]{8}(?:-[A-F0-9]{8}){3}$/);
    assert.equal(Buffer.from(code.replaceAll('-', ''), 'hex').length, 16);
    assert.ok(!JSON.stringify([...storage.data]).includes(code));
    assert.ok(!JSON.stringify([...records]).includes(code));
  }
  const replacement = await call('/auth/recovery/create', {});
  assert.equal((await store.list('recovery:')).size, 8);
  assert.notDeepEqual(replacement.value.codes, result.value.codes);
  advance(300001);
  assert.equal((await call('/auth/recovery/create', {})).status, 403);
});

test('recovery is challenge-bound, one-use and revokes old passkeys, sessions and account-bound challenges', async () => {
  const { register, login, call, primary, store, context } = fixture();
  const credential = await register();
  const oldPrimary = cookies(primary);
  const independent = browser();
  assert.equal((await login(credential, independent)).status, 200);
  const otherAccount = browser();
  await register(otherAccount, authenticator(), 'Taylor');
  const codes = (await call('/auth/recovery/create', {})).value.codes;
  assert.equal((await call('/auth/passkey/options', {})).status, 200);
  const recovering = browser();
  assert.equal((await call('/auth/recovery/use', { code: codes[0] }, { browser: recovering })).status, 400);
  await call('/auth/login/options', {}, { browser: recovering });
  const recovery = await call('/auth/recovery/use', { code: codes[0].toLowerCase().replaceAll('-', ' ') }, { browser: recovering });
  assert.equal(recovery.status, 200);
  assert.equal(recovery.value.needsPasskey, true);
  assert.equal((await call('/api/v1/me', undefined, { cookie: oldPrimary })).status, 401);
  assert.equal((await call('/api/v1/me', undefined, { browser: independent })).status, 401);
  assert.equal((await call('/api/v1/me', undefined, { browser: otherAccount })).status, 200);
  assert.equal(await store.get('credential:' + credential.id), undefined);
  assert.equal((await store.list('recovery:')).size, 7);
  assert.equal((await call('/api/v1/me', undefined, { browser: recovering })).value.needsPasskey, true);
  await assert.rejects(authenticate(new Request(ORIGIN + '/api/v1/homes', { headers: { Cookie: cookies(recovering) } }), context), error => error.status === 403);
  assert.equal((await login(credential, browser())).status, 400);
  await call('/auth/login/options', {}, { browser: browser() });
  const replay = browser();
  await call('/auth/login/options', {}, { browser: replay });
  assert.equal((await call('/auth/recovery/use', { code: codes[0] }, { browser: replay })).status, 400);
  const newCredential = authenticator();
  const options = await call('/auth/passkey/options', {}, { browser: recovering });
  assert.equal(options.status, 200);
  assert.deepEqual(options.value.excludeCredentials, []);
  assert.equal((await call('/auth/passkey/verify', newCredential.registration(options.value), { browser: recovering })).status, 200);
  assert.equal((await call('/api/v1/me', undefined, { browser: recovering })).value.needsPasskey, undefined);
  const principal = await authenticate(new Request(ORIGIN + '/api/v1/homes', { headers: { Cookie: cookies(recovering) } }), context);
  assert.equal(principal.verifiedAt, context.now());
});

test('wrong recovery code and foreign-origin use cannot mutate account authority', async () => {
  const { register, call, store } = fixture();
  await register();
  const codes = (await call('/auth/recovery/create', {})).value.codes;
  const original = [...await store.list('account:')][0][1];
  const recovering = browser();
  await call('/auth/login/options', {}, { browser: recovering });
  assert.equal((await call('/auth/recovery/use', { code: codes[0] }, { browser: recovering, origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('/auth/recovery/use', { code: '0'.repeat(32) }, { browser: recovering })).status, 400);
  assert.deepEqual([...await store.list('account:')][0][1], original);
  assert.equal((await store.list('recovery:')).size, 8);
  assert.equal((await call('/auth/recovery/use', { code: codes[0] }, { browser: recovering })).status, 400);
});

test('expired recovery records are pruned and cannot restore an account', async () => {
  const { register, call, advance, store } = fixture();
  await register();
  const code = (await call('/auth/recovery/create', {})).value.codes[0];
  advance(365 * 24 * 60 * 60 * 1000);
  const recovering = browser();
  await call('/auth/login/options', {}, { browser: recovering });
  assert.equal((await call('/auth/recovery/use', { code }, { browser: recovering })).status, 400);
  assert.equal((await store.list('recovery:')).size, 0);
});

test('deletion requires recent CSRF proof and removes identity only after household cleanup', async () => {
  const { register, call, store, context, advance, login } = fixture();
  const credential = await register();
  await call('/auth/recovery/create', {});
  const account = [...await store.list('account:')][0][1];
  let calls = 0;
  context.deleteAccount = async accountId => {
    calls++;
    assert.equal(accountId, account.id);
    assert.equal((await store.get('account:' + accountId)).status, 'deleting');
    assert.ok(await store.get('credential:' + credential.id));
  };
  assert.equal((await call('/auth/account/delete', {}, { csrf: false })).status, 403);
  advance(300001);
  assert.equal((await call('/auth/account/delete', {})).status, 403);
  assert.equal(calls, 0);
  assert.equal((await login(credential)).status, 200);
  const result = await call('/auth/account/delete', {});
  assert.equal(result.status, 200);
  assert.equal(result.value.deleted, true);
  assert.equal(calls, 1);
  for (const prefix of ['account:', 'credential:', 'session:', 'recovery:']) assert.equal((await store.list(prefix)).size, 0);
  assert.equal((await call('/api/v1/me')).status, 401);
});

test('transient household cleanup failure fences every other route but deletion remains resumable', async () => {
  const { register, call, store, context, primary, advance } = fixture();
  const credential = await register();
  let calls = 0;
  context.deleteAccount = async () => {
    calls++;
    if (calls === 1) { const error = new Error('Cleanup retry required'); error.status = 503; throw error; }
  };
  assert.equal((await call('/auth/account/delete', {})).status, 503);
  assert.equal((await store.list('account:')).values().next().value.status, 'deleting');
  assert.equal((await call('/api/v1/me')).status, 401);
  assert.equal((await call('/auth/passkey/options', {})).status, 401);
  assert.equal((await call('/auth/recovery/create', {})).status, 401);
  await assert.rejects(authenticate(new Request(ORIGIN + '/api/v1/homes', { headers: { Cookie: cookies(primary) } }), context), error => error.status === 401);
  assert.ok(await store.get('credential:' + credential.id));
  advance(300001);
  assert.equal((await call('/auth/account/delete', {})).status, 200);
  assert.equal(calls, 2);
  assert.equal((await store.list('account:')).size, 0);
});

test('registration durable failure rolls back account, key and session and never emits a success cookie', async () => {
  const { call, store, storage } = fixture();
  const credential = authenticator();
  const options = await call('/auth/register/options', { name: 'Alex' });
  storage.failures.put = key => key.startsWith('session:');
  const response = await call('/auth/register/verify', credential.registration(options.value));
  assert.equal(response.status, 503);
  assert.equal(response.response.headers.get('Set-Cookie'), null);
  for (const prefix of ['account:', 'credential:', 'session:', 'challenge:']) assert.equal((await store.list(prefix)).size, 0);
});

test('failed recovery transaction does not consume the code or revoke existing credentials and sessions', async () => {
  const { register, call, store, storage, primary } = fixture();
  const credential = await register();
  const code = (await call('/auth/recovery/create', {})).value.codes[0];
  const original = [...await store.list('account:')][0][1];
  const recovering = browser();
  await call('/auth/login/options', {}, { browser: recovering });
  storage.failures.put = key => key.startsWith('session:');
  assert.equal((await call('/auth/recovery/use', { code }, { browser: recovering })).status, 503);
  storage.failures.put = null;
  assert.deepEqual([...await store.list('account:')][0][1], original);
  assert.ok(await store.get('credential:' + credential.id));
  assert.equal((await store.list('recovery:')).size, 8);
  assert.equal((await call('/api/v1/me', undefined, { browser: primary })).status, 200);
  await call('/auth/login/options', {}, { browser: recovering });
  assert.equal((await call('/auth/recovery/use', { code }, { browser: recovering })).status, 200);
});

test('failed authentication write rolls back signature counter and retains the prior session', async () => {
  const { register, call, store, storage } = fixture();
  const credential = await register();
  const options = await call('/auth/login/options', {});
  storage.failures.put = key => key.startsWith('session:');
  assert.equal((await call('/auth/login/verify', credential.assertion(options.value))).status, 503);
  storage.failures.put = null;
  assert.equal((await store.get('credential:' + credential.id)).counter, 0);
  assert.equal((await call('/api/v1/me')).status, 200);
});

test('invalid browser sessions use public limits rather than consuming owner-reserved admission', async () => {
  const { register, call, budgets, primary } = fixture();
  await register();
  const anonymous = { cookie: '', headers: { 'CF-Connecting-IP': '203.0.113.99' } };
  for (let index = 0; index < 30; index++) assert.equal((await call('/api/v1/me', undefined, anonymous)).status, 401);
  assert.equal((await call('/api/v1/me', undefined, anonymous)).status, 429);
  assert.equal((await call('/api/v1/me', undefined, { browser: primary })).status, 200);
  assert.equal(budgets.get('identity:public').count, 33);
  assert.equal((await call('/auth/logout', {})).status, 200);
});

test('identity handles only its routes and rejects wrong methods and duplicate host cookies', async () => {
  const { call, register, primary } = fixture();
  assert.equal((await call('/api/v1/homes', {}, { method: 'GET' })).response, null);
  assert.equal((await call('/auth/login/options', undefined, { method: 'GET' })).status, 405);
  assert.equal((await call('/api/v1/me', {})).status, 401);
  await register();
  const value = primary.cookies.get('__Host-displayos');
  assert.equal((await call('/api/v1/me', undefined, { cookie: `__Host-displayos=${value}; __Host-displayos=${value}` })).status, 400);
});

test('only OAuth authorize and fixed Google callback top-level navigation can inspect a Lax session cross-site', async () => {
  const { register, primary, context } = fixture();
  await register();
  const navigation = { Cookie: cookies(primary), 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  const authorized = await authenticate(new Request(ORIGIN + '/oauth/authorize?client_id=known', { headers: navigation }), context);
  assert.equal(authorized.csrf, primary.csrf);
  const callback = await authenticate(new Request(ORIGIN + '/api/v1/providers/google/callback?code=temporary&state=bound', { headers: navigation }), context);
  assert.equal(callback.sessionId, authorized.sessionId);
  const anonymous = { ...navigation, Cookie: '' };
  await assert.rejects(authenticate(new Request(ORIGIN + '/oauth/authorize', { headers: anonymous }), context), error => error.status === 401);
  for (const [path, headers, method] of [
    ['/api/v1/me', navigation, 'GET'],
    ['/oauth/authorize', { ...navigation, 'Sec-Fetch-Mode': 'cors' }, 'GET'],
    ['/oauth/authorize', { ...navigation, 'Sec-Fetch-Dest': 'iframe' }, 'GET'],
    ['/oauth/authorize', { ...navigation, Origin: 'https://assistant.example' }, 'GET'],
    ['/oauth/authorize', { ...navigation, Origin: ORIGIN, 'X-DisplayOS-CSRF': primary.csrf }, 'POST'],
    ['/api/v1/providers/google/callback', { ...navigation, 'Sec-Fetch-Mode': 'cors' }, 'GET'],
    ['/api/v1/providers/google/callback', { ...navigation, 'Sec-Fetch-Dest': 'iframe' }, 'GET'],
    ['/api/v1/providers/google/callback', { ...navigation, Origin: ORIGIN, 'X-DisplayOS-CSRF': primary.csrf }, 'POST'],
    ['/api/v1/providers/google/callback/other', navigation, 'GET'],
    ['/auth/logout', { ...navigation, Origin: ORIGIN, 'X-DisplayOS-CSRF': primary.csrf }, 'POST'],
  ]) {
    await assert.rejects(authenticate(new Request(ORIGIN + path, { method, headers }), context), error => error.status === 403);
  }
});

test('certificate-bearing attestation formats cannot trigger remote trust or revocation lookups', async () => {
  const { call } = fixture();
  const credential = authenticator();
  const options = await call('/auth/register/options', { name: 'Alex' });
  const body = credential.registration(options.value);
  const attestation = isoCBOR.decodeFirst(Buffer.from(body.response.attestationObject, 'base64url'));
  attestation.set('fmt', 'packed');
  attestation.set('attStmt', new Map([['alg', -7], ['x5c', [Buffer.from('untrusted certificate')]], ['sig', Buffer.from([1])]]));
  body.response.attestationObject = base64(isoCBOR.encode(attestation));
  const result = await call('/auth/register/verify', body);
  assert.equal(result.status, 400);
  assert.equal(result.value.error, 'Passkey verification failed');
});

test('malformed client-data JSON values fail closed rather than escaping the boundary', async () => {
  const { call } = fixture();
  const credential = authenticator();
  const options = await call('/auth/register/options', { name: 'Alex' });
  for (const value of [null, [], 'text', 42]) {
    const body = credential.registration(options.value);
    body.response.clientDataJSON = base64(Buffer.from(JSON.stringify(value)));
    assert.equal((await call('/auth/register/verify', body)).status, 400);
  }
});

test('one account cannot exhaust authenticated challenge slots and its expired challenges are reclaimed', async () => {
  const { register, primary, call, advance, store, login } = fixture();
  const credential = await register();
  for (let index = 0; index < 4; index++) {
    const client = browser();
    client.cookies.set('__Host-displayos', primary.cookies.get('__Host-displayos'));
    client.csrf = primary.csrf;
    assert.equal((await call('/auth/passkey/options', {}, { browser: client })).status, 200);
  }
  assert.equal((await call('/auth/passkey/options', {})).status, 429);
  assert.equal((await store.list('challenge:')).size, 4);
  advance(300001);
  assert.equal((await login(credential)).status, 200);
  assert.equal((await call('/auth/passkey/options', {})).status, 200);
  assert.equal((await store.list('challenge:')).size, 1);
});
