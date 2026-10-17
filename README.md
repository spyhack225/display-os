# DisplayOS

DisplayOS now has customer passkey sign-in, isolated homes, QR pairing with physical confirmation, scoped assistant connections, structured family updates, private selected photos and an automatic quiet view. Use My home (`/home` on your deployment) on a modern phone and the prepared screen (`/screen` on your deployment) on the display. The browser trial is available in My home. Domain and trademark availability have not been checked.

The full roadmap and remaining physical/provider/commercial gates are tracked in [the implementation ledger](docs/full-implementation.md) and [SCHEME.md](SCHEME.md). [The operation guide](docs/product-operations.md) covers release and per-unit preparation. `kiosk/` contains the independent compiled Android app and its guarded installer. The original pilot remains under `/pilot/` with its state preserved.

Release `3f5e0dd8-da07-47c6-be0d-a21ee6ab7767` fixes detailed-photo uploads in Favorite faces, keeps progress and retry guidance visible, and allows the same file to be chosen after a failure. Passed: 330 unit, 393 protocol, 1130 provider-race, 275 browser and 811 live HTTPS checks. Sixteen additional live photo checks pass for JPEG, PNG and WebP selection, sanitized storage, reload and deletion of only the disposable QA home and account. Existing homes, tablet enrollment and PINs were not reset. Personal assistant publication and visible physical-tablet photo interaction remain separate acceptance checks. Historical releases and evidence stay in [the implementation ledger](docs/full-implementation.md).

The DisplayOS rename is deployed and verified (2026-10-17): 395 cloud unit, 393 workerd protocol, 1,130 provider-race, 275 browser and 861 live HTTPS checks pass on the renamed code, and Worker `displayos` is live at `https://displayos.sergio-williomes.workers.dev`. The design-work gap noted during the rename is closed: the product surfaces render the `.local-attribution` markup and the full browser suite passes. The demonstration tablet runs the new `com.displayos.kiosk` app, freshly enrolled and selected as default Home, with the previous package removed; the owner's physical PIN choice and claim remain the next step.

- **Samsung demo.** After charging, the owner connected the SM-T580 to their home. The installed kiosk now includes the empty-dashboard and startup-race corrections. The owner confirms that the reconnect loop stopped. No firmware was flashed and no wipe was performed. Long-duration and commercial qualification remain open. [Device evidence](diagnostics/displayos-tablet-preparation.json); the 2026-10-17 re-preparation is in [displayos-tablet-repreparation.json](diagnostics/displayos-tablet-repreparation.json).
- **Local software prototype.** Original code under `demo/` demonstrates separate ownership claim and agent permission, followed by bounded text updates. An external-process client published a card and the visible Chrome display sent its render receipt. It is not a repaired tablet or a production AI connector. [Demo instructions](demo/README.md).

## Use DisplayOS

Open My home on your phone, save a sign-in with your face, fingerprint or phone PIN, and name your home. Scan the prepared screen's code and confirm the matching words on that screen. Add DisplayOS through your assistant's supported connection setup before sending an invitation. For ChatGPT Work and dots, follow [Add DisplayOS to your assistant](docs/assistant-setup.md). A pasted message does not install a plugin, and this pilot has no public directory listing yet. Approve the screens and information you want it to use in your own browser. Access defaults to 30 days and can be stopped at any time. No family member needs a server key or installer account.

Without a tablet, open **Try it on this computer** in My home. This creates a clearly labelled browser trial, not a simulated hardware success. Personal assistant and provider access still require deliberate consent.

The independent Android app loads the authenticated HTTPS dashboard, handles native device identity and startup, and keeps credentials out of the renderer. Glass-inspired controls sit above readable family cards. Quiet view shows a local clock, calendar, upcoming plans and approved photos. Night privacy and offline expiry clear private content locally.

Current assistant instructions (`/skill.md` on your deployment) describe the implemented authenticated connector and tools. Direct calendar, inbox and weather controls are implemented, but require the operator's provider configuration and the family's separate consent. Unconfigured sources are shown as unavailable, not as working connections.

## Verification and history

The implementation ledger records current unit, real-service browser, protocol, APK and live-release evidence. Test identities and authenticators are disposable. They are not proof of a personal ChatGPT/Google connection or physical tablet operation. Logs and screenshots are under ignored `diagnostics/`.

Earlier prototype and recovery documents were moved out of this repository. The live `/skill.md` is the authoritative assistant instruction, and the visual language is described in [docs/design-system.md](docs/design-system.md).

The original pilot remains at `/pilot/setup`, `/pilot/display` and `/pilot/skill.md`, with its prior authentication and stored state preserved. The E: workspace is exFAT. Cloud and Android secrets stay in separately protected, current-user-only NTFS runtimes, not in this workspace.

## Hardware checkpoint

Current checkpoint, 2026-10-17: the tablet is charged and running Android 8.1 with WebView 70. It now runs the current DisplayOS debug build (`com.displayos.kiosk`, `1ad3a21f…`, signer `322979a6…`), freshly enrolled through the factory preparation flow against the current Worker, and is selected as default Home; the previous package was removed. The owner's physical screen-PIN choice and home confirmation on the unit remain next. No hardware-backed identity, personal-assistant receipt, cold-boot trial or commercial readiness is claimed.

## License

Copyright (C) 2026 Wearer Lab.

DisplayOS is free software under the GNU Affero General Public License v3.0 only (AGPL-3.0-only). The full text is in [LICENSE](LICENSE) and third-party notices are in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

The AGPL covers network use. If you run a modified version of the cloud service for other people, you must offer those users the source of your modified version. Unmodified deployments only need to link to this repository.
