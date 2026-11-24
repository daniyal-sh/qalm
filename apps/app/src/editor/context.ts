import { createUndoManager, type Comment, type Item, type Notebook, type Page, type PenStyle, type Reading, type TextItem } from '@qalm/core';
import type { InkRuler } from 'qalm-ink';
import * as React from 'react';
import type * as Y from 'yjs';

import type { InputPrefs } from '../theme/ThemeProvider';
import type { FormatKind } from './format.logic';
import type { CrossPageUndo } from './undoStack';
import type { EraserMode } from './items';
import type { ToolId } from './view';

export interface ToolState {
  tool: ToolId;
  penColor: string;
  penWidth: number;
  penStyle: PenStyle;
  hlColor: string;
  hlWidth: number;
  eraserRadius: number;
  /** Rub out whole strokes (the default) or only where the eraser passes. Remembered with the other tool settings. */
  eraserMode: EraserMode;
  /** Hold the pen still at the end of a stroke to snap it to a shape. */
  snapShapes: boolean;
  /** Lasso: draw a loop around things, or drag a rectangle over them. Tapping selects either way. */
  lassoMode: 'free' | 'rect';
  /** Laser pointer: a fading trail, or a dot that follows the pen. */
  laserMode: 'trail' | 'dot';
}

export interface Selection {
  pageId: string;
  ids: string[];
}

/** The text box being typed in. A new box is a `draft` until its first character: only then is it added to the page. */
export interface EditingText {
  pageId: string;
  itemId: string;
  draft?: TextItem;
}

export interface PageData {
  page: Page;
  index: number;
  /** Readings of the page's ink (quotes on comment cards). */
  readings: Reading[];
  comments: Comment[];
  /**
   * The page's items, so comment cards can follow their ink. Only kept fresh on pages with comments or the selection
   * (reporting every stroke re-rendered the whole editor); anything else reads `page.items()`, which is cached.
   */
  items: Item[];
}

export interface EditorCtx {
  notebook: Notebook;
  notebookId: string;
  tools: ToolState;
  setTool(t: ToolId): void;
  onPenButton(): void;
  input: InputPrefs;
  /** The on-screen ruler in window coordinates while it's shown (editor UI, never in the page), else null. */
  ruler: InkRuler | null;
  /** The ruler right now, also mid-move (web overlays read it at pen-down). */
  getRuler(): InkRuler | null;
  /** An overlay saw a real pen (auto-picks "draw with"). */
  onPenSeen(): void;
  undo: CrossPageUndo;
  /** One UndoManager per page doc, kept while the doc stays in memory (so history survives scrolling). */
  undoManagerFor(pageId: string, page: Page): Y.UndoManager;
  selection: Selection | null;
  setSelection(s: Selection | null): void;
  editingText: EditingText | null;
  setEditingText(e: EditingText | null): void;
  /** The text box being typed in registers how the format bar changes its text (null while none is). */
  textFormatter: React.RefObject<((kind: FormatKind) => void) | null>;
  activeCommentId: string | null;
  /** False while the notebook's AI access is off: comment pins and cards are hidden (the threads stay). */
  showComments: boolean;
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
