export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function reject(status, message) { throw new HttpError(status, message); }
const publicConnectionPaths = new Set(['/skill.md', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']);
export function publicConnectionRead(request) {
  const url = new URL(request.url);
  return request.method === 'GET' && url.protocol === 'https:' && !request.url.includes('?') && !request.url.includes('#') && !url.username && !url.password && publicConnectionPaths.has(url.pathname);
}
export function publicConnectionResponse(request, response) {
  if (!publicConnectionRead(request) || !response.ok) return response;
  const result = new Response(response.body, response);
  result.headers.delete('Access-Control-Allow-Credentials');
  result.headers.delete('Set-Cookie');
  result.headers.set('Access-Control-Allow-Origin', '*');
  return result;
}
export function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
}
export function random(bytes = 32) { return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url'); }
export async function digest(value) { return Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))).toString('base64url'); }
export function bearer(request) {
  const value = request.headers.get('authorization') || '';
  if (!/^Bearer [A-Za-z0-9_-]{20,256}$/.test(value)) reject(401, 'Please sign in again.');
  return value.slice(7);
}
export function text(value, max = 80) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[<>\u0000-\u001f\u007f]/u.test(value)) reject(400, 'Please use a short, plain-text value.');
  return value.trim();
}
export function exact(value, allowedKeys) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).some(key => !allowedKeys.includes(key))) reject(400, 'This information is not supported.');
  return value;
}
export async function readBytes(request, maxBytes = 200000) {
  if (Number(request.headers.get('content-length')) > maxBytes) reject(413, 'This update is too large.');
  if (!request.body) reject(400, 'Please send the information required.');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  let timer;
  const deadline = new Promise((resolve, rejectPromise) => { timer = setTimeout(() => rejectPromise(new HttpError(408, 'Please try again.')), 5000); });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) reject(413, 'This update is too large.');
      chunks.push(part.value);
    }
    return Buffer.concat(chunks);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    reject(400, 'We could not read this information.');
  } finally { clearTimeout(timer); await reader.cancel().catch(() => {}); }
}
export async function readJson(request, maxBytes = 65536) {
  if (!request.headers.get('content-type')?.toLowerCase().startsWith('application/json')) reject(415, 'Please send JSON.');
  const bytes = await readBytes(request, maxBytes);
  try {
    const result = JSON.parse(bytes.toString('utf8'));
    if (!result || Array.isArray(result) || typeof result !== 'object') reject(400, 'Please send an object.');
    return result;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    reject(400, 'We could not read this information.');
  }
}
export function errorResponse(error) {
  return json({ error: error instanceof HttpError ? error.message : 'We could not save this change. Please try again.' }, error instanceof HttpError ? error.status : 503);
}
export function internalRequest(origin, command, input, principal, credential) {
  return new Request(origin + '/internal', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-DisplayOS-Internal': credential }, body: JSON.stringify({ command, input, principal }) });
}
