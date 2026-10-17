# Voice talk to agent (next phase, parked)

Status: parked. Think-through done 2026-10-10. Do not implement until the user reopens it.

## The idea

Hold-to-talk button on the display, agent picker with a default, three-dot acknowledgement,
rendered result. Verdict from analysis: push-to-talk UX is right, transcription needs no new
service, OpenIntelligentUI is the wrong tool, and one architectural gap decides the shape.

## Key findings

- OpenIntelligentUI is a full Next.js plus Python chat product needing vendor API keys and
  hosting. Its sandboxed-iframe generative UI contradicts the screen's plain-text-only
  snapshot security model. Do not adopt; snapshot updates already are the feedback UI.
- Agents cannot be called today. They act when the person talks to them in their own chat.
  Voice needs a mailbox: per-assistant inbox, `voice_list` / `voice_get` / `voice_ack` MCP
  tools, assistant transcribes with its own multimodal ability on its next turn.
- Honest feedback state: dots mean "delivered to your helper", never "typing now". Live
  replies need an always-on agent service, which is a different product.
- Mic chain closed in three places: server CSP `microphone=()`, kiosk app has no
  RECORD_AUDIO path or WebView permission handler, native bridge caps packets at 8KB
  (chunk audio like photo chunks, ~60KB pattern exists). Tablet WebView 70 audio support
  is shaky and needs real-device testing. APK rebuild plus USB reinstall required.
- Interim ack without new protocols: a small `agentNote` snapshot field the assistant
  publishes when it fetches a message ("Heard X, on it").
- Privacy: push-to-talk only, visible recording dot plus timer, 60s cap, auto-delete after
  pickup or 24h, per-screen owner toggle mirroring list editing.

## Open decisions (user owns)

- Is inbox delivery plus next-update answer an acceptable v1, or must replies land live?
- Anyone-at-screen recording once enabled, or an extra step per message?
- Prototype to prove the iframe model fails the snapshot validator, or accept the verdict?
