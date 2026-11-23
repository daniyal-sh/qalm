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
  meta:   Y.Map  { id, title, cover, paper, paperColor, size:{w,h}, orientation, aiAccess, aiPaused?, createdAt, updatedAt }
  pages:  Y.Array<Y.Map>   { id, size:{w,h}, paper, paperColor, background: {kind:'paper'} | {kind:'pdf', assetId, pageIndex}, bookmarked? }
  assets: Y.Map<assetId, {id, sha256, mime, name, bytes, pageCount?}>
  asks:   Y.Array<{id, pageId, text, at, sel?: {itemIds, bbox}, commentId?}>   sel: an Ask about a selection; commentId: its thread

pg:{notebookId}:{pageId}   page doc
  items:    Y.Map<itemId, Y.Map>   item fields below; stroke points as Uint8Array
  order:    Y.Array<itemId>        z-order
  lines:    Y.Map<lineKey, Y.Map>  Line fields
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
interface Line { key: string /* = id of the line's first item; globally unique */; kind: 'line' | 'drawing'; itemIds: string[]; bbox: BBox; text?: string; textSrc?: 'device'|'agent'|'user'; conf?: number; by?: string /* the agent that transcribed it */ }
interface Comment { id: string; lineKey: string /* '' if a selection has no ink line */; author: { kind: 'agent'|'user'; name: string }; text: string; createdAt: number; resolved: boolean; replies: { author: {kind:'agent'|'user'; name:string}; text: string; at: number }[]; anchor?: BBox /* selection box */; anchorIds?: string[] /* the selected items: box and labels are derived from them live */; ask?: boolean /* started by an Ask */ }
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
  lines(): Line[]                    // maintained automatically on add/update/remove
  setLineText(lineKey, text, src: 'device'|'agent'|'user', conf?, by?): void
  clearLineText(lineKey): void   // back to automatic: no reading
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

### Line assignment (keys are race-free)
When a stroke is added, it joins an existing `line` if its vertical overlap with the line's bbox is ≥ 50% of the smaller
height **and** the horizontal gap is ≤ 1.5 × the line's height. Otherwise it starts a new line whose **key is the stroke's ID**.
Shape items, and strokes taller than 2.5 × the page's median line height, form `drawing`s with the same keying, merged with
overlapping drawings (the earliest key wins). Lines with no items are deleted.

**A line's reading** (`text`, `textSrc`, `conf`: an agent's `transcribe`, the device's guess, the student's text) is of
its items. It is cleared, unless `textSrc === 'user'`, when an edit changes **which items the line has**: an item joins
(a stroke written onto it, one moved onto it) or leaves (erased, moved away, so a partly moved line loses it on both
parts). An edit that leaves the line with the same items under the same key keeps it: moving, resizing or rotating a
whole line (or a selection of whole lines), recolouring, reordering. "An edit" is one transaction (one undo step): the
items are reassigned one by one, which splits and re-merges a moved line on the way, and the reading is settled against
the line's items at the start of the transaction. Moving a line's items in separate transactions is a change per step.
A reading saved during a transaction is of the items at that point.
**Editing a reading** (app): select a handwritten line (or tap it with the lasso) → **Reading** on the selection bar.
The sheet shows the saved text and its source (on-device guess, "Read by {agent}", or yours) with an edit field.
Saving writes `textSrc: 'user'`, which device guesses and agents can't overwrite (the server refuses `transcribe`); an
empty field or "Use automatic" calls `clearLineText`. Unchanged text stays automatic. Drawings, images and text boxes
have no reading. One undo step per save. Two offline devices may create two separate lines that overlap. That's fine, because keys never collide.
Short labels (`L7`, `D2`) exist **only in Q-ink**, and the server assigns them (§4).

Items are assigned one at a time, in the order they are added or changed, so a bulk edit (moving, duplicating or
deleting a selection) gives the same lines and keys as editing its items one by one. To keep that fast, `Page` keeps
the page's grouping in a per-doc **line index** that each step updates (no re-reading of the whole page per item), and
writes items' `line` fields once when the outermost `Page` call returns. The index follows transactions made through
`Page` and is rebuilt after anything else changes the doc (remote updates, undo, or raw writes, also between two `Page`
calls in one transaction). Moving 3000 strokes takes ~45 ms instead of ~2.4 s.

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
threadBox(comment, items, lines): BBox | null   // where a thread sits, live; null once its line or anchored ink is gone
anchorInkRemoved(comment, items): boolean
paperPattern(paper: Paper, color: PaperColor, size): { lines: [x0,y0,x1,y1][]; dots: [x,y][]; stroke: string; bg: string }  // shared by Skia and SVG
renderPageSvg(info: PageInfo, page: Page, opts?: { paper?: boolean; assetUrl?: (id) => string }): string
renderLinesStripSvg(page: Page, lineKeys: (string | BBox)[], labels: string[]): { svg: string; width: number; height: number }  // black on white, "[n]" rows; a BBox is a crop row
exportPdf(nb: Notebook, loadPage: (pageId) => Promise<Page>, getAsset: (id) => Promise<Uint8Array>): Promise<Uint8Array>   // pdf-lib
packQalm(...) / unpackQalm(bytes) -> { index: Y.Doc; pages: Map<pageId, Y.Doc>; assets: Map<id, Uint8Array> }              // zip (fflate)
```

### Q-ink (text format in `qink-live.md` §2)
```ts
interface QinkLabels { [pageId: string]: { nextL: number; nextD: number; byKey: Record<string /*lineKey*/, string /*'L7'*/> } }
interface QinkSnapshot { [pageId: string]: Record<string /*lineKey*/, string /*hash of itemIds + text*/> }
assignLabels(labels: QinkLabels, pageId: string, lines: Line[]): void       // mutates; existing labels never change, new keys get the next number
interface QinkThreads { next: number; byId: Record<string /*commentId*/, { label: string /*'C3'*/; pageId: string }> }   // notebook-wide, server-stored
type QinkSeen = Record<string /*commentId*/, number /*entries seen: comment + replies*/>                               // per agent
encodeQinkUpdate(nb: Notebook, pages: Record<string, Page> /*the pages to diff*/, labels: QinkLabels, prev: QinkSnapshot, opts: { session; rev; asks?; threads?; seen? })
  : { text: string; image: { pageId: string; lineKeys: (string | BBox)[]; labels: string[] } | null; snapshot: QinkSnapshot; seen: QinkSeen }
  // adds `note`/`re` for the student's new thread entries on the passed pages, and `ask C6 p3:L4-6 [n] "…"` for selection asks
encodeQinkRead(nb: Notebook, pages: Record<string, Page>, labels: QinkLabels, ref: string /*'outline' | 'p3' | 'p3:L2-9' | 'pdf:p2'*/)
  : { text: string; image: { pageId: string; lineKeys: string[]; labels: string[] } | null }
resolveRef(labels, nb, ref: 'p3:L4'): { pageId: string; lineKey: string }   // for transcribe and comment
threadLabel(threads, commentId, pageId): string; resolveThread(threads, 'C3'): { pageId; commentId }   // for comment(thread)
```
Q-ink refers to pages by **1-based position** (`p3`). A line without text, or with `textSrc === 'device'`, goes into the image, with
`~"guess"` added when device text exists. Lines with `textSrc` agent or user are sent as text only.

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
interface PageCanvasProps { info: PageInfo; items: Item[]; selection?: string[]; anchors?: { lineKey: string; bbox: BBox; active: boolean }[]; pdfImage?: string /*uri*/; width: number /*px*/; onDrawn?(ids: string[]): void /*item ids, once Skia has them*/;
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
QalmInk.recognize(lines: { key: string; strokes: InkPoint[][] }[], lang: 'en-US'): Promise<{ key: string; text: string; score: number }[]>  // ML Kit; web/desktop resolve []
QalmInk.ensureModel(lang: 'en-US'): Promise<void>
QalmInk.renderPdfPage(fileUri: string, pageIndex: number, widthPx: number): Promise<string /*cached png file uri*/>
  // iOS PDFKit, Android android.graphics.pdf.PdfRenderer, web pdf.js (returns an object URL)
```

**Zoom:** the app's editor handles pinch (react-native-gesture-handler) between 0.75× and 4×. While pinching, it applies a transform.
When the gesture ends, it lays the page out again at `width = baseWidth × scale`, which re-renders Skia (vector, so crisp) and re-requests the PDF
background at the nearest width bucket (1×, 2× or 4× the base width, at most 4096 px; pages mounted off screen use 1×). The overlay maps its
own size onto the page, so it needs no zoom state.

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
  content: a PNG made from `renderLinesStripSvg` with `@resvg/resvg-wasm`.
- **What an agent sees:** a notebook is visible only if it is (a) a live library entry (not trashed, not deleted forever), (b) inside the grant
  (picked directly or in a granted folder), and (c) has AI access on. (c) is read live from the notebook's index doc in its `DocRoom` on every tool
  call and on every pass of the `wait` update stream, so switching it off takes effect at once (a pending `wait` ends with an error). A notebook
  whose meta is unknown counts as off. `notebooks.ai_access` in D1 is a mirror kept by the `DocRoom` on every client update of the index doc; the
  consent page uses it to mark notebooks with AI access off (they can be granted but stay hidden until it's turned on).
- **Q-ink labels and snapshots** live in the notebook `DocRoom`'s storage (`QinkLabels`, plus a `QinkSnapshot` per agent session).
  Only that object assigns labels, so they're stable and unique.
- **Wake rules:** `wait(s)` resolves when (pen idle ≥ 6 s **and** changes since the last delivery **and** ≥ 20 s since the last wake) **or** a new `asks` entry arrives
  **or** the student added a comment or reply (a page room flags client transactions that touch its `comments` map and tells the notebook room,
  which keeps `lastCommentAt`). Only the changed pages are loaded.
- **Threads:** the notebook room stores `QinkThreads` (labels `C1`, `C2`, …) and, in each agent's state, `QinkSeen`. `comment {ref}` creates the
  comment in the page room and labels it; `comment {thread, resolve?}` replies there (author: the grant's client name). Agents still never touch ink.
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
    (pins on the page otherwise, plus a toast when an agent writes), and an unread badge on Comments (per device, `seen:{notebookId}` in kv)
  - Page navigator (top-bar "Pages"): thumbnails of every page, as a sidebar on windows ≥ 900 px wide and a full-screen grid below
    that. Tap to jump, long-press and drag to reorder, bookmark (with a Bookmarks filter), duplicate and delete; the current page is
    highlighted. Thumbnails render lazily (only cells on screen, one at a time, into an offscreen CPU surface as small JPEGs) and are
    cached until the page changes. Desktop keys: PgUp / PgDn, Home / End, Ctrl+G (go to page; the "Page n of m" label opens it too).
  - Settings: Account, Pen and palm rejection, and AI access (connected agents, pending requests, activity log)
  - Sign-in
- **Sync:** the client uses the `y-websocket` provider (with tickets) for each loaded doc, with IndexedDB persistence on web and file persistence on native.
  Native snapshot files are replaced crash-safely: write `.tmp`, rename the old file to `.bak`, rename `.tmp` into place, delete `.bak`; reads fall
  back to a complete `.tmp`, then `.bak`.
- **Big notebooks:** the editor renders views only for pages near the viewport (mounted pages ±2, plus plain page outlines a few pages further)
  and re-renders on scroll only when the shown pages change. Page docs open one at a time, nearest the current page first (`pageDocQueue`),
  and stay in an LRU of 24 idle docs (flushed before they are dropped; pages with undo history are dropped last). PDF renders run 2 at a
  time, newest first, and are skipped if the page scrolled away; on web the last 24 rendered pages are kept and older bitmaps revoked.
  Benchmark: `pnpm --filter @qalm/app bench:micro`, and `EXPO_PUBLIC_QALM_BENCH=1 pnpm --filter @qalm/app export:web` then
  `node apps/app/scripts/bench/run.mjs --label <name>` (headless Chrome: 300-page mixed notebook and a 300-page PDF).
- **`.qalm` backups** restore as a **new** notebook (new notebook and page ids, title + " (restored)"), copying pages, items, lines, comments, assets
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
- **Recognition:** debounced on-device recognition runs 1 s after a line changes, then calls `setLineText(key, …, 'device', score)`.

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
`updateItem` re-runs line assignment for moved ink. The selection bar recolours, duplicates, copies, cuts, pastes (an
in-app clipboard that works across pages and notebooks, copying image assets into the target notebook), brings to
front / sends to back, comments, asks and deletes; Ctrl/Cmd + C / X / V / D / A and Delete work on desktop. A thread
started from a selection stores its item ids (`anchorIds`), so its pin, margin card and Q-ink labels follow the ink; once
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
