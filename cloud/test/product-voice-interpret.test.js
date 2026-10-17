import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSnapshot, sampleSnapshot } from '../src/product/family.js';
import { transcribeVoice, interpretVoice } from '../src/product/voice.js';

const NOW = Date.parse('2026-10-10T12:00:00.000Z');
const REFERENCE = /^[A-Za-z0-9]{8,64}$/;

function validScene(scene) {
  return validateSnapshot({ ...sampleSnapshot(NOW), displayScene: scene }, NOW).displayScene;
}

function familySnapshot(extra = {}) {
  return {
    lists: [
      { id: 'list-groceries-01', title: 'Groceries', kind: 'groceries', items: [
        { id: 'item-milk-000001', text: 'Milk', person: 'Everyone', done: false },
        { id: 'item-eggs-000001', text: 'Eggs', person: 'Sam', done: true },
        { id: 'item-bread-00001', text: 'Bread', done: false },
        { id: 'item-bagels-0001', text: 'Bagels', done: true }
      ] },
      { id: 'list-todo-0000001', title: 'To do', kind: 'todo', items: [
        { id: 'item-dentist-0001', text: 'Book dentist', person: 'Alex', done: false },
        { id: 'item-paint-000001', text: 'Paint the hall', done: true },
        { id: 'item-bins-0000001', text: 'Take out the bins', done: false }
      ] },
      { id: 'list-costco-00001', title: 'Costco run', kind: 'groceries', items: [
        { id: 'item-rice-0000001', text: 'Rice', done: false }
      ] }
    ],
    weather: [
      { date: '2026-10-10', label: 'Today', high: 21, low: 14, condition: 'Bright' },
      { date: '2026-10-11', label: 'Sunday', high: 18, low: 11, condition: 'Showers' }
    ],
    week: [
      { date: '2026-10-10', events: [{ title: 'Soccer practice', time: '4:00 pm', person: 'Sam' }] },
      { date: '2026-10-11', events: [] },
      { date: '2026-10-12', events: [{ title: 'Dentist appointment for Alex and a very long title that runs well past eighty characters', time: '9:00 am', person: 'Alex' }] }
    ],
    reminders: [
      { title: 'Water the plants', time: 'After breakfast', person: 'Everyone' },
      { title: 'Call Grandma', person: 'Sam' },
      { title: 'Stretch your back' }
    ],
    ...extra
  };
}

test('add to the groceries list creates a list edit and a valid scene', () => {
  const result = interpretVoice('add Milk to the groceries list', familySnapshot());
  assert.equal(result.listEdit.action, 'add');
  assert.equal(result.listEdit.listId, 'list-groceries-01');
  assert.match(result.listEdit.item.id, REFERENCE);
  assert.equal(result.listEdit.item.text, 'milk');
  const scene = validScene(result.displayScene);
  assert.equal(scene.kind, 'list');
  assert.equal(scene.title, 'Added to Groceries');
  assert.equal(scene.subtitle, 'milk');
  assert.equal(scene.ttlSeconds, 600);
  assert.match(scene.id, REFERENCE);
  assert.deepEqual(scene.blocks, [{ type: 'rows', rows: [{ label: 'Item', value: 'milk', tone: 'good' }] }]);
});

test('add to the to-do list targets the todo kind', () => {
  const result = interpretVoice('add book dentist to the to-do list', familySnapshot());
  assert.equal(result.listEdit.listId, 'list-todo-0000001');
  assert.equal(result.listEdit.item.text, 'book dentist');
  const scene = validScene(result.displayScene);
  assert.equal(scene.kind, 'list');
  assert.equal(scene.title, 'Added to To do');
  assert.equal(scene.subtitle, 'book dentist');
});

test('add to a named list matches the list title', () => {
  const result = interpretVoice('add quinoa to costco', familySnapshot());
  assert.equal(result.listEdit.listId, 'list-costco-00001');
  assert.equal(result.listEdit.item.text, 'quinoa');
  assert.equal(validScene(result.displayScene).title, 'Added to Costco run');
  const named = interpretVoice('put rice on the costco list', familySnapshot());
  assert.equal(named.listEdit.listId, 'list-costco-00001');
  validScene(named.displayScene);
});

test('add to an unknown list drops the edit and explains it', () => {
  const result = interpretVoice('add milk to nowhere', familySnapshot());
  assert.equal(result.listEdit, undefined);
  const scene = validScene(result.displayScene);
  assert.equal(scene.kind, 'note');
  assert.equal(scene.title, 'Could not find that list');
  assert.deepEqual(scene.blocks, [{ type: 'text', text: 'Tell me the list name again.' }]);
});

test('tick off and mark done toggle the first open match', () => {
  const ticked = interpretVoice('tick milk off', familySnapshot());
  assert.deepEqual(ticked.listEdit, { listId: 'list-groceries-01', action: 'toggle', itemId: 'item-milk-000001' });
  const scene = validScene(ticked.displayScene);
  assert.equal(scene.kind, 'list');
  assert.equal(scene.title, 'Done');
  assert.deepEqual(scene.blocks, [{ type: 'rows', rows: [{ label: 'Item', value: 'milk', tone: 'good' }] }]);
  const marked = interpretVoice('mark bread done', familySnapshot());
  assert.deepEqual(marked.listEdit, { listId: 'list-groceries-01', action: 'toggle', itemId: 'item-bread-00001' });
  validScene(marked.displayScene);
});

test('tick off reports a missing item instead of guessing', () => {
  for (const phrase of ['check unicorn off', 'mark eggs done', 'tick painting off']) {
    const result = interpretVoice(phrase, familySnapshot());
    assert.equal(result.listEdit, undefined);
    const scene = validScene(result.displayScene);
    assert.equal(scene.kind, 'note');
    assert.equal(scene.title, 'Could not find that item');
    assert.deepEqual(scene.blocks, [{ type: 'text', text: 'Tell me the item name again.' }]);
  }
});

test('remove drops the first matching item in any list', () => {
  const result = interpretVoice('remove milk', familySnapshot());
  assert.deepEqual(result.listEdit, { listId: 'list-groceries-01', action: 'remove', itemId: 'item-milk-000001' });
  const scene = validScene(result.displayScene);
  assert.equal(scene.kind, 'list');
  assert.equal(scene.title, 'Removed');
  assert.deepEqual(scene.blocks, [{ type: 'rows', rows: [{ label: 'Item', value: 'milk' }] }]);
});

test('remove from a specific list scopes the search', () => {
  const scoped = interpretVoice('remove rice from the costco list', familySnapshot());
  assert.deepEqual(scoped.listEdit, { listId: 'list-costco-00001', action: 'remove', itemId: 'item-rice-0000001' });
  validScene(scoped.displayScene);
  const wrongList = interpretVoice('remove milk from costco', familySnapshot());
  assert.equal(wrongList.listEdit, undefined);
  assert.equal(validScene(wrongList.displayScene).title, 'Could not find that item');
});

test('remove of an unknown item drops the edit', () => {
  const result = interpretVoice('delete unicorn', familySnapshot());
  assert.equal(result.listEdit, undefined);
  assert.equal(validScene(result.displayScene).title, 'Could not find that item');
});

test('weather builds a forecast scene with rows and bars', () => {
  const result = interpretVoice('what is the weather', familySnapshot());
  assert.equal(result.listEdit, undefined);
  const scene = validScene(result.displayScene);
  assert.equal(scene.kind, 'answer');
  assert.equal(scene.title, 'Weather');
  assert.equal(scene.blocks.length, 2);
  assert.equal(scene.blocks[0].type, 'rows');
  assert.deepEqual(scene.blocks[0].rows, [
    { label: '2026-10-10', value: '21/14 C - Bright' },
    { label: '2026-10-11', value: '18/11 C - Showers' }
  ]);
  assert.equal(scene.blocks[1].type, 'bars');
  assert.deepEqual(scene.blocks[1].bars.map(bar => bar.label), ['10-10', '10-11']);
  assert.ok(Math.abs(scene.blocks[1].bars[0].value - 0.9) < 1e-9);
  assert.ok(Math.abs(scene.blocks[1].bars[1].value - 0.825) < 1e-9);
  assert.ok(scene.blocks[1].bars.every(bar => bar.value >= 0 && bar.value <= 1));
});

test('weather with no data explains it', () => {
  const result = interpretVoice('weather', { weather: [] });
  assert.equal(result.listEdit, undefined);
  const scene = validScene(result.displayScene);
  assert.equal(scene.kind, 'note');
  assert.equal(scene.title, 'No weather yet');
  validScene(interpretVoice('how is the weather today', {}).displayScene);
});

test('the week plan maps days to short labels and open slots', () => {
  const longTitle = 'Dentist appointment for Alex and a very long title that runs well past eighty characters';
  const result = interpretVoice("what's on the week", familySnapshot());
  const scene = validScene(result.displayScene);
  assert.equal(scene.kind, 'plan');
  assert.equal(scene.title, 'This week');
  assert.equal(scene.blocks.length, 1);
  assert.equal(scene.blocks[0].type, 'rows');
  const rows = scene.blocks[0].rows;
  assert.equal(rows.length, 3);
  assert.ok(rows[0].label.includes('Sat'));
  assert.equal(rows[0].value, 'Soccer practice');
  assert.equal(rows[1].value, 'Open');
  assert.equal(rows[2].value, longTitle.slice(0, 80));
  assert.ok(rows.every(entry => entry.label.length <= 80 && entry.value.length <= 80));
});

test('an empty week still produces a valid scene', () => {
  const result = interpretVoice('show me the plan', { week: [] });
  assert.equal(result.listEdit, undefined);
  assert.equal(validScene(result.displayScene).kind, 'note');
});

test('the groceries scene lists the groceries list items', () => {
  const result = interpretVoice('show me the groceries', familySnapshot());
  const scene = validScene(result.displayScene);
  assert.equal(scene.kind, 'list');
  assert.equal(scene.title, 'Groceries');
  assert.deepEqual(scene.blocks, [{ type: 'rows', rows: [
    { label: 'Milk', value: 'Everyone' },
    { label: 'Eggs', value: 'Sam', tone: 'good' },
    { label: 'Bread', value: 'Open' },
    { label: 'Bagels', value: 'Done', tone: 'good' }
  ] }]);
});

test('an empty groceries list says so', () => {
  for (const phrase of ['show the shopping list', 'grocery run']) {
    const result = interpretVoice(phrase, { lists: [] });
    assert.equal(result.listEdit, undefined);
    const scene = validScene(result.displayScene);
    assert.equal(scene.kind, 'note');
    assert.equal(scene.title, 'Nothing on the groceries list');
  }
});

test('the to-do scene lists the todo kind list', () => {
  const result = interpretVoice('what is on my todo list', familySnapshot());
  const scene = validScene(result.displayScene);
  assert.equal(scene.kind, 'list');
  assert.equal(scene.title, 'To do');
  assert.deepEqual(scene.blocks, [{ type: 'rows', rows: [
    { label: 'Book dentist', value: 'Alex' },
    { label: 'Paint the hall', value: 'Done', tone: 'good' },
    { label: 'Take out the bins', value: 'Open' }
  ] }]);
});

test('an empty to-do list says so', () => {
  const result = interpretVoice('show the to-do list', { lists: [] });
  assert.equal(result.listEdit, undefined);
  const scene = validScene(result.displayScene);
  assert.equal(scene.kind, 'note');
  assert.equal(scene.title, 'Nothing on the to-do list');
});

test('the reminders scene maps titles to times and people', () => {
  const result = interpretVoice('show my reminders', familySnapshot());
  const scene = validScene(result.displayScene);
  assert.equal(scene.kind, 'list');
  assert.equal(scene.title, 'Reminders');
  assert.deepEqual(scene.blocks, [{ type: 'rows', rows: [
    { label: 'Water the plants', value: 'After breakfast' },
    { label: 'Call Grandma', value: 'Sam' },
    { label: 'Stretch your back', value: 'Today' }
  ] }]);
});

test('empty reminders say so', () => {
  const result = interpretVoice('reminders please', { reminders: [] });
  assert.equal(result.listEdit, undefined);
  const scene = validScene(result.displayScene);
  assert.equal(scene.kind, 'note');
  assert.equal(scene.title, 'No reminders');
});

test('unmatched talk becomes a heard-you note', () => {
  const result = interpretVoice('Tell me a joke about penguins', familySnapshot());
  assert.equal(result.listEdit, undefined);
  const scene = validScene(result.displayScene);
  assert.equal(scene.kind, 'note');
  assert.equal(scene.title, 'Heard you');
  assert.equal(scene.subtitle, 'Tell me a joke about penguins');
  assert.deepEqual(scene.blocks, [{ type: 'text', text: 'Ask your helper for anything more detailed.' }]);
});

test('empty talk and a missing snapshot stay graceful', () => {
  const empty = interpretVoice('', null);
  const scene = validScene(empty.displayScene);
  assert.equal(scene.title, 'Heard you');
  assert.equal(scene.subtitle, undefined);
  const missing = interpretVoice('add milk to groceries', undefined);
  assert.equal(missing.listEdit, undefined);
  assert.equal(validScene(missing.displayScene).title, 'Could not find that list');
  assert.equal(validScene(interpretVoice(undefined, null).displayScene).title, 'Heard you');
});

test('list edit text is truncated to 80 characters and ids are short references', () => {
  const result = interpretVoice('add ' + 'x'.repeat(300) + ' to groceries', familySnapshot());
  assert.equal(result.listEdit.item.text, 'x'.repeat(80));
  assert.match(result.listEdit.item.id, REFERENCE);
  const scene = validScene(result.displayScene);
  assert.match(scene.id, REFERENCE);
  assert.equal(scene.id.length, 12);
  assert.equal(scene.subtitle, 'x'.repeat(240));
  assert.equal(scene.blocks[0].rows[0].value, 'x'.repeat(80));
});

test('every scene kind stays schema valid for null snapshots', () => {
  for (const phrase of ['add milk to groceries', 'tick milk off', 'remove milk', 'weather', "what's on the week", 'show the groceries', 'show the to-do list', 'remind me', 'hello there']) {
    validScene(interpretVoice(phrase, null).displayScene);
    validScene(interpretVoice(phrase, {}).displayScene);
  }
});

test('transcribeVoice returns null without a key or binding', async () => {
  assert.equal(await transcribeVoice(new Uint8Array([1, 2, 3]), 'audio/webm', {}), null);
  assert.equal(await transcribeVoice(new Uint8Array([1, 2, 3]), 'audio/webm', {}), null);
});

test('transcribeVoice posts multipart audio when the key is set', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ text: '  hello there  ' }) };
  };
  const bytes = new Uint8Array([9, 8, 7]);
  const result = await transcribeVoice(bytes, 'audio/webm', { VOICE_API_KEY: 'sk-test-key' }, fetchImpl);
  assert.equal(result, 'hello there');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer sk-test-key');
  assert.equal(calls[0].options.headers['Content-Type'], undefined);
  const form = calls[0].options.body;
  assert.ok(form instanceof FormData);
  assert.equal(form.get('model'), 'gpt-4o-transcribe');
  assert.equal(form.get('response_format'), 'json');
  const file = form.get('file');
  assert.ok(file instanceof File);
  assert.equal(file.name, 'clip.webm');
  assert.equal(file.type, 'audio/webm');
  assert.deepEqual([...new Uint8Array(await file.arrayBuffer())], [9, 8, 7]);
});

test('transcribeVoice returns null when the network or the provider fails', async () => {
  const key = { VOICE_API_KEY: 'sk-test-key' };
  const throwing = async () => { throw new Error('network down'); };
  assert.equal(await transcribeVoice(new Uint8Array([1]), 'audio/webm', key, throwing), null);
  const failing = async () => ({ ok: false, status: 502, json: async () => ({ text: 'ignored' }) });
  assert.equal(await transcribeVoice(new Uint8Array([1]), 'audio/webm', key, failing), null);
  const badJson = async () => ({ ok: true, json: async () => { throw new Error('bad json'); } });
  assert.equal(await transcribeVoice(new Uint8Array([1]), 'audio/webm', key, badJson), null);
});

test('transcribeVoice falls back to the workers AI binding', async () => {
  const calls = [];
  const env = { AI: { run: async (model, input) => { calls.push({ model, input }); return { text: 'from the binding' }; } } };
  const result = await transcribeVoice(new Uint8Array([1, 2]), 'audio/webm', env);
  assert.equal(result, 'from the binding');
  assert.equal(calls[0].model, '@cf/openai/whisper-tiny-en');
  assert.ok(Array.isArray(calls[0].input.audio));
  assert.deepEqual(calls[0].input.audio, [1, 2]);
  const failing = { AI: { run: async () => { throw new Error('nope'); } } };
  assert.equal(await transcribeVoice(new Uint8Array([1]), 'audio/webm', failing), null);
  const silent = { AI: { run: async () => ({}) } };
  assert.equal(await transcribeVoice(new Uint8Array([1]), 'audio/webm', silent), null);
});

test('the api key path wins over the workers binding', async () => {
  let aiCalled = false;
  const env = { VOICE_API_KEY: 'sk-test-key', AI: { run: async () => { aiCalled = true; return { text: 'binding' }; } } };
  const fetchImpl = async () => ({ ok: true, json: async () => ({ text: 'from openai' }) });
  assert.equal(await transcribeVoice(new Uint8Array([1]), 'audio/webm', env, fetchImpl), 'from openai');
  assert.equal(aiCalled, false);
});
