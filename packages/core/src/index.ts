export * from './types';
export { LOCAL_ORIGIN } from './origin';
export { encodePoints, decodePoints } from './points';
export { Notebook, createNotebookDoc, type NotebookInit } from './model/notebook';
export { Page } from './model/page';
export { Library, DEFAULT_SWATCHES, MAX_SWATCHES, type Folder, type LibraryEntry, type SwatchTool } from './model/library';
export { normalizeColor, splitAlpha, withAlpha, inkPaint } from './geometry/color';
export { createUndoManager, createNotebookUndoManager } from './model/undo';
export {
  strokeOutline,
  strokeSvgPath,
  tiltPressure,
  stabilize,
  PEN_WIDTHS,
  PEN_STYLES,
  SMOOTHING,
  DEFAULT_PEN_STYLE,
  DEFAULT_SMOOTHING,
  HIGHLIGHTER_WIDTH,
  HIGHLIGHTER_ALPHA,
} from './geometry/stroke';
export { snapShape, SNAP_HOLD_MS } from './geometry/shape';
export { hitTestErase, lassoSelect } from './geometry/hit';
export { itemBBox, unionBBox, textHeight, setTextMeasure, boxCorners, TEXT_LINE_HEIGHT, type TextMeasure } from './geometry/bbox';
export { shapePolylines, ellipseAxes } from './geometry/shape';
export {
  IDENTITY,
  moveBy,
  applySim,
  simMatrix,
  isIdentity,
  transformItem,
  transformPatch,
  visualBBox,
  selectionFrame,
  frameCorners,
  frameBBox,
  mapFrame,
  resizeSim,
  rotateSim,
  textWidthPatch,
  itemDistance,
  hitTestPoint,
  boxSelect,
  type Sim,
  type Frame,
} from './geometry/transform';
export { paperPattern, inkOnPaper, swatchOfInk, DEFAULT_INK, NIGHT_INK, PAPER_BG, type PaperPattern } from './geometry/paper';
export { renderPageSvg } from './render/svg';
export { renderLinesStripSvg } from './render/strip';
export { exportPdf, type ExportPdfOptions } from './export/pdf';
export { packQalm, unpackQalm, type QalmBundle } from './export/qalm';
export {
  assignLabels,
  encodeQinkUpdate,
  encodeQinkRead,
  encodeQinkThread,
  cleanAsk,
  resolveRef,
  resolveThread,
  threadLabel,
  emptyThreads,
  labelList,
  type QinkLabels,
  type QinkSnapshot,
  type QinkImage,
  type QinkThreads,
  type QinkSeen,
  type QinkAsk,
} from './qink';
export { threadBox, anchorInkRemoved, anchorLines } from './anchor';
