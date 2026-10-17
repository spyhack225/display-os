import http from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { DisplayModel, equalSecret, fail, secret } from './model.js';
import { secureRuntime } from './runtime.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const staticFiles = new Map([
  ['/', ['display.html', 'text/html']], ['/display', ['display.html', 'text/html']],
  ['/setup', ['setup.html', 'text/html']], ['/agent', ['agent.html', 'text/html']],
  ['/app.js', ['app.js', 'text/javascript']], ['/style.css', ['style.css', 'text/css']],
  ['/skill.md', ['skill.md', 'text/markdown']], ['/api-contract.json', ['api-contract.json', 'application/json']]
]);

function bearer(request) {
  const match = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.authorization || '');
  return match ? match[1] : '';
}

async function jsonBody(request) {
  if (request.headers['content-type'] !== 'application/json') fail(415, 'Use application/json.');
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) fail(413, 'Payload exceeds 8192 bytes.');
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(400, 'Invalid JSON.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, 'JSON object required.');
  return body;
}

export function createService({ ownerCredential, now = Date.now, modelOptions = {}, publicOrigin = null } = {}) {
  if (typeof ownerCredential !== 'string' || ownerCredential.length < 64) throw new Error('Strong owner credential required.');
  const model = new DisplayModel({ ...modelOptions, now });
  const sessions = new Map();
  const limits = new Map();

  function rate(request, bucket, maximum) {
    const key = request.socket.remoteAddress + ':' + bucket;
    let entry = limits.get(key);
    if (!entry || entry.until <= now()) {
      if (limits.size >= 2048 && !limits.has(key)) fail(429, 'Demo client limit reached.');
      entry = { count: 0, until: now() + 60000 };
      limits.set(key, entry);
    }
    if (++entry.count > maximum) fail(429, 'Too many requests. Wait one minute.');
  }

  function session(request, mutation = false) {
    const cookie = /(?:^|;\s*)demo_owner=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie || '');
    const active = cookie && sessions.get(cookie[1]);
    if (!active || active.expiresAt <= now()) fail(401, 'Owner login required.');
    if (mutation && !equalSecret(request.headers['x-csrf-token'], active.csrf)) fail(403, 'Owner CSRF token required.');
    return active;
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    response.setHeader('X-Frame-Options', 'DENY');
    const send = (status, body) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    try {
      const address = server.address();
      const origin = publicOrigin || 'http://127.0.0.1:' + address.port;
      const allowedHost = new URL(origin).host;
      if (request.headers.host !== allowedHost) fail(403, 'Unexpected Host. Use the configured origin.');
      if (request.headers.origin && request.headers.origin !== origin) fail(403, 'Cross-origin requests are not allowed.');
      if (!['GET', 'POST'].includes(request.method)) fail(405, 'Only GET and POST are supported.');
      if (request.method === 'POST' && request.headers['x-demo-request'] !== '1') fail(403, 'X-Demo-Request: 1 is required.');
      rate(request, 'all', 600);
      const url = new URL(request.url, origin);
      if (url.search) fail(400, 'Query parameters are not supported. Do not put credentials in URLs.');
      const route = url.pathname;
      if (request.method === 'GET' && staticFiles.has(route)) {
        const [filename, type] = staticFiles.get(route);
        const content = await readFile(path.join(root, 'public', filename));
        response.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
        response.end(content);
        return;
      }
      if (request.method === 'GET' && route === '/api/health') {
        send(200, { service: 'local-display-demo', version: 1, syntheticOnly: true });
        return;
      }
      if (request.method === 'POST' && route === '/api/owner/login') {
        rate(request, 'owner-login', 10);
        const body = await jsonBody(request);
        if (!equalSecret(body.credential, ownerCredential)) fail(401, 'Owner credential rejected.');
        for (const [id, entry] of sessions) if (entry.expiresAt <= now()) sessions.delete(id);
        if (sessions.size >= 32) fail(429, 'Owner session limit reached.');
        const cookie = secret();
        const active = { owner: 'local-owner', csrf: secret(), expiresAt: now() + 3600000 };
        sessions.set(cookie, active);
        response.setHeader('Set-Cookie', 'demo_owner=' + cookie + '; HttpOnly; SameSite=Strict; Path=/api/owner; Max-Age=3600');
        send(200, { csrfToken: active.csrf, expiresAt: active.expiresAt });
        return;
      }
      if (route.startsWith('/api/owner/')) {
        const active = session(request, request.method === 'POST');
        if (request.method === 'GET' && route === '/api/owner/state') {
          send(200, { ...model.ownerView(active.owner), csrfToken: active.csrf, sessionExpiresAt: active.expiresAt });
          return;
        }
        if (request.method === 'POST' && route === '/api/owner/logout') {
          const cookie = /demo_owner=([a-f0-9]{64})/.exec(request.headers.cookie);
          sessions.delete(cookie[1]);
          response.setHeader('Set-Cookie', 'demo_owner=; HttpOnly; SameSite=Strict; Path=/api/owner; Max-Age=0');
          send(200, { loggedOut: true });
          return;
        }
        if (request.method === 'POST' && route === '/api/owner/claim') {
          rate(request, 'claim', 10);
          send(200, model.claim(active.owner, await jsonBody(request)));
          return;
        }
        const approval = /^\/api\/owner\/requests\/([a-f0-9]{24})\/approve$/.exec(route);
        if (request.method === 'POST' && approval) {
          send(200, model.approve(active.owner, approval[1], await jsonBody(request)));
          return;
        }
        const revoke = /^\/api\/owner\/grants\/([a-f0-9]{24})\/revoke$/.exec(route);
        if (request.method === 'POST' && revoke) {
          await jsonBody(request);
          send(200, model.revoke(active.owner, revoke[1]));
          return;
        }
      }
      if (request.method === 'POST' && route === '/api/displays') {
        rate(request, 'enroll', 10);
        send(201, model.enroll(await jsonBody(request)));
        return;
      }
      const transport = /^\/api\/devices\/([a-f0-9]{24})\/(poll|pairing|ack)$/.exec(route);
      if (transport) {
        const device = model.transport(transport[1], bearer(request));
        if (request.method === 'GET' && transport[2] === 'poll') {
          send(200, model.poll(device));
          return;
        }
        if (request.method === 'POST' && transport[2] === 'pairing') {
          await jsonBody(request);
          send(200, model.rotatePairing(device));
          return;
        }
        if (request.method === 'POST' && transport[2] === 'ack') {
          send(200, model.acknowledge(device, await jsonBody(request)));
          return;
        }
      }
      if (request.method === 'POST' && route === '/api/agent/requests') {
        rate(request, 'agent-request', 20);
        send(201, model.requestGrant(await jsonBody(request)));
        return;
      }
      const requestStatus = /^\/api\/agent\/requests\/([a-f0-9]{24})$/.exec(route);
      if (request.method === 'GET' && requestStatus) {
        send(200, model.requestStatus(requestStatus[1], bearer(request)));
        return;
      }
      const agent = /^\/api\/agent\/devices\/([a-f0-9]{24})\/(capabilities|content|revisions\/([0-9]+))$/.exec(route);
      if (agent) {
        if (request.method === 'POST' && agent[2] === 'content') {
          model.agent(agent[1], bearer(request), 'content:write');
          send(200, model.publish(agent[1], bearer(request), await jsonBody(request), request.headers['idempotency-key']));
          return;
        }
        if (request.method === 'GET') {
          model.agent(agent[1], bearer(request), 'display:read');
          const device = model.device(agent[1]);
          if (agent[2] === 'capabilities') {
            send(200, { deviceId: device.id, revision: device.revision, blocks: ['text'], maximumCards: 4, maximumTitleLength: 80, maximumTextLength: 600, scopes: ['display:read', 'content:write'] });
            return;
          }
          if (agent[3]) {
            send(200, model.revisionStatus(device, Number(agent[3])));
            return;
          }
        }
      }
      fail(404, 'Route not found.');
    } catch (error) {
      if (!response.headersSent) send(error.status || 500, { error: error.status ? error.message : 'Internal demo error.' });
      else response.end();
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.maxConnections = 64;
  return { server, model };
}

export function configuration(env = process.env) {
  const host = env.HOST || '127.0.0.1';
  const port = env.PORT === undefined ? 8765 : Number(env.PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be 1 to 65535.');
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
  if (!loopback && env.ALLOW_INSECURE_LAN !== '1') throw new Error('LAN HTTP is unsafe. Set ALLOW_INSECURE_LAN=1 only on an isolated trusted LAN.');
  const defaultOrigin = 'http://' + (host === '::1' ? '[::1]' : host) + ':' + port;
  const origin = new URL(env.DEMO_ORIGIN || defaultOrigin);
  if (origin.protocol !== 'http:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || Number(origin.port || 80) !== port) throw new Error('DEMO_ORIGIN must be an exact HTTP origin using PORT.');
  if (!loopback && !env.DEMO_ORIGIN) throw new Error('LAN mode requires DEMO_ORIGIN, the exact browser-facing origin.');
  if (loopback && origin.origin !== new URL(defaultOrigin).origin) throw new Error('Loopback DEMO_ORIGIN must match HOST and PORT.');
  return { host, port, publicOrigin: origin.origin, lan: !loopback };
}

async function start() {
  const config = configuration();
  const { runtime, boundary } = await secureRuntime(root);
  const credentialPath = path.join(runtime, 'owner-credential.txt');
  let ownerCredential;
  try {
    ownerCredential = (await readFile(credentialPath, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(ownerCredential)) throw new Error('Invalid local owner credential file.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    ownerCredential = secret();
    await writeFile(credentialPath, ownerCredential + '\n', { flag: 'wx', mode: 0o600 });
  }
  const { server } = createService({ ownerCredential, publicOrigin: config.publicOrigin });
  server.on('error', error => {
    console.error(error.code === 'EADDRINUSE' ? 'Port already in use. Existing service left untouched.' : 'Server could not start.');
    process.exitCode = 1;
  });
  server.listen(config.port, config.host, () => {
    if (config.lan) console.warn('WARNING: LAN HTTP sends owner, display, and agent credentials in cleartext. Use an isolated trusted LAN, synthetic data only, and no public routing.');
    console.log('Local synthetic display demo: ' + config.publicOrigin);
    console.log('Owner credential file: ' + credentialPath + '. Read privately; do not paste into chat or logs.');
    console.log('Runtime boundary: ' + boundary + '. Local administrators can still take ownership.');
    console.log('PID: ' + process.pid + '. No physical device has been tested.');
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  start().catch(() => { console.error('Startup refused. Check configuration or runtime ACLs. No server started; file mode alone is not Windows privacy.'); process.exitCode = 1; });
}
