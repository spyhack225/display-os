# Demo handoff and verification

> Post-rename status (2026-10-17): the demo source and this record were updated to the DisplayOS workspace name and private runtime path. On the renamed tree, `node --test test/*.test.js` passed 25/25 and `scripts/smoke.js` passed 47 real HTTP checks. The historical evidence below is unchanged apart from name and path updates.

Verified on 2026-10-09 with `C:\Program Files\nodejs\node.exe`, version 24.14.0.

## Running service

- PID at handoff: `38140`.
- Verified listener: `127.0.0.1:8765`, owned by that PID. No LAN listener or firewall change.
- `GET /api/health` returned 200 and `{"service":"local-display-demo","version":1,"syntheticOnly":true}`.
- `/display`, `/setup`, `/agent`, `/skill.md`, and `/api-contract.json` are available. Agent instructions returned HTTP 200 and the contract returned version 1, with QR explicitly unimplemented.
- Safe diagnostic logs: `E:\GitHub\displayos\demo\.runtime\server.stdout.log` and `server.stderr.log`. Error log was empty at verification. These files contain no reusable credentials.
- Owner credential: `%LOCALAPPDATA%\DisplayOS\owner-credential.txt`. The default Windows runtime is `%LOCALAPPDATA%\DisplayOS`. Do not print the credential.
- Actual directory ACL: only the current Windows user has inheritable FullControl. Credential file inherits only that user's FullControl. Native `icacls` and independent Windows ACL verification passed. No secret was stored or migrated from the exFAT source tree.

The existing service was not replaced. The local port was checked before launch, and server startup also refuses `EADDRINUSE` without touching the existing listener.

## Exact commands and results

Run from `E:\GitHub\displayos\demo`:

```powershell
& 'C:\Program Files\nodejs\node.exe' --test test/*.test.js
& 'C:\Program Files\nodejs\node.exe' scripts/smoke.js
& 'C:\Program Files\nodejs\node.exe' --check server.js
& 'C:\Program Files\nodejs\node.exe' --check model.js
& 'C:\Program Files\nodejs\node.exe' --check runtime.js
& 'C:\Program Files\nodejs\node.exe' --check public/app.js
& 'C:\Program Files\nodejs\node.exe' --check scripts/agent-client.js
```

- Native tests: **25 passed, 0 failed, 0 skipped**.
- Smoke verification: **47 real HTTP status checks passed**, with additional content and state assertions.
- All five syntax checks passed.
- The native suite includes a separate Node process running the real Codex client. It waits for an isolated test owner approval, publishes through HTTP, and observes rendered status after the synthetic transport client ACK. It prints no owner, device, request, or grant secret.
- Windows boundary tests prove that source-volume exFAT cannot hold private runtime credentials, that unsupported ACLs gate secret use, and that the real NTFS default runtime passes current-user-only verification.
- Tests use disposable servers on free loopback ports. They do not automatically claim or approve a display on PID 38140.

Launch used:

```powershell
Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList 'server.js' -WorkingDirectory 'E:\GitHub\displayos\demo' -WindowStyle Hidden -RedirectStandardOutput 'E:\GitHub\displayos\demo\.runtime\server.stdout.log' -RedirectStandardError 'E:\GitHub\displayos\demo\.runtime\server.stderr.log' -PassThru
```

An earlier combined process-management command was rejected before execution. The isolated hidden launch above succeeded. `npm test` initially failed because cmd.exe could not resolve node under the inherited PATH. No machine PATH was changed. Package scripts are not claimed to work here without environment repair. Use the explicit Node executable.

## Exact source file changes

All 20 source and documentation files are new under the owned demo tree:

- `.gitignore`
- `package.json`
- `DESIGN.md`
- `README.md`
- `VERIFICATION.md`
- `model.js`
- `server.js`
- `runtime.js`
- `public/display.html`
- `public/setup.html`
- `public/agent.html`
- `public/app.js`
- `public/style.css`
- `public/skill.md`
- `public/api-contract.json`
- `scripts/agent-client.js`
- `scripts/http-check.js`
- `scripts/smoke.js`
- `test/http.test.js`
- `test/runtime.test.js`

Generated artifacts are the two ignored source-tree log files and the explicitly authorized current-user-protected Windows runtime directory and credential file. Temporary test directories were removed. Parent-owned docs, scripts, `.audit`, firmware, adb, firewall, and Git branches or commits were untouched.

## Proof limits

The native test and smoke ACKs are simulated HTTP transport clients. No actual browser painting or tablet result is claimed by this sidecar. The parent is performing separate Chrome verification against the running service. A render receipt means a client reported rendering, not tamper-resistant pixel attestation. Older-browser compatibility remains a target, not a verified result.

The parent subsequently completed visible Chrome verification on 2026-10-09. A UI-created disposable desktop display was claimed by an explicitly automated QA owner. A separate Node CLI process requested access, the QA owner separately approved it, and revision 1 progressed through accepted, downloaded, and rendered. The browser's visible text confirmed the card and its ACK. The QA grant was revoked and QA owner logged out afterward. This is not customer onboarding or Samsung testing. Evidence is in `../diagnostics/desktop-demo-qa.log` and `../diagnostics/desktop-demo.png`. The full-page screenshot attempt timed out; a viewport screenshot succeeded.

The parent's final repeat of the native tests passed 25 of 25 with no skips. The 47 HTTP smoke checks also passed. Output is retained in `../diagnostics/demo-tests-final.log` and `../diagnostics/demo-smoke-final.log`.

Independent review found two cleanup failure paths in the parent's QA helper. Both were fixed and re-reviewed with six isolated simulated probes. The parent also verified a rejected claim logs out, then repeated the successful external-process publish and visible browser receipt. See `../.audit/review.md` and `../diagnostics/desktop-demo-cleanup-qa.log`. The latest demo screenshot is `../diagnostics/desktop-demo-cleanup.png`.

QR is not implemented. Manual code and pairing session work. There is no production OAuth, verified AI provider identity, universal connector, TLS, account registration, ownership transfer, durable device state, or firmware support. The served skill and contract describe only this real local API. The README records a future adb reverse route without executing it or claiming Samsung recovery, USB debugging, or tablet setup success.
