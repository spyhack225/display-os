import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { secureRuntime } from '../../demo/runtime.js';
import { secret } from '../../demo/model.js';
import { toolEnvironment, toolPath } from './run-tool.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(await readFile(new URL('../wrangler.json', import.meta.url), 'utf8'));
const { runtime } = await secureRuntime(root);
const credentialPath = path.join(runtime, 'displayos-product-secrets.json');
let credentials;
try { credentials = JSON.parse(await readFile(credentialPath, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  credentials = { PRODUCT_STATE_KEY: secret(), FACTORY_CREDENTIAL: secret() };
  await writeFile(credentialPath, JSON.stringify(credentials) + '\n', { flag: 'wx', mode: 0o600 });
}
if (Object.keys(credentials).length !== 2 || Object.values(credentials).some(value => !/^[a-f0-9]{64}$/.test(value))) throw new Error('Invalid protected product configuration.');

let published = false;
function run(args, timeout = 300000) {
  const result = spawnSync(process.execPath, args, { cwd: root, env: { ...toolEnvironment(), WRANGLER_SEND_METRICS: 'false', CI: 'true', DISPLAYOS_UI_AUTH_ONLY: '0', DISPLAYOS_UI_IDENTIFIER_ONLY: '0', DISPLAYOS_UI_LOCATION_ONLY: '0', DISPLAYOS_UI_STANDBY_ONLY: '0', DISPLAYOS_UI_BUNDLE: '.wrangler/bundle/worker.js' }, windowsHide: true, encoding: 'utf8', timeout });
  let output = (result.stdout || '') + (result.stderr || '');
  for (const value of Object.values(credentials)) output = output.split(value).join('[redacted]');
  process.stdout.write(output);
  if (result.status !== 0) throw new Error(published ? 'Live verification failed after publication. Do not mark the release complete.' : 'Release gate failed. Publication stopped.');
  return output;
}

run(['--test', 'test/*.test.js']);
run(['scripts/build-assets.mjs']);
run([toolPath('wrangler'), 'deploy', '--dry-run', '--outdir', '.wrangler/bundle']);
run(['scripts/verify-product-runtime.mjs']);
run(['scripts/verify-product-provider-races.mjs']);
run(['scripts/verify-product-ui.mjs'], 600000);
run([toolPath('wrangler'), 'secret', 'bulk', credentialPath]);
const deploymentOutput = run([toolPath('wrangler'), 'deploy']);
published = true;
const version = /Current Version ID: ([a-f0-9-]{36})/.exec(deploymentOutput)?.[1];
if (!version) throw new Error('Published, but the deployment version could not be recorded. Verify Cloudflare before completion.');
for (const route of ['/welcome', '/home', '/screen', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp']) {
  const response = await fetch(config.vars.PUBLIC_ORIGIN + route, { signal: AbortSignal.timeout(15000), redirect: 'manual' });
  if (response.status !== 200 || response.headers.get('x-content-type-options') !== 'nosniff') throw new Error('Live release check failed: ' + route);
}
run(['scripts/verify-product-live.mjs']);
await writeFile(path.join(runtime, 'displayos-product-deployment.json'), JSON.stringify({ origin: config.vars.PUBLIC_ORIGIN, version, verifiedAt: new Date().toISOString(), gates: ['unit', 'workerd', 'browser', 'live-https'], hardwareVerified: false, providerConsentVerified: false }) + '\n', { mode: 0o600 });
console.log('DisplayOS software deployed. Physical hardware and real provider consent remain separate gates.');
