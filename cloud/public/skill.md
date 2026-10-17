# DisplayOS agent integration pilot

This service publishes synthetic plain-text cards to a browser display over HTTPS. It has one pilot owner, not customer accounts or provider connectors. The browser agent page is a test client, not an AI agent.

Use the current HTTPS origin. Send `Content-Type: application/json` and `X-Demo-Request: 1` on every POST. Never send credentials in URLs, logs, chat, or card content. Never ask for the owner credential or enrollment code. The owner enrolls and claims the display, then separately approves your requested display, scopes, and lifetime.

1. POST `/api/agent/requests` with `deviceId`, `label`, `scopes`, and `ttlSeconds`. Supported scopes are `display:read` and `content:write`, with at most 3600 seconds. Labels are self-reported. The returned request token has no display access.
2. Poll GET `/api/agent/requests/{requestId}` with `Authorization: Bearer REQUEST_TOKEN`. The request expires after five minutes. An approved response returns a grant token. Keep it in memory or protected storage.
3. GET `/api/agent/devices/{deviceId}/capabilities` using the grant bearer token. Read the current revision before publishing.
4. POST `/api/agent/devices/{deviceId}/content` using that token, `content:write`, and an 8 to 80 character `Idempotency-Key`. Supply `expectedRevision`, `ttlSeconds` from 1 to 86400, and 1 to 4 `cards`, each with `title` up to 80 characters and `text` up to 600. No markup or extra fields.
5. Poll GET `/api/agent/devices/{deviceId}/revisions/{revision}` with `display:read`. Status progresses from accepted to downloaded to rendered. Rendered means a client-reported receipt, not independent proof of tablet pixels. Only the display's transport token and delivered nonce can acknowledge.

Retry a lost publish response with the same idempotency key and identical payload. A changed payload or stale expected revision returns 409. Stop on expired or revoked authorization. Approval for one display does not authorize another. Revocation blocks future reads and writes but does not erase previously accepted content.

State survives cloud restarts. Owner sessions expire after one hour, pairing after two minutes. Pilot capacity is bounded to 32 displays, 128 pending or approved requests before cleanup, 100 revisions per display, and 60 KB of growth state with a reserved recovery budget. A 429 is not success. Do not invent delivery results or try to bypass capacity. Browser display and agent credentials live in tab session storage. The DisplayOS interface uses ordinary family language; keep API terms in your tool calls, not in messages asking the owner to consent. Installer preparation happens at /operator. Family setup accepts the single-use screen code, but you must not claim the display or approve yourself. The quiet view shows a local clock, calendar and one delivered text note. QR, boot startup, customer identity, email, calendars, photos and real AI connectors are not implemented.
