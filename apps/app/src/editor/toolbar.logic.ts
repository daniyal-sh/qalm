/** Which edges of the toolbar hide tools (1 px of slack for rounding). */
export function toolbarOverflow(x: number, view: number, content: number): { left: boolean; right: boolean } {
  if (!view || content <= view + 1) return { left: false, right: false };
  return { left: x > 1, right: x + view < content - 1 };
}
