import type { InkPoint } from './InkOverlay.types';

export interface RecognizeLine {
  key: string;
  strokes: InkPoint[][];
}
export interface RecognizeResult {
  key: string;
  text: string;
  score: number;
}

export interface QalmInkModuleType {
  /** ML Kit Digital Ink on Android and iPad. Web and desktop resolve `[]`. Lines without a candidate are omitted. */
  recognize(lines: RecognizeLine[], lang: 'en-US'): Promise<RecognizeResult[]>;
  /** Downloads the recognition model if needed. No-op on web. */
  ensureModel(lang: 'en-US'): Promise<void>;
  /**
   * Renders one PDF page (`pageIndex` is 0-based) to a PNG `widthPx` wide.
   * Native: returns a cached `file://` PNG. Web: returns an object URL.
   */
  renderPdfPage(fileUri: string, pageIndex: number, widthPx: number): Promise<string>;
}
