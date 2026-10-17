import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function toolEnvironment() {
  const environment = { ...process.env };
  const current = process.env.Path || process.env.PATH || '';
  for (const key of Object.keys(environment)) if (key.toLowerCase() === 'path') delete environment[key];
  environment[process.platform === 'win32' ? 'Path' : 'PATH'] = path.dirname(process.execPath) + path.delimiter + current;
  return environment;
}

export function toolPath(tool) {
  if (tool === 'wrangler') return fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url));
  if (tool === 'npm') return path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  throw new Error('Use npm or wrangler.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = spawnSync(process.execPath, [toolPath(process.argv[2]), ...process.argv.slice(3)], { env: toolEnvironment(), stdio: 'inherit' });
  process.exit(result.status ?? 1);
}
