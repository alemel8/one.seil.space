# One SEIL — Design System

Derived from `design/SEIL Brand Identity.pdf` (v1.0, June 2026). All future UI work
on one.seil.space should follow this. Tokens live in `public/css/variables.css`.

## Colors

| Color | Hex | CSS variable | Usage |
|---|---|---|---|
| SEIL Cyan | `#14E6E6` | `--primary`, `--seil-cyan` | Primary accent: buttons, active nav state, focus rings, small tags/badges, accent word in a headline. Never a large flat fill for body copy. |
| Deep Space | `#0A1626` | `--deep-space`, `--sidebar-bg`, dark-mode `--bg-page` | Dark navy for sidebar/hero/nav surfaces. |
| Petrol | `#0F7E89` | `--petrol`, `--primary-dark`, `--accent-blue` (alias) | Secondary teal accent; hover/pressed state of primary cyan elements. |
| Slate | `#8A93A3` | `--slate`, `--sidebar-text`, dark-mode `--text-secondary` | Secondary text on dark backgrounds, borders. |
| Mist | `#EDF1F6` | `--mist`, light-mode `--bg-page` | Light page background. |

Derived/computed shades (not in the official 5, built for UI states):
- `--primary-hover: #10CCCC` — darker cyan between Cyan and Petrol, for hover states on primary-colored elements.
- `--primary-light: #E3FBFB` — very light cyan tint for subtle backgrounds/badges.
- `--sidebar-hover: #131F33` / `--sidebar-active: #13253D` — lightened steps off Deep Space for sidebar item states.
- Dark-mode `--bg-card: #141F30` / `--bg-card-hover: #182437` — lightened steps off Deep Space for card surfaces in dark theme.

`--accent-blue` is not one of the 5 official brand colors; it now aliases `--petrol`
so existing usages shift onto brand rather than staying off-palette.

## Fonts

- **Space Grotesk** (`--font-primary`, weights 300/400/500/700) — default for everything: all headings and body text.
- **Space Mono** (`--font-mono`, weights 400/700) — technical/data content only: uppercase eyebrow labels, section tags, table numeric/data cells, invoice/order numbers, timestamps, codes. Not for prose.
- Helvetica/Arial is the brand's print fallback for Office docs — not relevant to this web app.

Loaded together in `views/layouts/base.ejs`:
```
https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300;400;500;700&family=Space+Mono:wght@400;700&display=swap
```

## Logo rules

`public/img/logo.png`, `logo-white.png`, `znak.png`, `favicon.png`, `icon-192.png`,
`icon-512.png` are correct as-is — do not touch. When placing the logo elsewhere:

- Never recolor the logo.
- No drop shadows, rotation, or gradients applied to the logo.
- No unapproved background colors behind the logo.
- Never append extra text into the logo lockup.

## Visual tone

Dark navy (`#0A1626`) sections carry a subtle faint concentric-ring decoration and a
faint dot-grid texture in the background. Light sections sit on Mist (`#EDF1F6`) with
white cards and hairline 1px borders. Cyan is used sparingly — as an accent word inside
a headline, on buttons, active nav states, small tags/badges, focus rings — never as a
large flat fill for body copy. Small uppercase tracked micro-labels (section numbers
like "0.1", eyebrow tags like "BRAND MANUÁL · 06/2026") are set in Space Mono,
letter-spaced, small size, colored cyan or slate.
