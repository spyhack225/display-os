import test from 'node:test';
import assert from 'node:assert/strict';
import { RateBudgets } from '../src/product/budgets.js';

test('public bucket exhaustion cannot consume family screen or approved assistant admission', async () => {
  const budgets = new RateBudgets({ capacity: 2, now: () => 1000 });
  await budgets.take('oauth:entry:attacker-one', 1, 60000);
  await budgets.take('oauth:entry:attacker-two', 1, 60000);
  await assert.rejects(budgets.take('oauth:entry:attacker-three', 1, 60000), { status: 429 });
  await budgets.take('identity:account:owner', 1, 60000);
  await budgets.take('device:screen', 1, 60000);
  await budgets.take('oauth:mcp-grant:approved', 1, 60000);
  await assert.rejects(budgets.take('device:screen', 1, 60000), { status: 429 });
});

test('rate windows and each category capacity recover without growing counters', async () => {
  let now = 1000;
  const budgets = new RateBudgets({ capacity: 1, now: () => now });
  await budgets.take('account:one', 1, 60000);
  await assert.rejects(budgets.take('account:two', 1, 60000), { status: 429 });
  now += 60000;
  await budgets.take('account:two', 1, 60000);
  assert.equal(budgets.groups.get('family').size, 1);
  await budgets.take('oauth:token-client:unproven', 1, 60000);
  assert.equal(budgets.groups.get('public').size, 1);
});
