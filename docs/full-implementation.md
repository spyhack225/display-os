# DisplayOS full implementation

> Naming note: this record was written before the October 2026 rename to DisplayOS. Release IDs, dates and recorded hashes are unchanged from the original runs; artifact and file names were updated to the current name, so a recorded name may not match a historical hash byte-for-byte. External resources keep their original identifiers where they still exist.

Requested on 2026-10-10. This tracks the whole roadmap, not a smaller preview milestone. Do not mark an external acceptance gate complete because its software exists.

## Execution checklist

- [x] Read the working principles and trace the current service before designing changes.
- [x] Frame the complete scope and capture baseline evidence.
- [x] Design the workflow: compare two architecture candidates, choose a data model and publish module contracts.
- [x] Run the loop: implement each unit and verify its own acceptance tests before integration.
- [x] Keep the audit trail: record decisions and checkpoint evidence in `.audit/full-product/decisions.tsv`.
- [x] Verify the integrated Cloudflare software, review security and deploy only after its release gates pass.
- [x] Install and prepare the authorized physical tablet, verify its setup screen and select DisplayOS as Home.
- [x] Owner reported successful physical home confirmation with the six-digit screen PIN.
- [x] Fix the empty-dashboard reconnect root, pass Android JSON regressions and install a preserving app update.
- [x] Owner confirms the installed correction stopped the visible tablet loop.
- [x] Publish and verify the full-width home redesign, pairing countdown, six-number entry, screen naming and private location controls.
- [ ] Complete an actual assistant-controlled tablet demonstration.

## Baseline and traced constraints

The existing Worker routes assets through exact HTTPS origin checks. The pilot service runs one encrypted Durable Object snapshot for one shared operator owner. Its display model handles enrollment, two-minute pairing, separate expiring agent grants, ordered text-card revisions and explicit client receipts. The browser stores display and request credentials in tab session storage. Its plain-language screens still depend on installer keys and omit real customer identity, QR, structured family data, media and native startup.

Last verified baseline: 22 cloud unit tests, 28 local workerd checks, 53 browser checks and 56 live HTTPS checks. Existing UI screenshots are under `diagnostics/displayos-ui/`. Existing pilot storage and encryption keys must survive this work. Do not silently clear or migrate away customer or pilot state.

At the initial checkpoint, ADB detected no tablet and standard locations had no Android SDK or Java executable. A protected local toolchain and signed kiosk builds now exist. Cloudflare OAuth is authenticated to the existing your Cloudflare account account. No branded hostname, third-party provider OAuth client, approved commercial signing identity or published assistant listing has been supplied. The owner enabled USB debugging and trusted this computer. At 05:39 UTC the qualified Samsung was installed and enrolled using its own native key. Actual WebView 70 shows the live setup QR. DisplayOS is its default Home. No firmware change, wipe or device-owner provisioning was needed.

## Definition of software done

A person on a modern phone can create and revisit a real authenticated home without finding operator keys. A uniquely provisioned screen shows a live expiring QR and manual fallback. Claiming requires owner authentication and confirmation on the screen. Another home cannot claim, read or control that screen. A supported authenticated MCP/HTTP assistant can request access, wait for deliberate approval, configure bounded settings and publish a valid family snapshot. The renderer shows that snapshot, approved photos and useful quiet-mode content. It sends a receipt after a visible render. Replays, stale writes, bad content, expired data and revoked access fail safely. Logout, recovery, deletion and transfer are implemented and tested. A kiosk APK can be built with unique provisioning, restricted HTTPS navigation and platform-protected identity. No simulated test may be described as a real personal account or tablet test.

## Implementation units and gates

| Unit | Required implementation | Gate |
| --- | --- | --- |
| Identity and home isolation | Consumer passkey sign-in, recovery, sessions, per-home state and quotas | Real WebAuthn registration/authentication verified with a disposable authenticator; wrong origin, challenge replay and cross-home access fail |
| Device lifecycle | Unique preparation credentials, resumable enrollment, QR, manual code, physical confirmation, reset and transfer | Stolen QR alone cannot claim; codes expire; repeated enrollment and interrupted confirmation converge |
| Family data | Versioned bounded briefing, weather, week, kids, parents, news, prompts and nearby events | Valid external updates render; oversized or unsafe fields and wrong revisions fail |
| Media | Owner-approved bounded JPEG/PNG upload and authorized delivery | Cross-home access and arbitrary remote URLs fail; deleted or expired media is removed |
| Family UI | Supplied module intent, glass controls, portrait/landscape layouts, owner setup and settings | Ordinary users see no API keys, IDs, scopes or server instructions; normal bounded content is readable |
| Quiet and offline behavior | Local clock/calendar, next event/reminder, photo rotation, idle entry, night privacy and reconnect | Expired private content disappears offline; user interaction returns to the day view |
| Assistant connector | Standard OAuth with PKCE and protected-resource discovery, remote MCP tools, scoped approval and revocation | A separate client completes the complete authorization and publish flow; replay, audience confusion and scope expansion fail |
| Providers | Consent-based integration hooks, calendar/weather adapters and safe summaries | Tokens stay off the screen; unconfigured providers fail closed; configured providers still require real owner consent |
| Kiosk and preparation | Independent Android Home/WebView client, secure identity, Wi-Fi repair, owner exit, provisioning/build scripts | APK compiles and is inspected; navigation/TLS/recovery tests pass; physical boot tests remain explicit |
| Operations and privacy | Account and display removal, export, reset, bounded logs, update/recovery documentation | Revoked identities cannot return; deletion removes private state; logs contain no credentials |
| Integrated release | Adversarial review, tests, runtime/browser flow, live deploy, live TLS checks | No known release-blocking software findings; deployment does not damage the old pilot |

## Design and work ownership

Two independent candidates are written under `.audit/full-product/`. Parent work owns the shared protocol, authentication and Worker integration. Delegates own disjoint files for UI, Android and independent security verification once the contract is fixed. No branches or commits are created. The first throughput checkpoint is whether identity, the structured contract and device lifecycle pass before presentation work can be called connected.

## External acceptance gates

- The physical Samsung runs Android 8.1.0, API 27, WebView 70.0.3538.110 and security patch 2020-06-01. Installation, HTTPS enrollment, setup rendering and Home resolution are verified. Power interruption, cold boots, family render receipts and the 72-hour trial remain open. Its native identity reports hardwareBacked false, so hardware-backed key custody is not claimed.
- Connecting a real personal assistant or calendar account requires the owner's consent. Platform app publication and third-party OAuth credentials may need account-owner configuration. Do not bypass identity prompts or advertise universal assistant support.
- Signing and hardware qualification, maintained firmware, distribution rights, trademark/domain checks, privacy/legal review and commercial support policies are not made true by code. Keep obsolete Android synthetic until those gates pass.
- Do not upgrade a Cloudflare paid plan, buy a domain or wipe another device automatically.

## Implemented software evidence

The selected architecture is the bounded registry plus isolated household actors in `.audit/full-product/candidate-b.md`, compared with the independent-device-actor alternative in `candidate-a.md`. Its module contracts are in `docs/product-contract.md`. The original pilot actor and encryption key remain separate and unchanged.

- Identity: cryptographic passkey registration, authentication, new-key recovery, membership checks and resumable deletion; real Chromium WebAuthn registration runs against the workerd service with disposable authenticators.
- Devices: native-key-bound preparation, enrollment, expiring QR/manual claim, physical confirmation, epoch fencing, interrupted reset recovery and transfer. Browser trials are explicitly account-bound because their keys are extractable; they are not transferable hardware.
- Family data and photos: strict schema, revision conflict handling, idempotent publication, delivery/visible-render receipts, expiry alarms, approved normalized JPEG/PNG and authenticated delivery. No arbitrary HTML or remote image URL is accepted.
- Consumer UI: passkey phone setup, owned screen confirmation, dated assistant approval, settings, sources, photo catalogue, adult invitations, export and removal. Both orientations, maximum text bounds, readable detail sheets, quiet view, upcoming events, night privacy, offline expiry and an old-browser Promise fallback are exercised in Chromium.
- Assistants: OAuth discovery, public registration, S256 PKCE, narrow consent, rotated refresh tokens, stop/cancel and eight MCP tools. An independently installed official client completes authorization and updates against workerd. This does not claim every assistant host supports this connector.
- Sources: selected Google calendars, separately opted-in inbox subject metadata and configured weather adapters. Real browser fixtures verify the consumer controls; actual Google consent and commercially applicable weather configuration remain external.
- Kiosk: independent Android Home/WebView app, native Keystore identity, encrypted private cache, narrow HTTPS bridge, PIN exit, Wi-Fi repair, boot and guarded preparation. The installer validates APK signatures against the protected signer and stages verified bytes privately. The physical Samsung is now installed and enrolled; no firmware change occurred. Native key hardware backing is absent on this unit.
- Operations: account/home removal, resumable cleanup, current-membership checks, photo-inclusive export, bounded admission categories, context-bound encrypted records, preserved pilot and an independently reviewed release path.

Passing test accounts, simulated transport and desktop pixels do not close any physical or personal-account gate above.

## Earlier verified Cloudflare release

Published version: `1dbe4684-14fd-4c9e-99ca-f00c91c74306`, verified 2026-10-10 at 05:18:28 UTC. My home (`/home` on your deployment), screen (`/screen` on your deployment) and assistant instructions (`/skill.md` on your deployment) are live. Published home and screen JavaScript hashes match the final local source. No pilot key was rotated and no paid plan or domain was purchased.

| Evidence layer | Result | Boundary |
| --- | --- | --- |
| Cloud unit tests | 156 passed, no skips or todos | Cryptographic identity, family/media/providers, OAuth/MCP, encryption, capacity and review regressions; fixtures are disposable |
| Product workerd protocol | 117 passed | Real WebAuthn, actor restart, independent MCP SDK, two-home denial, real JPEG/PNG, reset and transfer |
| Product workerd browser | 143 passed | Real consumer flow, maximum text bounds, photos/export, 30-day consent, durable denial/callback, hash navigation, invitations, recovery, quiet/night/offline privacy and removal |
| Product live HTTPS/browser | 208 passed | Public pages/assets/headers, discovery, denied unauthenticated access and actual phone sign-in surface; no account or consent created |
| Product live synthetic journey | 35 passed on this final version at 05:20:03 UTC | Fresh QA passkey/home/browser trial, explicit QA consent, independent MCP publication, visible desktop render, revocation, account/home/trial deletion and old transport rejection |
| Preserved pilot | 28 local protocol, 53 browser, 56 live HTTPS passed | Its prior state, owner authentication, CSP, CSRF, revocation and routes remain separate |
| Kiosk before physical preparation refinement | 41 checks; both signed APKs and seven PowerShell scripts verified | JVM/adapter/ACL/installer proofs; not Android runtime or tablet evidence |
| Runtime dependency registry audit | Zero reported vulnerabilities | Installed production dependencies only; not a security certification |

The final release log is `diagnostics/displayos-product-release-verified.log`. Live evidence is under `diagnostics/displayos-product-live/`; the final synthetic journey log is `diagnostics/displayos-product-live-flow-final.log`. The independent findings and resolutions remain in `.audit/full-product/security-review.md`. APK hashes and native evidence remain in `kiosk/BUILD-EVIDENCE.md`.

Two bounded synthetic live journeys were run in total. Both removed their own QA account, home and browser trial. They consumed two internal preparation slots and left two public client registrations until their bounded expiry. They did not connect the owner's personal assistant, Google account or physical screen, approve a real household grant, or touch other customer data. No unlimited production test loop was used.

The headless fresh-preparation revision passed 55 checks and both signed artifact verifiers before physical installation. The six-digit PIN follow-up passed 84 checks and was installed without clearing enrollment or the owner PIN. Its debug APK SHA-256 is `09db98e172cea1d4c74a445b5b5ded0d0b81bce17c0dad2adebf9fe0cc2818a4`. The owner then reported successful connection, followed by a reconnect loop before the first family update. The server correctly sends `snapshot:null` for an empty owned dashboard. Native key-presence checks incorrectly treated that null value as expired private content. The preserving correction also exposed and fixed a separate queued-initialization race. Final installed debug APK `a1563e652f9182d3f0bd74c9ccbd4d0974697f3cee71fb6d1348ae1675c52ad5` passed 102 checks, including eleven real Android JSON regressions and lifecycle fencing. Three rapid starts produced no new Android crash report. The owner confirms, "The loop has stopped." No synthetic family data was published to hide the defect, and no re-enrollment or PIN reset was used. Physical evidence is in `diagnostics/displayos-tablet-preparation.json`. No PIN, bearer or private screen capture was collected.

## Earlier home redesign release

Published version `d2480a3f-50c1-412b-8855-b1d0c85fea5b` was verified at 2026-10-10T07:01:38.950Z. The release command exited 0. The log is `diagnostics/displayos-product-release-current.log`.

| Evidence layer | Result | Boundary |
| --- | --- | --- |
| Cloud unit tests | 257 passed, zero failures or skips | Includes manual-code guessing limits, ownership-preserving rename, private locations, provider authorization and operator safety |
| Product workerd protocol | 143 passed | Disposable real WebAuthn, isolated homes, encrypted restart, independent MCP client, empty snapshots and screen identity |
| Product workerd provider races | 1130 checks across 32 cases | Actual Durable Object scheduler; 66 synthetic Google calls, no external network; concurrent polling, revocation, reset, deletion, consent changes and persistent 300-call daily limit |
| Product workerd browser | 239 passed | Full consumer flow, responsive widths, single-field six-number entry, countdown, rename, transient local content, photos, quiet/offline privacy and late old-session rejection after recovery |
| Product live HTTPS/browser | 271 passed | Public routes and security boundaries; six published assets match the tested build byte for byte; no account, screen, grant or provider was created or approved |

The full-width home page uses three columns on desktop, two on tablet and one on phones. Screens, helper invitations and location controls are primary. Photos, people, settings and safety stay closed until chosen. Room names save without changing screen identity, permissions or family revisions. The ordinary Screen label matches the physical display. Manual pairing accepts six numbers in one accessible, pasteable field, while the scanned QR retains a separate strong secret. The screen shows when the code expires and hides expired codes while obtaining a replacement. Existing enrollment, owner PIN, homes and pilot credentials were preserved. The live synthetic journey recorded above belongs to the earlier version and was not repeated against private customer records.

At that release, Google configuration stopped because the authenticated CLI returned no open billing accounts. No billing linkage, API enablement or Google-key publication took place in that first attempt. Owners could save their private address or city, but weather and places were unavailable. The following release records the owner's later billing enablement and actual provider verification.

## Earlier Google and standby release

Version `71b34076-b838-4eec-a8eb-3292862d948d` was verified at 2026-10-10T07:39:01.109Z. The release command exited 0. Evidence is in `diagnostics/displayos-google-layout-release-final.log`.

| Evidence layer | Result | Boundary |
| --- | --- | --- |
| Cloud unit tests | 260 passed, zero failures or skips | Includes operator CLI error parsing and provider-preview clock bounds |
| Product workerd protocol | 143 passed | Disposable identity, ownership, encrypted restart and protocol checks |
| Product workerd provider races | 1130 checks across 32 cases | Actual scheduler, 66 synthetic provider calls and no external network |
| Product workerd browser | 267 passed | Full consumer journey, spaced location controls, persistent Screen labels, bounded local clocks and richer standby |
| Product live HTTPS/browser | 280 passed | Public security boundaries and seven exact-byte published assets; no customer mutations |
| Real Google preview UI | 26 passed | Published Preview buttons returned real weather and places with visible attribution for a disposable New York test home; consent withdrawal denied access; test account and home deleted |

The approved external Google Cloud project's billing was verified active. Geocoding, Weather, Places and API Keys were enabled, with three separate API-restricted server keys stored outside the shared workspace and published to the existing Worker. The service enforces 300 actual Google outbound calls per UTC day, including failed calls. This is a request cap, not a dollar spending cap or a limit on other project users. The customer's home, address and consent were not changed. Google results remain transient and absent from family snapshots, exports and offline caches. Personal assistant, calendar and inbox OAuth consent remain open gates.

Every owned screen shows its ordinary matching label in daytime, empty, standby, overnight and offline modes. Daytime standby can show existing approved family updates and photos, plus today's consented weather and one nearby place with attribution. Overnight standby contains only a dim clock, public date, date-only monthly calendar and Screen label. It does not show family appointments, photos, names or local results, and makes no Google requests.

The first release attempt stopped before publication when the full browser gate could not open the worst-case kids card. The cause was a test clock paused across a shared browser context, which also froze the main display's animation frames. The clock fixture now has its own context with guaranteed cleanup. Targeted tests verify frame progress, maximum-note scrolling and standby privacy. The failed attempt remains in `diagnostics/displayos-google-layout-release.log`; it is not counted as a pass.

## Current verified Cloudflare release

Version `3f5e0dd8-da07-47c6-be0d-a21ee6ab7767` is live. The release command exited successfully after 330 unit, 393 workerd, 1130 provider-race, 275 integrated browser and 811 live HTTPS checks. The protected deployment receipt records `2026-10-10T10:37:15.065Z`. Evidence is `diagnostics/displayos-photo-release.log`.

Favorite faces previously stopped after one resize, leaving some detailed images above the upload limit. JPEG server sanitizing could also enlarge an already valid compressed input beyond that limit. Browser preparation now keeps shrinking until its JPEG payload fits, and server re-encoding reduces quality when needed. The 96 KiB limit, strict format checks, metadata removal, household permissions and screen approval remain enforced. Persistent feedback distinguishes unreadable photos, oversized selections and a full collection; failed selections can be retried with the same file. A home switch during preparation cannot redirect the selected picture to another home.

Six photo regressions failed before the correction. All nine added regression cases pass in the complete unit gate. The integrated browser journey now uploads a detailed image through real workerd, preserves the existing briefing and loads the approved photo on its browser display. A separate deployed journey passed 16 checks for detailed JPEG, PNG and WebP browser selections, sanitized storage, catalog reload and deletion of its own QA account and home. Evidence is `diagnostics/displayos-photo-live.json`, verified at `2026-10-10T10:37:34.356Z`. No personal pictures or physical screens were used. Actual personal-photo rendering on the Samsung remains unverified.

## Previous action-discovery release

Version `a671cc7b-dd24-45f4-b684-6b8b30e524b5` passed 321 unit, 393 workerd, 1130 provider-race, 275 browser and 811 live HTTPS checks. It removed closed-name MCP capability validation and corrected a diagnostic cloned-stream stall without adding permissions. The real owner's existing plugin was refreshed and exposes five read actions and one write action. A selected-plugin conversation reported a successful two-screen lookup, but its invocation result was not independently inspectable. Personal publishing and a physical-tablet receipt are not claimed. See `.audit/full-product/action-discovery-incident.md`. OAuth source is unchanged in the photo release.

## Previous calendar and authorization release

Version `4947d62b-5750-444b-b0db-1b4e10523376` was published with 317 unit tests, 393 workerd protocol checks, 1130 provider-race checks and 275 browser checks. A coverage-only calendar fixture refinement was followed by another 317-test pass before publication. Evidence is in `diagnostics/displayos-host-calendar-release.log` and `diagnostics/displayos-host-calendar-unit-final.log`.

The initial release command exited 1 after publication because the live asset assertion reported a `screen.js` mismatch. An immediate probe matched the tested 34,605-byte source, SHA-256 `539bee6026089b71d227f2bbe2707cc80d593c76b4f645727d62e2e6c23ab447`. A complete 811-check live repeat passed on the same version without source changes or redeployment. The initial failure remains recorded; its cause is unproven. The repeat evidence is `diagnostics/displayos-host-calendar-live-final.log`. Do not describe the initial release command as successful or attribute the mismatch to a confirmed cache defect.

| Evidence layer | Result | Boundary |
| --- | --- | --- |
| Cloud unit tests | 317 passed | Includes host authorization compatibility and nine calendar reading-sheet regressions |
| Product workerd protocol | 393 passed | Real disposable WebAuthn, encrypted restart, official MCP SDK, two-home controls, explicit consent and both host request shapes |
| Product workerd provider races | 1130 checks across 32 cases | Actual scheduler with synthetic Google endpoints; no external network |
| Product workerd browser | 275 passed | Disposable consumer journey, calendar detail, approval, revocation, recovery, photos and private-data expiry |
| Product live HTTPS/browser repeat | 811 passed | Published security boundaries and exact tested assets; no customer account or consent created |
| ChatGPT-shaped live QA journey | 42 passed at 2026-10-10T09:21:46.157Z | Extra language hint, explicit MCP target, deliberate QA consent, refresh rotation, official SDK, desktop render, revocation and QA deletion |
| Muse-shaped live QA journey | 42 passed at 2026-10-10T09:22:00.386Z | Omitted MCP target through authorization, exchange and refresh; same scoped QA journey and deletion |

Authorization ignores bounded optional hints without fetching, storing or echoing them. An omitted target defaults only to this origin's MCP service. Duplicate parameter names and explicitly empty or wrong targets remain rejected. PKCE, client binding, home and screen selection, consent, expiry and revocation remain required. Both live request-shape journeys deleted their own QA account, home and browser trial. Evidence is in `diagnostics/displayos-host-chatgpt-live.log`, `diagnostics/displayos-host-muse-live.log` and the corresponding `synthetic-flow-chatgpt.json` and `synthetic-flow-muse.json` under `diagnostics/displayos-product-live/`. Neither proves a personal ChatGPT or Muse connection.

The calendar detail control now survives an unchanged owned poll with no family snapshot, so approved local-only calendar information can still be opened. Nine renderer regressions cover the reading sheet and privacy boundaries. Family and local expiry still close private detail views; the fix does not retain an expired copy.

At 2026-10-10T09:22:34.702Z, a preserving tablet restart confirmed PID 19773 and foreground task t51. No APK was changed, no enrollment or PIN was reset, and no private pixels were inspected. The owner's visible family or local-content confirmation, completed personal assistant connection, cold boots and long-running physical trial remain open acceptance gates.

## Previous public instructions and plugin setup release

Version `0ac4d8ed-1c49-483c-b07d-6d29ed3869ee` was verified through 2026-10-10T08:53:58.940Z. Checks passed: 300 unit, 351 protocol, 1130 provider-race, 275 browser, 811 live HTTPS and 36 separate live OAuth/MCP checks. Eight deployed consumer assets match the tested build. Evidence is in `diagnostics/displayos-public-plugin-release.log`, `diagnostics/displayos-public-plugin-live-final.log` and `diagnostics/displayos-public-plugin-mcp-live.log`. The initial post-publication public-header assertion failed. A complete live repeat passed on the same version without source changes or redeployment; the initial failure is retained and its transient cause is not asserted.

Only the four exact public instruction and OAuth discovery GET routes permit cross-origin reading. Their responses remove cookie and credential headers. Private home, device, OAuth changes and MCP calls retain their authorization and origin checks. Public instructions, the owner helper panel and [assistant setup](assistant-setup.md) now explain that a chat invitation does not install a plugin. There is no public DisplayOS directory listing or one-click installation link.

The actual owner ChatGPT account offers custom OAuth MCP setup and discovers DisplayOS's endpoints and Dynamic Client Registration. A form was prepared with only screen reading and family updates. The owner's attempt reached the approval address but Chrome displayed ERR_BLOCKED_BY_CLIENT. No protection was disabled, approval URL stored or personal consent bypassed. Owner approval, installation and a dot render receipt remain open. That release's live SDK test deleted only its own QA account, home and trial; it does not prove the personal connection. See `diagnostics/displayos-assistant-connection.json`. No native APK change or tablet reset was needed for this release.

## Previous local-information and registration release

Version `eb236600-edd1-4b6f-bb82-fee74438f504` was verified at 2026-10-10T08:28:09.405Z. Full release gates passed with 281 unit, 143 protocol, 1130 provider-race, 275 browser and 289 live HTTPS checks. Eight deployed assets match the tested build. A final separate 79-check standby/layout run also passed, including centered button bounds and an actual thirteen-second local-response fixture. Evidence is in `diagnostics/displayos-connection-local-release.log` and `diagnostics/displayos-connection-standby-final.log`.

Automatic OAuth registration now ignores bounded optional metadata instead of rejecting it. The six authority-relevant fields retain their validation, and ignored fields are never fetched, persisted, echoed or treated as consent. At 2026-10-10T08:29:06.668Z, 36 live disposable-home checks passed through registration with optional metadata, explicit consent, an official MCP client, publishing, desktop rendering, revocation and deletion. This does not prove the owner's Muse or Dot connected. Evidence is in `diagnostics/displayos-connection-mcp-live.log`.

The tablet clock lagged by roughly 2.5 seconds, enough for native validation to reject a newly issued one-hour local response. The new sanitizer allows at most thirty seconds of upper skew and clamps expiry downward to one local hour. Expired data and changed authority remain denied. Only authenticated local GET receives a thirty-five-second native read budget; the browser gives local information and two owner previews forty-five seconds. Other request budgets remain unchanged. Returning-user browser ceremony failures show neutral persistent guidance without creating or resetting an account.

At 2026-10-10T08:28:49.547Z, 42 real Google checks passed through previews and an explicitly paired disposable browser display, including Show full display and return to quiet hours. That QA account, home and trial were deleted, and customer consent was not changed. Evidence is in `diagnostics/displayos-connection-google-live.log`.

The native update passed 115 kiosk checks, signed artifact/source verification and the guarded preserving installation. Debug APK `0b1d5faf15a098f0e0e09a4da7bd18c25183636b8dbb99c72190449fc0da705a` is bound to app source `c11c746ee34516b9a673f76fed0125779e2d160e9ce995c4e2e5f737e959280f`. Encrypted enrollment remained present. After publication, a preserving restart confirmed PID 18333, foreground task t50 and default Home at 2026-10-10T08:29:46.153Z. No private pixels, address or bearer were inspected. The owner's visible native weather, actual assistant and Windows passkey availability remain acceptance checks, not claimed successes.

## Previous temperature and quiet-hour release

Version `4366acc7-c606-4423-a7de-09f5d5860014` was verified at 2026-10-10T08:00:48.941Z. The full release command exited 0, passing 265 unit, 143 protocol, 1130 provider-race, 273 browser and 289 live checks. Eight deployed assets match the tested build. Evidence is in `diagnostics/displayos-temperature-quiet-release.log`. A separate final 63-check browser regression covers the deliberate quiet-hour exit, held pre-gesture and post-gesture replies, no transient old-family flash, returning to privacy, canonical-temperature conversion and no extra provider calls for unit changes.

Quiet hours were an intentional gate on weather and nearby information, but the screen did not explain that gate or offer an exit. The requested Show full display button now obtains a fresh authorized update before showing full content. Back to quiet hours clears it; neither changes the saved schedule. Saving privately still does not enable local sources. Location controls explain the explicit sharing action and expected poll delay, while failed local loads show a retry message.

Celsius and Fahrenheit buttons save a unit-only home preference. A new owner-only command preserves every other individual screen preference, including custom quiet hours and photo choices. Provider and family values remain Celsius; only display text is converted. The actual owner flow verifies persistence after reload and propagation to screen polls without changing family content or fetching another local result.

At 2026-10-10T08:01:06.099Z, 29 real Google live checks passed through the deployed Preview controls, including switching an actual weather preview to Fahrenheit and back and verifying the saved preference. The disposable public-city account and home were deleted, with customer consent unchanged. Evidence is in `diagnostics/displayos-temperature-google-live.log`. The existing native app supports these changes without a rebuild; its transport and local-content schema remain unchanged. Physical private pixels and the user's actual address were not inspected, so an owner-visible weather confirmation remains separate from synthetic live proof.
