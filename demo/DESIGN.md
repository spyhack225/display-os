# Local display demo design

| Choice | What it proves | What it cannot prove |
| --- | --- | --- |
| Offline static simulation | Layout, sample content, and a clickable setup walkthrough with no service | Remote publishing, authorization boundaries, transport, or server-observed rendering |
| One Node HTTP process | Device polling, deliberate owner claim, separate scoped agent approval, authenticated publishing, and client render receipts | Secure hardware enrollment, production identity, OAuth, or physical tablet compatibility |

Use the real HTTP process. A static simulation would hide the exact delivery and authorization behavior this demo needs to exercise. Keep the renderer small and original. Copy no upstream code or assets.

## Boundaries

- Listen on `127.0.0.1:8765` by default. LAN HTTP requires an explicit unsafe-mode opt-in and exact public origin. No firewall changes or public deployment.
- Generate a service-local owner credential in a verified private runtime file. Windows defaults to `%LOCALAPPDATA%\DisplayOS`, away from the exFAT source tree. Owner login creates an HttpOnly, SameSite=Strict session cookie and a separate CSRF token. Never print credentials in logs.
- A browser enrollment creates a unique display, transport credential, and expiring pairing session. The owner enters the display's code and deliberately claims it. Claiming grants no agent permission.
- An agent requests an exact device and scopes. Only its owner can approve it. The request credential cannot publish. An approved grant expires and the owner can revoke it.
- Publish bounded plain-text cards, using an expected revision and idempotency key. Do not accept HTML, scripts, remote images, shell commands, or arbitrary tools.
- Polling marks a revision downloaded. The client updates text nodes, waits two animation frames, then explicitly acknowledges a delivery nonce. Acceptance is not rendering. A receipt remains client-reported evidence, not proof of physical pixels or an honest device.

## Deliberate demo shortcuts

Use native Node modules and in-memory state. Restarting clears displays, pairing sessions, grants, and content. Device and agent secrets live in browser session storage rather than a native keystore. The local agent page is a synthetic API client, not an AI connector. HTTP exposes credentials on a LAN. Use synthetic content only. No account registration, firmware actions, physical-device access, or production claims.

Use manual pairing codes. Omit QR rather than add an unreviewed dependency. Render ES5 browser JavaScript with XMLHttpRequest, basic flexbox, and system fonts. Older-browser compatibility is a design target, not a tested tablet result.
