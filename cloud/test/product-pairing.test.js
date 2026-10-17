import test from 'node:test';
import assert from 'node:assert/strict';
import { createPairing, removePairing, takeManualClaimBudget } from '../src/product/pairing.js';
import { digest, random } from '../src/product/common.js';
import { RecordStore } from '../src/product/store.js';

const ORIGIN = 'https://displayos.example.com';
const NOW = 1700000000000;
const BUDGET_KEY = 'pair-manual-budget';

class MemoryStorage {
  constructor(values = new Map(), root = null) { this.values = values; this.root = root || this; this.fail = null; this.writes = 0; }
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) {
    if (this.root.fail?.(key, value)) { this.root.fail = null; throw new Error('Injected write failure'); }
    this.root.writes++;
    this.values.set(key, structuredClone(value));
  }
  async delete(key) { this.root.writes++; return this.values.delete(key); }
  async list(prefix, limit) { return new Map([...this.values].filter(([key]) => key.startsWith(prefix)).slice(0, limit)); }
  async transaction(callback) {
    const transaction = new MemoryStorage(structuredClone(this.values), this.root);
    const result = await callback(transaction);
    this.values = transaction.values;
    return result;
  }
}

async function fixture(encrypted = false) {
  const storage = new MemoryStorage();
  const store = encrypted ? new RecordStore(storage, '1'.repeat(64), 'registry') : storage;
  const device = { id: random(18), epoch: 1, state: 'unclaimed', keyHash: 'current-key', name: 'Real prepared screen' };
  await store.put('device:' + device.id, device);
  return { storage, store, device };
}

function randomSequence(testcase, numbers, bytes = []) {
  let numberIndex = 0;
  let byteIndex = 0;
  testcase.mock.method(crypto, 'getRandomValues', array => {
    if (array instanceof Uint32Array) { assert.ok(numberIndex < numbers.length, 'unexpected numeric draw'); array[0] = numbers[numberIndex++]; }
    else { assert.ok(array instanceof Uint8Array && array.length === 16); array.fill(bytes[byteIndex++] ?? byteIndex); }
    return array;
  });
  return { draws: () => numberIndex };
}

test('pairing issues an independent 128-bit QR and leading-zero six-digit manual code atomically', async testcase => {
  const { store, device } = await fixture();
  randomSequence(testcase, [42], [0xAB]);
  const pairing = await createPairing(store, device, ORIGIN, NOW);
  assert.deepEqual(pairing, { code: 'AB'.repeat(16), manualCode: '000042', expiresAt: NOW + 120000, url: ORIGIN + '/home#pair=' + 'AB'.repeat(16) });
  const codeHash = await digest(pairing.code);
  const pointer = { deviceId: device.id, epoch: device.epoch, expiresAt: pairing.expiresAt, codeHash };
  assert.deepEqual(await store.get('pair:' + codeHash), pointer);
  assert.deepEqual(await store.get('pair-manual:' + await digest('000042')), pointer);
  assert.deepEqual(await store.get('device:' + device.id), { ...device, pairing });
  assert.equal(pairing.url.includes(pairing.manualCode), false);
});

test('Uint32 rejection sampling discards the biased tail and accepts all six-digit endpoints', async testcase => {
  const { store, device } = await fixture();
  const sequence = randomSequence(testcase, [4294967295, 4294000000, 4293999999, 0], [1, 2]);
  const last = await createPairing(store, device, ORIGIN, NOW);
  assert.equal(last.manualCode, '999999');
  const first = await createPairing(store, device, ORIGIN, NOW + 120000);
  assert.equal(first.manualCode, '000000');
  assert.equal(sequence.draws(), 4);
});

test('live manual and QR collisions retry without overwriting another device', async testcase => {
  const { store, device } = await fixture();
  const manualKey = 'pair-manual:' + await digest('000007');
  const qrKey = 'pair:' + await digest('02'.repeat(16));
  const occupied = { deviceId: random(18), epoch: 3, expiresAt: NOW + 1, codeHash: 'another-pair' };
  await store.put(manualKey, occupied);
  await store.put(qrKey, occupied);
  randomSequence(testcase, [7, 8, 9], [1, 2, 3]);
  const pairing = await createPairing(store, device, ORIGIN, NOW);
  assert.equal(pairing.manualCode, '000009');
  assert.equal(pairing.code, '03'.repeat(16));
  assert.deepEqual(await store.get(manualKey), occupied);
  assert.deepEqual(await store.get(qrKey), occupied);
  assert.equal(await store.get('pair:' + await digest('01'.repeat(16))), undefined);
});

test('generation stops after sixteen collisions and leaves all records untouched', async testcase => {
  const { store, device } = await fixture();
  await store.put('pair-manual:' + await digest('000007'), { expiresAt: NOW + 1 });
  const before = structuredClone(store.values);
  const sequence = randomSequence(testcase, Array(16).fill(7), Array(16).fill(1));
  await assert.rejects(createPairing(store, device, ORIGIN, NOW), { status: 503 });
  assert.equal(sequence.draws(), 16);
  assert.deepEqual(store.values, before);
});

test('a broken entropy source fails boundedly without issuing a biased manual code', async testcase => {
  const { store, device } = await fixture();
  const before = structuredClone(store.values);
  const sequence = randomSequence(testcase, Array(16).fill(4294000000), [1]);
  await assert.rejects(createPairing(store, device, ORIGIN, NOW), { status: 503 });
  assert.equal(sequence.draws(), 16);
  assert.deepEqual(store.values, before);
});

test('expired aliases can be recycled but an old pairing cannot remove the new owner', async testcase => {
  const { store, device } = await fixture();
  const second = { ...device, id: random(18), epoch: 2 };
  await store.put('device:' + second.id, second);
  randomSequence(testcase, [42, 42], [1, 2]);
  const old = await createPairing(store, device, ORIGIN, NOW);
  const newer = await createPairing(store, second, ORIGIN, old.expiresAt);
  const manualKey = 'pair-manual:' + await digest(old.manualCode);
  const pointer = await store.get(manualKey);
  await store.transaction(transaction => removePairing(transaction, old));
  assert.equal(await store.get('pair:' + await digest(old.code)), undefined);
  assert.deepEqual(await store.get(manualKey), pointer);
  assert.equal(pointer.codeHash, await digest(newer.code));
  assert.equal(pointer.deviceId, second.id);
  await store.transaction(transaction => removePairing(transaction, newer));
  assert.equal(await store.get(manualKey), undefined);
  assert.equal(await store.get('pair:' + await digest(newer.code)), undefined);
  await store.transaction(transaction => removePairing(transaction, old));
});

test('cleanup protects a reused QR and numeric alias even when the QR hash is identical', async testcase => {
  const { store, device } = await fixture();
  randomSequence(testcase, [12, 12], [4, 4]);
  const old = await createPairing(store, device, ORIGIN, NOW);
  const newer = await createPairing(store, device, ORIGIN, old.expiresAt);
  const before = structuredClone(store.values);
  await store.transaction(transaction => removePairing(transaction, old));
  assert.deepEqual(store.values, before);
  assert.equal(newer.expiresAt, old.expiresAt + 120000);
});

test('legacy claim and expiry cleanup removes only hashless twelve-hex pointers with the exact expiry', async () => {
  for (const expired of [false, true]) {
    const { store, device } = await fixture();
    const pairing = { code: 'ABCDEF012345', expiresAt: NOW + (expired ? 0 : 120000), url: ORIGIN + '/home#pair=ABCDEF012345', manualCode: '123456' };
    const key = 'pair:' + await digest(pairing.code);
    const pointer = { deviceId: device.id, epoch: device.epoch, expiresAt: pairing.expiresAt };
    const manualKey = 'pair-manual:' + await digest(pairing.manualCode);
    const manualPointer = { ...pointer, expiresAt: NOW + 600000, codeHash: 'new-pair-owner' };
    await store.put(key, pointer);
    await store.put(manualKey, manualPointer);
    await store.put('device:' + device.id, { ...device, pairing });
    if (expired) {
      const replacement = await createPairing(store, device, ORIGIN, NOW);
      assert.match(replacement.code, /^[A-F0-9]{32}$/);
      assert.notEqual(replacement.code, pairing.code);
    } else await store.transaction(transaction => removePairing(transaction, pairing));
    assert.equal(await store.get(key), undefined);
    assert.deepEqual(await store.get(manualKey), manualPointer);
    await store.transaction(transaction => removePairing(transaction, pairing));
    assert.equal(await store.get(key), undefined);
    for (const protectedPointer of [{ ...pointer, expiresAt: pointer.expiresAt + 1 }, { ...pointer, codeHash: await digest(pairing.code) }, { ...pointer, codeHash: null }]) {
      await store.put(key, protectedPointer);
      await store.transaction(transaction => removePairing(transaction, pairing));
      assert.deepEqual(await store.get(key), protectedPointer);
    }
  }
});

test('unexpired pairing retries do not rotate codes, extend expiry or write unchanged records', async testcase => {
  const { store, device } = await fixture();
  randomSequence(testcase, [321], [1]);
  const first = await createPairing(store, device, ORIGIN, NOW);
  const writes = store.writes;
  assert.deepEqual(await createPairing(store, device, ORIGIN, NOW + 119999), first);
  assert.equal(store.writes, writes);
});

test('creation uses current stored device state and rejects stale epochs, missing devices and unsafe origins', async () => {
  const { store, device } = await fixture();
  for (const origin of ['http://displayos.example.com', ORIGIN + '/', ORIGIN + '/path', ORIGIN + '?query', 'https://user@displayos.example.com']) await assert.rejects(createPairing(store, device, origin, NOW), { status: 400 });
  for (const now of [-1, NaN, NOW + 0.5]) await assert.rejects(createPairing(store, device, ORIGIN, now), { status: 400 });
  await assert.rejects(createPairing(store, { ...device, epoch: 2 }, ORIGIN, NOW), { status: 409 });
  await store.put('device:' + device.id, { ...device, state: 'owned' });
  await assert.rejects(createPairing(store, device, ORIGIN, NOW), { status: 409 });
  await store.delete('device:' + device.id);
  await assert.rejects(createPairing(store, device, ORIGIN, NOW), { status: 409 });
});

test('all pairing writes roll back together, including cleanup of an expired previous pairing', async () => {
  for (const target of ['pair:', 'pair-manual:', 'device:']) {
    const { store, storage, device } = await fixture();
    const previous = await createPairing(store, device, ORIGIN, NOW);
    const before = structuredClone(storage.values);
    storage.fail = key => key.startsWith(target);
    await assert.rejects(createPairing(store, device, ORIGIN, previous.expiresAt));
    assert.deepEqual(storage.values, before);
  }
});

test('account admission is a persistent sliding ten-minute window with no partial charges on denial', async () => {
  const { store } = await fixture(); const accountId = random(16);
  for (let attempt = 0; attempt < 5; attempt++) await takeManualClaimBudget(store, accountId, '192.0.2.1', NOW + attempt * 1000);
  const before = await store.get(BUDGET_KEY);
  await assert.rejects(takeManualClaimBudget(store, accountId, '192.0.2.2', NOW + 599999), { status: 429 });
  assert.deepEqual(await store.get(BUDGET_KEY), before);
  await takeManualClaimBudget(store, accountId, '192.0.2.2', NOW + 600000);
  await assert.rejects(takeManualClaimBudget(store, accountId, '192.0.2.2', NOW + 600000), { status: 429 });
  await takeManualClaimBudget(store, accountId, '192.0.2.2', NOW + 601000);
  assert.equal((await store.get(BUDGET_KEY)).accounts[await digest(accountId)].length, 5);
});

test('IP admission shares twenty attempts across accounts and prunes only timestamps past ten minutes', async () => {
  const { store } = await fixture(); const accounts = Array.from({ length: 4 }, () => random(16));
  for (let attempt = 0; attempt < 20; attempt++) await takeManualClaimBudget(store, accounts[Math.floor(attempt / 5)], '192.0.2.1', NOW + attempt * 1000);
  const before = await store.get(BUDGET_KEY);
  await assert.rejects(takeManualClaimBudget(store, random(16), '192.0.2.1', NOW + 599999), { status: 429 });
  assert.deepEqual(await store.get(BUDGET_KEY), before);
  await takeManualClaimBudget(store, random(16), '192.0.2.1', NOW + 600000);
  assert.equal((await store.get(BUDGET_KEY)).ips[await digest('192.0.2.1')].length, 20);
});

test('global admission caps one hundred twenty attempts per sliding two minutes across accounts and IPs', async () => {
  const { store } = await fixture(); const accounts = Array.from({ length: 24 }, () => random(16));
  for (let attempt = 0; attempt < 120; attempt++) await takeManualClaimBudget(store, accounts[Math.floor(attempt / 5)], '192.0.2.' + Math.floor(attempt / 20), NOW + attempt * 100);
  const before = await store.get(BUDGET_KEY);
  await assert.rejects(takeManualClaimBudget(store, random(16), '198.51.100.1', NOW + 119999), { status: 429 });
  assert.deepEqual(await store.get(BUDGET_KEY), before);
  await takeManualClaimBudget(store, random(16), '198.51.100.1', NOW + 120000);
  assert.equal((await store.get(BUDGET_KEY)).global.length, 120);
});

test('account and IP bucket capacity are bounded at 128, retained callers work and expiry releases capacity', async () => {
  for (const category of ['accounts', 'ips']) {
    const { store } = await fixture(); const accounts = Array.from({ length: 128 }, () => random(16));
    for (let attempt = 0; attempt < 128; attempt++) {
      const now = NOW + (attempt >= 120 ? 120000 : 0);
      const accountId = category === 'accounts' ? accounts[attempt] : accounts[Math.floor(attempt / 5)];
      const ip = '192.0.2.' + (category === 'ips' ? attempt : Math.floor(attempt / 20));
      await takeManualClaimBudget(store, accountId, ip, now);
    }
    const before = await store.get(BUDGET_KEY);
    assert.equal(Object.keys(before[category]).length, 128);
    const accountId = category === 'accounts' ? random(16) : accounts[26];
    const ip = category === 'ips' ? '198.51.100.1' : '192.0.2.0';
    await assert.rejects(takeManualClaimBudget(store, accountId, ip, NOW + 240000), { status: 429 });
    assert.deepEqual(await store.get(BUDGET_KEY), before);
    await takeManualClaimBudget(store, category === 'accounts' ? accounts[0] : accounts[26], category === 'ips' ? '192.0.2.0' : '198.51.100.1', NOW + 240000);
    assert.ok(Buffer.byteLength(JSON.stringify(await store.get(BUDGET_KEY)), 'utf8') < 90000);
    await takeManualClaimBudget(store, random(16), '203.0.113.1', NOW + 840000);
    assert.equal(Object.keys((await store.get(BUDGET_KEY))[category]).length, 1);
  }
});

test('encrypted pairing pointers and manual budgets survive restart without storing raw account/IP bucket keys', async () => {
  const { store, storage, device } = await fixture(true);
  const pairing = await createPairing(store, device, ORIGIN, NOW);
  const accountId = random(16); const ip = '203.0.113.111';
  for (let attempt = 0; attempt < 5; attempt++) await takeManualClaimBudget(store, accountId, ip, NOW);
  const restarted = new RecordStore(storage, '1'.repeat(64), 'registry');
  assert.deepEqual(await restarted.get('device:' + device.id), { ...device, pairing });
  assert.equal((await restarted.get('pair-manual:' + await digest(pairing.manualCode))).codeHash, await digest(pairing.code));
  await assert.rejects(takeManualClaimBudget(restarted, accountId, ip, NOW), { status: 429 });
  const budget = await restarted.get(BUDGET_KEY);
  assert.equal(JSON.stringify(budget).includes(accountId), false);
  assert.equal(JSON.stringify(budget).includes(ip), false);
  const persisted = JSON.stringify([...storage.values]);
  for (const value of [pairing.code, pairing.manualCode, accountId, ip]) assert.equal(persisted.includes(value), false);
});

test('manual budget storage failure cannot charge any category or acknowledge admission', async () => {
  const { store, storage } = await fixture(); const accountId = random(16);
  await takeManualClaimBudget(store, accountId, '192.0.2.1', NOW);
  const before = structuredClone(storage.values);
  storage.fail = key => key === BUDGET_KEY;
  await assert.rejects(takeManualClaimBudget(store, accountId, '192.0.2.1', NOW + 1));
  assert.deepEqual(storage.values, before);
  await takeManualClaimBudget(store, accountId, '192.0.2.1', NOW + 1);
  assert.equal((await store.get(BUDGET_KEY)).global.length, 2);
});

test('clock rollback cannot clear recent budgets or expose account/IP identifiers in rejection messages', async () => {
  const { store } = await fixture(); const accountId = random(16); const ip = '192.0.2.77';
  for (let attempt = 0; attempt < 5; attempt++) await takeManualClaimBudget(store, accountId, ip, NOW);
  await assert.rejects(takeManualClaimBudget(store, accountId, ip, NOW - 1), error => error.status === 429 && !error.message.includes(accountId) && !error.message.includes(ip));
  for (const value of ['', 'bad\naddress', 'x'.repeat(81)]) await assert.rejects(takeManualClaimBudget(store, accountId, value, NOW), { status: 400 });
  await assert.rejects(takeManualClaimBudget(store, '', ip, NOW), { status: 400 });
});
