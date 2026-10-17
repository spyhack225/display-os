# DisplayOS rename — completed record

Completed 2026-10-17. The product, code, evidence and workspace were renamed to DisplayOS in place; no old-name compatibility layer remains.

## What changed

- Worker `displayos` (`https://displayos.sergio-williomes.workers.dev`), Durable Object contexts, crypto contexts, cookies, headers and `DISPLAYOS_*` environment variables.
- Android package `com.displayos.kiosk`, fresh signing key (DN `CN=DisplayOS Local Demo`), APK `displayos-kiosk.apk`.
- Private runtimes under `%LOCALAPPDATA%` (`DisplayOS`, `DisplayOSKiosk`, `DisplayOSKioskToolchain`); the old runtime copies were removed after verification.
- Workspace folder `E:\GitHub\displayos`; evidence files renamed and their contents and citations updated to the current name.
- Historical workspace paths and pre-rename product names were removed from all current documents, evidence and scripts.

## Verification on the renamed tree

- Cloud: 395 unit, 28 retained-pilot workerd, 393 product workerd and 1,130 provider-race checks pass; `cloud/dist` and the Wrangler dry-run bundle regenerate clean with zero pre-rename strings.
- Kiosk: Debug and Release build and verify with the new package and signer; the full local test suite passes (12 + 55 + 11 + 31 + 4 + 2 checks).
- Closed the same day: the `.local-attribution` design work now renders on the weather-now, week, nearby, quiet-view and day-details surfaces (brand and source spans, `translate="no"`), decorative emoji are `aria-hidden` so the exact accessible-name checks pass, and the verifier's stale selectors were aligned (`.frame-photo`, eight family tiles). The full 275-check browser suite passes.

## Follow-ups (updated 2026-10-17 evening)

- Deployed the same day. A bootstrap `wrangler deploy` created the fresh Worker `displayos`, then the full release command published code version `c8390a65-957b-4b21-8c70-365cfd52918f` with 395 unit, 393 workerd, 1,130 provider-race and 275 browser checks green. Its first post-publication route probe failed because the fresh Worker lacked the three pilot secrets; the initial failure is preserved in `diagnostics/displayos-product-release.log`. The protected pilot secrets were uploaded unchanged from the protected pilot secrets file (`cloud-pilot-secrets.json` in the current-user runtime; no key rotated), and the live repeat passed 861 HTTPS checks on the resulting active version `8bfcd7b2-c99c-4282-ab2e-aaa8c4ded2e7` without further code change (`diagnostics/displayos-product-live.log`).
- Re-enrolled the tablet the same day. `cloud/scripts/prepare-screen.mjs 520305b1eea3a425` installed the current debug APK with a fresh native enrollment (`prepared:true`, `hardwareBacked:false`), selected `com.displayos.kiosk/.MainActivity` as default Home and removed the previous package; the owner's physical PIN choice and home confirmation remain. The adb default in `kiosk/scripts/provision.ps1` moved into the script body because Windows PowerShell 5.1 leaves `$PSScriptRoot` unset while binding Mandatory parameter defaults under `-File`; `diagnostics/displayos-tablet-prepare-preflight-failure.log` preserves the failure that motivated the fix.
- Still open: re-run `configure-google.mjs` before further Google work; the first run stops until the copied metadata is replaced and fresh `displayos-*` keys are created in the approved project.

## Kept deliberately external

- The approved Google Cloud project ID `next-notes-mac`.
- The upstream design credit (`spyhack225/next-notes`, see `THIRD-PARTY-NOTICES.md`).
- The previous live origin `https://desk-signal-pilot.sergio-williomes.workers.dev` was never renamed; the owner deleted that Worker and the other old Workers on 2026-10-17. Worker `displayos` replaces it, and historical evidence files may still cite the old origin.
