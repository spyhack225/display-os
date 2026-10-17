import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordStore } from '../src/product/store.js';
import { readJson, exact, text, bearer } from '../src/product/common.js';

class MemoryStorage {
  constructor(values = new Map()) { this.values = values; }
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async delete(key) { return this.values.delete(key); }
  async list({ prefix, limit }) { return new Map([...this.values].filter(([key]) => key.startsWith(prefix)).slice(0, limit)); }
  async transaction(callback) { const transaction = new MemoryStorage(structuredClone(this.values)); const result = await callback(transaction); this.values = transaction.values; return result; }
}

test('product records are encrypted and bound to their actor and record key', async () => {
  const storage = new MemoryStorage();
  const store = new RecordStore(storage, '1'.repeat(64), 'home-one');
  await store.put('family', { title: 'Private family event' });
  assert.ok(!JSON.stringify([...storage.values]).includes('Private family event'));
  assert.deepEqual(await store.get('family'), { title: 'Private family event' });
  await assert.rejects(new RecordStore(storage, '2'.repeat(64), 'home-one').get('family'));
  await assert.rejects(new RecordStore(storage, '1'.repeat(64), 'home-two').get('family'));
  storage.values.set('copied', storage.values.get('family'));
  await assert.rejects(store.get('copied'));
});

test('transaction rollback does not acknowledge partial records', async () => {
  const store = new RecordStore(new MemoryStorage(), '1'.repeat(64), 'one');
  await store.put('value', { count: 1 });
  await assert.rejects(store.transaction(async transaction => { await transaction.put('value', { count: 2 }); await transaction.put('extra', {}); throw new Error('write failure'); }));
  assert.deepEqual(await store.get('value'), { count: 1 });
  assert.equal(await store.get('extra'), undefined);
});

test('record values and request bodies enforce byte limits', async () => {
  const store = new RecordStore(new MemoryStorage(), '1'.repeat(64), 'one');
  await assert.rejects(store.put('large', { value: 'a'.repeat(90000) }), { status: 413 });
  const request = new Request('https://example.com', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: 'a'.repeat(100) }) });
  await assert.rejects(readJson(request, 64), { status: 413 });
});

test('product command boundaries reject executable values and ambiguous authority', () => {
  assert.throws(() => exact({ key: 'value', role: 'owner' }, ['key']), { status: 400 });
  assert.throws(() => text('<script>'), { status: 400 });
  assert.throws(() => text('hello\nworld'), { status: 400 });
  assert.throws(() => bearer(new Request('https://example.com', { headers: { Authorization: 'Basic token' } })), { status: 401 });
});
