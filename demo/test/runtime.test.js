import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { secureRuntime, runtimeLocation } from '../runtime.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function localRuntime(directory) {
  return secureRuntime(directory, { runtimePath: path.join(directory, '.runtime') });
}

async function temporary(run) {
  const directory = await mkdtemp(path.join(root, '.acl-test-'));
  try { await run(directory); }
  finally {
    const relative = path.relative(root, path.resolve(directory));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe test cleanup.');
    await rm(directory, { recursive: true, force: true });
  }
}

test('runtime protects existing and new files, or gates unsupported Windows filesystems', async () => temporary(async directory => {
  await mkdir(path.join(directory, '.runtime'));
  await writeFile(path.join(directory, '.runtime', 'old-synthetic-secret.txt'), 'synthetic-test-data');
  let result;
  try { result = await localRuntime(directory); }
  catch (error) {
    if (process.platform !== 'win32') throw error;
    const acl = execFileSync(path.join(process.env.SystemRoot, 'System32', 'icacls.exe'), [path.join(directory, '.runtime')], { windowsHide: true, encoding: 'utf8' });
    if (!acl.includes('No permissions are set. All users have full control.')) throw error;
    await assert.rejects(localRuntime(directory));
    assert.equal(await readFile(path.join(directory, '.runtime', 'old-synthetic-secret.txt'), 'utf8'), 'synthetic-test-data');
    return;
  }
  assert.match(result.boundary, process.platform === 'win32' ? /current-user-only ACL verified/ : /POSIX/);
  await writeFile(path.join(result.runtime, 'new-synthetic-secret.txt'), 'synthetic-test-data', { mode: 0o600 });
  await localRuntime(directory);
  assert.equal(await readFile(path.join(result.runtime, 'old-synthetic-secret.txt'), 'utf8'), 'synthetic-test-data');
}));

test('Windows explicit Everyone access on runtime gates secret use until removed', { skip: process.platform !== 'win32' }, async () => temporary(async directory => {
  const runtime = path.join(directory, '.runtime');
  await mkdir(runtime);
  const icacls = path.join(process.env.SystemRoot, 'System32', 'icacls.exe');
  execFileSync(icacls, [runtime, '/grant', '*S-1-1-0:(OI)(CI)R', '/Q'], { windowsHide: true, stdio: 'pipe' });
  await assert.rejects(localRuntime(directory));
  execFileSync(icacls, [runtime, '/remove:g', '*S-1-1-0', '/Q'], { windowsHide: true, stdio: 'pipe' });
  const acl = execFileSync(icacls, [runtime], { windowsHide: true, encoding: 'utf8' });
  if (acl.includes('No permissions are set. All users have full control.')) await assert.rejects(localRuntime(directory));
  else await localRuntime(directory);
}));

test('runtime subdirectories are refused rather than recursively following unexpected content', async () => temporary(async directory => {
  await mkdir(path.join(directory, '.runtime', 'unexpected-directory'), { recursive: true });
  await assert.rejects(localRuntime(directory));
}));

test('Windows default runtime is outside the exFAT source tree, with validated explicit override', () => {
  const localAppData = process.env.LOCALAPPDATA || path.join(root, 'test-local-appdata');
  const expected = path.resolve(localAppData, 'DisplayOS');
  assert.equal(runtimeLocation(root, { LOCALAPPDATA: localAppData }, 'win32'), expected);
  assert.throws(() => runtimeLocation(root, { DEMO_RUNTIME_DIR: 'relative' }, 'win32'));
  assert.throws(() => runtimeLocation(root, { DEMO_RUNTIME_DIR: path.parse(root).root }, 'win32'));
  assert.equal(runtimeLocation(root, { DEMO_RUNTIME_DIR: path.join(root, '.runtime') }, 'win32'), path.join(root, '.runtime'));
});

test('actual Windows default runtime verifies current-user-only ACLs before credential storage', { skip: process.platform !== 'win32' }, async () => {
  const result = await secureRuntime(root);
  assert.equal(result.runtime, path.resolve(process.env.LOCALAPPDATA, 'DisplayOS'));
  assert.match(result.boundary, /current-user-only ACL verified/);
});
