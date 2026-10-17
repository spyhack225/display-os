const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'app/src/main/assets/kiosk-native-transport.js'), 'utf8');
function adapter() {
  const listeners = {};
  const timers = [];
  const sent = [];
  const reads = [];
  const window = { addEventListener(name, callback) { listeners[name] = callback; } };
  const timerDelays = [];
  const context = { window, location: { origin: 'https://example.test' }, setTimeout(callback, delay) { timers.push(callback); timerDelays.push(delay); return timers.length; }, clearTimeout() {} };
  vm.runInNewContext(source, context);
  window.DisplayOSUI = { request(address, options) { reads.push({ address, options }); return Promise.resolve({}); } };
  const port = { postMessage(packet) { sent.push(JSON.parse(packet)); } };
  const connect = (origin = 'null') => listeners.message({ origin, source: null, isTrusted: true, data: 'displayos-native-port-v1', ports: [port] });
  return { window, sent, reads, port, connect, timers, timerDelays, listeners };
}
test('GET uses intercepted XHR with no renderer token', async () => {
  const demo = adapter(); await demo.window.DisplayOSUI.request('/device/v1/poll', { deviceToken: 'synthetic', blob: false });
  assert.equal(demo.reads.length, 1); assert.equal(demo.reads[0].options.deviceToken, undefined);
});
test('POST queued until native opaque-origin port arrives', async () => {
  const demo = adapter(); const result = demo.window.DisplayOSUI.request('/device/v1/pairing', { method: 'POST', body: {} });
  demo.connect('https://evil.test'); assert.equal(demo.sent.length, 0); demo.connect(); assert.equal(demo.sent.length, 1);
  demo.port.onmessage({ data: JSON.stringify({ id: demo.sent[0].id, status: 200, body: { code: 'ephemeral-test' } }) });
  assert.equal((await result).code, 'ephemeral-test');
});
test('factory, recovery, OS and unknown device POST rejected', async () => {
  const demo = adapter();
  for (const address of ['/device/v1/enroll', '/device/v1/recover/verify', '/device/v1/shell']) await assert.rejects(demo.window.DisplayOSUI.request(address, { method: 'POST', body: {} }), { status: 403 });
  assert.equal(demo.sent.length, 0);
});
test('unknown GET and malformed media rejected', async () => {
  const demo = adapter();
  for (const address of ['/device/v1/tokens', '/device/v1/media/a%2fb', '/device/v1/poll?token=test']) await assert.rejects(demo.window.DisplayOSUI.request(address), { status: 403 });
  assert.equal(demo.reads.length, 0);
});
test('message body bounded', async () => {
  const demo = adapter(); await assert.rejects(demo.window.DisplayOSUI.request('/device/v1/ack', { method: 'POST', body: { nonce: 'x'.repeat(8192) } }), { status: 413 });
});
test('message queue bounded and timeout rejects', async () => {
  const demo = adapter(); const waiting = [];
  for (let index = 0; index < 8; index++) waiting.push(assert.rejects(demo.window.DisplayOSUI.request('/device/v1/pairing', { method: 'POST', body: {} }), { status: 0 }));
  await assert.rejects(demo.window.DisplayOSUI.request('/device/v1/pairing', { method: 'POST' }), { status: 429 });
  demo.timers.forEach(callback => callback()); await Promise.all(waiting);
});
test('native rejection never becomes success', async () => {
  const demo = adapter(); demo.connect(); const result = demo.window.DisplayOSUI.request('/device/v1/erase', { method: 'POST', body: {} });
  demo.port.onmessage({ data: JSON.stringify({ id: demo.sent[0].id, status: 403, body: { deviceToken: 'must-not-be-returned' } }) });
  await assert.rejects(result, { status: 403 });
});
test('adapter cannot be replaced after installation', () => {
  const demo = adapter(); assert.throws(() => { demo.window.DisplayOSUI = {}; }, /already installed/);
});
test('script-created or window-origin ports rejected', async () => {
  const demo = adapter(); const result = demo.window.DisplayOSUI.request('/device/v1/pairing', { method: 'POST', body: {} });
  demo.listeners.message({ origin: 'null', source: null, isTrusted: false, data: 'displayos-native-port-v1', ports: [demo.port] });
  demo.listeners.message({ origin: 'https://example.test', source: demo.window, isTrusted: true, data: 'displayos-native-port-v1', ports: [demo.port] });
  assert.equal(demo.sent.length, 0); demo.connect(); demo.port.onmessage({ data: JSON.stringify({ id: demo.sent[0].id, status: 200, body: {} }) }); await result;
});
test('native security configuration static boundary', () => {
  const main = fs.readFileSync(path.join(root, 'app/src/main/java/com/displayos/kiosk/MainActivity.java'), 'utf8');
  assert.doesNotMatch(main, /addJavascriptInterface|SslErrorHandler[^]*\.proceed\(/);
  for (const guard of ['setAllowFileAccess(false)', 'setAllowContentAccess(false)', 'MIXED_CONTENT_NEVER_ALLOW', 'setWebContentsDebuggingEnabled(false)', 'FLAG_SECURE', 'isLockTaskPermitted', 'setBlockNetworkLoads(true)']) assert.ok(main.includes(guard), guard);
  assert.ok(main.includes('getString("path")')); assert.ok(main.includes('protocol.devicePost(path)'));
});
test('microphone capture passes through only after the Android runtime grant', () => {
  const main = fs.readFileSync(path.join(root, 'app/src/main/java/com/displayos/kiosk/MainActivity.java'), 'utf8');
  const policy = fs.readFileSync(path.join(root, 'app/src/main/java/com/displayos/kiosk/CapturePolicy.java'), 'utf8');
  assert.ok(policy.includes('"android.webkit.resource.AUDIO_CAPTURE"')); assert.ok(policy.includes('enum Decision'));
  for (const wiring of ['CapturePolicy.decide(resources,', 'checkSelfPermission(Manifest.permission.RECORD_AUDIO)', 'requestPermissions(new String[] { Manifest.permission.RECORD_AUDIO }, CAPTURE_PERMISSION)', 'public void onRequestPermissionsResult(int code', 'pendingCapture', 'request.grant(request.getResources())', 'pendingCapture.deny()']) assert.ok(main.includes(wiring), wiring);
  assert.doesNotMatch(main, /if \(audioOnly\) request\.grant\(resources\)/);
  assert.doesNotMatch(main, /RESOURCE_VIDEO_CAPTURE|RESOURCE_MIDI_SYSEX|RESOURCE_PROTECTED_MEDIA_ID/);
});
test('native device post gate knows the exact voice and list bodies', () => {
  const native = fs.readFileSync(path.join(root, 'app/src/main/java/com/displayos/kiosk/NativeClient.java'), 'utf8');
  const policy = fs.readFileSync(path.join(root, 'app/src/main/java/com/displayos/kiosk/DeviceCommandPolicy.java'), 'utf8');
  assert.ok(native.includes('"/device/v1/voice".equals(path) || "/device/v1/lists".equals(path)'));
  assert.ok(native.includes('DeviceCommandPolicy.check(path, body)'));
  assert.ok(native.includes('throw new SecurityException("Unexpected native command data.")'));
  for (const shape of ['"audio/webm"', '262144', '120000', '{1,5600}', '"add"', '"toggle"', '"remove"', 'expectedRevision', 'itemId']) assert.ok(policy.includes(shape), shape);
});
test('identity and encrypted storage static boundary', () => {
  const java = name => fs.readFileSync(path.join(root, 'app/src/main/java/com/displayos/kiosk', name + '.java'), 'utf8');
  assert.ok(java('Identity').includes('AndroidKeyStore')); assert.ok(java('Identity').includes('SignatureCodec.raw'));
  assert.ok(java('Vault').includes('AES/GCM/NoPadding')); assert.ok(java('Vault').includes('updateAAD')); assert.ok(java('Vault').includes('getNoBackupFilesDir'));
  assert.ok(java('NativeClient').includes('DisplayOS recovery\\n')); assert.ok(java('NativeClient').includes('"{\\"state\\":\\"unclaimed\\"}"'));
});
test('no committed reusable credentials or desktop factory key pipeline', () => {
  const manifest = fs.readFileSync(path.join(root, 'app/src/main/AndroidManifest.xml'), 'utf8');
  assert.ok(manifest.includes('android:allowBackup="false"')); assert.ok(manifest.includes('android:exported="${debuggable}"'));
  assert.doesNotMatch(source, /FACTORY_CREDENTIAL|privateKey|deviceToken\s*=/);
});
test('managed Home policy only applies to existing authorized device owner', () => {
  const admin = fs.readFileSync(path.join(root, 'app/src/main/java/com/displayos/kiosk/KioskAdmin.java'), 'utf8');
  assert.ok(admin.includes('!manager.isDeviceOwnerApp')); assert.ok(admin.includes('setLockTaskPackages')); assert.ok(admin.includes('addPersistentPreferredActivity'));
});
test('expiry and reset prevent private cache fallback', () => {
  const native = fs.readFileSync(path.join(root, 'app/src/main/java/com/displayos/kiosk/NativeClient.java'), 'utf8');
  for (const boundary of ['contentDenied', 'elapsedRealtime()', 'vault.retain("photo-", names)', 'return post("/device/v1/erase", new JSONObject())', 'resumePending()']) assert.ok(native.includes(boundary), boundary);
});

test('snapshot null handling is shared and expiry erasure is idempotent', () => {
  const native = fs.readFileSync(path.join(root, 'app/src/main/java/com/displayos/kiosk/NativeClient.java'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'app/src/main/java/com/displayos/kiosk/MainActivity.java'), 'utf8');
  assert.doesNotMatch(native, /\.(?:has|optJSONObject)\("snapshot"\)/);
  for (const boundary of ['SnapshotState.snapshot(state)', 'SnapshotState.hasSnapshot(latest)', 'SnapshotState.hasSnapshot(recovered)', 'SnapshotState.hasSnapshot(state)', 'SnapshotState.contentRemoved(latest, state)', 'SnapshotState.expiry(']) assert.ok(native.includes(boundary), boundary);
  assert.ok(main.includes('!wiped && expected != null'));
  const erased = main.slice(main.indexOf('@Override public void erased() {\n        final'), main.indexOf('@Override public void onResume()'));
  assert.ok(erased.includes('expected == null || wiped'));
  assert.ok(main.includes('synchronized (expected)'));
  assert.ok(main.includes('expected.clearContent()'));
});
test('broadcast preparation reloads existing activity and carries factory unit id', () => {
  const main = fs.readFileSync(path.join(root, 'app/src/main/java/com/displayos/kiosk/MainActivity.java'), 'utf8');
  const provision = fs.readFileSync(path.join(root, 'scripts/provision.ps1'), 'utf8');
  assert.ok(main.includes('onNewIntent(Intent intent)')); assert.ok(main.includes('initializeClient(false)')); assert.ok(main.includes('installer.dismiss()'));
  assert.ok(provision.includes('deviceId=$ticket.deviceId')); assert.ok(provision.includes('$information.origin -ne $Origin'));
});

test('initialization publishes captured candidates only through a current live UI callback', () => {
  const main = fs.readFileSync(path.join(root, 'app/src/main/java/com/displayos/kiosk/MainActivity.java'), 'utf8');
  const initializer = main.slice(main.indexOf('private void initializeClient'), main.indexOf('private EditText field'));
  assert.ok(main.includes('initializeClient(true)'));
  assert.ok(initializer.includes('final int epoch = initialization.begin()'));
  assert.ok(initializer.includes('final NativeClient candidate = new NativeClient(this, expectedProtocol)'));
  assert.match(initializer, /runOnUiThread\(\(\) -> \{\s*if \(!initialization.current\(epoch\) \|\| isFinishing\(\) \|\| isDestroyed\(\)\) return;\s*client = candidate; observe\(candidate\);\s*if \(candidate.prepared\(\)\)/);
  assert.doesNotMatch(initializer, /client\.prepared\(\)|client\.resumePending\(\)/);
  assert.equal((initializer.match(/client = /g) || []).length, 1);
  const destroy = main.slice(main.indexOf('@Override public void onDestroy()'));
  assert.ok(destroy.indexOf('initialization.destroy()') < destroy.indexOf('commands.shutdownNow()'));
});

test('factory preparation is headless while physical claim still creates or verifies PIN', () => {
  const provision = fs.readFileSync(path.join(root, 'scripts/provision.ps1'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'app/src/main/java/com/displayos/kiosk/MainActivity.java'), 'utf8');
  assert.doesNotMatch(provision, /Read-Host|ownerPin=|SecureStringToBSTR/);
  assert.ok(provision.includes('@{ticket=$ticket.ticket;deviceId=$ticket.deviceId}'));
  assert.ok(main.includes('expected.verifyClaimPin(supplied, attempt.phrase, attempt.expiresAt,'));
  assert.ok(main.includes('Choose a 6-digit screen PIN'));
  const native = fs.readFileSync(path.join(root, 'app/src/main/java/com/displayos/kiosk/NativeClient.java'), 'utf8');
  assert.ok(native.includes('Protocol.requireNewPin(pin)'));
  assert.ok(native.includes('else accepted = verifyPin(pin)'));
});

test('only physical confirmation gets a longer bounded timeout', async () => {
  const demo = adapter(); demo.connect();
  const pending = ['/device/v1/pairing', '/device/v1/confirm', '/device/v1/ack', '/device/v1/erase'].map(address => assert.rejects(demo.window.DisplayOSUI.request(address, { method: 'POST', body: {} }), { status: 0 }));
  assert.deepEqual(demo.timerDelays, [30000, 115000, 30000, 30000]);
  demo.timers.forEach(callback => callback()); await Promise.all(pending);
});

test('cancelled confirmation rejects promptly and frees the pending slot', async () => {
  const demo = adapter(); demo.connect();
  const cancelled = assert.rejects(demo.window.DisplayOSUI.request('/device/v1/confirm', { method: 'POST', body: { phrase: 'synthetic' } }), { status: 499 });
  demo.port.onmessage({ data: JSON.stringify({ id: demo.sent[0].id, status: 499, body: {} }) }); await cancelled;
  const retried = demo.window.DisplayOSUI.request('/device/v1/confirm', { method: 'POST', body: { phrase: 'synthetic' } });
  demo.port.onmessage({ data: JSON.stringify({ id: demo.sent[1].id, status: 200, body: { owned: true } }) });
  assert.equal((await retried).owned, true);
});

test('expired queued confirmation is never delivered after late bootstrap', async () => {
  const demo = adapter();
  const expired = assert.rejects(demo.window.DisplayOSUI.request('/device/v1/confirm', { method: 'POST', body: {} }), { status: 0 });
  demo.timers[0](); await expired; demo.connect(); assert.equal(demo.sent.length, 0);
});

test('claim dialog keeps invalid input editable and settles lifecycle cancellation', () => {
  const main = fs.readFileSync(path.join(root, 'app/src/main/java/com/displayos/kiosk/MainActivity.java'), 'utf8');
  for (const guard of ['setPositiveButton("Connect screen", null)', 'setOnCancelListener', 'setOnDismissListener', 'finishClaim(attempt, 499)', 'pendingClaim != null', 'attempt.epoch == generation', 'client == attempt.expected', 'attempt.expected.state()', 'attempt.deadline', 'cancelClaim(409)', 'cancelClaim(410)', 'outstanding.incrementAndGet()', 'outstanding.decrementAndGet()', 'Protocol.newPinFormat(supplied)']) assert.ok(main.includes(guard), guard);
  assert.match(main, /Choose exactly 6 numbers[^]*?return;/);
  assert.doesNotMatch(main, /Log\.[vdiew]\(|printStackTrace\(|error\.getMessage\(/);
});

test('worker authorization never reads Android UI and observes volatile lifecycle fields', () => {
  const main = fs.readFileSync(path.join(root, 'app/src/main/java/com/displayos/kiosk/MainActivity.java'), 'utf8');
  const guard = main.slice(main.indexOf('private boolean claimWorkerCurrent'), main.indexOf('private boolean claimCurrent'));
  assert.doesNotMatch(guard, /browser\.|getUrl\(|isShown\(|hasWindowFocus\(|\.state\(/);
  for (const declaration of ['volatile WebMessagePort channel', 'volatile ClaimAttempt pendingClaim', 'volatile boolean foreground', 'volatile boolean wiped', 'volatile int generation', 'volatile NativeClient client']) assert.ok(main.includes(declaration), declaration);
  assert.ok(main.includes('() -> claimWorkerCurrent(attempt)'));
  const native = fs.readFileSync(path.join(root, 'app/src/main/java/com/displayos/kiosk/NativeClient.java'), 'utf8');
  assert.ok(native.includes('private volatile JSONObject latest'));
  assert.ok(native.includes('public JSONObject state() { return latest; }'));
  assert.doesNotMatch(native, /public synchronized JSONObject state/);
  const post = native.slice(native.indexOf('String credentialForRequest = token()'), native.indexOf('if ("/device/v1/erase".equals(path) && response.status'));
  assert.ok(post.indexOf('!permitted.getAsBoolean()') < post.indexOf('http.send('));
  assert.ok(post.indexOf('!currentClaim(') < post.indexOf('http.send('));
});

test('fresh PIN candidate is computed and persisted before live configuration changes', () => {
  const native = fs.readFileSync(path.join(root, 'app/src/main/java/com/displayos/kiosk/NativeClient.java'), 'utf8');
  const store = native.slice(native.indexOf('private synchronized void storePin(String pin, java.util.function.BooleanSupplier'), native.indexOf('private boolean currentClaim'));
  assert.ok(store.indexOf('byte[] hash = pinHash') < store.indexOf('updated.put("pinSalt"'));
  assert.ok(store.indexOf('vault.put("configuration", updated') < store.indexOf('configuration = updated'));
  assert.ok(store.indexOf('if (!permitted.getAsBoolean())') > store.indexOf('byte[] hash = pinHash'));
  assert.ok(store.indexOf('if (!permitted.getAsBoolean())') < store.indexOf('vault.put("configuration", updated'));
  assert.doesNotMatch(store, /configuration\.put\("pinSalt"|configuration\.remove/);
  assert.ok(native.includes('Protocol.requireNewPin(pin); storePin(pin)'));
  assert.ok(native.includes('else if (!hasPin()) storePin(pin)'));
});

test('family PIN dialog separates connection codes and hides technical details', () => {
  const main = fs.readFileSync(path.join(root, 'app/src/main/java/com/displayos/kiosk/MainActivity.java'), 'utf8');
  const dialog = main.slice(main.indexOf('private void confirmClaim'), main.indexOf('private void notice'));
  for (const wording of ['Connect this screen to your home', 'Choose a 6-digit screen PIN', 'This is only for changing or leaving this screen. Keep it private.', 'Enter your saved screen PIN.', 'separate from your connection code', 'Please finish while your phone is waiting.']) assert.ok(dialog.includes(wording), wording);
  assert.doesNotMatch(dialog, /legacy|Diagnostic|PIN_CRYPTO|90 seconds|owner PIN|Approve this home on this unit/);
});

test('Android immersive mode skips PIN dialogs and reapplies on foreground focus', () => {
  const main = fs.readFileSync(path.join(root, 'app/src/main/java/com/displayos/kiosk/MainActivity.java'), 'utf8');
  for (const guard of ['SYSTEM_UI_FLAG_IMMERSIVE_STICKY', 'SYSTEM_UI_FLAG_HIDE_NAVIGATION', 'SYSTEM_UI_FLAG_FULLSCREEN', 'onWindowFocusChanged(boolean focused)', 'if (focused) applyImmersive()', 'pendingClaim != null || installer != null && installer.isShowing()']) assert.ok(main.includes(guard), guard);
});

test('native preparation and recovery execute strict deferred PIN policy', () => {
  const java = name => fs.readFileSync(path.join(root, 'app/src/main/java/com/displayos/kiosk', name + '.java'), 'utf8');
  assert.ok(java('PreparationReceiver').includes('EnrollmentPolicy.fields(fields)'));
  assert.ok(java('NativeClient').includes('EnrollmentPolicy.prepare('));
  assert.ok(java('NativeClient').includes('if (pin != null && hasPin() && !verifyPin(pin))'));
  assert.ok(java('NativeClient').includes('if (configuration.optBoolean("deferredPinEnrollment")) verifyUnclaimed(token)'));
  assert.ok(java('NativeClient').includes('EnrollmentPolicy.clearPinAfterRecovery(configuration.optBoolean("resetPending")'));
  assert.ok(java('NativeClient').includes('configuration.put("resetPending", true); save()'));
  assert.ok(java('NativeClient').includes('An existing owner PIN cannot be replaced'));
});

test('local GET uses intercepted HTTP without renderer credential', async () => {
  const demo = adapter();
  await demo.window.DisplayOSUI.request('/device/v1/local', { method: 'GET', deviceToken: 'synthetic-private' });
  assert.equal(demo.reads.length, 1); assert.equal(demo.reads[0].address, '/device/v1/local'); assert.equal(demo.reads[0].options.deviceToken, undefined); assert.equal(demo.sent.length, 0);
});

test('local alternative methods paths queries and traversal are rejected', async () => {
  const demo = adapter();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) await assert.rejects(demo.window.DisplayOSUI.request('/device/v1/local', { method, body: {} }), { status: 403 });
  for (const address of ['/device/v1/local/', '/device/v1/local?address=synthetic', '/device/v1/%6cocal', '/device/v1/../v1/local']) await assert.rejects(demo.window.DisplayOSUI.request(address, { method: 'GET' }), { status: 403 });
  assert.equal(demo.reads.length, 0); assert.equal(demo.sent.length, 0);
});

test('local native path precedes poll and has no vault state ACK or offline fallback', () => {
  const main = fs.readFileSync(path.join(root, 'app/src/main/java/com/displayos/kiosk/MainActivity.java'), 'utf8');
  assert.ok(main.indexOf('if ("/device/v1/local".equals(path)) return response(client.local())') < main.indexOf('if (protocol.deviceGet(path)) return response(client.poll())'));
  const native = fs.readFileSync(path.join(root, 'app/src/main/java/com/displayos/kiosk/NativeClient.java'), 'utf8');
  const local = native.slice(native.indexOf('public NativeHttp.Reply local()'), native.indexOf('public NativeHttp.Reply poll()'));
  assert.ok(local.includes('http.local(credential')); assert.ok(local.includes('LocalContent.sanitize(response.text())')); assert.ok(local.includes('localAllowed(credential)'));
  assert.doesNotMatch(local, /vault\.|acceptPoll\(|\.poll\(|\.post\(|save\(|recover\(|catch\s*\(|latest\s*=/);
  const guard = native.slice(native.indexOf('private synchronized boolean localAllowed'), native.indexOf('public NativeHttp.Reply local()'));
  for (const boundary of ['prepared()', 'credential.equals(configuration.optString("deviceToken"))', '"owned".equals(latest.optString("state"))', '!latest.optBoolean("offline")', 'age <= 60000L']) assert.ok(guard.includes(boundary), boundary);
});

test('local output schema excludes address coordinates tokens and arbitrary markup', () => {
  const local = fs.readFileSync(path.join(root, 'app/src/main/java/com/displayos/kiosk/LocalContent.java'), 'utf8');
  for (const boundary of ['fields(source, "available", "localEnabled", "localRevision", "cityLabel", "weather", "nearby", "attribution", "thirdPartyAttributions", "expiresAt", "ephemeral", "weatherSourceAttribution")', 'fields(enabled, "weather", "nearby")', 'fields(row, "date", "label", "high", "low", "condition")', 'fields(row, "title", "when")', 'Unexpected local data field', 'weather.length() > 7', 'nearby.length() > 3', 'input instanceof String', 'input instanceof Number', 'input instanceof Boolean', '9007199254740991D', 'expiresAt - now > 3630000L', 'Math.min(expiresAt, now + 3600000L)', 'thirdParty.length() != 0', 'Source: Includes weather data from Google', 'Unavailable local data cannot contain rows']) assert.ok(local.includes(boundary), boundary);
  assert.doesNotMatch(local, /put\("(?:address|latitude|longitude|apiKey|deviceToken|ticket)"/);
  assert.doesNotMatch(local, /Vault|\.poll\(|\.post\(|FileOutputStream|SharedPreferences|Log\./);
});
