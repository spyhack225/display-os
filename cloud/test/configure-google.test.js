import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PROJECT, parseOptions, gcloudCommand, runGcloud, configureGoogle, publishSecrets, main, GoogleSetupError } from '../scripts/configure-google.mjs';

const NUMBER = '123456789012';
const BILLING = 'ABCDEF-123456-ABC123';
const SECRET = 'AIza' + 's'.repeat(35);
const SERVICES = ['weather.googleapis.com', 'places.googleapis.com', 'geocoding-backend.googleapis.com', 'apikeys.googleapis.com'];
const SECRET_NAMES = ['GOOGLE_GEOCODING_API_KEY', 'GOOGLE_WEATHER_API_KEY', 'GOOGLE_PLACES_API_KEY'];

async function fixture(testcase, options = {}) {
  const parent = path.resolve(os.tmpdir());
  const runtime = await mkdtemp(path.join(parent, 'displayos-google-fixture-'));
  testcase.after(async () => {
    const relative = path.relative(parent, path.resolve(runtime));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    await rm(runtime, { recursive: true, force: true });
  });
  const calls = [];
  const enabled = new Set(options.enabled || []);
  const keys = new Map();
  const state = {
    billingEnabled: options.billingEnabled ?? true, billingAccountName: 'billingAccounts/' + BILLING,
    accounts: options.accounts || [{ name: 'billingAccounts/' + BILLING, open: true }],
    prepareCalls: 0, publishCalls: 0, failAfterCreate: false, mutateKey: null, getKeyCount: 0
  };
  const dependencies = {
    async prepare() { state.prepareCalls++; return { runtime, boundary: 'synthetic fixture only' }; },
    async publish(file, suppliedRuntime) {
      state.publishCalls++;
      assert.equal(suppliedRuntime, runtime);
      assert.equal(file, path.join(runtime, 'displayos-google-secrets.json'));
      assert.deepEqual(Object.keys(JSON.parse(await readFile(file, 'utf8'))).sort(), [...SECRET_NAMES].sort());
    },
    async gcloud(args) {
      calls.push([...args]);
      const verb = args.slice(0, 3).join(' ');
      if (args[0] === 'projects') return { projectId: PROJECT, projectNumber: NUMBER, lifecycleState: 'ACTIVE', name: 'DisplayOS', keyString: SECRET };
      if (verb === 'billing projects describe') return { projectId: PROJECT, billingEnabled: state.billingEnabled, billingAccountName: state.billingAccountName };
      if (verb === 'billing accounts list') return structuredClone(state.accounts);
      if (verb === 'billing projects link') { state.billingEnabled = true; state.billingAccountName = 'billingAccounts/' + args[4].split('=')[1]; return {}; }
      if (args[0] === 'services' && args[1] === 'list') return [...enabled].map(name => ({ config: { name } }));
      if (args[0] === 'services' && args[1] === 'enable') { args.slice(2).forEach(service => enabled.add(service)); return null; }
      if (verb === 'services api-keys describe') {
        if (!keys.has(args[3])) throw new GoogleSetupError('GCLOUD_NOT_FOUND');
        const value = structuredClone(keys.get(args[3]));
        return state.mutateKey ? state.mutateKey(value) : value;
      }
      if (verb === 'services api-keys create') {
        const label = args.find(value => value.startsWith('--display-name=')).slice('--display-name='.length);
        const id = args.find(value => value.startsWith('--key-id=')).slice('--key-id='.length);
        const service = args.find(value => value.startsWith('--api-target=service=')).slice('--api-target=service='.length);
        const name = 'projects/' + NUMBER + '/locations/global/keys/' + id;
        assert.equal(keys.has(name), false, 'must not duplicate or rotate a key');
        const value = { name, displayName: label, restrictions: { apiTargets: [{ service }] }, keyString: SECRET };
        keys.set(name, value);
        if (state.failAfterCreate) { state.failAfterCreate = false; throw new Error('lost reply with ' + SECRET); }
        return value;
      }
      if (verb === 'services api-keys get-key-string') {
        assert.ok(keys.has(args[3]), 'only recorded managed keys may be fetched');
        state.getKeyCount++;
        return { keyString: SECRET };
      }
      throw new Error('Unexpected fixture command ' + args.join(' '));
    }
  };
  return { runtime, calls, enabled, keys, state, dependencies };
}

test('default inspection is read-only, fixed to DisplayOS and does not touch local credentials or billing accounts', async testcase => {
  const setup = await fixture(testcase, { billingEnabled: false, enabled: ['weather.googleapis.com', 'unrelated.googleapis.com'] });
  const result = await configureGoogle(parseOptions([]), setup.dependencies);
  assert.deepEqual(result, { project: PROJECT, mode: 'inspect', billingEnabled: false, enabledServices: ['weather.googleapis.com'], configured: false, published: false });
  assert.deepEqual(setup.calls.map(args => args.slice(0, 3).join(' ')), ['projects describe ' + PROJECT, 'billing projects describe', 'services list --enabled']);
  assert.equal(setup.state.prepareCalls, 0);
  assert.equal(setup.state.publishCalls, 0);
  assert.deepEqual(await readdir(setup.runtime), []);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
});

test('flag grammar prevents shell injection, unauthorized projects, duplicate options and implicit mutation', async () => {
  for (const args of [
    ['--project', 'another-valid-project'], ['--project', PROJECT + '&whoami'], ['--project', PROJECT + '\n'],
    ['--enable-billing'], ['--publish'], ['--billing-account', BILLING], ['--configure', '--configure'],
    ['--configure', '--enable-billing', '--billing-account', BILLING + '&whoami'], ['--configure', '--enable-billing', '--billing-account'],
    ['--gcloud', 'cmd.exe'], ['--runtime', 'E:\\public'], ['--configure', '--rotate']
  ]) assert.throws(() => parseOptions(args), GoogleSetupError);
  assert.equal(parseOptions(['--project', PROJECT]).configure, false);
  assert.equal(parseOptions(['--configure', '--enable-billing', '--billing-account', BILLING, '--publish']).billingAccount, BILLING);
});

test('native gcloud invocation bypasses cmd, pins project and suppresses child output and gcloud file logs', async () => {
  const command = gcloudCommand(['services', 'list', '--enabled']);
  assert.ok(path.win32.isAbsolute(command.executable));
  assert.match(command.executable, /bundledpython\\python\.exe$/);
  assert.match(command.args[0], /google-cloud-sdk\\lib\\gcloud\.py$/);
  assert.equal(command.args.includes('--project=' + PROJECT), true);
  await runGcloud(['projects', 'describe', PROJECT], (executable, args, options) => {
    assert.equal(executable, command.executable);
    assert.equal(args.includes('--format=json'), true);
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(options.env.CLOUDSDK_CORE_LOG_HTTP, 'false');
    assert.equal(options.env.CLOUDSDK_CORE_DISABLE_FILE_LOGGING, 'true');
    assert.equal(options.env.CLOUDSDK_CORE_PROJECT, PROJECT);
    return { status: 0, stdout: '{}', stderr: SECRET };
  });
  assert.equal(await runGcloud(['services', 'enable', ...SERVICES], () => ({ status: 0, stdout: '', stderr: SECRET })), null);
});

test('failed or malformed CLI responses never disclose stdout, stderr, exception details or keys', async () => {
  for (const result of [{ status: 1, stdout: SECRET, stderr: SECRET }, { status: 0, stdout: SECRET }, { status: 1, error: new Error(SECRET) }]) {
    await assert.rejects(runGcloud(['services', 'list'], () => result), error => error instanceof GoogleSetupError && !error.message.includes(SECRET));
  }
  await assert.rejects(runGcloud(['services', 'list'], () => { throw new Error(SECRET); }), error => !error.message.includes(SECRET));
  await assert.rejects(runGcloud(['services', 'api-keys', 'describe', 'managed'], () => ({ status: 1, stderr: '(NOT_FOUND) ' + SECRET })), { code: 'GCLOUD_NOT_FOUND' });
});

test('configure requires enabled billing before API or key mutation', async testcase => {
  const setup = await fixture(testcase, { billingEnabled: false });
  await assert.rejects(configureGoogle(parseOptions(['--configure']), setup.dependencies), { code: 'BILLING_APPROVAL_REQUIRED' });
  assert.equal(setup.calls.some(args => ['link', 'enable', 'create'].includes(args[2]) || args[1] === 'enable'), false);
  assert.equal(setup.state.prepareCalls, 0);
});

test('real gcloud missing-key diagnostics permit planned creation without mistaking permission failures for missing keys', async () => {
  const args = ['services', 'api-keys', 'describe', 'managed'];
  await assert.rejects(runGcloud(args, () => ({ status: 1, stderr: 'ERROR: (gcloud.services.api-keys.describe) NOT_FOUND: Requested entity was not found. ' + SECRET })), { code: 'GCLOUD_NOT_FOUND' });
  for (const stderr of ['ERROR: (gcloud.services.api-keys.describe) PERMISSION_DENIED: ' + SECRET, 'ERROR: (gcloud.services.api-keys.describe) INVALID_ARGUMENT: NOT_FOUND appears in a supplied value.']) {
    await assert.rejects(runGcloud(args, () => ({ status: 1, stderr })), error => error.code === 'GCLOUD_FAILED' && !error.message.includes(SECRET));
  }
});

test('billing linkage requires exactly one existing open account or an explicit matching account', async testcase => {
  const setup = await fixture(testcase, { billingEnabled: false });
  await configureGoogle(parseOptions(['--configure', '--enable-billing']), setup.dependencies);
  const link = setup.calls.find(args => args.slice(0, 3).join(' ') === 'billing projects link');
  assert.deepEqual(link, ['billing', 'projects', 'link', PROJECT, '--billing-account=' + BILLING]);
  assert.equal(setup.calls.findIndex(args => args[1] === 'enable') > setup.calls.indexOf(link), true);
  assert.equal(setup.state.publishCalls, 0);
  const accounts = [{ name: 'billingAccounts/' + BILLING, open: true }, { name: 'billingAccounts/AAAAAA-BBBBBB-CCCCCC', open: true }];
  const selected = await fixture(testcase, { billingEnabled: false, accounts });
  await configureGoogle(parseOptions(['--configure', '--enable-billing', '--billing-account', BILLING]), selected.dependencies);
  assert.equal(selected.state.billingAccountName, 'billingAccounts/' + BILLING);
});

test('zero, multiple, closed or foreign billing selections stop without billing/API/key mutation', async testcase => {
  for (const accounts of [[], [{ name: 'billingAccounts/' + BILLING, open: false }], [{ name: 'billingAccounts/' + BILLING, open: true }, { name: 'billingAccounts/AAAAAA-BBBBBB-CCCCCC', open: true }]]) {
    const setup = await fixture(testcase, { billingEnabled: false, accounts });
    await assert.rejects(configureGoogle(parseOptions(['--configure', '--enable-billing']), setup.dependencies), { code: 'SELECT_EXISTING_OPEN_BILLING_ACCOUNT' });
    assert.equal(setup.calls.some(args => args.slice(0, 3).join(' ') === 'billing projects link' || args[1] === 'enable' || args[2] === 'create'), false);
  }
  const foreign = await fixture(testcase, { billingEnabled: false });
  await assert.rejects(configureGoogle(parseOptions(['--configure', '--enable-billing', '--billing-account', 'AAAAAA-BBBBBB-CCCCCC']), foreign.dependencies), { code: 'SELECT_EXISTING_OPEN_BILLING_ACCOUNT' });
  const linked = await fixture(testcase);
  await assert.rejects(configureGoogle(parseOptions(['--configure', '--enable-billing', '--billing-account', 'AAAAAA-BBBBBB-CCCCCC']), linked.dependencies), { code: 'BILLING_ALREADY_LINKED_ELSEWHERE' });
});

test('configuration enables exactly four services and creates three separate single-API restricted server keys', async testcase => {
  const setup = await fixture(testcase);
  const result = await configureGoogle(parseOptions(['--configure']), setup.dependencies);
  assert.deepEqual(setup.calls.find(args => args[1] === 'enable'), ['services', 'enable', ...SERVICES]);
  const creates = setup.calls.filter(args => args[2] === 'create');
  assert.equal(creates.length, 3);
  for (const args of creates) {
    assert.equal(args.filter(arg => arg.startsWith('--api-target=')).length, 1);
    assert.equal(args.some(arg => arg.startsWith('--allowed-') || arg.startsWith('--service-account=')), false);
    assert.match(args.find(arg => arg.startsWith('--key-id=')), /^--key-id=displayos-(geocoding|weather|places)-[a-f0-9]{24}$/);
  }
  assert.equal(setup.calls.some(args => args[1] === 'api-keys' && ['list', 'update', 'delete'].includes(args[2])), false);
  assert.deepEqual(Object.keys(JSON.parse(await readFile(path.join(setup.runtime, 'displayos-google-secrets.json'), 'utf8'))).sort(), [...SECRET_NAMES].sort());
  const metadata = JSON.parse(await readFile(path.join(setup.runtime, 'displayos-google-metadata.json'), 'utf8'));
  assert.equal(metadata.project, PROJECT);
  assert.equal(metadata.projectNumber, NUMBER);
  assert.equal(Object.values(metadata.keys).every(key => key.status === 'ready' && /^[a-f0-9]{64}$/.test(key.secretHash)), true);
  assert.equal(result.configured, true);
  assert.equal(result.published, false);
  assert.equal(result.requestCapVerifiedByThisScript, false);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(setup.state.prepareCalls, 2);
});

test('repeated configure reuses only its protected metadata, never re-enables or rotates/fetches unrelated keys', async testcase => {
  const setup = await fixture(testcase);
  await configureGoogle(parseOptions(['--configure']), setup.dependencies);
  const initial = JSON.parse(await readFile(path.join(setup.runtime, 'displayos-google-metadata.json'), 'utf8'));
  setup.calls.length = 0;
  setup.state.getKeyCount = 0;
  await configureGoogle(parseOptions(['--configure']), setup.dependencies);
  assert.equal(setup.calls.some(args => args[1] === 'enable' || args[2] === 'create' || args[2] === 'list' && args[1] === 'api-keys'), false);
  assert.equal(setup.state.getKeyCount, 0);
  assert.deepEqual(JSON.parse(await readFile(path.join(setup.runtime, 'displayos-google-metadata.json'), 'utf8')), initial);
  assert.equal(setup.keys.size, 3);
});

test('lost key-create reply leaves a protected intent and retry recovers the same key without duplication', async testcase => {
  const setup = await fixture(testcase);
  setup.state.failAfterCreate = true;
  await assert.rejects(configureGoogle(parseOptions(['--configure']), setup.dependencies));
  const journal = JSON.parse(await readFile(path.join(setup.runtime, 'displayos-google-metadata.json'), 'utf8'));
  assert.equal(journal.keys.GOOGLE_GEOCODING_API_KEY.status, 'planned');
  assert.equal(setup.keys.size, 1);
  const firstName = journal.keys.GOOGLE_GEOCODING_API_KEY.name;
  await configureGoogle(parseOptions(['--configure']), setup.dependencies);
  assert.equal(setup.keys.size, 3);
  assert.equal(JSON.parse(await readFile(path.join(setup.runtime, 'displayos-google-metadata.json'), 'utf8')).keys.GOOGLE_GEOCODING_API_KEY.name, firstName);
});

test('ready keys missing remotely fail closed rather than rotating or replacing credentials', async testcase => {
  const setup = await fixture(testcase);
  await configureGoogle(parseOptions(['--configure']), setup.dependencies);
  setup.keys.clear(); setup.calls.length = 0;
  await assert.rejects(configureGoogle(parseOptions(['--configure']), setup.dependencies), { code: 'GCLOUD_NOT_FOUND' });
  assert.equal(setup.calls.some(args => args[2] === 'create'), false);
});

test('wrong restrictions, label, resource, application constraints or deleted keys stop before key-string fetch/publish', async testcase => {
  for (const mutate of [
    key => ({ ...key, name: key.name.replace(NUMBER, '999999999999') }),
    key => ({ ...key, displayName: 'other-app' }),
    key => ({ ...key, deleteTime: '2026-10-10T00:00:00Z' }),
    key => ({ ...key, restrictions: {} }),
    key => ({ ...key, restrictions: { apiTargets: [{ service: 'wrong.googleapis.com' }] } }),
    key => ({ ...key, restrictions: { apiTargets: [...key.restrictions.apiTargets, { service: 'another.googleapis.com' }] } }),
    key => ({ ...key, restrictions: { ...key.restrictions, serverKeyRestrictions: { allowedIps: ['1.2.3.4'] } } }),
    key => ({ ...key, restrictions: { apiTargets: [{ ...key.restrictions.apiTargets[0], methods: ['restricted'] }] } })
  ]) {
    const setup = await fixture(testcase); setup.state.mutateKey = mutate;
    await assert.rejects(configureGoogle(parseOptions(['--configure', '--publish']), setup.dependencies), { code: 'KEY_RESTRICTIONS_MISMATCH' });
    assert.equal(setup.state.getKeyCount, 0);
    assert.equal(setup.state.publishCalls, 0);
  }
});

test('foreign metadata and extra private secrets cannot be adopted or published', async testcase => {
  for (const type of ['metadata', 'secrets']) {
    const setup = await fixture(testcase);
    if (type === 'metadata') await writeFile(path.join(setup.runtime, 'displayos-google-metadata.json'), JSON.stringify({ version: 1, project: 'another-project', projectNumber: NUMBER, keys: {} }));
    else await writeFile(path.join(setup.runtime, 'displayos-google-secrets.json'), JSON.stringify({ PRODUCT_STATE_KEY: SECRET }));
    await assert.rejects(configureGoogle(parseOptions(['--configure', '--publish']), setup.dependencies), GoogleSetupError);
    assert.equal(setup.calls.some(args => args[1] === 'enable' || args[2] === 'create'), false);
    assert.equal(setup.state.publishCalls, 0);
  }
});

test('existing credentials without their ownership metadata fail closed instead of silently rotating keys', async testcase => {
  const setup = await fixture(testcase, { billingEnabled: false });
  await writeFile(path.join(setup.runtime, 'displayos-google-secrets.json'), JSON.stringify({ GOOGLE_WEATHER_API_KEY: SECRET }));
  await assert.rejects(configureGoogle(parseOptions(['--configure', '--enable-billing']), setup.dependencies), { code: 'MISSING_KEY_METADATA' });
  assert.equal(setup.calls.some(args => args[2] === 'link' || args[1] === 'enable' || args[2] === 'create'), false);
  assert.equal(setup.keys.size, 0);
});

test('simultaneous operators stop at the private lock without changing API keys', async testcase => {
  const setup = await fixture(testcase);
  await writeFile(path.join(setup.runtime, 'displayos-google-configure.lock'), 'another invocation');
  await assert.rejects(configureGoogle(parseOptions(['--configure']), setup.dependencies), { code: 'CONFIGURATION_LOCKED' });
  assert.equal(setup.keys.size, 0);
  assert.equal(await readFile(path.join(setup.runtime, 'displayos-google-configure.lock'), 'utf8'), 'another invocation');
});

test('publish is explicit and uploads only the protected three-key JSON after local preparation verification', async testcase => {
  const setup = await fixture(testcase);
  await configureGoogle(parseOptions(['--configure']), setup.dependencies);
  assert.equal(setup.state.publishCalls, 0);
  await configureGoogle(parseOptions(['--configure', '--publish']), setup.dependencies);
  assert.equal(setup.state.publishCalls, 1);
  assert.equal(setup.state.prepareCalls, 4);
  assert.equal((await readdir(setup.runtime)).some(file => file.endsWith('.lock') || file.endsWith('.tmp')), false);
});

test('native publication sends a private file path, never key values, to only the configured existing Worker', async testcase => {
  const setup = await fixture(testcase);
  await configureGoogle(parseOptions(['--configure']), setup.dependencies);
  const file = path.join(setup.runtime, 'displayos-google-secrets.json');
  let called = 0;
  const testAccount = '0123456789abcdef0123456789abcdef';
  const configFile = path.join(setup.runtime, 'wrangler.test.json');
  await writeFile(configFile, JSON.stringify({ name: 'displayos', account_id: testAccount }));
  await publishSecrets(file, setup.runtime, (executable, args, options) => {
    called++;
    assert.equal(executable, process.execPath);
    assert.deepEqual(args.slice(1, 4), ['secret', 'bulk', file]);
    assert.equal(args.join(' ').includes(SECRET), false);
    assert.equal(args[args.indexOf('--name') + 1], 'displayos');
    assert.equal(path.isAbsolute(args[args.indexOf('--config') + 1]), true);
    assert.equal(options.shell, false);
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.equal(options.env.CLOUDFLARE_ACCOUNT_ID, testAccount);
    assert.equal(options.env.WRANGLER_LOG_PATH, path.join(setup.runtime, 'displayos-google-wrangler.log'));
    return { status: 0, stdout: SECRET, stderr: SECRET };
  }, configFile);
  assert.equal(called, 1);
  await assert.rejects(publishSecrets(file, setup.runtime, () => ({ status: 1, stdout: SECRET, stderr: SECRET }), configFile), error => error.code === 'PUBLISH_FAILED' && !error.message.includes(SECRET));
  await writeFile(file, JSON.stringify({ GOOGLE_WEATHER_API_KEY: SECRET, PRODUCT_STATE_KEY: SECRET }));
  await assert.rejects(publishSecrets(file, setup.runtime, () => { throw new Error('must not spawn'); }, configFile), { code: 'INVALID_GOOGLE_SECRETS' });
});

test('the operator CLI emits only safe summaries and suppresses arbitrary provider errors and malicious metadata', async testcase => {
  const setup = await fixture(testcase);
  let stdout = ''; let stderr = '';
  const capture = { ...setup.dependencies, output: value => { stdout += value; }, errorOutput: value => { stderr += value; } };
  assert.equal(await main([], capture), 0);
  assert.equal(stdout.includes(SECRET), false);
  stdout = '';
  assert.equal(await main(['--configure', '--publish'], capture), 0);
  assert.equal(stdout.includes(SECRET), false);
  assert.equal(stderr, '');
  capture.gcloud = async () => { throw new Error('Provider says token=' + SECRET); };
  assert.equal(await main([], capture), 1);
  assert.equal(stderr.includes(SECRET), false);
  stdout = ''; stderr = '';
  assert.equal(await main(['--help'], capture), 0);
  assert.match(stdout, /300\/day/);
  assert.equal(stderr, '');
});
