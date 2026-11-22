import * as Y from 'yjs';
import { LOCAL_ORIGIN } from '../origin';
import type { Page } from './page';

/** Undo for one page: tracks only local transactions, one step per transaction (no time-based merging). */
export function createUndoManager(page: Page): Y.UndoManager {
  const d = page.doc;
  return new Y.UndoManager([d.getMap('items'), d.getArray('order'), d.getMap('lines')], {
    trackedOrigins: new Set([LOCAL_ORIGIN]),
    captureTimeout: 0,
  });
}
