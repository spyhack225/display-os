# On-screen list editing (full setup, open editing)

Status: in progress. Source of truth is code.

## Decision

Full device write path. Once an owner enables a screen, anyone touching that screen can add,
tick off, and remove grocery and to-do items. No per-edit PIN.

## Trust model (deliberate)

- Screens stay untrusted: possession of the screen equals permission, only on screens the
  owner explicitly flagged. Default off. The flag is per screen, revocable anytime.
- Writes are lists-only, plain text, existing bounds (4 lists, 12 items). The full snapshot
  is revalidated server-side on every edit.
- Tight per-screen rate budget on top of the existing device command window.
- The shared kiosk WebView cannot be taught new calls without an APK rebuild, so the
  tablet needs a reinstall over USB. Browser demo screens work with the server half alone.

## Changes

- `cloud/src/product/household.js`: `screen.lists` (owner flips `allowListEdits`),
  `lists.edit` (device principal only, flag-gated, revision-guarded read-modify-publish).
  Device command gate extended. Poll responses carry `allowListEdits`.
- `cloud/src/product/registry.js`: `POST /device/v1/lists` with device auth and a
  12-per-minute per-screen budget.
- `cloud/product-public/screen.js`: lists modal gains add-item form, done checkboxes and
  remove buttons when the screen allows editing. Retries once on revision conflict.
- `cloud/product-public/home.js`: per-screen "let this screen edit family lists" toggle.
- `kiosk/.../Protocol.java` + `kiosk-native-transport.js`: allowlist the new path.
  APK rebuild and USB reinstall required on the tablet.
- Tests: household toggle plus add/tick/remove/validation/conflict/flag-off cases,
  screen UI flows for allowed and read-only screens.

## Remaining

- Rebuild the APK on a machine with the toolchain and reinstall on the tablet over USB.
- Deploy the worker and confirm live, then restart the kiosk app on the tablet.
