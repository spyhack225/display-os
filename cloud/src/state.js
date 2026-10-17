import { DisplayModel, fail } from '../../demo/model.js';

export function snapshot(service) {
  return JSON.stringify({
    version: 1,
    devices: service.model.devices,
    requests: service.model.requests,
    grants: service.model.grants,
    sessions: service.sessions,
    limits: service.limits
  }, (key, value) => value instanceof Map ? { deskMap: [...value] } : value);
}

export function restore(service, value) {
  const state = JSON.parse(value, (key, entry) => entry && Array.isArray(entry.deskMap) ? new Map(entry.deskMap) : entry);
  if (state.version !== 1 || ['devices', 'requests', 'grants', 'sessions', 'limits'].some(key => !(state[key] instanceof Map))) {
    throw new Error('Unsupported persisted state.');
  }
  service.model = new DisplayModel({ now: service.now });
  for (const key of ['devices', 'requests', 'grants']) service.model[key] = state[key];
  service.sessions = state.sessions;
  service.limits = state.limits;
}

async function encryptionKey(value) {
  if (!/^[a-f0-9]{64}$/.test(value || '')) throw new Error('Missing encryption key.');
  return crypto.subtle.importKey('raw', Buffer.from(value, 'hex'), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

const context = new TextEncoder().encode('displayos-state-v1');

export async function seal(value, key) {
  const plaintext = new TextEncoder().encode(value);
  if (plaintext.byteLength > 80000) fail(429, 'Pilot storage capacity reached. No change was committed.');
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: context }, await encryptionKey(key), plaintext);
  return { version: 1, nonce: Buffer.from(nonce).toString('base64'), ciphertext: Buffer.from(ciphertext).toString('base64') };
}

export async function unseal(value, key) {
  if (value.version !== 1) throw new Error('Unsupported encrypted state.');
  const plaintext = await crypto.subtle.decrypt({
    name: 'AES-GCM', iv: Buffer.from(value.nonce, 'base64'), additionalData: context
  }, await encryptionKey(key), Buffer.from(value.ciphertext, 'base64'));
  return new TextDecoder().decode(plaintext);
}
