import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { secureRuntime } from '../../demo/runtime.js';
import { waitForHealth } from './health.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(await readFile(new URL('../wrangler.json', import.meta.url), 'utf8'));
const origin = config.vars.PUBLIC_ORIGIN;
let checks = 0;
function check(actual, expected) { assert.equal(actual, expected); checks++; }
async function call(route, value, extra = {}) {
  const headers = { ...extra };
  if (value !== undefined) { headers['Content-Type'] = 'application/json'; headers['X-Demo-Request'] = '1'; }
  return fetch(origin + route, { method: value === undefined ? 'GET' : 'POST', headers, body: value === undefined ? undefined : JSON.stringify(value), redirect: 'manual', signal: AbortSignal.timeout(10000) });
}

await waitForHealth(origin);
check((await call('/api/health')).status, 200);
for (const route of ['/pilot/display', '/pilot/setup', '/agent', '/operator', '/app.js', '/owner.js', '/style.css', '/pilot/skill.md', '/api-contract.json']) {
  const response = await call(route);
  check(response.status, 200);
  check(response.headers.get('cache-control'), 'no-store');
  check(response.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(response.headers.get('content-security-policy').includes("img-src 'none'")); checks++;
}
check((await call('/setup.html')).status, 404);
check((await call('/api/owner/state')).status, 401);
check((await call('/api/displays', { name: 'Unauthorized synthetic probe' })).status, 401);
check((await call('/api/health?token=not-a-secret')).status, 400);
check((await call('/api/health', undefined, { Origin: 'https://wrong.example.com' })).status, 403);
check((await call('/api/owner/login', { credential: 'not-a-credential' })).status, 403);
check((await call('/api/owner/login', { credential: 'not-a-credential' }, { Origin: origin })).status, 401);
const contract = await (await call('/api-contract.json')).json();
check(contract.service, 'displayos-cloud');
assert.ok(contract.authentication.owner.includes('__Host-desk_owner')); checks++;
const { runtime } = await secureRuntime(root);
const credentialPath = path.join(runtime, 'cloud-pilot-secrets.json');
const credentials = JSON.parse(await readFile(credentialPath, 'utf8'));
const login = await call('/api/owner/login', { credential: credentials.OWNER_CREDENTIAL }, { Origin: origin });
check(login.status, 200);
const cookie = login.headers.get('set-cookie');
for (const flag of ['Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/']) { assert.ok(cookie.includes(flag)); checks++; }
const auth = { Cookie: cookie.split(';')[0], Origin: origin };
const session = await login.json();
try {
  const state = await call('/api/owner/state', undefined, auth);
  check(state.status, 200);
  const visible = await state.json();
  assert.ok(!JSON.stringify(visible).includes(credentials.OWNER_CREDENTIAL)); checks++;
  check((await call('/api/owner/logout', {}, auth)).status, 403);
} finally {
  const logout = await call('/api/owner/logout', {}, { ...auth, 'X-CSRF-Token': session.csrfToken });
  check(logout.status, 200);
}
check((await call('/api/owner/state', undefined, auth)).status, 401);
await writeFile(path.join(runtime, 'cloud-pilot-deployment.json'), JSON.stringify({ origin, verifiedAt: new Date().toISOString(), credentialPath, liveChecks: checks }, null, 2) + '\n', { mode: 0o600 });
console.log(checks + ' retained-pilot live HTTPS checks passed at ' + origin + '. Secrets stayed in memory or protected files.');
console.log('No display enrolled, owner claim, grant approval or render ACK was automated on the live pilot.');
