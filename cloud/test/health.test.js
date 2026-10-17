import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForHealth } from '../scripts/health.mjs';

test('live health tolerates propagation but requires the expected service', async () => {
  let calls = 0;
  let waits = 0;
  await waitForHealth('https://pilot.example.com', {
    fetcher: async () => ++calls === 1 ? new Response('propagating', { status: 503 }) : Response.json({ service: 'displayos-cloud', syntheticOnly: true }),
    delay: async () => { waits++; }
  });
  assert.equal(calls, 2);
  assert.equal(waits, 1);
});

test('live health stops after its retry budget without claiming success', async () => {
  let calls = 0;
  await assert.rejects(() => waitForHealth('https://pilot.example.com', {
    fetcher: async () => { calls++; throw new Error('Transient network failure'); }, delay: async () => {}, attempts: 3
  }), /bounded retries/);
  assert.equal(calls, 3);
});

test('health rejects wrong services and insecure origins', async () => {
  await assert.rejects(() => waitForHealth('http://pilot.example.com'), /HTTPS/);
  await assert.rejects(() => waitForHealth('https://pilot.example.com', { attempts: 13 }), /attempts/);
  await assert.rejects(() => waitForHealth('https://pilot.example.com', { fetcher: async () => Response.json({ service: 'other-service' }) }), /Unexpected service/);
});
