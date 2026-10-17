import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { secret } from '../model.js';
import { secureRuntime } from '../runtime.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let statePath;
const origin = 'http://127.0.0.1:' + (process.env.PORT || '8765');
const command = process.argv[2];

async function call(method, route, body, token, key) {
  const headers = {};
  if (method === 'POST') { headers['Content-Type'] = 'application/json'; headers['X-Demo-Request'] = '1'; }
  if (token) headers.Authorization = 'Bearer ' + token;
  if (key) headers['Idempotency-Key'] = key;
  const response = await fetch(origin + route, { method, headers, body: method === 'POST' ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request rejected.');
  return result;
}

async function save(state) {
  await writeFile(statePath, JSON.stringify(state) + '\n', { mode: 0o600 });
}

async function run() {
  if (command === 'run') {
    const deviceId = process.argv[3];
    if (!/^[a-f0-9]{24}$/.test(deviceId || '')) throw new Error('Supply the claimed display ID.');
    const request = await call('POST', '/api/agent/requests', { deviceId, label: 'Codex local HTTP tool client', scopes: ['display:read', 'content:write'], ttlSeconds: 900 });
    console.log('Pending request ' + request.requestId + ' for display ' + deviceId + '. Owner must approve at /setup. Credentials stay in this process memory.');
    let grant;
    while (Date.now() < request.expiresAt) {
      const result = await call('GET', '/api/agent/requests/' + request.requestId, null, request.requestToken);
      if (result.status === 'approved') { grant = result; break; }
      if (result.status !== 'pending') throw new Error('Agent request is ' + result.status + '.');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!grant) throw new Error('Owner did not approve before request expiration.');
    console.log('Owner separately approved the scoped grant.');
    const capabilities = await call('GET', '/api/agent/devices/' + deviceId + '/capabilities', null, grant.grantToken);
    const body = { expectedRevision: capabilities.revision, ttlSeconds: 600, cards: [{ title: 'A signal from the local Codex client', text: 'Synthetic content published through the scoped HTTP API by a separate process. Waiting for the display client render receipt.' }] };
    const published = await call('POST', '/api/agent/devices/' + deviceId + '/content', body, grant.grantToken, 'codex_' + secret(12));
    console.log('Revision ' + published.revision + ': ' + published.status + '.');
    const deadline = Math.min(grant.expiresAt, Date.now() + 60000);
    let previous = '';
    while (Date.now() < deadline) {
      const result = await call('GET', '/api/agent/devices/' + deviceId + '/revisions/' + published.revision, null, grant.grantToken);
      if (result.status !== previous) console.log('Revision ' + result.revision + ': ' + result.status + '.');
      previous = result.status;
      if (result.status === 'rendered') return;
      if (result.status === 'expired') throw new Error('Content expired before a client render receipt.');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('No client render receipt within 60 seconds. Publishing is not proof of rendering.');
  }
  try {
    const protectedRuntime = await secureRuntime(root);
    statePath = path.join(protectedRuntime.runtime, 'agent-client.json');
  } catch { throw new Error('Runtime ACL protection failed. No credentials read or written. Use run for a memory-only client, not to bypass server protection.'); }
  if (command === 'request') {
    const deviceId = process.argv[3];
    if (!/^[a-f0-9]{24}$/.test(deviceId || '')) throw new Error('Supply the claimed display ID, not a pairing or owner secret.');
    const request = await call('POST', '/api/agent/requests', { deviceId, label: 'Codex local HTTP tool client', scopes: ['display:read', 'content:write'], ttlSeconds: 900 });
    await save({ ...request, deviceId, origin });
    console.log('Pending request ' + request.requestId + ' for display ' + deviceId + '. Owner must approve it at /setup. No display access yet.');
    return;
  }
  if (!['check', 'publish', 'status'].includes(command)) throw new Error('Usage: node scripts/agent-client.js run DISPLAY_ID | request DISPLAY_ID | check | publish | status');
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  if (state.origin !== origin) throw new Error('Saved client belongs to a different local origin.');
  if (command === 'check') {
    const result = await call('GET', '/api/agent/requests/' + state.requestId, null, state.requestToken);
    if (result.status === 'approved') { state.grantToken = result.grantToken; state.expiresAt = result.expiresAt; state.grantId = result.grantId; await save(state); }
    console.log('Request status: ' + result.status + '. No credentials printed.');
    return;
  }
  if (!state.grantToken) throw new Error('No grant saved. Owner must approve, then run check.');
  if (command === 'publish') {
    if (!state.pendingPublish) {
      const capabilities = await call('GET', '/api/agent/devices/' + state.deviceId + '/capabilities', null, state.grantToken);
      state.pendingPublish = {
        key: 'codex_' + secret(12), body: { expectedRevision: capabilities.revision, ttlSeconds: 600, cards: [{ title: 'A signal from the local Codex client', text: 'Synthetic content published through the scoped HTTP API. Owner claim and agent approval were separate. The display must send its own render receipt.' }] }
      };
      await save(state);
    }
    const result = await call('POST', '/api/agent/devices/' + state.deviceId + '/content', state.pendingPublish.body, state.grantToken, state.pendingPublish.key);
    state.revision = result.revision; delete state.pendingPublish; await save(state);
    console.log('Revision ' + result.revision + ': ' + result.status + '. Run status after the display polls and renders.');
    return;
  }
  if (!state.revision) throw new Error('Publish a revision first.');
  const result = await call('GET', '/api/agent/devices/' + state.deviceId + '/revisions/' + state.revision, null, state.grantToken);
  console.log(JSON.stringify(result));
}

run().catch(error => {
  console.error(error.code === 'ENOENT' ? 'No local agent state. Run request after the owner claims a display.' : error.message);
  process.exitCode = 1;
});
