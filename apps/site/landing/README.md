# qalm.apollolearn.app: the site's pages

This folder generates everything in `apps/site/public/`: the landing page, the legal pages, Contact, the 404 page and
the "not available yet" page for downloads. The handwriting is not a font. Glyph centerlines are drawn by hand, then
turned into variable-width ink by perfect-freehand with qalm's own fountain-pen settings (the same as
`packages/core/src/geometry/stroke.ts`), and written into the pages as inline SVG.

## Regenerate

From the repo root, after `pnpm install`:

```bash
pnpm --filter @qalm/site build:landing   # public/*.html, favicon.svg, robots.txt, sitemap.xml
pnpm --filter @qalm/site build:og        # public/og.png (1200×630) and apple-touch-icon.png: needs Chrome
pnpm --filter @qalm/site build:site      # the whole site: runs build:landing, then adds the web app at dist/app/
```

The output is deterministic: every piece of ink uses a seeded random generator, so an unchanged build reproduces
`public/` byte for byte. Edit the sources here, never `public/*.html`. Run `build:og` after changing the hero or the
mark. It uses Chrome from `CHROME_PATH`, or the default Windows install.

## Files

| File | What it holds |
|---|---|
| `build.mjs` | Writes `public/`: every page, `favicon.svg`, `robots.txt` and `sitemap.xml` |
| `site.mjs` | What every page shares: the site facts (operator, emails, "last updated"), `<head>` (meta, OG and Twitter tags, icons, fonts), header, footer, mark, icons |
| `shared.css` | Tokens (`docs/brand.md`), base, buttons, header, footer and the hand-drawn underline |
| `template.html` + `landing.mjs` | The landing page and the generated ink it needs |
| `legal.mjs` | The words of Privacy, Terms and Data rights, in Apollo's structure, with a note on where each fact comes from in qalm's code |
| `pages.mjs` | The layouts for the legal pages, Contact, 404 and "not available yet" |
| `ink.mjs` | The glyphs (`G`: centerlines in an em box, baseline 0, x-height −48), the pressure model, stroke outlines, and `layout()` for maths (`{sup:[…]}`, `{frac:[num, den]}`) |
| `pieces.mjs` | The hero page (`hero()`) and its timing, the nib samples and the AI region crop |
| `og.mjs` | The social preview and the touch icon |
| `shot.mjs` | Screenshots with headless Chrome |

## Common changes

- **Legal facts change** (a provider, sign-in, storage limit, retention, account deletion): edit `legal.mjs`, set
  `UPDATED` in `site.mjs`, and rebuild.
- **Download links:** the buttons point at `/download/windows` and `/download/android`; the Worker streams the
  installers from R2 (`src/worker.js`, `src/routes.js`). Upload `windows/qalm-setup.exe` and `android/qalm.apk` to the
  `DOWNLOADS` bucket (`qalm-downloads-staging` or `qalm-downloads`).
- **Different handwriting on the hero:** edit the `layout([...])` lines in `hero()` (`pieces.mjs`). Lines marked
  `pre: true` are already on the page; the rest write themselves on. Add any missing glyph to `G` in `ink.mjs`.
  Changing a seed (`rng(7)` etc.) gives a differently imperfect hand.
- **Faster or slower writing:** `v` (pen speed) and `t0` (start delay) at the end of `hero()`, or `speed` on one block.

## Screenshots

```bash
node apps/site/landing/shot.mjs <page.html or http://…> <outDir> \
  hero-1440-light:1440:900:light:wait=11000 \
  full-390-dark:390:844:dark:full:motion=reduce
```

A spec is `name:width:height:light|dark`, then optional `full`, `lazy` (scroll through first so lazy images load),
`motion=reduce`, `wait=ms`, `dpr=2`, `scroll=selector`.
