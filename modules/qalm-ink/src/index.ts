export { PageCanvas } from './PageCanvas';
export { renderThumbnail, type ThumbnailInput } from './thumbnail';
export type { PageCanvasProps, CommentAnchor } from './PageCanvas';
export { InkOverlay } from './InkOverlay';
export { PALM_MAJOR_MM, PEN_LOCKOUT_MS } from './InkOverlay.types';
export type {
  InkTool,
  InkPenStyle,
  InkSmoothing,
  InkPoint,
  InkInputSettings,
  InkOverlayProps,
  StrokeEndEvent,
  EraseEvent,
  LassoEvent,
  PenButtonEvent,
  RejectedTouchEvent,
} from './InkOverlay.types';
export { QalmInk } from './QalmInk';
export type { QalmInkModuleType } from './QalmInk.types';
/** @deprecated Temporary shim types; removed with `QalmInk.recognize`. */
export type { RecognizeLine, RecognizeResult } from './QalmInk';
