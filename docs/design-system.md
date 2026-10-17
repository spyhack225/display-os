# Design system

DisplayOS uses one visual system across the welcome page, privacy page, My home, the pairing flow, the tablet screen and the retained pilot pages. It follows the credited upstream design language ([THIRD-PARTY-NOTICES](../THIRD-PARTY-NOTICES.md)): quiet black and white, one muted sage accent, large display type with tight tracking, and surfaces that look like glass. Be present. Keep your promises. Anything that sends or deletes shows a preview and waits for one approval.

## Files

| File | Holds |
| --- | --- |
| `cloud/product-public/design-system.css` | Tokens, light and dark themes, base elements, buttons, fields, checkboxes, sheets, chips, disclosure rows, glass, dotted field, focus, motion and preference rules. Loaded first on every page. |
| `cloud/product-public/style.css` | Owner chrome, welcome, privacy, progress steps, dialogs and the tablet screen shell (heading, tiles, quiet view, photo frame, night view, pairing panel). |
| `cloud/product-public/details.css` | Reading sheets, calendar days, family lists, voice dock, scene cards, photo and source panels. |
| `cloud/product-public/home-layout.css` | The My home card grid and the single column views. |
| `cloud/product-public/pairing.css` | Six number entry on My home and the code styling on the screen. |
| `cloud/product-public/theme.js` | Applies the saved theme before first paint and wires the theme toggle. |
| `cloud/public/style.css` | Layout for the retained pilot pages. It only uses the tokens. |

The pilot pages link `/product/design-system.css` and `/product/theme.js`, so one build serves both.

## Themes

Dark is the default. A page follows `prefers-color-scheme` unless the person chose a theme with the toggle. The choice is stored under the `theme` key in `localStorage` (wrapped in `try/catch`) and applied as the class `dark` or `light` on the root element by `theme.js`, which loads synchronously in the head so nothing flashes. The same script rewrites the `theme-color` meta tag (`#0a0a0b` dark, `#ffffff` light). The tablet screen sets `class="dark" data-theme-default="dark"` and only changes if someone saved `light`. The night view is always dark, even if the light theme was chosen.

A WebView that does not know `prefers-color-scheme`, such as Chrome 70 on the tablet, never matches the light block, so it renders dark.

## Tokens

Names describe the role, not the color.

| Token | Dark | Light |
| --- | --- | --- |
| `--background` | `hsl(0 0% 0%)` | `hsl(0 0% 100%)` |
| `--foreground` | `hsl(0 0% 100%)` | `hsl(0 0% 4%)` |
| `--card` | `hsl(0 0% 5%)` | `hsl(0 0% 97%)` |
| `--secondary` and `--secondary-foreground` | 12% and 85% | 92% and 25% |
| `--muted` and `--muted-foreground` | 15% and 65% | 94% and 40% |
| `--accent` and `--accent-foreground` | `hsl(170 15% 45%)` and white | `hsl(170 20% 32%)` and white |
| `--accent-text` | `hsl(170 22% 68%)` | `hsl(170 22% 28%)` |
| `--border` | 20% | 86% |
| `--border-strong` | 40% | 50% |
| `--input` | 18% | 84% |
| `--ring` | 40% | 60% |
| `--focus` | 82% | 22% |
| `--success`, `--warning`, `--danger`, `--info` | green, orange, red, blue, tuned for each theme | |

Role aliases map onto them: `--text`, `--text-secondary`, `--text-tertiary`, `--surface`, `--content`, `--grouped`, `--separator`, `--selection` and `--record`.

Two extra tokens exist because the base values alone miss WCAG AA. The raw accent is only 4.1:1 against white, so filled primary buttons invert the page (`--primary` is the foreground color) and the accent colors small text through `--accent-text`. The light `--ring` is 2.9:1 on white, so keyboard focus uses `--focus` and keeps `--ring` for the soft halo.

Type: `--font-sans` is Inter, then the system sans stack. `--font-display` is Instrument Serif, then `ui-serif`, Georgia and serif, used only for display accents such as the second line of the welcome headline. No web font is loaded. Tracking tokens: display -2px, section -1.5px, headline -1px, title -0.01em, eyebrow 3px (uppercase, 11px, 12px on the wall display), caption 0.14em. Display line height is 1.03.

Space: `--space-2`, `-4`, `-8`, `-12`, `-16`, `-24`, `-32`, `-48`, with page padding 20, section gap 28 and card padding 14. Touch targets use `--touch` (44px).

Radii: `--radius-control` 6, `--radius-card` 10, `--radius-sheet` 14, `--radius-field` 12, `--radius-glass` 16, `--radius-hud` 22, `--radius-pill` 999.

Shadows: `--shadow-card` (0 2px 8px), `--shadow-raised` (0 4px 14px), `--shadow-hud` (0 8px 18px).

Motion: `--dur-hover` 0.14s, `--dur-standard` 0.2s, `--dur-emphasis` 0.3s, `--dur-spring` 0.45s, with `--ease-hover` ease-out, `--ease-standard` and `--ease-spring` (`cubic-bezier(.34, 1.3, .5, 1)`). Under `prefers-reduced-motion` every duration drops to 0.01ms and animations run once.

## Components

- Button (`.button`, `.secondary`, `.danger`): pill, 48px tall, 44px minimum width. Primary inverts the page. Secondary is a bordered glass fill. Press scales to 0.97 with the spring curve.
- Field (`.field`): label above, 52px input with a strong border and 12px radius. Selects get a drawn chevron. Range inputs use the accent.
- Checkbox: custom 24px box with a drawn tick, inside a 44px tall label.
- Sheet (`.sheet`) and glass (`.glass`): see Glass below.
- Disclosure row (`details`, `summary`): 44px row with a circled plus or minus.
- Chip (`.status-pill`, `.badge`, `.scene-chip`): accent tint with a visible border.
- Flow note (`.flow-note`): accent bar and tinted fill for something the person must read.
- Progress steps (`.progress`): numbered pills. The current step is inverted and has `aria-current="step"`.
- Theme toggle (`.theme-toggle`): a 44px half filled circle, hidden until `theme.js` runs.
- Dotted field and orb: `body::before` paints a 24px dot lattice and a soft sage orb behind the page. Decoration only, hidden in forced colors.
- Screen tiles (`.family-tile`), reading sheet (`.screen-sheet`), calendar day (`.cal-day`), voice dock (`.voice-bar`), scene card (`.scene-card`) and photo frame chips (`.frame-chip`) are screen specific and use the same tokens.

## Glass

A glass surface has a near transparent fill (white 1% on dark, black 2% on light, raised to about 4% on content cards so text keeps a clear plane), a 1px border, an inset top highlight and a backdrop blur between 4px and 12px. Every glass rule starts from an opaque fallback and changes only inside `@supports ((-webkit-backdrop-filter: blur(4px)) or (backdrop-filter: blur(4px)))`. The luminous gradient rim (a masked `::before`) is drawn only inside `@supports (mask-composite: exclude)`. Chrome 70 matches neither, so the tablet gets solid cards with a hairline border. Elements that scroll (`.family-tile`, `.screen-sheet-body`) skip the rim, because it would scroll with the content. Under `prefers-reduced-transparency` glass returns to opaque.

## Layout rules

Owner pages are mobile first. My home is one column, two from 760px and three from 1200px, with 20, 24 and 32px page padding. Sign in, recovery, first home and invitations stay in one 640px column (the `data-view` attribute on `#home-root`).

The wall display is built to read from across a room: a 76px clock at 1280px wide, 19px tile titles, 18px body text. From 1000px wide the tile rows become columns (4 and 3). At 700px tall or more every row also sizes itself to the window, so the day needs no scrolling. Shorter windows scroll instead of clipping. The quiet view puts the clock and next plan on the left and the calendar on the right. Night shows a dim clock and calendar only, using `--night-foreground` and `--night-muted`, both above 4.5:1 on black.

## Chrome 70 rules

The tablet screen loads `design-system.css`, `style.css`, `details.css` and `pairing.css` in Android 8.1 WebView 70. Those four files avoid `min()`, `max()`, `clamp()` outside `@supports`, flex `gap`, `aspect-ratio`, `:is()`, `:where()`, the `inset` shorthand, logical properties and any dependence on `mask-composite`. Use `grid-gap`, margins on `> * + *` and four-sided offsets. Never put a modern selector and an old one in the same rule list, because one unknown selector drops the whole rule. Focus styling uses a plain `:focus` rule followed by `:focus:not(:focus-visible)`, so old WebViews keep a visible ring.

## Accessibility

- Text is at least 4.5:1 in both themes. Large text and UI borders are at least 3:1.
- Focus shows a 2px `--focus` outline with a soft `--ring-halo` shadow.
- Buttons, toggles, rows and calendar days are at least 44px.
- State never relies on color alone. Checkboxes draw a tick, the current step is bold and inverted, selected filters get a second outline, finished list items are struck through.
- Forced colors and `prefers-contrast: more` are handled in each file.
- Reduced motion removes the spring, the card hover lift and the photo drift.

## Adding a page or component

1. Link `theme.js`, then `design-system.css`, then the page files.
2. Use tokens only. Do not hard code a color except on top of photos.
3. Give each glass rule an opaque fallback first.
4. Check the page at 375 wide, 1280x800 and 1024x600 in both themes before shipping.
5. If the page loads in the tablet WebView, follow the Chrome 70 rules above.
