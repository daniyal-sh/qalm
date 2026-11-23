import { createNotebookUndoManager, inkOnPaper, Notebook, Page, PEN_WIDTHS, HIGHLIGHTER_WIDTH, type ImageItem, type Item } from '@qalm/core';
import { router } from 'expo-router';
import { QalmInk, renderThumbnail } from 'qalm-ink';
import * as React from 'react';
import { ActivityIndicator, Image, Platform, ScrollView, StyleSheet, useWindowDimensions, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { GestureDetector, usePinchGesture } from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';

import { mark } from '../bench/hook';
import { exportNotebook, updateNotebookMeta } from '../library/ops';
import { CoverSheet, NameSheet, PaperSheet } from '../library/components';
import { newId } from '../lib/id';
import { kvGet, kvSet } from '../lib/kv';
import { pickFile } from '../lib/files';
import { docIds, openLoaded, type DocHandle } from '../sync/docs';
import { useDoc, useLibraryData, useSession, useSyncStatus, useVersion } from '../state/session';
import { useTheme } from '../theme/ThemeProvider';
import { indicatorStyleFor } from '../theme/scrollbars';
import { PEN_COLORS, HIGHLIGHTER_COLORS, radius, shadow2 } from '../theme/tokens';
import { confirm } from '../ui/confirm';
import { Button, IconButton, Pill, TextField, Toggle } from '../ui/controls';
import { EmptyState, Menu, Row, Sheet, useToast, type MenuItem } from '../ui/layout';
import { Text } from '../ui/Text';
import { CommentsPanel, PANEL_W } from './CommentsPanel';
import { threadRows } from './CommentsPanel.logic';
import { mirrorLoadedThreads, useThreadBackfill, useThreadIndex } from './threadIndex';
import { MARGIN_CARD_H, MarginCard, PresencePill, usePresence, useReadAfterDwell } from './ai';
import { fitColumn, MARGIN_CARD_GAP, marginColumn } from './margin.logic';
import { marginCards, markSeen, newestAgentEntry, startThinking, stillThinking, THINKING_MS, unreadCount, unreadIds, type SeenThreads, type Thinking } from './ai.logic';
import { EditorContext, UndoRegistry, type EditingText, type EditorCtx, type PageData, type Selection, type ToolState } from './context';
import { clipSetAt, getClip, pasteItems, setClip, useClip } from './clipboard';
import { pastedImage, pastedText, pasteSource, readPaste, systemChangedAt, viewCentre, watchSystemClipboard } from './systemPaste';
import { cloneItems, recolorPatch, selectionBBox, selectionSwatch } from './items';
import { trackModifiers } from './modifiers';
import { SelectionThumb } from './SelectionThumb';
import { PageView } from './PageView';
import { selectionInk } from './reading.logic';
import { ReadingSheet } from './ReadingSheet';
import { SwatchStrip } from './Swatches';
import { Toolbar } from './Toolbar';
import { keyTarget, NAV_SIDEBAR_MIN, NAV_SIDEBAR_W, parseGoTo } from './navigator.logic';
import { PageNavigator } from './PageNavigator';
import { entryMirror, notebookFound, pendingScrollY, type PendingScroll } from './editor.logic';
import { Thumbnails } from './thumbnails';
import { CrossPageUndo } from './undoStack';
import {
  anchoredScroll,
  baseWidth,
  clampZoom,
  contentHeight,
  currentPageIndex,
  layoutPages,
  mountedRange,
  penButtonTool,
  stepZoom,
  viewKey,
  windowRange,
  type ToolId,
} from './view';

const GAP = 44;
/** The cross-page undo stack's id for the notebook's page list. */
const PAGES_UNDO = '__pages';
const DEFAULT_TOOLS: ToolState = {
  tool: 'pen',
  penColor: PEN_COLORS[0].hex,
  penWidth: PEN_WIDTHS[1],
  penStyle: 'fountain',
  hlColor: HIGHLIGHTER_COLORS[0].hex,
  hlWidth: HIGHLIGHTER_WIDTH,
  eraserRadius: 10,
  snapShapes: true,
  lassoMode: 'free',
};

type MenuState = { items: MenuItem[]; anchor?: { x: number; y: number; align?: 'left' | 'right' } } | null;

export function EditorScreen({ notebookId }: { notebookId: string }) {
  const { c, input, scheme } = useTheme();
  const s = useSession();
  const { library } = useLibraryData();
  const h = useDoc(docIds.notebook(notebookId), 2500);
  const notebook = React.useMemo(() => (h ? new Notebook(h.doc) : null), [h]);
  const sub = React.useMemo(() => (notebook ? (cb: () => void) => notebook.observe(cb) : null), [notebook]);
  const ver = useVersion(sub);
  const pages = React.useMemo(() => notebook?.pages() ?? [], [notebook, ver]);
  const meta = React.useMemo(() => notebook?.meta() ?? null, [notebook, ver]);
  const sync = useSyncStatus(h);
  const win = useWindowDimensions();
  React.useEffect(() => mark('qalm:editor-mount'), []);

  // ---- tools ----
  const [tools, setTools] = React.useState<ToolState>(DEFAULT_TOOLS);
  const prevTool = React.useRef<ToolId>('pen');
  React.useEffect(() => {
    void kvGet<Partial<ToolState>>('tools').then((t) => t && setTools((x) => ({ ...x, ...t, tool: x.tool })));
  }, []);
  const changeTools = React.useCallback((p: Partial<ToolState>) => {
    setTools((x) => {
      const next = { ...x, ...p };
      void kvSet('tools', next);
      return next;
    });
  }, []);
  const toolRef = React.useRef(tools.tool);
  toolRef.current = tools.tool;
  const setTool = React.useCallback(
    (t: ToolId) => {
      if (t !== toolRef.current) prevTool.current = toolRef.current;
      changeTools({ tool: t });
      if (t !== 'lasso') setSelection(null);
    },
    [changeTools],
  );
  const onPenButton = React.useCallback(() => setTool(penButtonTool(input.penGesture, toolRef.current, prevTool.current)), [input.penGesture, setTool]);

  // ---- undo ----
  const undo = React.useMemo(() => new CrossPageUndo(), []);
  const registry = React.useMemo(() => new UndoRegistry(undo), [undo]);
  const undoSub = React.useCallback((cb: () => void) => undo.onChange(cb), [undo]);
  useVersion(undoSub);
  React.useEffect(() => {
    const prefix = `pg:${notebookId}:`;
    const off = s.dm.onEvict((docId) => {
      if (docId.startsWith(prefix)) registry.drop(docId.slice(prefix.length));
    });
    // Pages with undo history stay in memory longest, so undo still reaches them after scrolling far away.
    s.dm.setRetain((docId) => docId.startsWith(prefix) && undo.hasHistory(docId.slice(prefix.length)));
    return () => {
      off();
      s.dm.setRetain(null);
      registry.clear();
    };
  }, [s.dm, registry, notebookId, undo]);
  // Page-list changes (add, delete, move, duplicate, bookmark) are undo steps too, on the notebook's index doc.
  React.useEffect(() => {
    if (!notebook) return;
    const um = createNotebookUndoManager(notebook);
    const off = undo.attach(PAGES_UNDO, um);
    return () => {
      off();
      undo.detach(PAGES_UNDO);
      um.destroy();
    };
  }, [notebook, undo]);

  // ---- selection, text, comments ----
  const [selection, setSelection] = React.useState<Selection | null>(null);
  const [editingText, setEditingText] = React.useState<EditingText | null>(null);
  const [activeCommentId, setActiveComment] = React.useState<string | null>(null);
  const [pageData, setPageData] = React.useState(() => new Map<string, PageData>());
  const reportPage = React.useCallback((pageId: string, data: PageData | null) => {
    setPageData((m) => {
      const n = new Map(m);
      if (data) n.set(pageId, data);
      else n.delete(pageId);
      return n;
    });
  }, []);
  // Comment threads notebook-wide: live on the loaded pages, from the notebook's thread index elsewhere.
  const threadIndex = useThreadIndex(notebook);
  const threads = React.useMemo(() => threadRows(threadIndex, pageData, pages.map((p) => p.id)), [threadIndex, pageData, pages]);
  const summaries = React.useMemo(() => threads.map((r) => r.summary), [threads]);
  React.useEffect(() => {
    if (notebook) mirrorLoadedThreads(notebook, pageData);
  }, [notebook, pageData]);
  const indexing = useThreadBackfill(s.dm, notebook, notebookId);
  // ---- live agent: presence, "thinking…" after an Ask, unread agent comments ----
  const agents = usePresence(s.user ? s.tm : null, notebookId, !!meta?.aiAccess);
  const [seen, setSeen] = React.useState<SeenThreads>({});
  const seenKey = `seen:${notebookId}`;
  React.useEffect(() => {
    void kvGet<SeenThreads>(seenKey).then((v) => v && setSeen((cur) => ({ ...v, ...cur })));
  }, [seenKey]);
  const [thinking, setThinking] = React.useState<Thinking | null>(null);
  const isThinking = stillThinking(thinking, summaries, Date.now());
  React.useEffect(() => {
    if (!thinking) return;
    if (!isThinking) return setThinking(null);
    const t = setTimeout(() => setThinking((x) => (x === thinking ? null : x)), Math.max(0, thinking.at + THINKING_MS - Date.now()));
    return () => clearTimeout(t);
  }, [thinking, isThinking]);
  const unread = unreadCount(summaries, seen);

  const lastPage = React.useRef<string | null>(null);
  const touchTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchPage = React.useCallback(
    (pageId: string) => {
      lastPage.current = pageId;
      // Keep the library's "last edited" fresh (at most every few seconds).
      if (touchTimer.current) return;
      touchTimer.current = setTimeout(() => {
        touchTimer.current = null;
        library?.updateEntry(notebookId, { updatedAt: Date.now() });
      }, 3000);
    },
    [library, notebookId],
  );
  React.useEffect(() => () => {
    if (touchTimer.current) clearTimeout(touchTimer.current);
  }, []);

  // A bogus link, or a notebook deleted forever (maybe on another device): "not found", and never a new library entry.
  const entry = library?.entry(notebookId);
  const found = notebookFound(meta, notebookId, !!library, entry);
  // Mirror title / cover / AI access into the library entry (they may change on another device).
  React.useEffect(() => {
    if (!found || !meta || !library || !entry) return;
    const patch = entryMirror(meta, entry);
    if (patch) library.updateEntry(notebookId, patch);
  }, [found, meta, library, entry, notebookId]);

  // ---- layout, scroll and zoom ----
  const [viewport, setViewport] = React.useState({ w: win.width, h: win.height });
  const [zoom, setZoom] = React.useState(1);
  const [liveScale, setLiveScale] = React.useState(1);
  const [scrollY, setScrollY] = React.useState(0);
  const vScroll = React.useRef<React.ComponentRef<typeof ScrollView>>(null);
  // Dock the comments panel beside the page only on wide windows; below that it floats over the page.
  // Decided by window width (not the page viewport, which itself shrinks when the panel docks).
  const dockComments = win.width >= 1100;
  const [commentsOpen, setCommentsOpen] = React.useState(dockComments);
  // Rotating to portrait (or narrowing the window) turns a docked panel into one covering the page: close it.
  React.useEffect(() => {
    if (!dockComments) setCommentsOpen(false);
  }, [dockComments]);
  const base = baseWidth(viewport.w);
  const slots = React.useMemo(() => layoutPages(pages, base, zoom, GAP, 96), [pages, base, zoom]);
  const totalH = contentHeight(slots, GAP) + 80;
  const widestPx = React.useMemo(() => slots.reduce((m, x) => Math.max(m, x.width), 0), [slots]);
  const contentW = Math.max(viewport.w, widestPx + 48);
  const [first, last] = mountedRange(slots, scrollY, viewport.h, 2);
  const [visFirst, visLast] = mountedRange(slots, scrollY, viewport.h, 0);
  // Only pages near the viewport are rendered at all (placeholders beyond the mounted ones), not one view per page.
  const [winFirst, winLast] = windowRange([first, last], slots.length);
  // Scroll events re-render the editor only when what it shows changes (mounted / visible / current page).
  const slotsRef = React.useRef(slots);
  slotsRef.current = slots;
  const shownKey = React.useRef('');
  shownKey.current = viewKey(slots, scrollY, viewport.h);
  // Comment cards sit in a column beside the page when there's room and the panel is closed; otherwise pins on the page
  // (and the panel, which lists every thread).
  const column = marginColumn(contentW, widestPx, commentsOpen);
  const wideMargin = column !== null;
  const current = currentPageIndex(slots, scrollY, viewport.h);
  const currentPageId = pages[current]?.id ?? null;

  const commitZoom = React.useCallback(
    (next: number) => {
      const z = clampZoom(next);
      mark('qalm:zoom-commit', z);
      setLiveScale(1);
      setZoom((prev) => {
        if (Math.abs(z - prev) < 1e-3) return prev;
        const y = anchoredScroll(scrollYRef.current, viewportRef.current.h, prev, z);
        requestAnimationFrame(() => vScroll.current?.scrollTo({ y, animated: false }));
        return z;
      });
    },
    [],
  );
  const scrollYRef = React.useRef(0);
  const viewportRef = React.useRef(viewport);
  viewportRef.current = viewport;
  const zoomRef = React.useRef(zoom);
  zoomRef.current = zoom;
  // When the page width changes (the page sidebar opens or closes, the window resizes), keep the same place in view.
  const prevBase = React.useRef(base);
  React.useEffect(() => {
    const prev = prevBase.current;
    prevBase.current = base;
    if (prev === base) return;
    const y = anchoredScroll(scrollYRef.current, viewportRef.current.h, prev, base);
    requestAnimationFrame(() => vScroll.current?.scrollTo({ y, animated: false }));
  }, [base]);

  const pinchScale = React.useRef(1);
  const pinch = usePinchGesture({
    runOnJS: true,
    disableReanimated: true,
    onUpdate: (e) => {
      pinchScale.current = e.scale;
      setLiveScale(clampZoom(zoomRef.current * e.scale) / zoomRef.current);
    },
    onDeactivate: () => commitZoom(zoomRef.current * pinchScale.current),
  });

  // Web / Electron: trackpad pinch and ctrl+wheel zoom; keyboard shortcuts.
  React.useEffect(() => {
    if (Platform.OS !== 'web') return;
    let pending = 1;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onWheel = (ev: WheelEvent) => {
      if (!ev.ctrlKey && !ev.metaKey) return;
      ev.preventDefault();
      pending = clampZoom(zoomRef.current * pending * Math.exp(-ev.deltaY * 0.01)) / zoomRef.current;
      setLiveScale(pending);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        commitZoom(zoomRef.current * pending);
        pending = 1;
      }, 180);
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.removeEventListener('wheel', onWheel);
      if (timer) clearTimeout(timer);
    };
  }, [commitZoom]);

  const selectionPage = selection ? pageData.get(selection.pageId)?.page : undefined;
  const selectionPaper = selection ? pages.find((p) => p.id === selection.pageId)?.paperColor : undefined;
  const selectedItems = () => (selection && selectionPage ? selection.ids.map((id) => selectionPage.item(id)).filter((x) => !!x) : []);
  const openSelection = (mode: 'ask' | 'comment') => {
    if (!selection || !selectionPage) return;
    const box = selectionBBox(selectedItems());
    if (box) openAsk({ pageId: selection.pageId, ids: selection.ids, bbox: box, mode });
  };
  // Reading: what an agent (or the student) read in the selected ink (none for images or text boxes alone).
  const selInk = selection && pageData.get(selection.pageId) ? selectionInk(pageData.get(selection.pageId)!.items, selection.ids) : [];
  const [reading, setReading] = React.useState<{ pageId: string; page: Page; ink: string[] } | null>(null);
  const openReading = () => {
    if (!selection || !selectionPage) return;
    const ink = selectionInk(selectionPage.items(), selection.ids);
    if (ink.length) setReading({ pageId: selection.pageId, page: selectionPage, ink });
  };
  const deleteSelection = () => {
    if (!selection || !selectionPage) return;
    selectionPage.removeItems(selection.ids);
    touchPage(selection.pageId);
    setSelection(null);
  };
  // Items deleted elsewhere (undo, another device) drop out of the selection.
  React.useEffect(() => {
    if (!selection) return;
    const d = pageData.get(selection.pageId);
    if (!d) return;
    // Ask the doc itself: `pageData` can lag a render behind a paste or duplicate.
    const ids = selection.ids.filter((id) => !!d.page.item(id));
    if (ids.length !== selection.ids.length) setSelection(ids.length ? { pageId: selection.pageId, ids } : null);
  }, [pageData, selection]);

  const clip = useClip();
  /** Where Paste goes: the selection's page, else the page last written on, else the one in view. */
  const pasteTarget = (): { pageId: string; page: Page } | null => {
    const id = selection?.pageId ?? (lastPage.current && pageData.has(lastPage.current) ? lastPage.current : currentPageId);
    const page = id ? pageData.get(id)?.page : undefined;
    return id && page ? { pageId: id, page } : null;
  };
  const copySelection = () => {
    if (!selection || !notebook) return false;
    const items = selectedItems();
    if (!items.length) return false;
    const assets = items.flatMap((it) => (it.type === 'image' ? [notebook.asset(it.assetId)].filter((x) => !!x) : []));
    setClip(items, assets, selection.pageId);
    return true;
  };
  const sel = {
    copy: () => {
      if (copySelection()) showToast('Copied');
    },
    cut: () => {
      if (copySelection()) deleteSelection();
    },
    paste: () => {
      const cl = getClip();
      const target = pasteTarget();
      if (!cl || !target || !notebook) return;
      for (const a of cl.assets) if (!notebook.asset(a.id)) notebook.addAsset(a); // images pasted from another notebook
      const copies = pasteItems(cl, target.pageId, newId);
      target.page.addItems(copies);
      touchPage(target.pageId);
      setTool('lasso');
      setSelection({ pageId: target.pageId, ids: copies.map((x) => x.id) });
    },
    /** Web / Electron paste event: qalm's own clip, or an image or text from another app (at the view's centre). */
    pasteFrom: (dt: DataTransfer | null): boolean => {
      const sys = readPaste(dt);
      const src = pasteSource(sys, clipSetAt(), systemChangedAt());
      if (src === 'qalm') {
        selRef.current.paste();
        return true;
      }
      const info = pages[current];
      const slot = slots[current];
      const page = info ? pageData.get(info.id)?.page : undefined;
      if (!src || !notebook || !info || !slot || !page) return false;
      const at = viewCentre(slot, scrollYRef.current, viewportRef.current.h, info.size);
      const place = (item: Item) => {
        page.addItem(item);
        touchPage(info.id);
        setTool('lasso');
        setSelection({ pageId: info.id, ids: [item.id] });
      };
      if (src === 'text') place(pastedText(sys.text, at, info.size, inkOnPaper(tools.penColor, info.paperColor), newId()));
      else {
        const blob = sys.image!;
        void run('Adding image…', async () => {
          const asset = await s.assets.put(new Uint8Array(await blob.arrayBuffer()), blob.type || 'image/png', 'Pasted image');
          notebook.addAsset(asset);
          const bmp = await createImageBitmap(blob);
          const px = { w: bmp.width, h: bmp.height };
          bmp.close();
          place(pastedImage(asset.id, px, at, info.size, newId()));
        });
      }
      return true;
    },
    duplicate: () => {
      if (!selection || !selectionPage) return;
      const copies = cloneItems(selectedItems(), 16, 16, newId);
      selectionPage.addItems(copies);
      touchPage(selection.pageId);
      setSelection({ pageId: selection.pageId, ids: copies.map((x) => x.id) });
    },
    recolor: (hex: string) => {
      if (!selection || !selectionPage) return;
      selectionPage.updateItems(
        selectedItems().flatMap((it) => {
          const patch = recolorPatch(it, hex, selectionPaper);
          return patch ? [[it.id, patch] as const] : [];
        }),
      );
      touchPage(selection.pageId);
    },
    order: (to: 'front' | 'back') => {
      if (!selection || !selectionPage) return;
      selectionPage.reorder(selection.ids, to);
      touchPage(selection.pageId);
    },
    selectAll: () => {
      const target = pasteTarget();
      const ids = target ? pageData.get(target.pageId)?.items.map((it) => it.id) : [];
      if (!target || !ids?.length) return;
      setTool('lasso');
      setSelection({ pageId: target.pageId, ids });
    },
  };
  const selRef = React.useRef(sel);
  selRef.current = sel;
  const [recoloring, setRecoloring] = React.useState(false);
  React.useEffect(() => setRecoloring(false), [selection?.pageId, selection?.ids.length]);
  // The selection's colour when every recolourable item shares one (marked in the recolour swatches).
  const selectionColor = React.useMemo(() => {
    if (!recoloring) return null;
    return selectionSwatch(selectedItems(), selectionPaper);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recoloring, selection, pageData]);

  React.useEffect(() => {
    if (Platform.OS !== 'web') return;
    trackModifiers();
    const onKey = (ev: KeyboardEvent) => {
      const target = ev.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      const mod = ev.ctrlKey || ev.metaKey;
      const k = ev.key.toLowerCase();
      const a = selRef.current;
      if (mod && k === 'z') {
        ev.preventDefault();
        if (ev.shiftKey) undo.redo();
        else undo.undo();
      } else if (mod && k === 'y') {
        ev.preventDefault();
        undo.redo();
      } else if (mod && (k === 'c' || k === 'x' || k === 'd') && selection) {
        ev.preventDefault();
        if (k === 'c') a.copy();
        else if (k === 'x') a.cut();
        else a.duplicate();
      } else if (mod && k === 'a') {
        ev.preventDefault();
        a.selectAll();
      } else if ((k === 'delete' || k === 'backspace') && selection) {
        ev.preventDefault();
        deleteSelection();
      } else if (k === 'escape') setSelection(null);
      else if (mod && k === 'g') {
        ev.preventDefault();
        openGoTo();
      } else if (mod) return;
      else if (k === 'p') setTool('pen');
      else if (k === 'h') setTool('highlighter');
      else if (k === 'e') setTool('eraser');
      else if (k === 'l') setTool('lasso');
      else if (k === 't') setTool('text');
      else if (!ev.altKey) {
        const to = keyTarget(ev.key, currentRef.current, pagesRef.current.length);
        if (to === null) return;
        ev.preventDefault();
        jumpToRef.current(to);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undo, selection, selectionPage, setTool]);

  // Ctrl/Cmd+V comes as the browser's paste event, which carries the system clipboard (no permission prompt).
  React.useEffect(() => {
    if (Platform.OS !== 'web') return;
    const stopWatching = watchSystemClipboard();
    const onPaste = (ev: ClipboardEvent) => {
      const target = ev.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (selRef.current.pasteFrom(ev.clipboardData)) ev.preventDefault();
    };
    document.addEventListener('paste', onPaste);
    return () => {
      stopWatching();
      document.removeEventListener('paste', onPaste);
    };
  }, []);

  // ---- actions ----
  const [menu, setMenu] = React.useState<MenuState>(null);
  const [askOpen, setAskOpen] = React.useState(false);
  const [askText, setAskText] = React.useState('');
  /** Ask (or comment) about a selection; null for the general Ask. */
  const [askScope, setAskScope] = React.useState<{ pageId: string; ids: string[]; bbox: [number, number, number, number]; mode: 'ask' | 'comment' } | null>(null);
  const openAsk = (scope: typeof askScope = null) => {
    setAskScope(scope);
    setAskOpen(true);
  };
  // While a selection's sheet is open its page doc stays open, even if the page scrolls away or a zoom unmounts it,
  // so the comment or Ask is always written (and its thumbnail keeps showing).
  const scopeDocId = askOpen && askScope ? docIds.page(notebookId, askScope.pageId) : null;
  const [scopeDoc, setScopeDoc] = React.useState<DocHandle | null>(null);
  React.useEffect(() => {
    if (!scopeDocId) return;
    const hd = s.dm.open(scopeDocId);
    let alive = true;
    void hd.loaded.then(() => alive && setScopeDoc(hd));
    return () => {
      alive = false;
      setScopeDoc(null);
      hd.release();
    };
  }, [s.dm, scopeDocId]);
  const heldPage = React.useMemo(() => (scopeDoc ? { docId: scopeDoc.docId, page: new Page(scopeDoc.doc) } : null), [scopeDoc]);
  const [renaming, setRenaming] = React.useState(false);
  const [coverOpen, setCoverOpen] = React.useState(false);
  /** The page whose paper is being changed (its index). */
  const [paperFor, setPaperFor] = React.useState<number | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [toast, showToast] = useToast();

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await fn();
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const scrollToPage = (pageId: string) => {
    const i = slots.findIndex((x) => x.id === pageId);
    const slot = slots[i];
    // Nearby pages scroll smoothly; far ones jump (an animated scroll past hundreds of pages would load them all).
    if (slot) vScroll.current?.scrollTo({ y: Math.max(0, slot.top - 80), animated: Math.abs(i - current) <= 3 });
  };
  // A scroll that waits for the page list to change (a page added or moved), applied once its slot exists.
  const pendingScroll = React.useRef<PendingScroll | null>(null);
  React.useEffect(() => {
    const p = pendingScroll.current;
    if (!p) return;
    const y = pendingScrollY(slots, p);
    if (y === null) return;
    pendingScroll.current = null;
    requestAnimationFrame(() => vScroll.current?.scrollTo({ y, animated: false }));
  }, [slots]);
  const jumpTo = (index: number) => {
    const p = pages[index];
    if (p) scrollToPage(p.id);
  };
  const jumpToRef = React.useRef(jumpTo);
  jumpToRef.current = jumpTo;
  const currentRef = React.useRef(current);
  currentRef.current = current;
  const pagesRef = React.useRef(pages);
  pagesRef.current = pages;

  // ---- page navigator ----
  const navWide = win.width >= NAV_SIDEBAR_MIN;
  const [navOpen, setNavOpen] = React.useState(false);
  const [goTo, setGoTo] = React.useState<string | null>(null);
  const openGoTo = () => setGoTo(String(currentRef.current + 1));
  const thumbs = React.useMemo(
    () =>
      notebook
        ? new Thumbnails({
            dm: s.dm,
            notebookId,
            pdfUri: async (assetId) => {
              const a = notebook.asset(assetId);
              return a ? s.assets.uri(a) : null;
            },
            renderPdf: (uri, pageIndex, w) => QalmInk.renderPdfPage(uri, pageIndex, w),
            draw: renderThumbnail,
          })
        : null,
    [notebook, notebookId, s.dm, s.assets],
  );
  React.useEffect(() => () => thumbs?.dispose(), [thumbs]);
  // A page's paper lives in the notebook doc, not the page doc: redraw its thumbnail when it changes (here, undo, sync).
  const paperSeen = React.useRef(new Map<string, string>());
  React.useEffect(() => {
    for (const p of pages) {
      const k = `${p.paper}|${p.paperColor}`;
      const was = paperSeen.current.get(p.id);
      if (was !== undefined && was !== k) thumbs?.invalidate(p.id);
      paperSeen.current.set(p.id, k);
    }
  }, [pages, thumbs]);
  const duplicatePage = (index: number) =>
    void run('Duplicating page…', async () => {
      const src = pages[index];
      if (!notebook || !src) return;
      const id = newId();
      // Content first (its own doc), then the page entry: one undo step that removes the copy.
      const [a, b] = await Promise.all([openLoaded(s.dm, docIds.page(notebookId, src.id)), openLoaded(s.dm, docIds.page(notebookId, id))]);
      try {
        new Page(b.doc).copyFrom(new Page(a.doc), newId);
      } finally {
        a.release();
        b.release();
      }
      notebook.duplicatePage(src.id, id);
      showToast(`Page ${index + 1} duplicated`);
    });
  const toggleBookmark = (index: number) => {
    const p = pages[index];
    if (notebook && p) notebook.setBookmark(p.id, !p.bookmarked);
  };
  /** Moves a page, keeping the page in view (and the spot on it) in view wherever it ends up. */
  const movePage = (from: number, to: number) => {
    const p = pages[from];
    if (!notebook || !p || from === to || to < 0 || to >= pages.length) return;
    const inView = slots[currentRef.current];
    if (inView) pendingScroll.current = { pageId: inView.id, offset: scrollYRef.current - inView.top };
    notebook.movePage(p.id, to);
  };

  const addPage = (afterIndex?: number) => {
    if (!notebook) return;
    const after = afterIndex !== undefined ? pages[afterIndex] : pages[pages.length - 1];
    // A page after a PDF page gets the notebook's paper.
    const id = notebook.addPage(after && after.background.kind === 'paper' ? { size: after.size, paper: after.paper, paperColor: after.paperColor } : {}, afterIndex !== undefined ? afterIndex + 1 : undefined);
    // The new page becomes the current one: scroll to it once it's laid out; Paste, Ask and images go there.
    pendingScroll.current = { pageId: id };
    lastPage.current = id;
  };

  const deletePage = (index: number) => {
    if (!notebook || pages.length <= 1) return showToast('A notebook needs at least one page');
    const p = pages[index];
    if (!p) return;
    confirm(`Delete page ${index + 1}?`, 'Its ink, text and comments go with it.', 'Delete', () => {
      // The page's ink history stays (eviction drops it), so undoing the delete brings back its undo steps too.
      notebook.removePage(p.id);
    });
  };

  const pageMenu = (index: number, anchor: { x: number; y: number }) =>
    setMenu({
      anchor: { ...anchor, align: 'right' },
      items: [
        { label: 'Add page after', icon: 'plus', onPress: () => addPage(index) },
        { label: 'Duplicate page', icon: 'copy', onPress: () => duplicatePage(index) },
        ...(pages[index]?.background.kind === 'paper' ? [{ label: 'Paper…', icon: 'file' as const, onPress: () => setPaperFor(index) }] : []),
        { label: pages[index]?.bookmarked ? 'Remove bookmark' : 'Bookmark page', icon: 'bookmark', onPress: () => toggleBookmark(index) },
        { label: 'Move up', icon: 'arrow-up', onPress: () => movePage(index, index - 1) },
        { label: 'Move down', icon: 'arrow-down', onPress: () => movePage(index, index + 1) },
        { label: 'Delete page', icon: 'trash-2', tone: 'bad', onPress: () => deletePage(index) },
      ],
    });

  const ctx = { dm: s.dm, assets: s.assets };
  /** The selection bar's secondary actions: inline on wide screens, in a "…" menu on narrow ones. */
  const selMore: MenuItem[] = [
    { label: 'Duplicate', icon: 'plus-square', onPress: () => sel.duplicate() },
    { label: 'Copy', icon: 'copy', onPress: () => sel.copy() },
    { label: 'Cut', icon: 'scissors', onPress: () => sel.cut() },
    ...(clip ? [{ label: 'Paste', icon: 'clipboard' as const, onPress: () => sel.paste() }] : []),
    { label: 'Bring to front', icon: 'chevrons-up', onPress: () => sel.order('front') },
    { label: 'Send to back', icon: 'chevrons-down', onPress: () => sel.order('back') },
    { label: 'Comment on selection', icon: 'message-square', onPress: () => openSelection('comment') },
  ];

  const moreMenu = (anchor: { x: number; y: number }) =>
    setMenu({
      anchor: { ...anchor, align: 'right' },
      items: [
        { label: 'Add page', icon: 'file-plus', onPress: () => addPage() },
        { label: 'Rename', icon: 'edit-2', onPress: () => setRenaming(true) },
        { label: 'Cover…', icon: 'book', onPress: () => setCoverOpen(true) },
        {
          label: meta?.aiAccess ? 'Turn off AI access' : 'Turn on AI access',
          icon: 'cpu',
          tone: 'assistant',
          description: meta?.aiAccess ? 'Connected agents can read and comment' : 'Agents can’t see this notebook',
          onPress: () => notebook?.setMeta({ aiAccess: !meta?.aiAccess }),
        },
        { label: 'Export PDF', icon: 'file-text', onPress: () => void run('Exporting PDF…', () => exportNotebook(ctx, notebookId, 'pdf')) },
        { label: 'Export .qalm backup', icon: 'archive', onPress: () => void run('Exporting…', () => exportNotebook(ctx, notebookId, 'qalm')) },
        { label: 'Settings', icon: 'settings', onPress: () => router.push('/settings') },
      ],
    });

  const insertImage = () =>
    void run('Adding image…', async () => {
      if (!notebook) return;
      const pageId = lastPage.current && pages.some((p) => p.id === lastPage.current) ? lastPage.current : currentPageId;
      const info = pages.find((p) => p.id === pageId);
      const target = pageId ? pageData.get(pageId)?.page : undefined;
      if (!info || !target) return;
      const f = await pickFile(['image/*']);
      if (!f) return;
      if (!f.mime.startsWith('image/')) throw new Error('Pick an image');
      const asset = await s.assets.put(f.bytes, f.mime, f.name);
      notebook.addAsset(asset);
      const uri = (await s.assets.uri(asset)) ?? f.uri;
      const size = await new Promise<{ w: number; h: number }>((resolve) =>
        Image.getSize(uri, (w, hh) => resolve({ w, h: hh }), () => resolve({ w: 4, h: 3 })),
      );
      const w = Math.min(info.size.w * 0.6, size.w);
      const hh = (w * size.h) / size.w;
      const item: ImageItem = { id: newId(), type: 'image', assetId: asset.id, x: (info.size.w - w) / 2, y: Math.max(24, (info.size.h - hh) / 3), w, h: hh };
      target.addItem(item);
      setTool('lasso');
      setSelection({ pageId: info.id, ids: [item.id] });
    });

  const sendAsk = () => {
    const text = askText.trim();
    if (!notebook || !text) return;
    const scope = askScope;
    let askThread: string | undefined;
    if (scope) {
      const page = heldPage?.docId === docIds.page(notebookId, scope.pageId) ? heldPage.page : pageData.get(scope.pageId)?.page;
      // Keep the text (and the sheet) when there's nowhere to write it.
      if (!pages.some((p) => p.id === scope.pageId)) return showToast('That page was deleted. Your text is still here.');
      if (!page) return showToast('Still loading the page. Try again in a moment.');
      // A thread anchored to the selection; for an Ask, the agent answers in it.
      const asking = scope.mode === 'ask';
      const commentId = page.addComment({ author: { kind: 'user', name: 'You' }, text, anchor: scope.bbox, anchorIds: scope.ids, ask: asking || undefined });
      if (asking) {
        notebook.addAsk(scope.pageId, text, { sel: { itemIds: scope.ids, bbox: scope.bbox }, commentId });
        askThread = commentId;
      }
      setSelection(null);
      setActiveComment(commentId);
    } else {
      // The general Ask is about the page in view: the one the sheet names.
      const pageId = currentPageId ?? pages[0]?.id;
      if (!pageId) return;
      notebook.addAsk(pageId, text);
    }
    setAskText('');
    setAskOpen(false);
    setAskScope(null);
    if (scope?.mode === 'comment') return;
    if (meta?.aiAccess && agents.length && !meta.aiPaused) setThinking(startThinking(summaries, Date.now(), askThread));
    else showToast(!meta?.aiAccess ? 'Saved. Turn on AI access so agents can see it' : meta.aiPaused ? 'Saved. Sharing is paused' : 'Sent. No agent is following right now');
  };

  const scopeInfo = askScope ? pages.find((x) => x.id === askScope.pageId) : undefined;
  const scopePage = askScope ? (heldPage?.page ?? pageData.get(askScope.pageId)?.page) : undefined;
  // Read state (per device): a thread is read once it is opened (its card, pin or panel row tapped), or once its margin
  // card or panel card has been on screen for a moment. The badge counts the agent entries not read that way.
  const summariesRef = React.useRef(summaries);
  summariesRef.current = summaries;
  const markRead = React.useCallback(
    (ids: Iterable<string>) => {
      const want = new Set(ids);
      const read = summariesRef.current.filter((x) => want.has(x.id));
      setSeen((cur) => {
        const next = markSeen(read, cur);
        if (next !== cur) void kvSet(seenKey, next);
        return next;
      });
    },
    [seenKey],
  );
  const selectThread = React.useCallback(
    (id: string | null) => {
      setActiveComment(id);
      if (id) markRead([id]);
    },
    [markRead],
  );
  const [panelVisible, setPanelVisible] = React.useState<string[]>([]);
  // Margin cards on screen: on a visible page, and inside the viewport (checked again, live, when the dwell ends).
  const marginTops = new Map<string, number>();
  if (wideMargin) {
    for (let i = visFirst; i <= visLast; i++) {
      const info = pages[i];
      const slot = slots[i];
      const d = info ? pageData.get(info.id) : undefined;
      if (!info || !slot || !d) continue;
      const placed = marginCards(d.comments, slot.width / info.size.w, MARGIN_CARD_H, MARGIN_CARD_GAP, activeCommentId, slot.height, d.items);
      for (const m of fitColumn(placed, MARGIN_CARD_H, MARGIN_CARD_GAP, slot.height).shown) marginTops.set(m.comment.id, slot.top + m.top);
    }
  }
  const marginTopsRef = React.useRef(marginTops);
  marginTopsRef.current = marginTops;
  const marginOnScreen = (id: string) => {
    const top = marginTopsRef.current.get(id);
    return top !== undefined && top < scrollYRef.current + viewportRef.current.h && top + MARGIN_CARD_H > scrollYRef.current;
  };
  const unreadSet = unreadIds(summaries, seen);
  const onScreen = [...marginTops.keys()].filter(marginOnScreen);
  if (commentsOpen) onScreen.push(...panelVisible);
  const panelVisibleRef = React.useRef(panelVisible);
  panelVisibleRef.current = commentsOpen ? panelVisible : [];
  useReadAfterDwell(
    onScreen.filter((id) => unreadSet.has(id)),
    1500,
    (ids) => markRead(ids.filter((id) => panelVisibleRef.current.includes(id) || marginOnScreen(id))),
  );
  // Say so when an agent writes while the panel is closed and its card isn't in view: no margin (narrow windows), or
  // a page out of view, anywhere in the notebook. (Only entries written after the editor opened.)
  const newestAgent = newestAgentEntry(summaries);
  const notifiedAt = React.useRef(Date.now());
  React.useEffect(() => {
    if (!newestAgent || newestAgent.at <= notifiedAt.current) return;
    notifiedAt.current = newestAgent.at;
    const i = pages.findIndex((p) => p.id === newestAgent.pageId);
    if (commentsOpen || (wideMargin && i >= visFirst && i <= visLast)) return;
    showToast(i >= 0 && i !== current ? `${newestAgent.name} commented on page ${i + 1}. Open comments to read it.` : `${newestAgent.name} commented. Open comments to read it.`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newestAgent?.at]);

  const edCtx = React.useMemo<EditorCtx | null>(
    () =>
      notebook
        ? {
            notebook,
            notebookId,
            tools,
            setTool,
            onPenButton,
            input,
            undo,
            undoManagerFor: (pageId: string, page: Page) => registry.get(pageId, page),
            selection,
            setSelection,
            editingText,
            setEditingText,
            activeCommentId,
            setActiveComment: (id: string | null) => {
              selectThread(id);
              if (id) setCommentsOpen(true);
            },
            reportPage,
            touchPage,
          }
        : null,
    [notebook, notebookId, tools, setTool, onPenButton, input, undo, registry, selection, editingText, activeCommentId, selectThread, reportPage, touchPage],
  );

  if (!h || !notebook || !meta || !edCtx) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.bg }}>
        <ActivityIndicator color={c.accent} />
      </View>
    );
  }
  if (!found) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }}>
        <EmptyState icon="alert-circle" title="Notebook not found" body="It may still be syncing, or it was deleted, maybe on another device." action={<Button label="Back to library" onPress={() => router.replace('/')} />} />
      </SafeAreaView>
    );
  }

  const syncPill =
    sync === null ? null : sync === 'synced' ? <Pill label="Synced" tone="good" dot /> : sync === 'offline' ? <Pill label="Offline" tone="warn" dot /> : <Pill label="Syncing" tone="neutral" dot />;
  const narrow = win.width < 640;

  return (
    <EditorContext.Provider value={edCtx}>
      <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }} edges={['top', 'left', 'right']}>
        {/* Header */}
        <View style={[styles.header, { backgroundColor: c.surface, borderBottomColor: c.line }]}>
          <IconButton icon="chevron-left" label="Back to library" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
          <IconButton icon={navWide ? 'sidebar' : 'grid'} label="Pages" selected={navOpen} onPress={() => setNavOpen((x) => !x)} />
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text variant="bodyStrong" numberOfLines={1} onPress={() => setRenaming(true)} accessibilityRole="button" accessibilityHint="Rename the notebook">
              {meta.title}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text variant="meta" tone="faint" onPress={openGoTo} accessibilityRole="button" accessibilityHint="Go to a page">
                Page {current + 1} of {pages.length}
              </Text>
              {!narrow ? syncPill : null}
              {meta.aiAccess && (agents.length || meta.aiPaused) ? (
                <PresencePill agents={agents} notebook={notebook} paused={!!meta.aiPaused} thinking={isThinking} compact={narrow} />
              ) : !narrow && meta.aiAccess ? (
                <Pill label="AI can read" tone="assistant" />
              ) : null}
            </View>
          </View>
          <IconButton icon="rotate-ccw" label="Undo" disabled={!undo.canUndo} onPress={() => undo.undo()} />
          <IconButton icon="rotate-cw" label="Redo" disabled={!undo.canRedo} onPress={() => undo.redo()} />
          <View>
            <IconButton icon="message-square" label={unread ? `Comments, ${unread} unread` : 'Comments'} selected={commentsOpen} onPress={() => setCommentsOpen((x) => !x)} />
            {unread > 0 ? (
              <View pointerEvents="none" importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={[styles.badge, { backgroundColor: c.assistant }]}>
                <Text variant="meta" tone="onAccent" style={{ fontSize: 10, lineHeight: 14 }}>
                  {unread}
                </Text>
              </View>
            ) : null}
          </View>
          {win.width < 480 ? (
            <IconButton icon="message-circle" label="Ask" tone="assistant" onPress={() => openAsk()} />
          ) : (
            <Button label="Ask" icon="message-circle" variant="assistant" size="sm" onPress={() => openAsk()} />
          )}
          <IconButton icon="more-vertical" label="More" onPress={(e) => moreMenu({ x: e.nativeEvent.pageX, y: e.nativeEvent.pageY + 20 })} />
        </View>

        <View style={{ flex: 1, flexDirection: 'row' }}>
          {navOpen && navWide && thumbs ? (
            <PageNavigator
              mode="sidebar"
              width={NAV_SIDEBAR_W}
              pages={pages}
              current={current}
              thumbs={thumbs}
              onJump={jumpTo}
              onClose={() => setNavOpen(false)}
              onGoTo={openGoTo}
              onMove={movePage}
              onDuplicate={duplicatePage}
              onDelete={deletePage}
              onBookmark={toggleBookmark}
              onPaper={setPaperFor}
            />
          ) : null}
          <View style={{ flex: 1 }} onLayout={(e) => setViewport({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
            <GestureDetector gesture={pinch}>
              <ScrollView horizontal scrollEnabled={contentW > viewport.w + 1} contentContainerStyle={{ width: contentW }} showsHorizontalScrollIndicator={contentW > viewport.w + 1}>
                <ScrollView
                  ref={vScroll}
                  indicatorStyle={indicatorStyleFor(scheme)}
                  style={{ width: contentW, height: viewport.h }}
                  scrollEventThrottle={32}
                  onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => {
                    const y = e.nativeEvent.contentOffset.y;
                    scrollYRef.current = y;
                    if (viewKey(slotsRef.current, y, viewportRef.current.h) !== shownKey.current) setScrollY(y);
                  }}
                >
                  <View style={{ width: contentW, height: totalH, transform: liveScale !== 1 ? [{ scale: liveScale }] : undefined, transformOrigin: 'top center' }}>
                    {slots.slice(winFirst, winLast + 1).map((slot, k) => {
                      const i = winFirst + k;
                      const info = pages[i]!;
                      const left = (contentW - slot.width) / 2;
                      const data = i >= first && i <= last ? pageData.get(info.id) : undefined;
                      const cards =
                        column && data
                          ? fitColumn(
                              marginCards(data.comments, slot.width / info.size.w, MARGIN_CARD_H, MARGIN_CARD_GAP, activeCommentId, slot.height, data.items),
                              MARGIN_CARD_H,
                              MARGIN_CARD_GAP,
                              slot.height,
                            )
                          : null;
                      return (
                        <React.Fragment key={slot.id}>
                          <View style={[styles.page, { left, top: slot.top, width: slot.width, height: slot.height, borderColor: c.line }]}>
                            {i >= first && i <= last ? (
                              <PageView info={info} index={i} width={slot.width} zoom={zoom} visible={i >= visFirst && i <= visLast} priority={Math.abs(i - current)} />
                            ) : (
                              <View style={{ flex: 1, backgroundColor: info.paperColor === 'night' ? '#1f1f23' : info.paperColor === 'cream' ? '#fbf7ee' : '#ffffff' }} />
                            )}
                          </View>
                          <View style={[styles.pageFoot, { left, top: slot.top + slot.height + 4, width: slot.width }]}>
                            <Text variant="meta" tone="faint">
                              {i + 1}
                              {info.background.kind === 'pdf' ? ' · PDF' : ''}
                            </Text>
                            <IconButton icon="more-horizontal" label={`Page ${i + 1} options`} size={32} onPress={(e) => pageMenu(i, { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY })} />
                          </View>
                          {column && cards && (cards.shown.length || cards.more) ? (
                            <View
                              pointerEvents="box-none"
                              style={{ position: 'absolute', left: left + slot.width + column.gap, top: slot.top, width: column.width, height: slot.height }}
                            >
                              {cards.shown.map((m) => (
                                <MarginCard
                                  key={m.comment.id}
                                  comment={m.comment}
                                  top={m.top}
                                  width={column.width}
                                  active={m.comment.id === activeCommentId}
                                  unread={unreadSet.has(m.comment.id)}
                                  thinking={isThinking && thinking?.commentId === m.comment.id}
                                  onPress={() => edCtx.setActiveComment(m.comment.id)}
                                />
                              ))}
                              {cards.more ? (
                                <View style={{ position: 'absolute', top: cards.moreTop, left: 0 }}>
                                  <Button
                                    label={`${cards.more} more`}
                                    accessibilityLabel={`${cards.more} more comments on page ${i + 1}: open comments`}
                                    icon="message-square"
                                    size="sm"
                                    variant="ghost"
                                    onPress={() => setCommentsOpen(true)}
                                  />
                                </View>
                              ) : null}
                            </View>
                          ) : null}
                        </React.Fragment>
                      );
                    })}
                    {slots.length ? (
                      <View style={{ position: 'absolute', top: contentHeight(slots, GAP), left: 0, right: 0, alignItems: 'center' }}>
                        <Button label="Add page" icon="plus" size="sm" onPress={() => addPage()} />
                      </View>
                    ) : null}
                  </View>
                </ScrollView>
              </ScrollView>
            </GestureDetector>

            {/* Floating toolbar */}
            <View style={styles.toolbarWrap} pointerEvents="box-none">
              <Toolbar
                tools={tools}
                paper={pages[current]?.paperColor}
                onTool={setTool}
                onChange={changeTools}
                onImage={insertImage}
                zoom={zoom * liveScale}
                onZoom={(d) => commitZoom(stepZoom(zoom, d))}
                onZoomReset={() => commitZoom(1)}
              />
            </View>

            {selection && selectionPage ? (
              <View style={styles.selWrap} pointerEvents="box-none">
                <View style={[styles.selBar, shadow2, { backgroundColor: c.surface, borderColor: c.line }]}>
                  {recoloring ? (
                    <>
                      <IconButton icon="chevron-left" label="Back" onPress={() => setRecoloring(false)} />
                      <SwatchStrip tool="pen" verb="Recolour" paper={selectionPaper} current={selectionColor ?? ''} onSelect={(hex) => sel.recolor(hex)} />
                    </>
                  ) : (
                    <>
                      <Text variant="label" style={{ paddingHorizontal: 8 }}>
                        {selection.ids.length} selected
                      </Text>
                      <IconButton icon="droplet" label="Recolour" onPress={() => setRecoloring(true)} />
                      {narrow ? (
                        // Under 640 px the secondary actions go in a menu so the bar stays one row (F27).
                        <IconButton
                          icon="more-horizontal"
                          label="More selection actions"
                          onPress={(e) => setMenu({ anchor: { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY }, items: selMore })}
                        />
                      ) : (
                        selMore.map((m) => <IconButton key={m.label} icon={m.icon!} label={m.label} onPress={m.onPress} />)
                      )}
                      {/* Reading stays on the bar at every width (F6). */}
                      {selInk.length ? <IconButton icon="type" label="Reading" onPress={openReading} /> : null}
                      <Button label="Ask" accessibilityLabel="Ask about selection" icon="message-circle" variant="assistant" size="sm" onPress={() => openSelection('ask')} />

                      <IconButton icon="trash-2" label="Delete selection" tone="bad" onPress={deleteSelection} />
                      <IconButton icon="x" label="Deselect" onPress={() => setSelection(null)} />
                    </>
                  )}
                </View>
              </View>
            ) : tools.tool === 'lasso' && clip ? (
              <View style={styles.selWrap} pointerEvents="box-none">
                <View style={[styles.selBar, shadow2, { backgroundColor: c.surface, borderColor: c.line }]}>
                  <Button label="Paste" icon="clipboard" size="sm" onPress={sel.paste} />
                </View>
              </View>
            ) : null}
          </View>

          {commentsOpen ? (
            // Docked: a fixed-width column beside the page area (never squeezed by it). Floating: over the page, at the right.
            <View style={dockComments ? { width: PANEL_W, flexShrink: 0 } : [StyleSheet.absoluteFill, { alignItems: 'flex-end' }]} pointerEvents="box-none">
              <View style={dockComments ? { flex: 1 } : [{ flex: 1, maxWidth: '100%' }, shadow2]}>
              <CommentsPanel
                threads={threads}
                indexing={indexing}
                activeId={activeCommentId}
                onSelect={selectThread}
                onVisible={setPanelVisible}
                onJump={scrollToPage}
                onClose={() => {
                  setCommentsOpen(false);
                  setActiveComment(null);
                }}
              />
              </View>
            </View>
          ) : null}
          {navOpen && !navWide && thumbs ? (
            <View style={StyleSheet.absoluteFill}>
              <PageNavigator
                mode="grid"
                width={win.width}
                pages={pages}
                current={current}
                thumbs={thumbs}
                onJump={(i) => {
                  setNavOpen(false);
                  jumpTo(i);
                }}
                onClose={() => setNavOpen(false)}
                onGoTo={openGoTo}
                onMove={movePage}
                onDuplicate={duplicatePage}
                onDelete={deletePage}
                onBookmark={toggleBookmark}
              onPaper={setPaperFor}
              />
            </View>
          ) : null}
        </View>

        {busy ? (
          <View style={[styles.busy, { backgroundColor: c.surface, borderColor: c.line }]} pointerEvents="none">
            <ActivityIndicator color={c.accent} size="small" />
            <Text variant="label">{busy}</Text>
          </View>
        ) : null}
        {toast}

        {reading ? (
          <ReadingSheet
            page={reading.page}
            ink={reading.ink}
            onClose={() => setReading(null)}
            onDone={(msg) => {
              touchPage(reading.pageId);
              setReading(null);
              if (msg) showToast(msg);
            }}
          />
        ) : null}
        <Menu visible={!!menu} onClose={() => setMenu(null)} items={menu?.items ?? []} anchor={menu?.anchor} />

        <Sheet
          visible={askOpen}
          onClose={() => setAskOpen(false)}
          title={askScope ? (askScope.mode === 'comment' ? 'Comment on the selection' : 'Ask about the selection') : 'Ask your agent'}
          width={480}
          footer={
            <>
              <Button label="Cancel" onPress={() => setAskOpen(false)} />
              <Button
                label={askScope?.mode === 'comment' ? 'Comment' : 'Send'}
                variant={askScope?.mode === 'comment' ? 'primary' : 'assistant'}
                icon="send"
                disabled={!askText.trim()}
                onPress={sendAsk}
              />
            </>
          }
        >
          {askScope && scopeInfo && scopePage ? (
            <SelectionThumb info={scopeInfo} items={askScope.ids.map((id) => scopePage.item(id)).filter((x) => !!x)} bbox={askScope.bbox} />
          ) : null}
          <Text tone="muted">
            {askScope?.mode === 'comment'
              ? 'Your comment is pinned next to the selection. Connected agents see it and can reply.'
              : askScope
                ? 'Connected agents get your question right away, with an image of the selection. The answer appears in a thread next to it.'
                : `Connected agents get your question right away, with what changed on page ${current + 1}. Answers appear as comments next to your ink.`}
          </Text>
          <TextField
            value={askText}
            onChangeText={setAskText}
            placeholder={askScope?.mode === 'comment' ? 'Add a comment' : askScope ? 'What would you like to know about this?' : 'Is line 5 right?'}
            multiline
            autoFocus
            accessibilityLabel={askScope?.mode === 'comment' ? 'Comment' : 'Question'}
            style={{ minHeight: 72 }}
          />
          <View style={{ borderWidth: StyleSheet.hairlineWidth, borderColor: c.line, borderRadius: radius.control }}>
            <Row title="AI access" description={meta.aiAccess ? 'Agents you approved can read and comment' : 'Off: agents can’t see this notebook'} last>
              <Toggle label="AI access" value={meta.aiAccess} onChange={(v) => notebook.setMeta({ aiAccess: v })} />
            </Row>
          </View>
        </Sheet>

        <Sheet
          visible={goTo !== null}
          onClose={() => setGoTo(null)}
          title="Go to page"
          width={360}
          footer={
            <>
              <Button label="Cancel" onPress={() => setGoTo(null)} />
              <Button
                label="Go"
                variant="primary"
                disabled={parseGoTo(goTo ?? '', pages.length) === null}
                onPress={() => {
                  const i = parseGoTo(goTo ?? '', pages.length);
                  setGoTo(null);
                  if (i !== null) {
                    setNavOpen((x) => x && navWide);
                    jumpTo(i);
                  }
                }}
              />
            </>
          }
        >
          <TextField
            value={goTo ?? ''}
            onChangeText={(v) => setGoTo(v.replace(/[^0-9]/g, ''))}
            keyboardType="number-pad"
            autoFocus
            selectTextOnFocus
            accessibilityLabel={`Page number, 1 to ${pages.length}`}
            placeholder={`1–${pages.length}`}
            onSubmitEditing={() => {
              const i = parseGoTo(goTo ?? '', pages.length);
              setGoTo(null);
              if (i !== null) {
                setNavOpen((x) => x && navWide);
                jumpTo(i);
              }
            }}
          />
        </Sheet>

        <PaperSheet
          visible={paperFor !== null && !!pages[paperFor]}
          title={`Paper for page ${(paperFor ?? 0) + 1}`}
          initial={{ paper: pages[paperFor ?? 0]?.paper ?? meta.paper, paperColor: pages[paperFor ?? 0]?.paperColor ?? meta.paperColor }}
          pdfPages={pages.filter((p) => p.background.kind === 'pdf').length}
          onClose={() => setPaperFor(null)}
          onApply={({ paper, paperColor, all }) => {
            const p = paperFor !== null ? pages[paperFor] : undefined;
            setPaperFor(null);
            if (!p) return;
            notebook.setPagePaper(all ? pages.map((x) => x.id) : [p.id], { paper, paperColor });
          }}
        />
        <CoverSheet
          visible={coverOpen}
          initial={{ title: meta.title, cover: meta.cover }}
          onClose={() => setCoverOpen(false)}
          onSave={(v) => {
            setCoverOpen(false);
            if (library) void updateNotebookMeta({ dm: s.dm, assets: s.assets, library }, notebookId, v);
            else notebook.setMeta(v);
          }}
        />
        <NameSheet
          visible={renaming}
          title="Rename notebook"
          initial={meta.title}
          placeholder="Title"
          action="Rename"
          onClose={() => setRenaming(false)}
          onSubmit={(title) => {
            setRenaming(false);
            if (library) void updateNotebookMeta({ dm: s.dm, assets: s.assets, library }, notebookId, { title });
            else notebook.setMeta({ title });
          }}
        />
      </SafeAreaView>
    </EditorContext.Provider>
  );
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 6, minHeight: 60, borderBottomWidth: StyleSheet.hairlineWidth },
  badge: { position: 'absolute', top: 4, right: 2, minWidth: 16, height: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  page: {
    position: 'absolute',
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 },
    elevation: 1,
  },
  pageFoot: { position: 'absolute', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 32 },
  toolbarWrap: { position: 'absolute', top: 12, left: 12, right: 12, alignItems: 'center' },
  selWrap: { position: 'absolute', bottom: 20, left: 12, right: 12, alignItems: 'center' },
  selBar: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 2, padding: 4, borderRadius: radius.panel, borderWidth: StyleSheet.hairlineWidth },
  busy: {
    position: 'absolute',
    top: 72,
    alignSelf: 'center',
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
