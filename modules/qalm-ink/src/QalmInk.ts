import NativeQalmInk from './QalmInkModule';
import type { InkPoint } from './InkOverlay.types';
import type { QalmInkModuleType } from './QalmInk.types';

// TEMPORARY SHIM — remove once apps/app stops calling recognize/ensureModel.
// On-device recognition (ML Kit) was removed: agents read handwriting from the page image (tech-spec §3).
// The native module no longer has these functions; they stay here as no-ops only so `main` keeps compiling
// until the app PR drops its callers.

/** @deprecated On-device recognition was removed. Will be deleted with the shim below. */
export interface RecognizeLine {
  key: string;
  strokes: InkPoint[][];
}
/** @deprecated On-device recognition was removed. Will be deleted with the shim below. */
export interface RecognizeResult {
  key: string;
  text: string;
  score: number;
}

export const QalmInk: QalmInkModuleType & {
  /** @deprecated No on-device recognition any more. Always resolves `[]`. */
  recognize(lines: RecognizeLine[], lang: 'en-US'): Promise<RecognizeResult[]>;
  /** @deprecated No recognition model any more. Resolves immediately. */
  ensureModel(lang: 'en-US'): Promise<void>;
} = {
  renderPdfPage: (fileUri, pageIndex, widthPx) => NativeQalmInk.renderPdfPage(fileUri, pageIndex, widthPx),
  recognize: async () => [],
  ensureModel: async () => {},
};
