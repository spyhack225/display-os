import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';

if (process.argv.slice(2).length !== 1 || process.argv[2] !== '--synthetic-home') throw new Error('Use --synthetic-home. This check creates and deletes only its own disposable photo-test account and home.');
const config = JSON.parse(await readFile(new URL('../wrangler.json', import.meta.url), 'utf8'));
const origin = config.vars.PUBLIC_ORIGIN;
const tag = randomBytes(5).toString('hex');
let browser;
let owner;
let registered = false;
let deleted = false;
let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; }

async function api(path, body) {
  return owner.evaluate(async ({ path, body }) => {
    const me = await fetch('/api/v1/me').then(response => response.json());
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-DisplayOS-CSRF': me.csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, value: await response.json() };
  }, { path, body });
}

try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  owner = await context.newPage();
  owner.setDefaultTimeout(20000);
  owner.on('response', response => { if (new URL(response.url()).pathname === '/auth/register/verify' && response.status() === 200) registered = true; });
  await owner.goto(origin + '/home');
  const authenticator = await context.newCDPSession(owner);
  await authenticator.send('WebAuthn.enable');
  await authenticator.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await owner.locator('#your-name').fill('Disposable photo QA ' + tag);
  await owner.getByRole('button', { name: 'Get started', exact: true }).click();
  await owner.locator('#home-name').waitFor();
  await owner.locator('#home-name').fill('Disposable photo QA home ' + tag);
  await owner.getByRole('button', { name: 'Make my home', exact: true }).click();
  await owner.getByText('Favorite faces', { exact: true }).waitFor();
  const homes = await api('/api/v1/homes');
  check(homes.status === 200 && homes.value.homes.length === 1, 'The photo-test account must contain exactly its own home.');
  const homeId = homes.value.homes[0].id;
  await owner.getByText('Favorite faces', { exact: true }).click();
  await owner.getByText('Your chosen photos will appear here.', { exact: true }).waitFor();
  const savedPhotos = new Set();
  for (const mime of ['image/png', 'image/jpeg', 'image/webp']) {
    const data = await owner.evaluate(mime => {
      const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 853;
      const context = canvas.getContext('2d'); const pixels = context.createImageData(canvas.width, canvas.height);
      let seed = 123456;
      for (let index = 0; index < pixels.data.length; index += 4) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        pixels.data[index] = seed & 255; pixels.data[index + 1] = (seed >>> 8) & 255; pixels.data[index + 2] = (seed >>> 16) & 255; pixels.data[index + 3] = 255;
      }
      context.putImageData(pixels, 0, 0);
      return canvas.toDataURL(mime, .9).split(',')[1];
    }, mime);
    await owner.getByRole('button', { name: 'Choose photos', exact: true }).waitFor({ state: 'visible' });
    await owner.waitForFunction(() => !document.querySelector('#home-root button').disabled);
    await owner.locator('#chosen-photo').setInputFiles({ name: 'synthetic-photo.' + mime.split('/')[1], mimeType: mime, buffer: Buffer.from(data, 'base64') });
    await owner.waitForFunction(() => document.getElementById('photo-status').textContent === 'Photo saved for your assistant to use. Only this chosen photo was shared.');
    check(await owner.locator('#chosen-photo').inputValue() === '', 'The picker must allow another selection.');
    const catalog = await api('/api/v1/home', { homeId, command: 'media.list', input: {} });
    check(catalog.status === 200 && catalog.value.photos.length === savedPhotos.size + 1, 'The saved photo must appear in the live catalog.');
    const mediaId = catalog.value.photos.find(photo => !savedPhotos.has(photo.mediaId)).mediaId;
    savedPhotos.add(mediaId);
    const saved = await api('/api/v1/home', { homeId, command: 'media.get', input: { mediaId } });
    check(saved.status === 200 && saved.value.mime === 'image/jpeg', 'Live storage must contain a sanitized JPEG.');
    check(Buffer.from(saved.value.data, 'base64').length <= 98304, 'The normalized photo must stay inside its byte limit.');
  }
  await owner.reload();
  await owner.getByText('Favorite faces', { exact: true }).click();
  await owner.waitForFunction(() => document.querySelectorAll('.photo-catalog img').length === 3);
  check(await owner.locator('.photo-catalog img').count() === 3, 'Saved photos must remain available after reloading.');
  const cleanup = await api('/auth/account/delete', {});
  check(cleanup.status === 200, 'The disposable photo-test account must be deleted.'); deleted = true;
  check((await api('/api/v1/me')).status === 401, 'The deleted account must lose its session.');
  await writeFile(new URL('../../diagnostics/displayos-photo-live.json', import.meta.url), JSON.stringify({ origin, verifiedAt: new Date().toISOString(), checks, formats: ['image/png', 'image/jpeg', 'image/webp'], syntheticAccountDeleted: deleted, hardwareVerified: false, personalPhotoTested: false }, null, 2) + '\n');
  console.log(checks + ' live photo checks passed: detailed JPEG, PNG and WebP selection, sanitized storage, reload and disposable account deletion. No personal photos or screens used.');
} finally {
  if (registered && !deleted && owner) {
    try {
      await owner.goto(origin + '/home');
      const cleanup = await api('/auth/account/delete', {});
      if (cleanup.status !== 200) throw new Error('Cleanup did not complete.');
      console.log('Disposable photo-test account removed after a failed journey.');
    } catch { console.error('Photo-test cleanup did not pass. Inspect only Disposable photo QA ' + tag + '.'); }
  }
  await browser?.close();
}
