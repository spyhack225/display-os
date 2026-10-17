import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { secureRuntime } = await import('../demo/runtime.js');
const origin = 'http://127.0.0.1:8765';
const [deviceId, code, sessionId] = process.argv.slice(2);
assert.match(deviceId || '', /^[a-f0-9]{24}$/);
assert.match(code || '', /^[A-F0-9]{12}$/);
assert.match(sessionId || '', /^[a-f0-9]{32}$/);
const { runtime } = await secureRuntime(path.join(workspace, 'demo'));
const credential = (await readFile(path.join(runtime, 'owner-credential.txt'), 'utf8')).trim();
let cookie = '';
let csrfToken = '';

async function owner(method, route, body) {
  const response = await fetch(origin + route, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Demo-Request': '1', Cookie: cookie, 'X-CSRF-Token': csrfToken },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000)
  });
  assert.equal(response.ok, true, 'QA owner request rejected: ' + route);
  if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
  return response.json();
}

csrfToken = (await owner('POST', '/api/owner/login', { credential })).csrfToken;
let child;
let grantId;
try {
  const claimed = await owner('POST', '/api/owner/claim', { code, sessionId });
  assert.equal(claimed.deviceId, deviceId);
  assert.equal(claimed.agentAccess, false);
  console.log('QA ONLY: disposable desktop display claimed by automated test owner. No real customer onboarding or tablet proof.');
  child = spawn(process.execPath, ['scripts/agent-client.js', 'run', deviceId], { cwd: path.join(workspace, 'demo'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', chunk => process.stdout.write(chunk));
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  const finished = new Promise(resolve => {
    child.on('error', error => resolve({ error }));
    child.on('exit', exitCode => resolve({ exitCode }));
  });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const state = await owner('GET', '/api/owner/state');
    const pending = state.requests.find(request => request.deviceId === deviceId && request.label === 'Codex local HTTP tool client');
    if (pending) {
      const approved = await owner('POST', '/api/owner/requests/' + pending.requestId + '/approve', { approved: true });
      grantId = approved.grantId;
      console.log('QA ONLY: test owner separately approved this synthetic display grant.');
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert.ok(grantId, 'No QA agent request observed');
  const outcome = await finished;
  if (outcome.error) throw outcome.error;
  assert.equal(outcome.exitCode, 0, 'CLI failed');
  const state = await owner('GET', '/api/owner/state');
  const device = state.devices.find(entry => entry.deviceId === deviceId);
  console.log('PASS desktop client receipt and separate-process publish. Owner view: ' + JSON.stringify(device));
} finally {
  if (child && child.exitCode === null) child.kill();
  try {
    if (grantId) {
      await owner('POST', '/api/owner/grants/' + grantId + '/revoke', {});
      console.log('QA grant revoked. Content remains until its expiry.');
    }
  } finally {
    await owner('POST', '/api/owner/logout', {});
    console.log('QA owner session logged out.');
  }
}
