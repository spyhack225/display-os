import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../product-public/common.js', import.meta.url), 'utf8');

function fixture() {
  const requests = [];
  class Request {
    constructor() { requests.push(this); }
    open(method, path) { this.method = method; this.path = path; }
    setRequestHeader() {}
    send() { this.status = 200; this.responseText = '{}'; this.onload(); }
  }
  const sandbox = { window: {}, document: {}, XMLHttpRequest: Request };
  runInNewContext(source, sandbox);
  return { ui: sandbox.window.DisplayOSUI, requests };
}

test('local Google lookups allow their bounded multi-request native and provider budgets', async () => {
  const state = fixture();
  for (const path of ['/device/v1/local', '/api/v1/providers/google/weather', '/api/v1/providers/google/nearby']) {
    await state.ui.request(path);
    assert.equal(state.requests.at(-1).timeout, 45000);
  }
});

test('other requests retain the short connection budget and cannot choose an arbitrary timeout', async () => {
  const state = fixture();
  for (const path of ['/device/v1/poll', '/auth/login/options', '/api/v1/home', '/device/v1/local?extra=true', '/api/v1/providers/google/calendar']) {
    await state.ui.request(path, { timeout: 999999 });
    assert.equal(state.requests.at(-1).timeout, 12000);
  }
});
