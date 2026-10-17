# Original local display demo

An original Node HTTP service and vanilla-JavaScript display. No upstream code, images, fonts, or dependencies were copied. It demonstrates owner claim, separate agent approval, device-bound publishing, polling, and explicit render receipts. It performs no physical-device or firmware work.

Read [the architecture comparison](DESIGN.md). The static simulation option was rejected because it cannot prove the remote delivery loop.

## Current local boundary

This workspace's E: source volume is exFAT. Windows `icacls` reports that no permissions are set and all users have full control, even after an attempted current-user-only grant. File mode 0600 is not Windows privacy. Windows credentials therefore default to `%LOCALAPPDATA%\DisplayOS` on the owner's C: NTFS volume, not to the source tree. Set `DEMO_RUNTIME_DIR` only to an absolute dedicated runtime directory whose actual ACL verification passes. A drive root is forbidden. Selecting exFAT still refuses before reading or generating credentials or listening. No old E: secret is read or migrated.

The real HTTP smoke server and tests use disposable credentials held only in memory. They do not silently disable the normal service's runtime gate. No running demo server is implied by passing those tests.

On Windows volumes that support ACLs, startup invokes `icacls` without a visible window, removes inherited access on the runtime directory, and grants full access only to the current user SID. It then independently verifies the root and every existing regular file through the Windows ACL API. Unexpected principals, directories, links, or an unverifiable ACL gate startup. Explicit broad access is not silently accepted. New files inherit the protected directory's ACL. Server and persistent CLI use the same real directory. Local administrators can still take ownership, and processes under the same user are trusted. POSIX systems use directory mode 0700 and file mode 0600.

## Start and use

Requires Node 20 or newer. Verified here with Node 24.14.0. No install step or build is needed. From a location whose runtime boundary passes:

```powershell
Set-Location E:\GitHub\displayos\demo
& 'C:\Program Files\nodejs\node.exe' server.js
```

Default origin is `http://127.0.0.1:8765`. Use that exact host, not `localhost`, because Host and Origin checks are deliberate. If the port is occupied, leave that service alone. Choose another `PORT` instead. No firewall change is needed.

1. Open `/display`. Choose Create display session. This creates a unique browser transport identity, not ownership.
2. Open `/setup`. Privately open `%LOCALAPPDATA%\DisplayOS\owner-credential.txt` on the Windows server computer and enter it in the password field. The service logs the actual path if overridden. Other systems use `.runtime/owner-credential.txt`. Never paste the credential into chat or logs. Login alone claims nothing.
3. Copy the pairing code and pairing session from the display, then choose Claim deliberately. The code lasts two minutes, is single-use, and binds to that display and session. An expired code can be regenerated on the display. Claiming grants no agent access.
4. Request an agent grant through `/agent` or the CLI below. Review the pending request in `/setup`, including the device ID, scopes, self-reported label, and lifetime. Approve separately.
5. Publish a synthetic card. Keep the display visible. Owner setup reports accepted, downloaded, and rendered separately. The client sends an ACK only after updating text nodes and waiting two visible animation frames.
6. Revoke the grant in `/setup`. Future agent reads and writes fail. Accepted content remains until expiration or server restart.

QR pairing is **not implemented**. Both the manual code and session are required. There is no fake QR button or QR library.

## Local Codex HTTP tool flow

This is an actual HTTP client in a separate Node process. Codex can invoke it with its local execution tool after the human owner claims the display:

```powershell
& 'C:\Program Files\nodejs\node.exe' scripts/agent-client.js run DISPLAY_ID
```

It holds secrets in memory, prints no reusable credentials, waits for human approval at `/setup`, publishes one synthetic card with approved read/write scopes, and watches revision status until a client ACK arrives. It exits with an error if owner approval expires, authority is revoked, or no render receipt arrives within 60 seconds after publishing. Keep the command running while the owner reviews the request. The browser agent page is a separate synthetic test driver. Neither is OAuth, a provider connector, or universal agent support.

On a verified private runtime filesystem, a staged CLI flow also works:

```powershell
node scripts/agent-client.js request DISPLAY_ID
# Human owner approves the pending request at /setup.
node scripts/agent-client.js check
node scripts/agent-client.js publish
node scripts/agent-client.js status
```

This staged flow stores its secrets in `agent-client.json` in the same protected runtime directory as the server and gates access if runtime privacy fails. One stored CLI session is supported. It persists an idempotency key before sending a publish, so retrying a lost response does not create a second revision. Start a new request if that saved publish conflicts with a later revision.

Served agent instructions are at `/skill.md`. The JSON contract is at `/api-contract.json`. Both describe only real routes. Agent POSTs require JSON and `X-Demo-Request: 1`; authenticated operations require role-specific bearer tokens; publishing additionally requires an idempotency key and expected revision.

## Verification

```powershell
& 'C:\Program Files\nodejs\node.exe' --test test/*.test.js
& 'C:\Program Files\nodejs\node.exe' scripts/smoke.js
```

On other systems, replace the explicit Windows executable with `node`. Equivalent package scripts are `npm start`, `npm test`, and `npm run smoke`, but they do not work in this environment unchanged. This shell has an oversized inherited PATH, so its first npm attempt could not resolve node under cmd.exe. Direct Node commands avoid that unrelated shell issue. Do not change the machine PATH to run this project. Use the explicit executable for the staged CLI commands too if `node` resolution fails.

The smoke test starts its own disposable loopback HTTP server on a free ephemeral port. It does not claim displays or approve agents on a running owner's service. It exercises claim, wrong authority, pairing session binding, claim replay, separate approval, approval replay, wrong-device grants, authenticated publishing, idempotency, download status, explicit synthetic ACK, stale ACK, content expiration, pairing expiration, grant expiration, and revocation. The native test suite also checks payload limits, forbidden content and scopes, owner boundaries, cookie/CSRF/Origin/Host protection, runtime ACL enforcement or refusal, and a separate-process Codex client.

The smoke ACK is synthetic. It proves server handling, not browser paint. The display's own code waits for animation frames and visible document state; actual browser verification is a separate gate. No physical Samsung or older WebView test has run.

## Future Samsung route, not tested

Only after the parent has completed recovery, Android has booted, the owner has deliberately enabled USB debugging, and the debugging authorization prompt has been accepted, the parent can use its staged adb:

```powershell
& 'E:\GitHub\displayos\tools\platform-tools\adb.exe' reverse tcp:8765 tcp:8765
```

Then manually open `http://127.0.0.1:8765/display` in the tablet browser. This keeps the service loopback-only. Download Mode cannot run this browser flow. Reverse setup, USB debugging, tablet rendering, boot behavior, and the browser version remain untested. No adb command was run by this demo task. The parent owns root docs, scripts, `.audit`, recovery, and firmware decisions.

## Optional trusted LAN mode

Prefer loopback and a future adb reverse route. LAN mode is HTTP, exposes every credential on the network, and is suitable only for isolated trusted-network synthetic demonstrations. Never expose it publicly, forward a router port, register real accounts, or open the firewall for this task.

```powershell
$env:HOST = '0.0.0.0'
$env:ALLOW_INSECURE_LAN = '1'
$env:DEMO_ORIGIN = 'http://192.168.1.50:8765'
node server.js
```

Use the computer's actual LAN address in `DEMO_ORIGIN`. The service checks that exact host and origin. This does not add TLS, make obsolete Android secure, or fix an unsupported filesystem. Clear the environment overrides before returning to loopback. The supplied CLI intentionally supports loopback only.

## Exact caveats

- One service-local owner, not owner accounts, production identity, or OAuth. Agent labels and browser enrollment are unverified. Possession of a screenshot containing both pairing values can claim the display before the owner does.
- Sessions, devices, pairing, grants, content, and receipts are in memory. A restart clears them. The generated owner credential survives only normal, ACL-protected file startup. There is no ownership transfer, factory enrollment, hardware key, refresh token, or production audit trail.
- Display and browser agent tokens use tab-local session storage, not a native protected keystore. A browser page refresh redraws content and can re-ACK it without changing the original server timestamp. Offline content expires locally; there is no durable offline cache.
- The renderer targets ES5, XMLHttpRequest, flexbox, and system fonts. No browser-version or tablet compatibility claim. A browser without requestAnimationFrame renders text but refuses to attest rendering. Hidden tabs wait to ACK.
- A render receipt is a client statement. A forged client with its transport credential could lie. It is not proof of pixels, user attention, or a tamper-resistant display.
- Plain-text cards only, 1 to 4 cards, titles up to 80 characters, text up to 600, and an 8192-byte request cap. No HTML, scripts, remote assets, shell tools, settings control, or private integrations.
- Local rate and state limits reduce mistakes; they are not production abuse protection. Expired in-memory records still count toward demo limits until restart.
- QR, maintained firmware, TLS, production signing, account recovery, connector compatibility, and physical-device validation remain follow-up work.
