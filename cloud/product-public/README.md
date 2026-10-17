# DisplayOS

These pages use real product routes. They do not use the pilot credentials or sample family content.

- `/welcome` explains the screen in ordinary language.
- `/home` signs in with a phone or computer, creates a home, adds a screen, waits for physical confirmation and manages assistant permissions.
- `/screen` is the shared day and quiet view. It starts with an expiring QR, not a credential form.
- `/privacy` states the current trial's privacy behavior and release limitations.

The helper panel opens the official ChatGPT Plugins setup and copies a non-secret `/mcp` address. Pilot setup requires creating and installing a personal OAuth plugin before using the invitation. There is no published DisplayOS directory listing or one-click installation link. The agent's cloud browser has a separate session and must not receive the owner's credentials or session cookie. See [assistant setup](../../docs/assistant-setup.md).

The browser loads locally hosted SimpleWebAuthn and QR bundles. Personal content is inserted with `textContent`. No remote fonts, images or scripts are requested. Returning-user browser sign-in failures show persistent neutral guidance for the saved sign-in device without creating another account or resetting a home.

## UI integration points

Identity paths used by `home.js` are `/auth/register/options`, `/auth/register/verify`, `/auth/login/options`, `/auth/login/verify`, `/auth/logout`, `/auth/passkey/options`, `/auth/passkey/verify`, `/auth/recovery/create`, `/auth/recovery/use` and `/auth/account/delete`. Options return the SimpleWebAuthn options object directly. Verification returns `{account:{name},csrf}`.

Connection requests return `{intents:[{id,label,scopes}]}`. Approval duration is seconds. Accepted grants use household `home.get` fields. The renderer loads protected JPEG/PNG bytes from `/device/v1/media/MEDIA_ID`.

Assistant approval defaults to 30 days, with an optional one-day choice. Both show ordinary language, explicit permissions and a dated end time. Settings and photo permissions start unchecked. The service limits access tokens to 15 minutes and supports refresh within the finite consent period. Stop remains available to the home owner.

Browser trials are created through signed-in, recent-authentication POST `/api/v1/demo-screen`. The UI keeps `deviceToken` in the current tab's `sessionStorage` under `displayos-demo-device-token`, then opens `/screen`. A native prepared screen needs no JavaScript credential; its restricted HTTP interceptor authenticates the documented device routes. Browser trials never save family content across page reloads.

Demo-only private P-256 identity is also held in tab session storage under `displayos-demo-device-key`. It recovers a lost reset response through `/device/v1/recover/start` and `/device/v1/recover/verify`, proving possession over the returned challenge before getting the current transport credential. This is not the native production identity model.

Invitation links contain a one-use invitation in the fragment, with the home routing ID. QR links contain only an expiring screen claim code. Neither link contains a transport credential or assistant access token. Account recovery codes appear only after deliberate creation.

The renderer polls around every 30 seconds once owned and every five seconds during pairing, with jitter and exponential error backoff up to five minutes. A hidden owned browser polls once a minute. Interaction, foreground return and reconnection check immediately. A phone's five-second setup checks run only in the foreground and pause after two inactive minutes unless an unexpired pairing or approval is pending. Local expiry checks and the clock still run every second without network requests.

The renderer sends a receipt after two visible animation frames, removes photo blob URLs on expiry/reset/night and never writes family updates to browser storage. Expired family information disappears even when polling fails. Night privacy shows only a clock. Ordinary touchscreen interaction leaves quiet view. Local calendar and clock follow the selected home time zone.

Long maximum-size content remains readable in individually scrollable cards. Overflowing cards show an explicit See all button opening a full-size keyboard-accessible reading sheet. Expiry, night and reset also remove this sheet. Normal sparse content fits the tablet view. Phones use a readable vertical layout rather than shrinking type to fit a display-sized page.

The photo panel loads persistent home metadata with `media.list` and privately retrieves previews through `media.get`. Delete removes selected media from the home and screen snapshots. Choosing Show in quiet view or leaving its visible upload checkbox selected reads `family.current`, adds the photo without replacing unrelated content, and preserves the earlier content expiry. No synthetic calendar or email information is introduced.

`providers.js`, owned by the Sources delegate, exports `DisplayOSSources.mount({ui,home,principal,api,command,tell,run,refresh})`. `home.js` mounts it only for home owners. Google and weather availability are obtained from actual service status. An unconfigured provider is not presented as connected. Weather attribution appears when its weather is used on the day view.

## Verification

The home page keeps screen cards, the helper invitation and home location in the main view. Display settings, photos, people and safety remain closed until chosen. A location can also be saved privately before pairing. Screen names are editable, and the short Screen label matches the physical display. Manual pairing uses one pasteable numeric field with six visual slots. Both legacy and current screen codes show a countdown from the returned expiry and disappear while their replacement is being obtained.

Google local content is a separate memory-only overlay from `/device/v1/local`. The renderer checks consent flags and location revision on ordinary polls. It fetches only an owned, online, visible screen outside quiet hours, refreshing after 55 minutes plus up to one minute of jitter. Show full display explicitly leaves the current quiet-night session after a fresh post-gesture authorized poll. Back to quiet hours clears family and local information without changing the saved schedule. Default quiet hours make no Google calls. Errors clear the overlay, show a retry message and retry after five minutes, doubling to a one-hour maximum. Offline, reset, authorization failure, ordinary night entry, consent changes and expiry remove it. Local data never changes family snapshots, rendering receipts or browser storage. Required Google Maps and weather source text stay beside the corresponding content. Local information and the two owner weather/nearby previews have fixed forty-five-second XHR budgets; other requests retain twelve seconds. Landscape night controls center without depending on newer flex-gap support.

Celsius and Fahrenheit buttons in Around your home use the owner-only unit command, preserving all other screen settings and current family content. Canonical provider and family values remain Celsius. The shared UI formatter converts only visible text, including previews and standby. Unit changes do not fetch new Google results.

The display JavaScript targets Chrome/WebView 61 or newer and includes an ES5 `Promise.finally` fallback. The browser harness removes that method before loading the display and verifies pairing and polling. This is a compatibility probe, not qualification of the tablet's actual firmware or WebView.

Run the asset build and Wrangler's dry-run bundle, then run `scripts/verify-product-ui.mjs` with `PLAYWRIGHT_MODULE` set to a local Playwright install if necessary. The script uses disposable actual workerd state and a Chromium virtual WebAuthn authenticator. It covers sign-in, physical pairing confirmation, assistant approval and stop, MCP publishing, selected media, recovery with a new sign-in, overnight privacy, offline expiry and reset. Screenshots are written to `diagnostics/displayos-product`.

The test bridge preserves multiple Set-Cookie headers and disables fetch's automatic redirects. OAuth intent redirects are read from workerd, their actual authorization cookie is applied to the disposable browser, then the browser opens the returned approval URL. Playwright does not intercept a second network hop in a fulfilled redirect chain to the fake test hostname. Browser fetch metadata is not forwarded through Undici because it would rewrite navigation mode. Real origin and OAuth navigation rules remain enforced by the service and its separate protocol tests.
