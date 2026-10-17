const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions';
const TRANSCRIBE_MODEL = 'gpt-4o-transcribe';
const WORKERS_MODEL = '@cf/openai/whisper-large-v3-turbo';
const SCENE_TTL_SECONDS = 600;

function freshId() {
  const provider = globalThis.crypto;
  if (provider && typeof provider.getRandomValues === 'function') {
    return Array.from(provider.getRandomValues(new Uint8Array(12)), value => ID_CHARS[value % ID_CHARS.length]).join('');
  }
  return Array.from({ length: 12 }, () => ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)]).join('');
}

function shortDay(iso) {
  const raw = typeof iso === 'string' ? iso : '';
  try {
    const parsed = new Date(raw + 'T12:00:00Z');
    if (!raw || Number.isNaN(parsed.getTime())) return raw;
    return parsed.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', day: 'numeric' });
  } catch {
    return raw;
  }
}

function clamp(value, min, max) {
  const number = Number(value);
  return Math.min(max, Math.max(min, Number.isFinite(number) ? number : min));
}

function row(label, value, tone) {
  const result = { label, value };
  if (tone !== undefined) result.tone = tone;
  return result;
}

function rowsBlock(rows) {
  return [{ type: 'rows', rows }];
}

function makeScene(kind, title, blocks, subtitle) {
  const scene = { id: freshId(), kind, title, blocks, ttlSeconds: SCENE_TTL_SECONDS };
  const extra = subtitle === undefined ? '' : String(subtitle).trim();
  if (extra) scene.subtitle = extra.slice(0, 240);
  return scene;
}

function findList(lists, target) {
  const key = String(target == null ? '' : target).replace(/^the\s+/, '').replace(/\s+list$/, '');
  if (!key) return null;
  return lists.find(entry => entry && ((entry.kind === 'groceries' && /grocer|shop/.test(key)) || (entry.kind === 'todo' && /to-?do|task/.test(key)) || String(entry.title || '').toLowerCase().indexOf(key) >= 0)) || null;
}

function findItem(lists, target, subject, openOnly) {
  let entries = lists;
  if (target) {
    const entry = findList(lists, target);
    entries = entry ? [entry] : [];
  }
  for (const entry of entries) {
    for (const item of (Array.isArray(entry.items) ? entry.items : [])) {
      if (!item || String(item.text || '').toLowerCase().indexOf(subject) < 0) continue;
      if (openOnly && item.done) continue;
      return { listId: entry.id, item };
    }
  }
  return null;
}

function listScene(lists, kind, title, emptyTitle, hint) {
  const entry = lists.find(value => value && value.kind === kind);
  const rows = (entry && Array.isArray(entry.items) ? entry.items : []).slice(0, 6).map(item => row(String(item.text || '').slice(0, 80), String(item.person || (item.done ? 'Done' : 'Open')).slice(0, 80), item.done ? 'good' : undefined));
  if (!rows.length) return { displayScene: makeScene('note', emptyTitle, [{ type: 'text', text: hint }]) };
  return { displayScene: makeScene('list', title, rowsBlock(rows)) };
}

export async function transcribeVoice(bytes, mime, env, fetchImpl = globalThis.fetch) {
  try {
    const source = env || {};
    const key = source.VOICE_API_KEY;
    if (typeof key === 'string' && key) {
      const form = new FormData();
      form.set('file', new File([bytes], 'clip.webm', { type: 'audio/webm' }));
      form.set('model', TRANSCRIBE_MODEL);
      form.set('response_format', 'json');
      const response = await fetchImpl(TRANSCRIBE_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: form });
      if (!response || !response.ok) return null;
      const payload = await response.json();
      return String(payload && payload.text || '').trim() || null;
    }
    if (source.AI && typeof source.AI.run === 'function') {
      const result = await source.AI.run(WORKERS_MODEL, { audio: Array.from(bytes) });
      const value = typeof result === 'string' ? result : result && result.text;
      return typeof value === 'string' ? value.trim() || null : null;
    }
    return null;
  } catch {
    return null;
  }
}

export function interpretVoice(text, currentSnapshot) {
  const snapshot = currentSnapshot || {};
  const spoken = String(text == null ? '' : text).trim().toLowerCase();
  const lists = Array.isArray(snapshot.lists) ? snapshot.lists : [];

  const add = /^(?:add|put|we need|i need)\s+(.+?)\s+(?:to|on)\s+(?:the\s+)?(.+?)(?:\s+list)?$/.exec(spoken);
  if (add) {
    const subject = (add[1] || '').trim();
    if (subject) {
      const entry = findList(lists, add[2]);
      if (!entry) return { displayScene: makeScene('note', 'Could not find that list', [{ type: 'text', text: 'Tell me the list name again.' }]) };
      return {
        displayScene: makeScene('list', 'Added to ' + entry.title, rowsBlock([row('Item', subject.slice(0, 80), 'good')]), subject),
        listEdit: { listId: entry.id, action: 'add', item: { id: freshId(), text: subject.slice(0, 80) } }
      };
    }
  }

  const toggle = /^(?:tick|check|mark)\s+(.+?)\s+(?:off|done)$/.exec(spoken);
  if (toggle) {
    const subject = (toggle[1] || '').trim();
    if (subject) {
      const found = findItem(lists, null, subject, true);
      if (!found) return { displayScene: makeScene('note', 'Could not find that item', [{ type: 'text', text: 'Tell me the item name again.' }]) };
      return {
        displayScene: makeScene('list', 'Done', rowsBlock([row('Item', subject.slice(0, 80), 'good')])),
        listEdit: { listId: found.listId, action: 'toggle', itemId: found.item.id }
      };
    }
  }

  const removal = /^(?:remove|delete)\s+(.+?)(?:\s+from\s+(.+))?$/.exec(spoken);
  if (removal) {
    const subject = (removal[1] || '').trim();
    if (subject) {
      const found = findItem(lists, removal[2], subject, false);
      if (!found) return { displayScene: makeScene('note', 'Could not find that item', [{ type: 'text', text: 'Tell me the item name again.' }]) };
      return {
        displayScene: makeScene('list', 'Removed', rowsBlock([row('Item', subject.slice(0, 80))])),
        listEdit: { listId: found.listId, action: 'remove', itemId: found.item.id }
      };
    }
  }

  if (/weather/.test(spoken)) {
    const days = (Array.isArray(snapshot.weather) ? snapshot.weather : []).slice(0, 6);
    if (!days.length) return { displayScene: makeScene('note', 'No weather yet', [{ type: 'text', text: 'Ask again later for the forecast.' }]) };
    const rows = days.map(day => row(String(day.date).slice(0, 80), (String(day.high) + '/' + String(day.low) + ' C - ' + String(day.condition)).slice(0, 80)));
    const bars = days.map(day => ({ label: String(day.date).slice(5), value: clamp((Number(day.high) + 15) / 40, 0, 1) }));
    return { displayScene: makeScene('answer', 'Weather', [{ type: 'rows', rows }, { type: 'bars', bars }]) };
  }

  if (/(?:what'?s|show).*(?:week|calendar|plan|schedule)/.test(spoken)) {
    const rows = (Array.isArray(snapshot.week) ? snapshot.week : []).slice(0, 6).map(day => row(shortDay(day.date) || String(day.date || '') || 'Open', ((day.events || []).map(event => String(event && event.title || '')).join(', ')).slice(0, 80) || 'Open'));
    if (!rows.length) return { displayScene: makeScene('note', 'Nothing planned', [{ type: 'text', text: 'Ask your helper to add plans.' }]) };
    return { displayScene: makeScene('plan', 'This week', rowsBlock(rows)) };
  }

  if (/(?:grocery|groceries|shopping)/.test(spoken)) return listScene(lists, 'groceries', 'Groceries', 'Nothing on the groceries list', 'Say add something to groceries.');
  if (/(?:to-?do|todo)/.test(spoken)) return listScene(lists, 'todo', 'To do', 'Nothing on the to-do list', 'Say add something to your to-do list.');

  if (/remind/.test(spoken)) {
    const rows = (Array.isArray(snapshot.reminders) ? snapshot.reminders : []).slice(0, 6).map(item => row(String(item.title || '').slice(0, 80), String(item.time || item.person || '').slice(0, 80) || 'Today'));
    if (!rows.length) return { displayScene: makeScene('note', 'No reminders', [{ type: 'text', text: 'Say remind me about something.' }]) };
    return { displayScene: makeScene('list', 'Reminders', rowsBlock(rows)) };
  }

  return { displayScene: makeScene('note', 'Heard you', [{ type: 'text', text: 'Ask your helper for anything more detailed.' }], String(text == null ? '' : text)) };
}
