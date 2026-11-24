import type { LectureCrop } from '@qalm/core';

/**
 * An imported crop's region labels belong to the old notebook's registry: in the new one `R7` would be some other
 * region (or none). They are kept for reading, marked as the original's: `R7` → `(R7 orig)`, in its regions and text.
 */
export function markImportedCrop(c: LectureCrop): LectureCrop {
  const mark = (l: string) => (/^R\d+$/.test(l) ? `(${l} orig)` : l);
  return {
    ...c,
    regions: c.regions.map((r) => ({ ...r, label: mark(r.label) })),
    text: c.text.replace(/(^|\n)(R\d+)(?= )/g, (_m, nl: string, l: string) => `${nl}${mark(l)}`),
  };
}
