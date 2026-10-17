# Cloudflare service and tablet startup

## Status

- Implemented the authenticated single-owner synthetic pilot under `cloud/`. Encrypted Durable Object state survives runtime reloads.
- Verified 22 cloud unit tests, 28 local workerd checks, 53 local browser checks, the deployment bundle and 56 live HTTPS checks. The previous local-demo pass verified 25 existing demo tests. Runtime and browser tests use disposable synthetic owner and device actions, not real owner approval or tablet proof.
- Deployed to your `workers.dev` hostname (`/display` on your deployment) in your Cloudflare account. Live checks verify HTTPS, asset boundaries, origin rejection and owner login/logout. Actual display claim, agent approval, content receipt and physical tablet rendering remain to be verified live.
- DisplayOS now has glass-style controls, a sample home, manual Quiet view and plain-language setup. Installer credentials are separate at `/operator`. Customer sign-in and provisioning remain incomplete. See [the experience record](displayos-experience.md).
- No Android app, kiosk installation, firmware, factory reset, QR or personal provider integration has been installed or implemented.

## Service choice

| Design considered | Benefit | Requirement or limitation |
| --- | --- | --- |
| Worker with Cloudflare Access owner identity | Managed identity and policies | Needs the right Access team, policy and audience; customer identity still needs a separate design |
| Worker with a strong private pilot owner credential | Proves HTTPS, separate claim/approval and persistent delivery without assuming an identity tenant | One owner only; no customer registration or recovery |

Use the second for the synthetic pilot. Reuse the original text-card model through a separate Worker adapter. Do not weaken the loopback server or publicly tunnel its HTTP transport. Worker static assets and the API share one deployment.

The installer prepares owner access on a phone or laptop and enrollment in the screen browser at `/operator`. Family pages never ask for those credentials. Setup uses one short-lived screen code and a separate assistant approval. No credential travels in a hostname or QR URL. Customer identity and verified factory enrollment must replace these operator bootstrap steps before sales.

Start with the account's `workers.dev` hostname, then add a branded domain when chosen. Accept one exact HTTPS origin at a time. A domain migration requires reconfiguration and a client migration, not an allow-all Origin rule. See [deployment instructions](../cloud/README.md).

## App or webpage?

The dashboard is a web page and does not need a native rewrite. A browser is enough for rendering and agent-update demos.

A page cannot configure Android's launcher, guarantee startup after boot, enforce lock task, recover from a killed browser or own a native credential. Browser fullscreen normally needs user interaction. A shortcut or installed PWA is not proof of startup after reboot. [Fullscreen requirements](https://developer.mozilla.org/en-US/docs/Web/API/Element/requestFullscreen).

For the first demo, open the page manually. For quick hands-off tests, evaluate a maintained kiosk browser on the actual Android version. Check license, compatibility, startup and exit recovery before installation. No third-party package has been chosen or installed.

For customer devices, use a small branded Android kiosk shell that loads the same dashboard. The shell owns boot and device behavior; the website owns layout, standby and content. Website changes need no Android reflash or APK update. Native and OS security updates still need their own process.

Android dedicated devices can use a managed Home app and lock task. A device policy controller can make the kiosk the preferred Home app for launcher startup. Strong lockdown requires supported managed provisioning, not hidden browser chrome. This Samsung's managed provisioning and startup remain untested. [Android startup](https://developer.android.com/work/dpc/dedicated-devices/cookbook), [lock task](https://developer.android.com/work/dpc/dedicated-devices/lock-task-mode).

## Kiosk requirements

- Load only the configured HTTPS display origin. Block owner setup, arbitrary navigation, downloads and unapproved external app launches.
- Never ignore TLS errors, enable mixed content or give web content a general native bridge or shell access.
- Store only a rotatable display credential in app-private, platform-protected storage. Keep owner and provider secrets off the tablet. Current tab session storage does not meet this requirement.
- Become the chosen Home app through explicit provisioning. Keep owner-only exit and recovery, including Wi-Fi repair and deprovisioning. Do not lock the owner out of an unreliable tablet.
- Recover from network loss and show stale/offline status. Any cache needs approved fields and expiry. Private expired content must disappear.
- Keep the screen on while plugged in, with tested brightness and night mode. Ambient standby is an app view, not Android sleep. Charger connection does not guarantee automatic boot from power-off.
- Test restart, cold boot after unlock, network loss, process death, lost state, credential rotation, orientation and night mode on hardware.

## Next checkpoints

1. Complete the live owner walkthrough: enroll and deliberately claim the intended display, separately approve an agent, publish synthetic content, observe its receipt and revoke the grant. Cloud deployment, HTTPS and access-control checks have passed.
2. Test the stable, charged Samsung against the live page using synthetic information.
3. Prove startup and fullscreen through a selected kiosk browser or small shell. Serving a webpage does not require firmware work.
4. Build family dashboard and standby views with validated data and one supported agent connector.
5. Pass customer security, privacy, maintained-hardware and recovery gates before personal accounts or sales.
