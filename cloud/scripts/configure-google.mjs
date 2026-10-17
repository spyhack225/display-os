import { spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { secureRuntime } from '../../demo/runtime.js';
import { toolEnvironment, toolPath } from './run-tool.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const PROJECT = process.env.DISPLAYOS_GCP_PROJECT || 'next-notes-mac';
const SDK = process.env.GOOGLE_CLOUD_SDK || path.win32.join(process.env.LOCALAPPDATA || '', 'Google', 'Cloud SDK', 'google-cloud-sdk');
const WORKER = 'displayos';
const SERVICES = ['weather.googleapis.com', 'places.googleapis.com', 'geocoding-backend.googleapis.com', 'apikeys.googleapis.com'];
const KEYS = [
  { secret: 'GOOGLE_GEOCODING_API_KEY', label: 'displayos-geocoding', service: 'geocoding-backend.googleapis.com' },
  { secret: 'GOOGLE_WEATHER_API_KEY', label: 'displayos-weather', service: 'weather.googleapis.com' },
  { secret: 'GOOGLE_PLACES_API_KEY', label: 'displayos-places', service: 'places.googleapis.com' }
];
const HELP = 'Inspect: node cloud/scripts/configure-google.mjs\nConfigure after approval: add --configure\nLink an existing open billing account: add --enable-billing and, if needed, --billing-account XXXXXX-XXXXXX-XXXXXX\nPublish only the three Google secrets: add --publish\nOnly the project named by DISPLAYOS_GCP_PROJECT (default next-notes-mac) is supported. Confirm the deployed persistent 300/day Google request cap before publication. Billing alerts are not spending caps.\n';

export class GoogleSetupError extends Error {
  constructor(code) { super('Google setup stopped: ' + code + '. No command output or secret values are displayed.'); this.code = code; }
}

function stop(code) { throw new GoogleSetupError(code); }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function only(value, allowed) { return plain(value) && Object.keys(value).every(key => allowed.includes(key)); }
function keyString(value) { return typeof value === 'string' && /^AIza[A-Za-z0-9_-]{30,128}$/.test(value); }
function fingerprint(value) { return createHash('sha256').update(value).digest('hex'); }

export function parseOptions(args) {
  const options = { project: PROJECT, configure: false, enableBilling: false, publish: false, help: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) stop('INVALID_OPTIONS');
    seen.add(flag);
    if (flag === '--configure') options.configure = true;
    else if (flag === '--enable-billing') options.enableBilling = true;
    else if (flag === '--publish') options.publish = true;
    else if (flag === '--help') options.help = true;
    else if (flag === '--project' || flag === '--billing-account') {
      const value = args[++index];
      if (!value || value.startsWith('--')) stop('INVALID_OPTIONS');
      if (flag === '--project') options.project = value;
      else options.billingAccount = value;
    } else stop('INVALID_OPTIONS');
  }
  validateOptions(options);
  return options;
}

function validateOptions(options) {
  if (!only(options, ['project', 'configure', 'enableBilling', 'publish', 'help', 'billingAccount']) || options.project !== PROJECT || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(options.project)) stop('PROJECT_NOT_AUTHORIZED');
  if (['configure', 'enableBilling', 'publish', 'help'].some(key => typeof options[key] !== 'boolean')) stop('INVALID_OPTIONS');
  if ((options.enableBilling || options.publish) && !options.configure || options.billingAccount && !options.enableBilling) stop('CONFIGURE_REQUIRED');
  if (options.billingAccount !== undefined && !/^[A-F0-9]{6}-[A-F0-9]{6}-[A-F0-9]{6}$/.test(options.billingAccount)) stop('INVALID_BILLING_ACCOUNT');
}

export function gcloudCommand(args) {
  return {
    executable: path.win32.join(SDK, 'platform', 'bundledpython', 'python.exe'),
    args: [path.win32.join(SDK, 'lib', 'gcloud.py'), ...args, '--project=' + PROJECT, '--format=json', '--quiet', '--verbosity=error']
  };
}

export async function runGcloud(args, spawn = spawnSync) {
  const command = gcloudCommand(args);
  let result;
  try {
    result = spawn(command.executable, command.args, {
      shell: false, windowsHide: true, encoding: 'utf8', timeout: 300000, maxBuffer: 1048576, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CLOUDSDK_CORE_PROJECT: PROJECT, CLOUDSDK_CORE_LOG_HTTP: 'false', CLOUDSDK_CORE_DISABLE_FILE_LOGGING: 'true', CLOUDSDK_CORE_DISABLE_USAGE_REPORTING: 'true', CLOUDSDK_PAGER: '' }
    });
  } catch { stop('GCLOUD_FAILED'); }
  if (result?.error || result?.status !== 0) {
    if (!result?.error && /\(NOT_FOUND\)|^ERROR:\s+\(gcloud\.services\.api-keys\.describe\)\s+NOT_FOUND:/m.test(result?.stderr || '')) stop('GCLOUD_NOT_FOUND');
    stop('GCLOUD_FAILED');
  }
  if (!result.stdout?.trim()) return null;
  try { return JSON.parse(result.stdout); } catch { stop('GCLOUD_INVALID_RESPONSE'); }
}

async function protectedRuntime() {
  if (process.platform !== 'win32' || !process.env.LOCALAPPDATA || !path.win32.isAbsolute(process.env.LOCALAPPDATA)) stop('WINDOWS_PRIVATE_RUNTIME_REQUIRED');
  return secureRuntime(ROOT, { runtimePath: path.join(process.env.LOCALAPPDATA, 'DisplayOS') });
}

async function privateJson(file, fallback) {
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) stop('INVALID_PRIVATE_FILE');
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    if (error instanceof GoogleSetupError) throw error;
    stop('INVALID_PRIVATE_FILE');
  }
}

async function savePrivate(file, value) {
  const temporary = file + '.' + randomBytes(12).toString('hex') + '.tmp';
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value) + '\n', 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, file);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

function metadataValid(metadata, number) {
  if (!only(metadata, ['version', 'project', 'projectNumber', 'keys']) || metadata.version !== 1 || metadata.project !== PROJECT || metadata.projectNumber !== number || !only(metadata.keys, KEYS.map(key => key.secret))) stop('INVALID_KEY_METADATA');
  for (const target of KEYS) {
    const key = metadata.keys[target.secret];
    if (key === undefined) continue;
    if (!only(key, ['keyId', 'name', 'displayName', 'service', 'status', 'secretHash']) || !new RegExp('^' + target.label + '-[a-f0-9]{24}$').test(key.keyId) || key.name !== 'projects/' + number + '/locations/global/keys/' + key.keyId || key.displayName !== target.label || key.service !== target.service || !['planned', 'ready'].includes(key.status) || key.secretHash !== undefined && !/^[a-f0-9]{64}$/.test(key.secretHash) || key.status === 'ready' && key.secretHash === undefined) stop('INVALID_KEY_METADATA');
  }
}

function validateKey(key, managed, target) {
  const restrictions = key?.restrictions;
  const targets = restrictions?.apiTargets;
  if (!plain(key) || key.name !== managed.name || key.displayName !== target.label || key.deleteTime || !only(restrictions, ['apiTargets']) || !Array.isArray(targets) || targets.length !== 1 || !only(targets[0], ['service', 'methods']) || targets[0].service !== target.service || targets[0].methods !== undefined && (!Array.isArray(targets[0].methods) || targets[0].methods.length)) stop('KEY_RESTRICTIONS_MISMATCH');
}

export async function publishSecrets(file, runtime, spawn = spawnSync, configPath = path.join(ROOT, 'wrangler.json')) {
  const values = await privateJson(file, null);
  if (!only(values, KEYS.map(key => key.secret)) || Object.keys(values).length !== KEYS.length || Object.values(values).some(value => !keyString(value))) stop('INVALID_GOOGLE_SECRETS');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (config.name !== WORKER || !/^[0-9a-f]{32}$/.test(config.account_id || '')) stop('WORKER_NOT_AUTHORIZED');
  let result;
  try {
    result = spawn(process.execPath, [toolPath('wrangler'), 'secret', 'bulk', file, '--config', configPath, '--name', WORKER], {
      shell: false, windowsHide: true, cwd: ROOT, encoding: 'utf8', timeout: 300000, maxBuffer: 1048576, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...toolEnvironment(), CI: 'true', WRANGLER_SEND_METRICS: 'false', WRANGLER_LOG: 'error', WRANGLER_LOG_PATH: path.join(runtime, 'displayos-google-wrangler.log'), CLOUDFLARE_ACCOUNT_ID: config.account_id }
    });
  } catch { stop('PUBLISH_FAILED'); }
  if (result?.error || result?.status !== 0) stop('PUBLISH_FAILED');
}

export async function configureGoogle(options, dependencies = {}) {
  validateOptions(options);
  const gcloud = dependencies.gcloud || runGcloud;
  const prepare = dependencies.prepare || protectedRuntime;
  const publish = dependencies.publish || publishSecrets;
  const project = await gcloud(['projects', 'describe', PROJECT]);
  if (project?.projectId !== PROJECT || project.lifecycleState !== 'ACTIVE' || !/^[0-9]{6,20}$/.test(String(project.projectNumber))) stop('PROJECT_NOT_ACTIVE');
  const number = String(project.projectNumber);
  let billing = await gcloud(['billing', 'projects', 'describe', PROJECT]);
  if (billing?.projectId !== PROJECT || typeof billing.billingEnabled !== 'boolean') stop('INVALID_BILLING_RESPONSE');
  const enabled = await gcloud(['services', 'list', '--enabled']);
  if (!Array.isArray(enabled)) stop('INVALID_SERVICE_RESPONSE');
  const enabledServices = SERVICES.filter(service => enabled.some(entry => entry?.config?.name === service));
  if (!options.configure) return { project: PROJECT, mode: 'inspect', billingEnabled: billing.billingEnabled, enabledServices, configured: false, published: false };
  if (!billing.billingEnabled && !options.enableBilling) stop('BILLING_APPROVAL_REQUIRED');
  const protectedFiles = await prepare();
  const runtime = protectedFiles.runtime;
  if (!path.isAbsolute(runtime)) stop('INVALID_PRIVATE_RUNTIME');
  const secretFile = path.join(runtime, 'displayos-google-secrets.json');
  const metadataFile = path.join(runtime, 'displayos-google-metadata.json');
  const lockFile = path.join(runtime, 'displayos-google-configure.lock');
  let lock;
  try { lock = await open(lockFile, 'wx', 0o600); } catch { stop('CONFIGURATION_LOCKED'); }
  try {
    const metadata = await privateJson(metadataFile, { version: 1, project: PROJECT, projectNumber: number, keys: {} });
    metadataValid(metadata, number);
    const secrets = await privateJson(secretFile, {});
    if (!only(secrets, KEYS.map(key => key.secret)) || Object.values(secrets).some(value => !keyString(value))) stop('INVALID_GOOGLE_SECRETS');
    if (Object.keys(secrets).some(name => !metadata.keys[name])) stop('MISSING_KEY_METADATA');
    billing = await gcloud(['billing', 'projects', 'describe', PROJECT]);
    if (billing?.projectId !== PROJECT || typeof billing.billingEnabled !== 'boolean') stop('INVALID_BILLING_RESPONSE');
    if (!billing.billingEnabled) {
      if (!options.enableBilling) stop('BILLING_APPROVAL_REQUIRED');
      const accounts = await gcloud(['billing', 'accounts', 'list', '--filter=open=true']);
      if (!Array.isArray(accounts)) stop('INVALID_BILLING_RESPONSE');
      const openAccounts = accounts.filter(account => account?.open === true && /^billingAccounts\/[A-F0-9]{6}-[A-F0-9]{6}-[A-F0-9]{6}$/.test(account.name));
      const selected = options.billingAccount ? openAccounts.find(account => account.name === 'billingAccounts/' + options.billingAccount) : openAccounts.length === 1 ? openAccounts[0] : null;
      if (!selected) stop('SELECT_EXISTING_OPEN_BILLING_ACCOUNT');
      await gcloud(['billing', 'projects', 'link', PROJECT, '--billing-account=' + selected.name.slice('billingAccounts/'.length)]);
      billing = await gcloud(['billing', 'projects', 'describe', PROJECT]);
      if (billing?.projectId !== PROJECT || billing.billingEnabled !== true || billing.billingAccountName !== selected.name) stop('BILLING_LINK_NOT_VERIFIED');
    } else if (options.billingAccount && billing.billingAccountName !== 'billingAccounts/' + options.billingAccount) stop('BILLING_ALREADY_LINKED_ELSEWHERE');
    const missing = SERVICES.filter(service => !enabledServices.includes(service));
    if (missing.length) await gcloud(['services', 'enable', ...missing]);
    const verifiedServices = await gcloud(['services', 'list', '--enabled']);
    if (!Array.isArray(verifiedServices) || SERVICES.some(service => !verifiedServices.some(entry => entry?.config?.name === service))) stop('SERVICES_NOT_VERIFIED');
    for (const target of KEYS) {
      let managed = metadata.keys[target.secret];
      if (!managed) {
        const keyId = target.label + '-' + randomBytes(12).toString('hex');
        managed = { keyId, name: 'projects/' + number + '/locations/global/keys/' + keyId, displayName: target.label, service: target.service, status: 'planned' };
        metadata.keys[target.secret] = managed;
        await savePrivate(metadataFile, metadata);
      }
      let key;
      try { key = await gcloud(['services', 'api-keys', 'describe', managed.name]); }
      catch (error) {
        if (!(error instanceof GoogleSetupError) || error.code !== 'GCLOUD_NOT_FOUND' || managed.status !== 'planned') throw error;
        await gcloud(['services', 'api-keys', 'create', '--display-name=' + target.label, '--key-id=' + managed.keyId, '--api-target=service=' + target.service]);
        key = await gcloud(['services', 'api-keys', 'describe', managed.name]);
      }
      validateKey(key, managed, target);
      if (!secrets[target.secret] || managed.secretHash !== fingerprint(secrets[target.secret])) {
        const result = await gcloud(['services', 'api-keys', 'get-key-string', managed.name]);
        if (!keyString(result?.keyString)) stop('INVALID_KEY_STRING');
        secrets[target.secret] = result.keyString;
        await savePrivate(secretFile, secrets);
      }
      managed.status = 'ready';
      managed.secretHash = fingerprint(secrets[target.secret]);
      await savePrivate(metadataFile, metadata);
    }
    await prepare();
    if (options.publish) await publish(secretFile, runtime);
    return { project: PROJECT, mode: 'configure', billingEnabled: true, enabledServices: SERVICES, configured: true, published: options.publish, managedKeys: KEYS.map(key => key.label), serverOnly: true, applicationIpRestriction: false, requestCapVerifiedByThisScript: false };
  } finally {
    await lock.close();
    await unlink(lockFile);
  }
}

export async function main(args = process.argv.slice(2), dependencies = {}) {
  const output = dependencies.output || (value => process.stdout.write(value));
  const errorOutput = dependencies.errorOutput || (value => process.stderr.write(value));
  try {
    const options = parseOptions(args);
    if (options.help) { output(HELP); return 0; }
    const result = await configureGoogle(options, dependencies);
    output(JSON.stringify(result) + '\n');
    return 0;
  } catch (error) {
    errorOutput((error instanceof GoogleSetupError ? error.message : 'Google setup failed. Raw command output and secret values are suppressed.') + '\n');
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main();
