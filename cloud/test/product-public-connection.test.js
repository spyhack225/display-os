import test from 'node:test';
import assert from 'node:assert/strict';
import { publicConnectionRead, publicConnectionResponse } from '../src/product/common.js';

const origin = 'https://displayos.example.com';
const paths = ['/skill.md', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'];

test('public connection reads allow only the four canonical HTTPS GET paths', () => {
  for (const path of paths) {
    for (const source of ['https://chatgpt.com', 'null']) {
      const request = new Request(origin + path, { headers: { Origin: source } });
      assert.equal(publicConnectionRead(request), true);
      const response = publicConnectionResponse(request, new Response('public'));
      assert.equal(response.headers.get('access-control-allow-origin'), '*');
      assert.equal(response.headers.get('access-control-allow-credentials'), null);
      assert.equal(response.headers.get('set-cookie'), null);
    }
  }
});

test('public connection access never widens protected routes or noncanonical URLs', () => {
  for (const path of ['/home', '/mcp', '/oauth/token', '/oauth/register', '/api/v1/me', '/device/v1/local', '/product/skill.md', '/skill.md/']) {
    const request = new Request(origin + path);
    assert.equal(publicConnectionRead(request), false);
    assert.equal(publicConnectionResponse(request, new Response('protected')).headers.get('access-control-allow-origin'), null);
  }
  for (const path of paths) {
    for (const method of ['HEAD', 'POST', 'DELETE', 'OPTIONS']) assert.equal(publicConnectionRead(new Request(origin + path, { method })), false);
    for (const address of [origin + path + '?', origin + path + '#', origin + path + '?code=not-secret', origin + path + '#fragment', 'http://displayos.example.com' + path]) assert.equal(publicConnectionRead(new Request(address)), false);
  }
});

test('public connection error responses do not receive a cross-origin exception', () => {
  const request = new Request(origin + '/skill.md');
  for (const status of [400, 401, 403, 404, 429, 503]) assert.equal(publicConnectionResponse(request, new Response('error', { status })).headers.get('access-control-allow-origin'), null);
});

test('public connection responses explicitly remove credential and cookie headers', () => {
  const response = publicConnectionResponse(new Request(origin + '/skill.md'), new Response('public', { headers: { 'Access-Control-Allow-Credentials': 'true', 'Set-Cookie': 'synthetic=marker; Secure' } }));
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
  assert.equal(response.headers.get('set-cookie'), null);
});
