import { mkdir, lstat, readdir, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

function native(executable, args, env = process.env) {
  return execFileSync(executable, args, { windowsHide: true, encoding: 'utf8', timeout: 15000, env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function runtimeLocation(root, env = process.env, platform = process.platform) {
  if (env.DEMO_RUNTIME_DIR) {
    if (!path.isAbsolute(env.DEMO_RUNTIME_DIR)) throw new Error('DEMO_RUNTIME_DIR must be absolute.');
    const selected = path.resolve(env.DEMO_RUNTIME_DIR);
    if (selected === path.parse(selected).root) throw new Error('Runtime cannot be a drive root.');
    return selected;
  }
  if (platform === 'win32') {
    if (!env.LOCALAPPDATA || !path.isAbsolute(env.LOCALAPPDATA)) throw new Error('Windows LOCALAPPDATA is required.');
    return path.resolve(env.LOCALAPPDATA, 'DisplayOS');
  }
  return path.resolve(root, '.runtime');
}

export async function secureRuntime(root, { runtimePath = runtimeLocation(root) } = {}) {
  const runtime = path.resolve(runtimePath);
  if (!path.isAbsolute(runtimePath) || runtime === path.parse(runtime).root) throw new Error('Invalid runtime location.');
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const directory = await lstat(runtime);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Runtime must be a real directory.');
  const children = await readdir(runtime);
  for (const name of children) {
    const child = await lstat(path.join(runtime, name));
    if (!child.isFile() || child.isSymbolicLink()) throw new Error('Runtime must contain only regular files.');
  }
  if (process.platform === 'win32') {
    const system = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    const powershell = path.join(system, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const sid = native(powershell, ['-NoProfile', '-NonInteractive', '-Command', '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value']);
    if (!/^S-1-5-[0-9-]+$/.test(sid)) throw new Error('Cannot determine Windows user SID.');
    native(path.join(system, 'icacls.exe'), [runtime, '/inheritance:r', '/grant:r', '*' + sid + ':(OI)(CI)F', '/Q']);
    const verify = "$ErrorActionPreference='Stop'; $sid=$env:DEMO_USER_SID; $root=$env:DEMO_RUNTIME_PATH; $items=@(Get-Item -LiteralPath $root)+@(Get-ChildItem -LiteralPath $root -Force); foreach($item in $items) { $acl=Get-Acl -LiteralPath $item.FullName; if($item.FullName -eq $root -and -not $acl.AreAccessRulesProtected) { throw 'Runtime inheritance not disabled' }; $rules=$acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]); if($rules.Count -eq 0) { throw 'No runtime access rule' }; foreach($rule in $rules) { if($rule.IdentityReference.Value -ne $sid -or $rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow -or ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { throw 'Runtime accessible by another principal or lacks full user control' } } }; Write-Output 'current-user-only'";
    const verified = native(powershell, ['-NoProfile', '-NonInteractive', '-Command', verify], { ...process.env, DEMO_RUNTIME_PATH: runtime, DEMO_USER_SID: sid });
    if (verified !== 'current-user-only') throw new Error('Windows runtime ACL verification failed.');
    return { runtime, boundary: 'Windows current-user-only ACL verified', sid };
  }
  await chmod(runtime, 0o700);
  for (const name of children) await chmod(path.join(runtime, name), 0o600);
  return { runtime, boundary: 'POSIX directory mode 0700 and file mode 0600' };
}
