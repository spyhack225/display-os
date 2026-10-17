import { reject } from './common.js';

function group(bucket) {
  if (/^(?:account:|claim:|identity:account:|oauth:approval:|oauth:owner:)/.test(bucket) || bucket === 'factory') return 'family';
  if (bucket.startsWith('device:')) return 'screens';
  if (bucket.startsWith('oauth:mcp-grant:')) return 'assistants';
  return 'public';
}

export class RateBudgets {
  constructor({ now = Date.now, capacity = 2048 } = {}) { this.now = now; this.capacity = capacity; this.groups = new Map(); }

  async take(bucket, limit, windowMs) {
    const now = this.now();
    const name = group(bucket);
    if (!this.groups.has(name)) this.groups.set(name, new Map());
    const values = this.groups.get(name);
    const previous = values.get(bucket);
    if (previous && previous.until > now) {
      if (previous.count >= limit) reject(429, 'Please wait a moment and try again.');
      previous.count += 1;
      return;
    }
    if (values.size >= this.capacity) {
      for (const [key, value] of values) if (value.until <= now) values.delete(key);
      if (values.size >= this.capacity) reject(429, 'Please wait a moment and try again.');
    }
    values.set(bucket, { count: 1, until: now + windowMs });
  }
}
