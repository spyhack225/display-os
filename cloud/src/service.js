import { DisplayModel, equalSecret, fail, secret } from '../../demo/model.js';
import { createHash } from 'node:crypto';

export function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

export function errorResponse(error) {
  return json(error.status || 503, { error: error.status ? error.message : 'Pilot service unavailable. No success has been assumed.' });
}

export function configuration(env) {
  const origin = new URL(env.PUBLIC_ORIGIN);
  if (origin.protocol !== 'https:' || origin.origin !== env.PUBLIC_ORIGIN || origin.hostname.endsWith('.invalid')) {
    throw new Error('Configure an exact HTTPS PUBLIC_ORIGIN.');
  }
  for (const key of ['OWNER_CREDENTIAL', 'ENROLLMENT_CODE', 'STATE_ENCRYPTION_KEY']) {
    if (!/^[a-f0-9]{64}$/.test(env[key] || '')) throw new Error('Missing pilot secret.');
  }
  return origin.origin;
}

export async function body(request) {
  if (request.headers.get('content-type') !== 'application/json') fail(415, 'Use application/json.');
  const reader = request.body?.getReader();
  if (!reader) fail(400, 'JSON object required.');
  const chunks = [];
  let size = 0;
  const deadline = Date.now() + 5000;
  while (true) {
    let timer;
    const chunk = await Promise.race([
      reader.read(),
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Request body timed out.'), { status: 408 })), Math.max(0, deadline - Date.now())); })
    ]).catch(error => { reader.cancel().catch(() => {}); throw error; }).finally(() => clearTimeout(timer));
    if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > 8192) { await reader.cancel(); fail(413, 'Payload exceeds 8192 bytes.'); }
    chunks.push(chunk.value);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(400, 'Invalid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'JSON object required.');
  return value;
}

function bearer(request) {
  const match = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get('authorization') || '');
  return match ? match[1] : '';
}

export class CloudService {
  constructor(env, now = Date.now) {
    this.env = env;
    this.now = now;
    this.model = new DisplayModel({ now });
    this.sessions = new Map();
    this.limits = new Map();
  }

  rate(client, bucket, maximum) {
    const key = client + ':' + bucket;
    let entry = this.limits.get(key);
    if (!entry || entry.until <= this.now()) {
      const reserved = value => /^(owner|fixed|display|agent|request):/.test(value);
      const anonymous = [...this.limits.keys()].filter(entry => !reserved(entry)).length;
      if (!reserved(client) && anonymous >= 64 && !this.limits.has(key)) fail(429, 'Pilot client capacity reached. Wait one minute.');
      entry = { count: 0, until: this.now() + 60000 };
      this.limits.set(key, entry);
    }
    if (entry.count >= maximum) fail(429, 'Too many requests. Wait one minute.');
    entry.count++;
  }

  cleanup() {
    for (const [key, entry] of this.limits) if (entry.until <= this.now()) this.limits.delete(key);
    for (const [key, entry] of this.sessions) if (entry.expiresAt <= this.now()) this.sessions.delete(key);
    for (const [key, entry] of this.model.requests) if (entry.expiresAt <= this.now()) this.model.requests.delete(key);
    for (const [key, entry] of this.model.grants) {
      if ((entry.expiresAt <= this.now() || entry.revoked) && ![...this.model.requests.values()].some(request => request.grantId === key)) this.model.grants.delete(key);
    }
  }

  session(request, mutation) {
    const cookie = /(?:^|;\s*)__Host-desk_owner=([a-f0-9]{64})(?:;|$)/.exec(request.headers.get('cookie') || '');
    const active = cookie && this.sessions.get(cookie[1]);
    const credentialId = createHash('sha256').update(this.env.OWNER_CREDENTIAL).digest('hex');
    if (!active || active.expiresAt <= this.now() || !equalSecret(active.credentialId, credentialId)) fail(401, 'Owner login required.');
    if (mutation && !equalSecret(request.headers.get('x-csrf-token'), active.csrf)) fail(403, 'Owner CSRF token required.');
    return { ...active, cookie: cookie[1] };
  }

  authenticatedClient(request, route) {
    try {
      if (route.startsWith('/api/owner/') && route !== '/api/owner/login') {
        this.session(request, false);
        return 'owner:pilot';
      }
      const device = /^\/api\/devices\/([a-f0-9]{24})\/(poll|pairing|ack)$/.exec(route);
      if (device) {
        this.model.transport(device[1], bearer(request));
        return 'display:' + device[1];
      }
      const pending = /^\/api\/agent\/requests\/([a-f0-9]{24})$/.exec(route);
      if (pending) {
        const status = this.model.requestStatus(pending[1], bearer(request));
        return (status.status === 'approved' ? 'agent:' : 'request:') + this.model.requests.get(pending[1]).deviceId;
      }
      const agent = /^\/api\/agent\/devices\/([a-f0-9]{24})\/(capabilities|content|revisions\/[0-9]+)$/.exec(route);
      if (agent) {
        this.model.agent(agent[1], bearer(request), request.method === 'POST' && agent[2] === 'content' ? 'content:write' : 'display:read');
        return 'agent:' + agent[1];
      }
    } catch (error) { if (![401, 403, 404, 410].includes(error.status)) throw error; }
    return null;
  }

  async handle(request) {
    const url = new URL(request.url);
    const origin = configuration(this.env);
    if (url.origin !== origin) fail(403, 'Unexpected origin. Use the configured HTTPS hostname.');
    if (url.search) fail(400, 'Query parameters are not supported. Never put credentials in URLs.');
    if (request.headers.has('origin') && request.headers.get('origin') !== origin) fail(403, 'Cross-origin requests are not allowed.');
    if (!['GET', 'POST'].includes(request.method)) fail(405, 'Only GET and POST are supported.');
    if (request.method === 'POST' && request.headers.get('x-demo-request') !== '1') fail(403, 'X-Demo-Request: 1 is required.');
    const route = url.pathname;
    this.cleanup();
    const authenticated = this.authenticatedClient(request, route);
    const client = authenticated || request.headers.get('cf-connecting-ip') || 'local-test';
    if (!authenticated) this.rate('fixed:anonymous', 'all', 300);
    this.rate(client, 'all', 600);
    if (request.method === 'GET' && route === '/api/health') return json(200, { service: 'displayos-cloud', version: 1, syntheticOnly: true, ownerAuth: 'single-owner', persistent: true });
    if (request.method === 'POST' && route === '/api/owner/login') {
      if (request.headers.get('origin') !== origin) fail(403, 'Owner login requires the exact browser origin.');
      this.rate('pilot', 'login-global', 30);
      this.rate(client, 'login', 10);
      const value = await body(request);
      if (Object.keys(value).some(key => key !== 'credential') || !equalSecret(value.credential, this.env.OWNER_CREDENTIAL)) fail(401, 'Owner credential rejected.');
      if (this.sessions.size >= 16) fail(429, 'Pilot session capacity reached. Log out or wait for expiry.');
      const cookie = secret();
      const active = { owner: 'pilot-owner', csrf: secret(), expiresAt: this.now() + 3600000, credentialId: createHash('sha256').update(this.env.OWNER_CREDENTIAL).digest('hex') };
      this.sessions.set(cookie, active);
      const response = json(200, { csrfToken: active.csrf, expiresAt: active.expiresAt });
      response.headers.set('Set-Cookie', '__Host-desk_owner=' + cookie + '; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600');
      return response;
    }
    if (route.startsWith('/api/owner/')) {
      if (request.method === 'POST' && request.headers.get('origin') !== origin) fail(403, 'Owner changes require the exact browser origin.');
      const active = this.session(request, request.method === 'POST');
      if (request.method === 'GET' && route === '/api/owner/state') return json(200, { ...this.model.ownerView(active.owner), csrfToken: active.csrf, sessionExpiresAt: active.expiresAt });
      if (request.method === 'POST' && route === '/api/owner/logout') {
        await body(request);
        this.sessions.delete(active.cookie);
        const response = json(200, { loggedOut: true });
        response.headers.set('Set-Cookie', '__Host-desk_owner=; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
        return response;
      }
      if (request.method === 'POST' && route === '/api/owner/claim') {
        this.rate(client, 'claim', 10);
        const value = await body(request);
        if (Object.keys(value).length === 1 && typeof value.code === 'string' && /^[a-f0-9]{12}$/i.test(value.code)) {
          const matches = [...this.model.devices.values()].filter(device => equalSecret(device.pairing.code, value.code.toUpperCase()));
          if (matches.length !== 1) fail(400, 'Screen code not found. Check the code on your screen.');
          value.sessionId = matches[0].pairing.sessionId;
        }
        return json(200, this.model.claim(active.owner, value));
      }
      const approval = /^\/api\/owner\/requests\/([a-f0-9]{24})\/approve$/.exec(route);
      if (request.method === 'POST' && approval) return json(200, this.model.approve(active.owner, approval[1], await body(request)));
      const revoke = /^\/api\/owner\/grants\/([a-f0-9]{24})\/revoke$/.exec(route);
      if (request.method === 'POST' && revoke) { await body(request); return json(200, this.model.revoke(active.owner, revoke[1])); }
    }
    if (request.method === 'POST' && route === '/api/displays') {
      this.rate(client, 'enroll', 10);
      if (!equalSecret(request.headers.get('x-enrollment-code'), this.env.ENROLLMENT_CODE)) fail(401, 'Private pilot enrollment code required.');
      return json(201, this.model.enroll(await body(request)));
    }
    const transport = /^\/api\/devices\/([a-f0-9]{24})\/(poll|pairing|ack)$/.exec(route);
    if (transport) {
      const device = this.model.transport(transport[1], bearer(request));
      if (request.method === 'GET' && transport[2] === 'poll') return json(200, this.model.poll(device));
      if (request.method === 'POST' && transport[2] === 'pairing') { await body(request); return json(200, this.model.rotatePairing(device)); }
      if (request.method === 'POST' && transport[2] === 'ack') return json(200, this.model.acknowledge(device, await body(request)));
    }
    if (request.method === 'POST' && route === '/api/agent/requests') {
      this.rate(client, 'agent-request', 20);
      this.rate('pilot', 'agent-request-global', 60);
      const value = await body(request);
      if ([...this.model.requests.values()].filter(entry => entry.deviceId === value.deviceId && entry.status === 'pending').length >= 5) fail(429, 'Display already has five pending requests. Wait for approval or expiry.');
      return json(201, this.model.requestGrant(value));
    }
    const requestStatus = /^\/api\/agent\/requests\/([a-f0-9]{24})$/.exec(route);
    if (request.method === 'GET' && requestStatus) return json(200, this.model.requestStatus(requestStatus[1], bearer(request)));
    const agent = /^\/api\/agent\/devices\/([a-f0-9]{24})\/(capabilities|content|revisions\/([0-9]+))$/.exec(route);
    if (agent) {
      if (request.method === 'POST' && agent[2] === 'content') return json(200, this.model.publish(agent[1], bearer(request), await body(request), request.headers.get('idempotency-key')));
      if (request.method === 'GET') {
        this.model.agent(agent[1], bearer(request), 'display:read');
        const device = this.model.device(agent[1]);
        if (agent[2] === 'capabilities') return json(200, { deviceId: device.id, revision: device.revision, blocks: ['text'], maximumCards: 4, maximumTitleLength: 80, maximumTextLength: 600, scopes: ['display:read', 'content:write'] });
        if (agent[3]) return json(200, this.model.revisionStatus(device, Number(agent[3])));
      }
    }
    fail(404, 'Route not found.');
  }
}
