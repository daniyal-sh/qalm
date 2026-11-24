# qalm v1 technical spec (rev 3)

Read with `decisions.md` (scope), `qink-live.md` (AI format), `lecture-mode.md` (recording sessions) and **`brand.md` (qalm by Apollo: colours, type, mark)**.
Layouts and flows come from [`design/mockups/editor.html`](design/mockups/editor.html), [`screens-library.html`](design/mockups/screens-library.html) and [`screens-ai.html`](design/mockups/screens-ai.html).
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
  meta:   Y.Map  { id, title, cover, paper, paperColor, size:{w,h}, orientation, aiAccess, threadsIndexed?, createdAt, updatedAt }
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
  lectures: Y.Map<sessionId, LectureSummary>   lecture sessions (lecture-mode.md §5)

lec:{notebookId}:{sessionId}   lecture session doc: meta, timeline (deflated JSONL chunks), audio, transcript, crops
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
  replaceItems(reps: { id; with: Item[] }[]): void     // one transaction: new items take the old one's z-slot; readings of it read
                                                        // them (stale), threads on it follow them; adds and removes like addItem/removeItems
  applyErase(plan: ErasePlan): void                     // a partial-erase pass (replaceItems + removeItems), one transaction
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
recognizeShape(points): ShapeItem | null                                // no hold gate: the overlays time the hold; see below
snapShape(points: InkPoint[], heldMs: number): ShapeItem | null          // recognizeShape, only if heldMs >= SNAP_HOLD_MS (400)
adjustShape(shape, from, to): pts                                        // dragging after the snap; see below
hitTestErase(items: Item[], path: {x:number;y:number}[], radius: number): string[]   // box culled first: cheap on dense pages
splitStroke(stroke, path, radius, makeId?): StrokeItem[] | null    // partial erase of one stroke (§7, Erasing); null = missed
planPartialErase(items, path, radius, makeId?): ErasePlan          // { split: { id, pieces }[]; remove: shape ids }
scribbleShape(points): ScribbleShape; isScribble(points): boolean  // the scribble shape test (§7, Erasing)
scribbleTargets(items, points, width): string[]; detectScribble(items, points, width): string[] | null
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
type InkTool = 'pen' | 'highlighter' | 'eraser' | 'lasso' | 'laser' | 'none';
interface InkOverlayProps {
  pageSize: { w: number; h: number };          // page units; the overlay's laid-out size maps linearly onto the page
  tool: InkTool; color: string; width: number;
  penStyle?: 'fountain' | 'ball' | 'brush'; smoothing?: 0 | 1 | 2 | 3;   // pen only; defaults 'fountain' / 0
  lassoMode?: 'free' | 'rect';                 // lasso: a loop, or a rectangle from the first point to the last
  eraserMode?: 'stroke' | 'partial';            // partial: a faint trail of the eraser's last 250 ms (§7, Erasing)
  laserMode?: 'trail' | 'dot';                  // laser: a fading trail, or a dot under the pen (§7, Laser pointer)
  ruler?: { cx: number; cy: number; angle: number; length: number; thickness: number } | null;
                                                // window px / dp / pt: strokes starting near an edge follow it (§7, Ruler)
  input: { drawWith: 'pen' | 'any'; hand: 'left' | 'right'; palm: 'relaxed' | 'standard' | 'strict' };
  committedIds: string[];                       // stroke ids already drawn by PageCanvas (from its onDrawn)
  onStrokeEnd(e: { nativeEvent: { id: string; tool: 'pen'|'highlighter'; color: string; width: number; points: InkPoint[]; heldMs: number; style; smoothing } }): void;
  onErase(e: { nativeEvent: { path: {x:number;y:number}[] } }): void;
  onLasso(e: { nativeEvent: { polygon: {x:number;y:number}[] } }): void;   // every lasso gesture, taps too (1+ points)
  onPenButton?(e: { nativeEvent: { kind: 'double-tap'|'squeeze'|'button' } }): void;
  onRejectedTouch?(e: { nativeEvent: { reason: string } }): void;
  onPenSeen?(e: { nativeEvent: {} }): void;     // once per overlay: the first real pen, touching or hovering
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
3. Touches within 600 ms of pen activity, or below or beside (±10 mm) the pen on the `hand` side within **2 s** of pen
   activity, are rejected.
4. An OS cancel (`ACTION_CANCEL` / `FLAG_CANCELED` / `touchesCancelled`) retracts the in-progress stroke, as does a contact
   that grows into a palm.

**"Pen and finger" (`drawWith: 'any'`):** one finger draws; two fingers pan and pinch-zoom (the editor's RNGH pinch). The palm rules
above still apply, and a rejected palm never counts as a finger. A second finger landing **within 150 ms** of the first, or before
the first has travelled **3 mm**, retracts that half-started stroke (`multi-touch`); later, the stroke was real: it is kept, ending
where the second finger landed, and the fingers go on to pan. Until every finger lifts, no finger draws.
- Web / Electron: the canvas is `touch-action: none`, so `twoFingerPan.ts` scrolls the nearest scroll views by the fingers' midpoint
  and flings after they lift (velocity over the last 100 ms, decaying 0.998 per ms like UIScrollView). Fingers are tracked
  window-wide, so a second finger on another page or between pages counts.
- Android: the finger stroke holds the ancestor ScrollViews still; a second finger releases them (their own scroll and fling).
- iOS: while a finger draws, the ancestor scroll views' pan needs two touches (`minimumNumberOfTouches`, restored when the touches
  end) and may run alongside the ink recognizer, so two fingers scroll natively with momentum.

**Auto-pick:** until the user chooses in Settings (`drawWithAuto`), `drawWith` is "pen and finger" on a device that has never shown
a real pen (web pointerType `'pen'`, Android `TOOL_TYPE_STYLUS`, iOS `.pencil`) and "pen only" once one is seen (`penSeen`, in the
local prefs). The switch shows a one-time toast: "Pen detected: fingers now scroll. Change in Settings." Prefs saved before this
have no `drawWithAuto`: a saved "pen" counts as a choice, a saved "any" as auto. Settings shows whether the mode was auto-picked.

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
- **Storage cap** (`MAX_USER_STORAGE_BYTES`, default 250 MB = 250 000 000 bytes): counts the user's uploaded assets (`user_assets`, each
  sha once per user) plus their notebook data. Notebook data is the bytes each `DocRoom` keeps in its SQLite storage (snapshot parts +
  update log), tracked in memory as it persists and written to D1 `doc_sizes(doc_id, user_id, bytes)` by a DO alarm 5 s after a write (so
  a burst of strokes costs one D1 write). The owner is the library's user or `notebooks.owner_id`. "Delete forever" removes the rows.
  `GET /me/storage` → `{usedBytes, limitBytes, assetBytes, notebookBytes}`. A `PUT /assets` that doesn't fit gets **413** with
  `{error, code: 'storage_full', …usage}`; sync is never refused, so ink is never blocked or lost (usage can go past the cap from ink alone).
  The app checks `/me/storage` before a PDF, image or `.qalm` import and refuses with the same message; offline it imports locally and the
  upload waits in the queue (a 413 stays queued).
- **App API** (Bearer, CORS `*` for the web/Electron build): `GET /ai/grants`, `PATCH /ai/grants/{id} {canComment?, canTranscribe?}`,
  `DELETE /ai/grants/{id}`, `GET /ai/requests`, `POST /ai/requests/{id}/deny`, `GET /ai/activity?limit=`, `GET /ai/presence?nb={notebookId}` (owner only:
  `{aiAccess, live, paused (= !live, for older apps), agents: [{name, waiting, lastAt, canComment, canTranscribe}]}`, the agents with a pending `wait` or a call in the last
  60 s; empty while AI access is off; the editor polls it every 8 s), and `DELETE /notebooks/{id}` (owner only,
  "Delete forever": sets `notebooks.deleted_at`, refuses sync tickets from then on, and purges the notebook's `nb:`/`pg:` room storage, best effort).
  Moving to the trash is only `deletedAt` in the library doc, so restoring from the trash needs no server call.
- **D1** tables: `users`, `sessions`, `magic_links`, `notebooks(id, owner_id, title, ai_access, deleted_at)`, `sync_tickets`, `email_sends`, `user_assets`, `doc_sizes`, OAuth tables, and
  `grants(client_id, user_id, can_comment, can_transcribe, expires_at)`. A grant covers every notebook of the user with AI access on (checked
  live in the notebook's room on every call); `grants.notebook_ids` / `folder_ids` are left from per-agent scoping and unused.
- **Auth (email only):** `POST /auth/email/start` and `POST /auth/email/verify` return `{accessToken (JWT, 1h), refreshToken}`. There is no Apple or
  Google sign-in (removed; `users.apple_sub` / `google_sub` from `0001_init` are unused and left in place, since SQLite can't drop UNIQUE columns),
  `POST /auth/refresh` renews them and `POST /auth/logout` ends the session. In dev, emails are logged to the console.
  - **Delete account** (Settings → Delete account, `apps/server/src/account.ts`, Bearer): `POST /account/delete/start {email}` (must be the
    account's address; same rate limits) emails a 6-digit code stored as a `magic_links` row with `purpose = 'delete'` and its own hash
    prefix; every sign-in query requires `purpose = 'signin'`, so neither code works for the other. `POST /account/delete {code}` (5 wrong
    tries kill the code) sets `users.deleting_at`, then purges every notebook room (and the page rooms it knows), every room in `doc_sizes`
    and the library room; deletes the R2 objects no other user has in `user_assets`; revokes every OAuth grant (OAUTH_KV); and deletes the
    user's rows in `user_assets`, `doc_sizes`, `grants`, `auth_requests`, `activity`, `sessions`, `sync_tickets`, `notebooks`,
    `magic_links`, `email_sends`, then `users` last. Every step is idempotent: once `deleting_at` is set, the same call with the same
    access token finishes a partial run without a code, and a call after the user row is gone answers `{deleted: true}`. Sync tickets and
    uploads require a live (not deleting) user, since access tokens stay valid for up to an hour. The app then stops syncing, removes the
    account's library and notebook docs from this device (keeping notebooks still in the signed-out library), clears its token and prefs,
    and shows "Your account was deleted" on the sign-in screen.
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
- **Presence:** every agent call records `presence` (client id → name, grant switches, last call) in the notebook room; pending waits
  are counted in memory.
- **Play / Pause AI (liveness):** agents get a notebook only while one of the owner's devices plays it (`docs/qink-live.md` §4). Text frames
  on the `nb:` sync socket: `ai:play`, `ai:live` every 15 s (only extends a live socket), `ai:resume:<epoch>` after a reconnect, `ai:pause`,
  `ai:stop`. `DocRoom` keeps `liveUntil` (last accepted frame + 40 s) in that socket's attachment (survives hibernation, never synced) and
  `liveUntil()` is the latest over open sockets; the pause epoch is in the room's `kv` (`aiPauseEpoch`). Every MCP path goes through
  `AgentHub.isLive()` / `requireLive()` (AI access on, `meta.aiPaused` not set, a live socket); a change wakes pending waits, and a pending
  wait also re-checks when the last heartbeat would lapse. `applyAgentEdit` asks the notebook room (`agentLiveError`) right before writing.
  `meta.aiPaused` (deprecated) is still honoured for apps from before Play / Pause; the current app clears it on Play.

## 5. App (`apps/app`, Expo, New Architecture, expo-router)

- **Screens:**
  - Library
  - New notebook sheet
  - Editor: a virtualized vertical list of pages, each a `PageCanvas` with an `InkOverlay`, plus the floating toolbar, comments panel, Ask button, pinch zoom, and undo/redo.
    Live agent: the Play / Pause AI control in the header (only with AI access on and signed in; starts "AI paused"; "AI live",
    "AI live · Claude" with a following agent, "… is thinking…" after an Ask until an agent entry arrives or 90 s; tap to play or
    pause; `useAiLive` / `src/editor/aiLive.ts`, stopped on background, close, AI off and outages over 40 s), open threads as cards in the margin beside the page when the gutter is ≥ 200 px
    (pins on the page otherwise, plus a toast when an agent writes where its card isn't in view), and an unread badge on Comments (per device,
    `seen:{notebookId}` in kv: a thread is read once it's opened, or its margin card or panel card has been on screen for 1.5 s).
    The comments panel lists every thread in the notebook (§2, thread index)
  - Page navigator (top-bar "Pages"): thumbnails of every page, as a sidebar on windows ≥ 900 px wide and a full-screen grid below
    that. Tap to jump, long-press and drag to reorder, bookmark (with a Bookmarks filter), duplicate and delete; the current page is
    highlighted. Thumbnails render lazily (only cells on screen, one at a time, into an offscreen CPU surface as small JPEGs) and are
    cached until the page changes. Desktop keys: PgUp / PgDn, Home / End, Ctrl+G (go to page; the "Page n of m" label opens it too).
  - Fullscreen and focus layout: F11 (Windows, Linux, browsers), Ctrl+Cmd+F or the green button (macOS), or the header's
    Full screen button. Desktop uses `BrowserWindow.setFullScreen` (F11 is caught in main's `before-input-event`, since
    there's no menu bar), browsers the Fullscreen API, iPad and Android hide the system bars (`expo-status-bar`,
    `expo-navigation-bar` immersive). The header, toolbar and side panels give way to a floating pill (pen, highlighter,
    eraser, lasso, laser, ruler, colour, undo/redo, exit) that can be dragged to any edge and is remembered (`focusPill`
    pref). Where even the shrunk pill (0.8×) can't fit along its edge (a portrait phone), the lasso, laser and ruler fold into a
    "More tools" button (`pillCompact`). Esc clears a selection first, then leaves fullscreen; leaving restores the panels.
  - Presentation view: F5 (web / desktop), the laser's "Present" option or More → Present. Fullscreen with no chrome:
    no header, toolbar, pill, page numbers and menus, margin cards, comment pins, selection or ruler. The page is fitted
    whole and centred (`fitZoom`, which may go below the 0.75× minimum; pinch is off), the laser is the tool, and a
    small bar at the bottom has previous / next, "n / m", the laser's trail / dot and Stop. Keys: → ↓ Space Enter PgDn
    next, ← ↑ Backspace PgUp previous, Home / End, K switches trail / dot, Esc or F5 stops (`present.logic.ts`); Space
    or Enter on a focused bar button only presses it. F5 never reloads the page, even in a text field (where it does
    nothing). While presenting, the pen button doesn't switch to the eraser and Ctrl+wheel / trackpad pinch don't zoom;
    pages deleted on another device meanwhile keep the index on a page that exists (none left: it stops). Leaving
    fullscreen any other way stops it too; stopping restores the tool, the zoom and the page.
  - Desktop keys (web and Electron; not while typing): P pen, H highlighter, E eraser (again: whole stroke / partial),
    L lasso, T text, K laser (again: trail / dot), R ruler on / off, F5 present, F11 or Ctrl+Cmd+F fullscreen, Esc
    (selection, then fullscreen or presenting), Ctrl/Cmd + Z / Shift+Z / Y undo and redo, Ctrl/Cmd + C / X / V / D / A,
    Delete, PgUp / PgDn / Home / End and Ctrl+G for pages. The toolbar shows the laser and the ruler after the text
    tool and Insert image; on narrow windows the bar scrolls sideways with edge chevrons.
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

### Erasing (eraser modes, scribble to erase)
- **Eraser modes** (the eraser's toolbar options, kv `tools.eraserMode`, default **Whole stroke**; E pressed again while
  the eraser is on switches): *Whole stroke* removes every stroke or shape the eraser touches (`hitTestErase`).
  *Partial* rubs out only where it passes (`planPartialErase`): each touched stroke's centreline is cut where it comes
  within the eraser radius plus half the stroke width, so the pieces' round ends just touch the eraser and the gap is as
  wide as the eraser. Cuts are found by sampling near the eraser and bisection (one interpolated point per cut); every
  other point is the stroke's own, so pieces keep pressure, tilt and time, and the tool, colour, width, style, smoothing
  and `createdAt`. Pieces under ~0.5 units are dropped.
  - **Nothing is written while the eraser is down.** An `EraseSession` (core `geometry/erase.ts`) keeps what the page
    would look like: each touched stroke's pieces so far, touched shapes gone. The page draws that (PageCanvas, on
    every platform) and the next segment is hit-tested against it.
  - **The pen-up commits it once** (the overlay's last `onErase` has `final: true`; else 400 ms after the last
    segment, or when the page goes away): one transaction, one undo step: each touched stroke deleted, its pieces
    added in its z-order slot as ordinary new strokes with `splitFrom` naming the stroke as drawn (copies drop it).
    Undo is the plain delete/add undo. Older builds and servers see ordinary strokes (no deploy order). An app killed
    mid-gesture has written nothing. A 50-move rub along a 1000-point stroke grows the doc by ~12 KB (one write of the
    ~500 points left), against ~907 KB when every move re-created the pieces.
  - **Two devices at once:** a move of the stroke elsewhere that lands after the erase is lost (the stroke is gone);
    undoing the erase brings the stroke back as it was. A delete elsewhere stays a delete, but the other device's
    pieces remain. **Accepted limit:** two devices partially erasing the *same* stroke at the same moment each keep
    their own pieces, so ink can show twice (and an erased spot can show the other side's ink). Rare for one person's
    devices; nothing is lost. **Highlighters split too. Shapes are erased whole** (they are
  geometric, so a piece of a rectangle isn't a rectangle); text boxes and images are never erased. The radius is the
  eraser size (4 / 10 / 22 units). Each overlay `onErase` segment is one `applyErase` transaction; the app merges a
  gesture's segments into one undo entry (`CrossPageUndo.merging('erase')`), so **one undo restores the strokes whole**.
  While erasing in Partial mode the overlay draws a faint trail of the eraser's last 250 ms (`ERASE_TRAIL_MS`) on web,
  Android and iOS. Cost: the box cull in `hitTestErase` first, then only hit strokes are split (a pass over a
  3000-stroke page is a few ms).
- **Agents and readings:** a split is an erase plus new ink. In Q-ink a stroke whose new path is a shorter one inside
  its old box counts as erased (its old shape, faint red) and fresh (what's left), and the pieces are fresh, so the
  region is reported as `+pieces -1 (was R…)`. A reading of a split stroke reads its pieces too and goes stale; a
  thread anchored to it follows the new pieces as well. Lecture mode and anything else that
  follows the page's items sees the same add/remove events as any edit.
- **Scribble to erase** (GoodNotes 6 style; Settings → Pen, `scribbleErase`, on by default): when a pen stroke ends
  (not a snapped shape), `detectScribble` runs. Both must hold, else the stroke is ink:
  1. **It is a scribble** (`scribbleShape`, on the stroke resampled every 0.4 mm): ≥ **4 sharp reversals** (a turn of
     ≥ 130° within 1.2 mm of path either side); legs (between reversals) with a median chord of **2.5–120 mm** and
     **straightness ≥ 0.8**; same-side reversals close together: for 3 in 4 of them, their distance is **≤ 0.4 × the leg
     length** (the legs lie side by side; "m", "w", "MMM", "NNN" spread theirs out); average speed **≥ 60 mm/s** and
     at most **3 s** long.
  2. **It covers ink** (`scribbleTargets`): strokes and shapes with **≥ 60% of their points** inside the scribble's convex
     hull (grown by 1 mm plus half the pen width) that the **middles of ≥ 3 legs cross** (a leg is the path between
     two reversals, less **1.2 mm** at each end where it turns; marks under **4 mm** across need one). Two rules for
     **outlines**: snapped closed shapes, and closed strokes (ends within 20% of their size) that are **≥ 8 mm**
     across on average, or box-like (**≥ 3 corners** of 60°+ and filling **≥ 85%** of their own box). A small round
     closed stroke (o, 0, 8) is a letter. An outline whose box, grown by **0.4 × its shorter side (1.5–3 mm)**, holds
     the whole scribble is never a target (a checkbox ticked with a zig-zag that overshoots it); and when **≥ 60% of
     the scribble's turns lie within 1.5 mm** of an outline whose grown box holds ≥ 80% of them, the scribble is
     shading and **deletes nothing**, not even ink written inside (a "2" in a shaded box), unless the ink inside spans
     **≥ 60% of the outline one way and ≥ 40% the other** (a boxed answer being scribbled out). Text and images are
     never deleted.
  A scribble over empty paper (or shading) covers nothing and stays ink. Otherwise the covered ink is removed in one
  transaction (one undo brings it back), the scribble is never added (the overlay drops it through `committedIds`, as
  a hand-off), and the deleted ink fades out over 320 ms (`EraseFade`; at once with reduced motion). Thresholds are in
  page mm (1 unit = 1/72 in), so the same scribble works at any zoom. Tests: real-looking zig-zags (horizontal,
  vertical scratch-out, diagonal, small, uneven) and a corpus of ~150 handwriting strokes that must not trigger (m, mmm,
  w, www, MMM, NNN, ZZZ, eee, lll, sine, 8, spiral, a slow spring, a sparse sawtooth, a double underline, a tremor;
  2.5–8 mm at 25–90 mm/s, plus tall fast coils at 120–260 mm/s), and shading inside a 30 × 15 mm box and a 10 mm circle
  (hand-drawn and snapped; 0.6 / 1 / 1.5 mm apart at 80 / 150 / 200 mm/s; turning at the outline or overshooting it by
  1 mm; diagonal) that must keep the outline, 6–8 mm checkboxes ticked 2 mm past their sides, and a "2" inside a
  shaded box, in `packages/core/test/scribble.test.ts`; scribble-outs of a word in a hand-drawn box (1.5 / 2 / 3 mm
  margins) and of small closed letters (o, 8, "2o") in `scribbleProbes.test.ts`.
- **Limits:** a vertical scratch-out with legs further apart than ~0.4 × their length (e.g. 6 mm legs moving on 1.5 mm
  each) is kept as ink; scribble back and forth along the words instead. Circular scribbles ("@@@") aren't detected.

### Ruler (editor UI only)
- **What:** a toggle (toolbar, pill, R) shows a translucent straightedge over the pages: mm, 5 mm and numbered cm
  ticks on both long edges at the current page's scale (page mm at this zoom; mm ticks are left out below 3 px per mm),
  and its angle (0–179°). It belongs to the editor, not the page: never synced, saved, exported or sent to agents.
  Default 720 × 72 px (`RULER`), centred, no wider than the view less 48 px; its centre stays in the view.
- **Moving it** (`ruler.logic.ts`): one finger or the mouse on its body drags it; two fingers turn it about their
  midpoint and move it with them (a second finger anywhere counts once one is on the ruler); the round handle at its
  right end turns it with the mouse; × hides it. Angles snap to multiples of 45° within **4°** (`RULER.snapDeg`). A
  palm (the overlay's palm rules) doesn't move it. In "Pen and finger" a finger on the ruler moves it instead of
  drawing. The pose goes to the overlays (window coordinates) when a move holds still for **80 ms**
  (`RULER_SETTLE_MS`: a finger holding the ruler while the pen draws along it) and when it ends, so dragging doesn't
  re-render pages every frame; on web an overlay also reads the live pose at pen-down (`getRuler`), so a stroke follows
  the ruler where it is even mid-move.
- **Drawing along it** (`rulerEdgeAt`, `rulerLine`, `projectOnLine`; ports in `RulerSnap.kt` / `RulerSnap.swift`): a
  pen or highlighter stroke that **starts within 24 px** (`RULER.snapPx`, `RULER_SNAP_PX`; dp / pt on native) outside a
  long edge, or over the ruler's half next to it, and along its length (plus 24 px at each end) follows that edge:
  every point, predicted ones too, is projected onto the edge line pushed out by half the pen width, keeping pressure,
  tilt and time. Such a stroke never snaps to a shape, and is never taken for a scribble (`ruler` on `onStrokeEnd`:
  going back and forth along the ruler would look like one). On web a pen landing on the ruler is handed to the overlay
  underneath (`forwardToInk`: a synthetic pointerdown, then the overlay captures the pointer). Zoom-proof: the line is
  mapped into each page's units when the stroke starts.
- **Native:** the overlays snap. The pose is in React Native's `measureInWindow` coordinates, so Android measures its
  own origin the same way (`getLocationOnScreen` less `getWindowVisibleDisplayFrame`, so a status bar doesn't shift
  it) and iOS uses UIWindow coordinates (`convert(_:to: nil)`), which is what RN reports there. The ruler view itself is React Native, so on iPad and Android a pen landing
  on the ruler's body moves it (only web forwards it); strokes starting outside the edge snap everywhere.

### Laser pointer
- A tool (toolbar, pill, K) whose options are **Trail** (default) and **Dot** (`tools.laserMode`). It draws on the ink
  overlay only and never emits a stroke, so nothing is saved, synced or undoable. It never erases either: the pen's
  barrel button, the eraser end and the right mouse button (which erase that stroke with the other tools) draw the
  laser too.
- **Trail:** a red line, a 3 px core in brand `bad` (#b91c1c) over a 10 px glow in its dark tint (#f87171) at 35 %,
  each segment fading with its age and gone after **1 s** (`LASER_FADE_MS`), also after the pen lifts. **Dot:** a 4 px
  core in a 9 px glow under the pen, and under a hovering pen or mouse (the mouse cursor is hidden). Sizes are screen
  px at any zoom. Web: canvas, requestAnimationFrame while fading; Android: the front-buffered layer redrawn with
  `postOnAnimation`; iOS: a `LaserView` drawn with a CADisplayLink.

### Shape snapping (live: `recognizeShape`, `adjustShape`)
GoodNotes-style, gated by the `snapShapes` setting (the app passes `recognizeShape` to the overlay only when it's on):
- **Snap while holding.** Pen strokes only. The overlay times the hold: the pen stays within **2.5 mm**
  (`SNAP_HOLD_TOLERANCE_MM`, measured from where the hold began, not frame to frame) for **400 ms** (`SNAP_HOLD_MS`). It
  then asks for the shape of the stroke up to where the hold began. A shape replaces the ink under the pen at once: a
  haptic tick on Android (`CONFIRM`, API 30+, else `CLOCK_TICK`) and iOS (`UICanvasFeedbackGenerator` for the Pencil
  Pro on 17.5+, else a light impact); a short fading halo on web and Electron. Not a shape: nothing happens, the pen
  keeps drawing, and lifting keeps the ink.
- **Adjust while still holding** (`adjustShape`, ported to `LiveShape.kt` / `LiveShape.swift`): lines and arrows move
  the end nearest the pen by the pen's offset, the other end fixed, still snapping to horizontal or vertical within 5°.
  Closed shapes scale and turn uniformly about their centre, by the pen's distance and angle from the centre compared
  with where it snapped; so circles stay round and squares square. Turns under 6° keep the snapped orientation;
  rectangles and ellipses come upright within 6°. **Lift to place it.**
- **Native:** a JS function can't run synchronously on the UI thread. The view sends `onShapeHold` (request id and the
  points up to the hold) and the JS wrapper answers through the view function `setShapePreview(id, shape | null)`.
  The hold is the latency budget; an answer that arrives after the pen moved on (a new hold) or lifted is dropped.
  Adjusting runs natively, so the shape follows the pen without a round trip.
- **Storing it:** `onStrokeEnd` carries `shape: { kind, pts }` besides the hand-drawn `points`. The app adds the stroke,
  then the shape in its place under the same id (`commitSnapped`): two undo steps, so **one undo brings the hand-drawn
  stroke back**.

Recognition steps:
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
   - **Fitted corners (3 or 4):** a line is fitted through the middle 60% of each side and neighbouring sides are
     intersected: a hand rounds corners off, so the turning points sit inside the shape.
   - **3 corners:** triangle.
   - **4 corners:** rect if every angle is within 18° of 90°. It keeps its rotation, snaps upright within 5°, and becomes a
     square within 10%. Otherwise, or with corners at top/right/bottom/left, it's a diamond.
   - **5–6 corners:** a regular pentagon or hexagon, a point or flat side on top within 6°.
   - **5 sharp tips visited every other one:** a 5-point star (inner radius 0.382).
   - **Error limit:** each fit must stay within 6% of the size on average. With 4–7 corners, regular pentagon and hexagon
     fits of the whole outline are tried too.
   - **Rounded-off rectangle** (≤ 4 corners found): a box along the outline's dominant directions; a rect when it's
     within 4% of the size on average and closer than 0.7× the ellipse's error.
   - **Otherwise, an ellipse:** principal axes and extents, error under 11% (7% when corners were found). It becomes a circle
     when round within 10%, and upright within 8°.
Synthetic tests (jitter, wobble, rounded corners, overshoot, rotation) and held handwriting (e, a, s, 8, 2, m, L, V, Z, N,
cursive, spirals, scribbles) are in `packages/core/test/shapes.test.ts`; handwriting never snaps there. Quick, sparse,
wobbly strokes as the live hold sees them (wobbly and small circles, rounded rectangles, triangles, lines and arrows),
letters that must not snap unless held (o, 0, D, ∫) and `adjustShape` are in `packages/core/test/liveShapes.test.ts`.
