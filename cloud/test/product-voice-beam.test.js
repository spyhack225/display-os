import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const beamSource = await readFile(new URL('../product-public/voice-beam.js', import.meta.url), 'utf8');

async function withBeam(options, callback) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: 'no-preference' });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setContent('<!doctype html><html><body style="margin:0;background:#05070d"><div id="host" style="position:relative;width:420px;height:140px;border-radius:70px;overflow:hidden;background:#070b16"></div></body></html>');
    await page.addScriptTag({ content: beamSource });
    await page.evaluate(opts => {
      window.__beam = window.DisplayOSVoiceBeam(document.getElementById('host'), opts || {});
    }, options || {});
    await callback({ page });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}

async function sample(page, selector) {
  return page.evaluate(sel => {
    const canvas = document.querySelector(sel);
    if (!canvas) return null;
    const ctx = canvas.getContext('2d');
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let nonTransparent = 0;
    let brightness = 0;
    let satSum = 0;
    let satN = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (a <= 8) continue;
      nonTransparent += 1;
      brightness += r + g + b;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max > 16) {
        satSum += (max - min) / max;
        satN += 1;
      }
    }
    return { nonTransparent, brightness, saturation: satN ? satSum / satN : 0, width: canvas.width, height: canvas.height };
  }, selector);
}

test('mounting creates exactly one sized canvas inside the container', async () => {
  await withBeam({}, async ({ page }) => {
    await page.waitForTimeout(150);
    const info = await page.evaluate(() => {
      const host = document.getElementById('host');
      const canvases = host.querySelectorAll('canvas');
      return {
        count: canvases.length,
        width: canvases[0] ? canvases[0].width : 0,
        height: canvases[0] ? canvases[0].height : 0,
        position: canvases[0] ? canvases[0].style.position : '',
      };
    });
    assert.equal(info.count, 1);
    assert.ok(info.width > 0, 'canvas width should be non-zero');
    assert.ok(info.height > 0, 'canvas height should be non-zero');
    assert.equal(info.position, 'absolute');
  });
});

test('setLevel(0) then setLevel(1) blooms more and brighter pixels', async () => {
  await withBeam({ level: 0 }, async ({ page }) => {
    await page.waitForTimeout(450);
    const low = await sample(page, '#host canvas');
    await page.evaluate(() => window.__beam.setLevel(1));
    await page.waitForTimeout(500);
    const high = await sample(page, '#host canvas');
    assert.ok(high.nonTransparent > low.nonTransparent, `pixels ${low.nonTransparent} -> ${high.nonTransparent}`);
    assert.ok(high.brightness > low.brightness, `brightness ${low.brightness} -> ${high.brightness}`);
    assert.ok(high.brightness > low.brightness * 1.5, `brightness ${low.brightness} -> ${high.brightness}`);
  });
});

test('setProcessing(true) still draws a non-blank canvas', async () => {
  await withBeam({ level: 0 }, async ({ page }) => {
    await page.waitForTimeout(150);
    await page.evaluate(() => window.__beam.setProcessing(true));
    await page.waitForTimeout(250);
    const first = await sample(page, '#host canvas');
    assert.ok(first.nonTransparent > 0, 'processing frame should draw something');
    await page.waitForTimeout(200);
    const second = await sample(page, '#host canvas');
    assert.ok(second.nonTransparent > 0, 'processing loop keeps drawing');
  });
});

test('destroy() removes the canvas and stops the loop', async () => {
  await withBeam({}, async ({ page }) => {
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => document.getElementById('host').querySelectorAll('canvas').length), 1);
    await page.evaluate(() => window.__beam.destroy());
    assert.equal(await page.evaluate(() => document.getElementById('host').querySelectorAll('canvas').length), 0);
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => document.getElementById('host').querySelectorAll('canvas').length), 0);
    const noop = await page.evaluate(() => {
      window.__beam.setLevel(1);
      window.__beam.setProcessing(true);
      window.__beam.setPaused(true);
      window.__beam.setStream(null);
      window.__beam.destroy();
      return document.getElementById('host').querySelectorAll('canvas').length;
    });
    assert.equal(noop, 0);
  });
});

test('a zero-size container does not throw', async () => {
  await withBeam({}, async ({ page }) => {
    await page.evaluate(() => {
      const zero = document.createElement('div');
      zero.id = 'zero';
      zero.style.width = '0px';
      zero.style.height = '0px';
      zero.style.position = 'relative';
      document.body.appendChild(zero);
      window.__zeroBeam = window.DisplayOSVoiceBeam(zero, { level: 1, processing: true });
    });
    await page.waitForTimeout(250);
    const zeroInfo = await page.evaluate(() => {
      window.__zeroBeam.setLevel(0);
      window.__zeroBeam.setProcessing(false);
      window.__zeroBeam.setPaused(false);
      const canvas = document.getElementById('zero').querySelector('canvas');
      return { count: document.getElementById('zero').querySelectorAll('canvas').length, width: canvas ? canvas.width : -1 };
    });
    assert.equal(zeroInfo.count, 1);
    assert.equal(zeroInfo.width, 0);
    await page.evaluate(() => window.__zeroBeam.destroy());
  });
});

test('options are readable and colorVariant shifts the hue', async () => {
  await withBeam({ level: 1, colorVariant: 'colorful' }, async ({ page }) => {
    const shape = await page.evaluate(() => {
      const beam = window.__beam;
      return {
        hasSetLevel: typeof beam.setLevel,
        hasSetStream: typeof beam.setStream,
        hasSetProcessing: typeof beam.setProcessing,
        hasSetPaused: typeof beam.setPaused,
        hasDestroy: typeof beam.destroy,
        options: beam.options,
      };
    });
    assert.equal(shape.hasSetLevel, 'function');
    assert.equal(shape.hasSetStream, 'function');
    assert.equal(shape.hasSetProcessing, 'function');
    assert.equal(shape.hasSetPaused, 'function');
    assert.equal(shape.hasDestroy, 'function');
    const options = shape.options;
    assert.equal(options.type, 'pill');
    assert.equal(options.colorVariant, 'colorful');
    assert.equal(options.sensitivity, 1.6);
    assert.equal(options.threshold, 0.06);
    assert.equal(options.attack, 0.28);
    assert.equal(options.release, 0.09);
    assert.equal(options.reach, 0.62);
    assert.equal(options.spread, 0.55);
    assert.equal(options.flow, 0.35);
    assert.equal(options.bend, 0.18);
    assert.equal(options.idle, 0.08);
    assert.equal(options.theme, 'dark');
    assert.equal(options.strength, 1);
    assert.equal(options.active, true);
    assert.equal(options.paused, false);
    assert.equal(options.scale, 1);
    assert.equal(options.colors.length, 7);
    assert.equal(options.colors[0], '#FF6B6B');
    assert.equal(options.bandColors.core, '#ffffff');
    assert.equal(options.bandColors.above, '#FFD166');
    assert.equal(options.bandColors.mid, '#4D96FF');
    assert.equal(options.bandColors.below, '#B388FF');
    await page.waitForTimeout(400);
    const colorful = await sample(page, '#host canvas');
    await page.evaluate(() => {
      const second = document.createElement('div');
      second.id = 'mono-host';
      second.style.cssText = 'position:relative;width:420px;height:140px;border-radius:70px;overflow:hidden;background:#070b16';
      document.body.appendChild(second);
      window.__monoBeam = window.DisplayOSVoiceBeam(second, { level: 1, colorVariant: 'mono' });
    });
    await page.waitForTimeout(400);
    const mono = await sample(page, '#mono-host canvas');
    assert.ok(colorful.nonTransparent > 0, 'colorful canvas drew pixels');
    assert.ok(mono.nonTransparent > 0, 'mono canvas drew pixels');
    assert.ok(colorful.saturation > mono.saturation + 0.1, `saturation colorful ${colorful.saturation} mono ${mono.saturation}`);
    await page.evaluate(() => window.__monoBeam.destroy());
  });
});
