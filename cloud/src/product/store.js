import { reject } from './common.js';

export class RecordStore {
  constructor(storage, key, namespace) {
    if (!/^[a-f0-9]{64}$/.test(key || '')) throw new Error('Product storage is not configured.');
    this.storage = storage;
    this.key = key;
    this.namespace = namespace;
    this.cryptoKey = crypto.subtle.importKey('raw', Buffer.from(key, 'hex'), 'AES-GCM', false, ['encrypt', 'decrypt']);
  }

  context(key) { return new TextEncoder().encode('displayos-record-v1:' + this.namespace + ':' + key); }

  async decode(key, value) {
    if (!value) return undefined;
    if (value.version !== 1) throw new Error('Unsupported product record.');
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(value.nonce, 'base64'), additionalData: this.context(key) }, await this.cryptoKey, Buffer.from(value.data, 'base64'));
    return JSON.parse(new TextDecoder().decode(decrypted));
  }

  async get(key) { return this.decode(key, await this.storage.get(key)); }

  async put(key, value) {
    const encoded = new TextEncoder().encode(JSON.stringify(value));
    if (encoded.byteLength > 90000) reject(413, 'This item is too large to save.');
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: this.context(key) }, await this.cryptoKey, encoded);
    await this.storage.put(key, { version: 1, nonce: Buffer.from(nonce).toString('base64'), data: Buffer.from(encrypted).toString('base64') });
  }

  async delete(key) { return this.storage.delete(key); }

  async list(prefix, limit = 200) {
    const records = await this.storage.list({ prefix, limit });
    const result = new Map();
    for (const [key, value] of records) result.set(key, await this.decode(key, value));
    return result;
  }

  async transaction(callback) {
    return this.storage.transaction(storage => callback(new RecordStore(storage, this.key, this.namespace)));
  }
}
