import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const output = new URL('dist/', root);
await mkdir(output, { recursive: true });
for (const filename of ['app.js', 'style.css', 'agent.html']) {
  await copyFile(new URL('../../demo/public/' + filename, import.meta.url), new URL(filename, output));
}
const contract = JSON.parse(await readFile(new URL('../../demo/public/api-contract.json', import.meta.url), 'utf8'));
contract.service = 'displayos-cloud';
contract.defaultOrigin = null;
contract.originPolicy = 'Use the current HTTPS origin, exactly matching configured PUBLIC_ORIGIN.';
contract.authentication.owner = 'Single pilot owner credential establishes __Host-desk_owner Secure HttpOnly SameSite=Strict cookie with Path=/, CSRF and exact Origin checks. Not customer accounts or OAuth.';
contract.authentication.enrollment = 'Private pilot enrollment code required to create a display. Does not claim ownership.';
contract.schemas.claim.required = ['code'];
contract.schemas.claim.description = 'Family setup sends the single-use 12-character screen code. Owner authentication, exact Origin, CSRF, attempt limits and two-minute expiry remain required. Code and sessionId together are still accepted for existing API clients.';
contract.headers.enrollmentPost = { 'X-Enrollment-Code': 'private pilot enrollment code' };
contract.headers.ownerPost.Origin = 'exact configured HTTPS origin';
contract.limits.growthStateBytes = 60000;
contract.limits.maximumStateBytes = 80000;
contract.limits.pendingRequestsPerDisplay = 5;
contract.persistence = 'Encrypted Durable Object state survives restarts. Browser tokens remain in tab session storage.';
await writeFile(new URL('api-contract.json', output), JSON.stringify(contract, null, 2) + '\n');
for (const filename of await readdir(new URL('public/', root))) {
  await copyFile(new URL('public/' + filename, root), new URL(filename, output));
}
await mkdir(new URL('product/', output), { recursive: true });
for (const filename of await readdir(new URL('product-public/', root))) {
  if (filename === 'README.md') continue;
  await copyFile(new URL('product-public/' + filename, root), new URL('product/' + filename, output));
}
await copyFile(new URL('node_modules/@simplewebauthn/browser/dist/bundle/index.es5.umd.min.js', root), new URL('product/webauthn.js', output));
await copyFile(new URL('node_modules/qrcode-generator/dist/qrcode.js', root), new URL('product/qrcode.js', output));
console.log('Built public pilot assets at ' + fileURLToPath(output) + '. No runtime secrets included.');
