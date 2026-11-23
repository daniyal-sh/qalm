# qalm: handover

You are picking up **qalm** (by Apollo), a handwriting note-taking app. Agents built the whole repo in one long thread.
This file summarises that thread: what was decided, what exists, what was verified, what's left, and how the owner
likes to work. Read it first, then `docs/decisions.md`, `docs/tech-spec.md`, `docs/qink-live.md` and `docs/brand.md`.

## 1. What qalm is

- A GoodNotes-style app for handwritten notes. Pages first; an infinite canvas comes later.
  - PDF import and annotation, images.
  - Ink should be smooth and beautiful, with strong palm rejection.
- Platforms, all at launch: **iPad, Android tablets, Windows and macOS.** Linux and stylus phones are not a priority.
- **AI-friendly through MCP only.** A remote agent, such as a tutor LLM on another machine, follows a live writing
  session token-efficiently. It gets **regions** (crops of the ink that changed, with the ink around it) and reads the
  handwriting itself. It can **read**, **comment** on ink, and save its reading of some ink (**transcribe**). It can
  **never edit ink**.
- Branding: **"qalm" is always lowercase**, in UI, window titles, installers, emails and docs. The byline is
  "by Apollo". It belongs to the Apollo family alongside Board (`daniyal-sh/apollo`, private, and `daniyal-sh/board`).
  The UI follows Apollo Study Space: see `docs/brand.md`.

## 2. Owner preferences (follow these)

- **Don't overengineer.** "Just make it simple so it's accurate." Don't ship analyzers or server-side AI.
- **Ask questions with the question tool** (multiple choice) when a decision is the owner's to make.
- **Build with subagents:** when delegating, use Claude **Opus 5.5 at medium effort**
  (`{"providerInstanceId":"claudeAgent","model":"claude-opus-5-5","options":{"effort":"medium"}}`). Keep under ~5
  agents at once, give each a separate worktree and a non-overlapping file list, and tell them to commit early and often.
- Commit on feature branches. Don't push or deploy unless asked. Commit messages end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Secrets only in env or `apps/server/.dev.vars`, which is gitignored. Never commit them.
- Visual style:
  - Apollo tokens.
  - Figtree and Geist Mono.
  - Solid tints with hairline borders.
  - 8/12 px radii and 44 px controls.
  - **No gradients or blur.**
- The owner reviews visually. When UI changes, show screenshots: `scratchpad/shots.cjs` drove headless Chrome over
  CDP against the web export. Recreate it if needed.

## 3. Decisions, from the owner's answers

| Area | Decision |
|---|---|
| Users | General note-takers |
| Stack | React Native (Expo) for iPad and Android, Electron for desktop, a native live-ink surface. Agents chose the rest |
| Shared core | TypeScript, not Rust |
| v1 tools | Pen, highlighter, eraser, lasso select and move, typed text boxes, shape snapping, PDF import and annotation, images |
| Not in v1 | Handwriting search, sharing with other people, audio, stickers, templates, infinite canvas |
| Export | PDF (ink flattened) and `.qalm` (full-fidelity backup) |
| Recognition | **None on device** (ML Kit removed; the app is ~20 MB lighter per language). The agent reads handwriting from the image with its own vision |
| Pen extras | Hover preview; pen button, squeeze or double-tap for the eraser; tilt shading |
| Minimum OS | iPadOS 17, Android 10, Windows 10, macOS 13 |
| Accounts | Apple, Google and email magic link. Cloud sync from day one. Free in beta with capped storage, no payments |
| Backend | Cloudflare: Workers, Durable Objects, R2, D1. Encrypted at rest (Cloudflare default), no E2E |
| AI | MCP only. Updates go out on a pen pause (≥ 6 s) or the **Ask** button, at most one per 20 s (Ask exempt). What changed is sent as **regions** (Q-ink v1.0): new ink black, context grey, erased red, on a 0–1000 grid. No lines (they split maths apart). `transcribe` saves a reading of strokes. The agent keeps its own chat history; updates are self-contained |
| Server AI | **None.** The image crop goes to the user's agent, which reads it |

**Cost estimates** (GPT-6 Luna: $0.10/M in, $0.01/M cached, $0.50/M out), one hour of maths tutoring:

| Approach | Uncached | Cached |
|---|---|---|
| Full-page screenshots | ~$1.36/h | ~$0.17/h |
| Q-ink Live v0.2 | ~$0.13/h | ~$0.025/h |

The first thing to measure with a real client is how each provider counts image tokens.

## 4. Architecture (details in `docs/tech-spec.md`, rev 2)

```
packages/core      @qalm/core  TypeScript: Yjs model (Notebook/Page/Library), geometry, render helpers,
                               PDF + .qalm export, Q-ink encoding/labels/refs
modules/qalm-ink   qalm-ink    Expo native module:
                               - PageCanvas: the ONE Skia renderer for finished content, everywhere
                                 (CanvasKit on web and Electron)
                               - InkOverlay: draws only the live stroke natively
                                 (iOS: coalesced and predicted UITouch; Android: front-buffered renderer and
                                 MotionEventPredictor; web: desynchronized canvas and getCoalescedEvents)
                               - QalmInk.renderPdfPage (PDFKit, PdfRenderer, pdf.js). No recognition: ML Kit was removed
apps/app           @qalm/app   Expo SDK 58, expo-router, New Architecture, RN 0.88, React 19.3
apps/desktop       @qalm/desktop  Electron shell loading the app's web export over a privileged app://qalm protocol
apps/server        @qalm/server   Cloudflare Worker: auth, DocRoom Durable Object (Yjs sync), R2 assets, D1, MCP + OAuth
```

- **Data model:**
  - **Docs:** one Yjs doc per user library (`lib:{userId}`), per notebook index (`nb:{id}`) and per page (`pg:{nb}:{page}`).
  - **Origins:** every local mutation uses `LOCAL_ORIGIN`. The one-time migration from lines uses `MIGRATION_ORIGIN`
    and stays out of undo.
  - **Undo:** per device, via `Y.UndoManager` (`createUndoManager`).
- **No lines (regions, rev 3):** the model has no line grouping. Agents get regions computed when an update goes out
  (`packages/core/src/geometry/regions.ts`, `qink.ts`): changed strokes clustered (gap < 2 units; unit = ruling, else
  2.5 × median stroke height), plus context (≤ ½ unit, then along the row < 1½ units). Region labels (`R7`) are
  notebook-wide, never reused, stored by the notebook DocRoom with their strokes and box. **Readings** are of strokes
  (`readings` map: agent or student, stale flag); **comments** anchor to stroke ids (`anchorIds`) with a box fallback.
  Old pages are migrated once on load (`migratePage`).
- **Stroke geometry:** perfect-freehand 1.2.3 with pinned settings, ported to Swift and Kotlin.
  - **Same path everywhere:** M p0, then `Q p[i] mid(p[i],p[i+1])`, then close; fewer than 4 points uses lines.
  - **Parity test:** a JVM test checks the Kotlin port against a fixture from core (`pnpm --filter qalm-ink gen:fixture`).
- **Coordinates and zoom:** PDF points, with A4 at 595×842. Zoom runs 0.75–4× and re-lays out at the end of the
  gesture. PDF backgrounds render at width buckets 1/2/4×.
- **Palm rejection:**
  - **Thresholds** use the contact's full major axis in mm: relaxed 9, standard 7, strict 5.
  - **Pen priority:** a 600 ms pen lockout, and the writing-hand side is considered for 3 s.
  - **Retractions:** an OS cancel retracts the stroke, as does a second finger or a contact that grows into a palm.
  - **Fingers:** with "pen only" they scroll; a rejected palm never scrolls.
  - **Parity:** the same rules apply on iOS, Android and web.
- **Hand-off:** the overlay keeps a finished stroke on screen until its id shows up in `committedIds` (reported by
  `PageCanvas`'s `onDrawn` once Skia has it) plus 2 frames (web) or 50 ms (native), with a 4 s fallback.
  On native, the brush-width prop is `strokeWidth`. The name `width` collided with Fabric's layout width.
- **Server (§4):**
  - **Sync:** one-time 30 s sync tickets (`POST /sync/ticket`, then `/sync/{docId}?ticket=`). DocRoom uses
    hibernating WebSockets and compacts every 200 updates.
  - **Access:** every doc is checked against its owner. Assets in R2 are content-addressed (sha256), readable only by
    their uploader, and capped per user (1 GiB by default).
  - **Agents:** MCP at `/mcp` (Streamable HTTP, OAuth 2.1 with dynamic client registration, via
    `@cloudflare/workers-oauth-provider`) exposes 4 tools: `wait`, `read`, `transcribe`, `comment`. Region images are
    rendered to PNG with resvg-wasm.

## 5. Status: what exists and what's verified

All on `main` (the agents' working branch was `build/v1`). Every package type-checks cleanly. Test counts:

| Package | Tests | Other verification |
|---|---|---|
| core | 137 | Regions (clustering, context, the owner's page, first look, erased, labels, refs), readings stale rules, migration |
| server | 33 | `wrangler dev` smoke test; `wrangler deploy --dry-run` (bundle ~1.1 MB gzipped) |
| app | 128 | Every round-2 PR checked in headless Chrome, offline and signed in against `wrangler dev` with a scripted MCP agent |
| qalm-ink | JVM freehand parity test (31 style × smoothing cases) | Android `assembleDebug` (x86_64); drawing on an emulator and on web |
| desktop | 3 unit | Packaged `qalm.exe` end-to-end test (Playwright): library, open notebook, draw, reload route, PDF export via the native save dialog, deep link, no console errors |

**Round 2 (PRs #1–#24, all merged; audit issue #14 covers the findings):**
- **Ink:** no blank frame when a stroke ends (PageCanvas reports what it drew; #5); pen styles fountain/ball/brush and
  stroke smoothing low/medium/high, stored per stroke, identical in core/web/Kotlin/Swift (#6); default ink follows the
  paper colour (#24).
- **Editing:** lasso tap-select, box select, handles to move/resize/rotate, inline text editing, clipboard incl. paste
  from other apps on web/desktop, Ctrl/Cmd shortcuts (#8, #20); hold-to-snap shapes at 350 ms incl. rotated rects and
  ellipses, diamond, pentagon, hexagon, star, double arrow (#11); custom colours: picker + synced swatches per tool,
  per-colour highlighter opacity (#12); maths symbols in text boxes via a Noto Sans Math subset (#20).
- **Performance:** chunked Skia pictures, page windowing, nearest-first page loading, PDF render queue and LRU, page-doc
  LRU that keeps undo (#9); batched/incremental line assignment (3000-stroke move 2.4 s → ~45 ms; #13). Benchmark
  harness in the repo (300-page notebook).
- **Pages:** page navigator (thumbnails, reorder, duplicate, delete, bookmarks, Ctrl+G; #10); Paper… and Cover… (#24).
- **AI** (protocol in `docs/qink-live.md` v0.4): threads both ways (`note`, `re`, `comment` with `thread`/`resolve`),
  Ask about a selection with a crop row (#1, #7); presence pill with Pause sharing / Stop, "Thinking…", margin comment
  cards that follow their ink (#7, #8); robust malformed Asks and open-threads-only for a new agent, `read("C5")` (#15);
  Readings: view and edit a line's text, agent names on transcriptions (#22); notebook-wide thread index for the panel,
  badge and toasts (#23); accessible comments panel and real read state (#21).
- **Correctness/polish:** no ghost notebooks, Asks never dropped, Add page scrolls, undo after page delete (#16);
  night-paper ink, no empty text boxes, measured text height (#17); PDF export with Figtree + Symbol, WebP/GIF
  conversion, clipboard across restarts, dev-server reload (#18); in-app confirm dialogs and toolbar/library/settings
  polish (#19); hermetic server tests (#4).

**What the app has:**
- **Sign-in:**
  - Apple (iOS), Google (when configured) and email link or 6-digit code.
  - You can continue without an account.
- **Library:**
  - Folders, favorites, "Shared with AI", trash and restore, and delete forever (which also deletes on the server).
  - Search, covers with a spine, and the new-notebook sheet.
  - PDF import and `.qalm` import (a restore always creates a NEW notebook, with AI access off).
- **Editor:**
  - **Pages:** a virtualised page list, the toolbar, zoom (pinch, Ctrl+wheel, ±), undo/redo, and add or delete pages.
  - **Writing tools:** pen, highlighter, eraser, lasso (move, recolour, duplicate, delete), text boxes, images and
    shape snapping.
  - **PDFs:** PDF backgrounds.
  - **AI:** the comments panel (docked at ≥ 1100 px, floating below that, closed when the window narrows), Ask, and
    Reading (what an agent read in the selected ink, with a "stale" badge; editable).
- **Settings:**
  - Account and pen/palm settings with a test area.
  - AI access: connect URL, pending requests, per-agent comment and transcribe switches, a notebook picker and an
    activity log.
  - Appearance: system, light or dark.
- **Desktop:**
  - **Security:** sandboxed with context isolation; IPC checks the sender and validates its arguments.
  - **Shell:** `qalm://` deep links; external links open in the system browser; **no menu bar on Windows** (macOS keeps
    its system menu).
  - **Profile:** moved once from `%APPDATA%\Apollo Qalm` to `%APPDATA%\qalm`.
  - **Packaging:** electron-builder: NSIS installer for x64 and arm64, macOS universal DMG with the hardened runtime;
    notarization only when its env vars are set.

**Final review: all 11 findings fixed and tested.**
- **AI access switch:** enforced on every MCP call. It was ignored by the server before.
- **Trashed and deleted notebooks:** hidden from agents and from consent. Delete forever tombstones the notebook
  (D1 `deleted_at`, tickets refused, rooms purged).
- **Magic links (login CSRF):**
  - **Device binding:** links are bound to the requesting device with a nonce.
  - **Other links:** a link this device didn't ask for asks "Sign in as x@y?".
  - **Notebooks made while signed out:** moving them into the account is an explicit choice.
- **GET never uses up a link or returns tokens.** It shows a page with a Continue button. There's a 6-digit code fallback.
- **Refresh tokens:** a 60 s grace window after rotation, and cross-tab refresh via `navigator.locks` plus a re-read.
- **Signed-out notebooks:** merged into the account on every sign-in, not just once per device.
- **Native snapshot writes:** crash-safe (`.tmp`, `.bak`, fallback reads).
- **Rate limits:** 5 sign-in emails per address and 20 per IP per hour.
- **Sign-out:** `POST /auth/logout` ends the server session.
- **iOS palm size:** uses `2 × majorRadius`, matching Android and web.

D1 migrations: `0001_init`, `0002_user_assets`, `0003_notebook_deleted`, `0004_auth_hardening`.

## 6. Not verified, and known gaps

- **iOS has never been compiled.** There was no Mac or Xcode. The Swift code, including `QalmInkView.swift`,
  `Freehand.swift` and the `strokeWidth` rename, needs a Mac build and an iPad test.
- **No real stylus testing anywhere.** Pressure, tilt, hover, the pen button, `FLAG_CANCELED` and front-buffered latency
  are untested. The Android emulator only injects finger input.
- `renderPdfPage` on Android hasn't been run on a device. (ML Kit is gone, so there's no model download to test.)
- **Regions are tuned on synthetic handwriting.** The clustering and context constants (2 / ½ / 1½ units) and the image
  scale (64 px per unit) need checking on real pages and with a real MCP client (image token counts per provider).
- **Sign-in:** Apple and Google are untested end to end, and they **don't work in the desktop app** (no redirect back
  into the app; this needs a web redirect page). Real Resend email delivery is untested.
- **Agents:** no real MCP client has connected yet, and image-token costs per provider haven't been measured.
- **Builds:** the macOS DMG and the Windows arm64 installer haven't been built. Nothing is signed.
- **Not deployed.** The Cloudflare resource ids in `apps/server/wrangler.jsonc` are placeholders.
  `MAGIC_LINK_URL` assumes the web app lives at `https://qalm.app/auth/email/verify`; for local dev use
  `http://localhost:8081/auth/email/verify`.
- **Round 2, untested on devices:** pen styles/smoothing feel, the 50 ms native ink hand-off, tap-vs-scroll and handle
  dragging with touch/stylus, swatch drag in the toolbar, the new dialogs/sheets and the maths fallback font on
  iOS/Android, thumbnails and chunked pictures on a real GPU. Swatch sync and the thread index were only tested with
  two in-process docs, not two signed-in devices.
- **Smaller gaps:**
  - Paste from other apps is web/desktop only; native Paste uses qalm's own clipboard.
  - Selecting a far comment thread scrolls to the top of its page, not its line.
  - Emptying an existing text box and reloading (without the page unmounting) keeps the empty box.
  - Arcs aren't recognised as shapes; there's no snap preview while holding.
  - Fractions like ⅔ have no glyph on the page; PDF export uses Symbol, so symbol-heavy lines may wrap differently.
  - Pinch zoom on tablets works only with "pen only"; with "pen and finger" use the ± buttons.
  - The live highlighter uses plain alpha; finished highlights use multiply.
  - The Android overlay sits on top of the window (`setZOrderOnTop`), so UI placed over the page would be hidden.
  - After logout, access JWTs stay valid for up to 1 h and open sync sockets aren't closed.
  - The Electron page has no Content-Security-Policy.

## 7. How to run

```bash
pnpm install                    # pnpm 12; nodeLinker: hoisted is set in pnpm-workspace.yaml (pnpm 10+ ignores .npmrc for it)
node node_modules/electron/install.js   # fresh clones: Electron's download script may not run during install
pnpm typecheck && pnpm test     # all packages

# server (needs apps/server/.dev.vars: copy .dev.vars.example; dev emails, incl. the 6-digit code, are logged to the console)
pnpm --filter @qalm/server migrate:local
pnpm --filter @qalm/server dev  # wrangler dev, http://127.0.0.1:8787

# app on web (offline-only unless EXPO_PUBLIC_QALM_SERVER_URL is set at build time)
EXPO_PUBLIC_QALM_SERVER_URL=http://127.0.0.1:8787 pnpm --filter @qalm/app web
pnpm --filter @qalm/app export:web      # -> apps/app/dist

# desktop (Windows)
pnpm --filter @qalm/desktop build       # web export + icons + electron-builder --dir -> apps/desktop/release/win-unpacked/qalm.exe
pnpm --filter @qalm/desktop e2e

# Android example for the ink module
cd modules/qalm-ink/example/android && ./gradlew assembleDebug --max-workers=1
```

App env vars: `EXPO_PUBLIC_QALM_SERVER_URL`, plus `EXPO_PUBLIC_GOOGLE_{WEB,IOS,ANDROID}_CLIENT_ID`. Server secrets are
listed in `apps/server/.dev.vars.example`.

**Environment gotchas** (from the development PC: Windows 11, 15 GB RAM):
- **`ELECTRON_RUN_AS_NODE=1`** can leak in from hosts that are Electron apps, and it turns `qalm.exe` into plain Node.
  Unset it before launching. The dev and e2e scripts already strip it.
- **Memory is tight.** clang, Metro, workerd and tsc have all run out of memory. Use
  `NODE_OPTIONS=--max-old-space-size=3072`, Metro/Expo with `--max-workers 2`, Gradle with `--max-workers=1`, and build
  react-native-skia's native code with `ninja -j1` if needed. Run one heavy build at a time.
- **Windows path lengths:** Gradle output inside worktrees can exceed path limits. Delete with
  `Remove-Item -LiteralPath '\\?\C:\…' -Recurse`.
- **Stop only your own processes.** Never kill `workerd`, `java` or `node` machine-wide; the owner runs other projects
  on this machine.

**Staging on Cloudflare** (owner's account, workers.dev subdomain `apollolearn`):
- Web app: `https://qalm-web-staging.apollolearn.workers.dev` (Worker `qalm-web-staging`, static assets from
  `apps/app/wrangler.jsonc`, SPA fallback).
- API + MCP: `https://qalm-api-staging.apollolearn.workers.dev` (`/mcp` for agents; Worker `qalm-api-staging`, env
  `staging` in `apps/server/wrangler.jsonc`): D1 `qalm-staging`, R2 `qalm-assets-staging`, KV `qalm-oauth-staging`.
- Secrets: `JWT_SECRET` (random), `RESEND_API_KEY` (owner sets it: `npx wrangler secret put RESEND_API_KEY --env
  staging` in `apps/server`). Email is sent as `qalm <qalm@apollolearn.app>` via the owner's Resend domain.
- Deploy: `pnpm --filter @qalm/server migrate:staging`, `pnpm --filter @qalm/server deploy:staging`, then
  `EXPO_PUBLIC_QALM_SERVER_URL=https://qalm-api-staging.apollolearn.workers.dev pnpm --filter @qalm/app deploy:staging`.
- `apollolearn.app` DNS is on Vercel, so custom domains (e.g. `qalm.apollolearn.app`) need either moving its DNS to
  Cloudflare or hosting the web app on Vercel. Decide before production.

## 8. Suggested next steps

1. **Mac:** build iOS (`expo run:ios`; the podspec now depends only on `ExpoModulesCore`, no ML Kit pod) and test on an iPad
   with an Apple Pencil: latency, palm rejection, hover, squeeze and double-tap, and PDF rendering. Build
   the macOS DMG too.
2. **Android tablet with a stylus:** test the same list, plus whether the front-buffered renderer's latency feels right.
3. **Deploy staging on Cloudflare**, once the owner agrees and with their accounts:
   - create D1, R2 and the Durable Objects;
   - set the secrets (JWT, Resend, Apple and Google);
   - apply the migrations;
   - set `MAGIC_LINK_URL` to the real web app.
4. **Connect a real MCP client** (e.g. Claude) and measure tokens per update against the `docs/qink-live.md` estimates.
5. **Desktop Google and Apple sign-in:** add a web redirect page that hands off to `qalm://`.
6. **Smaller gaps from §6**, as the owner prioritises them. Ask before adding scope.

## 9. Thread history (brief)

1. **Discovery:**
   - Rounds of questions with the question tool, and HTML mockups (`mockups/`).
   - The token-cost analysis.
   - Q-ink Live simplified to v0.2: no server AI, image plus guess, `transcribe`.
2. **Brand:** inspired by the Apollo and Board repos: tokens, the pen-nib-in-orbit mark (`assets/brand/qalm-mark.svg`).
3. **Spec rev 2** after the owner's review:
   - one Skia renderer, and race-free line keys;
   - per-page docs, with PDF rendering on native;
   - zoom and undo, and sync tickets;
   - palm thresholds in mm, and consistent desktop recognition.
4. **Phase 1:** core and the iOS overlay. **Phase 2:** server, app, and the Android and web overlays. The work survived
   several rate-limit and out-of-memory interruptions by committing agents' WIP and relaunching them.
5. **Integration:**
   - **Desktop:** the Electron shell.
   - **Fixes:** a flaky Yjs undo test made deterministic; a webcrypto shim for lib0 on native (expo-crypto).
   - **UI:** the comments panel layout, the library title opening the notebook, and the cover spine.
6. **Final review** by a fresh agent found 11 issues; two agents fixed them in parallel.
7. **Rename to lowercase "qalm" everywhere** and **no menu bar** on Windows (owner request, after testing the packaged
   desktop app).
8. **Round 2** (owner: "audit qalm in detail… polished UX like GoodNotes… make a lot of PRs"):
   - **Owner decisions:** keep the MCP general (no tutor mode); hold-to-snap shapes; lasso + tap-to-select; colour
     picker + synced swatches; page navigator and pen styles; a new agent gets open threads only; build Readings and
     Paper/Cover rather than dropping the promises.
   - **Process:** agents opened PRs; the lead verified each (all package checks on the merged result) and merged.
     PRs #1–#24 merged; #2/#3 were replaced by #7 after a stacked-merge mistake. A full audit (issue #14, 35 findings)
     drove the fix PRs.
   - **Environment:** T3 restarts and API rate limits interrupted agents repeatedly; agents now push early as draft
     PRs. Use a random free Chrome debug port in browser checks (two agents once shared 9333).
   - **Mockup:** `mockups/ai-integration.html` explains the AI integration end to end.
9. **Regions (PRs #29, #31):** after a live test where line grouping split maths apart (a superscript ² on its own
   line, each ∫ a separate drawing, two expressions on one rule split) and the agent "corrected" correct work, the owner
   removed lines and on-device recognition (ML Kit, #28): agents get cropped stroke changes (regions) with context and
   coordinates, read handwriting with their own vision, save readings of strokes (stale when the ink changes), and
   comment on strokes. Q-ink Live v1.0 (`docs/qink-live.md`), tech spec rev 3.
