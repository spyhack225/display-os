import { digest, reject } from './common.js';

const TTL = 120000;
const WINDOW = 600000;
const CAPACITY = 128;
const BUDGET_KEY = 'pair-manual-budget';
const RETRIES = 16;
const UNIFORM_LIMIT = 4294000000;

function validTime(now) {
  if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - WINDOW) reject(400, 'Please try again.');
}

function manualCode() {
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    const value = crypto.getRandomValues(new Uint32Array(1))[0];
    if (value < UNIFORM_LIMIT) return String(value % 1000000).padStart(6, '0');
  }
  reject(503, 'We could not prepare a new code. Please try again.');
}

function available(pointer, now) {
  return !pointer || Number.isSafeInteger(pointer.expiresAt) && pointer.expiresAt <= now;
}

function matches(pointer, pairing, codeHash) {
  return pointer?.codeHash === codeHash && pointer.expiresAt === pairing.expiresAt;
}

export async function removePairing(store, pairing) {
  if (!pairing || !Number.isSafeInteger(pairing.expiresAt)) return;
  if (/^[A-F0-9]{12}$/.test(pairing.code)) {
    const key = 'pair:' + await digest(pairing.code);
    const pointer = await store.get(key);
    if (pointer && !Object.hasOwn(pointer, 'codeHash') && pointer.expiresAt === pairing.expiresAt) await store.delete(key);
    return;
  }
  if (!/^[A-F0-9]{32}$/.test(pairing.code)) return;
  const codeHash = await digest(pairing.code);
  const key = 'pair:' + codeHash;
  if (matches(await store.get(key), pairing, codeHash)) await store.delete(key);
  if (!/^\d{6}$/.test(pairing.manualCode)) return;
  const manualKey = 'pair-manual:' + await digest(pairing.manualCode);
  if (matches(await store.get(manualKey), pairing, codeHash)) await store.delete(manualKey);
}

export async function createPairing(store, device, origin, now) {
  validTime(now);
  if (!device || typeof device.id !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(device.id) || !Number.isSafeInteger(device.epoch) || device.epoch < 1) reject(400, 'This screen could not be verified.');
  let parsed;
  try { parsed = new URL(origin); } catch { reject(400, 'Please use a secure connection.'); }
  if (parsed.protocol !== 'https:' || parsed.origin !== origin || parsed.username || parsed.password) reject(400, 'Please use a secure connection.');
  return store.transaction(async transaction => {
    const current = await transaction.get('device:' + device.id);
    if (!current || current.epoch !== device.epoch || current.state !== 'unclaimed') reject(409, 'This screen is already being set up.');
    const previous = current.pairing;
    if (previous?.expiresAt > now && /^[A-F0-9]{32}$/.test(previous.code) && /^\d{6}$/.test(previous.manualCode)) {
      const codeHash = await digest(previous.code);
      const pointers = await Promise.all([transaction.get('pair:' + codeHash), transaction.get('pair-manual:' + await digest(previous.manualCode))]);
      if (pointers.every(pointer => matches(pointer, previous, codeHash) && pointer.deviceId === current.id && pointer.epoch === current.epoch)) return previous;
    }
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      const code = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('hex').toUpperCase();
      const numeric = manualCode();
      const codeHash = await digest(code);
      const key = 'pair:' + codeHash;
      const manualKey = 'pair-manual:' + await digest(numeric);
      if (!available(await transaction.get(key), now) || !available(await transaction.get(manualKey), now)) continue;
      const pairing = { code, manualCode: numeric, expiresAt: now + TTL, url: origin + '/home#pair=' + code };
      const pointer = { deviceId: current.id, epoch: current.epoch, expiresAt: pairing.expiresAt, codeHash };
      await removePairing(transaction, previous);
      await transaction.put(key, pointer);
      await transaction.put(manualKey, pointer);
      await transaction.put('device:' + current.id, { ...current, pairing });
      return pairing;
    }
    reject(503, 'We could not prepare a new code. Please try again.');
  });
}

function pruneBuckets(buckets, now, window) {
  const result = {};
  for (const [key, timestamps] of Object.entries(buckets)) {
    const live = timestamps.filter(timestamp => timestamp > now - window);
    if (live.length) result[key] = live;
  }
  return result;
}

export async function takeManualClaimBudget(store, accountId, ip, now) {
  validTime(now);
  if (typeof accountId !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(accountId) || typeof ip !== 'string' || !ip || ip.length > 80 || /[\u0000-\u001f\u007f]/.test(ip)) reject(400, 'Please try again.');
  const accountHash = await digest(accountId);
  const ipHash = await digest(ip);
  await store.transaction(async transaction => {
    const stored = await transaction.get(BUDGET_KEY) || { accounts: {}, ips: {}, global: [] };
    const accounts = pruneBuckets(stored.accounts, now, WINDOW);
    const ips = pruneBuckets(stored.ips, now, WINDOW);
    const global = stored.global.filter(timestamp => timestamp > now - TTL);
    const account = accounts[accountHash] || [];
    const address = ips[ipHash] || [];
    if (account.length >= 5 || address.length >= 20 || global.length >= 120 || !accounts[accountHash] && Object.keys(accounts).length >= CAPACITY || !ips[ipHash] && Object.keys(ips).length >= CAPACITY) reject(429, 'Please wait before trying another screen code.');
    accounts[accountHash] = [...account, now];
    ips[ipHash] = [...address, now];
    await transaction.put(BUDGET_KEY, { accounts, ips, global: [...global, now] });
  });
}
