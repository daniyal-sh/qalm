# Qalm v1 technical spec

Read with `decisions.md` (scope), `qink-live.md` (AI format) and **`brand.md` (Qalm by Apollo: colours, type, mark)**.
Layouts and flows come from `mockups/editor.html`, `mockups/screens-library.html` and `mockups/screens-ai.html`.
Their colours and fonts are superseded by `brand.md`.
This file is the **contract between packages**. If you must change a contract, change it here too.

## 1. Repo layout (pnpm workspace, `node-linker=hoisted` for Expo)

```
packages/core     @qalm/core     TypeScript, no platform deps. Model, geometry, render, export, Q-ink
modules/qalm-ink  qalm-ink       Expo native module: ink surface + on-device recognition
                                 ios/ (Swift), android/ (Kotlin), src/ (TS API + web implementation)
apps/app          @qalm/app      Expo app (iOS, Android, web). All UI screens
apps/desktop      @qalm/desktop  Electron shell that loads the app's web build
apps/server       @qalm/server   Cloudflare Worker: auth, sync, assets, MCP
```

Shared rules: TypeScript strict, ESM, Vitest for tests, no `any` in public APIs.
Coordinates are page units in **PDF points** (A4 = 595×842, Letter = 612×792, A5 = 420×595).

## 2. Data model (`@qalm/core`, Yjs)

There's one `Y.Doc` per notebook (doc id `nb:{notebookId}`) and one per user library (`lib:{userId}`).

### Notebook Y.Doc layout
```
meta:    Y.Map  { id, title, cover, paper, paperColor, size:{w,h}, orientation, aiAccess:boolean, createdAt, updatedAt }
pages:   Y.Array<string>                      page order
page:{id}: Y.Map {
           id, size:{w,h}, paper, paperColor,
           background: {kind:'paper'} | {kind:'pdf', assetId, pageIndex},
           items: Y.Map<itemId, Y.Map>,       item fields as below; stroke points as Uint8Array
           order: Y.Array<itemId>,            z-order
           lines: Y.Map<lineId, Y.Map>,       Line fields
           nextLine: number, nextDrawing: number }
assets:  Y.Map<assetId, {id, sha256, mime, name, bytes, pages?}>
comments:Y.Map<commentId, Comment>
asks:    Y.Array<{id, pageId, text, at}>      student tapped Ask
```

### Types (exported from `@qalm/core`)
```ts
type Tool = 'pen' | 'highlighter';
type Paper = 'blank' | 'ruled' | 'dotted' | 'grid' | 'cornell' | 'weekly';
type PaperColor = 'white' | 'cream' | 'night';
interface InkPoint { x: number; y: number; p: number /*0..1*/; tilt: number /*altitude rad, π/2 = upright*/; az: number /*azimuth rad*/; t: number /*ms since stroke start*/ }
interface StrokeItem { id: string; type: 'stroke'; tool: Tool; color: string; width: number; points: InkPoint[]; bbox: BBox; createdAt: number }
interface TextItem  { id: string; type: 'text'; x: number; y: number; w: number; text: string; fontSize: number; color: string }
interface ImageItem { id: string; type: 'image'; assetId: string; x: number; y: number; w: number; h: number }
interface ShapeItem { id: string; type: 'shape'; kind: 'line'|'arrow'|'rect'|'ellipse'|'triangle'; pts: [number, number][]; color: string; width: number }
type Item = StrokeItem | TextItem | ImageItem | ShapeItem;
type BBox = [x0: number, y0: number, x1: number, y1: number];
interface Line { id: string /*'L1' | 'D1'*/; kind: 'line' | 'drawing'; itemIds: string[]; bbox: BBox; text?: string; textSrc?: 'device'|'agent'|'user'; conf?: number }
interface Comment { id: string; pageId: string; ref: string /*'L4'|'D1'*/; author: { kind: 'agent'|'user'; name: string }; text: string; createdAt: number; resolved: boolean; replies: { author: {kind:'agent'|'user'; name:string}; text: string; at: number }[] }
```
Stroke points are stored as a Float32Array of 6-tuples `(x, y, p, tilt, az, t)`, exposed as a `Uint8Array`
(`encodePoints` / `decodePoints`).

### Notebook API
```ts
createNotebookDoc(init: { id: string; title: string; cover: string; paper: Paper; paperColor: PaperColor; size: {w:number;h:number} }): Y.Doc
class Notebook {
  constructor(doc: Y.Doc)
  readonly doc: Y.Doc
  meta(): NotebookMeta; setMeta(patch: Partial<NotebookMeta>): void
  pages(): PageInfo[]; addPage(opts?: Partial<PageInfo>, index?: number): string; removePage(id: string): void
  items(pageId: string): Item[]; addItem(pageId: string, item: Item): void
  updateItem(pageId: string, id: string, patch: Partial<Item>): void; removeItems(pageId: string, ids: string[]): void
  lines(pageId: string): Line[]                 // maintained automatically by addItem/removeItems/updateItem
  setLineText(pageId: string, lineId: string, text: string, src: 'device'|'agent'|'user', conf?: number): void
  comments(pageId?: string): Comment[]; addComment(c: Omit<Comment,'id'|'createdAt'|'resolved'|'replies'>): string
  replyToComment(id: string, author: Comment['author'], text: string): void; resolveComment(id: string): void
  assets(): Asset[]; addAsset(a: Asset): void
  addAsk(pageId: string, text: string): void
  observe(cb: () => void): () => void
}
class Library { constructor(doc: Y.Doc) /* folders + notebook entries {id,title,cover,folderId,updatedAt,aiAccess,favorite,deletedAt} */ }
```
Every mutation runs in a single `doc.transact`.

### Line assignment (stable IDs)
When a stroke is added, it joins an existing `line` on the same page if its vertical overlap with the line's bbox is
≥ 50% of the smaller height, **and** the horizontal gap is ≤ 1.5 × the line's height. Otherwise a new line is
created with the id `L{nextLine++}`. Shape items, and strokes taller than 2.5 × the page's median line height,
form drawings with the id `D{nextDrawing++}`, merged with overlapping drawings.
IDs are never reused. A line with no items is deleted. When a line's items change, its `text` is cleared unless
`textSrc === 'user'`.

### Geometry, rendering and export
```ts
strokeOutline(s: StrokeItem): [number, number][]    // closed polygon. Pressure and tilt shading; highlighter = flat
strokeSvgPath(s: StrokeItem): string
snapShape(points: InkPoint[], heldMs: number): ShapeItem | null   // only if heldMs >= 500
hitTestErase(items: Item[], path: {x:number;y:number}[], radius: number): string[]   // stroke eraser
lassoSelect(items: Item[], polygon: {x:number;y:number}[]): string[]
renderPageSvg(nb: Notebook, pageId: string, opts?: { paper?: boolean; assetUrl?: (id: string) => string }): string
renderLinesStripSvg(nb: Notebook, pageId: string, refs: string[]): { svg: string; width: number; height: number }
  // black on white, rows stacked, row label "[n]" on the left, about a 24px x-height
exportPdf(nb: Notebook, getAsset: (id: string) => Promise<Uint8Array>): Promise<Uint8Array>   // pdf-lib
packQalm(nb: Notebook, getAsset): Promise<Uint8Array>; unpackQalm(bytes): Promise<{ doc: Y.Doc; assets: Map<string, Uint8Array> }>  // zip (fflate)
```

### Q-ink (see `qink-live.md` §2 for the text format)
```ts
interface QinkSnapshot { rev: number; pages: Record<string /*pageId*/, Record<string /*lineId*/, string /*hash of itemIds+text*/>> }
encodeQinkUpdate(nb: Notebook, prev: QinkSnapshot | null, opts: { session: string; rev: number; asks?: {pageId:string;text:string}[] })
  : { text: string; image: { pageId: string; refs: string[] } | null; snapshot: QinkSnapshot }
encodeQinkRead(nb: Notebook, ref: string /*'outline' | 'p3' | 'p3:L2-9' | 'pdf:p2'*/)
  : { text: string; image: { pageId: string; refs: string[] } | null }
```
Pages are referred to by **1-based position** (`p3`) in Q-ink text. Any line whose `text` is missing or whose `textSrc === 'device'`
goes in the image, with `~"guess"` when device text exists. Lines with `textSrc` agent or user are sent as text only.

## 3. Ink module (`qalm-ink`, Expo Modules API)

Native module name `QalmInk`, native view `QalmInkView`. Android package `app.qalm.ink` (Kotlin), iOS Swift
(`QalmInkModule.swift`, `QalmInkView.swift`). The web implementation is `src/QalmInkView.web.tsx` (canvas + pointer events),
which is also what Electron uses.

The view renders **one page**. Low-latency rendering of the in-progress stroke happens natively:
- Android: androidx.ink `InProgressStrokesView` (front-buffered), plus motion prediction.
- iOS: coalesced and predicted `UITouch`es, rendered with Metal or Core Graphics incrementally at 120 Hz.
- Web: `getCoalescedEvents`/`getPredictedEvents` and a `desynchronized` canvas.

Committed content is rendered by the view from the `items` prop.

```ts
type InkTool = 'pen' | 'highlighter' | 'eraser' | 'lasso' | 'none';
interface QalmInkViewProps {
  pageSize: { w: number; h: number };          // page units; the view scales to fit its width
  items: Item[];                                // committed content (core types), re-rendered when it changes
  selection?: string[];                         // item ids drawn with a selection outline
  tool: InkTool; color: string; width: number;
  input: { drawWith: 'pen' | 'any'; hand: 'left' | 'right'; palm: 'relaxed' | 'standard' | 'strict' };
  onStrokeEnd(e: { nativeEvent: { tool: 'pen'|'highlighter'; color: string; width: number; points: InkPoint[]; heldMs: number } }): void;
  onErase(e: { nativeEvent: { path: {x:number;y:number}[] } }): void;   // eraser drag path, page units
  onLasso(e: { nativeEvent: { polygon: {x:number;y:number}[] } }): void;
  onPenButton?(e: { nativeEvent: { kind: 'double-tap'|'squeeze'|'button' } }): void;
  onRejectedTouch?(e: { nativeEvent: { reason: string } }): void;
}
// functions
QalmInk.recognize(lines: { id: string; strokes: InkPoint[][] }[], lang: 'en-US'): Promise<{ id: string; text: string; score: number }[]>
QalmInk.ensureModel(lang: 'en-US'): Promise<void>
```
Recognition uses ML Kit Digital Ink on Android and iOS. On the web, `recognize` resolves `[]`, and the desktop app
may provide its own recognizer later through the Electron preload. An empty guess is fine because agents read the image.

Palm rejection (every platform, inside the native view):
1. Pen input always draws. With `drawWith: 'pen'`, touches never draw (they scroll and zoom).
2. Touches with a large contact size are rejected (`palm` thresholds: relaxed 40, standard 30, strict 22 px major axis).
3. Touches within 600 ms of pen activity, or below or beside the pen on the `hand` side, are rejected.
4. An OS cancel (`ACTION_CANCEL` / `FLAG_CANCELED` / `touchesCancelled`) retracts the in-progress stroke.

Hover (where supported) shows a brush-size preview. The pen button, squeeze or double-tap fires `onPenButton`, and the
app switches to the eraser.

## 4. Server (`apps/server`, Cloudflare Workers)

- **Durable Object `DocRoom`**, one per doc id. It speaks the Yjs sync and awareness protocol over a hibernating WebSocket at
  `GET /sync/{docId}?token=`. It persists updates in DO storage and compacts them into a snapshot every 200 updates.
  It tracks `lastClientUpdateAt` for wake rules.
- **R2** `ASSETS`: `PUT /assets/{sha256}` and `GET /assets/{sha256}` (authenticated; content-addressed).
- **D1** tables: `users`, `sessions`, `magic_links`, `notebooks(id, owner_id, title, ai_access)`, plus OAuth and MCP grants
  (`grants(client_id, user_id, notebook_ids|folder_ids, can_comment, can_transcribe, expires_at)`).
- **Auth**: `POST /auth/email/start`, `GET /auth/email/verify`, `POST /auth/apple`, `POST /auth/google`.
  These return `{accessToken (JWT, 1h), refreshToken}`, and `POST /auth/refresh` renews them. In dev, emails are logged.
- **MCP**: Streamable HTTP at `/mcp` with OAuth 2.1 and dynamic client registration (`@cloudflare/workers-oauth-provider`).
  The consent page is served by the worker, matching mockup screen 5. There are 4 tools: `wait`, `read`, `transcribe` and `comment`,
  as in `qink-live.md`. Images are returned as MCP image content: a PNG made from `renderLinesStripSvg`
  with `@resvg/resvg-wasm`.
- **Wake rules**: `wait(s)` resolves when (pen idle ≥ 6 s **and** changes since the last delivery **and** ≥ 20 s since the last wake)
  **or** a new `asks` entry arrives. The per-agent `QinkSnapshot` is stored in the DO.

## 5. App (`apps/app`, Expo, New Architecture, expo-router)

Screens: Library, New notebook sheet, Editor (pages list of `QalmInkView`, floating toolbar, comments panel,
Ask button), Settings (Account, Pen and palm rejection, AI access with connected agents, pending requests and an activity log),
and Sign-in. The client sync uses the `y-websocket` provider to `/sync/{docId}`, with IndexedDB persistence on the web and
MMKV or file persistence on native. Debounced on-device recognition runs 1 s after a line changes, then calls `setLineText(…, 'device', score)`.

## 6. Desktop (`apps/desktop`, Electron)

It loads the app's web export (`expo export -p web`) from disk, has a native window frame, and provides `window.qalmDesktop`
in the preload (file open/save dialogs for PDF import and export). It's packaged with electron-builder for Windows and macOS.
