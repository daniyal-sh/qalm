# qalm v1 technical spec (rev 2)

Read with `decisions.md` (scope), `qink-live.md` (AI format) and **`brand.md` (qalm by Apollo: colours, type, mark)**.
Layouts and flows come from `mockups/editor.html`, `mockups/screens-library.html` and `mockups/screens-ai.html`.
Their colours and fonts are superseded by `brand.md`.
This file is the **contract between packages**. If you must change a contract, change it here too.

Changes in rev 2 (from review):
- One Skia renderer for all finished content.
- The native view only draws the stroke in progress.
- One Yjs doc per page.
- Line keys come from stroke IDs, and the server assigns the short labels.
- Added PDF rendering, zoom and undo.
- Sync uses one-time tickets.
- Palm thresholds are in millimetres.

## 1. Repo layout (pnpm workspace, `node-linker=hoisted` for Expo)

```
packages/core     @qalm/core     TypeScript, no platform deps. Model, geometry, SVG/PDF export, Q-ink
modules/qalm-ink  qalm-ink       Expo module: PageCanvas (Skia, all platforms) + InkOverlay (native live stroke)
                                 + PDF page rendering + on-device recognition. ios/ (Swift), android/ (Kotlin), src/ (TS + web)
apps/app          @qalm/app      Expo app (iOS, Android, web). All UI screens
apps/desktop      @qalm/desktop  Electron shell that loads the app's web build
apps/server       @qalm/server   Cloudflare Worker: auth, sync, assets, MCP
```

Shared rules: TypeScript strict, ESM, Vitest for tests, no `any` in public APIs.
Coordinates are page units in **PDF points** (A4 = 595×842, Letter = 612×792, A5 = 420×595).
IDs are random UUIDs, created by whoever creates the object. A stroke's ID is created by the ink overlay.

## 2. Data model (`@qalm/core`, Yjs)

There's one **index doc** per notebook, one **page doc** per page, and one **library doc** per user. Only the pages
on screen (plus or minus 2) are loaded on the device. Durable Objects hold one doc each, so memory stays small however long a notebook gets.

```
nb:{notebookId}            index doc
  meta:   Y.Map  { id, title, cover, paper, paperColor, size:{w,h}, orientation, aiAccess, createdAt, updatedAt }
  pages:  Y.Array<Y.Map>   { id, size:{w,h}, paper, paperColor, background: {kind:'paper'} | {kind:'pdf', assetId, pageIndex} }
  assets: Y.Map<assetId, {id, sha256, mime, name, bytes, pageCount?}>
  asks:   Y.Array<{id, pageId, text, at}>

pg:{notebookId}:{pageId}   page doc
  items:    Y.Map<itemId, Y.Map>   item fields below; stroke points as Uint8Array
  order:    Y.Array<itemId>        z-order
  lines:    Y.Map<lineKey, Y.Map>  Line fields
  comments: Y.Map<commentId, Y.Map>

lib:{userId}               library doc: folders + notebook entries {id,title,cover,folderId,updatedAt,aiAccess,favorite,deletedAt}
```

### Types (exported from `@qalm/core`)
```ts
type Tool = 'pen' | 'highlighter';
type Paper = 'blank' | 'ruled' | 'dotted' | 'grid' | 'cornell' | 'weekly';
type PaperColor = 'white' | 'cream' | 'night';
interface InkPoint { x: number; y: number; p: number /*0..1*/; tilt: number /*altitude rad, π/2 = upright*/; az: number /*azimuth rad*/; t: number /*ms since stroke start*/ }
type PenStyle = 'fountain' | 'ball' | 'brush';
type Smoothing = 0 | 1 | 2 | 3;              // 0 = none
interface StrokeItem { id: string; type: 'stroke'; tool: Tool; color: string; width: number; points: InkPoint[]; bbox: BBox; createdAt: number;
  style?: PenStyle; smoothing?: Smoothing }  // pen strokes only; missing = 'fountain' / 0, the look of strokes made before these existed
interface TextItem  { id: string; type: 'text'; x: number; y: number; w: number; text: string; fontSize: number; color: string }
interface ImageItem { id: string; type: 'image'; assetId: string; x: number; y: number; w: number; h: number }
interface ShapeItem { id: string; type: 'shape'; kind: 'line'|'arrow'|'rect'|'ellipse'|'triangle'; pts: [number, number][]; color: string; width: number }
type Item = StrokeItem | TextItem | ImageItem | ShapeItem;
type BBox = [x0: number, y0: number, x1: number, y1: number];
interface Line { key: string /* = id of the line's first item; globally unique */; kind: 'line' | 'drawing'; itemIds: string[]; bbox: BBox; text?: string; textSrc?: 'device'|'agent'|'user'; conf?: number }
interface Comment { id: string; lineKey: string; author: { kind: 'agent'|'user'; name: string }; text: string; createdAt: number; resolved: boolean; replies: { author: {kind:'agent'|'user'; name:string}; text: string; at: number }[] }
```
Stroke points are stored as a Float32Array of 6-tuples `(x, y, p, tilt, az, t)`, exposed as a `Uint8Array`
(`encodePoints` / `decodePoints`).

### API
```ts
createNotebookDoc(init: { id; title; cover; paper; paperColor; size }): Y.Doc        // with one first page
class Notebook {                     // wraps the index doc
  constructor(doc: Y.Doc); readonly doc: Y.Doc
  meta(): NotebookMeta; setMeta(patch): void
  pages(): PageInfo[]; addPage(opts?: Partial<PageInfo>, index?: number): string; removePage(id): void; movePage(id, index): void
  assets(): Asset[]; addAsset(a: Asset): void
  addAsk(pageId, text): void; asks(): Ask[]
  observe(cb): () => void
}
class Page {                         // wraps one page doc
  constructor(doc: Y.Doc); readonly doc: Y.Doc
  items(): Item[]; addItem(item: Item): void; updateItem(id, patch): void; removeItems(ids: string[]): void
  lines(): Line[]                    // maintained automatically on add/update/remove
  setLineText(lineKey, text, src: 'device'|'agent'|'user', conf?): void
  comments(): Comment[]; addComment(c: Omit<Comment,'id'|'createdAt'|'resolved'|'replies'>): string
  replyToComment(id, author, text): void; resolveComment(id): void
  observe(cb): () => void
}
createUndoManager(page: Page): Y.UndoManager   // tracks only local transactions (origin LOCAL_ORIGIN)
class Library { constructor(doc: Y.Doc) /* folders and entries; CRUD */ }
const LOCAL_ORIGIN: unique symbol                // every app mutation uses doc.transact(fn, LOCAL_ORIGIN)
```
**Undo and redo** apply per device: each page has a `createUndoManager`, and the app keeps a small cross-page stack of the page IDs
it edited, so undo goes to the right page. Edits from other devices and agents are never undone.

### Line assignment (keys are race-free)
When a stroke is added, it joins an existing `line` if its vertical overlap with the line's bbox is ≥ 50% of the smaller
height **and** the horizontal gap is ≤ 1.5 × the line's height. Otherwise it starts a new line whose **key is the stroke's ID**.
Shape items, and strokes taller than 2.5 × the page's median line height, form `drawing`s with the same keying, merged with
overlapping drawings (the earliest key wins). Lines with no items are deleted. When a line's items change, its `text` is cleared
unless `textSrc === 'user'`. Two offline devices may create two separate lines that overlap. That's fine, because keys never collide.
Short labels (`L7`, `D2`) exist **only in Q-ink**, and the server assigns them (§4).

### Geometry, rendering and export
Stroke outlines use **perfect-freehand** settings everywhere, so live and finished strokes are identical on every platform.
The native overlays use exact ports of this algorithm (Swift and Kotlin) with the same constants.
```ts
const tiltPressure = (pt: InkPoint) => Math.min(1, pt.p * (1 + 0.6 * (1 - pt.tilt / (Math.PI / 2))));  // tilt shading
PEN_STYLES = { fountain: { thinning: 0.6, curve: 1 }, ball: { thinning: 0.15, curve: 1 }, brush: { thinning: 0.75, curve: 0.6 } }
SMOOTHING  = [ { minStep: 0, passes: 0, streamline: 0.35 },   // 0: none (the original pen)
               { minStep: 0.3, passes: 1, streamline: 0.4 },  // 1: low
               { minStep: 0.6, passes: 2, streamline: 0.45 }, // 2: medium (the default for new strokes)
               { minStep: 1, passes: 4, streamline: 0.5 } ]   // 3: high
pen:         st = PEN_STYLES[style ?? 'fountain'], sm = SMOOTHING[smoothing ?? 0]
             input = pts.map(q => [q.x, q.y, st.curve === 1 ? tiltPressure(q) : tiltPressure(q) ** st.curve])
             getStroke(stabilize(input, sm.minStep, sm.passes), { size: width, thinning: st.thinning, smoothing: 0.5, streamline: sm.streamline, simulatePressure: false, last: true })
highlighter: getStroke(pts.map(q => [q.x, q.y, 0.5]),             { size: width, thinning: 0,   smoothing: 0.5, streamline: 0.5,  simulatePressure: false, last: true })  // drawn at 0.45 alpha, multiply
```
`stabilize` (input stabilisation, before getStroke): keep the first point; keep each next point only if it is ≥ `minStep` (page units)
from the last kept one; always keep the last point. Then `passes` rounds of `q[i] = (q[i-1] + 2 q[i] + q[i+1]) / 4` over x, y and
pressure, with both ends pinned, so the line still ends under the pen (no lag) while jitter is evened out. Fewer than 3 points pass
through unchanged. Each pen stroke stores the `style` and `smoothing` it was drawn with, so changing defaults never changes old
strokes. The app sets the style from the toolbar (per device, with the other tool settings) and the smoothing in Settings → Pen
(low / medium / high = 1 / 2 / 3, default medium). Highlighters ignore both.
Default widths (page units): pen 1.2 / 1.8 / 2.8, highlighter 12.
```ts
strokeOutline(s: StrokeItem): [number, number][]; strokeSvgPath(s: StrokeItem): string
snapShape(points: InkPoint[], heldMs: number): ShapeItem | null          // only if heldMs >= 500
hitTestErase(items: Item[], path: {x:number;y:number}[], radius: number): string[]
lassoSelect(items: Item[], polygon: {x:number;y:number}[]): string[]
paperPattern(paper: Paper, color: PaperColor, size): { lines: [x0,y0,x1,y1][]; dots: [x,y][]; stroke: string; bg: string }  // shared by Skia and SVG
renderPageSvg(info: PageInfo, page: Page, opts?: { paper?: boolean; assetUrl?: (id) => string }): string
renderLinesStripSvg(page: Page, lineKeys: string[], labels: string[]): { svg: string; width: number; height: number }  // black on white, "[n]" rows
exportPdf(nb: Notebook, loadPage: (pageId) => Promise<Page>, getAsset: (id) => Promise<Uint8Array>): Promise<Uint8Array>   // pdf-lib
packQalm(...) / unpackQalm(bytes) -> { index: Y.Doc; pages: Map<pageId, Y.Doc>; assets: Map<id, Uint8Array> }              // zip (fflate)
```

### Q-ink (text format in `qink-live.md` §2)
```ts
interface QinkLabels { [pageId: string]: { nextL: number; nextD: number; byKey: Record<string /*lineKey*/, string /*'L7'*/> } }
interface QinkSnapshot { [pageId: string]: Record<string /*lineKey*/, string /*hash of itemIds + text*/> }
assignLabels(labels: QinkLabels, pageId: string, lines: Line[]): void       // mutates; existing labels never change, new keys get the next number
encodeQinkUpdate(nb: Notebook, pages: Record<string, Page> /*the pages to diff*/, labels: QinkLabels, prev: QinkSnapshot, opts: { session; rev; asks? })
  : { text: string; image: { pageId: string; lineKeys: string[]; labels: string[] } | null; snapshot: QinkSnapshot }
encodeQinkRead(nb: Notebook, pages: Record<string, Page>, labels: QinkLabels, ref: string /*'outline' | 'p3' | 'p3:L2-9' | 'pdf:p2'*/)
  : { text: string; image: { pageId: string; lineKeys: string[]; labels: string[] } | null }
resolveRef(labels, nb, ref: 'p3:L4'): { pageId: string; lineKey: string }   // for transcribe and comment
```
Q-ink refers to pages by **1-based position** (`p3`). A line without text, or with `textSrc === 'device'`, goes into the image, with
`~"guess"` added when device text exists. Lines with `textSrc` agent or user are sent as text only.

## 3. Rendering and input (`qalm-ink`)

**One renderer for finished content:** `PageCanvas`, a TypeScript component built on `@shopify/react-native-skia`. It runs on iOS and
Android (Skia) and on web and Electron (CanvasKit, through react-native-skia's web support). It draws the paper (`paperPattern`), the PDF
background image, items in z-order (stroke Skia paths built from `strokeOutline`), the selection outline, and comment anchors.

**Only the stroke in progress is native:** `InkOverlay` (native view `QalmInkView`) is a transparent view stacked exactly over the
`PageCanvas`. It takes all input and draws only the current stroke with minimum latency, using the same perfect-freehand port:
- Android: `androidx.graphics` `CanvasFrontBufferedRenderer` (front-buffered), `androidx.input` `MotionEventPredictor`, `requestUnbufferedDispatch`.
- iOS: coalesced and predicted `UITouch`es, drawn into a dedicated layer every frame (a Metal or Core Graphics live layer).
- Web: a canvas overlay with `getCoalescedEvents`, `getPredictedEvents` and a `desynchronized` 2D context.

When the pen lifts, the overlay redraws the stroke from its real points only (no predicted points), which is exactly the geometry
PageCanvas will draw, and emits `onStrokeEnd` with a new stroke `id`. It **keeps drawing that stroke until its id appears in
`committedIds`, and then for a short hand-off** (2 animation frames on web, 50 ms on iOS and Android), so nothing flickers at hand-off.
`committedIds` are not the page's items: they come from `PageCanvas`'s `onDrawn`, which fires from an effect inside the Skia tree, i.e.
once Skia's own reconciler has committed and handed the new picture to its view. On web that is often several frames after React
commits the page (Skia's reconciler is asynchronous), and dropping the stroke earlier left a blank frame. The app passes the newest 64
drawn ids.

```ts
// PageCanvas (TS, all platforms)
interface PageCanvasProps { info: PageInfo; items: Item[]; selection?: string[]; anchors?: { lineKey: string; bbox: BBox; active: boolean }[]; pdfImage?: string /*uri*/; width: number /*px*/; onDrawn?(ids: string[]): void /*item ids, once Skia has them*/ }
// InkOverlay (native view QalmInkView; web: src/InkOverlay.web.tsx)
type InkTool = 'pen' | 'highlighter' | 'eraser' | 'lasso' | 'none';
interface InkOverlayProps {
  pageSize: { w: number; h: number };          // page units; the overlay's laid-out size maps linearly onto the page
  tool: InkTool; color: string; width: number;
  penStyle?: 'fountain' | 'ball' | 'brush'; smoothing?: 0 | 1 | 2 | 3;   // pen only; defaults 'fountain' / 0
  input: { drawWith: 'pen' | 'any'; hand: 'left' | 'right'; palm: 'relaxed' | 'standard' | 'strict' };
  committedIds: string[];                       // stroke ids already drawn by PageCanvas (from its onDrawn)
  onStrokeEnd(e: { nativeEvent: { id: string; tool: 'pen'|'highlighter'; color: string; width: number; points: InkPoint[]; heldMs: number; style; smoothing } }): void;
  onErase(e: { nativeEvent: { path: {x:number;y:number}[] } }): void;
  onLasso(e: { nativeEvent: { polygon: {x:number;y:number}[] } }): void;
  onPenButton?(e: { nativeEvent: { kind: 'double-tap'|'squeeze'|'button' } }): void;
  onRejectedTouch?(e: { nativeEvent: { reason: string } }): void;
}
// functions
QalmInk.recognize(lines: { key: string; strokes: InkPoint[][] }[], lang: 'en-US'): Promise<{ key: string; text: string; score: number }[]>  // ML Kit; web/desktop resolve []
QalmInk.ensureModel(lang: 'en-US'): Promise<void>
QalmInk.renderPdfPage(fileUri: string, pageIndex: number, widthPx: number): Promise<string /*cached png file uri*/>
  // iOS PDFKit, Android android.graphics.pdf.PdfRenderer, web pdf.js (returns an object URL)
```

**Zoom:** the app's editor handles pinch (react-native-gesture-handler) between 0.75× and 4×. While pinching, it applies a transform.
When the gesture ends, it lays the page out again at `width = baseWidth × scale`, which re-renders Skia (vector, so crisp) and re-requests the PDF
background at the nearest width bucket (1×, 2× or 4× the base width). The overlay maps its own size onto the page, so it needs no zoom state.

**Palm rejection** happens inside each overlay, in **millimetres** converted with the screen's density (Android `xdpi`, iOS points ≈ 0.19 mm on iPad,
web CSS px = 0.2646 mm):
1. Pen input always draws. With `drawWith: 'pen'`, touches never draw: they're passed through to scroll and zoom.
2. Touches whose contact major axis is larger than the threshold are rejected: relaxed 9 mm, standard 7 mm, strict 5 mm. The major axis is
   the full contact length on every platform: Android `getTouchMajor`, iOS `2 × majorRadius` (not reduced by `majorRadiusTolerance`),
   web the larger of the pointer's `width` / `height`.
3. Touches within 600 ms of pen activity, or below or beside the pen on the `hand` side, are rejected.
4. An OS cancel (`ACTION_CANCEL` / `FLAG_CANCELED` / `touchesCancelled`) retracts the in-progress stroke.

Hover (where supported) shows a brush-size preview. The pen button, squeeze or double-tap fires `onPenButton`, and the app switches to the eraser.

**Recognition** uses ML Kit Digital Ink on iPad and Android. On desktop there's **no recognizer in v1**: `recognize` resolves `[]`, and agents read the image.

## 4. Server (`apps/server`, Cloudflare Workers)

- **Durable Objects:** there's one `DocRoom` per doc ID (`nb:`, `pg:`, `lib:`). It speaks the Yjs sync and awareness protocol over a hibernating WebSocket,
  persists updates in DO storage, and compacts them into a snapshot every 200 updates. A page `DocRoom` notifies its notebook's `DocRoom` on each
  client update (`lastClientUpdateAt`, `changedPage`).
- **Sync auth:** `POST /sync/ticket {docId}` with `Authorization: Bearer <accessToken>` returns a single-use ticket that expires in 30 s. Then
  `GET /sync/{docId}?ticket=…` upgrades. Access tokens never appear in URLs.
- **R2** `ASSETS`: `PUT /assets/{sha256}` and `GET /assets/{sha256}` (Bearer auth; content-addressed).
- **App API** (Bearer, CORS `*` for the web/Electron build): `GET /ai/grants`, `PATCH /ai/grants/{id} {canComment?, canTranscribe?, notebookIds?, folderIds?}`,
  `DELETE /ai/grants/{id}`, `GET /ai/requests`, `POST /ai/requests/{id}/deny`, `GET /ai/activity?limit=`, and `DELETE /notebooks/{id}` (owner only,
  "Delete forever": sets `notebooks.deleted_at`, refuses sync tickets from then on, and purges the notebook's `nb:`/`pg:` room storage, best effort).
  Moving to the trash is only `deletedAt` in the library doc, so restoring from the trash needs no server call.
- **D1** tables: `users`, `sessions`, `magic_links`, `notebooks(id, owner_id, title, ai_access, deleted_at)`, `sync_tickets`, `email_sends`, OAuth tables, and
  `grants(client_id, user_id, notebook_ids|folder_ids, can_comment, can_transcribe, expires_at)`.
- **Auth:** `POST /auth/email/start`, `POST /auth/email/verify`, `POST /auth/apple`, `POST /auth/google`. These return `{accessToken (JWT, 1h), refreshToken}`,
  `POST /auth/refresh` renews them and `POST /auth/logout` ends the session. In dev, emails are logged to the console.
  - **Email links are bound to the device that asked.** The app sends `{email, nonceHash}` (sha256 of a random nonce it keeps for 15 min).
    The email has a link to the app's verify route (`MAGIC_LINK_URL`, normally the web app's `/auth/email/verify`; universal link / `qalm://` on native)
    and a 6-digit code. The app consumes it with `POST /auth/email/verify` `{token, nonce}` or `{email, code, nonce}` (5 wrong codes and that code is dead).
    A link the device has no nonce for is consumed only with `{token, confirm: true}`, after the app asked "Sign in as …?" (it reads the address
    with `POST /auth/email/lookup {token}`, which doesn't use the link up).
  - **A GET never uses up a link or returns tokens** (mail scanners follow links). `GET /auth/email/verify?token=` shows a page with a Continue
    button: for app links it opens the app link; for the MCP consent sign-in it POSTs the token (same origin only), which sets the web cookie.
  - **Rate limits:** at most 5 sign-in emails per address and 20 per client IP (`CF-Connecting-IP`) per hour, for `/auth/email/start` and
    `/authorize/signin`; over that, 429 with `Retry-After`.
  - **Refresh rotation:** each refresh rotates the token. The immediately-previous token still works for 60 s after a rotation and returns
    the current pair (two tabs refreshing at once); any other stale token ends the session. Access tokens carry the session id (`sid`) and
    stay valid until they expire (1 h) after logout.
- **MCP:** Streamable HTTP at `/mcp` with OAuth 2.1 and dynamic client registration (`@cloudflare/workers-oauth-provider`). The consent page is
  served by the worker (mockup screen 5). There are 4 tools: `wait`, `read`, `transcribe` and `comment`, as in `qink-live.md`. Images are returned as MCP image
  content: a PNG made from `renderLinesStripSvg` with `@resvg/resvg-wasm`.
- **What an agent sees:** a notebook is visible only if it is (a) a live library entry (not trashed, not deleted forever), (b) inside the grant
  (picked directly or in a granted folder), and (c) has AI access on. (c) is read live from the notebook's index doc in its `DocRoom` on every tool
  call and on every pass of the `wait` update stream, so switching it off takes effect at once (a pending `wait` ends with an error). A notebook
  whose meta is unknown counts as off. `notebooks.ai_access` in D1 is a mirror kept by the `DocRoom` on every client update of the index doc; the
  consent page uses it to mark notebooks with AI access off (they can be granted but stay hidden until it's turned on).
- **Q-ink labels and snapshots** live in the notebook `DocRoom`'s storage (`QinkLabels`, plus a `QinkSnapshot` per agent session).
  Only that object assigns labels, so they're stable and unique.
- **Wake rules:** `wait(s)` resolves when (pen idle ≥ 6 s **and** changes since the last delivery **and** ≥ 20 s since the last wake) **or** a new `asks` entry arrives.
  Only the changed pages are loaded.

## 5. App (`apps/app`, Expo, New Architecture, expo-router)

- **Screens:**
  - Library
  - New notebook sheet
  - Editor: a virtualized vertical list of pages, each a `PageCanvas` with an `InkOverlay`, plus the floating toolbar, comments panel, Ask button, pinch zoom, and undo/redo
  - Settings: Account, Pen and palm rejection, and AI access (connected agents, pending requests, activity log)
  - Sign-in
- **Sync:** the client uses the `y-websocket` provider (with tickets) for each loaded doc, with IndexedDB persistence on web and file persistence on native.
  Native snapshot files are replaced crash-safely: write `.tmp`, rename the old file to `.bak`, rename `.tmp` into place, delete `.bak`; reads fall
  back to a complete `.tmp`, then `.bak`.
- **`.qalm` backups** restore as a **new** notebook (new notebook and page ids, title + " (restored)"), copying pages, items, lines, comments, assets
  and meta. A backup never merges into the original, so it works under any account and can't resurrect or collide with the original's history.
- **Accounts:** notebooks made while signed out live in `lib:local`. On every sign-in and app start while signed in they're moved into the
  account library and removed from `lib:local`. After a sign-in this device didn't ask for (a confirmed link), the user is asked first
  ("Move N notebooks into this account?"). Signing in while signed in to another account always asks first. Token refresh re-reads the stored
  tokens first (another tab may have rotated them) and, on web, runs under `navigator.locks`. Sign-out calls `/auth/logout` (best effort).
- **Recognition:** debounced on-device recognition runs 1 s after a line changes, then calls `setLineText(key, …, 'device', score)`.

## 6. Desktop (`apps/desktop`, Electron)

- **Content:** loads the app's web export (`expo export -p web`) from disk.
- **Window and files:** a native window frame, and `window.qalmDesktop` in the preload for file open/save dialogs (PDF import and export).
- **Packaging:** electron-builder for Windows and macOS.
