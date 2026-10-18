# Voice live fixes: microphone grant, native upload gate, transcription binding and publishing permission

Status: done (2026-10-17). Three live failures drove this work: press-and-hold showed
"Microphone is not available on this screen."; after the microphone fix the send failed with
"That did not send. Try again."; and the connected assistant could read the approved Family
screen but saw no `family_publish` tool, so it could not send anything.

## Evidence and root causes

1. Microphone: an adb long-press on the talk button reached WebView media instead of a dead
   touch. Chromium logged `cr_media: Requires MODIFY_AUDIO_SETTINGS and RECORD_AUDIO. No
   audio device will be available for recording` and `chromium:
   [ERROR:audio_manager_android.cc(272)] Unable to select audio device!`
   (diagnostics/displayos-voice-mic-repro.log). `appops get com.displayos.kiosk RECORD_AUDIO`
   reported no operation: the app never requested the Android runtime permission. The manifest
   declares it, and the WebView `onPermissionRequest` grant path did run (media reached the
   device-selection stage), so the only gap was the missing runtime request in `MainActivity`.
2. Native upload gate: after the microphone fix a press recorded audio (logcat shows the audio
   HAL voice-note session) but no `/device/v1/voice` request ever reached the Worker.
   `NativeClient.post` allowed request bodies only for `/device/v1/confirm` and
   `/device/v1/ack` and rejected every other device POST with "Unexpected native command
   data.", so the screen page's `begin/part/end/cancel` bodies were refused before any HTTP
   request existed. `wrangler tail` stayed empty while the screen showed the generic send
   error; the same rule also silently blocked list edits from the screen (`/device/v1/lists`).
3. Server part accounting: with the gate open, a ~5 s recording reached the Worker, uploaded
   six parts, then one part failed `413 "That recording is too large."` and the page
   cancelled. `voice.part` compared the accumulated base64 string length against the declared
   raw byte total (`received += input.data.length` vs `totalBytes`), so any recording above
   roughly 12 KB raw (a few seconds of Opus) tripped its own size guard near the end of the
   upload.
4. Truncated recordings: `voice.end` concatenated per-part base64 strings and decoded once.
   Each part is padded base64, and Node stops decoding at the first padding, so a stored
   message decoded back to just its first 4096-byte chunk — for `voice.get`, `processVoice`
   and the MCP voice tools alike. An earlier unit test missed it because its two 6-byte parts
   produced padding-free base64.
5. Rate and window sizing: one full recording is one `begin` + up to 64 parts + one `end`; the
   server allowed 30 voice commands/minute per device and the native bridge window 60/minute,
   both below the contract's 262144-byte ceiling.
6. Transcription: the live service had no `VOICE_API_KEY` and no `AI` binding, so
   `transcribeVoice` returned null and `processVoice` returned before writing the transcript,
   the `heard` state or the interpreted scene (cloud/src/product/voice.js,
   cloud/src/product/household.js). Messages stayed `received`.
7. Publishing permission: MCP `tools/list` filters on the approved connection scopes
   (cloud/src/product/oauth.js). The owner's ChatGPT connection lists exactly the seven
   `display:read` tools, so it was approved with `display:read` only; `family_publish` and
   `voice_reply` require `content:write`. An authorization request that omits `scope`
   silently defaulted to `display:read`, and neither approval nor refresh can add a missing
   permission. The documented first connection is `display:read content:write`
   (docs/assistant-setup.md, skill.md, and the ChatGPT-shaped live QA journey).

## Fixes

1. kiosk microphone: `CapturePolicy` plus `MainActivity` hold the WebView `PermissionRequest`,
   request the Android `RECORD_AUDIO` runtime grant once, and fulfill the WebView grant only
   after Android grants it. JVM policy tests and a static wiring check in bridge.test.cjs.
2. kiosk native gate: `DeviceCommandPolicy` validates the exact bodies the screen sends for
   `/device/v1/voice` and `/device/v1/lists` (key discipline, `audio/webm`, raw byte, part and
   id bounds mirroring the server) and `NativeClient.post` admits those two paths; everything
   else keeps the empty-body rule. JVM policy tests and a static check.
3. kiosk window: the native command window changed from 60 to 120 commands per minute so a
   full-size upload fits under the bridge rate guard.
4. cloud accounting: `voice.part` counts decoded bytes against the declared total and only
   once per sequence number; `voice.end` decodes each part, concatenates true bytes and
   re-encodes once, so stored messages are canonical base64 that every reader decodes fully.
5. cloud rates: the per-device `device:voice` limit changed from 30 to 90 commands per minute.
6. cloud transcription: Workers AI binding `"ai": { "binding": "AI" }` in wrangler.json
   (`@cf/openai/whisper-large-v3-turbo` per the voice contract). No new secret.
7. cloud oauth: the omitted-scope `authorize` fallback becomes `display:read content:write`
   intersected with the client's registered scopes. Owner approval still decides, and refresh
   still cannot add permissions.
8. docs: assistant-setup reconnect guidance (the read-only symptom and the approval
   checkboxes), product-operations voice note, build evidence.

## Verification

- kiosk: `scripts/test.ps1` fully green — 55 JVM protocol + 12 LocalContent + 11 snapshot +
  3 capture policy + 7 device command policy + 33 Node/static + 2 runtime + 4 installer checks
  (127 total). Debug APK SHA-256 `126736804b60...`, app source `2e664071...`, 24 app files,
  built and verified against origin `https://displayos.sergio-williomes.workers.dev`.
- tablet: guarded `provision.ps1 -Action Recover -Install -Launch` (same signer
  `322979a6...`, data preserved, native encrypted enrollment present). A long-press raised the
  Android permission dialog and a physical tap granted `RECORD_AUDIO`
  (`grantRuntimePermissions` in logcat; `dumpsys package` shows `granted=true`). After the
  gate fix, a six-second synthetic press produced `begin` + 8 parts + `end` — all HTTP 200 in
  `wrangler tail` (diagnostics/voice-tail2.jsonl), no 413, no cancel.
- cloud: full unit suite 398/398; `scripts/deploy-product.mjs` gates passed (unit, workerd,
  provider races, browser 275, live 861 checks); deployed version
  `9974f032-fca6-4337-b110-c93880f7253a` with `env.AI` bound; deployment record updated.
- to confirm with the owner's own voice: the message state moves to `heard` with a transcript
  (visible to the connected assistant through `voice_list`), and simple list phrasing applies
  a list edit. On an empty Family screen the heard scene cannot publish (there is no base
  snapshot), which is expected; the tablet still shows the "Got it" toast from the end
  response.
- owner: reconnect the ChatGPT plugin keeping `display:read` and `content:write` selected and
  both approval checkboxes checked; the assistant then sees `family_publish` and
  `voice_reply`. An existing read-only grant cannot be expanded and refresh cannot add scopes.

## Follow-up: transcription contract (2026-10-17, same day)

The two live recordings uploaded after the release (18:49 and 19:05 in
diagnostics/voice-tail3.jsonl) reached the connected assistant through `voice_list` without
transcripts. The binding call `env.AI.run('@cf/openai/whisper-large-v3-turbo', { audio:
[...bytes] })` never worked on live Workers AI: that model's input schema accepts base64 audio
(or a `{body, contentType}` object), so every call was rejected and swallowed by the
function's silent error path; messages stayed `received`.

A real Workers AI check through `wrangler dev` (the deployed account, a scratch local Worker)
on a genuine Chromium `audio/webm;codecs=opus` recording (Windows TTS speech captured through
the same MediaRecorder path the kiosk page uses) proved the contracts: turbo + bytes rejected;
turbo + base64 transcribed (about 5 s); tiny-en + bytes transcribed (about 1 s); tiny-en +
base64 rejected. The Worker now calls `@cf/openai/whisper-tiny-en` (English-only) with its
8-bit byte array input, a bounded `displayos_voice_transcribe_failed` console event covers
future failures, and the unit test locks the tiny-en byte-array call
(cloud/test/product-voice-interpret.test.js). Version
`48d9649d-677f-4c59-9faa-210248828631` passed the complete release gates (unit 398, workerd
393, provider-race 1,130, browser 275, live HTTPS 861). The acceptance check passed on
2026-10-17: the owner's press-and-hold on the tablet produced `begin` + 8 parts + `end`, all
HTTP 200 on version `48d9649d` in the live `wrangler tail` (`diagnostics/voice-tail4.jsonl`),
and the tail showed no `displayos_voice_transcribe_failed` event; the connected assistant
listed the recordings with transcripts, including recordings that had stayed silent before
the fix. Pre-fix recordings have no server-side transcript (transcription runs once, on
`voice.end`); the assistant recovers them by listening to the audio through `voice_get`.
