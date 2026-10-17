import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { random } from '../src/product/common.js';
import { sampleSnapshot, validateSnapshot } from '../src/product/family.js';

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

const origin = 'https://voice.example.com';

async function fixture() {
  const homeId = random(24);
  const storage = new MemoryStorage();
  const context = { id: { toString: () => homeId }, storage, blockConcurrencyWhile: callback => callback() };
  const env = { PRODUCT_STATE_KEY: '1'.repeat(64), FACTORY_CREDENTIAL: random() };
  const actor = new HouseholdState(context, env);
  const owner = { accountId: random(16) };
  const first = { id: random(24), epoch: 1 };
  async function call(command, input = {}, principal = owner) {
    const response = await actor.fetch(new Request(origin + '/internal', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DisplayOS-Internal': env.FACTORY_CREDENTIAL },
      body: JSON.stringify({ command, input, principal }),
    }));
    return { status: response.status, value: await response.json() };
  }
  assert.equal((await call('home.create', { id: homeId, name: 'Our home', accountId: owner.accountId, accountName: 'Alex' }, { system: true })).status, 200);
  assert.equal((await call('screen.attach', { deviceId: first.id, epoch: first.epoch, name: 'Kitchen' }, { system: true })).status, 200);
  return { actor, storage, env, owner, first, call };
}

const devicePrincipal = screen => ({ deviceId: screen.id, epoch: screen.epoch });

function sampleSnapshotAt(now) {
  return sampleSnapshot(now);
}

test('owner flips per-screen voice and the default agent, never editors or screens', async () => {
  const { call, actor, first } = await fixture();
  const editor = { accountId: random(16) };
  const home = await actor.records.get('home');
  home.members.push({ accountId: editor.accountId, role: 'editor', name: 'Sam' });
  await actor.records.put('home', home);
  assert.equal((await call('screen.voice', { deviceId: first.id, allowVoice: true })).status, 200);
  assert.equal((await actor.records.get('home')).screens[0].allowVoice, true);
  assert.equal((await call('screen.voice', { deviceId: first.id, allowVoice: 'yes' })).status, 400);
  assert.equal((await call('screen.voice', { deviceId: first.id, allowVoice: false }, editor)).status, 403);
  assert.equal((await call('screen.voice', { deviceId: first.id, allowVoice: true }, devicePrincipal(first))).status, 403);
  assert.equal((await call('screen.voice', { deviceId: 'missing-screen-00000', allowVoice: true })).status, 403);
  assert.equal((await call('home.voiceDefault', { defaultVoiceAgent: 'Maya' })).status, 200);
  assert.equal((await actor.records.get('home')).settings.defaultVoiceAgent, 'Maya');
  assert.equal((await call('home.voiceDefault', { defaultVoiceAgent: '' })).status, 200);
  assert.equal((await call('home.voiceDefault', { defaultVoiceAgent: 'x'.repeat(81) })).status, 400);
  assert.equal((await call('home.voiceDefault', { defaultVoiceAgent: '<script>' })).status, 400);
  assert.equal((await call('home.voiceDefault', { defaultVoiceAgent: 'Maya' }, editor)).status, 403);
});

test('device poll carries the voice affordances', async () => {
  const { call, first } = await fixture();
  assert.equal((await call('screen.voice', { deviceId: first.id, allowVoice: true })).status, 200);
  assert.equal((await call('home.voiceDefault', { defaultVoiceAgent: 'Maya' })).status, 200);
  const poll = await call('device.poll', { deviceId: first.id, epoch: first.epoch }, devicePrincipal(first));
  assert.equal(poll.value.allowVoice, true);
  assert.equal(poll.value.allowListEdits, false);
  assert.equal(poll.value.defaultVoiceAgent, 'Maya');
});

test('a recording uploads, lands in the voice inbox and publishes an immediate ack', async () => {
  const { call, first } = await fixture();
  const device = devicePrincipal(first);
  assert.equal((await call('screen.voice', { deviceId: first.id, allowVoice: true })).status, 200);
  const published = await call('family.publish', { deviceId: first.id, snapshot: sampleSnapshotAt(Date.now()), expectedRevision: 0, idempotencyKey: 'voice-fixture-1' });
  assert.equal(published.status, 200);

  const begun = await call('voice.begin', { mime: 'audio/webm', byteLength: 12, durationMs: 1500 }, device);
  assert.equal(begun.status, 200);
  const uploadId = begun.value.uploadId;
  assert.match(uploadId, /^[A-Za-z0-9_-]{8,64}$/);

  const part1 = await call('voice.part', { uploadId, seq: 0, data: Buffer.from('hello ').toString('base64') }, device);
  const part2 = await call('voice.part', { uploadId, seq: 1, data: Buffer.from('world!').toString('base64') }, device);
  assert.equal(part1.status, 200);
  assert.equal(part2.value.received, 2);

  const ended = await call('voice.end', { uploadId }, device);
  assert.equal(ended.status, 200);
  assert.equal(ended.value.voiceAck.state, 'received');
  assert.equal(ended.value.revision, 2);

  const current = await call('family.current', { deviceId: first.id });
  assert.equal(current.value.snapshot.voiceAck.id, ended.value.messageId);
  assert.equal(current.value.snapshot.voiceAck.state, 'received');
  validateSnapshot(current.value.snapshot, Date.now());

  const listed = await call('voice.list', {});
  assert.equal(listed.value.messages.length, 1);
  assert.equal(listed.value.messages[0].id, ended.value.messageId);
  assert.equal(listed.value.messages[0].state, 'received');
  assert.equal('data' in listed.value.messages[0], false);

  const got = await call('voice.get', { messageId: ended.value.messageId });
  assert.equal(got.status, 200);
  assert.equal(Buffer.from(got.value.data, 'base64').toString(), 'hello world!');
  assert.equal(got.value.mime, 'audio/webm');
  assert.equal((await call('voice.list', {})).value.messages[0].state, 'heard');
});

test('voice uploads reject bad parts, gaps and oversize totals', async () => {
  const { call, first } = await fixture();
  const device = devicePrincipal(first);
  assert.equal((await call('screen.voice', { deviceId: first.id, allowVoice: true })).status, 200);
  const begun = await call('voice.begin', { mime: 'audio/webm', byteLength: 40, durationMs: 900 }, device);
  const uploadId = begun.value.uploadId;
  assert.equal((await call('voice.begin', { mime: 'audio/mp4', byteLength: 10, durationMs: 100 }, device)).status, 415);
  assert.equal((await call('voice.begin', { mime: 'audio/webm', byteLength: 999999, durationMs: 100 }, device)).status, 413);
  assert.equal((await call('voice.begin', { mime: 'audio/webm', byteLength: 10, durationMs: 999999 }, device)).status, 400);
  assert.equal((await call('voice.part', { uploadId, seq: 999, data: 'AAAA' }, device)).status, 400);
  assert.equal((await call('voice.part', { uploadId, seq: 0, data: 'x'.repeat(5700) }, device)).status, 400);
  assert.equal((await call('voice.part', { uploadId: 'no-such-upload-000', seq: 0, data: 'AAAA' }, device)).status, 404);
  assert.equal((await call('voice.end', { uploadId: 'no-such-upload-000' }, device)).status, 404);
  assert.equal((await call('voice.end', { uploadId }, device)).status, 400);
  assert.equal((await call('voice.part', { uploadId, seq: 0, data: Buffer.alloc(30, 1).toString('base64') }, device)).status, 200);
  assert.equal((await call('voice.part', { uploadId, seq: 1, data: Buffer.alloc(20, 2).toString('base64') }, device)).status, 413);
  assert.equal((await call('voice.cancel', { uploadId }, device)).status, 200);
});

test('a full recording survives storage and retrieval with padded parts', async () => {
  const { call, first } = await fixture();
  const device = devicePrincipal(first);
  assert.equal((await call('screen.voice', { deviceId: first.id, allowVoice: true })).status, 200);
  const bytes = Buffer.alloc(16384);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  const begun = await call('voice.begin', { mime: 'audio/webm', byteLength: bytes.length, durationMs: 5200 }, device);
  assert.equal(begun.status, 200);
  for (let seq = 0; seq < 4; seq++) {
    const data = bytes.subarray(seq * 4096, seq * 4096 + 4096).toString('base64');
    assert.equal(data.length, 5464);
    const part = await call('voice.part', { uploadId: begun.value.uploadId, seq, data }, device);
    assert.equal(part.status, 200);
    assert.equal(part.value.received, seq + 1);
  }
  assert.equal((await call('voice.part', { uploadId: begun.value.uploadId, seq: 4, data: 'AA==' }, device)).status, 413);
  const ended = await call('voice.end', { uploadId: begun.value.uploadId }, device);
  assert.equal(ended.status, 200);
  const got = await call('voice.get', { messageId: ended.value.messageId });
  assert.equal(got.status, 200);
  const decoded = Buffer.from(got.value.data, 'base64');
  assert.equal(decoded.length, bytes.length);
  assert.ok(decoded.equals(bytes));
});

test('voice is refused entirely when the screen is not allowed to record', async () => {
  const { call, first } = await fixture();
  const device = devicePrincipal(first);
  assert.equal((await call('voice.begin', { mime: 'audio/webm', byteLength: 10, durationMs: 100 }, device)).status, 403);
  assert.equal((await call('screen.voice', { deviceId: first.id, allowVoice: true })).status, 200);
  assert.equal((await call('voice.begin', { mime: 'audio/webm', byteLength: 10, durationMs: 100 }, device)).status, 200);
  assert.equal((await call('screen.voice', { deviceId: first.id, allowVoice: false })).status, 200);
  assert.equal((await call('voice.list', {})).status, 200);
});

test('voice.reply publishes a scene and marks the message acted', async () => {
  const { call, owner, first } = await fixture();
  const device = devicePrincipal(first);
  assert.equal((await call('screen.voice', { deviceId: first.id, allowVoice: true })).status, 200);
  assert.equal((await call('family.publish', { deviceId: first.id, snapshot: sampleSnapshotAt(Date.now()), expectedRevision: 0, idempotencyKey: 'voice-fixture-2' })).status, 200);
  const begun = await call('voice.begin', { mime: 'audio/webm', byteLength: 6, durationMs: 500 }, device);
  await call('voice.part', { uploadId: begun.value.uploadId, seq: 0, data: Buffer.from('hello!').toString('base64') }, device);
  const ended = await call('voice.end', { uploadId: begun.value.uploadId }, device);
  const messageId = ended.value.messageId;

  const grant = await call('grant.create', { clientId: random(), label: 'Maya', deviceIds: [first.id], scopes: ['display:read', 'content:write'], expiresAt: Date.now() + 600000 });
  const agent = { accountId: owner.accountId, grantId: grant.value.id, clientId: grant.value.clientId };
  const scene = { id: 'scene-000001', kind: 'answer', title: 'Heard you', blocks: [{ type: 'text', text: 'Milk is on the list.' }], ttlSeconds: 300 };
  const ack = { id: messageId, state: 'acted', heard: 'add milk', agentName: 'Maya' };
  const replied = await call('voice.reply', { deviceId: first.id, messageId, displayScene: scene, voiceAck: ack }, agent);
  assert.equal(replied.status, 200);

  const current = await call('family.current', { deviceId: first.id });
  assert.equal(current.value.snapshot.displayScene.title, 'Heard you');
  assert.equal(current.value.snapshot.voiceAck.state, 'acted');
  validateSnapshot(current.value.snapshot, Date.now());
  assert.equal((await call('voice.list', {})).value.messages[0].state, 'acted');
  assert.equal((await call('voice.list', {})).value.messages[0].agentName, 'Maya');

  const bad = { ...scene, kind: 'mystery' };
  const rejected = await call('voice.reply', { deviceId: first.id, messageId, displayScene: bad, voiceAck: ack }, agent);
  assert.equal(rejected.status, 400);
  const withUrl = { ...scene, title: 'see https://example.com' };
  assert.equal((await call('voice.reply', { deviceId: first.id, messageId, displayScene: withUrl, voiceAck: ack }, agent)).status, 400);
});

function ownerId(actor) {
  const home = actor.records.values.get('home');
  return home.members[0].accountId;
}

test('the default agent survives a home settings save', async () => {
  const { call, actor, first } = await fixture();
  assert.equal((await call('home.voiceDefault', { defaultVoiceAgent: 'Maya' })).status, 200);
  const current = await actor.records.get('home');
  const settings = { timezone: current.settings.timezone, quietAfterSeconds: current.settings.quietAfterSeconds, nightStart: current.settings.nightStart, nightEnd: current.settings.nightEnd, brightness: current.settings.brightness, orientation: current.settings.orientation, showPhotos: current.settings.showPhotos };
  assert.equal((await call('home.update', { name: 'Our home', settings })).status, 200);
  assert.equal((await actor.records.get('home')).settings.defaultVoiceAgent, 'Maya');
  const poll = await call('device.poll', { deviceId: first.id, epoch: first.epoch }, devicePrincipal(first));
  assert.equal(poll.value.settings.defaultVoiceAgent, 'Maya');
});

test('the background pass transcribes, answers and can drive a list edit', async () => {
  const { call, actor, env, first } = await fixture();
  const device = devicePrincipal(first);
  assert.equal((await call('screen.voice', { deviceId: first.id, allowVoice: true })).status, 200);
  assert.equal((await call('screen.lists', { deviceId: first.id, allowListEdits: true })).status, 200);
  const snapshot = sampleSnapshotAt(Date.now());
  assert.equal((await call('family.publish', { deviceId: first.id, snapshot, expectedRevision: 0, idempotencyKey: 'voice-fixture-3' })).status, 200);
  const target = snapshot.lists.find(entry => entry.kind === 'groceries');

  const begun = await call('voice.begin', { mime: 'audio/webm', byteLength: 12, durationMs: 1200 }, device);
  await call('voice.part', { uploadId: begun.value.uploadId, seq: 0, data: Buffer.from('hello world!').toString('base64') }, device);
  const ended = await call('voice.end', { uploadId: begun.value.uploadId }, device);
  assert.equal(ended.value.voiceAck.state, 'received');

  env.AI = { run: async () => ({ text: 'add milk to groceries' }) };
  await actor.processVoice(ended.value.messageId);

  const current = await call('family.current', { deviceId: first.id });
  assert.equal(current.value.snapshot.voiceAck.state, 'heard');
  assert.equal(current.value.snapshot.voiceAck.heard, 'add milk to groceries');
  assert.equal(current.value.snapshot.displayScene.kind, 'list');
  validateSnapshot(current.value.snapshot, Date.now());
  const updated = current.value.snapshot.lists.find(entry => entry.id === target.id);
  assert.ok(updated.items.some(item => item.text === 'milk'));
  assert.equal((await call('voice.list', {})).value.messages[0].transcript, 'add milk to groceries');
});
