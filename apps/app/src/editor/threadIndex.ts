/**
 * The notebook-wide thread index (tech-spec §2): a summary of every comment thread in the notebook's index doc, so the
 * comments panel, the unread badge and "… commented" toasts cover every page without loading every page doc.
 */
import { Page, summarizeThreads, type Notebook, type ThreadSummary } from '@qalm/core';
import * as React from 'react';

import { docIds, openLoaded, type DocManager } from '../sync/docs';
import type { PageData } from './context';

/** The index's summaries, live (re-read when the index doc's `threads` map changes). */
export function useThreadIndex(notebook: Notebook | null): ThreadSummary[] {
  const [ver, setVer] = React.useState(0);
  React.useEffect(() => {
    if (!notebook) return;
    const m = notebook.doc.getMap('threads');
    const bump = () => setVer((v) => v + 1);
    m.observe(bump);
    bump();
    return () => m.unobserve(bump);
  }, [notebook]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return React.useMemo(() => notebook?.threads() ?? [], [notebook, ver]);
}

/**
 * Writes the loaded pages' threads into the index where they are newer (a comment or reply made here, offline or
 * not; or one that reached this page doc before the index). Cheap when nothing changed: nothing is written.
 */
export function mirrorLoadedThreads(notebook: Notebook, loaded: ReadonlyMap<string, PageData>): void {
  for (const [pageId, d] of loaded) notebook.putThreads(summarizeThreads(pageId, d.comments, d.readings));
}

const START_MS = 3000;
const BETWEEN_MS = 30;

/**
 * Notebooks made before the index existed: once, in the background, open each page doc in turn (through the doc
 * manager's LRU, released straight away), index its threads, then flag the notebook as indexed (synced, so other
 * devices skip it). A page that couldn't sync leaves the flag unset, so a later visit tries again. Returns whether
 * this is still running.
 */
export function useThreadBackfill(dm: DocManager, notebook: Notebook | null, notebookId: string): boolean {
  const [running, setRunning] = React.useState(false);
  React.useEffect(() => {
    if (!notebook) return;
    let alive = true;
    const needed = () => alive && !notebook.threadsIndexed();
    const t = setTimeout(async () => {
      if (!needed()) return;
      setRunning(true);
      let complete = true;
      try {
        for (const p of notebook.pages()) {
          if (!needed()) break;
          const h = await openLoaded(dm, docIds.page(notebookId, p.id), 4000);
          try {
            const prov = h.provider();
            if (prov && !prov.synced) complete = false;
            const page = new Page(h.doc);
            notebook.putThreads(summarizeThreads(p.id, page.comments(), page.readings()));
          } finally {
            h.release();
          }
          await new Promise((r) => setTimeout(r, BETWEEN_MS));
        }
        if (needed() && complete) notebook.markThreadsIndexed();
      } catch {
        // Try again next time the notebook opens.
      } finally {
        if (alive) setRunning(false);
      }
    }, START_MS);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [dm, notebook, notebookId]);
  return running;
}
