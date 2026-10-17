import { DurableObject } from 'cloudflare:workers';
import { RecordStore } from './store.js';
import { RateBudgets } from './budgets.js';
import { createPairing, removePairing, takeManualClaimBudget } from './pairing.js';
import { identityRoute, authenticate, requireBrowser } from './identity.js';
import { oauthRoute } from './oauth.js';
import { createProviderAdapters } from './providers.js';
import { localMetadata, loadLocal } from './local.js';
import { readJson, json, errorResponse, reject, random, text, digest, bearer, exact, internalRequest, publicConnectionRead } from './common.js';

const customerCommands = new Set(['home.get', 'home.update', 'home.temperature', 'home.export', 'home.delete', 'member.invite', 'member.remove', 'screen.list', 'screen.capabilities', 'screen.rename', 'screen.lists', 'screen.voice', 'home.voiceDefault', 'family.publish', 'family.current', 'revision.status', 'screen.settings', 'media.upload', 'media.list', 'media.get', 'media.delete', 'grant.revoke']);
const recentCommands = new Set(['home.delete', 'member.invite', 'member.remove']);
const system = { system: true };
const ownerPreviews = new Map([['/api/v1/providers/google/weather', 'weather'], ['/api/v1/providers/google/nearby', 'nearby']]);

function publicKey(value) {
  exact(value, ['kty', 'crv', 'x', 'y', 'ext', 'key_ops']);
  if (value.kty !== 'EC' || value.crv !== 'P-256' || !/^[A-Za-z0-9_-]{43}$/.test(value.x || '') || !/^[A-Za-z0-9_-]{43}$/.test(value.y || '')) reject(400, 'A device public key is required.');
  for (const coordinate of [value.x, value.y]) if (Buffer.from(coordinate, 'base64url').length !== 32 || Buffer.from(coordinate, 'base64url').toString('base64url') !== coordinate) reject(400, 'A canonical device public key is required.');
  return { kty: 'EC', crv: 'P-256', x: value.x, y: value.y, ext: true };
}

export class ProductRegistry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.records = new RecordStore(ctx.storage, env.PRODUCT_STATE_KEY, 'registry:' + ctx.id.toString());
    this.budgets = new RateBudgets();
    this.context = {
      store: this.records, origin: env.PUBLIC_ORIGIN, env, now: () => Date.now(),
      authenticate: request => authenticate(request, this.context),
      requireBrowser: request => requireBrowser(request, this.context),
      homeCall: (homeId, principal, command, input) => this.homeCall(homeId, principal, command, input),
      deviceHome: deviceId => this.records.get('device:' + deviceId),
      rate: (bucket, limit, windowMs) => this.rate(bucket, limit, windowMs),
      deleteAccount: accountId => this.deleteAccount(accountId)
    };
  }

  async rate(bucket, limit, windowMs) {
    return this.budgets.take(bucket, limit, windowMs);
  }

  async homeCall(homeId, principal, command, input = {}) {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(homeId || '')) reject(400, 'Choose a home.');
    const stub = this.env.HOMES.get(this.env.HOMES.idFromName(homeId));
    const response = await stub.fetch(internalRequest(this.env.PUBLIC_ORIGIN, command, input, principal, this.env.FACTORY_CREDENTIAL));
    const result = await response.json();
    if (!response.ok) reject(response.status, result.error || 'This action is not available.');
    return result;
  }

  async fetch(request) {
    try {
      const localUrl = new URL(request.url);
      if (ownerPreviews.has(localUrl.pathname)) return await this.ownerPreview(request, ownerPreviews.get(localUrl.pathname));
      if (localUrl.pathname === '/device/v1/local') {
        if (localUrl.origin !== this.env.PUBLIC_ORIGIN || localUrl.search || localUrl.hash || localUrl.username || localUrl.password || request.method !== 'GET' || request.headers.get('origin') && request.headers.get('origin') !== localUrl.origin) reject(403, 'Please use the correct screen connection.');
        const device = await this.authenticatedDevice(request);
        if (device.state !== 'owned') reject(403, 'Connect this screen to your home first.');
        await this.rate('device:local:' + device.id, 12, 3600000);
        const adapter = createProviderAdapters({ env: this.env, store: this.records, fetch, now: Date.now, origin: this.env.PUBLIC_ORIGIN });
        return await loadLocal({ device, store: this.records, adapter, homeCall: (...args) => this.homeCall(...args), finalize: callback => this.ctx.blockConcurrencyWhile(async () => json(await callback())) }).then(result => result instanceof Response ? result : json(result));
      }
      return await this.ctx.blockConcurrencyWhile(async () => {
        const url = this.customerAddress(request);
        const protocolResponse = await identityRoute(request, this.context) || await oauthRoute(request, this.context);
        if (protocolResponse) return protocolResponse;
        if (url.pathname.startsWith('/factory/')) return this.factory(request);
        if (url.pathname.startsWith('/device/')) return this.device(request);
        return this.customer(request);
      });
    } catch (error) { return errorResponse(error); }
  }

  customerAddress(request) {
    const url = new URL(request.url);
    if (url.origin !== this.env.PUBLIC_ORIGIN) reject(403, 'Please use the correct address.');
    if (url.search && !['/oauth/authorize', '/api/v1/providers/google/callback'].includes(url.pathname)) reject(400, 'Do not put private information in this address.');
    if (url.hash || url.username || url.password) reject(400, 'Please use the normal DisplayOS address.');
    if (request.headers.get('origin') && request.headers.get('origin') !== url.origin && !publicConnectionRead(request)) reject(403, 'Please use this page to make the change.');
    return url;
  }

  async ownerPreview(request, kind) {
    const prepared = await this.ctx.blockConcurrencyWhile(async () => {
      this.customerAddress(request);
      if (request.method !== 'POST') reject(405, 'This action requires confirmation.');
      const principal = await this.context.requireBrowser(request);
      await this.rate('account:' + principal.accountId, 120, 60000);
      const input = exact(await readJson(request, 200000), ['homeId']);
      const home = await this.homeCall(input.homeId, principal, 'home.get');
      if (home.role !== 'owner') reject(403, 'Only the person who manages this home can change its location.');
      await this.rate('account:local:' + principal.accountId, 12, 3600000);
      const adapter = createProviderAdapters({ env: this.env, store: this.records, fetch, now: Date.now, origin: this.env.PUBLIC_ORIGIN });
      const metadata = await localMetadata(adapter, input.homeId);
      return { principal, homeId: input.homeId, timezone: home.settings.timezone, adapter, metadata };
    });
    const result = kind === 'weather' ? await prepared.adapter.googleWeather(prepared.homeId, prepared.timezone) : await prepared.adapter.nearby(prepared.homeId);
    return this.ctx.blockConcurrencyWhile(async () => {
      const principal = await this.context.requireBrowser(request);
      if (principal.accountId !== prepared.principal.accountId || principal.sessionId !== prepared.principal.sessionId) reject(401, 'Please sign in again to see this information.');
      const home = await this.homeCall(prepared.homeId, principal, 'home.get');
      if (home.role !== 'owner') reject(403, 'Only the person who manages this home can see this information.');
      const fresh = await localMetadata(prepared.adapter, prepared.homeId);
      if (home.settings.timezone !== prepared.timezone || fresh.localRevision !== prepared.metadata.localRevision || JSON.stringify(fresh.localEnabled) !== JSON.stringify(prepared.metadata.localEnabled) || !fresh.localEnabled[kind]) reject(409, 'Your home location choices changed. Please try again.');
      if (result.available !== true || result.locationVersion !== fresh.localRevision || result.ephemeral !== true || result.attribution !== 'Google Maps' || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= Date.now() || result.expiresAt > Date.now() + 3600000 || !Array.isArray(result.thirdPartyAttributions) || result.thirdPartyAttributions.length || !Array.isArray(result[kind])) reject(502, 'Local information is not ready yet.');
      if (kind === 'weather' && result.weather.length && result.weatherSourceAttribution !== 'Source: Includes weather data from Google') reject(502, 'Weather information is not ready yet.');
      return json(result);
    });
  }

  async factory(request) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/factory/v1/tickets') reject(404, 'This action is not available.');
    if (bearer(request) !== this.env.FACTORY_CREDENTIAL) reject(403, 'Not allowed.');
    await this.rate('factory', 30, 60000);
    const input = exact(await readJson(request), ['serial', 'hardwareProfile', 'publicKey']);
    const serial = text(input.serial, 120);
    if (!['samsung-sm-t580-demo', 'browser-demo'].includes(input.hardwareProfile)) reject(400, 'This hardware is not qualified.');
    const key = publicKey(input.publicKey);
    const keyHash = await digest(JSON.stringify(key));
    const serialHash = await digest(serial);
    for (const prefix of ['serial:' + serialHash, 'device-key:' + keyHash]) {
      const existing = await this.records.get(prefix);
      if (existing) {
        if (existing.expiresAt <= Date.now() && !await this.records.get('device:' + existing.deviceId)) await this.records.delete(prefix);
        else reject(409, 'This screen was already prepared.');
      }
    }
    const count = await this.records.get('factory-count') || { value: 0 };
    if (count.value >= 1000) reject(429, 'The pilot preparation limit has been reached.');
    const deviceId = random(24);
    const ticket = random(32);
    const expiresAt = Date.now() + 600000;
    await this.records.transaction(async store => {
      await store.put('ticket:' + await digest(ticket), { deviceId, serialHash, serial, hardwareProfile: input.hardwareProfile, key, keyHash, expiresAt });
      await store.put('serial:' + serialHash, { deviceId, expiresAt });
      await store.put('device-key:' + keyHash, { deviceId, expiresAt });
      await store.put('factory-count', { value: count.value + 1 });
    });
    return json({ ticket, deviceId, expiresAt }, 201);
  }

  async enrollment(request, trustedAccountId) {
    await this.rate(trustedAccountId ? 'account:demo-enroll:' + trustedAccountId : 'enroll:' + (request.headers.get('cf-connecting-ip') || 'local'), 10, 60000);
    const input = exact(await readJson(request), ['ticket', 'publicKey', 'signature']);
    if (!/^[A-Za-z0-9_-]{43}$/.test(input.ticket || '') || !/^[A-Za-z0-9_-]{86}$/.test(input.signature || '')) reject(400, 'This preparation could not be verified.');
    const ticketKey = 'ticket:' + await digest(input.ticket);
    const ticket = await this.records.get(ticketKey);
    if (!ticket || ticket.expiresAt <= Date.now()) reject(410, 'This preparation has expired.');
    const key = publicKey(input.publicKey);
    if (await digest(JSON.stringify(key)) !== ticket.keyHash) reject(403, 'This preparation belongs to another screen.');
    const cryptoKey = await crypto.subtle.importKey('jwk', key, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, cryptoKey, Buffer.from(input.signature, 'base64url'), new TextEncoder().encode(input.ticket))) reject(403, 'This preparation could not be verified.');
    const deviceKey = 'device:' + ticket.deviceId;
    const existing = await this.records.get(deviceKey);
    if (existing) {
      if (!ticket.usedAt || existing.enrollmentHash !== await digest(input.ticket)) reject(409, 'This preparation was already used.');
      return json({ deviceId: existing.id, deviceToken: ticket.deviceToken });
    }
    const deviceToken = random(32);
    const device = { id: ticket.deviceId, name: 'Family screen', hardwareProfile: ticket.hardwareProfile, key: ticket.key, keyHash: ticket.keyHash, serial: ticket.serial, tokenHash: await digest(deviceToken), deviceToken, enrollmentHash: await digest(input.ticket), epoch: 1, state: 'unclaimed' };
    await this.records.transaction(async store => {
      await store.put(deviceKey, device);
      await store.put('device-token:' + device.tokenHash, { id: device.id });
      await store.put(ticketKey, { ...ticket, usedAt: Date.now(), deviceToken });
    });
    return json({ deviceId: device.id, deviceToken }, 201);
  }

  async authenticatedDevice(request) {
    const tokenHash = await digest(bearer(request));
    const pointer = await this.records.get('device-token:' + tokenHash);
    const device = pointer && await this.records.get('device:' + pointer.id);
    if (!device || device.tokenHash !== tokenHash) reject(401, 'This screen needs to be prepared again.');
    await this.rate('device:' + device.id, 180, 60000);
    return device;
  }

  async device(request) {
    const path = new URL(request.url).pathname;
    if (path === '/device/v1/enroll' && request.method === 'POST') return this.enrollment(request);
    if (path.startsWith('/device/v1/recover/') && request.method === 'POST') return this.recoverDevice(request);
    const device = await this.authenticatedDevice(request);
    const now = Date.now();
    if (path === '/device/v1/pairing' && request.method === 'POST') {
      exact(await readJson(request), []);
      if (device.state !== 'unclaimed') reject(409, 'This screen is already being set up.');
      if (device.pairing?.expiresAt > now) return json(device.pairing);
      return json(await createPairing(this.records, device, this.env.PUBLIC_ORIGIN, now));
    }
    if (path === '/device/v1/poll' && request.method === 'GET') {
      if (device.state === 'erase') return json({ state: 'erase', epoch: device.epoch });
      if (device.state === 'claiming') {
        if (device.claim.expiresAt <= now) {
          device.state = 'unclaimed'; delete device.claim;
          await this.records.put('device:' + device.id, device);
          return json({ state: 'unclaimed' });
        }
        return json({ state: 'confirm', phrase: device.claim.phrase, homeName: device.claim.homeName, expiresAt: device.claim.expiresAt });
      }
      if (device.state === 'attaching') return this.finishClaim(device);
      if (device.state !== 'owned') return json({ state: 'unclaimed', pairing: device.pairing?.expiresAt > now ? device.pairing : null });
      const state = await this.homeCall(device.homeId, { deviceId: device.id, epoch: device.epoch }, 'device.poll', { deviceId: device.id, epoch: device.epoch });
      const adapter = createProviderAdapters({ env: this.env, store: this.records, fetch, now: Date.now, origin: this.env.PUBLIC_ORIGIN });
      return json({ ...state, ...await localMetadata(adapter, device.homeId) });
    }
    if (path === '/device/v1/confirm' && request.method === 'POST') {
      const input = exact(await readJson(request), ['phrase']);
      if (device.state === 'owned') return json({ owned: true });
      if (device.state !== 'claiming' || device.claim.expiresAt <= now || input.phrase !== device.claim.phrase) reject(410, 'Please start pairing again.');
      device.state = 'attaching';
      await this.records.put('device:' + device.id, device);
      return this.finishClaim(device);
    }
    if (path === '/device/v1/erase' && request.method === 'POST') {
      exact(await readJson(request), []);
      if (device.state !== 'erase') reject(409, 'This screen does not need erasing.');
      if (device.previousHomeId) await this.homeCall(device.previousHomeId, system, 'screen.detach', { deviceId: device.id, epoch: device.epoch, operationId: device.resetId }).catch(error => { if (error.status !== 404) throw error; });
      const deviceToken = random(32);
      const tokenHash = await digest(deviceToken);
      await this.records.transaction(async store => {
        await store.delete('device-token:' + device.tokenHash);
        await store.put('device-token:' + tokenHash, { id: device.id });
        await store.put('device:' + device.id, { id: device.id, name: device.name, serial: device.serial, hardwareProfile: device.hardwareProfile, key: device.key, keyHash: device.keyHash, demoAccountId: device.demoAccountId, epoch: device.epoch, tokenHash, deviceToken, state: 'unclaimed' });
      });
      return json({ deviceToken, state: 'unclaimed' });
    }
    if (path === '/device/v1/ack' && request.method === 'POST') {
      const input = exact(await readJson(request), ['revision', 'nonce']);
      if (device.state !== 'owned') reject(403, 'This screen is not ready.');
      return json(await this.homeCall(device.homeId, { deviceId: device.id, epoch: device.epoch }, 'device.ack', input));
    }
    if (path === '/device/v1/lists' && request.method === 'POST') {
      const input = exact(await readJson(request, 8192), ['expectedRevision', 'listId', 'action', 'item', 'itemId']);
      if (device.state !== 'owned') reject(403, 'This screen is not ready.');
      await this.rate('device:lists:' + device.id, 12, 60000);
      return json(await this.homeCall(device.homeId, { deviceId: device.id, epoch: device.epoch }, 'lists.edit', input));
    }
    if (path === '/device/v1/voice' && request.method === 'POST') {
      const input = exact(await readJson(request, 8192), ['action', 'mime', 'byteLength', 'durationMs', 'uploadId', 'seq', 'data']);
      if (device.state !== 'owned') reject(403, 'This screen is not ready.');
      await this.rate('device:voice:' + device.id, 90, 60000);
      const principal = { deviceId: device.id, epoch: device.epoch };
      let command;
      let payload;
      if (input.action === 'begin') { command = 'voice.begin'; payload = { mime: input.mime, byteLength: input.byteLength, durationMs: input.durationMs }; }
      else if (input.action === 'part') { command = 'voice.part'; payload = { uploadId: input.uploadId, seq: input.seq, data: input.data }; }
      else if (input.action === 'end') { command = 'voice.end'; payload = { uploadId: input.uploadId }; }
      else if (input.action === 'cancel') { command = 'voice.cancel'; payload = { uploadId: input.uploadId }; }
      else reject(400, 'Choose a supported voice action.');
      return json(await this.homeCall(device.homeId, principal, command, payload));
    }
    if (/^\/device\/v1\/media\/[A-Za-z0-9_-]{24}$/.test(path) && request.method === 'GET') {
      if (device.state !== 'owned') reject(403, 'This screen is not ready.');
      const image = await this.homeCall(device.homeId, { deviceId: device.id, epoch: device.epoch }, 'media.get', { mediaId: path.split('/').at(-1) });
      return new Response(Buffer.from(image.data, 'base64'), { headers: { 'Content-Type': image.mime } });
    }
    reject(404, 'This action is not available.');
  }

  async recoverDevice(request) {
    await this.rate('recover:' + (request.headers.get('cf-connecting-ip') || 'local'), 10, 60000);
    const path = new URL(request.url).pathname;
    const input = exact(await readJson(request), path.endsWith('/start') ? ['deviceId', 'publicKey'] : ['deviceId', 'challenge', 'signature']);
    const device = await this.records.get('device:' + String(input.deviceId || ''));
    if (!device?.key) reject(403, 'This screen could not be verified.');
    const key = 'device-recovery:' + device.id;
    if (path === '/device/v1/recover/start') {
      if (await digest(JSON.stringify(publicKey(input.publicKey))) !== device.keyHash) reject(403, 'This screen could not be verified.');
      const challenge = random(32);
      await this.records.put(key, { challenge, expiresAt: Date.now() + 120000 });
      return json({ challenge, message: 'DisplayOS recovery\n' + this.env.PUBLIC_ORIGIN + '\n' + device.id + '\n' + challenge });
    }
    if (path !== '/device/v1/recover/verify') reject(404, 'This action is not available.');
    const recovery = await this.records.get(key);
    if (!recovery || recovery.expiresAt <= Date.now() || recovery.challenge !== input.challenge || !/^[A-Za-z0-9_-]{86}$/.test(input.signature || '')) reject(403, 'This screen could not be verified.');
    const publicCryptoKey = await crypto.subtle.importKey('jwk', device.key, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const message = 'DisplayOS recovery\n' + this.env.PUBLIC_ORIGIN + '\n' + device.id + '\n' + recovery.challenge;
    if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicCryptoKey, Buffer.from(input.signature, 'base64url'), new TextEncoder().encode(message))) reject(403, 'This screen could not be verified.');
    await this.records.delete(key);
    return json({ deviceId: device.id, deviceToken: device.deviceToken, state: device.state });
  }

  async finishClaim(device) {
    await this.homeCall(device.claim.homeId, system, 'screen.attach', { deviceId: device.id, name: device.name, epoch: device.epoch });
    device.homeId = device.claim.homeId;
    device.ownerAccountId = device.claim.accountId;
    device.state = 'owned';
    delete device.claim; delete device.pairing;
    await this.records.put('device:' + device.id, device);
    return json({ owned: true, state: 'owned' });
  }

  async customer(request) {
    const path = new URL(request.url).pathname;
    const principal = request.method === 'POST' ? await this.context.requireBrowser(request) : await this.context.authenticate(request);
    await this.rate('account:' + principal.accountId, 120, 60000);
    if (path === '/api/v1/providers/google/callback' && request.method === 'GET') {
      const parameters = new URL(request.url).searchParams;
      const allowed = ['code', 'state', 'scope', 'authuser', 'prompt', 'error', 'error_description'];
      const seen = new Set();
      for (const [key] of parameters) { if (!allowed.includes(key) || seen.has(key)) reject(400, 'Please start connecting this source again.'); seen.add(key); }
      if (parameters.has('error')) return Response.redirect(this.env.PUBLIC_ORIGIN + '/home#source=cancelled', 303);
      const adapter = createProviderAdapters({ env: this.env, store: this.records, fetch, now: Date.now, origin: this.env.PUBLIC_ORIGIN });
      await adapter.finishGoogle(principal.accountId, { code: parameters.get('code'), state: parameters.get('state') });
      return Response.redirect(this.env.PUBLIC_ORIGIN + '/home#source=connected', 303);
    }
    if (path === '/api/v1/providers/status' && request.method === 'GET') {
      return json(await createProviderAdapters({ env: this.env, store: this.records, fetch, now: Date.now, origin: this.env.PUBLIC_ORIGIN }).status(principal.accountId));
    }
    if (path === '/api/v1/homes' && request.method === 'GET') {
      const index = await this.records.get('account-homes:' + principal.accountId) || { homes: [] };
      const homes = [];
      for (const id of index.homes) {
        try { const home = await this.homeCall(id, principal, 'home.get'); homes.push({ id, name: home.name, role: home.role }); } catch (error) { if (![403, 404].includes(error.status)) throw error; }
      }
      return json({ homes });
    }
    if (request.method !== 'POST') reject(405, 'This action requires confirmation.');
    const input = await readJson(request, 200000);
    if (path === '/api/v1/demo-screen') {
      exact(input, []);
      this.requireRecent(principal);
      const index = await this.records.get('account-demos:' + principal.accountId) || { devices: [] };
      if (index.devices.length >= 2) reject(429, 'Two practice screens are enough. Use an existing one or remove your account to start again.');
      const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      const key = await crypto.subtle.exportKey('jwk', keys.publicKey);
      const prepared = await this.factory(new Request(this.env.PUBLIC_ORIGIN + '/factory/v1/tickets', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.env.FACTORY_CREDENTIAL }, body: JSON.stringify({ serial: 'browser-' + random(24), hardwareProfile: 'browser-demo', publicKey: key }) }));
      const { ticket } = await prepared.json();
      const signature = Buffer.from(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, new TextEncoder().encode(ticket))).toString('base64url');
      const enrolled = await this.enrollment(new Request(this.env.PUBLIC_ORIGIN + '/device/v1/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket, publicKey: key, signature }) }), principal.accountId);
      const identity = await enrolled.json();
      const demoDevice = await this.records.get('device:' + identity.deviceId);
      await this.records.put('device:' + identity.deviceId, { ...demoDevice, demoAccountId: principal.accountId });
      await this.records.put('account-demos:' + principal.accountId, { devices: [...index.devices, identity.deviceId] });
      return json({ ...identity, publicKey: key, privateKey: await crypto.subtle.exportKey('jwk', keys.privateKey) }, 201);
    }
    if (path === '/api/v1/homes') {
      exact(input, ['name']);
      const index = await this.records.get('account-homes:' + principal.accountId) || { homes: [] };
      if (index.homes.length >= 8) reject(429, 'You have enough homes already.');
      const account = await this.records.get('account:' + principal.accountId);
      const name = text(input.name);
      let pending = await this.records.get('pending-home:' + principal.accountId);
      if (!pending) { pending = { id: random(24), name }; await this.records.put('pending-home:' + principal.accountId, pending); }
      if (pending.name !== name) reject(409, 'Please finish creating your previous home first.');
      const id = pending.id;
      const home = await this.homeCall(id, system, 'home.create', { id, name, accountId: principal.accountId, accountName: account.name });
      await this.records.transaction(async store => { await store.put('account-homes:' + principal.accountId, { homes: [...new Set([...index.homes, id])] }); await store.delete('pending-home:' + principal.accountId); });
      return json(home, 201);
    }
    if (path === '/api/v1/claim') {
      exact(input, ['code', 'homeId']);
      const code = typeof input.code === 'string' ? input.code.replace(/[\s-]/g, '').toUpperCase() : '';
      const manual = /^[0-9]{6}$/.test(code);
      if (!manual && !/^(?:[A-F0-9]{12}|[A-F0-9]{32})$/.test(code)) reject(400, 'Enter the six numbers shown on your screen, or scan its square.');
      await this.rate('claim:' + principal.accountId, 10, 60000);
      const home = await this.homeCall(input.homeId, principal, 'home.get');
      if (home.role !== 'owner') reject(403, 'Only the person who manages this home can add a screen.');
      if (manual) await takeManualClaimBudget(this.records, principal.accountId, request.headers.get('cf-connecting-ip') || 'local', Date.now());
      const pairKey = (manual ? 'pair-manual:' : 'pair:') + await digest(code);
      const pairing = await this.records.get(pairKey);
      if (!pairing || pairing.expiresAt <= Date.now()) reject(410, 'This code has expired. Ask the screen for a new one.');
      const device = await this.records.get('device:' + pairing.deviceId);
      if (!device || device.state !== 'unclaimed' || device.epoch !== pairing.epoch) reject(409, 'This screen is already being paired.');
      if (!device.pairing || device.pairing.expiresAt <= Date.now() || pairing.codeHash && pairing.codeHash !== await digest(device.pairing.code)) reject(410, 'This code has expired. Ask the screen for a new one.');
      if (device.demoAccountId && device.demoAccountId !== principal.accountId) reject(403, 'A practice screen stays with the person who created it. Please use your own trial.');
      const phrase = ['Sunshine', 'Meadow', 'Horizon', 'Seaside'][crypto.getRandomValues(new Uint8Array(1))[0] % 4] + ' ' + String(crypto.getRandomValues(new Uint16Array(1))[0] % 900 + 100);
      const claim = { accountId: principal.accountId, homeId: input.homeId, homeName: home.name, phrase, expiresAt: Date.now() + 120000 };
      await this.records.transaction(async store => { await removePairing(store, device.pairing); await store.put('device:' + device.id, { ...device, state: 'claiming', claim }); });
      return json({ pending: true, phrase, screenName: device.name, expiresAt: claim.expiresAt });
    }
    if (path === '/api/v1/screens/reset') {
      exact(input, ['deviceId', 'homeId']);
      this.requireRecent(principal);
      const home = await this.homeCall(input.homeId, principal, 'home.get');
      if (home.role !== 'owner') reject(403, 'Only the person who manages this home can remove a screen.');
      const device = await this.records.get('device:' + input.deviceId);
      if (!device || device.homeId !== input.homeId || !['owned', 'erase'].includes(device.state)) reject(403, 'This screen is not in your home.');
      await this.resetDevice(device);
      return json({ pending: true });
    }
    if (path === '/api/v1/invitations/accept') {
      exact(input, ['code', 'homeId']);
      this.requireRecent(principal);
      const account = await this.records.get('account:' + principal.accountId);
      const index = await this.records.get('account-homes:' + principal.accountId) || { homes: [] };
      if (index.homes.length >= 8 && !index.homes.includes(input.homeId)) reject(429, 'You have enough homes already.');
      const pendingKey = 'pending-invite:' + principal.accountId;
      const pending = await this.records.get(pendingKey);
      if (pending && (pending.homeId !== input.homeId || pending.code !== input.code)) reject(409, 'Finish your previous invitation first.');
      if (!pending) await this.records.put(pendingKey, { homeId: input.homeId, code: input.code });
      await this.homeCall(input.homeId, system, 'member.accept', { code: input.code, accountId: principal.accountId, name: account.name, operationId: await digest(principal.accountId + ':' + input.code) });
      await this.records.transaction(async store => { await store.put('account-homes:' + principal.accountId, { homes: [...new Set([...index.homes, input.homeId])] }); await store.delete(pendingKey); });
      return json({ joined: true });
    }
    if (path.startsWith('/api/v1/providers/')) return this.providers(request, principal, input);
    if (path === '/api/v1/home') {
      exact(input, ['homeId', 'command', 'input']);
      if (!customerCommands.has(input.command)) reject(403, 'This action is not available.');
      if (recentCommands.has(input.command)) this.requireRecent(principal);
      if (input.command === 'home.delete') {
        await this.deleteHome(input.homeId, principal);
        return json({ deleted: true });
      }
      const result = await this.homeCall(input.homeId, principal, input.command, input.input || {});
      if (input.command === 'home.export') {
        const location = await this.records.get('provider:location:' + input.homeId);
        return json({ ...result, homeLocation: location?.address ? { address: location.address, weather: location.weather, nearby: location.nearby, savedAt: location.savedAt } : null });
      }
      return json(result);
    }
    reject(404, 'This action is not available.');
  }

  requireRecent(principal) { if (Date.now() - principal.verifiedAt > 300000) reject(401, 'Please sign in again to confirm this change.'); }

  async resetDevice(device) {
    if (device.state !== 'erase') {
      device.previousHomeId = device.homeId;
      device.epoch += 1;
      device.state = 'erase'; device.resetId = random(24);
      await this.records.put('device:' + device.id, device);
    }
    await this.homeCall(device.previousHomeId, system, 'screen.detach', { deviceId: device.id, epoch: device.epoch, operationId: device.resetId }).catch(error => { if (error.status !== 404) throw error; });
  }

  async deleteHome(homeId, principal) {
    const journalKey = 'deleting-home:' + homeId;
    let home = await this.records.get(journalKey);
    if (home && home.deletedBy !== principal.accountId) reject(403, 'Only the person who manages this home can delete it.');
    if (!home) {
      home = await this.homeCall(homeId, principal, 'home.get');
      if (home.role !== 'owner') reject(403, 'Only the person who manages this home can delete it.');
      home.deletedBy = principal.accountId;
      await this.records.put(journalKey, home);
    }
    for (const screen of home.screens) {
      const device = await this.records.get('device:' + screen.id);
      if (device?.homeId === homeId) await this.resetDevice(device);
    }
    await this.homeCall(homeId, principal, 'home.delete').catch(error => { if (error.status !== 404) throw error; });
    await this.records.delete('provider:location:' + homeId);
    for (const member of home.members) {
      const index = await this.records.get('account-homes:' + member.accountId);
      if (index) await this.records.put('account-homes:' + member.accountId, { homes: index.homes.filter(id => id !== homeId) });
    }
    await this.records.delete(journalKey);
  }

  async deleteAccount(accountId) {
    const index = await this.records.get('account-homes:' + accountId) || { homes: [] };
    const pendingHome = await this.records.get('pending-home:' + accountId);
    const pendingInvite = await this.records.get('pending-invite:' + accountId);
    if (pendingHome?.id) index.homes.push(pendingHome.id);
    if (pendingInvite?.homeId) index.homes.push(pendingInvite.homeId);
    index.homes = [...new Set(index.homes)];
    for (const homeId of index.homes) {
      if (await this.records.get('deleting-home:' + homeId)) { await this.deleteHome(homeId, { accountId }); continue; }
      const result = await this.homeCall(homeId, system, 'account.remove', { accountId }).catch(error => { if (error.status !== 404) throw error; return {}; });
      if (result.needsDelete) await this.deleteHome(homeId, { accountId });
    }
    await this.records.delete('account-homes:' + accountId);
    await this.records.delete('pending-home:' + accountId);
    await this.records.delete('pending-invite:' + accountId);
    const demos = await this.records.get('account-demos:' + accountId);
    for (const id of demos?.devices || []) {
      const device = await this.records.get('device:' + id);
      if (!device) continue;
      if ((device.ownerAccountId && device.ownerAccountId !== accountId) || (device.claim && device.claim.accountId !== accountId)) continue;
      if (device.pairing) await removePairing(this.records, device.pairing);
      if (device.state === 'owned') await this.resetDevice(device);
      await this.records.transaction(async store => {
        await store.delete('device-token:' + device.tokenHash);
        await store.delete('device:' + id);
        await store.delete('device-key:' + device.keyHash);
        await store.delete('serial:' + await digest(device.serial));
        await store.delete('device-recovery:' + id);
        if (device.enrollmentHash) await store.delete('ticket:' + device.enrollmentHash);
      });
    }
    await this.records.delete('account-demos:' + accountId);
    await createProviderAdapters({ env: this.env, store: this.records, fetch, now: Date.now, origin: this.env.PUBLIC_ORIGIN }).disconnect(accountId);
  }

  async providers(request, principal, input) {
    const adapter = createProviderAdapters({ env: this.env, store: this.records, fetch, now: Date.now, origin: this.env.PUBLIC_ORIGIN });
    const path = new URL(request.url).pathname;
    if (['/api/v1/providers/location', '/api/v1/providers/location/save'].includes(path)) {
      exact(input, path.endsWith('/save') ? ['homeId', 'address', 'weather', 'nearby'] : ['homeId']);
      const home = await this.homeCall(input.homeId, principal, 'home.get');
      if (home.role !== 'owner') reject(403, 'Only the person who manages this home can change its location.');
      if (path === '/api/v1/providers/location') return json(await adapter.location(input.homeId));
      if (path === '/api/v1/providers/location/save') return json(await adapter.saveLocation(input.homeId, { address: input.address, weather: input.weather, nearby: input.nearby }));
    }
    if (path === '/api/v1/providers/google/start') { this.requireRecent(principal); return json(await adapter.beginGoogle(principal.accountId, input)); }
    if (path === '/api/v1/providers/google/finish') return json(await adapter.finishGoogle(principal.accountId, input));
    if (path === '/api/v1/providers/google/calendar') return json(await adapter.calendar(principal.accountId, input));
    if (path === '/api/v1/providers/google/inbox') return json(await adapter.inbox(principal.accountId, input));
    if (path === '/api/v1/providers/sharing') return json(await adapter.setSharing(principal.accountId, input));
    if (path === '/api/v1/providers/weather') return json(await adapter.weather(input));
    if (path === '/api/v1/providers/disconnect') return json(await adapter.disconnect(principal.accountId));
    reject(404, 'This source is not available.');
  }
}
