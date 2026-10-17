import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSnapshot, validateSettings, capabilities, sampleSnapshot } from '../src/product/family.js';

const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const sample = () => sampleSnapshot(NOW);
const settings = () => ({ timezone: 'America/New_York', quietAfterSeconds: 120, nightStart: '22:00', nightEnd: '07:00', brightness: 75, orientation: 'landscape', showPhotos: true });

test('sample is labeled synthetic and optional lists normalize without sharing input', () => {
  const input = { schemaVersion: 1, timezone: 'UTC', generatedAt: NOW, expiresAt: NOW + 1, briefing: { title: 'Today', text: 'Welcome home' } };
  const result = validateSnapshot(input, NOW);
  for (const field of ['weather', 'week', 'reminders', 'kids', 'parents', 'news', 'prompts', 'nearby', 'photos']) assert.deepEqual(result[field], []);
  result.briefing.title = 'Changed';
  assert.equal(input.briefing.title, 'Today');
  assert.match(sample().briefing.text, /sample/i);
  assert.equal(capabilities().timestampFormat, 'unix-milliseconds');
});

test('unknown fields fail at every family nesting boundary', () => {
  const changes = [value => { value.url = 'x'; }, value => { value.briefing.html = 'x'; }, value => { value.weather[0].url = 'x'; }, value => { value.week[0].events[0].url = 'x'; }, value => { value.reminders[0].raw = 'x'; }, value => { value.kids[0].extra = 'x'; }, value => { value.parents[0].extra = 'x'; }, value => { value.news[0].url = 'x'; }, value => { value.nearby[0].url = 'x'; }];
  for (const change of changes) { const value = sample(); change(value); assert.throws(() => validateSnapshot(value, NOW)); }
});

test('text rejects unsafe markup, links, controls, empty and excessive fields', () => {
  for (const text of ['<script>bad</script>', '&lt;img&gt;', 'https://example.com', 'javascript:alert(1)', 'data:text/html,x', '\u202Ehidden', 'x\u0000y', '  ', 'x'.repeat(241)]) {
    const value = sample(); value.briefing.text = text; assert.throws(() => validateSnapshot(value, NOW));
  }
  const value = sample(); value.briefing.title = 'x'.repeat(81); assert.throws(() => validateSnapshot(value, NOW));
});

test('all top-level and nested list bounds reject rather than silently truncate', () => {
  for (const [field, max] of Object.entries(capabilities().bounds)) {
    if (['events', 'items', 'photos', 'listItems', 'sceneBlocks', 'sceneRows', 'sceneChips', 'sceneSteps', 'sceneBars'].includes(field)) continue;
    const value = sample(); value[field] = Array.from({ length: max + 1 }, () => structuredClone(value[field][0])); assert.throws(() => validateSnapshot(value, NOW));
  }
  const events = sample(); events.week[0].events = Array(3).fill(events.week[0].events[0]); assert.throws(() => validateSnapshot(events, NOW));
  const kids = sample(); kids.kids[0].items = Array(4).fill('School'); assert.throws(() => validateSnapshot(kids, NOW));
  const photos = sample(); photos.photos = Array.from({ length: 21 }, (_, index) => 'photo_reference_' + index); assert.throws(() => validateSnapshot(photos, NOW));
  photos.photos.pop(); assert.equal(validateSnapshot(photos, NOW).photos.length, 20);
});

test('dates, zones and temperatures are real and duplicate days fail', () => {
  for (const date of ['2026-02-30', '2026-13-01', '10/10/2026']) { const value = sample(); value.weather[0].date = date; assert.throws(() => validateSnapshot(value, NOW)); }
  for (const timezone of ['Nowhere/Unknown', '<img>', 'UTC\u0000', '']) { const value = sample(); value.timezone = timezone; assert.throws(() => validateSnapshot(value, NOW)); }
  for (const temperature of [NaN, Infinity, '21', 101, -101]) { const value = sample(); value.weather[0].high = temperature; assert.throws(() => validateSnapshot(value, NOW)); }
  const value = sample(); value.weather.push(value.weather[0]); assert.throws(() => validateSnapshot(value, NOW));
  value.weather = [{ ...value.weather[0], low: 50 }]; assert.throws(() => validateSnapshot(value, NOW));
});

test('timestamp freshness, version, expiry, total UTF-8 length and reference bounds fail closed', () => {
  for (const change of [value => { value.schemaVersion = 2; }, value => { value.generatedAt = NOW - 300001; }, value => { value.generatedAt = NOW + 300001; }, value => { value.expiresAt = NOW; }, value => { value.expiresAt = NOW + 86400001; }, value => { value.generatedAt = String(NOW); }, value => { value.photos = ['https://example.com/image.jpg']; }, value => { value.photos = ['photo_reference_1', 'photo_reference_1']; }, value => { value.photos = ['short']; }, value => { value.extra = '😀'.repeat(20000); }]) {
    const value = sample(); change(value); assert.throws(() => validateSnapshot(value, NOW));
  }
  const value = sample(); value.photos = ['photo_reference_1']; assert.deepEqual(validateSnapshot(value, NOW).photos, ['photo_reference_1']);
});

test('display scenes and voice acks stay typed, bounded and plain text', () => {
  const scene = { id: 'scene-000001', kind: 'answer', title: 'Here is the week', subtitle: 'From your helper', blocks: [{ type: 'rows', rows: [{ label: 'Mon', value: 'Soccer', tone: 'good' }] }, { type: 'chips', chips: ['Milk', 'Eggs'] }, { type: 'steps', steps: ['Pack bags'] }, { type: 'bars', bars: [{ label: 'Done', value: 0.5 }] }, { type: 'text', text: 'All set' }], ttlSeconds: 300 };
  const value = sample(); value.displayScene = scene; value.voiceAck = { id: 'voice-000001', state: 'heard', heard: 'add milk to groceries', agentName: 'Maya' };
  const result = validateSnapshot(value, NOW);
  assert.equal(result.displayScene.blocks.length, 5);
  assert.equal(result.displayScene.blocks[0].rows[0].tone, 'good');
  assert.equal(result.voiceAck.state, 'heard');
  const none = sample(); delete none.displayScene; delete none.voiceAck;
  assert.equal(validateSnapshot(none, NOW).displayScene, undefined);
  for (const change of [
    v => { v.displayScene.kind = 'mystery'; },
    v => { v.displayScene.blocks = Array(7).fill({ type: 'text', text: 'x' }); },
    v => { v.displayScene.blocks = [{ type: 'html', text: '<script>' }]; },
    v => { v.displayScene.blocks = [{ type: 'text', text: 'https://example.com' }]; },
    v => { v.displayScene.blocks = [{ type: 'rows', rows: [{ label: 'a', value: 'b', tone: 'loud' }] }]; },
    v => { v.displayScene.blocks = [{ type: 'bars', bars: [{ label: 'x', value: 2 }] }]; },
    v => { v.displayScene.ttlSeconds = 10; },
    v => { v.displayScene.title = ''; },
    v => { v.displayScene.extra = 1; },
    v => { v.voiceAck.state = 'maybe'; },
    v => { v.voiceAck.id = 'short'; },
    v => { v.voiceAck.heard = '<img>'; },
  ]) { const next = sample(); next.displayScene = JSON.parse(JSON.stringify(scene)); next.voiceAck = { id: 'voice-000001', state: 'heard' }; change(next); assert.throws(() => validateSnapshot(next, NOW)); }
});

test('settings support valid values and reject missing, unknown and out-of-range values', () => {
  assert.deepEqual(validateSettings(settings()), settings());
  for (const [field, bad] of [['quietAfterSeconds', 29], ['quietAfterSeconds', 1801], ['quietAfterSeconds', 30.5], ['brightness', 9], ['brightness', 101], ['nightStart', '24:00'], ['nightEnd', '7:00'], ['orientation', 'diagonal'], ['showPhotos', 'true'], ['timezone', 'Invalid/Zone'], ['extra', 1]]) {
    const value = settings(); value[field] = bad; assert.throws(() => validateSettings(value));
  }
  const value = settings(); delete value.brightness; assert.throws(() => validateSettings(value));
});

test('family lists keep groceries and to-dos bounded with plain text and stable references', () => {
  const good = { id: 'groceries-01', title: 'Groceries', kind: 'groceries', items: [{ id: 'item-0001', text: 'Milk', person: 'Everyone', done: false }, { id: 'item-0002', text: 'Bread', done: true }] };
  const value = sample(); value.lists = [good, { id: 'todo-list-1', title: 'Weekend jobs', kind: 'todo', items: [] }];
  const result = validateSnapshot(value, NOW);
  assert.equal(result.lists.length, 2);
  assert.equal(result.lists[0].items[1].done, true);
  assert.equal(result.lists[0].items[1].person, undefined);
  const missing = sample(); delete missing.lists; assert.deepEqual(validateSnapshot(missing, NOW).lists, []);
  for (const change of [
    list => { list.lists = Array.from({ length: 5 }, (_, index) => ({ ...good, id: 'list-' + index + '00' })); },
    list => { list.lists = [{ ...good, items: Array.from({ length: 13 }, (_, index) => ({ id: 'item-' + String(index).padStart(4, '0'), text: 'Thing ' + index })) }]; },
    list => { list.lists = [{ ...good, kind: 'wishlist' }]; },
    list => { list.lists = [{ ...good, title: '' }]; },
    list => { list.lists = [{ ...good, title: 'x'.repeat(41) }]; },
    list => { list.lists = [{ ...good, id: 'short' }]; },
    list => { list.lists = [{ ...good, items: [{ id: 'item-0001', text: '' }] }]; },
    list => { list.lists = [{ ...good, items: [{ id: 'item-0001', text: 'https://example.com' }] }]; },
    list => { list.lists = [{ ...good, items: [{ id: 'item-0001', text: 'Milk', done: 'yes' }] }]; },
    list => { list.lists = [{ ...good, items: [{ id: 'item-0001', text: 'Milk' }, { id: 'item-0001', text: 'Eggs' }] }]; },
    list => { list.lists = [{ ...good, id: good.id }, { ...good, id: good.id }]; },
    list => { list.lists = [{ ...good, items: [{ id: 'item-0001', text: 'Milk', extra: 1 }] }]; },
  ]) { const next = sample(); change(next); assert.throws(() => validateSnapshot(next, NOW)); }
});
