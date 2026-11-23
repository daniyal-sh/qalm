import { isInk, itemBBox, readingsOf, type BBox, type Item, type Page, type Reading } from '@qalm/core';

/** How many readings the Reading sheet lists at once. */
export const MAX_READINGS = 12;

/** The ink (strokes and shapes) in a selection: what readings are of. Images and text boxes have none. */
export function selectionInk(items: readonly Item[], ids: readonly string[]): string[] {
  const sel = new Set(ids);
  return items.filter((it) => sel.has(it.id) && isInk(it)).map((it) => it.id);
}

/** The readings of any of `ink`, top to bottom by where their strokes are. */
export function selectionReadings(readings: readonly Reading[], items: readonly Item[], ink: readonly string[]): Reading[] {
  const box = new Map(items.map((it) => [it.id, it]));
  const top = (r: Reading) => {
    let b: BBox | null = null;
    for (const id of r.ids) {
      const it = box.get(id);
      if (!it) continue;
      const q = itemBBox(it);
      if (!b || q[1] < b[1] || (q[1] === b[1] && q[0] < b[0])) b = q;
    }
    return b ?? [0, 0, 0, 0];
  };
  return readingsOf(readings, ink)
    .map((r) => ({ r, b: top(r) }))
    .sort((a, b) => a.b[1] - b.b[1] || a.b[0] - b.b[0])
    .slice(0, MAX_READINGS)
    .map((x) => x.r);
}

export type ReadingTone = 'user' | 'agent';

/** Who a reading is from, in plain words. */
export function readingSource(r: Pick<Reading, 'src' | 'by'>): { label: string; tone: ReadingTone } {
  if (r.src === 'user') return { label: 'Yours', tone: 'user' };
  return { label: r.by ? `Read by ${r.by}` : 'Read by your agent', tone: 'agent' };
}

export type ReadingResult = 'saved' | 'removed' | 'unchanged';

/**
 * Saves what the student typed for a reading: it becomes theirs (fresh, no agent name), which agents can't overwrite.
 * Empty text removes the reading. Unchanged text leaves an agent's fresh reading as it is (a stale one becomes
 * the student's: they confirmed it).
 */
export function saveReading(page: Page, r: Pick<Reading, 'id' | 'text' | 'src' | 'stale'>, typed: string): ReadingResult {
  const text = typed.trim();
  if (!text) {
    page.editReading(r.id, '');
    return 'removed';
  }
  if (text === r.text && !r.stale) return 'unchanged';
  page.editReading(r.id, text);
  return 'saved';
}

/** The student's own reading of ink that has none yet. */
export function addReading(page: Page, ink: readonly string[], typed: string): ReadingResult {
  const text = typed.trim();
  if (!text || !ink.length) return 'unchanged';
  return page.setReading(ink, text, 'user') ? 'saved' : 'unchanged';
}
