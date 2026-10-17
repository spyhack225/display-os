import { fail } from '../../demo/model.js';
import { errorResponse } from './service.js';
import { snapshot, restore, seal } from './state.js';

export async function commit(service, request, storage, key) {
  const previous = snapshot(service);
  let response;
  try { response = await service.handle(request); }
  catch (error) { response = errorResponse(error); }
  try {
    const next = snapshot(service);
    if (next === previous) return response;
    const route = new URL(request.url).pathname;
    const grows = request.method === 'POST' && (['/api/displays', '/api/owner/login', '/api/agent/requests'].includes(route) || route.endsWith('/content'));
    if (response.ok && grows && new TextEncoder().encode(next).byteLength > 60000) fail(429, 'Pilot content capacity reached. Logout and revocation remain available.');
    await storage.put('state', await seal(next, key));
    return response;
  } catch (error) {
    restore(service, previous);
    return errorResponse(error);
  }
}
