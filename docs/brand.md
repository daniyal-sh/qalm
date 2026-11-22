# Qalm by Apollo: brand and UI

Qalm is part of the Apollo family, alongside Board. It follows **Apollo Study Space**, Apollo's design system,
as Board adapts it (`daniyal-sh/board` → `apps/desktop/src/renderer/src/styles.css`, `packages/shared/src/brand.ts`).
The mockups in `/mockups` set **layout and flows only**. Colours, type and surfaces come from this file.
Where this file and a mockup differ, this file wins.

## Naming
```ts
export const BRAND = {
  name: 'Qalm', byline: 'by Apollo', website: 'https://apollolearn.app',
  systemName: 'Apollo Qalm',          // folders, installer, window title
  appId: 'com.apollo.qalm',           // bundle id, Android applicationId, Electron appId
} as const;
```
Lockup: the mark, then "Qalm" (semibold, -0.02em tracking) with "by Apollo" under it (medium, muted, 0.58×).

## Mark
`assets/brand/qalm-mark.svg`: a **pen nib** (qalam = pen) ringed by Apollo's orbit, with Apollo's planet on the front
of the ring. It's the same construction as Board's mark: the orbit passes behind the nib at the top and in front of it at the bottom. The nib and slit are
in ink, the orbit is in accent (indigo) and the planet is in assistant (blue). In-app, the colours follow the theme tokens.

## Tokens (light / dark)
| Token | Light | Dark | Use |
|---|---|---|---|
| bg | #f3f3f5 | #151517 | app canvas (behind pages and the library) |
| surface | #ffffff | #1c1c1f | panels, cards, toolbar, sheets |
| surface-2 | #f6f6f8 | #212125 | quiet insets |
| soft | #e9e9ed | #2a2a2f | pressed or selected neutral fills, segmented-control track |
| ink | #27272a | #f4f4f5 | text, default pen colour on light paper |
| ink-2 | #3f3f46 | #d4d4d8 | secondary icons |
| muted | #5c5c65 | #a1a1aa | secondary text |
| faint | #8b8b95 | #71717a | metadata, placeholders |
| line | #d3d3d9 | #303035 | hairline borders |
| line-2 | #e4e4e8 | #28282d | dividers inside a surface |
| accent | #4338ca | #5b50f0 | **one solid indigo action per screen**, selected tool, selected nav |
| accent-ink | #3730a3 | #a9a3ff | indigo text and icons (never `accent` as text) |
| accent-soft / accent-line | #eeedfa / #c7c3ee | #26244a / #403b86 | selected rows, chips |
| assistant | #1d4ed8 | #60a5fa | **AI agents**: comment pins, "Claude is reading", agent avatars |
| assistant-soft / assistant-line | #ebf0fc / #bfcdf4 | #1d2a3d / #2f4b72 | AI comment cards, anchored-line highlight |
| context | #0f766e | #5eccc4 | PDFs and imported documents (PDF badge, import) |
| good / good-soft | #047857 / #e6f2ee | #34d399 / #1a2e27 | synced, saved, resolved |
| warn / warn-soft | #9a4a08 / #f5ede6 | #fbbf24 / #332a17 | pending (connection requests, unsynced) |
| bad / bad-soft | #b91c1c / #f8e9e9 | #f87171 / #351f20 | destructive, errors, rejected palm touch |

Tinted surfaces are **solid** (`*-soft` fills with `*-line` borders), never translucent.

**Paper stays paper**: pages render light in every theme (white #ffffff, cream #fbf7ee), unless the user picks
**Night** paper (#1f1f23 with #e4e4e7 ink). Page rules and dots are #d9dce3 on white and cream, and #34343a on night.
Pages sit on `bg` with shadow-1 plus a hairline line.

Pen colours (the default palette): graphite #27272a, indigo #4338ca, blue #1d4ed8, teal #0f766e, red #b91c1c,
amber #b45309. Highlighters: #fde68a, #bfdbfe, #bbf7d0, #fbcfe8 (multiplied at 0.45).

## Type
- **Figtree** (400/500/600/700) for everything. **Geist Mono** for code, the MCP URL and the activity log.
- Page titles 24–30 semibold with tight tracking. Section titles 16–20 semibold. Body and controls 14–16. Metadata 12.
- Sentence case everywhere. No ALL-CAPS labels. (The mockups' uppercase section labels become sentence-case muted 12px.)
- Typed text boxes on pages use Figtree too.

## Shape and depth
- Radii: controls **8px**, panels **12px**, pills 999px. Notebook covers 4px spine side and 10px open side.
- Hairline borders (`line`) on every surface. shadow-1 `0 1px 2px rgba(0,0,0,.04)` at rest. shadow-2
  `0 18px 40px -16px rgba(0,0,0,.22), 0 0 0 1px rgba(0,0,0,.04)` **only** for overlays (popovers, sheets, the floating toolbar).
- **No gradients, glassmorphism, backdrop blur, glow or decorative blobs.** The floating toolbar is a solid `surface`
  with shadow-2. Avatars are solid fills (agents use `assistant`, people use `accent`).
- Controls are 44px high, with targets of at least 44px on touch. Focus rings stay visible (2px accent-line plus a 1px accent offset).

## Covers
Solid colours from the palette family, with no gradients. Choices: graphite #27272a, indigo #4338ca, blue #1d4ed8, teal #0f766e,
sand #d6c7a8, rose #c9a3a3, sage #a7b8a1, paper #f1efe9. A label sticker is `surface` with ink text.

## Motion and voice
- Brief (120–200 ms) motion for continuity only, respecting reduced motion. Ink never animates.
- The voice is concise, calm and direct. Explain what the AI can see and do in plain words ("Claude can read and comment").

## Mockup → brand mapping
| Mockup | Becomes |
|---|---|
| green accent #2F6F5E | accent indigo (actions) or assistant blue (AI) |
| amber comment pins | assistant blue pins with an assistant-soft anchor highlight |
| Inter, JetBrains Mono, Caveat | Figtree, Geist Mono (Caveat was only mockup handwriting) |
| blurred translucent toolbar | solid surface + shadow-2 |
| gradient avatars and covers | solid fills |
| "UPPERCASE" section labels | sentence-case muted 12px |
