export type Tool = 'pen' | 'highlighter';
export type Paper = 'blank' | 'ruled' | 'dotted' | 'grid' | 'cornell' | 'weekly';
export type PaperColor = 'white' | 'cream' | 'night';
export type BBox = [x0: number, y0: number, x1: number, y1: number];
export interface Size { w: number; h: number }

export interface InkPoint {
  x: number;
  y: number;
  /** 0..1 */
  p: number;
  /** altitude in radians, π/2 = upright */
  tilt: number;
  /** azimuth in radians */
  az: number;
  /** ms since stroke start */
  t: number;
}

/** Pen nib (pen strokes only). Missing = 'fountain', the look of strokes from before styles existed. */
export type PenStyle = 'fountain' | 'ball' | 'brush';
/** Input stabilisation, 1 low .. 3 high (pen strokes only). Missing or 0 = none, as strokes from before it existed. */
export type Smoothing = 0 | 1 | 2 | 3;
export interface StrokeItem {
  id: string;
  type: 'stroke';
  tool: Tool;
  color: string;
  width: number;
  points: InkPoint[];
  bbox: BBox;
  createdAt: number;
  /** Stored per stroke so a stroke never changes look when the defaults change. */
  style?: PenStyle;
  smoothing?: Smoothing;
}
/** `rot` (radians, clockwise on the page) turns a text box or image about its top-left corner `(x, y)`; missing = 0. */
export interface TextItem { id: string; type: 'text'; x: number; y: number; w: number; text: string; fontSize: number; color: string; rot?: number }
export interface ImageItem { id: string; type: 'image'; assetId: string; x: number; y: number; w: number; h: number; rot?: number }
export type ShapeKind =
  | 'line'
  | 'arrow'
  | 'double-arrow'
  | 'rect'
  | 'ellipse'
  | 'triangle'
  | 'diamond'
  | 'pentagon'
  | 'hexagon'
  | 'star';
/**
 * `pts` per kind: line `[a, b]`; arrow `[tail, tip]`; double-arrow `[a, b]`; rect 4 corners; triangle 3 corners;
 * diamond 4, pentagon 5, hexagon 6 corners; star its 10 outer and inner points in order;
 * ellipse `[[x0, y0], [x1, y1]]` (axis-aligned box, older shapes) or the 4 corners of its rotated box.
 */
export interface ShapeItem { id: string; type: 'shape'; kind: ShapeKind; pts: [number, number][]; color: string; width: number }
export type Item = StrokeItem | TextItem | ImageItem | ShapeItem;

export type TextSrc = 'device' | 'agent' | 'user';
export interface Line {
  /** id of the line's first item; globally unique */
  key: string;
  kind: 'line' | 'drawing';
  itemIds: string[];
  bbox: BBox;
  text?: string;
  textSrc?: TextSrc;
  conf?: number;
}

export interface Author { kind: 'agent' | 'user'; name: string }
export interface Comment {
  id: string;
  lineKey: string;
  author: Author;
  text: string;
  createdAt: number;
  resolved: boolean;
  replies: { author: Author; text: string; at: number }[];
  /** Page-space box of the selection a thread is about (a student's comment or Ask on a selection). */
  anchor?: BBox;
  /**
   * The selected item ids a thread is about. The pin box and the agent's line labels are derived from these items
   * live (`threadBox`), so the thread follows its ink; `anchor` stays as the fallback for threads made before this.
   */
  anchorIds?: string[];
  /** The thread was started by an Ask: its question reaches agents as the `ask`, not as a `note`. */
  ask?: boolean;
}

export type Orientation = 'portrait' | 'landscape';
export type PageBackground = { kind: 'paper' } | { kind: 'pdf'; assetId: string; pageIndex: number };

export interface NotebookMeta {
  id: string;
  title: string;
  cover: string;
  paper: Paper;
  paperColor: PaperColor;
  size: Size;
  orientation: Orientation;
  aiAccess: boolean;
  /** "Pause sharing": agents keep their access but get no updates and can't call tools until resumed. */
  aiPaused?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface PageInfo {
  id: string; size: Size; paper: Paper; paperColor: PaperColor; background: PageBackground;
  /** Bookmarked in the page navigator (missing = not bookmarked). */
  bookmarked?: boolean;
}
export interface Asset { id: string; sha256: string; mime: string; name: string; bytes: number; pageCount?: number }
/** What a selection Ask is about: the selected item ids and their page-space box. */
export interface AskSelection { itemIds: string[]; bbox: BBox }
export interface Ask {
  id: string;
  pageId: string;
  text: string;
  at: number;
  sel?: AskSelection;
  /** The thread (page comment) the answer belongs in. */
  commentId?: string;
}
