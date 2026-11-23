export interface QalmInkModuleType {
  /**
   * Renders one PDF page (`pageIndex` is 0-based) to a PNG `widthPx` wide.
   * Native: returns a cached `file://` PNG. Web: returns an object URL.
   */
  renderPdfPage(fileUri: string, pageIndex: number, widthPx: number): Promise<string>;
}
