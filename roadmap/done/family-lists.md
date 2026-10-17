# Family lists (groceries and to-dos)

Status: in progress. Source of truth is code; this file tracks intent and remaining work.

## Intent

- The dashboard gains a "Family lists" card. Anyone in the family can keep running grocery and to-do lists there.
- Each list has a kind (`groceries` or `todo`). The card filters by kind: All, Groceries, To do.
- Each item has text, an optional person it is for, and a done state.
- Owners edit lists on the home page. The assistant can edit them through `family_publish` like any other snapshot field.
- The screen itself stays read-only. Ticking items off happens on the phone or through the assistant, never on the shared display.

## Bounds (kept tight so the card stays glanceable)

- At most 4 lists per update, at most 12 items per list.
- Titles 40 chars, item text and person 80 chars.
- IDs are 8-64 chars of letters, digits, `_`, `-`, generated where the edit happens.

## Changes

- `cloud/src/product/family.js`: `lists` root key, validators, bounds, sample entry.
- `cloud/src/product/oauth.js`: mirror `lists` in the MCP snapshot schema so assistants can publish them.
- `cloud/product-public/screen.js`: "Family lists" tile in the family row with kind filter chips. Done items render struck through.
- `cloud/product-public/home.js`: owner-only "Family lists" editor. Loads the first screen's current lists, edits locally, publishes to every screen with one revision retry.
- `cloud/product-public/skill.md`: documents `lists` plus the rule that `news` must be relevant, current headlines the family cares about.
- Tests: schema bounds in `product-family.test.js`, screen rendering and filter in `product-lists-ui.test.js`, owner editor publish flow in the same UI test.

## Security notes (unchanged model)

- No new commands. Owner edits reuse `family.current` + `family.publish` with the existing revision guard.
- Plain-text validators from the existing schema apply to every list string. No links or markup.
- The 64KiB snapshot cap still bounds total list content.

## Remaining

- Deploy and confirm live (with the rows, attribution, modal, and spacing changes already queued).
- The tablet kiosk app must be restarted to load any of this.
