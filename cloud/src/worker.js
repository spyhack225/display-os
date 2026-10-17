import { DurableObject } from 'cloudflare:workers';
import { configuration, CloudService, errorResponse, body } from './service.js';
import { fail } from '../../demo/model.js';
import { restore, unseal } from './state.js';
import { commit } from './persistence.js';
import { readBytes, publicConnectionRead, publicConnectionResponse } from './product/common.js';
export { ProductRegistry } from './product/registry.js';
export { HouseholdState } from './product/household.js';

const assets = new Map([
  ['/', '/display.html'], ['/display', '/display.html'], ['/setup', '/setup.html'],
  ['/agent', '/agent.html'], ['/operator', '/operator.html'], ['/app.js', '/app.js'], ['/owner.js', '/owner.js'],
  ['/style.css', '/style.css'], ['/skill.md', '/skill.md'], ['/api-contract.json', '/api-contract.json']
]);

const productAssets = new Map([
  ['/', '/product/welcome.html'], ['/welcome', '/product/welcome.html'],
  ['/home', '/product/home.html'], ['/setup', '/product/home.html'],
  ['/screen', '/product/screen.html'], ['/display', '/product/screen.html'],
  ['/privacy', '/product/privacy.html'], ['/skill.md', '/product/skill.md']
]);
const productRoute = path => path.startsWith('/api/v1/') || path.startsWith('/auth/') || path.startsWith('/oauth/') || path.startsWith('/device/v1/') || path.startsWith('/factory/v1/') || path === '/mcp' || path.startsWith('/.well-known/');

function secure(response, product = false) {
  const result = new Response(response.body, response);
  result.headers.set('Cache-Control', 'no-store');
  result.headers.set('X-Content-Type-Options', 'nosniff');
  result.headers.set('Referrer-Policy', 'no-referrer');
  result.headers.set('Strict-Transport-Security', 'max-age=31536000');
  result.headers.set('X-Frame-Options', 'DENY');
  result.headers.set('Permissions-Policy', 'camera=(), microphone=(self), geolocation=()');
  result.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src " + (product ? "'self' blob: data:" : "'none'") + "; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  return result;
}

export class PilotState extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.service = new CloudService(env);
    this.ctx.blockConcurrencyWhile(async () => {
      const saved = await this.ctx.storage.get('state');
      if (saved) restore(this.service, await unseal(saved, env.STATE_ENCRYPTION_KEY));
    });
  }

  async fetch(request) {
    return this.ctx.blockConcurrencyWhile(() => commit(this.service, request, this.ctx.storage, this.env.STATE_ENCRYPTION_KEY));
  }
}

export default {
  async fetch(request, env) {
    try {
      const origin = configuration(env);
      const url = new URL(request.url);
      if (url.origin !== origin) fail(403, 'Unexpected origin. Use the configured HTTPS hostname.');
      if (productRoute(url.pathname)) {
        if (!['GET', 'POST', 'DELETE', 'OPTIONS'].includes(request.method)) fail(405, 'This method is not supported.');
        if (request.headers.has('origin') && request.headers.get('origin') !== origin && !publicConnectionRead(request)) fail(403, 'Cross-origin requests are not allowed.');
        if (!/^[a-f0-9]{64}$/.test(env.PRODUCT_STATE_KEY || '') || !/^[a-f0-9]{64}$/.test(env.FACTORY_CREDENTIAL || '')) fail(503, 'DisplayOS is being prepared. Please try again shortly.');
        let buffered = request;
        if (request.method === 'POST') {
          const bytes = await readBytes(request);
          const headers = new Headers(request.headers);
          headers.delete('content-length');
          buffered = new Request(request.url, { method: 'POST', headers, body: bytes });
        }
        return secure(publicConnectionResponse(request, await env.REGISTRY.get(env.REGISTRY.idFromName('displayos-identity-v1')).fetch(buffered)), true);
      }
      if (url.search) fail(400, 'Query parameters are not supported. Never put credentials in URLs.');
      if (request.headers.has('origin') && request.headers.get('origin') !== origin && !publicConnectionRead(request)) fail(403, 'Cross-origin requests are not allowed.');
      if (request.method === 'GET' && assets.has(url.pathname)) {
        if (productAssets.has(url.pathname)) return secure(publicConnectionResponse(request, await env.ASSETS.fetch(new Request(origin + productAssets.get(url.pathname)))), true);
        const asset = new Request(origin + assets.get(url.pathname), { method: 'GET' });
        return secure(await env.ASSETS.fetch(asset));
      }
      if (request.method === 'GET' && (productAssets.has(url.pathname) || /^\/product\/[a-z0-9._-]+$/.test(url.pathname))) {
        return secure(await env.ASSETS.fetch(new Request(origin + (productAssets.get(url.pathname) || url.pathname))), true);
      }
      if (request.method === 'GET' && ['/pilot/setup', '/pilot/display', '/pilot/skill.md'].includes(url.pathname)) {
        const path = url.pathname === '/pilot/setup' ? '/setup.html' : url.pathname === '/pilot/display' ? '/display.html' : '/skill.md';
        return secure(await env.ASSETS.fetch(new Request(origin + path)));
      }
      if (!url.pathname.startsWith('/api/')) fail(404, 'Route not found.');
      if (!['GET', 'POST'].includes(request.method)) fail(405, 'Only GET and POST are supported.');
      let forwarded = request;
      if (request.method === 'POST') {
        if (request.headers.get('x-demo-request') !== '1') fail(403, 'X-Demo-Request: 1 is required.');
        if (url.pathname.startsWith('/api/owner/') && request.headers.get('origin') !== origin) fail(403, 'Owner changes require the exact browser origin.');
        const value = await body(request);
        const headers = new Headers(request.headers);
        headers.delete('content-length');
        forwarded = new Request(request.url, { method: 'POST', headers, body: JSON.stringify(value) });
      }
      return secure(await env.PILOT.get(env.PILOT.idFromName('bounded-pilot-v1')).fetch(forwarded));
    } catch (error) { return secure(errorResponse(error)); }
  }
};
