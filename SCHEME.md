# Agent-controlled display rollout plan

Status, 2026-10-10: Release `3f5e0dd8-da07-47c6-be0d-a21ee6ab7767` fixes detailed-photo uploads in Favorite faces and adds persistent progress, specific retry guidance and same-file retry. Passed: 330 unit, 393 protocol, 1130 provider-race, 275 browser and 811 live HTTPS checks, plus 16 separate live photo checks with a deleted disposable QA home and account. JPEG, PNG and WebP browser selections reach sanitized storage and survive reload. The existing home, tablet enrollment and PIN remain unchanged. Personal assistant publication and physical-tablet photo interaction remain acceptance checks. Historical releases and remaining physical/commercial gates stay in [the implementation ledger](docs/full-implementation.md).

## Current implementation

The customer surfaces are `/home` and `/screen`, with `/setup` and `/display` pointing to them. The prior pilot remains separately accessible under `/pilot/setup` and `/pilot/display`; its stored state and credentials are preserved. Families no longer use its operator keys.

| Roadmap area | Software delivered | Remaining acceptance |
| --- | --- | --- |
| Identity and ownership | Reviewed WebAuthn passkeys, challenge cookies, one-use recovery, isolated homes, adult invitations and per-unit QR plus physical confirmation; owner reported actual phone sign-in, pairing and resolution of the empty-screen loop | Remaining personal assistant flow |
| Family updates | Bounded typed layout, revision conflicts, idempotent retries, delivery/render receipts, expiry alarms and current-content reads | Qualified tablet pixels, power stability and old WebView compatibility |
| Photos and quiet view | Normalized private JPEG/PNG, owner catalogue, selected photo sharing, idle view, approved daytime local information, public date/calendar nights and offline expiry | Physical display readability and interruption trial |
| Assistants | Protected-resource discovery, S256 PKCE, separate scoped consent, refresh rotation, revocation and eight MCP tools | The owner's chosen assistant host must support and approve the connector; no universal compatibility claim |
| Sources | Selected Google calendars and inbox subject metadata software, separate shared-screen consent, connected Google location/weather/nearby services and consumer source controls | Calendar/inbox OAuth credentials, personal consent and commercial provider terms |
| Kiosk and preparation | Independent Home/WebView APK installed and selected as Home on the Samsung; native Keystore identity, encrypted cache, limited HTTPS transport, Wi-Fi repair, owner PIN and unique preparation scripts | Ten cold boots, a 72-hour trial and maintained production hardware |
| Privacy and recovery | Scoped stop, member removal, export including approved photos, resumable home/account deletion, reset fencing and same-key device recovery | Independent commercial privacy review, retention agreement and support operations |
| Commercial rollout | Source and release tooling, configuration guides, test evidence and explicit gates | Maintained hardware/firmware, production signing custody, rights, domain/name checks and sale approval |

Implementation details are in [the shared product contract](docs/product-contract.md), [provider setup](docs/provider-setup.md) and `kiosk/`. The dated design and original acceptance criteria below remain the rollout record, not a claim that hardware or provider consent has been completed by code.

Historical baseline, 2026-10-09: the [Cloudflare pilot](cloud/README.md) provided one synthetic-demo owner, 22 cloud unit tests, 28 local workerd checks, 53 local browser checks and 56 live HTTPS checks. Its initial sample layout and manual Quiet view were not customer identity or native provisioning. The implementation above replaces that customer path while preserving the pilot. [The experience record](docs/displayos-experience.md) and [kiosk plan](docs/cloudflare-and-kiosk.md) retain the earlier decisions.

Prepared on 2026-10-09. DisplayOS is the product name; availability has not been checked. The branded domain and first supported personal assistant are not selected.

## Product goal

Sell a branded display that a customer connects to their personal AI agent. The agent handles configuration and content updates. The customer connects Wi-Fi, proves ownership, and approves access.

Remote control means updating approved display content and settings. It does not mean remote Android administration, arbitrary code execution, or control of appliances.

The BIUFRAME work in `wesbos/photo-frame-dashboard` is the technical research baseline. The owner identifies the purchased display as the same device. Confirm the board and firmware on the actual sample before applying device-specific changes.

## Family dashboard design input

The family-screen experience was first sketched as a Raspberry Pi and TV dashboard. The tablet replaced that display arrangement, not the credential boundary or the need for a backend. The current layout is documented in [the design system](docs/design-system.md).


Establish stable Android and browser operation before considering new firmware. Keep provider credentials off the tablet and use synthetic data for the initial physical demonstration.

The glass-inspired family layout and quiet view are implemented in `cloud/product-public/`. Glass belongs primarily to controls; family content remains readable on stable surfaces. Current protocol and test evidence live in the implementation ledger.

## Verified upstream baseline

Reviewed revision: [`adcbc38411ae0e653fbcdd078076eadaadacb313`](https://github.com/wesbos/photo-frame-dashboard/tree/adcbc38411ae0e653fbcdd078076eadaadacb313).

These are upstream observations, not measurements of our sample.

| Area | Evidence | Product implication |
| --- | --- | --- |
| Device | BIUFRAME, USB name `Synergy 10X1`, Rockchip RK3126, Android 6.0.1 | Start with this hardware profile, not the Samsung or Skylight procedures. |
| USB access | ADB and shipped root are documented | Factory preparation may not require replacing Android. |
| Dashboard | A Vite web application with mock data | Treat the design as a prototype, not a working customer backend. |
| Kiosk | A full-screen WebView app | Use the behavior as a reference for the branded display client. |
| Compatibility | JavaScript target `chrome106`, CSS target `chrome61` | Test rendering on the physical device, not just a desktop browser. |
| Setup automation | A Mac-oriented setup script | Prepare a reviewed Windows workflow before running it from this workspace. |

Sources: [upstream README](https://github.com/wesbos/photo-frame-dashboard/blob/adcbc38411ae0e653fbcdd078076eadaadacb313/README.md), [hardware observations](https://github.com/wesbos/photo-frame-dashboard/blob/adcbc38411ae0e653fbcdd078076eadaadacb313/docs/biuframe.md), and [build configuration](https://github.com/wesbos/photo-frame-dashboard/blob/adcbc38411ae0e653fbcdd078076eadaadacb313/dashboard/vite.config.js).

The upstream agents screen is a mock usage display, not an agent integration. See [agents view](https://github.com/wesbos/photo-frame-dashboard/blob/adcbc38411ae0e653fbcdd078076eadaadacb313/dashboard/js/views/agents.js) and [mock data](https://github.com/wesbos/photo-frame-dashboard/blob/adcbc38411ae0e653fbcdd078076eadaadacb313/dashboard/js/data.js).

The kiosk accepts launch URLs and keeps navigation in its WebView. Its manifest allows cleartext traffic. Its build script signs with a debug key. None of these is a production security design. The inspected manifest has no boot receiver or HOME category, so reliable startup remains work to implement and verify.

Sources: [kiosk activity](https://github.com/wesbos/photo-frame-dashboard/blob/adcbc38411ae0e653fbcdd078076eadaadacb313/dashboard/kiosk/src/com/wesbos/homehq/MainActivity.java), [manifest](https://github.com/wesbos/photo-frame-dashboard/blob/adcbc38411ae0e653fbcdd078076eadaadacb313/dashboard/kiosk/AndroidManifest.xml), and [APK build](https://github.com/wesbos/photo-frame-dashboard/blob/adcbc38411ae0e653fbcdd078076eadaadacb313/dashboard/kiosk/build.sh).

## Release blockers

### Security on the existing firmware

The upstream guide reports unrestricted root, permissive SELinux, a July 2016 security patch, and browser components without further Android 6 updates. It explicitly warns against primary-account logins. A launcher or QR code does not repair those limits. [Upstream security warnings](https://github.com/wesbos/photo-frame-dashboard/blob/adcbc38411ae0e653fbcdd078076eadaadacb313/docs/biuframe-setup-guide.md#read-this-first)

Use the stock baseline only for an isolated prototype with synthetic or non-sensitive content. Do not market that prototype as a secure personal assistant display.

Before sale, obtain and validate a maintained firmware path for this board, or choose supported hardware. Removing root alone is not sufficient. Network restrictions and scoped credentials reduce exposure but do not make an obsolete OS secure.

### Permission to reuse software

The inspected repository tree contains no `LICENSE` or `COPYING` file, and GitHub's license metadata is empty. Commercial reuse permission is unresolved. Obtain permission or an applicable license before incorporating upstream code into distributed software. Otherwise, implement the product independently using the documented findings as research. Public visibility is not a distribution license. [GitHub licensing guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)

Firmware, bundled applications, fonts, and images need separate distribution checks. Obtain appropriate professional review before commercial release.

### Hardware identity and recovery

An identical enclosure or listing does not establish identical partitions. Record USB IDs, build fingerprint, CPU, memory, WebView, and partition layout on each supported revision.

The upstream qualification profile expects `Synergy 10X1`, RK3126, and fingerprint `rockchip/rk312x/rk312x:6.0.1/MXC89K/user.thzy.20240919.143320:user/release-keys`. Its backup covers firmware before userdata, not customer photos or Wi-Fi settings. Prove recovery on a designated test unit before batch preparation. [Qualification and backup guide](https://github.com/wesbos/photo-frame-dashboard/blob/adcbc38411ae0e653fbcdd078076eadaadacb313/docs/biuframe-setup-guide.md)

## Customer setup

### Display-first entry

1. Power the display into the branded welcome screen.
2. Connect Wi-Fi on the display. Show a retry path if connection fails.
3. Display an expiring pairing QR code and an accessible manual code.
4. Open `/setup` on the customer's phone.
5. Authenticate the owner and confirm the physical display's pairing code.
6. Connect a supported agent and approve its requested permissions.
7. Let the agent configure the display and publish a test card.
8. Complete setup only after the display reports that it rendered the test revision.

### Agent-first entry

1. The customer asks an agent to follow the product's `/skill.md`.
2. The agent checks the published capabilities and its available tools.
3. A supported connector starts a setup session with no display permissions yet.
4. The agent presents the trusted claim URL to the customer.
5. The customer signs in, enters or scans the display's pairing code, and approves the agent grant.
6. The agent observes authorization through its connector and continues automatically.
7. The agent configures content and verifies the rendered revision.

Claiming a display and authorizing an agent are separate permissions. Present them in one review screen where possible, but do not silently grant agent access on claim.

A platform that cannot call our tools needs a supported connector or a manual setup path. The instruction document does not create missing tool access.

## Proposed system

```text
Customer phone -> setup website -> ownership and authorization service
Customer agent -> authenticated connector -> display content service
Display client -> outbound HTTPS -> display content service
Display client -> rendered-revision acknowledgement -> display content service
```

The table below is the original 2026-10-09 design. These responsibilities are now implemented under the current routes and contracts linked above; the original operation names below are not the callable API.

| Component | Responsibility |
| --- | --- |
| Display client | Welcome screen, pairing, trusted content rendering, local cache, reconnect, and render acknowledgements. |
| `/setup` | Ownership proof, permission review, accessible pairing, and recovery from interrupted setup. |
| `/skill.md` | Versioned agent instructions linking to the supported connector and API contract. |
| API contract | Machine-readable schemas, capabilities, errors, versioning, and authentication requirements. |
| Agent connector | Scoped authenticated access for one verified platform first. Add MCP or provider-specific adapters only after compatibility testing. |
| Content service | Validate updates, isolate owners, store revisions, deliver content, and report status. |
| Factory workflow | Qualify units, prepare software, enroll unique identities, test hardware, and leave units unclaimed. |
| Owner controls | Disconnect agents, erase content, reset ownership, manage devices, and view activity. |

Use outbound HTTPS polling for the first device transport. Add a persistent connection only if measured latency requires it. Do not expose ADB, SSH, or a customer router port to the internet.

Keep device credentials in the native client rather than in dashboard JavaScript or page URLs. Keep provider credentials off the display. The prototype firmware cannot guarantee protection of any locally stored secret.

Prefer typed content blocks over arbitrary agent HTML. Start with text, reminders, and controlled image assets. Validate payload size, media type, layout limits, and expiration. Reject executable markup and unapproved network resources.

Keep the first API narrow. Updates affect a display, not the customer's email, purchases, locks, or other appliances.

## Proposed operations and authorization

Operation names are design identifiers, not callable endpoints.

| Operation | Required authority | Result |
| --- | --- | --- |
| `setup_session_create` | Valid supported connector session | Provisional session and trusted approval URL, no display grant. |
| `setup_session_status` | The connector bound to that session | Pending, approved, expired, denied, or cancelled. Never reusable credentials in tool output. |
| `display_list` | Owner-approved grant | Only displays allowed by that grant. |
| `display_get_capabilities` | `display:read` for the selected display | Supported blocks, limits, and client version. |
| `display_publish` | `content:write` for the selected display | Validated revision identifier and acceptance status. |
| `display_get_revision_status` | `display:read` for the selected display | Accepted, downloaded, rendered, or failed, with timestamps. |
| `display_update_settings` | Separately approved `settings:write` | Changes to a bounded list of settings. |

Choose the exact authentication protocol after selecting the first agent platform. The supported authorization flow delivers credentials to the connector, not through chat. Do not invent a generic OAuth flow and assume every platform supports it.

Bind pairing to a single device, owner, setup session, and agent identity. Use expiring, single-use codes, physical possession proof, and rate limits. A device ID or QR screenshot alone must not confer ownership.

Require a new owner approval to expand scopes or add a display. Account authentication proves owner identity but does not replace physical possession proof.

Use idempotency keys for publishes and expected revisions for conflicting changes. A repeated request must not create duplicate cards. A delayed acknowledgement must not overwrite newer content.

Reset and ownership transfer revoke old device credentials, agent grants, and cached customer data. Factory preparation creates a unique identity per unit. Never distribute cloned customer credentials in a master image.

## Rollout phases

No phase below has passed its full acceptance gate. The local prototype implements a subset of ownership and content transport for desktop testing. It does not count as cold-boot, firmware, connector, or commercial verification.

| Phase | Deliverables | Acceptance gate |
| --- | --- | --- |
| 0. Qualify the sample | Read-only inventory, supported revision record, verified backup, and recovery procedure | Identity matches or receives a separately reviewed profile. Recovery succeeds on a designated test unit before writes expand. |
| 1. Local display prototype | Branded launcher or startup path, lightweight renderer, local welcome screen, and offline content | Ten cold boots reach the display UI without developer interaction. Touch, orientation, memory use, and Wi-Fi behavior pass on the actual unit. |
| 2. Ownership service | Device enrollment, claim website, pairing codes, owner account, and reset flow | Expired, replayed, stolen, and cross-owner pairing attempts fail. An interrupted claim resumes without duplicate ownership. |
| 3. Remote content | Typed content API, outbound transport, revisions, cache, and acknowledgements | A remote publish renders on the claimed display. Duplicate requests and offline reconnection preserve the intended final revision. |
| 4. Agent onboarding | One supported connector, published instructions, permission screen, and setup verification | A new customer supplies Wi-Fi and ownership approval, then the agent finishes setup without manual credential handling. Revoked grants stop further writes. |
| 5. Pilot preparation | Repeatable factory tooling, production signing, protected service controls, and documented support | Each unit gets its own identity. Interrupted provisioning is recoverable. A 72-hour trial with network and power interruptions passes. Sensitive customer pilots wait for the security gate. |
| 6. Commercial release | Maintained firmware or supported replacement hardware, approved reuse rights, updates, privacy controls, and support policy | Security and distribution review passes. Signed updates and rollback are tested. Data removal and ownership transfer work end to end. |

Run provider authorization tests when adding each connector. Do not advertise an agent as supported until it passes the complete onboarding and remote-publish flow.

## Verification plan

- Exercise first-run setup with a customer who has not seen developer instructions.
- Test wrong Wi-Fi credentials, captive networks, service outages, power loss, expired QR codes, and abandoned sessions.
- Test two owners, two agents, multiple displays, revoked grants, and concurrent content updates.
- Separate server acceptance, device download, and actual rendering in both logs and customer feedback.
- Test payload validation, script injection, media limits, unapproved redirects, and content that asks an agent to change permissions.
- Verify device TLS behavior, supported trust roots, and navigation restrictions on the target firmware.
- Keep diagnostic logs free of tokens, pairing secrets, Wi-Fi passwords, and private content.
- Measure setup completion, publish latency, reconnect behavior, and failed-update rates from real tests. Do not prefill product metrics.

## Authorization boundaries

The owner initially authorized planning from the upstream baseline. On 2026-10-09, the owner authorized work toward a demo on the identified Samsung SM-T580 and confirmed that its files need not be preserved. This permits compatible recovery and demo preparation on that unit. The latest work has not flashed, erased, or installed anything on it. See [the Samsung recovery record](docs/samsung-sm-t580-recovery.md).

Before each device write, identify the exact unit, verify firmware and transport compatibility, and record the change and recovery path. The owner waived file preservation for this Samsung, not identity or compatibility checks. Obtain separate approval for a different device, public deployment, purchases, or materially broader destructive work. Separate factory-maintainer permissions from customer-agent permissions permanently.

## Original deliverables and next step, 2026-10-09

- This plan records the research baseline, product design, and release gates.
- No upstream code has been copied into a product, and no upstream device-setup script has been executed.
- [The independent local prototype](demo/DESIGN.md) uses original code for display enrollment, deliberate owner claim, separate scoped agent approval, typed text cards, and client-reported delivery receipts. It is not a provider connector or a production service.
- Local verification passes 25 native tests and 47 HTTP checks. A separate-process client published a card to a visible Chrome display, which sent its own receipt. This was a disposable QA-owner flow, not a real customer onboarding. The QA grant was revoked afterward. [Demo handoff](demo/VERIFICATION.md).
- The local service serves working `/skill.md` instructions and `/api-contract.json`. These do not publish or implement the proposed production interface in the agent draft.
- The Samsung's bootloader revision 6 is confirmed, and WinUSB resolved host access. Both tools failed to retrieve its partition table. Later Recovery images identify Chinese build `T580ZCU6CTF1` and successful dm-verity verification. The owner now reports reaching the home screen followed by shutdown on laptop USB power. Wall-power charging is the next checkpoint. Stable operation and tablet rendering remain unverified. No flash or wipe was performed.
- The purchased BIUFRAME still needs its own read-only inventory. Do not apply Samsung firmware to it.
- After the local prototype, select one connector using the exact agent product URL and test the full customer flow. QR onboarding and maintained firmware remain separate acceptance gates.
- The document from the other agent has not been supplied. Reconcile it with this plan when available.

The prototype starts from the same display research. Commercial readiness remains a separate gate, not an assumption inherited from a working demo.
