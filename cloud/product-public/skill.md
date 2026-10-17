# DisplayOS assistant connection

DisplayOS is a shared family screen. The person wants useful, sparse family information, not a technical setup conversation. Never ask them to paste an access token, factory secret, screen credential or password into chat.

## Connect

Reading this document or pasting an invitation does not install a connection. DisplayOS is a pilot and does not yet have a published plugin directory listing or a one-click installation link.

The non-secret connection address is the HTTPS origin that served this document followed by `/mcp`. Never add tokens, home identifiers or approval handles to this address.

For ChatGPT Work and dots, the person first opens https://chatgpt.com/plugins in their own signed-in browser. If their account permits custom connections, they choose the plus button, Add custom MCP server, name it DisplayOS, enter the connection address and choose OAuth authentication. They review the warning and choose Create as a plugin, then install DisplayOS from their personal plugins. They can select `@DisplayOS` in a Work conversation. Use discovery and dynamic client registration rather than asking for a client secret. Account and workspace restrictions may prevent this setup. Current instructions are at https://developers.openai.com/plugins/quickstart and https://developers.openai.com/api/docs/guides/custom-mcp-server.

If your host has no installed DisplayOS tools and cannot add a secure connection, give the person the non-secret connection address and the supported setup link. Do not try to sign into My home in your cloud browser. It has a separate session from the person's phone or computer. Do not ask for their passkey, screen PIN, session cookie or access token. Never bypass owner approval. Other hosts need their own supported OAuth MCP connection setup. Do not promise Muse compatibility without testing it.

Use the HTTPS origin that served this document. The protected MCP resource is `/mcp`. Discover its OAuth authorization service through `/.well-known/oauth-protected-resource/mcp`. Use the advertised OAuth metadata, a public client, an exact registered redirect URI, authorization-code flow with PKCE S256, and `resource` set to the full `/mcp` URL.

Request only `display:read content:write` initially. Request `settings:write` or `media:write` only when the person asks for those abilities. Open the authorization URL using your supported secure connection mechanism. The person signs in at `/home`, chooses their home and screens, and approves explicit permissions. Do not approve your own request. Complete the exact callback and PKCE exchange inside your connection mechanism, not in chat.

If your host cannot make this authenticated connection, state that limitation plainly. Do not imply that every AI assistant or personal account is connected. Connecting Gmail, calendars or photos through another provider still requires that provider's separate owner consent.

Approval defaults to 30 days. The person can choose today instead or stop access at any time in My home. Access tokens last at most 15 minutes. Keep the returned refresh token inside your secure connection mechanism and use the advertised refresh flow to continue within the approved period. Replace a rotated refresh token with its replacement. Never ask for hourly approval, bypass the consent expiry or promise permanent access. Expired or revoked consent requires a new explicit approval.

## Use the screen

Initialize the advertised MCP protocol. Call `screen_list`, then `screen_capabilities`. Capabilities define supported fields and bounds. Build a family snapshot with `schemaVersion:1`, an IANA `timezone`, Unix-millisecond `generatedAt` and `expiresAt`, and a short plain-text `briefing` with `title` and `text`.

Optional fields are `weather`, `week`, `reminders`, `kids`, `parents`, `news`, `prompts`, `nearby`, `photos` and `lists`. Keep the week to seven dates and at most two events per date. Weather temperatures are Celsius. Use short summaries rather than full email bodies. Do not send private messages, diagnoses, passwords, account balances or precise children's locations to a shared screen. Ask before sharing sensitive information.

Make `news` two timely, relevant headlines the family would want to know about: local happenings, school or community updates, or major current events stated plainly. Skip filler and anything alarming without a reason. Each item needs a short `title` and a one-line `summary` saying why it matters to them.

Use `lists` for shared groceries and to-dos, at most four lists with twelve items each. Each list has an `id`, a short `title`, a `kind` of `groceries` or `todo`, and `items` with `id`, `text`, optional `person`, and `done`. Generate `id` values as 8 to 64 letters, digits, `_` or `-`. The screen lets the family filter by kind. Ticking items off happens here or in My home. If the owner allows it on a screen, the family can also add, tick off, and remove items directly on that display.

Watch for spoken requests with `voice_list`, which shows each request with its transcript when there is one, its state and time. Use `voice_get` to hear one request as base64 webm audio plus its transcript, and mark it heard. If `transcript` is empty, transcribe the audio yourself. Never ask the person to paste the audio. Use `voice_reply` to publish a short answer card and mark the request answered. The card is a `displayScene` with a `kind` of `answer`, `plan`, `list`, `compare`, `steps`, `note` or `timer`, a `title` of 1 to 80 characters, an optional `subtitle` of 1 to 240, one to six plain-text `blocks`, and `ttlSeconds` from 30 to 3600. Each block is one of `text` (1 to 240 characters), `rows` (1 to 6 pairs of `label` and `value`, 1 to 80 characters each, with an optional `tone` of `plain`, `good` or `warn`), `chips` (1 to 8 short labels of 1 to 80 characters), `steps` (1 to 6 lines of 1 to 80 characters) or `bars` (1 to 6 entries with a `label` of 1 to 40 characters and a `value` from 0 to 1). Plain text only, with no markup, links or URLs. Set `voiceAck.state` to `acted` and `voiceAck.agentName` to your own name. The person speaks to the screen and expects a fast, visible answer, so reply promptly and in one or two short sentences. Never guess at names of children, never put diagnoses or money on the screen, and ask before anything sensitive. Prefer acting on clear requests, such as adding milk to the groceries, over asking clarifying questions.

Call `family_publish` with the chosen `deviceId`, `snapshot`, current `expectedRevision` and a fresh `idempotencyKey`. Reuse the same key and body after a lost response. A revision conflict requires reading the current revision and recomposing intentionally, not blindly replacing another update. Call `revision_status` to distinguish accepted, delivered and rendered. Say that an update reached the screen only when rendered is confirmed.

Photos must come from explicitly approved JPEG or PNG uploads. `media_upload` accepts a bounded sanitized image, not an arbitrary remote URL. Use its returned media reference in `photos`. Never put provider passwords or OAuth tokens on the screen. Use `screen_settings` only after the person approves changing its quiet hours, time zone or view.

## Finish and respect consent

Explain completion in one ordinary sentence. Do not show internal identifiers, permissions names or protocol instructions to the person. Keep useful family lists short enough to read at a glance. Expiry means old private updates disappear locally even offline. A person can stop your access in My home. If access is revoked or expires, stop and request a new connection through the supported authorization flow. Do not try another home or screen.
