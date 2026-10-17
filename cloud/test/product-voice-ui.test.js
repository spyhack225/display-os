import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { sampleSnapshot } from '../src/product/family.js';

const root = new URL('../product-public/', import.meta.url);
const screenAssets = Object.fromEntries(await Promise.all(['common.js', 'screen.js', 'design-system.css', 'style.css', 'details.css', 'pairing.css', 'voice-beam.js'].map(async filename => [filename, await readFile(new URL(filename, root), 'utf8')])));
const screenOrigin = 'https://voice-screen.example.com';
const now = Date.parse('2026-10-10T16:00:00Z');
const defaultVoiceAck = { id: 'voice-message-0001', state: 'acted', heard: 'add milk to groceries', agentName: 'Maya' };

function sceneFixture() {
  return {
    id: 'scene-fixture-0001',
    kind: 'plan',
    title: 'Weekend plan',
    subtitle: 'A short plan from Maya',
    blocks: [
      { type: 'text', text: 'We will start at nine.' },
      { type: 'rows', rows: [
        { label: 'Park', value: 'Saturday', tone: 'good' },
        { label: 'Rain', value: 'Sunday', tone: 'warn' },
        { label: 'Lunch', value: 'Noon' },
      ] },
      { type: 'chips', chips: ['Snacks', 'Sun cream', 'Bikes'] },
      { type: 'steps', steps: ['Pack the bag', 'Fill the water bottles', 'Leave at nine'] },
      { type: 'bars', bars: [{ label: 'Sun', value: 0.8 }, { label: 'Rain', value: 0.25 }] },
    ],
    ttlSeconds: 900,
  };
}

function voiceSnapshot(scene) {
  const snapshot = { ...sampleSnapshot(now), briefing: { title: 'Voice day', text: 'Approved for this screen' } };
  if (scene) snapshot.displayScene = scene;
  return snapshot;
}

const mediaStubs = `
(function () {
  var fakeStream = { getTracks: function () { return [{ stop: function () {} }]; } };
  try {
    if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { value: {}, configurable: true });
  } catch (error) {}
  navigator.mediaDevices.getUserMedia = function () { return Promise.resolve(fakeStream); };
  function FakeAudioContext() { this.state = 'running'; }
  FakeAudioContext.prototype.resume = function () { return Promise.resolve(); };
  FakeAudioContext.prototype.close = function () { return Promise.resolve(); };
  FakeAudioContext.prototype.createMediaStreamSource = function () { return { connect: function () {}, disconnect: function () {} }; };
  FakeAudioContext.prototype.createAnalyser = function () {
    return {
      smoothingTimeConstant: 0.65, fftSize: 256, frequencyBinCount: 128,
      connect: function () {}, disconnect: function () {},
      getByteFrequencyData: function (array) { for (var i = 0; i < array.length; i++) array[i] = 0; }
    };
  };
  window.AudioContext = FakeAudioContext;
  window.webkitAudioContext = FakeAudioContext;
  function FakeMediaRecorder(stream, options) {
    this.stream = stream;
    this.mimeType = (options && options.mimeType) || 'audio/webm';
    this.state = 'inactive';
    this.ondataavailable = null;
    this.onstop = null;
    this.onerror = null;
  }
  FakeMediaRecorder.isTypeSupported = function (type) { return String(type).indexOf('audio/webm') === 0; };
  FakeMediaRecorder.prototype.start = function () { this.state = 'recording'; };
  FakeMediaRecorder.prototype.stop = function () {
    var self = this;
    this.state = 'inactive';
    if (this.ondataavailable) this.ondataavailable({ data: new Blob([new Uint8Array(9000)], { type: self.mimeType }) });
    if (this.onstop) this.onstop({});
  };
  window.MediaRecorder = FakeMediaRecorder;
}());
`;

function isEndResponse(response) {
  if (new URL(response.url()).pathname !== '/device/v1/voice') return false;
  const body = response.request().postDataJSON();
  return !!body && body.action === 'end';
}

async function withScreen(options, callback) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    page.setDefaultTimeout(4000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const voiceRequests = [];
    const pollAcks = [];
    const envelope = {
      state: 'owned', revision: 1, nonce: 'fixture-nonce', homeName: 'Fixture home', screenName: 'Kitchen', screenIdentifier: 'ABC123',
      settings: { timezone: 'UTC', nightStart: '07:00', nightEnd: '07:00', quietAfterSeconds: 1800, showPhotos: false, temperatureUnit: 'celsius', ...(options.settings || {}) },
      localRevision: 1, localEnabled: { weather: false, nearby: false },
      agents: [{ id: 'agent-maya', name: 'Maya' }, { id: 'agent-sam', name: 'Sam' }],
      snapshot: options.snapshot !== undefined ? options.snapshot : voiceSnapshot(),
    };
    await page.addInitScript(mediaStubs);
    await page.route(screenOrigin + '/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/screen') {
        await route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/product/design-system.css"><link rel="stylesheet" href="/product/style.css"><link rel="stylesheet" href="/product/details.css"><link rel="stylesheet" href="/product/pairing.css"></head><body class="display"><main id="screen-root" class="screen-shell"></main><p id="screen-status" role="status"></p></body></html>' });
        return;
      }
      if (path.startsWith('/product/')) {
        const filename = path.slice('/product/'.length);
        await route.fulfill({ contentType: filename.endsWith('.css') ? 'text/css' : 'text/javascript', body: screenAssets[filename] || '' });
        return;
      }
      if (path === '/device/v1/voice') {
        const body = request.postDataJSON();
        voiceRequests.push(body);
        if (body.action === 'begin') await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ uploadId: 'upload-fixture-0001' }) });
        else if (body.action === 'part') await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ received: true }) });
        else if (body.action === 'end') await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ messageId: 'voice-message-0001', revision: 2, voiceAck: options.voiceAck || defaultVoiceAck }) });
        else await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
        return;
      }
      if (path === '/device/v1/poll') {
        if (envelope.snapshot && envelope.snapshot.voiceAck) pollAcks.push(envelope.snapshot.voiceAck);
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(envelope) });
      } else if (path === '/device/v1/ack') await route.fulfill({ contentType: 'application/json', body: '{}' });
      else await route.fulfill({ status: 400, contentType: 'application/json', body: '{}' });
    });
    await page.goto(screenOrigin + '/screen');
    await page.clock.install({ time: new Date(now) });
    await page.evaluate(() => sessionStorage.setItem('displayos-demo-device-token', 'fixture-display-token'));
    await page.addScriptTag({ content: screenAssets['common.js'] });
    await page.addScriptTag({ content: screenAssets['voice-beam.js'] });
    await page.addScriptTag({ content: screenAssets['screen.js'] });
    await page.locator('[data-clock]').first().waitFor();
    if (!options.night) await page.getByRole('button', { name: 'Hold to talk', exact: true }).waitFor();
    await callback({ page, voiceRequests, pollAcks });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}

async function pressToTalk(page) {
  const talk = page.getByRole('button', { name: 'Hold to talk', exact: true });
  const bounds = await talk.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.getByRole('button', { name: 'Release to send', exact: true }).waitFor();
}

test('the mic bar shows hold-to-talk, assistant pills and a beam canvas', async () => {
  await withScreen({}, async ({ page }) => {
    assert.equal(await page.getByRole('button', { name: 'Hold to talk', exact: true }).isVisible(), true);
    const pills = page.locator('.voice-agent');
    assert.ok(await pills.count() >= 1, 'expected at least one assistant pill');
    assert.equal(await pills.first().textContent(), 'Maya');
    assert.equal(await pills.first().getAttribute('aria-pressed'), 'true');
    assert.equal(await pills.nth(1).getAttribute('aria-pressed'), 'false');
    assert.ok(await page.locator('.voice-bar canvas').count() >= 1, 'expected the voice beam canvas');
    assert.equal(await page.locator('.voice-status').textContent(), 'Hold to talk');
  });
});

test('holding and releasing sends begin, part and end voice uploads', async () => {
  await withScreen({}, async ({ page, voiceRequests }) => {
    await pressToTalk(page);
    await page.clock.fastForward(1000);
    const ended = page.waitForResponse(isEndResponse);
    await page.mouse.up();
    await ended;
    assert.deepEqual(voiceRequests.map(entry => entry.action), ['begin', 'part', 'part', 'part', 'end']);
    const begin = voiceRequests[0];
    assert.ok(begin.mime.startsWith('audio/webm'), 'begin mime should be webm audio, got ' + begin.mime);
    assert.equal(begin.byteLength, 9000);
    assert.ok(begin.durationMs >= 600, 'held long enough to send, got ' + begin.durationMs);
    const parts = voiceRequests.slice(1, 4);
    parts.forEach((part, index) => {
      assert.equal(part.uploadId, 'upload-fixture-0001');
      assert.equal(part.seq, index);
      assert.match(part.data, /^[A-Za-z0-9+/]+={0,2}$/, 'part data should be base64');
      assert.ok(Buffer.from(part.data, 'base64').length <= 4096, 'parts stay within the 4096 byte chunk size');
    });
    assert.equal(parts.reduce((sum, part) => sum + Buffer.from(part.data, 'base64').length, 0), 9000, 'every audio byte is uploaded');
    assert.deepEqual(voiceRequests[4], { action: 'end', uploadId: 'upload-fixture-0001' });
  });
});

test('the voice ack from the end response shows without any poll', async () => {
  await withScreen({ voiceAck: { id: 'voice-message-0001', state: 'heard', heard: 'add milk to groceries', agentName: 'Maya' } }, async ({ page, voiceRequests, pollAcks }) => {
    await pressToTalk(page);
    await page.clock.fastForward(1000);
    const ended = page.waitForResponse(isEndResponse);
    await page.mouse.up();
    await ended;
    const toast = page.locator('.voice-toast');
    await toast.waitFor();
    const text = await toast.textContent();
    assert.match(text, /add milk to groceries/);
    assert.match(text, /Maya/);
    assert.deepEqual(pollAcks, [], 'no poll delivered the ack');
    assert.ok(voiceRequests.some(entry => entry.action === 'end'));
  });
});

test('a live display scene renders rows, chips, bars and steps and dismisses', async () => {
  await withScreen({ snapshot: voiceSnapshot(sceneFixture()) }, async ({ page }) => {
    const card = page.locator('.scene-card');
    await card.waitFor();
    const text = await card.textContent();
    assert.match(text, /Weekend plan/);
    assert.match(text, /A short plan from Maya/);
    assert.match(text, /We will start at nine\./);
    assert.match(text, /Saturday/);
    assert.match(text, /Sunday/);
    assert.equal(await card.locator('.scene-row').count(), 3);
    assert.equal(await card.locator('.scene-row.tone-good').count(), 1);
    assert.equal(await card.locator('.scene-row.tone-warn').count(), 1);
    assert.equal(await card.locator('.scene-chip').count(), 3);
    assert.equal(await card.locator('.scene-steps li').count(), 3);
    assert.match(await card.locator('.scene-steps li').first().textContent(), /Pack the bag/);
    assert.deepEqual(await card.locator('.scene-bar-fill').evaluateAll(elements => elements.map(element => element.style.width)), ['80%', '25%']);
    assert.equal(await card.locator('.scene-icon').textContent(), '📅');
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.scene-card'));
  });
});

test('night mode shows neither the scene card nor the mic bar', async () => {
  await withScreen({ night: true, settings: { nightStart: '12:00', nightEnd: '18:00' }, snapshot: voiceSnapshot(sceneFixture()) }, async ({ page }) => {
    assert.equal(await page.locator('body').evaluate(element => element.classList.contains('night')), true);
    assert.equal(await page.locator('.scene-card').count(), 0);
    assert.equal(await page.locator('.voice-toast').count(), 0);
    assert.equal(await page.locator('.voice-dock').isVisible(), false);
    assert.equal(await page.getByRole('button', { name: 'Hold to talk', exact: true }).count(), 0);
  });
});

test('a tap shorter than six hundred milliseconds is discarded', async () => {
  await withScreen({}, async ({ page, voiceRequests }) => {
    await page.clock.setFixedTime(new Date(now));
    await pressToTalk(page);
    await page.mouse.up();
    await page.getByRole('button', { name: 'Too short', exact: true }).waitFor();
    assert.equal(voiceRequests.length, 0, 'nothing is sent for a discarded tap');
  });
});

test('the talk button can be held with the keyboard', async () => {
  await withScreen({}, async ({ page, voiceRequests }) => {
    const talk = page.getByRole('button', { name: 'Hold to talk', exact: true });
    await talk.focus();
    await page.keyboard.down('Enter');
    await page.getByRole('button', { name: 'Release to send', exact: true }).waitFor();
    await page.clock.fastForward(1000);
    const ended = page.waitForResponse(isEndResponse);
    await page.keyboard.up('Enter');
    await ended;
    assert.ok(voiceRequests.some(entry => entry.action === 'begin'));
    assert.ok(voiceRequests.some(entry => entry.action === 'end'));
  });
});
