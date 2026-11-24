# qalm development guide

How qalm is built, how to run, test, build and self-host it, the decisions behind it, and the known gaps. Read it with
[decisions.md](decisions.md) (v1 scope), [tech-spec.md](tech-spec.md) (architecture and contracts),
[qink-live.md](qink-live.md) (the AI format) and [brand.md](brand.md) (design system).

## 1. What qalm is

- A handwriting note-taking app. Pages first; an infinite canvas comes later.
  - PDF import and annotation, images.
  - Ink should be smooth and beautiful, with strong palm rejection.
- Platforms: **iPad, Android tablets, Windows and macOS**, plus the web. Linux and stylus phones are not a priority.
- **AI-friendly through MCP only.** A remote agent, such as a tutor LLM on another machine, follows a live writing
  session token-efficiently. It gets **regions** (crops of the ink that changed, with the ink around it) and reads the
  handwriting itself. It can **read**, **comment** on ink, and save its reading of some ink (**transcribe**). It can
  **never edit ink**.
- Branding: **"qalm" is always lowercase**, in UI, window titles, installers, emails and docs. The byline is
  "by Apollo". The UI follows Apollo Study Space: see [brand.md](brand.md). The names and logos aren't covered by the
  code's license: see [TRADEMARKS.md](../TRADEMARKS.md).
- Keep it simple: no analyzers and no server-side AI.

## 2. Decisions

| Area | Decision |
|---|---|
| Users | General note-takers |
| Stack | React Native (Expo) for iPad and Android, Electron for desktop, a native live-ink surface |
| Shared core | TypeScript, not Rust |
| v1 tools | Pen, highlighter, eraser, lasso select and move, typed text boxes, shape snapping, PDF import and annotation, images |
| Not in v1 | Handwriting search, sharing with other people, audio, stickers, templates, infinite canvas |
| Export | PDF (ink flattened) and `.qalm` (full-fidelity backup) |
| Recognition | **None on device** (ML Kit was removed; the app is ~20 MB lighter per language). The agent reads handwriting from the image with its own vision |
| Pen extras | Hover preview; pen button, squeeze or double-tap for the eraser; tilt shading |
| Minimum OS | iPadOS 17, Android 10, Windows 10, macOS 13 |
| Accounts | **Email only**: an emailed link or a 6-digit code. Cloud sync from day one. Free in beta with **250 MB per user** (PDFs, images and notebook data), no payments |
| Backend | Cloudflare: Workers, Durable Objects, R2, D1. Encrypted at rest (Cloudflare default), no E2E |
| AI | MCP only. Updates go out on a pen pause (≥ 6 s) or the **Ask** button, at most one per 20 s (Ask exempt). What changed is sent as **regions** (Q-ink v1.0): new ink black, context grey, erased red, on a 0–1000 grid. No lines (they split maths apart). `transcribe` saves a reading of strokes. The agent keeps its own chat history; updates are self-contained |
| Server AI | **None.** The image crop goes to the user's agent, which reads it |

**Cost estimates** (GPT-6 Luna: $0.10/M in, $0.01/M cached, $0.50/M out), one hour of maths tutoring:

| Approach | Uncached | Cached |
|---|---|---|
| Full-page screenshots | ~$1.36/h | ~$0.17/h |
| Q-ink Live v0.2 | ~$0.13/h | ~$0.025/h |

The first thing to measure with a real client is how each provider counts image tokens.

**Why regions, not lines:** in a live test, line grouping split maths apart (a superscript ² on its own line, each ∫ a
separate drawing, two expressions on one rule split) and the agent "corrected" correct work. So lines and on-device
recognition were removed: agents get cropped stroke changes (regions) with context and coordinates, read handwriting
with their own vision, save readings of strokes (stale when the ink changes), and comment on strokes.

## 3. Architecture (details in [tech-spec.md](tech-spec.md), rev 3)

```
packages/core      @qalm/core  TypeScript: Yjs model (Notebook/Page/Library), geometry, render helpers,
                               PDF + .qalm export, Q-ink encoding/labels/refs
modules/qalm-ink   qalm-ink    Expo native module:
                               - PageCanvas: the ONE Skia renderer for finished content, everywhere
                                 (CanvasKit on web and Electron)
                               - InkOverlay: draws only the live stroke natively
                                 (iOS: coalesced and predicted UITouch; Android: front-buffered renderer and
                                 MotionEventPredictor; web: desynchronized canvas and getCoalescedEvents)
                               - QalmInk.renderPdfPage (PDFKit, PdfRenderer, pdf.js)
apps/app           @qalm/app   Expo SDK 58, expo-router, New Architecture, RN 0.88, React 19.3
apps/desktop       @qalm/desktop  Electron shell loading the app's web export over a privileged app://qalm protocol
apps/server        @qalm/server   Cloudflare Worker: auth, DocRoom Durable Object (Yjs sync), R2 assets, D1, MCP + OAuth
apps/site          @qalm/site     Cloudflare Worker: the landing and legal pages, the web app at /app/, downloads
```

- **Data model:**
  - **Docs:** one Yjs doc per user library (`lib:{userId}`), per notebook index (`nb:{id}`) and per page (`pg:{nb}:{page}`).
  - **Origins:** every local mutation uses `LOCAL_ORIGIN`. The one-time migration from lines uses `MIGRATION_ORIGIN`
    and stays out of undo.
  - **Undo:** per device, via `Y.UndoManager` (`createUndoManager`).
- **Regions (no lines):** the model has no line grouping. Agents get regions computed when an update goes out
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
  - **Thresholds** use the contact's full major axis in mm: relaxed 30, standard 20, strict 14 (smaller values rejected
    most fingertips, which are 8–10 mm). The lockout, hand side and multi-touch rules catch smaller palm edges.
  - **Pen priority:** a 600 ms pen lockout, and the writing-hand side is considered for 3 s.
  - **Retractions:** an OS cancel retracts the stroke, as does a second finger or a contact that grows into a palm.
  - **Fingers:** with "pen only" one finger scrolls and two zoom; a rejected palm (or a finger landing right after the pen)
    never moves the page, on web, Android and iOS.
  - **Pen button:** held while writing, it erases only that stroke; pressed while hovering, it's the shortcut.
  - **Parity:** the same rules apply on iOS, Android and web.
- **Hand-off:** the overlay keeps a finished stroke on screen until its id shows up in `committedIds` (reported by
  `PageCanvas`'s `onDrawn` once Skia has it) plus 2 frames (web) or 50 ms (native), with a 4 s fallback.
  On native, the brush-width prop is `strokeWidth`. The name `width` collided with Fabric's layout width.
- **Server:**
  - **Sync:** one-time 30 s sync tickets (`POST /sync/ticket`, then `/sync/{docId}?ticket=`). DocRoom uses
    hibernating WebSockets and compacts every 200 updates. The client pings after 20 s of silence (the room auto-responds
    `pong` without waking) and reconnects if nothing comes back within 8 s, on `online` and in the foreground.
  - **Access:** every doc is checked against its owner. Assets in R2 are content-addressed (sha256), readable only by
    their uploader. Each user has **250 MB** (`MAX_USER_STORAGE_BYTES`) for assets plus notebook data: DocRooms report
    their stored bytes to D1 `doc_sizes`; `GET /me/storage` sums both. Over the cap, asset uploads get a 413; sync never stops.
  - **Agents:** MCP at `/mcp` (Streamable HTTP, OAuth 2.1 with dynamic client registration, via
    `@cloudflare/workers-oauth-provider`) exposes 4 tools: `wait`, `read`, `transcribe`, `comment`. Region images are
    rendered to PNG with resvg-wasm.
  - **Security:** the AI access switch is enforced on every MCP call; trashed and deleted notebooks are hidden from
    agents and from consent; delete forever tombstones the notebook (D1 `deleted_at`, tickets refused, rooms purged).
    Magic links are bound to the requesting device with a nonce, a link this device didn't ask for asks "Sign in as
    x@y?", and GET never uses up a link or returns tokens (a page with a Continue button; a 6-digit code fallback).
    Refresh tokens have a 60 s grace window after rotation. Rate limits: 5 sign-in emails per address and 20 per IP per
    hour. `POST /auth/logout` ends the server session. Delete account (Settings → Delete account, confirmed by an
    emailed 6-digit code) deletes everything on the server, idempotently (`apps/server/src/account.ts`).
  - **D1 migrations:** `0001_init`, `0002_user_assets`, `0003_notebook_deleted`, `0004_auth_hardening`, `0005_storage`
    (`doc_sizes`), `0006_account_delete` (`magic_links.purpose`, `users.deleting_at`). `users.apple_sub` and
    `google_sub` are unused since email-only sign-in and stay in place.
- **Desktop:** sandboxed with context isolation; IPC checks the sender and validates its arguments. `qalm://` deep
  links; external links open in the system browser; no menu bar on Windows (macOS keeps its system menu). The profile
  moved once from `%APPDATA%\Apollo Qalm` to `%APPDATA%\qalm`. electron-builder makes an NSIS installer for x64 and
  arm64 and a macOS universal DMG with the hardened runtime; notarization runs only when its env vars are set.

## 4. What the app has

- **Sign-in:** email only. One field sends a link and a 6-digit code; "Check your email" takes the code (or the pasted
  link), with resend after 30 s and "Use a different email". You can continue without an account; notebooks made while
  signed out are merged into the account on sign-in, as an explicit choice.
- **Library:** folders, favorites, "Shared with AI", trash and restore, and delete forever (which also deletes on the
  server). Search, covers with a spine, and the new-notebook sheet. PDF import and `.qalm` import (a restore always
  creates a NEW notebook, with AI access off).
- **Editor:**
  - **Pages:** a virtualised page list, the toolbar, zoom (pinch, Ctrl+wheel, ±), undo/redo, add or delete pages, a
    page navigator (thumbnails, reorder, duplicate, delete, bookmarks, Ctrl+G), Paper… and Cover…, fullscreen focus.
  - **Writing tools:** pen (fountain/ball/brush, smoothing low/medium/high, stored per stroke), highlighter, eraser,
    lasso (tap-select, box select, handles to move/resize/rotate, recolour, duplicate, delete, clipboard), text boxes
    (maths symbols via a Noto Sans Math subset), images, custom colours with synced swatches per tool.
  - **Shapes:** hold-to-snap, live: hold 400 ms within 2.5 mm and the shape snaps under the pen (lines, arrows,
    rectangles incl. rotated, ellipses, triangles, diamond, pentagon, hexagon, star, double arrow); drag to
    resize/rotate, lift to place; one undo restores the stroke.
  - **PDFs:** PDF backgrounds; PDF export with Figtree + Symbol.
  - **AI:** threads both ways (`note`, `re`, `comment` with `thread`/`resolve`); Ask about a selection; a presence pill
    with Pause sharing / Stop and "Thinking…"; margin comment cards that follow their ink; the comments panel (docked at
    ≥ 1100 px, floating below that); Reading (what an agent read in the selected ink, with a "stale" badge; editable).
- **Settings:** account, pen and palm settings with a test area; AI access (connect URL, pending requests, per-agent
  comment and transcribe switches, a notebook picker and an activity log); appearance (system, light or dark).

## 5. Status and tests

Every package type-checks cleanly. CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) runs the typecheck
and the unit tests below on every pull request.

| Package | Tests | Other verification |
|---|---|---|
| core | vitest | Regions (clustering, context, first look, erased, labels, refs), readings stale rules, migration |
| server | vitest in workerd (`@cloudflare/vitest-plugin`) | `wrangler dev` smoke test; `wrangler deploy --dry-run` (bundle ~1.1 MB gzipped) |
| app | vitest | Checked in headless Chrome, offline and signed in against `wrangler dev` with a scripted MCP agent |
| site | `node --test` | The Worker's routes: SPA fallback, downloads |
| desktop | `node --test` (unit) | `pnpm --filter @qalm/desktop e2e`: packaged `qalm.exe` end to end (Playwright): library, open notebook, draw, reload route, PDF export via the native save dialog, deep link, no console errors |
| qalm-ink | JVM freehand parity test (31 style × smoothing cases) | Android `assembleDebug` (x86_64); drawing on an emulator and on web |

## 6. Known gaps

- **iOS has never been compiled.** The Swift code, including `QalmInkView.swift`, `Freehand.swift`, the
  `strokeWidth` rename and live shapes, needs a Mac build and an iPad test.
- **No real stylus testing anywhere.** Pressure, tilt, hover, the pen button, `FLAG_CANCELED` and front-buffered latency
  are untested. The Android emulator only injects finger input.
- `renderPdfPage` on Android hasn't been run on a device.
- **Regions are tuned on synthetic handwriting.** The clustering and context constants (2 / ½ / 1½ units) and the image
  scale (64 px per unit) need checking on real pages and with real MCP clients (image token counts per provider).
- **Sign-in emails** haven't been checked across inboxes (Gmail, Outlook, Apple Mail dark mode).
- **Builds:** the macOS DMG and the Windows arm64 installer haven't been built. Nothing is code-signed.
- **Untested on devices:** pen styles/smoothing feel, the 50 ms native ink hand-off, tap-vs-scroll and handle dragging
  with touch/stylus, swatch drag in the toolbar, the dialogs/sheets and the maths fallback font on iOS/Android,
  thumbnails and chunked pictures on a real GPU. Swatch sync and the thread index were only tested with two in-process
  docs, not two signed-in devices.
- **Live shapes:** tested on web/Electron (a desktop e2e step); on Android only `LiveShape.kt` has a JVM test (the view
  wiring is uncompiled); iOS never compiled. Needs a real-stylus feel check.
- **Smaller gaps:**
  - Paste from other apps is web/desktop only; native Paste uses qalm's own clipboard.
  - Selecting a far comment thread scrolls to the top of its page, not its line.
  - Emptying an existing text box and reloading (without the page unmounting) keeps the empty box.
  - Arcs aren't recognised as shapes.
  - Fractions like ⅔ have no glyph on the page; PDF export uses Symbol, so symbol-heavy lines may wrap differently.
  - Pinch zoom on tablets works only with "pen only"; with "pen and finger" use the ± buttons.
  - The live highlighter uses plain alpha; finished highlights use multiply.
  - The Android overlay sits on top of the window (`setZOrderOnTop`), so UI placed over the page would be hidden.
  - After logout, access JWTs stay valid for up to 1 h and open sync sockets aren't closed. Other devices keep their
    local copies after an account is deleted until they sign out (their refresh fails within an hour).
  - The Electron page has no Content-Security-Policy.

Next steps, roughly in order: build and test iOS and the macOS DMG on a Mac with an Apple Pencil; test on an Android
tablet with a stylus; connect real MCP clients and measure tokens per update against the
[qink-live.md](qink-live.md) estimates; then the smaller gaps.

## 7. How to run

```bash
pnpm install                    # nodeLinker: hoisted is set in pnpm-workspace.yaml (pnpm 10+ ignores .npmrc for it)
node node_modules/electron/install.js   # fresh clones: Electron's download script may not run during install
pnpm typecheck && pnpm test     # all packages

# server (needs apps/server/.dev.vars: copy .dev.vars.example; dev emails, incl. the 6-digit code, are logged to the console)
pnpm --filter @qalm/server migrate:local
pnpm --filter @qalm/server dev  # wrangler dev, http://127.0.0.1:8787

# app on web (offline-only unless EXPO_PUBLIC_QALM_SERVER_URL is set at build time). Dev and export:web stay at the
# root (http://localhost:8081/); only the site build (below) uses the base path /app.
EXPO_PUBLIC_QALM_SERVER_URL=http://127.0.0.1:8787 pnpm --filter @qalm/app web
pnpm --filter @qalm/app export:web      # -> apps/app/dist, at the root (the desktop app uses this)

# website: landing at /, the web app at /app/ (one Worker, apps/site)
EXPO_PUBLIC_QALM_SERVER_URL=http://127.0.0.1:8787 pnpm --filter @qalm/site build:site   # -> apps/site/dist (+ dist/app)
pnpm --filter @qalm/site preview        # wrangler dev on http://127.0.0.1:8790 (not 8787: that's the API)

# desktop
pnpm --filter @qalm/desktop dev         # Electron on the web dev server (run the app on web first)
pnpm --filter @qalm/desktop build       # web export + icons + electron-builder --dir -> apps/desktop/release/
pnpm --filter @qalm/desktop e2e         # a build with a server URL: QALM_E2E_SIGNIN=skip (default), or code/link + QALM_E2E_SERVER_LOG=<wrangler dev output>

# Android example for the ink module
cd modules/qalm-ink/example/android && ./gradlew assembleDebug --max-workers=1
```

App env vars: `EXPO_PUBLIC_QALM_SERVER_URL`. Server secrets are listed in `apps/server/.dev.vars.example`. For local
dev, `MAGIC_LINK_URL` is `http://localhost:8081/auth/email/verify`.

**Environment gotchas:**
- **`ELECTRON_RUN_AS_NODE=1`** can leak in from hosts that are Electron apps (some editors and terminals), and it
  turns `qalm.exe` into plain Node. Unset it before launching (`env -u ELECTRON_RUN_AS_NODE`). The dev and e2e scripts
  already strip it.
- **Memory:** clang, Metro, workerd and tsc can run out of memory on smaller machines. Use
  `NODE_OPTIONS=--max-old-space-size=3072`, Metro/Expo with `--max-workers 2`, Gradle with `--max-workers=1`, and build
  react-native-skia's native code with `ninja -j1` if needed. Run one heavy build at a time.
- **Windows path lengths:** Gradle output in deep folders can exceed path limits. Delete it with
  `Remove-Item -LiteralPath '\\?\C:\…' -Recurse`.

## 8. Web layout (`apps/site`)

- `/` is the landing page, with `/privacy`, `/terms`, `/data-rights`, `/contact` and the 404 page next to it. They are
  generated into `apps/site/public/` by `apps/site/landing/` (handwritten ink, template, legal copy; see
  [its README](../apps/site/landing/README.md)): `pnpm --filter @qalm/site build:landing`, and `build:og` for
  `og.png`. Never edit `public/*.html` by hand. Anything outside `/app` and `/download` that doesn't exist gets
  `404.html`, never the app. The legal pages' facts are listed with their sources in `landing/legal.mjs`; update it
  (and `UPDATED` in `site.mjs`) when sign-in, storage, providers or retention change.
- `/download/windows` and `/download/android` stream `windows/qalm-setup.exe` and `android/qalm.apk` from the R2
  binding `DOWNLOADS`. Until a file is there, the route shows a "not available yet" page.
- `/app/…` is the Expo web export, built by `apps/site/scripts/build.mjs` with `QALM_WEB_BASE_URL=/app`
  (`apps/app/app.config.js` turns it into Expo's `experiments.baseUrl`; web only, unset everywhere else). Every
  script, font, `canvaskit.wasm` and `pdf.worker.min.mjs` loads from `/app/…` (index.ts and qalm-ink find their base
  from the bundle's own URL), and expo-router strips `/app` from routes.
- One Worker (`apps/site/wrangler.jsonc`): static assets first. `src/worker.js` runs only for `/download/*` and `/app` routes
  (`run_worker_first`, minus `/app/_expo/*`, `/app/assets/*` and the wasm/mjs files) and gives the SPA fallback: a
  missing `/app/…` path without a file extension (`/app/notebook/<id>`, `/app/auth/email/verify?token=…`) gets
  `/app/index.html`; a missing file (`.js`, `.ttf`, …) stays 404. `/app` redirects to `/app/`.
- API + MCP stay on their own Worker and origin (`apps/server`). Sign-in emails link to `MAGIC_LINK_URL`, the full
  URL of the app's verify route, so the server has no idea where the app lives beyond that var.
- The desktop app is unaffected: it bundles the root export (`export:web`) and serves it on `app://qalm/`. Native
  iOS/Android ignore the base path.

## 9. Self-hosting on Cloudflare

The public service runs at `https://qalm.apollolearn.app` (site, app at `/app/`) and `https://qalm-api.apollolearn.app`
(API, `/mcp` for agents). To run your own, you need a Cloudflare account (Workers with Durable Objects, D1, R2, KV) and,
for real sign-in emails, a [Resend](https://resend.com) account with a verified domain. Without Resend, sign-in codes
are only logged by the Worker.

Both `apps/server/wrangler.jsonc` and `apps/site/wrangler.jsonc` have a `staging` and a `production` env. Edit them for
your account (the steps are in `apps/server` unless noted):

1. **Names and domains:** change the Worker `name`s, the custom-domain `routes` (your zone must be on the same
   Cloudflare account; Wrangler creates the DNS records and certificates on the first deploy), or drop the routes and
   use your `*.workers.dev` URLs.
2. **Resources:** create them and put their ids into the env:
   ```bash
   npx wrangler d1 create <your-db>
   npx wrangler r2 bucket create <your-assets-bucket>
   npx wrangler kv namespace create <your-oauth-kv>
   npx wrangler r2 bucket create <your-downloads-bucket>   # for apps/site, optional
   ```
   Durable Objects need no setup beyond the migration in `wrangler.jsonc`. Update the `migrate:*` scripts in
   `apps/server/package.json` if you rename the database.
3. **Vars:** `PUBLIC_URL` (the API's origin), `MAGIC_LINK_URL` (`https://<your-site>/app/auth/email/verify`) and
   `EMAIL_FROM` (an address on your Resend domain).
4. **Secrets:** `npx wrangler secret put JWT_SECRET --env production` (a long random value, different per env) and
   `npx wrangler secret put RESEND_API_KEY --env production`.
5. **Migrate and deploy:**
   ```bash
   pnpm --filter @qalm/server migrate:prod
   pnpm --filter @qalm/server deploy:prod
   EXPO_PUBLIC_QALM_SERVER_URL=https://<your-api> pnpm --filter @qalm/site deploy:prod
   ```
   Use `migrate:staging` / `deploy:staging` for the staging env.
6. **Check:** the landing at `/`, `/app` opens the app, a reload of `/app/notebook/<id>` works, an email sign-in link
   opens `/app/auth/email/verify`, and `https://<your-api>/health` answers.
7. **Downloads (optional):** upload `windows/qalm-setup.exe` and `android/qalm.apk` to the downloads bucket.

**Client builds** for your server: set `EXPO_PUBLIC_QALM_SERVER_URL=https://<your-api>` at build time.
- Desktop: `pnpm --filter @qalm/desktop build` (or `dist` for installers).
- Android (in `apps/app`, same env var): `npx expo prebuild -p android --no-install`, then in `android/`
  `./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a,x86_64 --max-workers=1 -I ../scripts/android-windows.gradle`
  (on Windows; on smaller machines set the Gradle heap to `-Xmx3072m`, `org.gradle.parallel=false` and
  `kotlin.compiler.execution.strategy=in-process` in the generated `gradle.properties`, and `./gradlew --stop` after).
  Sign-in tokens are stored per server, so switching a build's server just asks for sign-in again.

**Android release signing:** sign release builds with your release keystore, kept outside the repo.
`apps/app/plugins/with-release-signing.js` (registered in `app.config.js`) reads a `keystore.properties` file
(`storeFile`, `storePassword`, `keyAlias`, `keyPassword`) from `QALM_ANDROID_KEYSTORE_PROPERTIES`, or by default
`~/.qalm/android/keystore.properties`, and wires the release `signingConfig` on every prebuild; without it the build
keeps debug signing. Never commit either file. Check a build with `apksigner verify --print-certs`: it should show your
certificate, not "Android Debug". **Back up the keystore:** Android only installs updates signed with the same key.
Bump `expo.android.versionCode` in `app.json` for every release after the first (it defaults to 1).

A fork you publish needs its own name and logo: see [TRADEMARKS.md](../TRADEMARKS.md).
