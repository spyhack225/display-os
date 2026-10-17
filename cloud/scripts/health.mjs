export async function waitForHealth(origin, { fetcher = fetch, delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)), attempts = 12 } = {}) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin) throw new Error('An exact HTTPS origin is required.');
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 12) throw new Error('Use 1 to 12 health attempts.');
  for (let attempt = 0; attempt < attempts; attempt++) {
    let response;
    try { response = await fetcher(origin + '/api/health', { signal: AbortSignal.timeout(8000) }); }
    catch { response = null; }
    if (response?.ok) {
      let result;
      try { result = await response.json(); } catch { result = null; }
      if (result?.service === 'displayos-cloud' && result.syntheticOnly === true) return;
      throw new Error('Unexpected service at the deployment hostname.');
    }
    if (attempt < attempts - 1) await delay(3000);
  }
  throw new Error('Deployment completed but live health did not pass after bounded retries. Do not claim the pilot is verified.');
}
