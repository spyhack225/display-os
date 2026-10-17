# DisplayOS operation and release

This guide is for the person preparing and operating the service. Families use the website and screen, not these commands.

## Customer journey

1. Prepare each unit once using its native Keystore public key. Never copy an enrolled app image to another unit.
2. The screen connects to Wi-Fi and shows a temporary QR and a six-number fallback code. Scanning avoids typing.
3. A person scans it on a modern phone, saves a sign-in with their face, fingerprint or phone PIN, and names their home.
4. They check the matching words on the physical screen and confirm there. They choose a six-digit screen PIN locally for changing or leaving the screen. Scanning or knowing the fallback code alone does not grant ownership.
5. They ask their supported assistant to connect and approve only the information and screens they want it to use.
6. Their assistant sends a short family update and checks its visible receipt. The screen keeps itself useful locally and clears expired private information when offline.

The browser trial in My home tests this journey without a tablet. Its connection and synthetic device key exist only in that tab. It is not a physical unit or secure native key-custody test.

Returning to an existing home requires the saved passkey. If sign-in does not finish, open DisplayOS on the phone or computer where it was saved, or use the browser's other-device option when available. The new guidance does not create another home or reset an existing one. A NotAllowedError alone does not prove the person cancelled.

For native weather rejection, verify the current kiosk build before resetting anything. The local sanitizer accepts at most thirty seconds of upper expiry skew and clamps retention to one local hour. Local GET has a thirty-five-second native read budget and a forty-five-second browser budget to accommodate sequential bounded Google lookups. Other request budgets and all device authorization checks remain unchanged. A fresh Google result should not be rejected merely because the tablet clock is a few seconds behind.

Families can give each screen a room name in the visible Your screens card. Match its `Screen` label with the label on the physical display before changing a name or removing a unit. Renaming preserves family content and permissions. Never remove an equally named screen automatically. The manual code entry has six visual slots but remains one accessible, pasteable field. The display shows time remaining before its code and QR are replaced, and hides expired codes while fetching a fresh pair.

The ordinary Screen label remains visible in empty, daytime, standby, overnight and offline modes. Daytime standby includes approved family information and consented local results when available. Overnight standby defaults to a dim time, public date and date-only monthly calendar. Tap Show full display to see fresh authorized content during quiet hours, then open Settings and choose Back to quiet hours to hide it again. This choice lasts for the current quiet-night session and does not change the saved schedule. Location save actions have separate spacing, with removal below its own divider.

Saving a location privately does not enable weather or nearby places. Choose Use for weather and nearby places to allow them, then give connected screens about 30 seconds to read the change. Quiet hours explain why local information is hidden. Failed local loads show a retry message rather than silently pretending that the screen is waiting only for family plans. In Around your home, Celsius and Fahrenheit buttons save the display unit for all screens without changing their individual privacy settings or fetching new Google information.

An empty newly connected home is valid. The native app must not repeatedly clear data or reconnect when the poll contains `snapshot:null`. The final preserving correction installed on the demo tablet passed 102 checks, including real Android JSON null regressions and queued-initialization fencing. Three rapid starts produced no new Android crash reports. The owner independently confirmed that the loop stopped. Enrollment and the private screen PIN were preserved. Cold boots and the long-running physical trial remain separate gates.

## Voice messages

A family screen with Voice enabled shows a press-and-hold button: hold to talk, release to send. The first use raises Android's microphone permission dialog on the tablet itself, and only the person at the screen can allow it. A recording can be up to 262144 bytes (roughly a minute) and uploads as bounded parts. Transcription runs on Workers AI through the deployed `env.AI` binding; no provider key is stored. Messages move through `received`, `heard` and `acted` states. On an empty screen the transcript is stored but no scene publishes, because there is no base snapshot to attach it to — expect the "Got it" acknowledgement without visible copy until the home has published content. The connected assistant can list messages, read a transcript and reply through `voice_list`, `voice_get` and `voice_reply`; replying needs a connection approved with `content:write`. A connection approved read-only must be reconnected — refreshing it cannot add permissions (see [assistant setup](assistant-setup.md)).

## Google location setup

Only one external Google Cloud project is supported by `cloud/scripts/configure-google.mjs`, set with `DISPLAYOS_GCP_PROJECT` (default `next-notes-mac`). Inspection is read-only by default. Configuration needs the separately approved existing billing-account linkage. If the CLI sees no open billing account, stop and request billing access. Do not create a billing account, choose another project or change the global gcloud project as a workaround.

```powershell
& 'C:\Program Files\nodejs\node.exe' .\cloud\scripts\configure-google.mjs
& 'C:\Program Files\nodejs\node.exe' .\cloud\scripts\configure-google.mjs --configure --enable-billing
```

Run these from the workspace root. If several existing open billing accounts are visible, the operator must choose one explicitly with `--billing-account`. The helper enables only API Keys, Geocoding, Weather and Places, then creates three separately API-restricted server keys. It journals ownership and credentials in the private NTFS runtime, never in the shared workspace. Repeating configuration reuses its own verified resources without rotating or adopting unrelated keys. Raw CLI output and credential values are suppressed.

Publish with the explicit `--publish` option only after the deployed service contains the tested persistent 300 actual Google requests per UTC-day cap. The release gate exercises that cap against synthetic Google endpoints in actual workerd, alongside delayed-request reset, deletion and consent-withdrawal races. This is an application request limit, not a spending cap or protection against other project users or stolen credentials. Google billing access was not available during the first real configuration attempt, so no linkage, API enablement or credential publication occurred.

Families may save an address or city privately while Google is unavailable. The page must say that weather and nearby places are unavailable, not show sample results as real data. Only deliberate consent sends the private input to Google. Screens receive coarse city information and transient Google output, never the full home address. Do not copy provider output into exports, family snapshots or native offline caches. Exports include the owner's own location input and consent only. Home deletion removes that location record.

At 2026-10-10T07:16:22.455Z, after the owner enabled billing, the CLI verified billing active on the approved external Google Cloud project. The four approved services and three separate API-restricted server keys were configured and published. The deployed service returned real Google weather and nearby public places for one disposable test home. Twenty-four live checks passed and the test account and home were deleted. The customer's home and consent were not changed. Calendar and inbox OAuth configuration remain separate and are not enabled by these Maps keys.

The subsequent published UI check passed 26 checks at 2026-10-10T07:39:18.274Z on version `71b34076-b838-4eec-a8eb-3292862d948d`. It clicked both actual Preview buttons and verified visible attribution, transient results, withdrawal denial and deletion of its own test account and home. Refresh My home to load the current controls. A privately saved location does not become shared automatically; the family must choose Use for weather and nearby places.

Version `4366acc7-c606-4423-a7de-09f5d5860014` adds unit switching and the explicit quiet-hour exit. At 2026-10-10T08:01:06.099Z, 29 live provider checks passed, including Fahrenheit conversion of an actual weather preview, saved unit preference and return to Celsius. No customer home or sharing choice was changed. A preserving tablet restart confirmed a new native process and DisplayOS foreground activity; the owner's visible weather confirmation remains open.

Previous version `eb236600-edd1-4b6f-bb82-fee74438f504` fixed optional registration metadata, local request budgets, night-action alignment and returning-user guidance. Its full release gates passed. Forty-two actual Google checks passed on the published preview and browser-display journey, and thirty-six separate live checks verified an official MCP client through explicit consent, publication, rendering and revocation. Each verifier deleted only its own QA account, home and trial. The 115-check native correction was installed with the same signer, preserving enrollment and PIN, then restarted to load published assets. The owner's visible native weather remains a separate check.

Previous version `0ac4d8ed-1c49-483c-b07d-6d29ed3869ee` added public instructions/discovery and explicit personal plugin setup. Its final gates passed with 300 unit, 351 protocol, 1130 provider-race, 275 browser and 811 live HTTPS checks, plus 36 separate SDK flow checks. The initial live header failure is preserved; its complete repeat passed without redeployment. Actual ChatGPT discovery worked, but the owner's Chrome blocked approval with ERR_BLOCKED_BY_CLIENT. Hand browser control back to the person; never disable protection or move their session to the assistant's cloud browser. Personal installation and publication remain unconfirmed.

Current version `9974f032-fca6-4337-b110-c93880f7253a` fixes the live press-and-hold voice path and the assistant's publishing permission. Unit-side fixes ship in the kiosk APK: the Android `RECORD_AUDIO` runtime request is held behind and answered by the WebView capture grant, the native device-command gate admits the exact voice and list request bodies, and the native command window is 120 per minute. Service-side fixes: voice uploads count decoded bytes against the declared total and rebuild the stored recording from true bytes, the per-device voice rate limit is 90 commands per minute, transcription uses the Workers AI binding `env.AI` (`@cf/openai/whisper-large-v3-turbo`, no new secret), and an authorization request that omits `scope` defaults to `display:read content:write` intersected with the client's registered scopes. The complete release command passed its unit (398), workerd, browser (275) and live HTTPS (861) gates; the deployment record is `%LOCALAPPDATA%\DisplayOS\displayos-product-deployment.json` with `hardwareVerified:false`. The demonstration tablet was reinstalled the same day under the same signer with native enrollment and the owner PIN preserved; a six-second press produced `begin` + 8 parts + `end`, all HTTP 200 in `wrangler tail`, with no mid-upload rejection. An existing read-only assistant grant cannot be widened — reconnect it per [assistant setup](assistant-setup.md).

Previous version `8bfcd7b2-c99c-4282-ab2e-aaa8c4ded2e7` carries the renamed Worker `displayos` at `https://displayos.sergio-williomes.workers.dev` (code version `c8390a65-957b-4b21-8c70-365cfd52918f`; an earlier bootstrap deploy `8d298e97-8bd0-4ab9-a03d-6e7dd95f19b0` created the fresh Worker first). The complete release command passed 395 unit, 393 workerd, 1,130 provider-race and 275 browser checks. Its first post-publication route probe failed because the fresh Worker did not yet contain `OWNER_CREDENTIAL`, `ENROLLMENT_CODE` and `STATE_ENCRYPTION_KEY`; the failure is preserved in `diagnostics/displayos-product-release.log`. The protected pilot secrets were then uploaded unchanged from the protected pilot secrets file (`cloud-pilot-secrets.json` in the current-user runtime; no key rotated), the route probe passed, and the full live repeat passed 861 HTTPS checks on the resulting active version without further code change (`diagnostics/displayos-product-live.log`; the record is `%LOCALAPPDATA%\DisplayOS\displayos-product-deployment.json`). The same day, the demonstration tablet was re-provisioned with the current debug APK and a fresh native enrollment (`diagnostics/displayos-tablet-prepare.log`, `diagnostics/displayos-tablet-repreparation.json`).

Previous version `3f5e0dd8-da07-47c6-be0d-a21ee6ab7767` fixes detailed-photo preparation and JPEG re-encoding size failures. The complete release command passed 330 unit, 393 workerd, 1130 provider-race, 275 browser and 811 live HTTPS checks, then exited successfully. Sixteen separate live photo checks passed with a deleted disposable account and home. Keep `diagnostics/displayos-photo-release.log`, `diagnostics/displayos-photo-live.log` and `diagnostics/displayos-photo-live.json`. No customer home, native identity or PIN was reset. Personal picture rendering on the physical tablet is still a separate check.

Previous version `a671cc7b-dd24-45f4-b684-6b8b30e524b5` corrected MCP initialization capability compatibility and a diagnostic request-stream stall. It passed 321 unit, 393 workerd, 1130 provider-race, 275 browser and 811 live HTTPS checks. The owner's existing plugin was refreshed successfully with six actions. Preserve `.audit/full-product/action-discovery-incident.md` and `diagnostics/displayos-action-final-release.log`. A fresh conversation reported a successful read; personal publication and a tablet receipt remain unverified.

Previous version `4947d62b-5750-444b-b0db-1b4e10523376` corrected host authorization compatibility and the calendar detail control after an unchanged empty-family poll. Pre-publication gates passed with 317 unit, 393 workerd, 1130 provider-race and 275 browser checks. The nine calendar regressions preserve family and local expiry. A coverage-only fixture refinement was followed by a fresh 317-test pass before publication. The release command exited 1 after publication on a live `screen.js` byte mismatch. An immediate source-hash probe matched all 34,605 tested bytes, and the full 811-check live repeat passed on that same version without source changes or redeployment. The mismatch's cause is unproven. Keep both `diagnostics/displayos-host-calendar-release.log` and `diagnostics/displayos-host-calendar-live-final.log`.

ChatGPT-shaped and Muse-shaped live QA journeys each passed 42 checks, including explicit narrow consent, refresh rotation, an official MCP client, desktop rendering, revocation and deletion of their own QA account, home and trial. Their completion times were 2026-10-10T09:21:46.157Z and 2026-10-10T09:22:00.386Z; logs are `diagnostics/displayos-host-chatgpt-live.log` and `diagnostics/displayos-host-muse-live.log`. ChatGPT's language hint is ignored within the bounded authorization query. Muse's omitted target defaults only to DisplayOS's MCP service through authorization, exchange and refresh. Duplicates, explicitly empty or wrong targets, unchecked permissions and bad PKCE remain denied. Use [assistant setup](assistant-setup.md) for a fresh personal connection; these QA journeys do not prove the owner's host is connected.

A preserving tablet restart at 2026-10-10T09:22:34.702Z confirmed PID 19773 and foreground task t51. It changed no APK, enrollment or PIN. Private pixels were not inspected. Successful visible content on the physical tablet and the owner's completed personal assistant connection remain separate acceptance checks.

For a deliberate bounded live provider check, run `node cloud/scripts/verify-google-live.mjs --synthetic-location`. It creates and deletes its own passkey account, home and account-bound browser trial. It uses the public test city New York, requests actual previews, pairs its own trial, exits that trial's quiet hours and verifies real weather and places on the browser display. It restores quiet hours, withdraws consent and checks deletion and denied access. It consumes a small number of real Google requests under the existing cap and must not be run as an unlimited load test. It does not prepare physical units, approve assistants or use a customer's address. Raw provider results, credentials and cookies are not logged.

## Local release checks

From `E:\GitHub\displayos\cloud`:

```powershell
& 'C:\Program Files\nodejs\node.exe' .\scripts\run-tool.mjs npm ci
& 'C:\Program Files\nodejs\node.exe' .\scripts\run-tool.mjs npm exec playwright install chromium
& 'C:\Program Files\nodejs\node.exe' --test test\*.test.js
& 'C:\Program Files\nodejs\node.exe' .\scripts\build-assets.mjs
& 'C:\Program Files\nodejs\node.exe' .\scripts\run-tool.mjs wrangler deploy --dry-run --outdir .wrangler/bundle
& 'C:\Program Files\nodejs\node.exe' .\scripts\verify-product-runtime.mjs
& 'C:\Program Files\nodejs\node.exe' .\scripts\verify-product-ui.mjs
```

Tests create disposable accounts, authenticators, homes and assistants. The independent MCP SDK runs against workerd. These are not real personal Google/ChatGPT consent or physical tablet evidence. Provider-browser fixtures are explicitly synthetic.

`scripts/deploy-product.mjs` runs these gates before publishing to the existing Cloudflare account. It creates a separate product secret file in the current-user-only NTFS runtime. It does not rotate the old pilot encryption key, remove pilot state, buy a domain or change a paid plan. Wrangler must already be signed in. Keep SDK and browser dependencies installed before an unattended release. On a fresh account or a brand-new Worker name, create the Worker once with a plain `wrangler deploy` and upload the protected pilot secrets (`OWNER_CREDENTIAL`, `ENROLLMENT_CODE`, `STATE_ENCRYPTION_KEY`) from the pilot secrets file before a release run: the release script uploads only the product secrets, and without the pilot trio every route answers 503. Never rotate the encryption key to clear such a failure.

After publishing, it runs `scripts/verify-product-live.mjs` against the actual HTTPS site and records the Cloudflare version only after verification passes. The live product verifier checks public pages, security headers, discovery, denied unauthenticated access and the phone sign-in surface. It creates no accounts, prepares no screens and approves no connections. A failure after publication is reported as an unverified publication, not as an unchanged deployment. The retained pilot's separate `scripts/verify-live.mjs` checks its existing owner login/read/logout without claiming screens or approving agents.

The separate optional `scripts/verify-product-live-flow.mjs --synthetic-home` creates only its own disposable QA passkey, home, account-bound browser trial and narrow test-assistant consent on the published service. It uses an intercepted `.invalid` callback and an official MCP client, publishes synthetic text, verifies a desktop render, revokes its own connection and deletes its own account/home/trial. Cleanup is also attempted after failure. It is not real personal-assistant or tablet proof. A public test-client registration remains until its bounded expiry, and one factory preparation slot is consumed internally by a browser trial. Do not run this repeatedly as a load test or remove any unrelated customer state to recover capacity.

The same verifier accepts `--synthetic-home --connection-shape=chatgpt` or `--synthetic-home --connection-shape=muse` for the observed authorization shapes. The original `--synthetic-home` mode remains valid. Each run makes one public client registration, rotates its refresh token and verifies the resulting scoped connection. Registration is limited to five attempts per IP per hour, including attempts rejected after admission. Account deletion does not reset that budget or remove the bounded public client registration. Do not repeatedly retry a capacity failure or infer the reset time from the most recent attempt.

## Unit preparation

### Live photo verification

Run `node cloud/scripts/verify-product-photo-live.mjs --synthetic-home` from the workspace root after a verified release. It creates its own disposable passkey account and home, chooses detailed synthetic JPEG, PNG and WebP images through Favorite faces, reads the sanitized copies back and checks their catalog after reload. It then deletes that account and home. It uses no customer pictures, screens or assistant approvals. Failure also attempts cleanup of only that test account. The evidence file is `diagnostics/displayos-photo-live.json`; no photo bytes, home identifiers or credentials are written there.

This is live HTTPS photo-storage evidence, not proof that a personal picture appeared on the physical Samsung. Local integrated browser checks cover publication preserving existing family plans and a browser display loading the approved photo.

`kiosk/scripts/setup-tools.ps1`, `build.ps1` and `test.ps1` supply and verify a project-local JDK/Android toolchain, build an APK and test independent protocol rules. Vendor archive hashes are checked before extraction. The debug signing identity is private local demo custody, not a commercial distribution identity.

After the powered SM-T580 has authorized USB debugging, `cloud/scripts/prepare-screen.mjs SERIAL` delegates to the qualified native preparation script. It verifies the model/API, installs the verified demo APK, exports that installation's Keystore public key, requests one key-bound ticket and completes enrollment. Fresh factory staging does not ask the laptop for a PIN; the owner chooses their screen PIN on the tablet during physical home confirmation. No private key is created on the laptop and no shared factory credential reaches the tablet renderer.

The demonstration Samsung was first installed and enrolled on 2026-10-10 and re-provisioned on 2026-10-17 with the current debug APK, the same demonstration signer, a fresh native enrollment against the current origin, default Home re-selected and the previous package removed. Its actual WebView 70 loads the HTTPS setup QR. Android 8.1.0 and security patch 2020-06-01 are obsolete, and the identity reports no hardware backing. Use this unit only as an owner-approved demonstration, not a commercially qualified customer device. Personal provider access, complete physical claiming, rendered family content, cold boots and interruption tests remain separate gates.

No unit is installed, reflashed, rooted or wiped by the software tests. The provisioner refuses a different model. Use separate reviewed profiles for other hardware. Android 8.1 and the upstream Android 6 board remain research-only until a maintained supported firmware/hardware path is qualified.

## Privacy and deletion

Account sessions use Secure HttpOnly cookies. Phones do not receive device factory authority. Screens do not receive passkey, calendar, email or assistant credentials. Assistant grants name a home, screens, permissions and expiry; current membership and revocation are checked on every call.

Family snapshots expire within 24 hours. The renderer clears expired private information locally. Household alarms remove expired server snapshots and receipts. Selected sanitized photos remain until removed by the owner or their home/account is deleted. Server data and native caches are encrypted with context-bound AES-GCM. Media limits are 20 normalized photos per home, 96 KiB each. The browser trial does not persist family snapshots.

Reset fences the old assignment immediately, stops delivery and waits for the screen to erase its local data before becoming unclaimed. A missing response is recoverable through fresh native-key proof. The screen must be physically confirmed again in the new home. Offline pixels cannot be certified erased remotely; the owner sees pending erasure, not a false completion.

Home and account deletion are resumable. Export includes family content and the approved normalized photos, not provider or assistant secrets. Recovery codes invalidate old passkeys and sessions; the person must save a new sign-in before returning to their home. Other homes and a screen transferred to another owner are not deleted with the original creator's account.

## Capacity and updates

This is a bounded service: 128 accounts, eight homes per account, eight adults and eight screens per home, 64 active grants per home, 128 registered assistant clients, 1,000 factory preparations and bounded histories. One registry still serializes identity and assignments. Do not call these limits production load qualification.

Use thirty-second jittered polling for owned screens and backoff when disconnected. Interactive pairing may poll faster. Estimate Worker and Durable Object calls together before expanding a pilot, monitor actual account quotas and do not silently upgrade billing. Rate maps separate public admission from signed-in families, prepared screens and approved assistants.

Record envelopes are versioned and fail closed on unknown versions, key mismatch or corruption. Keep the old `PilotState` binding, namespace, decoder and encryption key. Append migrations; never delete a Durable Object class as a rollback shortcut. Cloudflare code rollback must retain all current class declarations and readers for stored versions. Preserve encrypted platform backups and private key custody before changing storage schemas. Changing `PRODUCT_STATE_KEY` without a tested re-encryption migration makes saved data unreadable; the release script deliberately reuses it.

The native app trusts only its compiled HTTPS origin, refuses redirects/TLS errors and exposes only bounded device commands. Updates require the same protected signing identity and must pass build/protocol checks before installation. Default Home, dedicated-device policy, OS update/recovery and physical update rollback need qualification on the actual unit.

## Before sale

Complete the actual owner's assistant and provider connection, ten cold boots, Wi-Fi/power interruption, visible render/expiry/reset, a 72-hour trial, maintained OS/security review, commercial signing custody, distribution permissions, trademark/domain checks, privacy/legal review and support handoff. No software test substitutes for these gates.
