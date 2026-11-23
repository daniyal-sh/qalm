import { createUndoManager, type Comment, type Line, type Notebook, type Page, type PenStyle } from '@qalm/core';
import * as React from 'react';
import type * as Y from 'yjs';

import type { InputPrefs } from '../theme/ThemeProvider';
import type { CrossPageUndo } from './undoStack';
import type { ToolId } from './view';

export interface ToolState {
  tool: ToolId;
  penColor: string;
  penWidth: number;
  penStyle: PenStyle;
  hlColor: string;
  hlWidth: number;
  eraserRadius: number;
  /** Hold the pen still at the end of a stroke to snap it to a shape. */
  snapShapes: boolean;
}

export interface Selection {
  pageId: string;
  ids: string[];
}

export interface PageData {
  page: Page;
  index: number;
  lines: Line[];
  comments: Comment[];
}

export interface EditorCtx {
  notebook: Notebook;
  notebookId: string;
  tools: ToolState;
  setTool(t: ToolId): void;
  onPenButton(): void;
  input: InputPrefs;
  undo: CrossPageUndo;
  /** One UndoManager per page doc, kept while the doc stays in memory (so history survives scrolling). */
  undoManagerFor(pageId: string, page: Page): Y.UndoManager;
  selection: Selection | null;
  setSelection(s: Selection | null): void;
  editingText: { pageId: string; itemId: string } | null;
  setEditingText(e: { pageId: string; itemId: string } | null): void;
  activeCommentId: string | null;
  setActiveComment(id: string | null): void;
  reportPage(pageId: string, data: PageData | null): void;
  /** Tells the editor which page was last written on (Ask, image insert). */
  touchPage(pageId: string): void;
}

export const EditorContext = React.createContext<EditorCtx | null>(null);

export function useEditor(): EditorCtx {
  const v = React.useContext(EditorContext);
  if (!v) throw new Error('useEditor outside EditorContext');
  return v;
}

/** Registry of per-page UndoManagers keyed by page id, rebuilt if the page's doc object changed (evicted and reopened). */
export class UndoRegistry {
  private ums = new Map<string, { doc: Y.Doc; um: Y.UndoManager; off: () => void }>();
  constructor(private readonly undo: CrossPageUndo) {}

  get(pageId: string, page: Page): Y.UndoManager {
    const hit = this.ums.get(pageId);
    if (hit && hit.doc === page.doc) return hit.um;
    if (hit) this.drop(pageId);
    const um = createUndoManager(page);
    const off = this.undo.attach(pageId, um);
    this.ums.set(pageId, { doc: page.doc, um, off });
    return um;
  }

  drop(pageId: string): void {
    const hit = this.ums.get(pageId);
    if (!hit) return;
    this.ums.delete(pageId);
    this.undo.detach(pageId);
    hit.um.destroy();
  }

  clear(): void {
    for (const id of [...this.ums.keys()]) this.drop(id);
  }
}
