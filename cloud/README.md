# DisplayOS Cloudflare service

The Worker serves the family website, authenticated service and OAuth/MCP connector. New encrypted registry and household actors provide customer sign-in, unique screen ownership, structured updates, photos, sources and recovery. The tablet makes outbound HTTPS requests. After deployment, no laptop server, VPN or inbound tablet port is needed.

Customer pages are `/home` and `/screen`, also available as `/setup` and `/display`. See [the implementation ledger](../docs/full-implementation.md), [product contract](../docs/product-contract.md) and [operation guide](../docs/product-operations.md). `scripts/deploy-product.mjs` runs release gates and preserves the existing pilot. Personal provider credentials and consent, physical unit testing and commercial qualification remain separate gates.

## Retained pilot history

The following setup applies only to the original single-owner synthetic pilot at `/pilot/setup`, `/pilot/display` and `/pilot/skill.md`. It is not the customer setup. Its encrypted object and key remain unchanged.

The retained pilot is deployed in your Cloudflare account at the pilot display (`/pilot/display` on your deployment), with pilot setup (`/pilot/setup` on your deployment) and pilot agent instructions (`/pilot/skill.md` on your deployment).

Checks pass: 22 cloud unit tests, 28 local workerd checks, 53 local browser checks and 56 live HTTPS checks. Live verification covers asset boundaries, origin and credential rejection, owner login, protected state, CSRF and logout. It does not enroll or claim a display, approve an agent, acknowledge content or prove physical tablet rendering. Browser verification exercises those software actions only in disposable local state. Complete the live owner walkthrough below with synthetic content.

In that historical pilot, family pages used manual screen codes and ordinary assistant language. Installer credentials were isolated at `/operator`, but real customer sign-in, QR and factory provisioning were missing. Those features now exist in the separate product implementation; see [the experience record](../docs/displayos-experience.md).

## Verify

From `E:\GitHub\displayos\cloud`:

```powershell
& 'C:\Program Files\nodejs\node.exe' scripts\run-tool.mjs npm ci --ignore-scripts --no-fund --no-audit
& 'C:\Program Files\nodejs\node.exe' --test test\*.test.js
& 'C:\Program Files\nodejs\node.exe' scripts\build-assets.mjs
& 'C:\Program Files\nodejs\node.exe' scripts\run-tool.mjs wrangler deploy --dry-run --outdir .wrangler\bundle
& 'C:\Program Files\nodejs\node.exe' scripts\verify-runtime.mjs
```

The helper supplies the local Node directory to child tools without changing system PATH. This computer's npm lifecycle scripts still could not find Node. Installation used `--ignore-scripts`; installed platform binaries were then verified through Wrangler bundling and local workerd tests. Skipping an install script is not proof of runtime correctness.

After deployment, run `node scripts/verify-live.mjs` to repeat the HTTPS checks. It reads credentials only from the verified private runtime, briefly signs the owner in, reads protected state and signs out. It makes no enrollment, claim, approval or content mutation. Do not run it against an unrelated account or deployment.

For browser verification, install or provide Playwright and run `node scripts/verify-ui.mjs` after building assets and the dry-run bundle. `PLAYWRIGHT_MODULE` can point to an existing Playwright module entrypoint. Without it, the helper imports the `playwright` dev dependency installed by `npm install`. The helper runs a real local Worker with generated disposable test credentials, never the live owner. Screenshots go to ignored `diagnostics/displayos-ui/`.

## Deploy

1. Run `node scripts/run-tool.mjs wrangler whoami`. If unauthenticated, run `node scripts/run-tool.mjs wrangler login` and complete Cloudflare authorization yourself. Never use a temporary account or paste an API token into chat.
2. Confirm the account pinned in `wrangler.json` is the intended account. Copy `wrangler.example.json` to `wrangler.json` and set your own account id and origin; `wrangler.json` stays out of version control. When changing accounts, update the configuration deliberately; do not let the script guess.
3. Run the verification commands above.
4. Run `node scripts/deploy-pilot.mjs`. Replace `node` with `& 'C:\Program Files\nodejs\node.exe'` when Node is not on PATH.

The script generates separate owner, enrollment and encryption secrets in a verified private runtime. Windows defaults to `%LOCALAPPDATA%\DisplayOS\cloud-pilot-secrets.json`. It refuses an insecure runtime, including the exFAT source volume. Existing credentials are reused, not rotated silently.

During initial bootstrap, the Worker returns 503 while configuration is incomplete. The script reads the account's `workers.dev` hostname, uploads secrets through Wrangler, then redeploys with that exact HTTPS origin. The verified account and live origin are now pinned in `wrangler.json`, so later uploads do not restore the placeholder origin. No Origin bypass, LAN HTTP or paid-plan upgrade is automatic. It stops on authentication, account, upload or health errors. Health checks retry transient propagation or network failures within a bounded budget and reject an unexpected service.

The public URL is recorded in protected `cloud-pilot-deployment.json` only after live HTTPS health passes. Initial deployment uploaded the Worker and all three secrets successfully, but its immediate health check failed during propagation. After adding bounded health retries, `verify-live.mjs` passed all 52 checks and wrote the deployment record. The deployment script itself was not rerun after that helper change. Health alone does not prove claiming, agent approval or physical tablet rendering.

## Owner walkthrough

1. Installer step on the laptop or phone: open `/operator`, privately read `OWNER_CREDENTIAL` from the protected runtime file and choose Prepare owner access. It opens family setup with the authenticated one-hour session. Never put this credential on the tablet or give it to an agent.
2. Installer step in the screen browser: open `/operator`, use only `ENROLLMENT_CODE` and choose Prepare this screen. It clears the field and opens `/display`. Keep the prepared tab open. This is manual pilot preparation, not completed factory provisioning.
3. On the phone or laptop, enter the intended screen's single-use 12-character code in `/setup` and deliberately choose This is my screen. The pairing session is no longer a separate family input. No agent is approved by this action.
4. Choose Copy invitation for an agent with an HTTP tool, or Try a sample assistant to open `/agent` with the public display ID filled internally. No transport credential goes in that link.
5. Review the request's exact screen name, operations and lifetime, then separately choose Yes, let it help. Assistant names are supplied by the requester, not verified identities.
6. Send a synthetic note with the screen visible. Observe accepted, downloaded and rendered through the API. Family labels report progress in ordinary language. Confirmation is a client receipt, not independent proof of tablet pixels. The first delivered note also appears in Quiet view.
7. Open Who can update my screen?, choose Stop updates and confirm future reads and writes fail. Sign out and confirm owner state is denied.

Cloud state survives restarts. The browser still uses tab session storage; closing the display tab can lose its credential. Persistent boot identity belongs to the later kiosk client. Never put a transport token in a startup URL.

## Boundaries

- Owner sessions use Secure, HttpOnly, SameSite=Strict `__Host-desk_owner`, Path=/, no Domain, and one-hour server expiry. Changes require exact Origin, a custom header and session CSRF. Owner-secret rotation invalidates existing sessions.
- Display, request and agent credentials are distinct. Grants bind to one display, expire and can be revoked. Client labels do not verify agent identities.
- The Worker reads at most 8192 body bytes within five seconds before entering the serialized Durable Object. Slow input does not hold the pilot mutation lock.
- Owner recovery, display transport, approved agents and pending requests have separate rate buckets. Anonymous admission is capped at 64 client buckets and 300 API requests per minute. Valid display and agent traffic uses a bounded per-display budget, not the anonymous pool. Unapproved request polling cannot consume an approved agent's budget. Login and request throttles also apply. Each display can have five pending requests. Unchanged rejections do not rewrite state. Production still needs edge abuse controls, per-household quotas and billing alerts.
- AES-GCM uses a fresh nonce per snapshot. Missing or wrong keys, tampering and unsupported versions fail closed. State commits before success. Failed writes restore prior in-memory state and return an error.
- Growth stops at 60000 UTF-8 snapshot bytes, leaving a recovery budget. Hard state cap is 80000 bytes. These are chosen pilot limits, not claimed Cloudflare limits. There are at most 32 displays, 128 requests before cleanup and 100 revisions per display. Requests and terminal grants expire. Revision history and idempotency records remain bounded and retained. No silent reset on capacity.
- CSP permits only local scripts, styles and API calls. Images, camera, microphone and geolocation are disabled. No provider secrets, markup, remote code, shell or firmware commands are accepted.
- Preview URLs are disabled. Alternate hostnames fail exact-origin checks. Worker-first routing protects assets. Worker request logging is disabled in this configuration.

Keep the encryption key in the owner's protected file. Losing or blindly rotating it makes existing state unreadable. Rotation requires a reviewed decrypt-and-reencrypt migration. Removing the Worker or Durable Object is not a normal update.

## Customer release gates

Before household private data or sales, add customer identity and recovery, per-household storage, verified enrollment, device credential rotation and revocation, approved media, provider consent, deletion/retention procedures and edge quotas. Test maintained hardware, TLS, browser updates, kiosk escape, Wi-Fi repair and cold boot. Android 8.1 remains a synthetic demo target.

See [the kiosk decision](../docs/cloudflare-and-kiosk.md), [agent instructions](public/skill.md), [Cloudflare asset routing](https://developers.cloudflare.com/workers/static-assets/binding/), [Durable Object storage](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/) and [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/).
