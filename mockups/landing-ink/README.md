# Landing page ink

These scripts generate `mockups/landing.html`. The handwriting on the page is not a font. Glyph centerlines are drawn by
hand, then turned into variable-width ink by perfect-freehand with qalm's own fountain-pen settings (the same as
`packages/core/src/geometry/stroke.ts`). The result is written into `template.html` as inline SVG.

## Regenerate the page

From the repo root, after `pnpm install`:

```bash
node mockups/landing-ink/build.mjs            # writes mockups/landing.html
node mockups/landing-ink/build.mjs out.html   # or anywhere else
```

The output is deterministic: every piece of ink uses a seeded random generator, so an unchanged build reproduces
`landing.html` byte for byte. Edit `template.html` for page layout, copy and CSS, never `landing.html` directly.

## Files

| File | What it holds |
|---|---|
| `ink.mjs` | The glyphs (`G`: centerline paths in an em box, baseline 0, x-height −48), the pressure model (heavier on downstrokes and slow turns), stroke outlines, and `layout()` for maths: superscripts `{sup:[…]}` and stacked fractions `{frac:[num, den]}` |
| `pieces.mjs` | The hero page (`hero()`), its timing (`timeline()`, pen speed in page units per second), the masked write-on SVG, the nib samples and the AI region crop |
| `build.mjs` | Fills the `{{…}}` placeholders in `template.html`: hero ink, the palm diagram, nibs, crop, PDF annotations, papers, icons, the underline and the mark |
| `template.html` | The page: tokens, layout, copy and the replay script |
| `shot.mjs` | Screenshots with headless Chrome (one browser, closed at the end) |

## Common changes

- **Different handwriting on the hero:** edit the `layout([...])` lines in `hero()` (`pieces.mjs`). Lines marked
  `pre: true` are already on the page; the rest write themselves on. Add any missing glyph to `G` in `ink.mjs`.
- **Change the seed** (`rng(7)` etc.) to get a differently imperfect hand. This also changes the output bytes.
- **Faster or slower writing:** `v` (pen speed) and `t0` (start delay) at the end of `hero()`. The comment card's timing
  follows `--end` automatically.

## Screenshots

```bash
node mockups/landing-ink/shot.mjs mockups/landing.html mockups/landing-shots \
  hero-1440-light:1440:900:light:wait=11800 \
  full-390-dark:390:844:dark:full:motion=reduce
```

A spec is `name:width:height:light|dark`, then optional `full`, `motion=reduce`, `wait=ms`, `dpr=2`. Chrome is taken
from `CHROME_PATH`, or the default Windows install. The committed shots were then halved (1440 and 1024 full pages) and
reduced to 128 colours to stay small.
