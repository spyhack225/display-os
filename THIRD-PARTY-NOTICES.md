# Third-party notices

DisplayOS is copyright (C) 2026 Wearer Lab and licensed under AGPL-3.0-only (see `LICENSE`). It uses the packages below under their own licenses, all of which are compatible with the AGPL. Each package keeps its full license text in its `node_modules` folder and in its source repository.

## Shipped in the Worker or the browser bundle

| Package | Version | License | Copyright |
| --- | --- | --- | --- |
| `@simplewebauthn/browser` | 14.0.0 | MIT | 2020 Matthew Miller |
| `@simplewebauthn/server` | 14.0.3 | MIT | 2020 Matthew Miller |
| `qrcode-generator` | 2.0.4 | MIT | 2009 Kazuhiko Arase |
| `jpeg-js` | 0.4.4 | BSD-3-Clause | 2014 Eugene Ware |
| `pngjs` | 7.0.0 | MIT | 2015 Luke Page and original contributors; derived from work 2012 Kuba Niegowski |

## Development and test tooling (not shipped)

| Package | Version | License |
| --- | --- | --- |
| `wrangler` | 4.149.0 | MIT OR Apache-2.0 |
| `playwright` | 1.59.1 | Apache-2.0 |
| `@modelcontextprotocol/sdk` | 1.32.1 | MIT |

## Design reference

The visual design system follows the public design language of [Next Notes](https://github.com/spyhack225/next-notes), which is itself AGPL-3.0-or-later. No code or assets are copied from it. See `docs/design-system.md`.

## Android build

The kiosk app is built against the Android SDK platform and build tools and a Temurin JDK installed outside this repository by `kiosk/scripts/setup-tools.ps1`. Those tools keep their own licenses and are not redistributed here.
