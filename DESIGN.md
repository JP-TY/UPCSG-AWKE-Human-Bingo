# AKWE 2026 Human Bingo Design System

## Visual direction

Cut-and-paste scrapbook: red gingham cloth, corkboard, torn paper, masking tape, portrait stamps, and the supplied AKWE event artwork. Use the real kit in `Assets/`; do not substitute stock photos or decorative gradient/mesh backgrounds.

## Color strategy

Full palette on every surface. Burgundy and gingham red establish the base. Pink, sticker yellow, tomato red, teal, and leaf green are controlled stamp/sticker accents. Keep task text and form surfaces high-contrast in the bright event hall.

| Token | Value | Role |
| --- | --- | --- |
| `--color-paper` | `oklch(95.5% 0.018 85)` | warm paper |
| `--color-paper-2` | `oklch(92.5% 0.022 78)` | cork / raised scraps |
| `--color-paper-3` | `oklch(88% 0.035 70)` | kraft / masking tape |
| `--color-ink` | `oklch(22% 0.030 30)` | warm near-black text |
| `--color-ink-2` | `oklch(42% 0.025 35)` | secondary text |
| `--color-rule` | `oklch(78% 0.030 70)` | borders and separators |
| `--color-muted` | `oklch(52% 0.022 35)` | quiet text |
| `--color-burgundy` | `oklch(38% 0.115 25)` | primary brand field |
| `--color-gingham` | `oklch(58% 0.170 30)` | event red |
| `--color-focus` | `oklch(55% 0.200 85)` | focus ring |
| `--color-sticker-pink` | `oklch(75% 0.18 340)` | sticker accent |
| `--color-sticker-yellow` | `oklch(90% 0.16 95)` | sticker accent |
| `--color-sticker-red` | `oklch(62% 0.21 30)` | error / sticker accent |
| `--color-sticker-teal` | `oklch(78% 0.12 175)` | sticker accent |
| `--color-sticker-leaf` | `oklch(62% 0.13 145)` | verified accent |
| `--color-wood` | `oklch(47% 0.074 55)` | frame / signboard |
| `--color-cork` | `oklch(79% 0.065 74)` | bulletin board |

Derived interface roles remain named tokens too: `--color-tape`, `--color-pending-paper`, `--color-pending-stripe`, `--color-rejected-paper`, `--color-verified-paper`, `--color-list-paper`, `--color-sync-leaf-ring`, and `--color-sync-yellow-ring`.

Neutrals are warm-tinted. Never use pure black or white for large fields. Verify text and control contrast to WCAG AA.

## Typography

- **Cutout/display:** local AKWE font kit (`Chalktastic`, `Cartoon 2 US`, `CuteTumblr`, `Koala Station`, `Biro Script`). Use for ransom-note headings, short annotation, and celebration only.
- **Body/UI:** Schibsted Grotesk, with a sans-serif system fallback. Use for all task text, form labels, buttons, errors, and data.
- Body copy: 1rem minimum, line-height 1.5, maximum measure 70ch.
- Product density: fixed rem scale. Headings may use bounded `clamp()` on brand/hero surfaces.
- Never italicize display headings. Avoid long all-caps text.

## Layout and surfaces

- Mobile first, no horizontal scroll at 320px. Game card stays five columns at all sizes.
- Use a 4px spacing base: 4, 8, 12, 16, 24, 32, 48, 64, 96.
- Asymmetric collage rhythm, with slight controlled paper rotations and overlaps. Keep interactive controls aligned and easy to scan.
- Avoid nested cards and repeated identical card grids. Use paper scraps only where they represent a distinct action or piece of content.
- Navigation is a stamped event slab with an accessible compact disclosure on narrow screens.

## Components and game states

- `RansomTitle`: short letter-by-letter cutout heading, decorative letters hidden from assistive technology; semantic heading text remains intact.
- `PaperScrap`, `TapeLabel`, `GinghamField`: restrained texture framing real app content.
- `BingoGrid`: 25 semantic buttons in a five-column grid, with task, text state, and touch target preserved.
- `FaceStamp`: supplied portrait image chosen by a per-grid 11-bag sequence and persisted on the square at confirmation. Only verified squares receive a face-stamp. Pending and rejected squares have no stamp.
- Status is never conveyed through stamp art or color alone. Accessible labels and text status remain present.
- All interactive controls include default, hover, focus-visible, active, disabled, loading, error, and success states.

## Motion

- Hero reveal is one short entrance sequence. Do not block actions on animation.
- A confirmed face-stamp lands with a 180ms transform/opacity transition using a quart-out curve.
- UI transitions are 150–250ms. No layout-property animation, bounce, or elastic easing.
- Respect `prefers-reduced-motion` by removing spatial movement and stagger.

## Responsive and accessible behavior

- Use 44px minimum interactive targets and a 3px high-contrast `:focus-visible` ring.
- Stack page columns on mobile; keep the board 5×5 and reduce decorative elements before reducing task readability.
- Support keyboard navigation, visible labels, semantic landmarks, live announcements for sync and verification, and reduced motion.
