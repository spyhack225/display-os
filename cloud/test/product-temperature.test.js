import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { validateSettings } from '../src/product/family.js';

const source = await readFile(new URL('../product-public/common.js', import.meta.url), 'utf8');
const sandbox = { window: {}, document: {} };
runInNewContext(source, sandbox);
const ui = sandbox.window.DisplayOSUI;
const settings = { timezone: 'UTC', quietAfterSeconds: 120, nightStart: '22:00', nightEnd: '07:00', brightness: 70, orientation: 'auto', showPhotos: true };

test('display units convert canonical Celsius without changing source values', () => {
  assert.equal(ui.temperature(22, 'fahrenheit'), '72°F');
  assert.equal(ui.temperature(0, 'fahrenheit'), '32°F');
  assert.equal(ui.temperature(-40, 'fahrenheit'), '-40°F');
  assert.equal(ui.temperature(22, 'celsius'), '22°C');
  assert.equal(ui.temperatureRange(10, 20, 'fahrenheit'), '50°F to 68°F');
  assert.equal(ui.temperatureRange(10, 20), '10°C to 20°C');
});

test('stored display preferences accept only supported units and retain older settings', () => {
  assert.deepEqual(validateSettings(settings), settings);
  for (const unit of ['celsius', 'fahrenheit']) assert.equal(validateSettings({ ...settings, temperatureUnit: unit }).temperatureUnit, unit);
  for (const unit of ['kelvin', 'F', null, 0, true]) assert.throws(() => validateSettings({ ...settings, temperatureUnit: unit }));
});
