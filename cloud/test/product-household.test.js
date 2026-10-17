import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { random } from '../src/product/common.js';
import { sampleSnapshot } from '../src/product/family.js';

const durableObjectModule = 'data:text/javascript,' + encodeURIComponent('export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }');
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    return specifier === 'cloudflare:workers' ? { url: durableObjectModule, shortCircuit: true } : nextResolve(specifier, context);
  },
});
const { HouseholdState } = await import('../src/product/household.js');
hooks.deregister();

class MemoryStorage {
  constructor(values = new Map(), root = null) { this.values = values; this.root = root || this; this.fail = null; }
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) {
    if (this.root.fail?.(key)) { this.root.fail = null; throw new Error('Injected durable write failure'); }
    this.values.set(key, structuredClone(value));
  }
  async delete(key) { return this.values.delete(key); }
  async list({ prefix, limit }) {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix)).sort(([first], [second]) => first.localeCompare(second)).slice(0, limit));
  }
  async transaction(callback) {
    const transaction = new MemoryStorage(structuredClone(this.values), this.root);
    const result = await callback(transaction);
    this.values = transaction.values;
    return result;
  }
  async setAlarm(value) { this.root.alarm = value; }
  async deleteAlarm() { delete this.root.alarm; }
}

async function fixture() {
  const origin = 'https://household.example.com';
  const homeId = random(24);
  const storage = new MemoryStorage();
  const context = { id: { toString: () => homeId }, storage, blockConcurrencyWhile: callback => callback() };
  const env = { PRODUCT_STATE_KEY: '1'.repeat(64), FACTORY_CREDENTIAL: random() };
  const actor = new HouseholdState(context, env);
  const owner = { accountId: random(16) };
  const first = { id: random(24), epoch: 1 };
  const second = { id: random(24), epoch: 1 };
  async function call(command, input = {}, principal = owner, target = actor) {
    const response = await target.fetch(new Request(origin + '/internal', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DisplayOS-Internal': env.FACTORY_CREDENTIAL },
      body: JSON.stringify({ command, input, principal }),
    }));
    return { status: response.status, value: await response.json() };
  }
  assert.equal((await call('home.create', { id: homeId, name: 'Our home', accountId: owner.accountId, accountName: 'Alex' }, { system: true })).status, 200);
  for (const screen of [first, second]) assert.equal((await call('screen.attach', { deviceId: screen.id, epoch: screen.epoch, name: 'Family screen' }, { system: true })).status, 200);
  return { actor, storage, context, env, owner, first, second, call };
}

test('owner renames exactly one of two equally named screens without changing stable identities or deleting either', async () => {
  const { call, actor, first, second } = await fixture();
  const before = await actor.records.get('home');
  const renamed = await call('screen.rename', { deviceId: first.id, name: '  Kitchen  ' });
  assert.equal(renamed.status, 200);
  assert.deepEqual(renamed.value, { saved: true, screen: { id: first.id, name: 'Kitchen' } });
  const expected = structuredClone(before);
  expected.screens[0].name = 'Kitchen';
  assert.deepEqual(await actor.records.get('home'), expected);
  const listing = await call('screen.list');
  assert.deepEqual(listing.value.screens.map(({ id, name }) => ({ id, name })), [{ id: first.id, name: 'Kitchen' }, { id: second.id, name: 'Family screen' }]);
  const home = await call('home.get');
  assert.equal(home.value.screens.length, 2);
  assert.equal(home.value.screens[0].name, 'Kitchen');
});

test('rename preserves content, revision, settings, delivery receipt, grants, membership and sibling state', async () => {
  const { call, actor, first } = await fixture();
  const snapshot = sampleSnapshot();
  const publication = await call('family.publish', { deviceId: first.id, snapshot, expectedRevision: 0, idempotencyKey: 'before-rename' });
  assert.equal(publication.status, 200);
  const grant = await call('grant.create', { clientId: random(), label: 'Approved assistant', deviceIds: [first.id], scopes: ['display:read', 'settings:write'], expiresAt: Date.now() + 60000 });
  assert.equal(grant.status, 200);
  const delivery = await call('device.poll', {}, { deviceId: first.id, epoch: first.epoch });
  assert.equal(delivery.value.screenIdentifier, first.id.slice(-6).toUpperCase());
  assert.equal((await call('device.ack', { revision: delivery.value.revision, nonce: delivery.value.nonce }, { deviceId: first.id, epoch: first.epoch })).status, 200);
  const before = await actor.records.list('', 200);
  assert.equal((await call('screen.rename', { deviceId: first.id, name: 'Living room' })).status, 200);
  const expected = structuredClone(before);
  expected.get('home').screens[0].name = 'Living room';
  assert.deepEqual(await actor.records.list('', 200), expected);
  const after = await call('device.poll', {}, { deviceId: first.id, epoch: first.epoch });
  assert.equal(after.value.screenName, 'Living room');
  assert.equal(after.value.screenIdentifier, delivery.value.screenIdentifier);
  const expectedDelivery = { ...delivery.value, screenName: 'Living room' };
  assert.deepEqual(after.value, expectedDelivery);
  assert.equal((await call('revision.status', { deviceId: first.id, revision: 1 })).value.status, 'rendered');
});

test('only household owner browser authority can rename, never editors, agents, devices or service principals', async () => {
  const { call, actor, owner, first } = await fixture();
  const editor = { accountId: random(16) };
  const invitation = await call('member.invite');
  assert.equal((await call('member.accept', { code: invitation.value.code, accountId: editor.accountId, name: 'Sam' }, { system: true })).status, 200);
  const granted = await call('grant.create', { clientId: random(), label: 'Owner-approved assistant', deviceIds: [first.id], scopes: ['display:read', 'content:write', 'settings:write', 'media:write'], expiresAt: Date.now() + 60000 });
  const before = await actor.records.list('', 200);
  for (const principal of [
    editor, { accountId: random(16) }, { ...owner, grantId: granted.value.id, clientId: granted.value.clientId },
    { deviceId: first.id, epoch: first.epoch }, { ...owner, deviceId: first.id, epoch: first.epoch },
    { system: true }, { ...owner, system: true }, null,
  ]) {
    assert.equal((await call('screen.rename', { deviceId: first.id, name: 'Not authorized' }, principal)).status, 403);
    assert.deepEqual(await actor.records.list('', 200), before);
  }
});

test('names use the existing strict plain-text validator with a forty-character limit and no extra authority fields', async () => {
  const { call, actor, first } = await fixture();
  assert.equal((await call('screen.rename', { deviceId: first.id, name: 'a'.repeat(40) })).status, 200);
  const before = await actor.records.list('', 200);
  for (const name of ['', '   ', 'a'.repeat(41), '<script>', 'Kitchen\nRoom', 'Kitchen\u0000Room', 'Kitchen\u007fRoom', 42, null, ['Kitchen']]) {
    assert.equal((await call('screen.rename', { deviceId: first.id, name })).status, 400);
  }
  for (const extra of [{ epoch: 0 }, { homeId: random() }, { role: 'owner' }, { settings: {} }, { revision: 9 }]) {
    assert.equal((await call('screen.rename', { deviceId: first.id, name: 'Kitchen', ...extra })).status, 400);
  }
  for (const input of [null, [], {}, { deviceId: first.id }]) assert.equal((await call('screen.rename', input)).status, 400);
  assert.deepEqual(await actor.records.list('', 200), before);
});

test('ownership of another home does not authorize a foreign screen ID or a cross-home rename', async () => {
  const original = await fixture();
  const other = await fixture();
  const before = await original.actor.records.list('', 200);
  assert.equal((await original.call('screen.rename', { deviceId: original.first.id, name: 'Foreign owner' }, other.owner)).status, 403);
  assert.equal((await original.call('screen.rename', { deviceId: other.first.id, name: 'Foreign screen' })).status, 403);
  assert.deepEqual(await original.actor.records.list('', 200), before);
});

test('detached screens, stale device epochs and pending removal fences cannot be renamed', async () => {
  const { call, actor, first, second } = await fixture();
  assert.equal((await call('screen.detach', { deviceId: first.id, epoch: 2, operationId: random() }, { system: true })).status, 200);
  assert.equal((await call('screen.rename', { deviceId: first.id, name: 'Removed' })).status, 403);
  assert.equal((await call('screen.rename', { deviceId: second.id, name: 'Stale device' }, { deviceId: second.id, epoch: 0 })).status, 403);
  await actor.records.put('fence:' + second.id, { epoch: 2, operationId: random() });
  const before = await actor.records.list('', 200);
  assert.equal((await call('screen.rename', { deviceId: second.id, name: 'Fenced' })).status, 409);
  assert.deepEqual(await actor.records.list('', 200), before);
});

test('fresh and expired empty polls include the renamed screen label without inventing delivery receipts', async () => {
  const { call, actor, first } = await fixture();
  const before = await call('device.poll', {}, { deviceId: first.id, epoch: first.epoch });
  assert.equal(before.value.screenIdentifier, first.id.slice(-6).toUpperCase());
  assert.equal((await call('screen.rename', { deviceId: first.id, name: 'Kitchen' })).status, 200);
  const fresh = await call('device.poll', {}, { deviceId: first.id, epoch: first.epoch });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.value.snapshot, null);
  assert.equal(fresh.value.screenName, 'Kitchen');
  assert.equal(fresh.value.screenIdentifier, before.value.screenIdentifier);
  assert.equal(fresh.value.revision, 0);
  assert.equal((await actor.records.list('receipt:', 25)).size, 0);
  const snapshot = sampleSnapshot();
  await actor.records.put('content:' + first.id, { snapshot, revision: 0, epoch: first.epoch, expiresAt: Date.now() - 1 });
  const expired = await call('device.poll', {}, { deviceId: first.id, epoch: first.epoch });
  assert.equal(expired.value.snapshot, null);
  assert.equal(expired.value.screenName, 'Kitchen');
  assert.equal(expired.value.screenIdentifier, before.value.screenIdentifier);
  assert.equal((await actor.records.list('receipt:', 25)).size, 0);
  for (const value of [fresh.value, expired.value]) for (const key of ['serial', 'key', 'keyHash', 'deviceToken', 'hardwareProfile']) assert.equal(value[key], undefined);
  for (const principal of [null, { deviceId: first.id, epoch: 0 }, { deviceId: random(24), epoch: 1 }]) {
    const denied = await call('device.poll', {}, principal);
    assert.equal(denied.status, 403);
    assert.equal(denied.value.screenIdentifier, undefined);
  }
});

test('failed durable rename rolls back and never acknowledges success', async () => {
  const { call, actor, storage, first } = await fixture();
  const before = await actor.records.list('', 200);
  const raw = structuredClone(storage.values);
  storage.fail = key => key === 'home';
  const response = await call('screen.rename', { deviceId: first.id, name: 'Kitchen' });
  assert.equal(response.status, 503);
  assert.equal(response.value.saved, undefined);
  assert.deepEqual(await actor.records.list('', 200), before);
  assert.deepEqual(storage.values, raw);
});

test('encrypted household reload retains renamed labels and same-name retry leaves semantic state unchanged', async () => {
  const { call, actor, context, env, storage, first } = await fixture();
  assert.equal((await call('screen.rename', { deviceId: first.id, name: 'Kitchen' })).status, 200);
  assert.ok(!JSON.stringify([...storage.values.values()]).includes('Kitchen'));
  const restarted = new HouseholdState(context, env);
  const before = await actor.records.list('', 200);
  assert.equal((await call('screen.rename', { deviceId: first.id, name: 'Kitchen' }, undefined, restarted)).status, 200);
  assert.deepEqual(await restarted.records.list('', 200), before);
  const delivery = await call('device.poll', {}, { deviceId: first.id, epoch: first.epoch }, restarted);
  assert.equal(delivery.value.screenName, 'Kitchen');
  assert.equal(delivery.value.screenIdentifier, first.id.slice(-6).toUpperCase());
});
test('unit-only preferences preserve every screen privacy setting and family content', async () => {
  const { call, actor, first } = await fixture();
  const initial = await actor.records.get('home');
  const custom = { ...initial.settings, timezone: 'America/New_York', nightStart: '00:00', nightEnd: '23:59', showPhotos: false, brightness: 35 };
  assert.equal((await call('screen.settings', { deviceId: first.id, settings: custom })).status, 200);
  const snapshot = { ...sampleSnapshot(), timezone: custom.timezone };
  assert.equal((await call('family.publish', { deviceId: first.id, snapshot, expectedRevision: 0, idempotencyKey: random(24) })).status, 200);
  const before = await actor.records.get('home');
  const content = await actor.records.get('content:' + first.id);
  assert.equal((await call('home.temperature', { temperatureUnit: 'fahrenheit' })).status, 200);
  const after = await actor.records.get('home');
  assert.deepEqual(after.settings, { ...before.settings, temperatureUnit: 'fahrenheit' });
  for (let index = 0; index < before.screens.length; index++) assert.deepEqual(after.screens[index], { ...before.screens[index], settings: { ...before.screens[index].settings, temperatureUnit: 'fahrenheit' } });
  assert.deepEqual(await actor.records.get('content:' + first.id), content);
  const delivery = await call('device.poll', {}, { deviceId: first.id, epoch: first.epoch });
  assert.equal(delivery.value.settings.temperatureUnit, 'fahrenheit');
  assert.equal(delivery.value.settings.nightEnd, '23:59');
  assert.equal(delivery.value.settings.showPhotos, false);
});

test('unit-only preferences reject extra fields, invalid units and non-owner members', async () => {
  const { call, actor } = await fixture();
  const editor = { accountId: random(16) };
  const home = await actor.records.get('home');
  home.members.push({ accountId: editor.accountId, role: 'editor', name: 'Test adult' });
  await actor.records.put('home', home);
  assert.equal((await call('home.temperature', { temperatureUnit: 'fahrenheit' }, editor)).status, 403);
  for (const input of [{ temperatureUnit: 'kelvin' }, { temperatureUnit: null }, {}, { temperatureUnit: 'fahrenheit', nightEnd: '00:00' }]) assert.equal((await call('home.temperature', input)).status, 400);
  assert.deepEqual(await actor.records.get('home'), home);
});

test('only the owner flips per-screen list editing, never editors or screens', async () => {
  const { call, actor, first } = await fixture();
  const editor = { accountId: random(16) };
  const home = await actor.records.get('home');
  home.members.push({ accountId: editor.accountId, role: 'editor', name: 'Test adult' });
  await actor.records.put('home', home);
  assert.equal((await call('screen.lists', { deviceId: first.id, allowListEdits: true })).status, 200);
  assert.equal((await actor.records.get('home')).screens[0].allowListEdits, true);
  assert.equal((await call('screen.lists', { deviceId: first.id, allowListEdits: 'yes' })).status, 400);
  assert.equal((await call('screen.lists', { deviceId: first.id, allowListEdits: false }, editor)).status, 403);
  assert.equal((await call('screen.lists', { deviceId: first.id, allowListEdits: false }, { deviceId: first.id, epoch: first.epoch })).status, 403);
  assert.equal((await call('screen.lists', { deviceId: 'missing-screen-id-00000000', allowListEdits: true })).status, 403);
  assert.equal((await call('screen.lists', { deviceId: first.id, allowListEdits: false })).status, 200);
  assert.equal((await actor.records.get('home')).screens[0].allowListEdits, false);
});

test('an allowed screen adds, ticks and removes list items with revision guards', async () => {
  const { call, first } = await fixture();
  const device = { deviceId: first.id, epoch: first.epoch };
  const published = await call('family.publish', { deviceId: first.id, snapshot: sampleSnapshot(Date.now()), expectedRevision: 0, idempotencyKey: 'lists-fixture-1' });
  assert.equal(published.status, 200);
  const before = await call('family.current', { deviceId: first.id });
  const target = before.value.snapshot.lists.find(entry => entry.kind === 'groceries');
  assert.ok(target);
  assert.equal((await call('lists.edit', { expectedRevision: 1, listId: target.id, action: 'add', item: { id: 'screen-item-01', text: 'Eggs' } }, device)).status, 403);
  assert.equal((await call('screen.lists', { deviceId: first.id, allowListEdits: true })).status, 200);
  assert.equal((await call('lists.edit', { expectedRevision: 0, listId: target.id, action: 'add', item: { id: 'screen-item-01', text: 'Eggs' } }, device)).status, 409);
  const added = await call('lists.edit', { expectedRevision: 1, listId: target.id, action: 'add', item: { id: 'screen-item-01', text: 'Eggs', person: 'Sam' } }, device);
  assert.equal(added.status, 200);
  assert.equal(added.value.revision, 2);
  const current = await call('family.current', { deviceId: first.id });
  assert.deepEqual(current.value.snapshot.lists.find(entry => entry.id === target.id).items.map(item => [item.text, item.person, item.done]), [['Milk', 'Everyone', false], ['Eggs', 'Sam', false]]);
  assert.equal((await call('lists.edit', { expectedRevision: 2, listId: target.id, action: 'toggle', itemId: 'screen-item-01' }, device)).status, 200);
  const toggled = await call('family.current', { deviceId: first.id });
  assert.equal(toggled.value.snapshot.lists.find(entry => entry.id === target.id).items[1].done, true);
  assert.equal((await call('lists.edit', { expectedRevision: 3, listId: target.id, action: 'remove', itemId: 'screen-item-01' }, device)).status, 200);
  const removed = await call('family.current', { deviceId: first.id });
  assert.equal(removed.value.snapshot.lists.find(entry => entry.id === target.id).items.length, 1);
  assert.equal((await call('screen.lists', { deviceId: first.id, allowListEdits: false })).status, 200);
  assert.equal((await call('lists.edit', { expectedRevision: 4, listId: target.id, action: 'add', item: { id: 'screen-item-02', text: 'Bread' } }, device)).status, 403);
});

test('screen list edits reject invalid input and unavailable lists', async () => {
  const { call, first } = await fixture();
  const device = { deviceId: first.id, epoch: first.epoch };
  assert.equal((await call('screen.lists', { deviceId: first.id, allowListEdits: true })).status, 200);
  assert.equal((await call('lists.edit', { expectedRevision: 0, listId: 'groceries-01', action: 'add', item: { id: 'screen-item-01', text: 'Eggs' } }, device)).status, 409);
  const published = await call('family.publish', { deviceId: first.id, snapshot: sampleSnapshot(Date.now()), expectedRevision: 0, idempotencyKey: 'lists-fixture-invalid' });
  assert.equal(published.status, 200);
  const current = await call('family.current', { deviceId: first.id });
  const target = current.value.snapshot.lists.find(entry => entry.kind === 'groceries');
  const edit = input => call('lists.edit', { expectedRevision: 1, listId: target.id, action: 'add', item: { id: 'screen-item-01', text: 'Eggs' }, ...input }, device);
  assert.equal((await edit({ action: 'rename' })).status, 400);
  assert.equal((await edit({ item: { id: 'x', text: 'Eggs' } })).status, 400);
  assert.equal((await edit({ item: { id: 'screen-item-01', text: 'https://example.com' } })).status, 400);
  assert.equal((await edit({ listId: 'no-such-list-0000' })).status, 404);
  assert.equal((await call('lists.edit', { expectedRevision: 1, listId: target.id, action: 'toggle', itemId: 'no-such-item-00' }, device)).status, 404);
  assert.equal((await call('lists.edit', { expectedRevision: 1, listId: target.id, action: 'add', item: { id: 'screen-item-01', text: 'Eggs' } })).status, 403);
});
