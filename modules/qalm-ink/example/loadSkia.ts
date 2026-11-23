/** Native: Skia is built in. (loadSkia.web.ts loads CanvasKit; Metro picks it by platform extension.) */
export const loadSkia = (): Promise<void> => Promise.resolve();
