import { randomBytes, timingSafeEqual } from 'node:crypto';

export function secret(bytes = 32) {
  return randomBytes(bytes).toString('hex');
}

export function equalSecret(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function plainText(value, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[<>\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    fail(400, 'Use bounded plain text, without markup or control characters.');
  }
  return value.trim();
}

function exactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
    fail(400, 'Unexpected payload fields.');
  }
}

function duration(value, maximum) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) fail(400, 'Invalid expiration duration.');
  return value * 1000;
}

export class DisplayModel {
  constructor({ now = Date.now, pairingTtl = 120000, requestTtl = 300000 } = {}) {
    this.now = now;
    this.pairingTtl = pairingTtl;
    this.requestTtl = requestTtl;
    this.devices = new Map();
    this.requests = new Map();
    this.grants = new Map();
  }

  enroll(body) {
    exactKeys(body, ['name']);
    if (this.devices.size >= 32) fail(429, 'Demo display limit reached. Restart to clear state.');
    const device = {
      id: secret(12), name: plainText(body.name, 60), token: secret(), owner: null,
      revision: 0, revisions: new Map(), publishes: new Map()
    };
    this.devices.set(device.id, device);
    this.rotatePairing(device);
    return { deviceId: device.id, deviceToken: device.token, pairing: device.pairing };
  }

  rotatePairing(device) {
    if (device.owner) fail(409, 'This display is already claimed.');
    device.pairing = { sessionId: secret(16), code: secret(6).toUpperCase(), expiresAt: this.now() + this.pairingTtl, used: false };
    return device.pairing;
  }

  device(id) {
    const device = this.devices.get(id);
    if (!device) fail(404, 'Display not found.');
    return device;
  }

  transport(id, token) {
    const device = this.device(id);
    if (!equalSecret(token, device.token)) fail(401, 'Display transport authentication required.');
    return device;
  }

  owned(id, owner) {
    const device = this.device(id);
    if (device.owner !== owner) fail(403, 'Owner does not control this display.');
    return device;
  }

  claim(owner, body) {
    exactKeys(body, ['code', 'sessionId']);
    if (typeof body.code !== 'string' || typeof body.sessionId !== 'string') fail(400, 'Pairing code and session are required.');
    const device = [...this.devices.values()].find(entry => equalSecret(entry.pairing.code, body.code.toUpperCase()));
    if (!device || !equalSecret(device.pairing.sessionId, body.sessionId)) fail(400, 'Pairing code and session do not match.');
    if (device.pairing.used || device.owner) fail(409, 'Pairing code has already been used.');
    if (device.pairing.expiresAt <= this.now()) fail(410, 'Pairing code has expired. Generate a new code on the display.');
    device.owner = owner;
    device.pairing.used = true;
    return { deviceId: device.id, name: device.name, agentAccess: false };
  }

  requestGrant(body) {
    exactKeys(body, ['deviceId', 'label', 'scopes', 'ttlSeconds']);
    const device = this.device(body.deviceId);
    if (!device.owner) fail(409, 'The owner must claim the display first.');
    if (this.requests.size >= 128) fail(429, 'Demo request limit reached. Restart to clear state.');
    if (!Array.isArray(body.scopes) || !body.scopes.length || new Set(body.scopes).size !== body.scopes.length || body.scopes.some(scope => !['display:read', 'content:write'].includes(scope))) {
      fail(400, 'Only display:read and content:write are supported.');
    }
    const request = {
      id: secret(12), token: secret(), deviceId: device.id, owner: device.owner,
      label: plainText(body.label, 60), scopes: [...body.scopes],
      ttl: duration(body.ttlSeconds, 3600), expiresAt: this.now() + this.requestTtl, status: 'pending'
    };
    this.requests.set(request.id, request);
    return { requestId: request.id, requestToken: request.token, expiresAt: request.expiresAt, status: 'pending' };
  }

  approve(owner, requestId, body) {
    exactKeys(body, ['approved']);
    if (body.approved !== true) fail(400, 'Explicit approval is required.');
    const request = this.requests.get(requestId);
    if (!request) fail(404, 'Agent request not found.');
    this.owned(request.deviceId, owner);
    if (request.owner !== owner) fail(403, 'Wrong owner.');
    if (request.expiresAt <= this.now()) fail(410, 'Agent request has expired.');
    if (request.status !== 'pending') fail(409, 'Agent request has already been decided.');
    const grant = {
      id: secret(12), token: secret(), deviceId: request.deviceId, owner, label: request.label,
      scopes: [...request.scopes], expiresAt: this.now() + request.ttl, revoked: false
    };
    this.grants.set(grant.id, grant);
    request.status = 'approved';
    request.grantId = grant.id;
    return { grantId: grant.id, deviceId: grant.deviceId, scopes: grant.scopes, expiresAt: grant.expiresAt };
  }

  requestStatus(id, token) {
    const request = this.requests.get(id);
    if (!request || !equalSecret(token, request.token)) fail(401, 'Agent request authentication required.');
    if (request.expiresAt <= this.now()) fail(410, 'Agent request has expired.');
    const grant = this.grants.get(request.grantId);
    if (grant && (grant.revoked || grant.expiresAt <= this.now())) return { status: grant.revoked ? 'revoked' : 'expired' };
    if (!grant) return { status: request.status };
    return { status: 'approved', grantId: grant.id, grantToken: grant.token, deviceId: grant.deviceId, scopes: grant.scopes, expiresAt: grant.expiresAt };
  }

  agent(id, token, scope) {
    const grant = [...this.grants.values()].find(entry => equalSecret(entry.token, token));
    if (!grant || grant.revoked || grant.expiresAt <= this.now()) fail(401, 'Active agent grant required.');
    if (grant.deviceId !== id || !grant.scopes.includes(scope)) fail(403, 'Grant does not allow this display or operation.');
    return grant;
  }

  revoke(owner, grantId) {
    const grant = this.grants.get(grantId);
    if (!grant) fail(404, 'Agent grant not found.');
    this.owned(grant.deviceId, owner);
    if (grant.owner !== owner) fail(403, 'Wrong owner.');
    grant.revoked = true;
    return { revoked: true };
  }

  publish(id, token, body, key) {
    const grant = this.agent(id, token, 'content:write');
    exactKeys(body, ['expectedRevision', 'ttlSeconds', 'cards']);
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(key)) fail(400, 'Use an 8 to 80 character Idempotency-Key.');
    if (!Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) fail(400, 'Expected revision is required.');
    const ttl = duration(body.ttlSeconds, 86400);
    if (!Array.isArray(body.cards) || body.cards.length < 1 || body.cards.length > 4) fail(400, 'Supply 1 to 4 text cards.');
    const cards = body.cards.map(card => {
      exactKeys(card, ['title', 'text']);
      return { title: plainText(card.title, 80), text: plainText(card.text, 600) };
    });
    const device = this.device(id);
    const fingerprint = JSON.stringify({ expectedRevision: body.expectedRevision, ttlSeconds: body.ttlSeconds, cards });
    const keyId = grant.id + ':' + key;
    const previous = device.publishes.get(keyId);
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail(409, 'Idempotency key was used with different content.');
      return this.revisionStatus(device, previous.revision);
    }
    if (device.revision !== body.expectedRevision) fail(409, 'Revision conflict. Read status before publishing.');
    if (device.revisions.size >= 100) fail(429, 'Demo revision limit reached. Restart to clear state.');
    const revision = ++device.revision;
    device.revisions.set(revision, { revision, cards, acceptedAt: this.now(), expiresAt: this.now() + ttl, downloadedAt: null, renderedAt: null, nonce: null });
    device.publishes.set(keyId, { fingerprint, revision });
    return this.revisionStatus(device, revision);
  }

  revisionStatus(device, revision) {
    const content = device.revisions.get(revision);
    if (!content) fail(404, 'Revision not found.');
    return {
      revision, status: content.expiresAt <= this.now() ? 'expired' : content.renderedAt !== null ? 'rendered' : content.downloadedAt !== null ? 'downloaded' : 'accepted',
      acceptedAt: content.acceptedAt, downloadedAt: content.downloadedAt, renderedAt: content.renderedAt, expiresAt: content.expiresAt
    };
  }

  poll(device) {
    const content = device.revisions.get(device.revision);
    let delivery = null;
    if (content && content.expiresAt > this.now()) {
      if (content.downloadedAt === null) content.downloadedAt = this.now();
      if (!content.nonce) content.nonce = secret();
      delivery = { revision: content.revision, cards: content.cards, expiresAt: content.expiresAt, deliveryNonce: content.nonce };
    }
    return {
      deviceId: device.id, name: device.name, claimed: !!device.owner, serverTime: this.now(), revision: device.revision,
      pairing: device.owner ? null : device.pairing, delivery
    };
  }

  acknowledge(device, body) {
    exactKeys(body, ['revision', 'deliveryNonce']);
    if (!Number.isInteger(body.revision)) fail(400, 'Revision must be an integer.');
    const content = device.revisions.get(body.revision);
    if (!content || content.downloadedAt === null || !equalSecret(body.deliveryNonce, content.nonce)) fail(400, 'A delivered revision and its nonce are required.');
    if (device.revision !== body.revision) fail(409, 'Stale acknowledgement cannot update the latest revision.');
    if (content.expiresAt <= this.now()) fail(410, 'Content has expired.');
    if (content.renderedAt === null) content.renderedAt = this.now();
    return this.revisionStatus(device, body.revision);
  }

  ownerView(owner) {
    return {
      devices: [...this.devices.values()].filter(device => device.owner === owner).map(device => ({
        deviceId: device.id, name: device.name, revision: device.revision,
        latest: device.revision ? this.revisionStatus(device, device.revision) : null
      })),
      requests: [...this.requests.values()].filter(request => request.owner === owner && request.status === 'pending' && request.expiresAt > this.now()).map(request => ({
        requestId: request.id, deviceId: request.deviceId, label: request.label, scopes: request.scopes, expiresAt: request.expiresAt, ttlSeconds: request.ttl / 1000
      })),
      grants: [...this.grants.values()].filter(grant => grant.owner === owner).map(grant => ({
        grantId: grant.id, deviceId: grant.deviceId, label: grant.label, scopes: grant.scopes, expiresAt: grant.expiresAt,
        status: grant.revoked ? 'revoked' : grant.expiresAt <= this.now() ? 'expired' : 'active'
      }))
    };
  }
}
