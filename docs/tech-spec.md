# qalm v1 technical spec (rev 3)

Read with `decisions.md` (scope), `qink-live.md` (AI format) and **`brand.md` (qalm by Apollo: colours, type, mark)**.
Layouts and flows come from `mockups/editor.html`, `mockups/screens-library.html` and `mockups/screens-ai.html`.
Their colours and fonts are superseded by `brand.md`.
This file is the **contract between packages**. If you must change a contract, change it here too.

Changes in rev 2 (from review):
- One Skia renderer for all finished content.
- The native view only draws the stroke in progress.
- One Yjs doc per page.
- (rev 3) Lines are gone: agents get regions of changed strokes, readings are of strokes, comments anchor to strokes (§2).
- Added PDF rendering, zoom and undo.
- Sync uses one-time tickets.
- Palm thresholds are in millimetres.

## 1. Repo layout (pnpm workspace, `node-linker=hoisted` for Expo)

```
packages/core     @qalm/core     TypeScript, no platform deps. Model, geometry, SVG/PDF export, Q-ink
modules/qalm-ink  qalm-ink       Expo module: PageCanvas (Skia, all platforms) + InkOverlay (native live stroke)
                                 + PDF page rendering. ios/ (Swift), android/ (Kotlin), src/ (TS + web)
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
  meta:   Y.Map  { id, title, cover, paper, paperColor, size:{w,h}, orientation, aiAccess, aiPaused?, threadsIndexed?, createdAt, updatedAt }
  pages:  Y.Array<Y.Map>   { id, size:{w,h}, paper, paperColor, background: {kind:'paper'} | {kind:'pdf', assetId, pageIndex}, bookmarked? }
  assets: Y.Map<assetId, {id, sha256, mime, name, bytes, pageCount?}>
  asks:   Y.Array<{id, pageId, text, at, sel?: {itemIds, bbox}, commentId?}>   sel: an Ask about a selection; commentId: its thread
  threads: Y.Map<commentId, ThreadSummary>   the thread index (below): a summary of every comment thread in the notebook

pg:{notebookId}:{pageId}   page doc
  items:    Y.Map<itemId, Y.Map>   item fields below; stroke points as Uint8Array
  order:    Y.Array<itemId>        z-order
  readings: Y.Map<readingId, Y.Map> Reading fields (someone's reading of some strokes)
  comments: Y.Map<commentId, Y.Map>

lib:{userId}               library doc: folders + notebook entries {id,title,cover,folderId,updatedAt,aiAccess,favorite,deletedAt}
  swatches: Y.Map<'pen'|'highlighter', Y.Array<string>>   saved colours, in order; a missing key = the brand palette
```

**Changing paper later:** a page's `paper`/`paperColor` are set in place on its `pages` map (`Notebook.setPagePaper`,
one transaction, so one undo step on the notebook stack, even for "Apply to all pages"). PDF pages keep their PDF and
are skipped: their pattern and colour don't apply. Ink isn't rewritten. Instead, renderers draw items through
`itemsOnPaper`, so the default ink follows the paper: graphite (#27272a) draws as night ink (#e4e4e7) on night paper,
and night ink draws as graphite on white and cream. Other colours draw as stored. The cover (colour, title) is `meta`
plus the library entry (`updateNotebookMeta`), like a rename. It isn't on the undo stack.

**Thread index.** The comments panel, the unread badge, the "N open" count and "… commented" toasts cover the whole
notebook, but only nearby page docs are loaded. So the index doc keeps a `ThreadSummary` per thread:
`{id, pageId, onSelection?, quote?, author, text, last: {author, text, at}, kinds, lastAgent?: {name, at}, resolved, ask?, createdAt, updatedAt}`
(texts cut to 280 characters; `kinds` has one letter per entry, `a` agent or `u` student, which is all unread counts need).
The page doc stays the source of truth; the summary is a mirror, written with `Notebook.putThreads` (origin
`THREADS_ORIGIN`, so never undone):
- **Who writes it:** the notebook room after an agent's `comment` (the page room returns the page's summaries), the notebook
  room when a page room reports a student's comment change (it sends the page's summaries with `pageChanged`), and the app
  for every loaded page (`mirrorLoadedThreads`, so offline and signed-out notebooks have it too). Writes are skipped when
  nothing changed.
- **Conflicts:** a thread only gains entries, and between entries only goes from open to resolved (a reply reopens it).
  `putThreads` keeps whichever copy has more entries, and keeps `resolved` at equal length, so a writer holding an older
  copy of a page (a device that hasn't synced it yet) can't roll an entry back. Concurrent writes of one key converge
  because the server rewrites the summary from the merged page each time a student's change reaches the page room.
  Comments are never deleted, so entries are never removed; threads on deleted pages are filtered out by the page list
  (and come back if the delete is undone).
- **Older notebooks:** a notebook made before the index has no `meta.threadsIndexed`. The editor indexes it once in the
  background, 3 s after opening: each page doc in turn through the doc manager's LRU (released straight away), then sets
  the flag (synced, so other devices skip it). A page that couldn't sync leaves the flag unset for a later visit. New
  notebooks start with the flag set; a `.qalm` restore rebuilds the index from the restored pages.
- **In the app:** `threadRows` lists loaded pages' threads live (full card: replies, Reply / Resolve / Show) and the rest
  from the index (latest message and "Go to page n": selecting it scrolls there, which loads the page and the full thread).
  Read state (`seen:{notebookId}`), "thinking…" and toasts all work on summaries, so an agent's reply on page 30 while
  you're on page 2 raises the badge and a toast naming the page.
- Q-ink labels (`QinkThreads`) stay in the notebook room's storage; the index is for the app and isn't sent to agents.

**Saved colours (swatches).** One list per tool; text and shapes use the pen list. Pen colours are `#rrggbb`. A highlighter
colour is `#rrggbb` (drawn at the default 0.45 alpha, like every highlight made before custom colours) or `#rrggbbaa`,
which carries its own opacity. Colours are normalised (lowercase, `#rgb` expanded, `ff` alpha dropped, alpha dropped on
pens), deduplicated on read and capped at `MAX_SWATCHES` (24). An edit rewrites the tool's array; two devices editing at
once leave both lists in it, and the read deduplicates. An emptied list stays empty (the key exists). Signed-out colours
live in `lib:local` and move into the account with its notebooks (§5).

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
interface TextItem  { id: string; type: 'text'; x: number; y: number; w: number; text: string; fontSize: number; color: string; rot?: number }
interface ImageItem { id: string; type: 'image'; assetId: string; x: number; y: number; w: number; h: number; rot?: number }
// rot: radians, clockwise on the page, about the top-left corner (x, y); missing = 0
interface ShapeItem { id: string; type: 'shape'; kind: 'line'|'arrow'|'double-arrow'|'rect'|'ellipse'|'triangle'|'diamond'|'pentagon'|'hexagon'|'star'; pts: [number, number][]; color: string; width: number }
// pts: line [a, b]; arrow [tail, tip]; double-arrow [a, b]; rect, triangle, diamond, pentagon, hexagon their corners;
// star its 10 outer and inner points in order; ellipse [[x0,y0],[x1,y1]] (upright box, older
// shapes) or the 4 corners of its turned box. Moving or rotating a 2-point rect or ellipse stores 4 corners.
type Item = StrokeItem | TextItem | ImageItem | ShapeItem;
type BBox = [x0: number, y0: number, x1: number, y1: number];
interface Reading { id: string; ids: string[] /* the strokes it reads */; text: string; src: 'agent'|'user'; by?: string /* the agent */; stale?: boolean; updatedAt: number }
interface Comment { id: string; author: { kind: 'agent'|'user'; name: string }; text: string; createdAt: number; resolved: boolean; replies: { author: {kind:'agent'|'user'; name:string}; text: string; at: number }[]; anchor?: BBox /* fallback box */; anchorIds?: string[] /* the strokes it is about: its box is derived from them live */; ask?: boolean /* started by an Ask */ }
// A thread with anchorIds sits on those strokes (follows them; "Ink removed" once they're all gone); with only anchor on a box; with neither on the page.
interface Ask { id: string; pageId: string; text: string; at: number; sel?: { itemIds: string[]; bbox: BBox }; commentId?: string }
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
  setBookmark(id, on): void; duplicatePage(id, newPageId?): string | null   // the copy's content: Page.copyFrom
  assets(): Asset[]; addAsset(a: Asset): void
  addAsk(pageId, text, extra?: { sel?, commentId? }): string; asks(): Ask[]
  observe(cb): () => void
}
class Page {                         // wraps one page doc
  constructor(doc: Y.Doc); readonly doc: Y.Doc
  items(): Item[]; addItem(item: Item): void; updateItem(id, patch): void; removeItems(ids: string[]): void
  addItems(items: Item[]): void; updateItems(patches: Iterable<[id, patch]>): void   // one transaction (one undo step) each; same result as one call per item
  reorder(ids: string[], to: 'front' | 'back'): void   // z-order; keeps their order among themselves
  readings(): Reading[]
  setReading(ids, text, src: 'agent'|'user', by?): string | null   // null: no such strokes, or an agent over the student's reading
  editReading(id, text): void       // the student's edit: becomes theirs and fresh; '' removes it
  removeReading(id): void
  comments(): Comment[]; addComment(c: Omit<Comment,'id'|'createdAt'|'resolved'|'replies'>): string
  replyToComment(id, author, text): boolean   // a student's reply reopens a resolved thread; false if it's gone
  resolveComment(id): void
  observe(cb): () => void
}
createUndoManager(page: Page): Y.UndoManager   // tracks only local transactions (origin LOCAL_ORIGIN)
createNotebookUndoManager(nb: Notebook): Y.UndoManager   // the page list: add, delete, move, duplicate, bookmark (one step each)
class Library { constructor(doc: Y.Doc) /* folders and entries; CRUD */
  swatches(tool: SwatchTool): string[]; hasCustomSwatches(tool): boolean; setSwatches(tool, colors): void
  addSwatch(tool, color): boolean /* false: not a colour, already saved, or full */; moveSwatch(tool, color, index): void
  removeSwatch(tool, color): void; resetSwatches(tool): void; mergeSwatchesFrom(other: Library): void /* theirs after ours, capped */ }
type SwatchTool = 'pen' | 'highlighter'; const DEFAULT_SWATCHES: Record<SwatchTool, readonly string[]>; const MAX_SWATCHES = 24
normalizeColor(s): string | null; splitAlpha(color, fallback?): { rgb, alpha }; withAlpha(rgb, alpha): string
inkPaint(tool, color): { rgb, alpha }   // how every renderer paints ink: highlighters use the colour's alpha, else 0.45
const LOCAL_ORIGIN: unique symbol                // every app mutation uses doc.transact(fn, LOCAL_ORIGIN)
```
**Undo and redo** apply per device: each page has a `createUndoManager`, and the app keeps a small cross-page stack of the page IDs
it edited, so undo goes to the right page. Edits from other devices and agents are never undone.

### Readings, regions and migration (no lines)
There is no line grouping in the model. Ink (strokes and shapes) is just items; what an agent is sent is computed when an update goes out
(`qink.ts`, `geometry/regions.ts`; the rules and constants are in `qink-live.md` §2: unit, 2-unit clusters, ½-unit + row context).

**Readings** (`readings` map) are someone's reading of some strokes: an agent's `transcribe` or the student's own text. An agent's reading
is refused where the student's covers any of the strokes, and replaces agent readings of a subset of its strokes. A reading goes **stale**
(kept, flagged) when one of its strokes is erased, or ink that isn't part of it is added to it: within ½ unit, or on its row within 1½
units with vertical overlap, as for context (written, pasted or moved there;
ink that was already next to it, e.g. moved along with it, doesn't count). Moving, resizing, rotating or recolouring the read ink keeps it
fresh; a reading whose strokes are all erased is deleted. `Page` tracks this per transaction: a fresh reading's box and unit are taken once,
updated as its strokes move, and each outermost `Page` call checks only the ink it touched against them (a bulk edit stays linear).
Stale flags are written in the same transaction as the edit, so undo brings a reading back fresh. Readings are in the undo scope.

**Editing a reading** (app): select ink → **Reading** on the selection bar. The sheet lists the readings of the selection (the agent's text
with its name, or "You"; a "stale" badge), each editable. Saving makes it the student's (`editReading`), which agents can't overwrite; with
no reading yet, the student can write one for the selection (`setReading(ids, text, 'user')`). One undo step per save.

**Migration** (`migratePage`, origin `MIGRATION_ORIGIN`, not undoable): pages from before regions are moved once on load (app) or when an
agent edits them (server): a line comment (`lineKey`) gets the line's stroke ids as `anchorIds` (and its box as `anchor`), line text saved
by the student or an agent becomes a reading `m:{lineKey}` of those strokes, device guesses are dropped, and the `lines` map and items'
`line` fields are removed. Every write is deterministic, so two devices migrating at once converge; a migrated page has nothing left to move.

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
highlighter: getStroke(pts.map(q => [q.x, q.y, 0.5]),             { size: width, thinning: 0,   smoothing: 0.5, streamline: 0.5,  simulatePressure: false, last: true })  // drawn at inkPaint(...).alpha (0.45 unless #rrggbbaa), multiply
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
snapShape(points: InkPoint[], heldMs: number): ShapeItem | null          // only if heldMs >= SNAP_HOLD_MS (350); see below
hitTestErase(items: Item[], path: {x:number;y:number}[], radius: number): string[]
lassoSelect(items: Item[], polygon: {x:number;y:number}[]): string[]   // most of the ink inside, or a box's centre
// Selection (geometry/transform.ts). Sim = { s, r, ox, oy, dx, dy }: p' = o + s·R(r)·(p − o) + d
transformItem(item, sim): Item; transformPatch(item, sim): Partial<Item>   // widths and font sizes scale; text/images turn (rot)
visualBBox(item): BBox                  // itemBBox plus room for brush ink (0.4 × width) and arrow heads
selectionFrame(items): Frame | null     // { cx, cy, w, h, rot }: upright around everything, or turned with one turned text box / image
resizeSim(frame, corner, pointer): Sim  // uniform, about the opposite corner
rotateSim(frame, start, pointer): Sim   // about the centre, snapping to 45° within 4°
textWidthPatch(text, 'left'|'right', pointer): { x, y, w }   // a text box's edges change its width only (reflow)
hitTestPoint(items, p, tol): string | null   // tap: nearest ink within tol, topmost on a tie; inside a box or closed shape counts
boxSelect(items, a, b): string[]        // the lasso rule over a dragged rectangle
threadBox(comment, items): BBox | null   // where a thread sits, live; null once its anchored ink is gone (or on the page)
anchorInkRemoved(comment, items): boolean
paperPattern(paper: Paper, color: PaperColor, size): { lines: [x0,y0,x1,y1][]; dots: [x,y][]; stroke: string; bg: string }  // shared by Skia and SVG
renderPageSvg(info: PageInfo, page: Page, opts?: { paper?: boolean; assetUrl?: (id) => string }): string
renderRegionsSvg(pages: Record<pageId, Page>, rows: RegionRow[]): { svg: string; width: number; height: number }  // white, "[n]" rows: new ink black, context grey, erased red dashed; a clip row is a box crop
exportPdf(nb: Notebook, loadPage: (pageId) => Promise<Page>, getAsset: (id) => Promise<Uint8Array>): Promise<Uint8Array>   // pdf-lib
packQalm(...) / unpackQalm(bytes) -> { index: Y.Doc; pages: Map<pageId, Y.Doc>; assets: Map<id, Uint8Array> }              // zip (fflate)
```

### Q-ink (text format in `qink-live.md` §2)
```ts
type InkSeen = Record<string /*stroke id*/, string /*simplified path, half-unit lattice, delta encoded*/>   // per agent and page, server-stored
interface QinkRegions { next: number; byLabel: Record<string /*'R7'*/, { pageId; ids: string[]; box: BBox; client?: string; replaced?: boolean }> }   // notebook-wide, server-stored
interface QinkThreads { next: number; byId: Record<string /*commentId*/, { label: string /*'C3'*/; pageId: string }> }   // notebook-wide, server-stored
type QinkSeen = Record<string /*commentId*/, number /*entries seen: comment + replies*/>                               // per agent
encodeQinkUpdate(nb, pages: Record<string, Page> /*the pages to diff*/, regions: QinkRegions, prev: Record<pageId, InkSeen | undefined>,
  opts: { session; rev; client?; asks?; threads?; seen? }): { text; image: { rows: RegionRow[] } | null; ink: Record<pageId, InkSeen>; seen: QinkSeen }
  // a page without prev gets a first look; adds `note`/`re`/`open` for threads and `ask C6 R9 [n] …` for selection asks
encodeQinkRead(nb, pages, regions, ref /*'outline' | 'p3' | 'R7' | 'p3@120,300,260,80' | 'pdf:p2'*/, client?): { text; image | null }
encodeQinkThread(nb, pages, threads, 'C5'): string
resolveTarget(nb, regions, 'R7' | 'p3@x,y,w,h' | 'p3'): { kind: 'region', label, pageId, pos, ids, box } | { kind: 'box', pageId, pos, box } | { kind: 'page', pageId, pos }
registerRegion(regions, { pageId, ids, box }, client?): { label; was: string[] }   // same strokes keep their label; overlaps are replaced
inkInBox(items, box): string[]                     // ink whose centre is inside (box refs)
threadLabel(threads, commentId, pageId): string; resolveThread(threads, 'C3'): { pageId; commentId }
pageUnit(paper, boxes); clusterBoxes(boxes, gap); contextFor(seeds, others, unit); toGrid/fromGrid(box, size); gridSize(size)
```
Q-ink refers to pages by **1-based position** (`p3`) and to places by a 0–1000 grid across the page width.

## 3. Rendering and input (`qalm-ink`)

**One renderer for finished content:** `PageCanvas`, a TypeScript component built on `@shopify/react-native-skia`. It runs on iOS and
Android (Skia) and on web and Electron (CanvasKit, through react-native-skia's web support). It draws the paper (`paperPattern`), the PDF
background image, items in z-order (stroke Skia paths built from `strokeOutline`), the selection outline, and comment anchors.
Ink is drawn from **recorded pictures**, one per chunk of up to 256 consecutive strokes and shapes (text and images stay separate nodes,
so z-order is exact): a page with thousands of strokes is a handful of Skia nodes, zoom only changes the group's scale, and a new
stroke re-records only the last chunk. Paths are cached per item and rebuilt only when its geometry changes; a page seen for the first
time builds them in 8 ms slices in the background (newest chunk first). Replaced paths, pictures and images are freed (on web CanvasKit
objects are never garbage-collected). Images decode off the main thread on web (`createImageBitmap`). Ink of a selection being
dragged (`live`) is recorded in chunks of its own, drawn inside the live transform, so a drag only changes that transform.

**Baked bases (iOS/Android):** react-native-skia replays a canvas's whole recording on every redraw, on Android on the main
thread, so pictures alone still re-rasterised every stroke of a dense page on each change. A page with ≥ 1000 strokes and shapes
therefore keeps a **base**: one raster image of the paper, PDF background, comment highlights and every item except the newest
(`modules/qalm-ink/src/bake.ts` plans it, `PageCanvas` draws it). The base is drawn on the JS thread in 8 ms slices; the items after
it (the **tail**, 16–96 of them) are drawn as vectors on top. A stroke or an undo inside the tail redraws one image plus the tail;
when the tail passes 96 items it is drawn onto the base (one small draw). A page's first bake waits 300 ms after it mounts, so pages flung past never bake. An edit under the base (erasing or moving older ink, undo
past the tail, a paper colour change) falls back to the chunk pictures and re-bakes 250 ms after edits pause; a new zoom or
background keeps showing the old base until the new one is ready. The base stops before the first image item (and before text until
its font has loaded), so z-order stays exact. All mounted bases share a 16 MP budget (64 MB); a page that doesn't fit draws pictures.
A dense page shows its paper until its first base is ready (the overlay holds any stroke drawn meanwhile). Web keeps pictures only.

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
interface PageCanvasProps { info: PageInfo; items: Item[]; selection?: string[]; anchors?: { id: string /*comment id*/; bbox: BBox; active: boolean }[]; pdfImage?: string /*uri*/; width: number /*px*/; onDrawn?(ids: string[]): void /*item ids, once Skia has them*/;
  live?: { ids: string[]; transform: Sim } /* a selection being dragged: drawn transformed, paths not rebuilt */ }
// InkOverlay (native view QalmInkView; web: src/InkOverlay.web.tsx)
type InkTool = 'pen' | 'highlighter' | 'eraser' | 'lasso' | 'none';
interface InkOverlayProps {
  pageSize: { w: number; h: number };          // page units; the overlay's laid-out size maps linearly onto the page
  tool: InkTool; color: string; width: number;
  penStyle?: 'fountain' | 'ball' | 'brush'; smoothing?: 0 | 1 | 2 | 3;   // pen only; defaults 'fountain' / 0
  lassoMode?: 'free' | 'rect';                 // lasso: a loop, or a rectangle from the first point to the last
  input: { drawWith: 'pen' | 'any'; hand: 'left' | 'right'; palm: 'relaxed' | 'standard' | 'strict' };
  committedIds: string[];                       // stroke ids already drawn by PageCanvas (from its onDrawn)
  onStrokeEnd(e: { nativeEvent: { id: string; tool: 'pen'|'highlighter'; color: string; width: number; points: InkPoint[]; heldMs: number; style; smoothing } }): void;
  onErase(e: { nativeEvent: { path: {x:number;y:number}[] } }): void;
  onLasso(e: { nativeEvent: { polygon: {x:number;y:number}[] } }): void;   // every lasso gesture, taps too (1+ points)
  onPenButton?(e: { nativeEvent: { kind: 'double-tap'|'squeeze'|'button' } }): void;
  onRejectedTouch?(e: { nativeEvent: { reason: string } }): void;
}
// functions
QalmInk.renderPdfPage(fileUri: string, pageIndex: number, widthPx: number): Promise<string /*cached png file uri*/>
  // iOS PDFKit, Android android.graphics.pdf.PdfRenderer, web pdf.js (returns an object URL)
```

**Zoom:** the app's editor handles pinch (react-native-gesture-handler) between 0.75× and 4×. While pinching, it applies a transform.
When the gesture ends, it lays the page out again at `width = baseWidth × scale`, which re-renders Skia (vector, so crisp) and re-requests the PDF
background at the nearest width bucket (1×, 2× or 4× the base width, at most 4096 px; pages mounted off screen use 1×). The overlay maps its
own size onto the page, so it needs no zoom state.

**Palm rejection** happens inside each overlay, in **millimetres** converted with the screen's density (Android `xdpi`, iOS points ≈ 0.19 mm on iPad,
web CSS px = 0.2646 mm):
1. Pen input always draws. With `drawWith: 'pen'`, touches never draw: they're passed through to scroll and zoom, except a touch
   that rules 2 or 3 reject, which never scrolls (web: its `touchstart` is cancelled) and is reported with that reason.
2. Touches whose contact major axis is larger than the threshold are rejected: relaxed 30 mm, standard 20 mm, strict 14 mm. Fingertips
   (7–12 mm) draw at every level, palms (20–40 mm) are rejected from standard, and a 15–18 mm flat finger or palm edge only at strict;
   rule 3 and the multi-touch retraction catch smaller palm edges. The setting is stored by name, not by number. The major axis is
   the full contact length on every platform: Android `getTouchMajor`, iOS `2 × majorRadius` (not reduced by `majorRadiusTolerance`),
   web the larger of the pointer's `width` / `height`.
3. Touches within 600 ms of pen activity, or below or beside the pen on the `hand` side, are rejected.
4. An OS cancel (`ACTION_CANCEL` / `FLAG_CANCELED` / `touchesCancelled`) retracts the in-progress stroke.

Hover (where supported) shows a brush-size preview. The pen button pressed while hovering, a squeeze or a double-tap fires `onPenButton`,
and the app switches to the eraser (or the last tool, per Settings). On every platform the barrel button (or eraser end) held while the pen
touches only makes that stroke erase, and nothing fires `onPenButton` while the pen writes (iOS: squeeze and double-tap are ignored then).
On web the right mouse button erases too, and the page has no context menu.

**No on-device recognition.** qalm-ink has no handwriting recognizer on any platform (ML Kit was removed): the user's agent reads handwriting
from the region images with its own vision. That keeps the app about 20 MB lighter per language and the same on every platform.

## 4. Server (`apps/server`, Cloudflare Workers)

- **Durable Objects:** there's one `DocRoom` per doc ID (`nb:`, `pg:`, `lib:`). It speaks the Yjs sync and awareness protocol over a hibernating WebSocket,
  persists updates in DO storage, and compacts them into a snapshot every 200 updates. A page `DocRoom` notifies its notebook's `DocRoom` on each
  client update (`lastClientUpdateAt`, `changedPage`). A text `ping` gets `pong` through `setWebSocketAutoResponse`, so heartbeats
  never wake a hibernating room.
- **Sync auth:** `POST /sync/ticket {docId}` with `Authorization: Bearer <accessToken>` returns a single-use ticket that expires in 30 s. Then
  `GET /sync/{docId}?ticket=…` upgrades. Access tokens never appear in URLs.
- **R2** `ASSETS`: `PUT /assets/{sha256}` and `GET /assets/{sha256}` (Bearer auth; content-addressed).
- **App API** (Bearer, CORS `*` for the web/Electron build): `GET /ai/grants`, `PATCH /ai/grants/{id} {canComment?, canTranscribe?, notebookIds?, folderIds?}`,
  `DELETE /ai/grants/{id}`, `GET /ai/requests`, `POST /ai/requests/{id}/deny`, `GET /ai/activity?limit=`, `GET /ai/presence?nb={notebookId}` (owner only:
  `{aiAccess, paused, agents: [{name, waiting, lastAt, canComment, canTranscribe}]}`, the agents with a pending `wait` or a call in the last
  60 s; empty while AI access is off; the editor polls it every 8 s), and `DELETE /notebooks/{id}` (owner only,
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
  content: a PNG made from `renderRegionsSvg` with `@resvg/resvg-wasm`.
- **What an agent sees:** a notebook is visible only if it is (a) a live library entry (not trashed, not deleted forever), (b) inside the grant
  (picked directly or in a granted folder), and (c) has AI access on. (c) is read live from the notebook's index doc in its `DocRoom` on every tool
  call and on every pass of the `wait` update stream, so switching it off takes effect at once (a pending `wait` ends with an error). A notebook
  whose meta is unknown counts as off. `notebooks.ai_access` in D1 is a mirror kept by the `DocRoom` on every client update of the index doc; the
  consent page uses it to mark notebooks with AI access off (they can be granted but stay hidden until it's turned on).
- **Q-ink regions and ink seen** live in the notebook `DocRoom`'s storage: `regions` (`QinkRegions`, the notebook-wide `R#` registry)
  and, per agent and page, `ink:{clientId}:{pageId}` (`InkSeen`: each stroke's simplified path as last sent). Only that object assigns
  labels, so they're stable and unique. Pages loaded for an agent are migrated in memory (`migratePage`); an agent edit migrates the page
  room's doc for good.
- **Wake rules:** `wait(s)` resolves when (pen idle ≥ 6 s **and** changes since the last delivery **and** ≥ 20 s since the last wake) **or** a new `asks` entry arrives
  **or** the student added a comment or reply (a page room flags client transactions that touch its `comments` map and tells the notebook room,
  which keeps `lastCommentAt`). Only the changed pages are loaded.
- **Threads:** the notebook room stores `QinkThreads` (labels `C1`, `C2`, …) and, in each agent's state, `QinkSeen`. `comment {ref}` creates the
  comment in the page room (on the region's strokes still on the page, or the ink in a box, with the box as fallback) and labels it; `comment {thread, resolve?}` replies there (author: the grant's client name). Agents still never touch ink.
- **Presence and pause:** every agent call records `presence` (client id → name, grant switches, last call) in the notebook room; pending waits
  are counted in memory. `meta.aiPaused` ("Pause sharing") is read live like `aiAccess`: while it's on, `wait` delivers nothing (times out as
  `#q s=… paused`) and the other tools fail; turning it off wakes pending waits.

## 5. App (`apps/app`, Expo, New Architecture, expo-router)

- **Screens:**
  - Library
  - New notebook sheet
  - Editor: a virtualized vertical list of pages, each a `PageCanvas` with an `InkOverlay`, plus the floating toolbar, comments panel, Ask button, pinch zoom, and undo/redo.
    Live agent: a presence pill ("Claude is following along", "… is thinking…" after an Ask until an agent entry arrives or 90 s;
    tap for what it can do, Pause sharing, Stop), open threads as cards in the margin beside the page when the gutter is ≥ 200 px
    (pins on the page otherwise, plus a toast when an agent writes where its card isn't in view), and an unread badge on Comments (per device,
    `seen:{notebookId}` in kv: a thread is read once it's opened, or its margin card or panel card has been on screen for 1.5 s).
    The comments panel lists every thread in the notebook (§2, thread index)
  - Page navigator (top-bar "Pages"): thumbnails of every page, as a sidebar on windows ≥ 900 px wide and a full-screen grid below
    that. Tap to jump, long-press and drag to reorder, bookmark (with a Bookmarks filter), duplicate and delete; the current page is
    highlighted. Thumbnails render lazily (only cells on screen, one at a time, into an offscreen CPU surface as small JPEGs) and are
    cached until the page changes. Desktop keys: PgUp / PgDn, Home / End, Ctrl+G (go to page; the "Page n of m" label opens it too).
  - Settings: Account, Pen and palm rejection, and AI access (connected agents, pending requests, activity log)
  - Sign-in
- **Sync:** the client uses the `y-websocket` provider (with tickets) for each loaded doc, with IndexedDB persistence on web and file persistence on native.
  Native snapshot files are replaced crash-safely: write `.tmp`, rename the old file to `.bak`, rename `.tmp` into place, delete `.bak`; reads fall
  back to a complete `.tmp`, then `.bak`.
  - **Dropped connections:** after 20 s without a message the provider sends `ping`; if nothing arrives within 8 s (or a socket doesn't
    open within 16 s) it drops the socket and reconnects with backoff (0.5 s doubling to 30 s), each time with a fresh ticket. The browser's
    `offline` event drops the socket at once and stops retrying until `online`, which reconnects at once. Back in the foreground (page
    visible, or `AppState` active on iOS/Android) it pings at once. The editor shows "Reconnecting…" while retrying and "Offline" when the
    device is offline. No edit is lost: every connect starts with sync step 1 both ways, which also resends updates sent into a dead socket.
- **Big notebooks:** the editor renders views only for pages near the viewport (mounted pages ±2, plus plain page outlines a few pages further)
  and re-renders on scroll only when the shown pages change. Page docs open one at a time, nearest the current page first (`pageDocQueue`),
  and stay in an LRU of 24 idle docs (flushed before they are dropped; pages with undo history are dropped last). PDF renders run 2 at a
  time, newest first, and are skipped if the page scrolled away; on web the last 24 rendered pages are kept and older bitmaps revoked.
  Benchmark: `pnpm --filter @qalm/app bench:micro`, and `EXPO_PUBLIC_QALM_BENCH=1 pnpm --filter @qalm/app export:web` then
  `node apps/app/scripts/bench/run.mjs --label <name>` (headless Chrome: 300-page mixed notebook and a 300-page PDF).
- **`.qalm` backups** restore as a **new** notebook (new notebook and page ids, title + " (restored)"), copying pages, items, readings, comments, assets
  and meta. A backup never merges into the original, so it works under any account and can't resurrect or collide with the original's history.
- **Accounts:** notebooks made while signed out live in `lib:local`. On every sign-in and app start while signed in they're moved into the
  account library and removed from `lib:local`. After a sign-in this device didn't ask for (a confirmed link), the user is asked first
  ("Move N notebooks into this account?"). Saved colours in `lib:local` move too (`Library.mergeSwatchesFrom`: the account's list,
  then the signed-out colours it lacks) and `lib:local` goes back to the brand palette. Signing in while signed in to another account always asks first. Token refresh re-reads the stored
  tokens first (another tab may have rotated them) and, on web, runs under `navigator.locks`. Sign-out calls `/auth/logout` (best effort).
- **Colours:** the toolbar shows the active tool's saved colours from the library doc (pen list for pen, text and shapes;
  highlighter list for the highlighter), then "+". The current colour has an ink ring and a check; a swatch that would vanish
  against the toolbar (contrast < 1.6, e.g. graphite in dark mode) gets an outline. Labels are the brand name (`PEN_COLORS`,
  `HIGHLIGHTER_COLORS`) or the hex (with the opacity for a highlighter, "#fde68a, 50%"). Tap uses a colour; hold 280 ms and drag
  reorders (the toolbar stops scrolling while dragging); hold without moving, right-click, or the screen reader's long-press opens
  Move left / Move right / Remove. "+" opens the picker: a hue slider over a 5×7 grid of solid tones for that hue (vivid to soft,
  dark to light, plus greys; no gradients), a hex field, and for the highlighter an opacity slider (20–80 %). "Add colour" saves
  and uses it, "Use once" only uses it. The picker is a popover under "+" (a bottom sheet below 520 px). The selection bar's
  recolour shows the same pen strip and picker (highlighters and images keep their colour). The tool's current colour stays
  per device (kv `tools`). On night paper the default graphite still draws as night ink (#e4e4e7); other colours draw as picked.

## 6. Desktop (`apps/desktop`, Electron)

- **Content:** loads the app's web export (`expo export -p web`) from disk.
- **Window and files:** a native window frame, and `window.qalmDesktop` in the preload for file open/save dialogs (PDF import and export).
- **Packaging:** electron-builder for Windows and macOS.

## 7. Selecting and editing (app)

The lasso tool selects by **tapping** an item (`hitTestPoint`, 10 px), by a **freeform loop** or by a **rectangle**
(`lassoMode`, a toggle in the lasso's toolbar options). A lasso that moved less than 6 px is a tap; tapping empty paper
deselects. On desktop, Shift, Ctrl or Cmd adds to (or, on a tap, toggles in) the selection. Pen-only mode: fingers still
scroll and zoom; with "pen and finger", a finger tap selects too. The selection shows a frame (`selectionFrame`) with
handles: drag inside to move, corners to resize uniformly, the round handle to rotate; a single text box has edge handles
that change its width. A double-tap on a text box (or a tap with the text tool) edits it in place. While dragging,
`PageCanvas` draws the selection with `live`; on release the edit is one `LOCAL_ORIGIN` transaction (one undo step), and
readings of the moved ink stay fresh (ink moved next to another reading makes that one stale). The selection bar recolours, duplicates, copies, cuts, pastes (an
in-app clipboard that works across pages and notebooks, copying image assets into the target notebook), brings to
front / sends to back, comments, asks and deletes; Ctrl/Cmd + C / X / V / D / A and Delete work on desktop. A thread
started from a selection stores its item ids (`anchorIds`), so its pin, margin card and Q-ink box ref follow the ink; once
that ink is all deleted, the thread shows only in the panel ("Ink removed").

### Shape snapping (`snapShape`)
Hold the pen still for **350 ms** (`SNAP_HOLD_MS`) at the end of a stroke and it snaps. Each overlay reports `heldMs`: how long
the pen stayed within ~1 mm (web, Android) or 2 page units (iOS) of where it lifted. Steps:
1. Drop the hold's jitter at the end; resample to 96 points evenly spaced along the stroke.
2. **Closed or open:** a stroke whose end comes back within 20% of its size to its start (after 60% of its length) is
   closed. A short overshoot past the start is cut off. A tail longer than 18% of the loop (the stem of an "a", the end of
   an "e") means handwriting: no snap.
3. **Open strokes:**
   - **Line:** straight within 7% of its length. Snaps to horizontal or vertical within 5°.
   - **Arrows:** simplify the stroke (RDP). The longest segment is the shaft. A head is 1 barb, or barb–tip–barb, 6–50% of
     the shaft and pointing back at 12–75°. Heads at both ends make a `double-arrow`.
4. **Closed strokes:**
   - **Corners:** peaks of the turning angle over ±4% of the outline, at least 35° and 1.6× the outline's median turn (a
     circle turns evenly, so it has none).
   - **3 corners:** triangle.
   - **4 corners:** rect if every angle is within 18° of 90°. It keeps its rotation, snaps upright within 5°, and becomes a
     square within 10%. Otherwise, or with corners at top/right/bottom/left, it's a diamond.
   - **5–6 corners:** a regular pentagon or hexagon, a point or flat side on top within 6°.
   - **5 sharp tips visited every other one:** a 5-point star (inner radius 0.382).
   - **Error limit:** each fit must stay within 6% of the size on average. With 4–7 corners, regular pentagon and hexagon
     fits of the whole outline are tried too.
   - **Otherwise, an ellipse:** principal axes and extents, error under 11% (7% when corners were found). It becomes a circle
     when round within 10%, and upright within 8°.
Synthetic tests (jitter, wobble, rounded corners, overshoot, rotation) and held handwriting (e, a, s, 8, 2, m, L, V, Z, N,
cursive, spirals, scribbles) are in `packages/core/test/shapes.test.ts`; handwriting never snaps there.
