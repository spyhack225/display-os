import { DurableObject } from 'cloudflare:workers';
import { RecordStore } from './store.js';
import { readJson, json, errorResponse, reject, random, text, digest, exact } from './common.js';
import { validateSnapshot, validateSettings, capabilities } from './family.js';
import { transcribeVoice, interpretVoice } from './voice.js';
import { normalizeImage } from './media.js';

const ownerCommands = new Set(['home.update', 'home.temperature', 'home.delete', 'member.invite', 'member.remove', 'grant.create', 'grant.revoke', 'media.delete', 'screen.rename', 'screen.lists', 'screen.voice', 'home.voiceDefault']);
const agentScopes = { 'screen.list': 'display:read', 'screen.capabilities': 'display:read', 'revision.status': 'display:read', 'family.current': 'display:read', 'media.list': 'display:read', 'family.publish': 'content:write', 'screen.settings': 'settings:write', 'media.upload': 'media:write', 'voice.list': 'display:read', 'voice.get': 'display:read', 'voice.reply': 'content:write' };

export class HouseholdState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.records = new RecordStore(ctx.storage, env.PRODUCT_STATE_KEY, 'home:' + ctx.id.toString());
  }

  async fetch(request) {
    try {
      if (request.headers.get('x-displayos-internal') !== this.env.FACTORY_CREDENTIAL) reject(403, 'Not allowed.');
      const { command, input = {}, principal } = await readJson(request, 200000);
      return await this.ctx.blockConcurrencyWhile(async () => {
        const value = await this.records.transaction(store => this.execute(store, command, input, principal));
        if (command === 'family.publish') await this.scheduleExpiry();
        if (command === 'voice.end' && value && value.messageId) this.processVoice(value.messageId).catch(() => {});
        return json(value);
      });
    } catch (error) { return errorResponse(error); }
  }

  async processVoice(messageId) {
    const loaded = await this.records.transaction(async store => {
      const message = await store.get('voice:' + messageId);
      if (!message || message.expiresAt <= Date.now()) return null;
      let data = '';
      for (const key of message.chunks) { const chunk = await store.get(key); if (!chunk) return null; data += chunk.data; }
      return { message, bytes: Buffer.from(data, 'base64'), content: await store.get('content:' + message.deviceId), home: await store.get('home') };
    });
    if (!loaded) return;
    const transcript = await transcribeVoice(loaded.bytes, loaded.message.mime, this.env);
    if (!transcript) return;
    const snapshot = loaded.content && loaded.content.expiresAt > Date.now() ? loaded.content.snapshot : null;
    const plan = interpretVoice(transcript, snapshot);
    await this.records.transaction(async store => {
      const message = await store.get('voice:' + messageId);
      const home = await store.get('home');
      const screen = home && home.screens.find(value => value.id === loaded.message.deviceId);
      if (!message || !home || !screen || message.expiresAt <= Date.now()) return;
      const now = Date.now();
      message.transcript = transcript;
      message.state = 'heard';
      await store.put('voice:' + message.id, message);
      if (plan.listEdit) {
        try {
          await this.execute(store, 'lists.edit', { ...plan.listEdit, expectedRevision: screen.revision }, { deviceId: screen.id, epoch: screen.epoch });
        } catch (_) { /* the list may have changed; the scene still explains what happened */ }
      }
      const content = await store.get('content:' + screen.id);
      const base = content && content.expiresAt > now ? content.snapshot : null;
      if (!base) return;
      const ack = { id: message.id, state: 'heard', heard: transcript.slice(0, 240) };
      const next = { ...base, displayScene: plan.displayScene, voiceAck: ack, generatedAt: now, expiresAt: Math.min(base.expiresAt, now + 3600000) };
      screen.revision += 1;
      await store.put('content:' + screen.id, { snapshot: next, revision: screen.revision, epoch: screen.epoch, expiresAt: next.expiresAt });
      await store.put('receipt:' + screen.id + ':' + String(screen.revision).padStart(10, '0'), { revision: screen.revision, acceptedAt: now, idempotencyKey: 'voice-heard:' + message.id, payloadHash: await digest(JSON.stringify(next)) });
      const receipts = [...(await store.list('receipt:' + screen.id + ':', 25)).keys()];
      while (receipts.length >= 20) await store.delete(receipts.shift());
      await store.put('home', home);
    });
  }

  async scheduleExpiry() {
    const contents = [...(await this.records.list('content:', 9)).values()];
    const expiry = contents.reduce((minimum, value) => Math.min(minimum, value.expiresAt), Infinity);
    if (Number.isFinite(expiry)) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1000, expiry));
    else await this.ctx.storage.deleteAlarm();
  }

  async alarm() {
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.records.transaction(async store => {
        for (const [key, value] of await store.list('content:', 9)) if (value.expiresAt <= Date.now()) {
          await store.delete(key);
          for (const receipt of (await store.list('receipt:' + key.slice(8) + ':', 25)).keys()) await store.delete(receipt);
        }
        for (const prefix of ['invite:', 'grant:']) for (const [key, value] of await store.list(prefix, 65)) if (value.expiresAt <= Date.now() || value.revokedAt) { await store.delete(key); if (value.operationKey) await store.delete(value.operationKey); }
        for (const prefix of ['voice:', 'voice-upload:']) for (const [key, value] of await store.list(prefix, 21)) if (value.expiresAt <= Date.now()) {
          for (const chunk of value.chunks || []) await store.delete(chunk);
          if (key.startsWith('voice-upload:')) for (const seq of value.chunks || []) await store.delete('chunk:' + key + ':' + seq);
          await store.delete(key);
        }
      });
      await this.scheduleExpiry();
    });
  }

  async execute(store, command, input, principal) {
    const now = Date.now();
    let home = await store.get('home');
    if (command === 'home.create' && principal?.system) {
      if (home) return { home: { id: home.id, name: home.name } };
      home = { id: input.id, name: text(input.name), members: [{ accountId: input.accountId, name: text(input.accountName), role: 'owner' }], screens: [], settings: validateSettings({ timezone: input.timezone || 'UTC', quietAfterSeconds: 120, nightStart: '22:00', nightEnd: '07:00', brightness: 70, orientation: 'auto', showPhotos: true }), createdAt: now };
      await store.put('home', home);
      return { home: { id: home.id, name: home.name } };
    }
    if (!home) reject(404, 'This home is no longer available.');
    const member = home.members.find(entry => entry.accountId === principal?.accountId);
    let grant;
    if (principal?.grantId) {
      grant = await store.get('grant:' + principal.grantId);
      if (!member || !grant || grant.revokedAt || grant.expiresAt <= now || grant.accountId !== principal.accountId || grant.clientId !== principal.clientId) reject(403, 'This assistant no longer has access.');
      const scope = agentScopes[command];
      if (!scope || !grant.scopes.includes(scope)) reject(403, 'This assistant cannot do that.');
      if (input.deviceId && !grant.deviceIds.includes(input.deviceId)) reject(403, 'This assistant cannot use that screen.');
    } else if (!principal?.system && !principal?.deviceId && !member) reject(403, 'This home is not available to you.');
    if (ownerCommands.has(command) && !principal?.system && member?.role !== 'owner') reject(403, 'Only the person who manages this home can do that.');
    if (principal?.deviceId && !['device.poll', 'device.ack', 'media.get', 'lists.edit', 'voice.begin', 'voice.part', 'voice.end', 'voice.cancel'].includes(command)) reject(403, 'This screen cannot do that.');
    if (command === 'home.get') {
      const grants = [...(await store.list('grant:', 65)).values()].filter(value => !value.revokedAt && value.expiresAt > now);
      return { ...home, role: member?.role, grants: grants.map(({ id, label, deviceIds, scopes, expiresAt }) => ({ id, label, deviceIds, scopes, expiresAt })), revision: Math.max(0, ...home.screens.map(screen => screen.revision || 0)) };
    }
    if (command === 'home.temperature') {
      exact(input, ['temperatureUnit']);
      if (!['celsius', 'fahrenheit'].includes(input.temperatureUnit)) reject(400, 'Choose Celsius or Fahrenheit.');
      home.settings = { ...home.settings, temperatureUnit: input.temperatureUnit };
      for (const screen of home.screens) screen.settings = { ...screen.settings, temperatureUnit: input.temperatureUnit };
      await store.put('home', home);
      return { saved: true, temperatureUnit: input.temperatureUnit };
    }
    if (command === 'home.update') {
      exact(input, ['name', 'settings']);
      if (input.name !== undefined) home.name = text(input.name);
      if (input.settings !== undefined) {
        const keptAgent = home.settings.defaultVoiceAgent;
        home.settings = validateSettings(input.settings);
        if (keptAgent !== undefined) home.settings.defaultVoiceAgent = keptAgent;
        for (const screen of home.screens) {
          if (screen.settings.timezone !== home.settings.timezone) await this.clearScreenContent(store, screen.id);
          screen.settings = home.settings;
        }
      }
      await store.put('home', home);
      return { saved: true };
    }
    if (command === 'home.export') {
      if (member?.role !== 'owner') reject(403, 'Only the person who manages this home can do that.');
      const screens = [];
      for (const screen of home.screens) screens.push({ ...screen, content: await store.get('content:' + screen.id) });
      const photos = [];
      for (const media of (await store.list('media:', 21)).values()) {
        const image = await this.media(store, home, 'media.get', { mediaId: media.id }, principal);
        photos.push({ mediaId: media.id, width: media.width, height: media.height, approvedAt: media.approvedAt, ...image });
      }
      return { schemaVersion: 1, exportedAt: now, home: { ...home, screens }, photos };
    }
    if (command === 'home.delete') {
        for (const prefix of ['grant:', 'grant-operation:', 'content:', 'receipt:', 'media:', 'chunk:', 'invite:', 'fence:', 'membership-operation:', 'voice:', 'voice-upload:']) {
        while (true) { const values = await store.list(prefix, 200); if (!values.size) break; for (const key of values.keys()) await store.delete(key); }
      }
      await store.delete('home');
      return { deleted: true };
    }
    if (command === 'member.invite') {
      if (home.members.length >= 8) reject(429, 'This home has enough adults already.');
      const invites = await store.list('invite:', 9);
      for (const [key, value] of invites) if (value.expiresAt <= now) await store.delete(key);
      if ([...invites.values()].filter(value => value.expiresAt > now).length >= 8) reject(429, 'Please finish an invitation first.');
      const code = random(24);
      const id = await digest(code);
      await store.put('invite:' + id, { codeHash: id, expiresAt: now + 86400000, role: 'editor' });
      return { code, expiresAt: now + 86400000 };
    }
    if (command === 'member.accept' && principal?.system) {
      if (home.members.some(value => value.accountId === input.accountId)) return { joined: true };
      const key = 'invite:' + await digest(input.code);
      const invitation = await store.get(key);
      if (!invitation || invitation.expiresAt <= now || home.members.length >= 8) reject(410, 'This invitation is no longer available.');
      if (!home.members.some(value => value.accountId === input.accountId)) home.members.push({ accountId: input.accountId, name: text(input.name), role: invitation.role });
      await store.delete(key);
      await store.put('home', home);
      return { joined: true };
    }
    if (command === 'member.remove') {
      if (input.accountId === principal.accountId) reject(409, 'Choose another person to manage the home first.');
      home.members = home.members.filter(value => value.accountId !== input.accountId);
      for (const [key, value] of await store.list('grant:', 65)) if (value.accountId === input.accountId) await store.put(key, { ...value, revokedAt: now });
      await store.put('home', home);
      return { removed: true };
    }
    if (command === 'account.remove' && principal?.system) {
      const removed = home.members.find(value => value.accountId === input.accountId);
      if (!removed) return { removed: true };
      if (removed.role === 'owner') return { needsDelete: true };
      home.members = home.members.filter(value => value.accountId !== input.accountId);
      for (const [key, value] of await store.list('grant:', 65)) if (value.accountId === input.accountId) await store.put(key, { ...value, revokedAt: now });
      await store.put('home', home);
      return { removed: true };
    }
    if (command === 'screen.attach' && principal?.system) {
      const fence = await store.get('fence:' + input.deviceId);
      if (fence && input.epoch < fence.epoch) reject(409, 'This screen preparation is no longer current.');
      const previous = home.screens.find(value => value.id === input.deviceId);
      if (previous && previous.epoch === input.epoch) return { attached: true };
      if (previous) reject(409, 'This screen is already attached.');
      if (home.screens.length >= 8) reject(429, 'This home has enough screens already.');
      home.screens.push({ id: input.deviceId, name: text(input.name), epoch: input.epoch, revision: 0, settings: home.settings });
      await store.put('home', home);
      return { attached: true };
    }
    if (command === 'screen.detach' && principal?.system) {
      const fenceKey = 'fence:' + input.deviceId;
      const fence = await store.get(fenceKey);
      if (fence && (input.epoch < fence.epoch || input.operationId === fence.operationId)) return { detached: true };
      const active = home.screens.find(screen => screen.id === input.deviceId);
      if (active && input.epoch <= active.epoch) reject(409, 'This screen removal is no longer current.');
      home.screens = home.screens.filter(value => value.id !== input.deviceId);
      await store.delete('content:' + input.deviceId);
      for (const [key, value] of await store.list('receipt:' + input.deviceId + ':', 25)) await store.delete(key);
      for (const [key, value] of await store.list('grant:', 65)) {
        if (value.deviceIds.includes(input.deviceId)) await store.put(key, { ...value, deviceIds: value.deviceIds.filter(id => id !== input.deviceId), revokedAt: value.deviceIds.length === 1 ? now : value.revokedAt });
      }
      await store.put('home', home);
      await store.put(fenceKey, { epoch: input.epoch, operationId: input.operationId });
      return { detached: true };
    }
    if (command === 'grant.create') {
      const operationKey = input.operationId ? 'grant-operation:' + await digest(input.operationId) : null;
      if (operationKey) {
        const operation = await store.get(operationKey);
        if (operation) {
          const previous = await store.get('grant:' + operation.grantId);
          if (!previous || previous.revokedAt || previous.expiresAt <= now || previous.accountId !== principal.accountId || previous.clientId !== input.clientId || JSON.stringify([...previous.deviceIds].sort()) !== JSON.stringify([...input.deviceIds].sort()) || JSON.stringify([...previous.scopes].sort()) !== JSON.stringify([...input.scopes].sort())) reject(409, 'Start this assistant connection again.');
          return previous;
        }
      }
      const active = [...(await store.list('grant:', 65)).entries()];
      for (const [key, value] of active) if (value.expiresAt <= now || value.revokedAt) { await store.delete(key); if (value.operationKey) await store.delete(value.operationKey); }
      if (active.filter(([, value]) => value.expiresAt > now && !value.revokedAt).length >= 64) reject(429, 'Please stop an assistant before adding another.');
      if (!Array.isArray(input.deviceIds) || !input.deviceIds.length || input.deviceIds.length > 8 || input.deviceIds.some(id => !home.screens.some(screen => screen.id === id))) reject(400, 'Choose screens in this home.');
      if (!Array.isArray(input.scopes) || !input.scopes.length || input.scopes.some(scope => !['display:read', 'content:write', 'settings:write', 'media:write'].includes(scope))) reject(400, 'Choose supported permissions.');
      if (!Number.isFinite(input.expiresAt) || input.expiresAt <= now || input.expiresAt > now + 2592000000) reject(400, 'Choose a supported access duration.');
      const value = { id: random(18), accountId: principal.accountId, clientId: input.clientId, label: text(input.label), deviceIds: [...new Set(input.deviceIds)], scopes: [...new Set(input.scopes)], expiresAt: input.expiresAt, createdAt: now, operationKey };
      await store.put('grant:' + value.id, value);
      if (operationKey) await store.put(operationKey, { grantId: value.id });
      return value;
    }
    if (command === 'grant.check') {
      const value = await store.get('grant:' + input.grantId);
      if (!member || !value || value.accountId !== principal.accountId || value.revokedAt || value.expiresAt <= now || !value.deviceIds.length) reject(403, 'This assistant no longer has access.');
      if (input.scope && !value.scopes.includes(input.scope)) reject(403, 'This assistant cannot do that.');
      if (input.deviceIds?.some(id => !value.deviceIds.includes(id) || !home.screens.some(screen => screen.id === id))) reject(403, 'This assistant cannot use those screens.');
      return value;
    }
    if (command === 'grant.revoke') {
      const value = await store.get('grant:' + input.grantId);
      if (value) await store.put('grant:' + input.grantId, { ...value, revokedAt: now });
      return { stopped: true };
    }
    if (command === 'screen.list') return { screens: home.screens.filter(screen => !grant || grant.deviceIds.includes(screen.id)).map(({ id, name, revision, settings }) => ({ id, name, revision, timezone: settings.timezone })) };
    if (command === 'screen.capabilities') return capabilities();
    if (command.startsWith('media.')) return this.media(store, home, command, input, principal, grant);
    if (command === 'screen.rename') {
      if (principal.system || member?.role !== 'owner') reject(403, 'Only the person who manages this home can do that.');
      exact(input, ['deviceId', 'name']);
      const deviceId = text(input.deviceId, 64);
      const name = text(input.name, 40);
      const screen = home.screens.find(value => value.id === deviceId);
      if (!screen) reject(403, 'This screen is not available.');
      const fence = await store.get('fence:' + deviceId);
      if (fence && fence.epoch > screen.epoch) reject(409, 'This screen is being removed.');
      if (screen.name !== name) {
        screen.name = name;
        await store.put('home', home);
      }
      return { saved: true, screen: { id: screen.id, name: screen.name } };
    }
    if (command === 'screen.voice') {
      exact(input, ['deviceId', 'allowVoice']);
      const target = home.screens.find(value => value.id === input.deviceId);
      if (!target) reject(403, 'Choose one of your screens.');
      if (typeof input.allowVoice !== 'boolean') reject(400, 'Choose whether this screen can record voice.');
      target.allowVoice = input.allowVoice;
      await store.put('home', home);
      return { saved: true, allowVoice: target.allowVoice };
    }
    if (command === 'home.voiceDefault') {
      exact(input, ['defaultVoiceAgent']);
      const value = input.defaultVoiceAgent;
      if (value !== '' && (typeof value !== 'string' || value.length > 80 || /[<>&\u0000-\u001f\u007f]/.test(value))) reject(400, 'Choose a short, plain agent name.');
      home.settings.defaultVoiceAgent = value;
      await store.put('home', home);
      return { saved: true, defaultVoiceAgent: value };
    }
    if (command === 'voice.list') {
      exact(input, []);
      const messages = [...(await store.list('voice:', 21)).values()]
        .filter(value => value.expiresAt > now)
        .sort((a, b) => b.createdAt - a.createdAt).slice(0, 20)
        .map(value => {
          const row = { id: value.id, createdAt: value.createdAt, durationMs: value.durationMs, state: value.state };
          if (value.transcript !== undefined) row.transcript = value.transcript;
          if (value.agentName !== undefined) row.agentName = value.agentName;
          return row;
        });
      return { messages };
    }
    if (command === 'voice.get') {
      exact(input, ['messageId']);
      const message = await store.get('voice:' + input.messageId);
      if (!message || message.expiresAt <= now) reject(404, 'That voice message is no longer available.');
      let data = '';
      for (const key of message.chunks) { const chunk = await store.get(key); if (!chunk) reject(404, 'That voice message is no longer available.'); data += chunk.data; }
      if (message.state === 'received') { message.state = 'heard'; await store.put('voice:' + message.id, message); }
      return { id: message.id, mime: message.mime, data, transcript: message.transcript, durationMs: message.durationMs };
    }
    const screen = home.screens.find(value => value.id === (principal.deviceId || input.deviceId));
    if (!screen || (principal.deviceId && screen.epoch !== principal.epoch)) reject(403, 'This screen is not available.');
    if (command === 'screen.settings') {
      const settings = validateSettings(input.settings);
      if (settings.timezone !== screen.settings.timezone) await this.clearScreenContent(store, screen.id);
      screen.settings = settings;
      await store.put('home', home);
      return { saved: true, settings: screen.settings };
    }
    if (command === 'family.current') {
      const content = await store.get('content:' + screen.id);
      return { snapshot: content && content.expiresAt > now ? content.snapshot : null, revision: screen.revision };
    }
    if (command === 'family.publish') {
      const snapshot = validateSnapshot(input.snapshot, now);
      if (snapshot.timezone !== screen.settings.timezone) reject(400, 'Use this screen\'s chosen time zone for the family update.');
      const idempotencyKey = text(input.idempotencyKey, 100);
      if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) reject(400, 'A current revision is required.');
      for (const id of snapshot.photos) if (!await store.get('media:' + id)) reject(400, 'Choose an approved photo in this home.');
      const payloadHash = await digest(JSON.stringify({ snapshot, expectedRevision: input.expectedRevision }));
      const receipts = await store.list('receipt:' + screen.id + ':', 25);
      const existing = [...receipts.values()].find(value => value.idempotencyKey === idempotencyKey);
      if (existing) {
        if (existing.payloadHash !== payloadHash) reject(409, 'This update name was already used for different content.');
        return { revision: existing.revision, status: existing.renderedAt ? 'rendered' : existing.deliveredAt ? 'delivered' : 'accepted' };
      }
      if (screen.revision !== input.expectedRevision) reject(409, 'Another update arrived first. Read the latest screen and try again.');
      screen.revision += 1;
      const receipt = { revision: screen.revision, acceptedAt: now, idempotencyKey, payloadHash };
      await store.put('content:' + screen.id, { snapshot, revision: screen.revision, epoch: screen.epoch, expiresAt: snapshot.expiresAt });
      await store.put('receipt:' + screen.id + ':' + String(screen.revision).padStart(10, '0'), receipt);
      const oldKeys = [...receipts.keys()];
      while (oldKeys.length >= 20) await store.delete(oldKeys.shift());
      await store.put('home', home);
      return { revision: screen.revision, status: 'accepted' };
    }
    if (command === 'revision.status') {
      if (!Number.isInteger(input.revision)) reject(400, 'Choose a valid update.');
      const receipt = await store.get('receipt:' + screen.id + ':' + String(input.revision).padStart(10, '0'));
      if (!receipt) reject(404, 'This update is no longer retained.');
      const { revision, acceptedAt, deliveredAt, renderedAt } = receipt;
      return { revision, acceptedAt, deliveredAt, renderedAt, status: renderedAt ? 'rendered' : deliveredAt ? 'delivered' : 'accepted' };
    }
    if (command === 'screen.lists') {
      exact(input, ['deviceId', 'allowListEdits']);
      const target = home.screens.find(value => value.id === input.deviceId);
      if (!target) reject(404, 'Choose one of your screens.');
      if (typeof input.allowListEdits !== 'boolean') reject(400, 'Choose whether this screen can edit lists.');
      target.allowListEdits = input.allowListEdits;
      await store.put('home', home);
      return { saved: true, allowListEdits: target.allowListEdits };
    }
    if (command === 'lists.edit') {
      if (!principal?.deviceId) reject(403, 'Only a family screen can change lists this way.');
      if (screen.allowListEdits !== true) reject(403, 'List editing is not allowed from this screen.');
      exact(input, ['expectedRevision', 'listId', 'action', 'item', 'itemId']);
      if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) reject(400, 'A current revision is required.');
      if (typeof input.listId !== 'string' || !input.listId) reject(400, 'Choose a list to change.');
      if (!['add', 'toggle', 'remove'].includes(input.action)) reject(400, 'Choose a supported list change.');
      const content = await store.get('content:' + screen.id);
      if (!content || content.expiresAt <= now || content.revision !== screen.revision) reject(409, 'Lists are not available right now. Read the latest screen and try again.');
      if (screen.revision !== input.expectedRevision) reject(409, 'Another update arrived first. Read the latest screen and try again.');
      const snapshot = content.snapshot;
      const entry = (snapshot.lists || []).find(value => value.id === input.listId);
      if (!entry) reject(404, 'Choose a list on this screen.');
      if (input.action === 'add') {
        if (!input.item || typeof input.item !== 'object') reject(400, 'Describe the new item.');
        if ((entry.items || []).length >= 12) reject(409, 'This list is full.');
        entry.items = [...(entry.items || []), input.item];
      } else {
        if (typeof input.itemId !== 'string' || !input.itemId) reject(400, 'Choose an item to change.');
        const current = (entry.items || []).find(value => value.id === input.itemId);
        if (!current) reject(404, 'Choose an item on this screen.');
        entry.items = input.action === 'toggle'
          ? entry.items.map(value => value.id === input.itemId ? { ...value, done: !value.done } : value)
          : entry.items.filter(value => value.id !== input.itemId);
      }
      const next = validateSnapshot({ ...snapshot, lists: snapshot.lists, generatedAt: now }, now);
      screen.revision += 1;
      const receipt = { revision: screen.revision, acceptedAt: now, idempotencyKey: 'screen-lists:' + screen.revision, payloadHash: await digest(JSON.stringify(next)) };
      await store.put('content:' + screen.id, { snapshot: next, revision: screen.revision, epoch: screen.epoch, expiresAt: snapshot.expiresAt });
      await store.put('receipt:' + screen.id + ':' + String(screen.revision).padStart(10, '0'), receipt);
      const oldEdits = [...(await store.list('receipt:' + screen.id + ':', 25)).keys()];
      while (oldEdits.length >= 20) await store.delete(oldEdits.shift());
      await store.put('home', home);
      return { revision: screen.revision, status: 'accepted' };
    }
    if (command === 'voice.begin') {
      if (screen.allowVoice !== true) reject(403, 'Voice is not allowed from this screen.');
      exact(input, ['mime', 'byteLength', 'durationMs']);
      if (input.mime !== 'audio/webm') reject(415, 'Use a supported recording format.');
      if (!Number.isSafeInteger(input.byteLength) || input.byteLength < 1 || input.byteLength > 262144) reject(413, 'That recording is too large.');
      if (!Number.isSafeInteger(input.durationMs) || input.durationMs < 0 || input.durationMs > 120000) reject(400, 'Keep recordings under two minutes.');
      const uploads = await store.list('voice-upload:', 9);
      const live = await store.list('voice:', 21);
      if ([...uploads.values()].filter(value => value.deviceId === screen.id).length >= 3) reject(429, 'Finish a recording first.');
      if ([...live.values()].filter(value => value.deviceId === screen.id).length >= 20) reject(429, 'Your voice messages are full.');
      const uploadId = random(18);
      await store.put('voice-upload:' + uploadId, { id: uploadId, deviceId: screen.id, epoch: screen.epoch, mime: 'audio/webm', totalBytes: input.byteLength, durationMs: input.durationMs, seqs: [], received: 0, createdAt: now, expiresAt: now + 1800000 });
      return { uploadId };
    }
    if (command === 'voice.part') {
      if (screen.allowVoice !== true) reject(403, 'Voice is not allowed from this screen.');
      exact(input, ['uploadId', 'seq', 'data']);
      const upload = await store.get('voice-upload:' + input.uploadId);
      if (!upload || upload.deviceId !== screen.id || upload.expiresAt <= now) reject(404, 'That recording is no longer available.');
      if (!Number.isSafeInteger(input.seq) || input.seq < 0 || input.seq > 511) reject(400, 'Send a supported recording part.');
      if (typeof input.data !== 'string' || !input.data.length || input.data.length > 5600 || !/^[A-Za-z0-9+/=]+$/.test(input.data)) reject(400, 'Send a supported recording part.');
      const part = Buffer.from(input.data, 'base64');
      if (!part.length) reject(400, 'Send a supported recording part.');
      if (upload.received + part.length > upload.totalBytes) reject(413, 'That recording is too large.');
      await store.put('chunk:voice:' + upload.id + ':' + input.seq, { data: input.data });
      if (!upload.seqs.includes(input.seq)) {
        upload.seqs = upload.seqs.concat([input.seq]).sort((a, b) => a - b);
        upload.received += part.length;
      }
      await store.put('voice-upload:' + upload.id, upload);
      return { received: upload.seqs.length };
    }
    if (command === 'voice.end') {
      if (screen.allowVoice !== true) reject(403, 'Voice is not allowed from this screen.');
      exact(input, ['uploadId']);
      const upload = await store.get('voice-upload:' + input.uploadId);
      if (!upload || upload.deviceId !== screen.id || upload.expiresAt <= now) reject(404, 'That recording is no longer available.');
      const seqs = upload.seqs || [];
      if (!seqs.length) reject(400, 'Choose a complete recording.');
      for (let index = 0; index < seqs.length; index++) if (seqs[index] !== index) reject(400, 'Choose a complete recording.');
      const parts = [];
      for (const seq of seqs) { const part = await store.get('chunk:voice:' + upload.id + ':' + seq); if (!part) reject(400, 'Choose a complete recording.'); parts.push(Buffer.from(part.data, 'base64')); }
      const bytes = Buffer.concat(parts);
      if (!bytes.length) reject(400, 'Choose a complete recording.');
      if (bytes.length > 262144) reject(413, 'That recording is too large.');
      const messageId = random(18);
      const encoded = bytes.toString('base64');
      const chunks = [];
      for (let offset = 0; offset < encoded.length; offset += 60000) {
        const key = 'chunk:voice:' + messageId + ':' + chunks.length;
        chunks.push(key);
        await store.put(key, { data: encoded.slice(offset, offset + 60000) });
      }
      for (const seq of seqs) await store.delete('chunk:voice:' + upload.id + ':' + seq);
      await store.delete('voice-upload:' + upload.id);
      await store.put('voice:' + messageId, { id: messageId, deviceId: screen.id, mime: upload.mime, chunks, durationMs: upload.durationMs, state: 'received', createdAt: now, expiresAt: now + 86400000 });
      const content = await store.get('content:' + screen.id);
      if (content && content.expiresAt > now) {
        const snapshot = { ...content.snapshot, voiceAck: { id: messageId, state: 'received' }, generatedAt: now, expiresAt: Math.min(content.snapshot.expiresAt, now + 3600000) };
        screen.revision += 1;
        await store.put('content:' + screen.id, { snapshot, revision: screen.revision, epoch: screen.epoch, expiresAt: snapshot.expiresAt });
        await store.put('receipt:' + screen.id + ':' + String(screen.revision).padStart(10, '0'), { revision: screen.revision, acceptedAt: now, idempotencyKey: 'voice-ack:' + messageId, payloadHash: await digest(JSON.stringify(snapshot)) });
        const receipts = [...(await store.list('receipt:' + screen.id + ':', 25)).keys()];
        while (receipts.length >= 20) await store.delete(receipts.shift());
        await store.put('home', home);
      }
      return { messageId, revision: screen.revision, voiceAck: { id: messageId, state: 'received' } };
    }
    if (command === 'voice.cancel') {
      if (screen.allowVoice !== true) reject(403, 'Voice is not allowed from this screen.');
      exact(input, ['uploadId']);
      const upload = await store.get('voice-upload:' + input.uploadId);
      if (upload && upload.deviceId === screen.id) {
        for (const seq of upload.seqs || []) await store.delete('chunk:voice:' + upload.id + ':' + seq);
        await store.delete('voice-upload:' + upload.id);
      }
      return { ok: true };
    }
    if (command === 'voice.reply') {
      exact(input, ['deviceId', 'messageId', 'displayScene', 'voiceAck', 'idempotencyKey']);
      const message = await store.get('voice:' + input.messageId);
      if (!message || message.expiresAt <= now) reject(404, 'That voice message is no longer available.');
      const content = await store.get('content:' + screen.id);
      const base = content && content.expiresAt > now ? content.snapshot : validateSnapshot({ schemaVersion: 1, timezone: screen.settings.timezone, generatedAt: now, expiresAt: now + 3600000, briefing: { title: 'A little closer to home.', text: 'Your helper is here.' } }, now);
      const next = validateSnapshot({ ...base, displayScene: input.displayScene, voiceAck: input.voiceAck, generatedAt: now, expiresAt: Math.min(base.expiresAt, now + 3600000) }, now);
      const idempotencyKey = input.idempotencyKey === undefined ? 'voice-reply:' + message.id : text(input.idempotencyKey, 100);
      screen.revision += 1;
      await store.put('content:' + screen.id, { snapshot: next, revision: screen.revision, epoch: screen.epoch, expiresAt: next.expiresAt });
      await store.put('receipt:' + screen.id + ':' + String(screen.revision).padStart(10, '0'), { revision: screen.revision, acceptedAt: now, idempotencyKey, payloadHash: await digest(JSON.stringify(next)) });
      const receipts = [...(await store.list('receipt:' + screen.id + ':', 25)).keys()];
      while (receipts.length >= 20) await store.delete(receipts.shift());
      message.state = 'acted';
      if (input.voiceAck && input.voiceAck.agentName) message.agentName = input.voiceAck.agentName;
      await store.put('voice:' + message.id, message);
      await store.put('home', home);
      return { revision: screen.revision, status: 'accepted' };
    }
    if (command === 'device.poll') {
      const content = await store.get('content:' + screen.id);
      if (!content || content.expiresAt <= now) return { state: 'owned', snapshot: null, settings: { ...screen.settings, defaultVoiceAgent: home.settings.defaultVoiceAgent || '' }, allowListEdits: screen.allowListEdits === true, allowVoice: screen.allowVoice === true, defaultVoiceAgent: home.settings.defaultVoiceAgent || '', homeName: home.name, screenName: screen.name, screenIdentifier: screen.id.slice(-6).toUpperCase(), revision: screen.revision, expiresAt: content?.expiresAt };
      const key = 'receipt:' + screen.id + ':' + String(content.revision).padStart(10, '0');
      const receipt = await store.get(key);
      if (!receipt.deliveredAt) { receipt.deliveredAt = now; receipt.nonce = random(24); await store.put(key, receipt); }
      return { state: 'owned', ...content, nonce: receipt.nonce, settings: { ...screen.settings, defaultVoiceAgent: home.settings.defaultVoiceAgent || '' }, allowListEdits: screen.allowListEdits === true, allowVoice: screen.allowVoice === true, defaultVoiceAgent: home.settings.defaultVoiceAgent || '', homeName: home.name, screenName: screen.name, screenIdentifier: screen.id.slice(-6).toUpperCase() };
    }
    if (command === 'device.ack') {
      const content = await store.get('content:' + screen.id);
      if (!content || input.revision !== content.revision || content.expiresAt <= now) reject(409, 'This update is no longer current.');
      const key = 'receipt:' + screen.id + ':' + String(content.revision).padStart(10, '0');
      const receipt = await store.get(key);
      if (!receipt.nonce || receipt.nonce !== input.nonce) reject(403, 'This screen has not received that update.');
      if (!receipt.renderedAt) { receipt.renderedAt = now; await store.put(key, receipt); }
      return { rendered: true };
    }
    reject(404, 'This action is not available.');
  }

  async clearScreenContent(store, deviceId) {
    await store.delete('content:' + deviceId);
    for (const key of (await store.list('receipt:' + deviceId + ':', 25)).keys()) await store.delete(key);
  }

  async media(store, home, command, input, principal, grant) {
    if (command === 'media.list') {
      if (principal.deviceId) reject(403, 'This screen cannot list private photos.');
      return { photos: [...(await store.list('media:', 21)).values()].map(value => ({ mediaId: value.id, mime: value.mime, width: value.width, height: value.height, approvedAt: value.approvedAt })) };
    }
    if (command === 'media.upload') {
      if ((await store.list('media:', 21)).size >= 20) reject(429, 'Please remove a photo before adding another.');
      const image = await normalizeImage(input);
      const id = random(18);
      const chunks = [];
      for (let offset = 0; offset < image.data.length; offset += 60000) {
        const key = 'chunk:' + id + ':' + chunks.length;
        chunks.push(key);
        await store.put(key, { data: image.data.slice(offset, offset + 60000) });
      }
      await store.put('media:' + id, { id, mime: image.mime, width: image.width, height: image.height, chunks, approvedAt: Date.now() });
      return { mediaId: id };
    }
    const media = await store.get('media:' + input.mediaId);
    if (!media) reject(404, 'This photo is no longer available.');
    if (principal.deviceId) {
      const screen = home.screens.find(value => value.id === principal.deviceId && value.epoch === principal.epoch);
      const content = await store.get('content:' + principal.deviceId);
      if (!screen || !screen.settings.showPhotos || !content || content.expiresAt <= Date.now() || !content.snapshot.photos.includes(input.mediaId)) reject(403, 'This photo is not shared with this screen.');
    }
    if (command === 'media.delete') {
      for (const key of media.chunks) await store.delete(key);
      await store.delete('media:' + input.mediaId);
      for (const screen of home.screens) {
        const content = await store.get('content:' + screen.id);
        if (content?.snapshot.photos.includes(input.mediaId)) {
          content.snapshot.photos = content.snapshot.photos.filter(id => id !== input.mediaId);
          screen.revision += 1;
          content.revision = screen.revision;
          await store.put('content:' + screen.id, content);
          await store.put('receipt:' + screen.id + ':' + String(content.revision).padStart(10, '0'), { revision: content.revision, acceptedAt: Date.now(), idempotencyKey: 'photo-remove-' + random(18), payloadHash: await digest(JSON.stringify(content.snapshot)) });
          const receipts = [...(await store.list('receipt:' + screen.id + ':', 30)).keys()];
          while (receipts.length > 20) await store.delete(receipts.shift());
        }
      }
      await store.put('home', home);
      return { deleted: true };
    }
    if (command !== 'media.get' || grant) reject(403, 'This photo is not available to the assistant.');
    let data = '';
    for (const key of media.chunks) { const chunk = await store.get(key); if (!chunk) throw new Error('Missing media chunk.'); data += chunk.data; }
    return { data, mime: media.mime };
  }
}
