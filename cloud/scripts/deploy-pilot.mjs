import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { secureRuntime } from '../../demo/runtime.js';
import { secret } from '../../demo/model.js';
import { toolEnvironment, toolPath } from './run-tool.mjs';
import { waitForHealth } from './health.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const environment = { ...toolEnvironment(), WRANGLER_SEND_METRICS: 'false', CI: 'true' };
let credentials = {};
function run(args) {
  const result = spawnSync(process.execPath, [toolPath('wrangler'), ...args], { cwd: root, env: environment, encoding: 'utf8', timeout: 180000, windowsHide: true });
  let output = (result.stdout || '') + (result.stderr || '');
  for (const value of Object.values(credentials)) output = output.split(value).join('[redacted]');
  process.stdout.write(output);
  if (result.status !== 0) throw new Error('Wrangler failed. Deployment stopped without weakening authentication.');
  return output;
}

try {
  const { runtime } = await secureRuntime(root);
  const credentialPath = path.join(runtime, 'cloud-pilot-secrets.json');
  try { credentials = JSON.parse(await readFile(credentialPath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    credentials = { OWNER_CREDENTIAL: secret(), ENROLLMENT_CODE: secret(), STATE_ENCRYPTION_KEY: secret() };
    await writeFile(credentialPath, JSON.stringify(credentials, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  }
  if (Object.keys(credentials).length !== 3 || ['OWNER_CREDENTIAL', 'ENROLLMENT_CODE', 'STATE_ENCRYPTION_KEY'].some(key => !/^[a-f0-9]{64}$/.test(credentials[key] || ''))) throw new Error('Invalid protected pilot credential file.');
  await import('./build-assets.mjs');
  const output = run(['deploy']);
  const match = /https:\/\/displayos\.[a-z0-9-]+\.workers\.dev\b/.exec(output);
  if (!match) throw new Error('Could not identify the account workers.dev hostname. Initial deployment remains fail-closed.');
  const origin = match[0];
  run(['secret', 'bulk', credentialPath]);
  run(['deploy', '--var', 'PUBLIC_ORIGIN:' + origin]);
  await waitForHealth(origin);
  await writeFile(path.join(runtime, 'cloud-pilot-deployment.json'), JSON.stringify({ origin, verifiedAt: new Date().toISOString(), credentialPath }, null, 2) + '\n', { mode: 0o600 });
  console.log('Live HTTPS health passed: ' + origin + '/display');
  console.log('Owner and enrollment credentials are private in ' + credentialPath + '. Do not paste the file into chat.');
  console.log('Owner claim, approval and tablet rendering still need a deliberate owner walkthrough.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
