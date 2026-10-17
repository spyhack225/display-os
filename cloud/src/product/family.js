import { reject } from './common.js';

const DAY = 86400000;
const ROOT_KEYS = ['schemaVersion', 'timezone', 'generatedAt', 'expiresAt', 'briefing', 'weather', 'weatherAttribution', 'week', 'reminders', 'kids', 'parents', 'news', 'prompts', 'nearby', 'photos', 'lists', 'displayScene', 'voiceAck'];
const BOUNDS = Object.freeze({ weather: 7, week: 7, events: 2, reminders: 4, kids: 3, parents: 3, items: 3, news: 2, prompts: 3, nearby: 3, photos: 20, lists: 4, listItems: 12, sceneBlocks: 6, sceneRows: 6, sceneChips: 8, sceneSteps: 6, sceneBars: 6 });
const SCENE_KINDS = ['answer', 'plan', 'list', 'compare', 'steps', 'note', 'timer'];
const VOICE_STATES = ['received', 'heard', 'acted', 'failed'];

function invalid(message) {
  reject(400, message);
}

function object(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).some(key => !allowed.includes(key))) invalid('Use the supported family fields.');
  return value;
}

function phrase(value, max = 80) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[<>\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]|(?:https?:|javascript:|data:|file:|www\.)|&(?:lt|gt|#0*60|#0*62|#x0*3[ce]);/i.test(value)) invalid('Use short, plain text without links or markup.');
  return value.trim();
}

function zone(value) {
  const result = phrase(value);
  if (!/^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+){0,2}$/.test(result)) invalid('Choose a valid time zone.');
  try { new Intl.DateTimeFormat('en', { timeZone: result }).format(0); }
  catch { invalid('Choose a valid time zone.'); }
  return result;
}

function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid('Use dates in YYYY-MM-DD format.');
  const timestamp = Date.parse(value + 'T00:00:00.000Z');
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) invalid('Use a real calendar date.');
  return value;
}

function list(value, max, normalize) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) invalid('Keep family lists within the screen limits.');
  return value.map(normalize);
}

function uniqueDates(value) {
  if (new Set(value.map(item => item.date)).size !== value.length) invalid('Include each date only once.');
  return value;
}

function personItem(value) {
  object(value, ['title', 'time', 'person']);
  return { title: phrase(value.title), time: phrase(value.time), person: phrase(value.person) };
}

function people(value) {
  object(value, ['name', 'items']);
  return { name: phrase(value.name), items: list(value.items, BOUNDS.items, item => phrase(item, 240)) };
}

function reference(value, min = 8, max = 64) {
  if (typeof value !== 'string' || value.length < min || value.length > max || !/^[A-Za-z0-9_-]+$/.test(value)) invalid('Use supported list references.');
  return value;
}

function listItem(value) {
  object(value, ['id', 'text', 'person', 'done']);
  const item = { id: reference(value.id), text: phrase(value.text) };
  if (value.person !== undefined) item.person = phrase(value.person);
  if (value.done === undefined) item.done = false;
  else if (typeof value.done === 'boolean') item.done = value.done;
  else invalid('Mark list items done or not done.');
  return item;
}

function familyList(value) {
  object(value, ['id', 'title', 'kind', 'items']);
  if (value.kind !== 'groceries' && value.kind !== 'todo') invalid('Choose groceries or to-do for a list.');
  const items = list(value.items, BOUNDS.listItems, listItem);
  if (new Set(items.map(item => item.id)).size !== items.length) invalid('Include each list item only once.');
  return { id: reference(value.id), title: phrase(value.title, 40), kind: value.kind, items };
}

function temperature(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < -100 || value > 100) invalid('Use valid temperatures in Celsius.');
  return value;
}

function ratio(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) invalid('Use a ratio between 0 and 1.');
  return value;
}

function sceneBlock(value) {
  object(value, ['type', 'text', 'rows', 'chips', 'steps', 'bars']);
  if (!['text', 'rows', 'chips', 'steps', 'bars'].includes(value.type)) invalid('Use a supported scene block.');
  const block = { type: value.type };
  if (value.type === 'text') {
    block.text = phrase(value.text, 240);
  } else if (value.type === 'rows') {
    block.rows = list(value.rows, BOUNDS.sceneRows, row => {
      object(row, ['label', 'value', 'tone']);
      const item = { label: phrase(row.label), value: phrase(row.value) };
      if (row.tone !== undefined) {
        if (!['plain', 'good', 'warn'].includes(row.tone)) invalid('Use plain, good or warn for a row tone.');
        item.tone = row.tone;
      }
      return item;
    });
    if (!block.rows.length) invalid('Give a rows block at least one row.');
  } else if (value.type === 'chips') {
    block.chips = list(value.chips, BOUNDS.sceneChips, chip => phrase(chip));
    if (!block.chips.length) invalid('Give a chips block at least one chip.');
  } else if (value.type === 'steps') {
    block.steps = list(value.steps, BOUNDS.sceneSteps, step => phrase(step));
    if (!block.steps.length) invalid('Give a steps block at least one step.');
  } else {
    block.bars = list(value.bars, BOUNDS.sceneBars, bar => {
      object(bar, ['label', 'value']);
      return { label: phrase(bar.label, 40), value: ratio(bar.value) };
    });
    if (!block.bars.length) invalid('Give a bars block at least one bar.');
  }
  return block;
}

function displayScene(value) {
  object(value, ['id', 'kind', 'title', 'subtitle', 'blocks', 'ttlSeconds']);
  if (!SCENE_KINDS.includes(value.kind)) invalid('Use a supported scene kind.');
  const ttl = value.ttlSeconds;
  if (!Number.isSafeInteger(ttl) || ttl < 30 || ttl > 3600) invalid('Choose a scene lifetime between 30 seconds and one hour.');
  const scene = { id: reference(value.id), kind: value.kind, title: phrase(value.title), blocks: list(value.blocks, BOUNDS.sceneBlocks, sceneBlock), ttlSeconds: ttl };
  if (value.subtitle !== undefined) scene.subtitle = phrase(value.subtitle, 240);
  return scene;
}

function voiceAck(value) {
  object(value, ['id', 'state', 'heard', 'agentName']);
  if (!VOICE_STATES.includes(value.state)) invalid('Use a supported voice state.');
  const ack = { id: reference(value.id), state: value.state };
  if (value.heard !== undefined) ack.heard = phrase(value.heard, 240);
  if (value.agentName !== undefined) ack.agentName = phrase(value.agentName, 40);
  return ack;
}

function boundedJson(value) {
  let encoded;
  try { encoded = JSON.stringify(value); }
  catch { invalid('Use a valid family update.'); }
  if (typeof encoded !== 'string' || new TextEncoder().encode(encoded).byteLength > 65536) invalid('The family update is too large.');
}

export function validateSnapshot(input, now = Date.now()) {
  object(input, ROOT_KEYS);
  boundedJson(input);
  if (!Number.isSafeInteger(now) || input.schemaVersion !== 1) invalid('Use family schema version 1.');
  if (!Number.isSafeInteger(input.generatedAt) || Math.abs(input.generatedAt - now) > 300000) invalid('Create a fresh family update.');
  if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now || input.expiresAt <= input.generatedAt || input.expiresAt - input.generatedAt > DAY) invalid('Choose an expiry within 24 hours.');
  object(input.briefing, ['title', 'text']);
  const result = {
    schemaVersion: 1,
    timezone: zone(input.timezone),
    generatedAt: input.generatedAt,
    expiresAt: input.expiresAt,
    briefing: { title: phrase(input.briefing.title), text: phrase(input.briefing.text, 240) },
    weather: uniqueDates(list(input.weather, BOUNDS.weather, value => {
      object(value, ['date', 'label', 'high', 'low', 'condition']);
      const high = temperature(value.high);
      const low = temperature(value.low);
      if (low > high) invalid('The low temperature cannot exceed the high.');
      return { date: date(value.date), label: phrase(value.label), high, low, condition: phrase(value.condition) };
    })),
    week: uniqueDates(list(input.week, BOUNDS.week, value => {
      object(value, ['date', 'events']);
      return { date: date(value.date), events: list(value.events, BOUNDS.events, personItem) };
    })),
    reminders: list(input.reminders, BOUNDS.reminders, personItem),
    kids: list(input.kids, BOUNDS.kids, people),
    parents: list(input.parents, BOUNDS.parents, people),
    news: list(input.news, BOUNDS.news, value => {
      object(value, ['title', 'summary']);
      return { title: phrase(value.title), summary: phrase(value.summary, 240) };
    }),
    prompts: list(input.prompts, BOUNDS.prompts, value => phrase(value, 240)),
    nearby: list(input.nearby, BOUNDS.nearby, value => {
      object(value, ['title', 'when']);
      return { title: phrase(value.title), when: phrase(value.when) };
    }),
    photos: list(input.photos, BOUNDS.photos, value => {
      if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,80}$/.test(value)) invalid('Use an approved photo reference.');
      return value;
    }),
    lists: list(input.lists, BOUNDS.lists, familyList)
  };
  if (input.displayScene !== undefined) result.displayScene = displayScene(input.displayScene);
  if (input.voiceAck !== undefined) result.voiceAck = voiceAck(input.voiceAck);
  if (input.weatherAttribution !== undefined) {
    if (input.weatherAttribution !== 'Weather data by Open-Meteo') invalid('Use the supported weather acknowledgement.');
    result.weatherAttribution = input.weatherAttribution;
  }
  if (new Set(result.photos).size !== result.photos.length) invalid('Include each photo only once.');
  if (new Set(result.lists.map(entry => entry.id)).size !== result.lists.length) invalid('Include each list only once.');
  boundedJson(result);
  return result;
}

export function validateSettings(input) {
  object(input, ['timezone', 'quietAfterSeconds', 'nightStart', 'nightEnd', 'brightness', 'orientation', 'showPhotos', 'temperatureUnit']);
  if (input.temperatureUnit !== undefined && !['celsius', 'fahrenheit'].includes(input.temperatureUnit)) invalid('Choose Celsius or Fahrenheit.');
  if (!Number.isInteger(input.quietAfterSeconds) || input.quietAfterSeconds < 30 || input.quietAfterSeconds > 1800) invalid('Choose a quiet delay between 30 seconds and 30 minutes.');
  if (!Number.isInteger(input.brightness) || input.brightness < 10 || input.brightness > 100) invalid('Choose brightness from 10 to 100.');
  if (!['auto', 'portrait', 'landscape'].includes(input.orientation) || typeof input.showPhotos !== 'boolean') invalid('Choose supported screen settings.');
  const clock = value => {
    if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) invalid('Use HH:MM for quiet hours.');
    return value;
  };
  return { timezone: zone(input.timezone), quietAfterSeconds: input.quietAfterSeconds, nightStart: clock(input.nightStart), nightEnd: clock(input.nightEnd), brightness: input.brightness, orientation: input.orientation, showPhotos: input.showPhotos, ...(input.temperatureUnit === undefined ? {} : { temperatureUnit: input.temperatureUnit }) };
}

export function capabilities() {
  return { schemaVersion: 1, maxBytes: 65536, maxTtlSeconds: 86400, timestampFormat: 'unix-milliseconds', temperatureUnit: 'celsius', weatherAttribution: 'Weather data by Open-Meteo', textLimits: { short: 80, paragraph: 240 }, bounds: { ...BOUNDS }, sceneKinds: [...SCENE_KINDS], voiceStates: [...VOICE_STATES], media: { formats: ['image/jpeg', 'image/png'], maxBytes: 98304, maxDimension: 2048, maxPixels: 4000000 }, audio: { formats: ['audio/webm'], maxBytes: 262144, maxSeconds: 120 }, settings: { quietAfterSeconds: [30, 1800], brightness: [10, 100], orientation: ['auto', 'portrait', 'landscape'], temperatureUnit: ['celsius', 'fahrenheit'] } };
}

export function sampleSnapshot(now = Date.now()) {
  const today = new Date(now).toISOString().slice(0, 10);
  return validateSnapshot({ schemaVersion: 1, timezone: 'UTC', generatedAt: now, expiresAt: now + 3600000, briefing: { title: 'A little room for family', text: 'This is a sample day. Your assistant can bring your own plans and reminders here.' }, weather: [{ date: today, label: 'Today', high: 21, low: 14, condition: 'Sample forecast' }], week: [{ date: today, events: [{ title: 'An afternoon together', time: '4:00 pm', person: 'Everyone' }] }], reminders: [{ title: 'Water the plants', time: 'After breakfast', person: 'Everyone' }], kids: [{ name: 'School day', items: ['A sample lunch reminder'] }], parents: [{ name: 'For you', items: ['Leave some time for a walk'] }], news: [{ title: 'A sample story', summary: 'Small things worth talking about, chosen by your assistant.' }], prompts: ['What made you smile today?'], nearby: [{ title: 'A sample park visit', when: 'This weekend' }], photos: [], lists: [{ id: 'sample-groceries-1', title: 'Groceries', kind: 'groceries', items: [{ id: 'sample-item-01', text: 'Milk', person: 'Everyone', done: false }] }] }, now);
}
