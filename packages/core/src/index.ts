export * from './types';
export { LOCAL_ORIGIN } from './origin';
export { encodePoints, decodePoints } from './points';
export { Notebook, createNotebookDoc, type NotebookInit } from './model/notebook';
export { Page, readingsOf, freshCover } from './model/page';
export { migratePage, needsMigration, MIGRATION_ORIGIN } from './model/migrate';
export { summarizeThread, summarizeThreads, threadNewer, agentEntriesAfter, THREADS_ORIGIN, SUMMARY_TEXT, type ThreadSummary } from './model/threads';
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
export { adjustShape, recognizeShape, snapShape, SNAP_HOLD_MS, SNAP_HOLD_TOLERANCE_MM } from './geometry/shape';
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
export { paperPattern, inkOnPaper, itemsOnPaper, swatchOfInk, DEFAULT_INK, NIGHT_INK, PAPER_BG, type PaperPattern } from './geometry/paper';
export { renderPageSvg } from './render/svg';
export { renderRegionsSvg, rowScale, UNIT_PX, MAX_ROW_AREA, MIN_UNIT_PX, type RegionRow } from './render/regions';
export {
  pageUnit,
  clusterBoxes,
  contextFor,
  boxGap,
  inkBoxes,
  isInk,
  gridScale,
  gridSize,
  toGrid,
  fromGrid,
  gridPlace,
  boxRef,
  CLUSTER_GAP,
  NEAR,
  ROW_GAP,
  ROW_BAND,
  MAX_CONTEXT,
} from './geometry/regions';
export { exportPdf, type ExportPdfOptions } from './export/pdf';
export { packQalm, unpackQalm, type QalmBundle } from './export/qalm';
export {
  encodeQinkUpdate,
  encodeQinkRead,
  encodeQinkThread,
  cleanAsk,
  resolveTarget,
  resolveThread,
  registerRegion,
  threadLabel,
  emptyThreads,
  emptyRegions,
  inkInBox,
  inkSig,
  pageInk,
  sigPolyline,
  MAX_REGIONS,
  type InkSeen,
  type QinkRegion,
  type QinkRegions,
  type QinkTarget,
  type QinkImage,
  type QinkThreads,
  type QinkSeen,
  type QinkAsk,
} from './qink';
export { threadBox, anchorInkRemoved } from './anchor';
export { parseMarkdown, markdownToPlain, safeHref, type MdBlock, type MdInline, type Marks } from './markdown/parse';
export { allowedMath, layoutMarkdown, rendersMarkdown, LAYOUT_VERSION, type MdLayout, type MdOp } from './markdown/layout';
export { texToPath, withMathBudget, mathAllowance, MATH_LIMITS, type MathBox } from './markdown/math';
export { MD_FONTS, clusters, fontRuns, hasRtl, setFallbackTextMeasure, textMetricsEpoch, textWidth, type FallbackMeasure, type FontRun, type MdFont } from './markdown/fonts';
export { markdownSvg } from './render/svg';
