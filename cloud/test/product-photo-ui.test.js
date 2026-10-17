import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { normalizeImage } from '../src/product/media.js';
import { sampleSnapshot, validateSnapshot } from '../src/product/family.js';

const common = await readFile(new URL('../product-public/common.js', import.meta.url), 'utf8');
const source = await readFile(new URL('../product-public/home.js', import.meta.url), 'utf8');
const origin = 'https://photos.example.com';

async function withPhotos(options, callback) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const uploads = [];
    const publications = [];
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const home = { id: 'fixture-home', name: 'Fixture family', role: 'owner', members: [], screens: [], grants: [], settings: { timezone: 'UTC', nightStart: '22:00', nightEnd: '07:00', quietAfterSeconds: 300, brightness: 60, orientation: 'auto', showPhotos: true } };
    if (options.screen) home.screens.push({ id: 'fixture-screen', name: 'Kitchen', settings: home.settings });
    var current = { revision: 7, snapshot: { ...sampleSnapshot(Date.now()), briefing: { title: 'Keep our plans', text: 'Already approved' } } };
    await page.route(origin + '/**', async route => {
      const path = new URL(route.request().url()).pathname;
      let value;
      let status = 200;
      if (path === '/home') {
        await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><main id="home-root"></main><p id="message" role="status" hidden></p></body></html>' });
        return;
      }
      if (path === '/api/v1/me') value = { account: { id: 'fixture-owner', name: 'Fixture owner' }, csrf: 'fixture-csrf' };
      else if (path === '/api/v1/homes') value = { homes: [{ id: home.id, name: home.name }] };
      else if (path === '/api/v1/connections/pending') value = { intents: [] };
      else if (path === '/api/v1/home') {
        const body = route.request().postDataJSON();
        assert.equal(body.homeId, home.id);
        assert.equal(route.request().headers()['x-displayos-csrf'], 'fixture-csrf');
        if (body.command === 'home.get') value = home;
        else if (body.command === 'media.list') value = { photos: [] };
        else if (body.command === 'media.upload') {
          uploads.push(body.input);
          try {
            if (options.uploadStatus && uploads.length === 1) throw { status: options.uploadStatus };
            const image = await normalizeImage(body.input);
            value = { mediaId: 'fixture-photo-reference-' + uploads.length };
            options.normalized = image;
          } catch (error) { status = error.status || 503; value = { error: status === 429 && !options.rateLimited ? 'Please remove a photo before adding another.' : 'Private server detail must not appear' }; }
        } else if (body.command === 'family.current') value = current;
        else if (body.command === 'family.publish') {
          assert.equal(body.input.expectedRevision, current.revision);
          validateSnapshot(body.input.snapshot, Date.now());
          publications.push(body.input); current = { revision: current.revision + 1, snapshot: body.input.snapshot }; value = { accepted: true };
        } else throw new Error('Unexpected fixture command');
      } else throw new Error('Unexpected fixture path');
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    });
    await page.goto(origin + '/home');
    await page.clock.install();
    await page.addScriptTag({ content: common });
    await page.addScriptTag({ content: source });
    await page.getByText('Favorite faces', { exact: true }).click();
    await page.getByText('Your chosen photos will appear here.', { exact: true }).waitFor();
    await callback({ page, uploads, publications });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}

test('multiple selected photos publish one slideshow update without replacing family plans', async () => {
  await withPhotos({ screen: true }, async ({ page, uploads, publications }) => {
    assert.equal(await page.locator('#chosen-photo').getAttribute('multiple'), '');
    const buffer = await texturedPhoto(page);
    await page.locator('#chosen-photo').setInputFiles([1, 2, 3].map(index => ({ name: 'synthetic-' + index + '.png', mimeType: 'image/png', buffer })));
    await page.getByText('Saved 3 of 3 photos. Your slideshow has been sent to your screens.', { exact: true }).waitFor();
    assert.equal(uploads.length, 3);
    assert.equal(publications.length, 1);
    assert.equal(publications[0].snapshot.photos.length, 3);
    assert.equal(publications[0].snapshot.briefing.title, 'Keep our plans');
    assert.equal(await page.locator('.photo-catalog img').count(), 3);
  });
});

test('a batch keeps successful photos when another selected file cannot be opened', async () => {
  await withPhotos({}, async ({ page, uploads }) => {
    const buffer = await texturedPhoto(page);
    await page.locator('#chosen-photo').setInputFiles([{ name: 'good.png', mimeType: 'image/png', buffer }, { name: 'broken.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('Not a photo') }, { name: 'another.png', mimeType: 'image/png', buffer }]);
    await page.getByText('Saved 2 of 3 photos. Some photos could not be saved. Choose those photos again to retry. Your chosen photos are ready.', { exact: true }).waitFor();
    assert.equal(uploads.length, 2);
    assert.equal(await page.locator('.photo-catalog img').count(), 2);
    assert.equal(await page.locator('#chosen-photo').inputValue(), '');
  });
});

async function texturedPhoto(page, type = 'image/png') {
  return Buffer.from(await page.evaluate(type => {
    const canvas = document.createElement('canvas');
    canvas.width = 1280; canvas.height = 853;
    const context = canvas.getContext('2d');
    const pixels = context.createImageData(canvas.width, canvas.height);
    let seed = 123456;
    for (let index = 0; index < pixels.data.length; index += 4) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      pixels.data[index] = seed & 255; pixels.data[index + 1] = (seed >>> 8) & 255; pixels.data[index + 2] = (seed >>> 16) & 255; pixels.data[index + 3] = 255;
    }
    context.putImageData(pixels, 0, 0);
    return canvas.toDataURL(type, .9).split(',')[1];
  }, type), 'base64');
}

for (const mime of ['image/png', 'image/jpeg', 'image/webp']) {
  test('Favorite faces saves a detailed ' + mime + ' through browser preparation and server normalization', async () => {
    const options = {};
    await withPhotos(options, async ({ page, uploads }) => {
      const photo = await texturedPhoto(page, mime);
      await page.locator('#chosen-photo').setInputFiles({ name: 'synthetic-photo', mimeType: mime, buffer: photo });
      await page.getByText('Photo saved for your assistant to use. Only this chosen photo was shared.', { exact: true }).waitFor();
      assert.equal(uploads.length, 1);
      assert.ok(Buffer.from(uploads[0].data, 'base64').length <= 98304);
      assert.ok(Buffer.from(options.normalized.data, 'base64').length <= 98304);
      assert.equal(options.normalized.mime, 'image/jpeg');
      assert.equal(await page.locator('.photo-catalog img').count(), 1);
      assert.equal(await page.locator('#chosen-photo').inputValue(), '');
    });
  });
}

test('Favorite faces explains a full album, keeps the message visible and allows the same file to be retried', async () => {
  await withPhotos({ uploadStatus: 429 }, async ({ page, uploads }) => {
    const photo = { name: 'synthetic-photo.png', mimeType: 'image/png', buffer: await texturedPhoto(page) };
    await page.locator('#chosen-photo').setInputFiles(photo);
    await page.getByText('Your photo collection is full. Remove a photo, then try again.', { exact: true }).first().waitFor();
    assert.equal(await page.locator('#chosen-photo').inputValue(), '');
    await page.clock.fastForward(9000);
    assert.equal(await page.locator('#photo-status').isVisible(), true);
    assert.doesNotMatch(await page.locator('body').textContent(), /Private server detail/);
    await page.locator('#chosen-photo').setInputFiles(photo);
    await page.getByText('Photo saved for your assistant to use. Only this chosen photo was shared.', { exact: true }).waitFor();
    assert.equal(uploads.length, 2);
  });
});

test('Favorite faces explains an unreadable photo without sending an upload', async () => {
  await withPhotos({}, async ({ page, uploads }) => {
    await page.locator('#chosen-photo').setInputFiles({ name: 'broken.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('Not a photo') });
    await page.getByText('We could not open this photo. Try another JPEG, PNG or WebP photo.', { exact: true }).first().waitFor();
    assert.equal(uploads.length, 0);
    assert.equal(await page.locator('#chosen-photo').inputValue(), '');
  });
});

for (const [uploadStatus, rateLimited, message] of [
  [429, true, 'Let us pause for a moment. Please try again shortly.'],
  [503, false, 'That did not work. Please check and try again.'],
  [413, false, 'We could not make a small copy of this photo. Try another photo.']
]) {
  test('Favorite faces keeps a safe retry message for upload status ' + uploadStatus, async () => {
    await withPhotos({ uploadStatus, rateLimited }, async ({ page, uploads }) => {
      await page.locator('#chosen-photo').setInputFiles({ name: 'synthetic-photo.png', mimeType: 'image/png', buffer: await texturedPhoto(page) });
      await page.getByText(message, { exact: true }).first().waitFor();
      assert.equal(uploads.length, 1);
      assert.equal(await page.locator('#chosen-photo').inputValue(), '');
      assert.doesNotMatch(await page.locator('body').textContent(), /Private server detail/);
      assert.equal(await page.getByRole('button', { name: 'Choose photos', exact: true }).isEnabled(), true);
    });
  });
}
