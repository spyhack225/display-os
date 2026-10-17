# Add DisplayOS to your assistant

DisplayOS's invitation is a message to an assistant you have already connected. Pasting it into chat does not install DisplayOS or give permission to share anything.

## ChatGPT and your dot

For this pilot, add DisplayOS once in your own signed-in ChatGPT browser.

1. Open [ChatGPT Plugins](https://chatgpt.com/plugins).
2. Select the plus button, then **Add custom MCP server**.
3. Name it **DisplayOS**. For **Server URL**, paste `https://displayos.<your-subdomain>.workers.dev/mcp`. Choose **OAuth** authentication. Advanced OAuth settings should discover **Dynamic Client Registration** automatically. For the first connection, keep only `display:read` and `content:write` selected. Do not choose No authentication or enter a secret.
4. Review ChatGPT's warning. If you want to proceed, choose **Create as a plugin**.
5. Open DisplayOS under **Personal** and install it.
6. In ChatGPT Work, select `@DisplayOS`. Ask it to connect and show your family plans.
7. In DisplayOS's approval page, sign in with your saved sign-in, choose your home and screen, and approve only what you want it to share.

The connection address above is public and contains no password or token. You still control approval. Your assistant cannot approve itself. Its cloud browser is separate from your phone's browser, so a signed-out page there does not mean your home is lost. Never send your sign-in, screen PIN or browser session through chat.

If **Add custom MCP server** is missing or blocked, your account or workspace may not permit custom connections. Stop there rather than bypassing the restriction. DisplayOS has no published directory entry or one-click installation link yet. A personal plugin is not a public listing.

These steps follow OpenAI's [plugin quickstart](https://developers.openai.com/plugins/quickstart) and [custom MCP connection guide](https://developers.openai.com/api/docs/guides/custom-mcp-server). The existing owner's personal plugin is installed with an OAuth account and six discovered actions. A fresh selected-plugin conversation reports a successful lookup of two screens. Personal publication and a tablet render receipt still need confirmation; a connected account or successful action scan does not prove an update reached the display.

## If DisplayOS is installed but has no actions

Installation, account connection and available actions are separate checks. If the assistant says it cannot call DisplayOS, open DisplayOS's app details in ChatGPT Plugins and check the action list. A connected account alone is not enough.

For a custom MCP plugin, open its settings and select **Refresh tools**. If the refresh succeeds and actions appear, start a new conversation and select `@DisplayOS`. Ask `Show my connected family screens.` This is a read-only connection test. Do not claim that an update reached the tablet until a publish and its render receipt have both succeeded.

If the app says **No tools available** or refresh fails, do not create duplicate plugins, send tokens or switch off authentication. Report the visible message. DisplayOS previously rejected ChatGPT's additional client capabilities during its handshake. The corrected service now accepts bounded capabilities without treating them as permissions. After a successful refresh, the action list shows exactly the permissions that connection was approved with: a connection that kept both permissions shows the read actions and **Update the family screen**, while the current owner connection was approved read-only and shows only read actions — see the next section. Continue in a new selected-plugin conversation rather than repeating installation or home setup.

OpenAI documents the [refresh and new-conversation steps](https://developers.openai.com/plugins/deploy/connect-chatgpt). This guidance applies to custom MCP plugins, not the daily review process for published plugins.

## If DisplayOS can read your home but cannot send anything

A connection approved with the read permission alone can list screens, read the current screen and read voice messages, but it has no **Update the family screen** and no voice-reply action. That is a permission state, not a broken install: an existing grant cannot be widened, and refreshing the actions does not add permissions.

To let a connection send, open DisplayOS in ChatGPT Plugins, remove the connection, then add it again with the same server URL. On the approval page, sign in again, choose your home and screen, and keep both permissions checked — the read permission and the update permission. A new selected-plugin conversation then discovers the publishing and voice-reply actions. Never send your sign-in, browser session or screen PIN through chat to speed this up; only you can approve the wider connection.

## If Chrome blocks approval

The owner's attempted ChatGPT setup reached the DisplayOS approval address but Chrome showed `ERR_BLOCKED_BY_CLIENT`. Chromium defines this as the client choosing to block the request. The specific blocker has not been identified, and this is not a captured DisplayOS HTTP 403. See the [Chromium error definitions](https://github.com/chromium/chromium/blob/main/net/base/net_error_list.h).

Take over the browser before completing approval. If browser control is active, end that control using the visible Cancel button, then reload yourself. If the page remains blocked, start a fresh custom plugin connection from ChatGPT on your phone. Do not copy or send the authorization URL. Do not disable browser security or share session details to get around the block. An expired setup must be started again through ChatGPT.

## Other assistants

An assistant needs a supported OAuth MCP connection setup to use DisplayOS. Give that setup the same public connection address. Reading `/skill.md` alone is not enough. Muse's observed request shape now passes a disposable authorization and MCP journey, but your personal Muse connection still needs your approval and confirmation. If an assistant cannot add a secure connection, it should say so without asking for tokens or signing into your home on its cloud computer.

## If a connection request was rejected

Two setup differences caused the reported errors. ChatGPT supplied an extra language hint, which DisplayOS rejected as `invalid_request`. The Muse request omitted the target field, which DisplayOS rejected as `invalid_target`. These are server compatibility defects, not an incorrect screen PIN or lost home.

The correction ignores bounded optional authorization hints and defaults an omitted target only to DisplayOS's own MCP service. It does not approve the assistant, add permissions or let it use another service. Duplicate fields and explicitly incorrect targets remain rejected. Existing sign-in, screen selection, approval and revocation still apply.

Version `4947d62b-5750-444b-b0db-1b4e10523376` introduced this authorization correction. ChatGPT-shaped and Muse-shaped disposable journeys each passed 42 checks, including refresh rotation and a desktop screen update; both QA homes were deleted. The later action-discovery correction successfully refreshed the owner's existing ChatGPT plugin. These corrections remain in the current service. Version `9974f032-fca6-4337-b110-c93880f7253a` makes an authorization request that omits `scope` default to `display:read content:write` intersected with the client's registered scopes, so a fresh connection no longer silently becomes read-only. Existing connections are unchanged: a read-only grant still cannot be widened by refresh and must be reconnected as above. Do not reinstall an already connected plugin or repeat home setup otherwise; refresh its actions and use a fresh selected-plugin conversation. A new connection still requires approval in your own browser. Personal Muse approval and personal screen publication remain separate checks.

## Public instructions and private access

Only `/skill.md` and the three exact OAuth discovery addresses are public cross-origin GET reads. They contain no family data, credentials or approval handles. My home, device routes, OAuth registration and exchanges, and MCP calls keep their existing origin and authorization checks. Reading the instructions never grants access to a screen.
