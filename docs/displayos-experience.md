# DisplayOS experience

The 2026-10-10 implementation supersedes the preview-only flow recorded below. Families now use passkey sign-in, physical QR confirmation, separate assistant consent and connected family/quiet views. See [the full implementation ledger](full-implementation.md) and [operation guide](product-operations.md). The earlier pilot and its state remain separately available under `/pilot/`. Missing-feature statements below describe the historical preview, not the current product.

DisplayOS is the product name. Domain and trademark availability have not been checked. The Worker (`displayos`), cookie names, storage keys and Android package (`com.displayos.kiosk`) all use the name. The renamed service starts with empty state; pre-rename homes and tablet enrollments are not carried over.

## Who it is for

Parents, grandparents and anyone who wants a useful home screen without learning how software is hosted. They interact with their assistant and recognize the result on their screen. They do not manage credentials, services or API tools.

Use ordinary words in the product: home, screen, note, assistant, invite, allow, stop updates. Keep technical explanations in installer documentation and agent instructions. Do not make a person read a consent dashboard full of IDs, scopes or delivery revisions.

## Shipped interface

- `/display` opens a clearly labeled sample home without asking for credentials. Our day shows four made-up family notes. Quiet view shows a local clock, month calendar and one sample reminder or the first delivered note. The user changes views explicitly; idle switching is not implemented.
- Navigation and view controls use restrained translucent materials with a blur enhancement when supported. Content stays on readable solid surfaces. Reduced-transparency and reduced-motion preferences have fallbacks. This is a web design inspired by Apple's materials, not native Apple Liquid Glass.
- Technical preparation is separate at `/operator`. Installer owner access belongs on a phone or laptop; enrollment belongs in the screen browser. There is no installer link in family navigation. The route is not a substitute for authorization: existing credentials are still required for every preparation action.
- `/setup` guides an already prepared owner browser through one screen code, then an explicit assistant approval. It never asks the family to find an owner key or a file. An unprepared browser honestly explains that personal sign-in is not available yet. It does not pretend customer accounts exist.
- The 12-character screen code replaces two values in the family form. It retains its two-minute lifetime and single-use behavior. Claiming still requires an authenticated owner, exact Origin, CSRF and attempt limits. Older API callers may still supply both code and pairing session.
- A copied invitation includes the screen ID and official agent instructions without exposing machine details on screen. The sample-assistant link carries only the public screen ID in a fragment. No owner, enrollment, request or grant credential travels in a URL.
- The approval identifies the assistant's supplied name, the owned screen, what it can do and how long it can help. A plain-language warning explains that the name is supplied by the assistant. Approval is never automatic.
- The sample assistant asks to connect, sends a note and reports the observed delivery stage in ordinary language. Confirmation still means a browser receipt, not independent proof of tablet pixels.

## What still blocks a customer-ready flow

Moving operator work out of sight is not the same as eliminating it. This pilot still needs manual installer preparation, and owner sessions last one hour. It is not ready for unsupervised family onboarding or sales.

The intended customer sequence is:

1. Turn on the prepared screen and connect Wi-Fi.
2. Scan its short-lived setup code with a phone. Use a manual screen code if needed.
3. Sign in through an ordinary customer account and confirm This is my screen.
4. Choose a supported assistant and approve its screen updates in plain language.
5. The assistant sends a first useful note. Show success only after the screen reports it received and rendered the note.

Implement customer identity, factory or installer provisioning, QR pairing and one real assistant connector before presenting that sequence as working. Provider consent is separate from permission to update a shared family screen. The tablet never needs email or photo-account credentials.

## Verification

The browser helper at `cloud/scripts/verify-ui.mjs` runs the actual Worker and Durable Object locally with generated test credentials. It checks the public sample, quiet view, landscape and phone layouts, the installer split, single-code claim, separate approval, rejected markup, visible note delivery, quiet-view updates, revocation and sign-out. Its state is disposable; it does not act as the live owner or claim physical tablet proof.

Screenshots are under ignored `diagnostics/displayos-ui/`. Hardware readability, old-browser compatibility, automatic startup, real household content, photographs and a full structured family calendar remain unverified or unimplemented. The original family preview files are unchanged.

