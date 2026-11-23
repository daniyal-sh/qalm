import { LOCAL_ORIGIN, Notebook, PEN_WIDTHS, HIGHLIGHTER_WIDTH, type ImageItem, type Page } from '@qalm/core';
import { router } from 'expo-router';
import { QalmInk } from 'qalm-ink';
import * as React from 'react';
import { ActivityIndicator, Image, Platform, ScrollView, StyleSheet, useWindowDimensions, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { GestureDetector, usePinchGesture } from 'react-native-gesture-handler';
import { SafeAreaView } from 'react-native-safe-area-context';

import { exportNotebook, updateNotebookMeta } from '../library/ops';
import { NameSheet } from '../library/components';
import { newId } from '../lib/id';
import { kvGet, kvSet } from '../lib/kv';
import { pickFile } from '../lib/files';
import { docIds } from '../sync/docs';
import { useDoc, useLibraryData, useSession, useSyncStatus, useVersion } from '../state/session';
import { useTheme } from '../theme/ThemeProvider';
import { PEN_COLORS, HIGHLIGHTER_COLORS, radius, shadow2 } from '../theme/tokens';
import { confirm } from '../ui/confirm';
import { Button, IconButton, Pill, TextField, Toggle } from '../ui/controls';
import { EmptyState, Menu, Row, Sheet, useToast, type MenuItem } from '../ui/layout';
import { Text } from '../ui/Text';
import { CommentsPanel } from './CommentsPanel';
import { MARGIN_CARD_H, MarginCard, PresencePill, usePresence } from './ai';
import { markAllSeen, marginCards, newestAgentEntry, startThinking, stillThinking, THINKING_MS, unreadCount, type SeenThreads, type Thinking } from './ai.logic';
import { EditorContext, UndoRegistry, type EditorCtx, type PageData, type Selection, type ToolState } from './context';
import { getClip, pasteItems, setClip, useClip } from './clipboard';
import { cloneItems, recolorPatch, selectionBBox } from './items';
import { trackModifiers } from './modifiers';
import { SelectionThumb } from './SelectionThumb';
import { PageView } from './PageView';
import { Toolbar } from './Toolbar';
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
  type ToolId,
} from './view';

const GAP = 44;
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
  const { c, input } = useTheme();
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
    const off = s.dm.onEvict((docId) => {
      const prefix = `pg:${notebookId}:`;
      if (docId.startsWith(prefix)) registry.drop(docId.slice(prefix.length));
    });
    return () => {
      off();
      registry.clear();
    };
  }, [s.dm, registry, notebookId]);

  // ---- selection, text, comments ----
  const [selection, setSelection] = React.useState<Selection | null>(null);
  const [editingText, setEditingText] = React.useState<{ pageId: string; itemId: string } | null>(null);
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
  // ---- live agent: presence, "thinking…" after an Ask, unread agent comments ----
  const agents = usePresence(s.user ? s.tm : null, notebookId, !!meta?.aiAccess);
  const [seen, setSeen] = React.useState<SeenThreads>({});
  const seenKey = `seen:${notebookId}`;
  React.useEffect(() => {
    void kvGet<SeenThreads>(seenKey).then((v) => v && setSeen((cur) => ({ ...v, ...cur })));
  }, [seenKey]);
  const [thinking, setThinking] = React.useState<Thinking | null>(null);
  const isThinking = stillThinking(thinking, pageData, Date.now());
  React.useEffect(() => {
    if (!thinking) return;
    if (!isThinking) return setThinking(null);
    const t = setTimeout(() => setThinking((x) => (x === thinking ? null : x)), Math.max(0, thinking.at + THINKING_MS - Date.now()));
    return () => clearTimeout(t);
  }, [thinking, isThinking]);
  const unread = unreadCount(pageData.values(), seen);

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

  // Recognition model (ML Kit downloads it once; web is a no-op).
  React.useEffect(() => {
    QalmInk.ensureModel('en-US').catch(() => undefined);
  }, []);

  // Mirror title / cover / AI access into the library entry (they may change on another device).
  React.useEffect(() => {
    if (!meta || !library) return;
    const e = library.entry(notebookId);
    if (!e) library.putEntry({ id: notebookId, title: meta.title, cover: meta.cover, folderId: null, updatedAt: meta.updatedAt, aiAccess: meta.aiAccess, favorite: false, deletedAt: null });
    else if (e.title !== meta.title || e.cover !== meta.cover || e.aiAccess !== meta.aiAccess) library.updateEntry(notebookId, { title: meta.title, cover: meta.cover, aiAccess: meta.aiAccess });
  }, [meta, library, notebookId]);

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
  const contentW = Math.max(viewport.w, Math.max(0, ...slots.map((x) => x.width)) + 48);
  const [first, last] = mountedRange(slots, scrollY, viewport.h, 2);
  // Comment cards sit in the margin beside the page when there's room; otherwise pins on the page and the panel.
  const gutter = (contentW - Math.max(0, ...slots.map((x) => x.width))) / 2;
  const wideMargin = gutter >= 200;
  const marginW = Math.min(240, gutter - 40);
  const current = currentPageIndex(slots, scrollY, viewport.h);
  const currentPageId = pages[current]?.id ?? null;

  const commitZoom = React.useCallback(
    (next: number) => {
      const z = clampZoom(next);
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
  const selectedItems = () => (selection && selectionPage ? selection.ids.map((id) => selectionPage.item(id)).filter((x) => !!x) : []);
  const openSelection = (mode: 'ask' | 'comment') => {
    if (!selection || !selectionPage) return;
    const box = selectionBBox(selectedItems());
    if (box) openAsk({ pageId: selection.pageId, ids: selection.ids, bbox: box, mode });
  };
  const deleteSelection = () => {
    if (!selection || !selectionPage) return;
    selectionPage.removeItems(selection.ids);
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
      target.page.doc.transact(() => copies.forEach((it) => target.page.addItem(it)), LOCAL_ORIGIN);
      touchPage(target.pageId);
      setTool('lasso');
      setSelection({ pageId: target.pageId, ids: copies.map((x) => x.id) });
    },
    duplicate: () => {
      if (!selection || !selectionPage) return;
      const copies = cloneItems(selectedItems(), 16, 16, newId);
      selectionPage.doc.transact(() => copies.forEach((it) => selectionPage.addItem(it)), LOCAL_ORIGIN);
      setSelection({ pageId: selection.pageId, ids: copies.map((x) => x.id) });
    },
    recolor: (hex: string) => {
      if (!selection || !selectionPage) return;
      selectionPage.doc.transact(() => {
        for (const it of selectedItems()) {
          const patch = recolorPatch(it, hex);
          if (patch) selectionPage.updateItem(it.id, patch);
        }
      }, LOCAL_ORIGIN);
    },
    order: (to: 'front' | 'back') => {
      if (selection && selectionPage) selectionPage.reorder(selection.ids, to);
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
      } else if (mod && k === 'v' && getClip()) {
        ev.preventDefault();
        a.paste();
      } else if (mod && k === 'a') {
        ev.preventDefault();
        a.selectAll();
      } else if ((k === 'delete' || k === 'backspace') && selection) {
        ev.preventDefault();
        deleteSelection();
      } else if (k === 'escape') setSelection(null);
      else if (mod) return;
      else if (k === 'p') setTool('pen');
      else if (k === 'h') setTool('highlighter');
      else if (k === 'e') setTool('eraser');
      else if (k === 'l') setTool('lasso');
      else if (k === 't') setTool('text');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undo, selection, selectionPage, setTool]);

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
  const [renaming, setRenaming] = React.useState(false);
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
    const slot = slots.find((x) => x.id === pageId);
    if (slot) vScroll.current?.scrollTo({ y: Math.max(0, slot.top - 80), animated: true });
  };

  const addPage = (afterIndex?: number) => {
    if (!notebook) return;
    const after = afterIndex !== undefined ? pages[afterIndex] : pages[pages.length - 1];
    // A page after a PDF page gets the notebook's paper.
    const id = notebook.addPage(after && after.background.kind === 'paper' ? { size: after.size, paper: after.paper, paperColor: after.paperColor } : {}, afterIndex !== undefined ? afterIndex + 1 : undefined);
    requestAnimationFrame(() => scrollToPage(id));
  };

  const deletePage = (index: number) => {
    if (!notebook || pages.length <= 1) return showToast('A notebook needs at least one page');
    const p = pages[index];
    if (!p) return;
    confirm(`Delete page ${index + 1}?`, 'Its ink, text and comments go with it.', 'Delete', () => {
      registry.drop(p.id);
      notebook.removePage(p.id);
    });
  };

  const pageMenu = (index: number, anchor: { x: number; y: number }) =>
    setMenu({
      anchor: { ...anchor, align: 'right' },
      items: [
        { label: 'Add page after', icon: 'plus', onPress: () => addPage(index) },
        { label: 'Move up', icon: 'arrow-up', onPress: () => index > 0 && notebook?.movePage(pages[index]!.id, index - 1) },
        { label: 'Move down', icon: 'arrow-down', onPress: () => index < pages.length - 1 && notebook?.movePage(pages[index]!.id, index + 1) },
        { label: 'Delete page', icon: 'trash-2', tone: 'bad', onPress: () => deletePage(index) },
      ],
    });

  const ctx = { dm: s.dm, assets: s.assets };
  const moreMenu = (anchor: { x: number; y: number }) =>
    setMenu({
      anchor: { ...anchor, align: 'right' },
      items: [
        { label: 'Add page', icon: 'file-plus', onPress: () => addPage() },
        { label: 'Rename', icon: 'edit-2', onPress: () => setRenaming(true) },
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
    const data = scope ? pageData.get(scope.pageId) : undefined;
    let askThread: string | undefined;
    if (scope && data) {
      // A thread anchored to the selection; for an Ask, the agent answers in it.
      const ids = new Set(scope.ids);
      const first = data.lines.filter((l) => l.itemIds.some((id) => ids.has(id))).sort((a, b) => a.bbox[1] - b.bbox[1] || a.bbox[0] - b.bbox[0])[0];
      const asking = scope.mode === 'ask';
      const commentId = data.page.addComment({ lineKey: first?.key ?? '', author: { kind: 'user', name: 'You' }, text, anchor: scope.bbox, anchorIds: scope.ids, ask: asking || undefined });
      if (asking) {
        notebook.addAsk(scope.pageId, text, { sel: { itemIds: scope.ids, bbox: scope.bbox }, commentId });
        askThread = commentId;
      }
      setSelection(null);
      setActiveComment(commentId);
    } else if (!scope) notebook.addAsk(lastPage.current ?? currentPageId ?? pages[0]!.id, text);
    setAskText('');
    setAskOpen(false);
    setAskScope(null);
    if (scope?.mode === 'comment') return;
    if (meta?.aiAccess && agents.length && !meta.aiPaused) setThinking(startThinking(pageData, Date.now(), askThread));
    else showToast(!meta?.aiAccess ? 'Saved. Turn on AI access so agents can see it' : meta.aiPaused ? 'Saved. Sharing is paused' : 'Sent. No agent is following right now');
  };

  const scopeInfo = askScope ? pages.find((x) => x.id === askScope.pageId) : undefined;
  const scopePage = askScope ? pageData.get(askScope.pageId)?.page : undefined;
  const commentCount = [...pageData.values()].reduce((n, d) => n + d.comments.filter((x) => !x.resolved).length, 0);
  React.useEffect(() => {
    if (!commentsOpen || !unread) return;
    const t = setTimeout(() => {
      setSeen((cur) => {
        const next = markAllSeen(pageData.values(), cur);
        if (next !== cur) void kvSet(seenKey, next);
        return next;
      });
    }, 3000);
    return () => clearTimeout(t);
  }, [commentsOpen, unread, pageData, seenKey]);
  // Narrow windows have no margin for cards: say so when an agent writes while the panel is closed.
  // (Only entries written after the editor opened, so pages loading while scrolling stay quiet.)
  const newestAgent = newestAgentEntry(pageData.values());
  const notifiedAt = React.useRef(Date.now());
  React.useEffect(() => {
    if (!newestAgent || newestAgent.at <= notifiedAt.current) return;
    notifiedAt.current = newestAgent.at;
    if (!commentsOpen && !wideMargin) showToast(`${newestAgent.name} commented. Open comments to read it.`);
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
              setActiveComment(id);
              if (id) setCommentsOpen(true);
            },
            reportPage,
            touchPage,
          }
        : null,
    [notebook, notebookId, tools, setTool, onPenButton, input, undo, registry, selection, editingText, activeCommentId, reportPage, touchPage],
  );

  if (!h || !notebook || !meta || !edCtx) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: c.bg }}>
        <ActivityIndicator color={c.accent} />
      </View>
    );
  }
  if (!meta.id) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }}>
        <EmptyState icon="alert-circle" title="Notebook not found" body="It may still be syncing, or it was deleted on another device." action={<Button label="Back to library" onPress={() => router.replace('/')} />} />
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
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text variant="bodyStrong" numberOfLines={1} onPress={() => setRenaming(true)}>
              {meta.title}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text variant="meta" tone="faint">
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
            <IconButton icon="message-square" label="Comments" selected={commentsOpen} onPress={() => setCommentsOpen((x) => !x)} />
            {unread > 0 || commentCount > 0 ? (
              <View
                pointerEvents="none"
                accessibilityLabel={unread ? `${unread} unread` : undefined}
                style={[styles.badge, { backgroundColor: unread ? c.assistant : c.muted }]}
              >
                <Text variant="meta" tone="onAccent" style={{ fontSize: 10, lineHeight: 14 }}>
                  {unread || commentCount}
                </Text>
              </View>
            ) : null}
          </View>
          {narrow ? (
            <IconButton icon="help-circle" label="Ask" tone="assistant" onPress={() => openAsk()} />
          ) : (
            <Button label="Ask" icon="help-circle" variant="assistant" size="sm" onPress={() => openAsk()} />
          )}
          <IconButton icon="more-vertical" label="More" onPress={(e) => moreMenu({ x: e.nativeEvent.pageX, y: e.nativeEvent.pageY + 20 })} />
        </View>

        <View style={{ flex: 1, flexDirection: 'row' }}>
          <View style={{ flex: 1 }} onLayout={(e) => setViewport({ w: e.nativeEvent.layout.width, h: e.nativeEvent.layout.height })}>
            <GestureDetector gesture={pinch}>
              <ScrollView horizontal scrollEnabled={contentW > viewport.w + 1} contentContainerStyle={{ width: contentW }} showsHorizontalScrollIndicator={contentW > viewport.w + 1}>
                <ScrollView
                  ref={vScroll}
                  style={{ width: contentW, height: viewport.h }}
                  scrollEventThrottle={32}
                  onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) => {
                    scrollYRef.current = e.nativeEvent.contentOffset.y;
                    setScrollY(e.nativeEvent.contentOffset.y);
                  }}
                >
                  <View style={{ width: contentW, height: totalH, transform: liveScale !== 1 ? [{ scale: liveScale }] : undefined, transformOrigin: 'top center' }}>
                    {slots.map((slot, i) => {
                      const info = pages[i]!;
                      const left = (contentW - slot.width) / 2;
                      const data = i >= first && i <= last ? pageData.get(info.id) : undefined;
                      const cards = wideMargin && data ? marginCards(data.lines, data.comments, slot.width / info.size.w, MARGIN_CARD_H, 8, activeCommentId, slot.height, data.items) : [];
                      return (
                        <React.Fragment key={slot.id}>
                          <View style={[styles.page, { left, top: slot.top, width: slot.width, height: slot.height, borderColor: c.line }]}>
                            {i >= first && i <= last ? (
                              <PageView info={info} index={i} width={slot.width} zoom={zoom} />
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
                          {cards.length ? (
                            <View pointerEvents="box-none" style={{ position: 'absolute', left: left + slot.width + 14, top: slot.top, width: marginW, height: slot.height }}>
                              {cards.map((m) => (
                                <MarginCard
                                  key={m.comment.id}
                                  comment={m.comment}
                                  top={m.top}
                                  width={marginW}
                                  active={m.comment.id === activeCommentId}
                                  seen={seen}
                                  thinking={isThinking && thinking?.commentId === m.comment.id}
                                  onPress={() => edCtx.setActiveComment(m.comment.id)}
                                />
                              ))}
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
                      {PEN_COLORS.map((p) => (
                        <IconButton key={p.hex} icon="circle" label={`Recolour ${p.name}`} color={p.hex} onPress={() => sel.recolor(p.hex)} />
                      ))}
                    </>
                  ) : (
                    <>
                      <Text variant="label" style={{ paddingHorizontal: 8 }}>
                        {selection.ids.length} selected
                      </Text>
                      <IconButton icon="droplet" label="Recolour" onPress={() => setRecoloring(true)} />
                      <IconButton icon="plus-square" label="Duplicate" onPress={sel.duplicate} />
                      <IconButton icon="copy" label="Copy" onPress={sel.copy} />
                      <IconButton icon="scissors" label="Cut" onPress={sel.cut} />
                      {clip ? <IconButton icon="clipboard" label="Paste" onPress={sel.paste} /> : null}
                      <IconButton icon="chevrons-up" label="Bring to front" onPress={() => sel.order('front')} />
                      <IconButton icon="chevrons-down" label="Send to back" onPress={() => sel.order('back')} />
                      <IconButton icon="message-square" label="Comment on selection" onPress={() => openSelection('comment')} />
                      <Button label="Ask" accessibilityLabel="Ask about selection" icon="help-circle" variant="assistant" size="sm" onPress={() => openSelection('ask')} />
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
            <View style={dockComments ? undefined : [StyleSheet.absoluteFill, { alignItems: 'flex-end' }]} pointerEvents="box-none">
              <View style={dockComments ? { flex: 1 } : [{ flex: 1, maxWidth: '100%' }, shadow2]}>
              <CommentsPanel
                pages={pageData}
                activeId={activeCommentId}
                onSelect={setActiveComment}
                onJump={scrollToPage}
                onClose={() => {
                  setCommentsOpen(false);
                  setActiveComment(null);
                }}
              />
              </View>
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
                : `Connected agents get your question right away, with what changed on page ${current + 1}. Answers appear as comments next to your lines.`}
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
