# Voice interaction pipeline - SHARED CONTRACT

Every worker implementing this must obey these shapes exactly. Do not invent fields.

## Snapshot additions (cloud/src/product/family.js - already written, do not edit)

`displayScene` and `voiceAck` are optional top-level keys in the family snapshot.

```
displayScene: {
  id: string 8-64 [A-Za-z0-9_-],
  kind: 'answer'|'plan'|'list'|'compare'|'steps'|'note'|'timer',
  title: string 1-80 plain text,
  subtitle?: string 1-240 plain text,
  blocks: 1..6 blocks,
  ttlSeconds: integer 30..3600
}

block (discriminated union on `type`):
  { type:'text',  text: 1-240 }
  { type:'rows',  rows: 1..6 { label:1-80, value:1-80, tone?:'plain'|'good'|'warn' } }
  { type:'chips', chips: 1..8 of 1-80 }
  { type:'steps', steps: 1..6 of 1-80 }
  { type:'bars',  bars: 1..6 { label:1-40, value: 0..1 } }

voiceAck: {
  id: string 8-64 [A-Za-z0-9_-],
  state: 'received'|'heard'|'acted'|'failed',
  heard?: string 1-240,
  agentName?: string 1-40
}
```

Plain text only. No markup, no links, no URLs. `validateSnapshot` enforces this. Existing
bounds stay. `capabilities()` now also exposes `sceneKinds`, `voiceStates`, and `audio`.

## Voice storage (cloud/src/product/household.js)

```
voice-upload:{uploadId} = { id, deviceId, epoch, mime, totalBytes, chunks:[], received, createdAt, expiresAt, durationMs }
chunk:voice:{uploadId}:{seq} = { data }   // base64 slice
voice:{id} = { id, deviceId, mime, chunks:[], durationMs, transcript?, state, createdAt, expiresAt, agentName? }
```
- Max 262144 bytes (256 KiB) total audio. mime must be exactly `audio/webm`.
- Uploads expire 30 min after `createdAt`. Finished messages expire 24 h after `createdAt`.
- `state` starts `received`, moves `heard` when transcribed, `acted` when an agent replies,
  `failed` on reject.

## Household commands (principal gated)

| command | principal | input | output |
|---|---|---|---|
| `voice.begin` | device (this screen) | `{mime, byteLength, durationMs}` | `{uploadId}` |
| `voice.part` | device (this screen) | `{uploadId, seq, data}` | `{received}` |
| `voice.end` | device (this screen) | `{uploadId}` | `{messageId, revision, voiceAck}` |
| `voice.cancel` | device (this screen) | `{uploadId}` | `{ok:true}` |
| `voice.list` | grant `display:read` | `{}` | `{messages:[{id,createdAt,durationMs,transcript,state,agentName}]}` |
| `voice.get` | grant `display:read` | `{messageId}` | `{id, mime, data, transcript?, durationMs}` and marks `heard` |
| `voice.reply` | grant `content:write` | `{deviceId, messageId, displayScene, voiceAck}` | `{revision, status}` |

Device principal gate list must include `voice.begin`, `voice.part`, `voice.end`, `voice.cancel`.
Add a per-screen voice rate budget of 30/min at the registry layer.

## Device route (cloud/src/product/registry.js)

`POST /device/v1/voice` body is one of:
- `{action:'begin', mime, byteLength, durationMs}` -> `{uploadId}`
- `{action:'part', uploadId, seq, data}` -> `{received}`
- `{action:'end', uploadId}` -> `{messageId, revision, voiceAck}`
- `{action:'cancel', uploadId}` -> `{ok:true}`

`exact()` keys per action. `readJson(request, 8192)`. device state must be `owned`.
Rate limit `device:voice:{id}` at 30 per 60s. `byteLength` must be integer 1..262144.
`seq` must be integer 0..511. `data` must be a base64 string of at most 5600 chars.

## Hosted interpretation (new cloud/src/product/voice.js)

`transcribeVoice(bytes, mime, env)` -> `Promise<string|null>`
- If `env.VOICE_API_KEY` set: POST multipart to `https://api.openai.com/v1/audio/transcriptions`
  with model `gpt-4o-transcribe`, `response_format: 'json'`, file name `clip.webm`,
  content type `audio/webm`. Do not set Content-Type yourself.
- Else if `env.AI` bound: `env.AI.run('@cf/openai/whisper-large-v3-turbo', { audio: [...bytes] })`.
- Else return null.

`interpretVoice(text, currentSnapshot)` -> `{ displayScene, listEdit? }` deterministic,
no network. Match lowercase text:
- /^(?:add|put|we need|i need)\s+(.+?)\s+(?:to|on)\s+(?:the\s+)?(.+?)(?:\s+list)?$/ -> listEdit add
- /^(?:tick|check|mark)\s+(.+?)\s+(?:off|done)$/ -> listEdit toggle (mark done)
- /^(?:remove|delete)\s+(.+?)\s+(?:from)?\s*(.+?)?$/ -> listEdit remove
- /(?:what'?s|show).*(?:week|calendar|plan|schedule)/ -> scene kind 'plan' from snapshot.week
- /weather/ -> scene kind 'answer' from snapshot.weather
- /(?:grocery|groceries|shopping)/ -> scene kind 'list' from groceries lists
- /(?:to-?do|todo)/ -> scene kind 'list' from todo lists
- /remind/ -> scene kind 'list' from snapshot.reminders
- else -> scene kind 'note' with `heard` text and a line pointing at the helper.
`listEdit` is `{ listId, action:'add'|'toggle'|'remove', item?, itemId? }` reusing the
existing `lists.edit` shape. If the target list is missing, drop the edit and return a
scene explaining it.

## Display (cloud/product-public)

- New `voice-beam.js`: vanilla canvas port of the `voice-glow` effect. Class
  `DisplayOSVoiceBeam(container, options)` with options mirroring the library:
  `{ level, processing, colorVariant, colors, bandColors, sensitivity, threshold,
     attack, release, reach, spread, flow, bend, idle, theme, strength, active, paused, scale }`.
  `setLevel(n)`, `setProcessing(bool)`, `stop()`. Frame loop via rAF. 2D canvas,
  no WebGL. Must run on Chrome 70: use `Object.assign` / `var`, no optional chaining.
- `screen.js`: bottom agent bar (glass) with agent pills + hold-to-talk. Pointerdown
  starts capture + beam, pointerup stops and sends. States: idle, listening, sending,
  processing (beam `processing:true`), done, error. Scene card renders typed blocks.
  Adaptive polling: 1.5s while a voice round-trip is open, else 30s.
- Recording is `getUserMedia({audio:true})` + `MediaRecorder` with MIME
  `audio/webm;codecs=opus`. Cap 120 s. AnalyserNode feeds the beam; `smoothingTimeConstant` 0.65.
- Upload: split the blob into 4096-byte binary chunks, base64 each, send
  `begin` -> N x `part` -> `end`.

## Kiosk (kiosk/app)

- Manifest: add `RECORD_AUDIO` and `MODIFY_AUDIO_SETTINGS`.
- `MainActivity`: `WebChromeClient.onPermissionRequest` grants only
  `PermissionRequest.RESOURCE_AUDIO_CAPTURE`, on the UI thread.
- `Protocol.java` + `kiosk-native-transport.js`: allow `/device/v1/voice`.
- Rebuild and flash over USB with data preserved (`adb install -r`).

## Owner (cloud/product-public/home.js)

- Per-screen toggle "Let this screen record voice" -> `screen.voice` command
  (`{deviceId, allowVoice: bool}`) in household.js owner commands + registry
  `customerCommands`.
- Default agent picker: a select of `home.grants` + "My helper in its own app",
  stored as `home.settings.defaultVoiceAgent`.
- `skill.md` documents `voice_list` / `voice_get` / `voice_reply` and the scene schema.

## Latency budget

Recording start must feel instant (beam live within 2 frames of pointerdown). Release ->
`end` response -> on-screen ack should be under 3 s on a LAN. The on-screen ack comes from
the `end` response directly (no poll needed). The scene arrives via adaptive poll.
