import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { secureRuntime } from '../../demo/runtime.js';

const serial = process.argv[2];
if (!serial || !/^[A-Za-z0-9._:-]{1,80}$/.test(serial)) throw new Error('Supply the connected qualified unit serial. No flashing is performed.');
const root = fileURLToPath(new URL('../', import.meta.url));
const { runtime } = await secureRuntime(root);
const script = fileURLToPath(new URL('../../kiosk/scripts/provision.ps1', import.meta.url));
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const result = spawnSync(powershell, ['-NoProfile', '-File', script, '-Action', 'Prepare', '-Serial', serial, '-FactorySecretsFile', path.join(runtime, 'displayos-product-secrets.json'), '-Install', '-Launch'], { stdio: 'inherit', windowsHide: true });
process.exitCode = result.status ?? 1;
