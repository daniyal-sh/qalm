import type { Line, Page } from '@qalm/core';

/** How many lines the Reading sheet lists at once. */
export const MAX_READING_LINES = 12;

/**
 * The handwritten lines a selection touches, top to bottom. Drawings, images and text boxes have no reading, so a
 * selection of only those has none.
 */
export function selectionLines(lines: Line[], ids: readonly string[]): Line[] {
  const sel = new Set(ids);
  return lines
    .filter((l) => l.kind === 'line' && l.itemIds.some((id) => sel.has(id)))
    .sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0])
    .slice(0, MAX_READING_LINES);
}

export type ReadingTone = 'user' | 'agent' | 'device' | 'none';

/** Where a line's saved text came from, in plain words. */
export function readingSource(l: Pick<Line, 'text' | 'textSrc' | 'by'>): { label: string; tone: ReadingTone } {
  if (l.text === undefined) return { label: 'No reading yet', tone: 'none' };
  if (l.textSrc === 'user') return { label: 'Yours', tone: 'user' };
  if (l.textSrc === 'agent') return { label: l.by ? `Read by ${l.by}` : 'Read by your agent', tone: 'agent' };
  return { label: 'On-device guess', tone: 'device' };
}

export type ReadingResult = 'saved' | 'cleared' | 'unchanged';

/**
 * Saves what the student typed for a line. Their text is `textSrc: 'user'`, which agents can't overwrite. Empty text
 * goes back to automatic (no reading: the device guesses again and agents read the image). Unchanged text leaves an
 * automatic reading automatic.
 */
export function saveReading(page: Page, line: Pick<Line, 'key' | 'text' | 'textSrc'>, typed: string): ReadingResult {
  const text = typed.trim();
  if (!text) {
    if (line.text === undefined) return 'unchanged';
    page.clearLineText(line.key);
    return 'cleared';
  }
  if (text === line.text) return 'unchanged';
  page.setLineText(line.key, text, 'user');
  return 'saved';
}

/** Back to automatic: forget the student's own reading. */
export function resetReading(page: Page, line: Pick<Line, 'key' | 'textSrc'>): boolean {
  if (line.textSrc !== 'user') return false;
  page.clearLineText(line.key);
  return true;
}
