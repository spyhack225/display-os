# DisplayOS kiosk build evidence

Current build, 2026-10-17. The kiosk source, scripts, evidence and signing identity use the DisplayOS name; a fresh local demonstration signer was generated for this build. Historical pre-rename runs remain recorded under `../diagnostics/` with names and paths updated to the current tree; those records describe earlier builds whose artifacts are no longer kept.

## Current artifacts

| Artifact | SHA-256 |
| --- | --- |
| Debug `build/debug/displayos-kiosk.apk` | `126736804b606151c3b4d2a42dc927297212380cc0e6b5085d110f962f25dfd1` |
| Debug app source | `2e664071a01fd218b1422b930f1945ade3b01317b00a8607bef74de36028af1c` |
| Release `build/release/displayos-kiosk.apk` | `a508f892fdb1ef562d29943c6256189d8be06fec5c6824728ce389c4cd3caa4f` |
| Release app source | `2e664071a01fd218b1422b930f1945ade3b01317b00a8607bef74de36028af1c` |
| Signing certificate | `322979a6f1fe19f842c305644af1eb8407a12b57cca538febd4068aac5a2d625` |

Both APKs were built on 2026-10-17 from source `2e664071...` against origin `https://displayos.sergio-williomes.workers.dev`. Package `com.displayos.kiosk`, version code 1, version name 0.1.0, minSdk 26, targetSdk 35. The signer is DN `CN=DisplayOS Local Demo`, RSA-3072, in the ACL-protected JKS keystore at `%LOCALAPPDATA%\DisplayOSKiosk\demo-signing.jks` — private local demonstration custody, not an approved commercial identity. v2 and v3 signing verified; v1, v3.1, v4 and SourceStamp are not claimed.

The debug APK is installed on the demonstration SM-T580 (serial `520305b1eea3a425`) with a fresh native enrollment against the live Worker on 2026-10-17; `com.displayos.kiosk` is selected as default Home and the previous package was removed. Later the same day, guarded `provision.ps1 -Action Recover -Install -Launch` runs reinstalled the current debug APK under the same signer with native enrollment and the owner PIN preserved. The release APK is not installed on any device. Each `evidence.json` still lists `installed:false` and `hardwareTested:false`, and no hardware test suite ran on the unit; those flags describe build generation, while installation state is recorded in "Installed demonstration unit" below. Aggregate source hash covers sorted UTF-8 `relativePath=fileSha256` lines joined with LF, no trailing LF; it excludes generated BuildConfig and mutable backend code. Source/artifact binding is local evidence, not third-party attestation or byte reproducibility.

## Validation commands

Run from `E:\GitHub\displayos`, without npm or a session PATH repair:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File kiosk/scripts/setup-tools.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File kiosk/scripts/build.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File kiosk/scripts/build.ps1 -Configuration Release -SigningStore "$env:LOCALAPPDATA\DisplayOSKiosk\demo-signing.jks"
powershell -NoProfile -ExecutionPolicy Bypass -File kiosk/scripts/test.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File kiosk/scripts/verify.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File kiosk/scripts/verify.ps1 -Configuration Release
powershell -NoProfile -ExecutionPolicy Bypass -File kiosk/test/install-boundary.test.ps1
```

The build and signature checks execute tools from ACL-protected `%LOCALAPPDATA%\DisplayOSKioskToolchain`. `setup-tools.ps1 -ProjectLocal` can make a research-only shared copy under `kiosk/.tools`, but signing/provisioning will not execute it, and no project-local copy is currently kept. Private setup extracts only the required platform `android.jar`, plus the JDK and build tools; no lingering setup process or local service is started.

## Results

| Check | Result | What it proves |
| --- | --- | --- |
| JVM protocol/transport/enrollment/claim/local/lifecycle | 55 passed | Existing boundaries plus 35-second authenticated exact-route/method budget checks. Auth denial and ownership changes remain fail-closed. |
| Android JSONObject local-content regressions | 12 passed | Actual LocalContent sanitizer, injected synthetic time, observed 2.5-second lag, exact/excess skew, clamp/no extension, expired data, metadata, types and privacy guards. |
| Android 8.1 JSONObject snapshot regressions | 11 passed | Actual vendor JSON null semantics, 100 repeated owned-null polls, one content removal, real expiry/rollback, no null ACK, unclaimed checks and malformed snapshot denial. Synthetic fixtures, no tablet or vault. |
| Capture policy (JVM) | 3 passed | Only `RESOURCE_AUDIO_CAPTURE` is eligible, held until the Android runtime grant and fulfilled once on the UI thread; other resource sets are denied. |
| Device command policy (JVM) | 7 passed | Voice and list request bodies keep exact keys, types and bounds; unknown actions and every other non-empty device body stay denied. |
| Node adapter/static | 33 passed | Captured-candidate initialization, UI-only publication, epoch/destruction guards, shared startup/reload path, microphone capture wiring and the device POST gate. Static assertions do not execute Android dialogs, LocalContent schema or Keystore. |
| Windows runtime | 2 passed | Current-user-only NTFS runtime accepted; shared exFAT workspace refused as private runtime. |
| Installer signer boundary | 4 passed | Private staging and expected signer accepted; a valid different signer rejected even with its matching attacker-editable evidence hash; unsigned matching-hash payload rejected; private verified bytes remain bound. No ADB invocation. |
| PowerShell parser | 8 scripts passed | All kiosk scripts parse, including the test-only JSON source setup. |
| Artifact/source verification | Debug and Release passed | 24 app file bindings, eight scripts and APK payload/private-file boundary accepted for both configurations. |

**127 checks passed** on the current source: 55 JVM + 12 actual LocalContent JSON regressions + 11 snapshot regressions + 3 capture policy + 7 device command policy + 33 Node/static + 2 ACL + 4 installer checks, plus debug and release artifact/source verification. `diagnostics/local-regression-red.log` records the earlier synthetic clock-lag failure that motivated the LocalContent correction; after the fix all twelve local tests pass. `diagnostics/build-debug.log`, `build-release.log`, `verify-debug.log`, `verify-release.log` and `tests.log` record the current run. No install or tablet operation was part of that local run.

The test runner downloads six unmodified Android 8.1 JSON implementation files from the official `android-8.1.0_r1` AOSP libcore tree. `scripts/setup-test-json.ps1` verifies pinned vendor Git blob hashes before using each cached or downloaded file. They reside only in ignored `.tools/android-json`, retain Apache-2.0 source headers and add no APK dependency. These tests execute actual JSONObject semantics on the JVM, not Android lifecycle or physical-cache behavior.

## Installed demonstration unit

On 2026-10-17, `node cloud/scripts/prepare-screen.mjs 520305b1eea3a425` re-provisioned the qualified SM-T580 against `https://displayos.sergio-williomes.workers.dev`. The run verified the APK hash and signer (`322979a6...`), installed the debug APK, exported that installation's Keystore public key to `%LOCALAPPDATA%\DisplayOSKiosk\native-public-key-520305b1eea3a425.json`, requested one key-bound factory ticket from the live Worker and completed fresh native enrollment without a laptop PIN. `files/unit-info.json` reports `prepared:true`, origin `https://displayos.sergio-williomes.workers.dev` and `hardwareBacked:false`. `cmd package set-home-activity` selected `com.displayos.kiosk/.MainActivity` as default Home (`isDefault=true`), and the previous kiosk package was uninstalled. The owner's physical PIN choice and home confirmation remain the next gate.

The first preparation attempt stopped before any device work: Windows PowerShell 5.1 does not set `$PSScriptRoot` while binding parameter defaults when a script declares Mandatory parameters and is run with `-File`. `scripts/provision.ps1` now resolves the adb path default in the script body. `diagnostics/displayos-tablet-prepare-preflight-failure.log` preserves the failure; `diagnostics/displayos-tablet-prepare.log` and `diagnostics/displayos-tablet-repreparation.json` record the successful preparation.

## Voice pipeline

This revision completes the press-and-hold voice path. `AndroidManifest.xml` declares `android.permission.RECORD_AUDIO` and `android.permission.MODIFY_AUDIO_SETTINGS`; a `WebChromeClient.onPermissionRequest` override routes every request through `CapturePolicy`: only `RESOURCE_AUDIO_CAPTURE` is eligible, the Android runtime grant for `RECORD_AUDIO` is requested once, the WebView request is held until that grant is answered, and the grant is fulfilled on the UI thread from `onRequestPermissionsResult`. Any other resource set is denied.

The next live failure, "That did not send. Try again.", came from the native command gate: `NativeClient.post` allowed request bodies only for `/device/v1/confirm` and `/device/v1/ack`, so the screen's `/device/v1/voice` `begin/part/end/cancel` bodies were refused with "Unexpected native command data." before any HTTP request existed. `DeviceCommandPolicy` now validates the exact bodies the screen sends for `/device/v1/voice` and `/device/v1/lists` (allowed keys, `audio/webm`, raw byte and part bounds mirroring the server) and `NativeClient.post` admits those two paths; everything else keeps the empty-body rule. The 8192 packet cap, origin, signing, enrollment and identity handling are unchanged; the per-minute native command window changed from 60 to 120 so a full-size upload (one `begin`, up to 64 parts, one `end`) fits under the bridge rate guard. The server side of the same contract counts decoded bytes against the declared total and rebuilds the stored recording from true bytes (cloud/src/product/household.js), so parts that arrive as padded base64 are stored and read back whole.

Verified on the live unit: a long-press raised the Android permission dialog and a physical tap granted `RECORD_AUDIO` (`AppPermissionGroup grantRuntimePermissions` in logcat; `dumpsys package` shows `granted=true`, appops `allow`). After the gate fix, a six-second press produced `begin` + 8 parts + `end`, all HTTP 200 in `wrangler tail`, with no 413 and no cancel. The recording itself was synthetic ambient audio; the owner's spoken confirmation and the assistant-side transcript remain separate checks.

## Vendor archive integrity

JDK vendor metadata comes from the [Adoptium release API](https://api.adoptium.net/v3/assets/latest/17/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse). Android archive hashes come from Google's [SDK repository metadata](https://dl.google.com/android/repository/repository2-1.xml). The setup pins specific downloads and hashes, rather than querying a changing latest release during execution.

| Archive | Published algorithm and hash | Independently recorded SHA-256 |
| --- | --- | --- |
| [Temurin JDK 17.0.20.1+1 Windows x64](https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jdk_x64_windows_hotspot_17.0.20.1_1.zip) | SHA-256 `e53a79c3c3d86865bd7e787903884331068e71321714ffd44f145785affc7cb0` | Same as published hash. |
| [Android platform 35 ext15 r01](https://dl.google.com/android/repository/platform-35-ext15_r01.zip) | SHA-1 `ce757091f933b7ac646bf197ce8957cc73b95614` | `a93712aedd4f851d9cf1f7281f7c4fe5581ce03a9df37ffc8c53a487eadf311f` |
| [Android build tools 35 Windows](https://dl.google.com/android/repository/build-tools_r35_windows.zip) | SHA-1 `af059bb67cf7786f45ee0db85e2d24985df1b4b6` | `5753c679a1b90bcf6fbc9945a2ce39dfb9e74f1df0831a1e1866ae5b594326f0` |

Google's metadata publishes SHA-1 for these archives. The recorded SHA-256 values are local integrity measurements, not a claim that Google published SHA-256 for them. Source URLs use vendor HTTPS. No commercial licensing clearance follows from checksum verification.

## Kiosk tree

All authored files are under `kiosk/`:

```text
.gitignore
README.md
PROTOCOL.md
BUILD-EVIDENCE.md
scripts/setup-tools.ps1
scripts/setup-test-json.ps1
scripts/protect-runtime.ps1
scripts/build.ps1
scripts/test.ps1
scripts/verify.ps1
scripts/provision.ps1
scripts/install-boundary.ps1
test/NativeProtocolTest.java
test/SnapshotStateTest.java
test/CapturePolicyTest.java
test/DeviceCommandPolicyTest.java
test/LocalContentTest.java
test/bridge.test.cjs
test/install-boundary.test.ps1
app/src/main/AndroidManifest.xml
app/src/main/assets/kiosk-native-transport.js
app/src/main/res/values/strings.xml
app/src/main/res/xml/network_security_config.xml
app/src/main/res/xml/device_admin.xml
app/src/main/java/com/displayos/kiosk/Protocol.java
app/src/main/java/com/displayos/kiosk/EnrollmentPolicy.java
app/src/main/java/com/displayos/kiosk/ClaimPolicy.java
app/src/main/java/com/displayos/kiosk/CapturePolicy.java
app/src/main/java/com/displayos/kiosk/DeviceCommandPolicy.java
app/src/main/java/com/displayos/kiosk/LocalContent.java
app/src/main/java/com/displayos/kiosk/SnapshotState.java
app/src/main/java/com/displayos/kiosk/InitializationGate.java
app/src/main/java/com/displayos/kiosk/SignatureCodec.java
app/src/main/java/com/displayos/kiosk/Identity.java
app/src/main/java/com/displayos/kiosk/Vault.java
app/src/main/java/com/displayos/kiosk/NativeHttp.java
app/src/main/java/com/displayos/kiosk/NativeClient.java
app/src/main/java/com/displayos/kiosk/MainActivity.java
app/src/main/java/com/displayos/kiosk/BootReceiver.java
app/src/main/java/com/displayos/kiosk/PreparationReceiver.java
app/src/main/java/com/displayos/kiosk/KioskAdmin.java
```

Generated artifacts, archive caches and diagnostic logs are ignored. Generated signing/tool runtime lives under the current user's LocalAppData. The repository is published at `https://github.com/spyhack225/display-os`.

## Signing and custody boundary

Signing passwords, signing keys, ticket responses and per-unit exports belong in `%LOCALAPPDATA%\DisplayOSKiosk` on an ACL-capable NTFS volume, not the exFAT workspace. `protect-runtime.ps1` removes inherited access, grants the current user SID and verifies every access rule; any other principal, missing enforceable ACL or reparse point gates the operation. The first-install signer gate against the protected keystore stays in force (the four installer boundary checks above). Never clear app data or replace the signing identity to fix an enrollment failure. A commercial signing store and certificate-continuity policy need owner approval.

## External release gates

No emulator or connected unit was used for this record. The qualified SM-T580 (Android 8.1/API 27, security patch 2020-06-01, WebView 70.0.3538.110, reported non-hardware-backed P-256 identity; the AES vault key is separate) now runs the current debug APK with the fresh native enrollment and default Home described above; the package change superseded the previous enrollment and PIN as expected. QR/manual claim, wrong PIN/backoff, two-home denial, bearer isolation, visible render ACK, Wi-Fi disconnect/reconnect, offline cold start before expiry, deadline/clock rollback, boot/Home behavior, managed escape denial, lost-erase recovery, app process death, non-debug upgrade and owner-visible weather/nearby delivery all still need on-unit verification with the current APKs. Use synthetic demo content only. Commercial signing custody, supported OS/WebView versions and licensing remain owner decisions. This native app implements the supplied device protocol, not OAuth, an MCP provider connector, remote OS administration or universal assistant support.
