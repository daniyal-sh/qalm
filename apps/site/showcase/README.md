# Showcase screenshots

Reproducible screenshots of qalm for the README and the website: a demo library of a student's notebooks is generated
from code, seeded into a fresh browser profile of the real web app, and captured in each state at tablet and desktop
sizes, in light and dark. Nothing is placed by hand.

## Run it

You need Chrome (`CHROME_PATH`, or the default Windows install) and a checkout with every feature the shots use
(Lecture mode, Play/Pause AI, the ruler and laser, Markdown text boxes). From the repo root:

```bash
# 1. The web export, pointed at the showcase's own local server (port 18917; SHOWCASE_SERVER_PORT to change it)
EXPO_PUBLIC_QALM_SERVER_URL=http://127.0.0.1:18917 pnpm --filter @qalm/app export:web

# 2. Capture (starts `wrangler dev --local` with fresh state, signs in, connects the Tutor agent): out/raw/*.png
node apps/site/showcase/capture.mjs                  # every shot at every size and theme (pnpm --filter @qalm/site showcase)
node apps/site/showcase/capture.mjs --only=ai,lecture --sizes=desktop --themes=dark

# 3. README PNGs, framed site images and the hero composition: apps/site/public/showcase/
node apps/site/showcase/frame.mjs                    # or: pnpm --filter @qalm/site showcase:frame
```

To capture another checkout (an integration branch in a separate worktree, say), set `SHOWCASE_ROOT` to it: the
seed uses that checkout's `@qalm/core`, its web export and its server.

Sizes: desktop 1440 × 900, tablet 1180 × 820 and portrait 820 × 1180, all at DPR 2. The pipeline never touches ports
8787 or 8081, picks a random port for the static server and for Chrome's debugger, and stops only the processes it
started.

## How it works

| File | What it does |
|---|---|
| `hand.mjs` | Handwriting as real pen strokes (below) |
| `assets.mjs` | The lecture slides (HTML printed to PDF by Chrome, maths by MathJax) and the animal cell diagram (SVG → PNG) |
| `content.mjs` | The library: eight notebooks, four folders, favourites, a recorded lecture with its transcript, the tutor's comment threads, built with `@qalm/core` (`Notebook`, `Page`, `Library`, `LectureDoc`) |
| `core.mjs` | Bundles `@qalm/core`'s TypeScript for Node (esbuild) and shares one Yjs with the seed |
| `server.mjs` | `wrangler dev --local` on its own state, email sign-in (the code from the console email) and an MCP agent connected through the real OAuth flow |
| `capture.mjs` | Serves the export, writes the seed into IndexedDB exactly as the app stores it (`y-indexeddb`: one database per doc; assets in `qalm-assets`), signs the profile in, then runs each shot |
| `shots.mjs` | The shots: each drives the app through its UI (keyboard shortcuts, buttons, mouse strokes) into one state |
| `frame.mjs` | Quantised PNGs for the README, WebP and AVIF for the site, window and tablet frames, the hero composition |
| `preview.mjs` | Renders a page of generated ink with `renderPageSvg`, without the app |

**Handwriting.** Glyphs come from single-line fonts (EMS Casual Hand and EMS Allure, SIL OFL: see `fonts/README.md`).
Each glyph's centreline is slanted, jittered in size, rotation, spacing and baseline (with a slow drift along the
line), rounded at its corners like a moving pen, resampled like a digitiser with a slight tremor, and given a pressure
curve (ramping in and out, heavier on downstrokes) and per-point timestamps from a pen speed that slows on curves.
The result is stored as ordinary qalm strokes (fountain pen, smoothing 2), so the app draws it with its own renderer,
and the lecture replay writes it back at the speed it was "written". Circles, underlines and arrows are drawn the same
way; boxes and labelled arrows are snapped shapes, as the app makes them.

**Everything is made up:** Maya Chen, Dr. Amara Okafor, the slides, the diagram and the transcript.
