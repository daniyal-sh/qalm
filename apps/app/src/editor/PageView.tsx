import { boxSelect, EraseSession, inkOnPaper, textHeight, hitTestPoint, isIdentity, lassoSelect, rendersMarkdown, Page, type Item, type PageInfo, type TextItem } from '@qalm/core';
import { InkOverlay, PageCanvas, QalmInk, useMathFill, type InkOverlayProps } from 'qalm-ink';
import * as React from 'react';
import { PixelRatio, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { mark } from '../bench/hook';
import { newId } from '../lib/id';
import { docIds, openLoaded, type DocHandle } from '../sync/docs';
import { useSession, useVersion } from '../state/session';
import { smoothingLevel } from '../theme/ThemeProvider';
import { font } from '../theme/tokens';
import { useEditor } from './context';
import { applyFormatTo, type Sel } from './format.logic';
import { adjustLiveShape, commitErase, commitSnapped, eraseAlong, scribbleErase, DEFAULT_TEXT_SIZE, DEFAULT_TEXT_WIDTH, dropEmptyText, formatText, TEXT_LINE_HEIGHT, hitText, typeText, liveShape, makeStroke, pointsBBox, transformPatch } from './items';
import { EraseFade, type Fading } from './EraseFade';
import { isAdditive } from './modifiers';
import { PAPER_ACCENT, SelectionFrame, type LiveEdit } from './SelectionFrame';
import { pageDocQueue, pdfQueue } from './renderQueue';
import { commentAnchors, pdfRenderWidth } from './view';

/** A lasso that moved less than this (px) is a tap. */
const TAP_SLOP_PX = 6;
/** A partial erase is committed this long after its last segment if the pen-up never arrives. */
const COMMIT_AFTER_MS = 400;
/** A tap selects the nearest item within this many px. */
const TAP_TOLERANCE_PX = 10;
const DOUBLE_TAP_MS = 450;
/** A text-tool tap this soon after a text box was finished only finished it (no new box), like GoodNotes. */
const TEXT_END_MS = 400;
let textEndedAt = 0;

/** Resolves asset ids to loadable uris (PDF file for the background, image files for image items). */
function useAssetUris(ids: string[]): Map<string, string> {
  const { assets } = useSession();
  const { notebook } = useEditor();
  const [map, setMap] = React.useState(() => new Map<string, string>());
  const key = ids.join(',');
  React.useEffect(() => {
    let alive = true;
    for (const id of ids) {
      if (map.has(id)) continue;
      const a = notebook.asset(id);
      if (!a) continue;
      void assets.uri(a).then((u) => {
        if (alive && u) setMap((m) => (m.has(id) ? m : new Map(m).set(id, u)));
      });
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, notebook, assets]);
  return map;
}

function usePdfBackground(info: PageInfo, width: number, zoom: number, visible: boolean): string | undefined {
  const bg = info.background;
  const assetId = bg.kind === 'pdf' ? bg.assetId : null;
  const uris = useAssetUris(assetId ? [assetId] : []);
  const fileUri = assetId ? uris.get(assetId) : undefined;
  // A page scrolling out of view keeps the bitmap it has (no re-render at 1×); one mounted off screen starts at 1×.
  const full = pdfRenderWidth(width, zoom, PixelRatio.get(), true);
  const last = React.useRef<number | null>(null);
  const target = visible ? full : last.current !== null && last.current <= full ? last.current : pdfRenderWidth(width, zoom, PixelRatio.get(), false);
  last.current = target;
  const [png, setPng] = React.useState<string | undefined>();
  React.useEffect(() => {
    if (!fileUri || bg.kind !== 'pdf') return;
    let alive = true;
    // Queued (2 at a time, newest first) and dropped if the page scrolls away before its turn.
    const job = pdfQueue.request(() => QalmInk.renderPdfPage(fileUri, bg.pageIndex, target));
    job.promise.then((u) => alive && setPng(u)).catch(() => undefined);
    return () => {
      alive = false;
      job.cancel();
    };
  }, [fileUri, bg.kind === 'pdf' ? bg.pageIndex : -1, target]);
  return png;
}

/** Off-screen (overscan) pages open their doc a moment later, so the pages in view load and draw first. */
/** `value`, or the previous one while its JSON is the same (small lists: comments, readings). */
function useSameJson<T>(value: T): T {
  const ref = React.useRef<{ value: T; json: string } | null>(null);
  const json = JSON.stringify(value);
  if (!ref.current || ref.current.json !== json) ref.current = { value, json };
  return ref.current.value;
}

function useDeferred(ready: boolean, delayMs = 200): boolean {
  const [armed, setArmed] = React.useState(ready);
  if (ready && !armed) setArmed(true);
  React.useEffect(() => {
    if (armed) return;
    const t = setTimeout(() => setArmed(true), delayMs);
    return () => clearTimeout(t);
  }, [armed, delayMs]);
  return armed;
}

/**
 * Holds a page doc open while mounted, opened through `pageDocQueue` (nearest the current page first). The queue moves
 * on once this page has drawn (`drawn()`) or 400 ms after its doc loaded. A doc still in memory opens right away.
 */
function usePageDoc(docId: string | null, priority: number): { h: DocHandle | null; drawn(): void } {
  const { dm } = useSession();
  const [h, setH] = React.useState<DocHandle | null>(null);
  const done = React.useRef<() => void>(() => undefined);
  const prio = React.useRef(priority);
  prio.current = priority;
  React.useEffect(() => {
    if (!docId) return;
    let alive = true;
    let handle: DocHandle | null = null;
    const open = (finish: () => void) =>
      openLoaded(dm, docId).then(
        (x) => {
          if (!alive) {
            x.release();
            return finish();
          }
          handle = x;
          setH(x);
          setTimeout(finish, 400);
        },
        () => finish(),
      );
    let cancel = () => undefined as void;
    if (dm.has(docId)) void open(() => undefined);
    else {
      const job = pageDocQueue.request(
        () =>
          new Promise<void>((resolve) => {
            done.current = resolve;
            void open(resolve);
          }),
        prio.current,
      );
      cancel = job.cancel;
    }
    return () => {
      alive = false;
      cancel();
      done.current();
      done.current = () => undefined;
      setH(null);
      handle?.release();
    };
  }, [dm, docId]);
  return React.useMemo(() => ({ h, drawn: () => done.current() }), [h]);
}

/**
 * The ids PageCanvas has actually drawn (its `onDrawn`), newest 64. Kept outside PageView's state so a report only
 * re-renders the overlay, not the whole page.
 */
function createDrawnIds() {
  let ids: string[] = [];
  const subs = new Set<() => void>();
  return {
    get: () => ids,
    set: (all: string[]) => {
      const next = all.slice(-64);
      if (next.length === ids.length && next.every((id, i) => id === ids[i])) return; // e.g. a selection drag
      ids = next;
      subs.forEach((f) => f());
    },
    subscribe: (f: () => void) => {
      subs.add(f);
      return () => void subs.delete(f);
    },
    /** Hands a stroke that never reaches the page (a scribble that erased) back to the overlay: it drops it now. */
    dismiss: (id: string) => {
      ids = [...ids.slice(-63), id];
      subs.forEach((f) => f());
    },
  };
}
type DrawnIds = ReturnType<typeof createDrawnIds>;

/** The overlay keeps drawing a finished stroke until PageCanvas reports it drawn (tech-spec §3, hand-off). */
function HandoffInkOverlay({ drawn, ...props }: Omit<InkOverlayProps, 'committedIds'> & { drawn: DrawnIds }) {
  const committedIds = React.useSyncExternalStore(drawn.subscribe, drawn.get);
  return <InkOverlay {...props} committedIds={committedIds} />;
}

export interface PageViewProps {
  info: PageInfo;
  index: number;
  /** px */
  width: number;
  zoom: number;
  /** In the viewport (not just mounted ahead of the scroll). */
  visible?: boolean;
  /** Load order: 0 for the current page, then by distance from it. */
  priority?: number;
}

/** Memoised: scrolling and live zoom re-render the editor, not the pages (they change only with their props). */
export const PageView = React.memo(function PageView({ info, index, width, zoom, visible = true, priority = 0 }: PageViewProps) {
  const ed = useEditor();
  const armed = useDeferred(visible);
  const { h, drawn: pageDrawn } = usePageDoc(armed ? docIds.page(ed.notebookId, info.id) : null, priority);
  const page = React.useMemo(() => (h ? new Page(h.doc) : null), [h]);
  const sub = React.useMemo(() => (page ? (cb: () => void) => page.observe(cb) : null), [page]);
  const v = useVersion(sub);
  const items = React.useMemo(() => page?.items() ?? [], [page, v]);
  // Same arrays until their content changes: a stroke changes neither.
  const readings = useSameJson(React.useMemo(() => page?.readings() ?? [], [page, v]));
  const comments = useSameJson(React.useMemo(() => page?.comments() ?? [], [page, v]));
  const scale = width / info.size.w;
  const height = Math.round(info.size.h * scale);

  // Undo manager while the page is mounted.
  React.useEffect(() => {
    if (!page) return;
    ed.undoManagerFor(info.id, page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, info.id]);

  // Comments and readings for the comments panel. Items only matter to the editor for comment cards (which follow
  // their ink) and the selection: reporting every stroke on other pages re-rendered the whole editor per stroke.
  const itemsMatter = comments.length > 0 || ed.selection?.pageId === info.id;
  const reportedItems = itemsMatter ? items : null;
  React.useEffect(() => {
    if (!page) return;
    ed.reportPage(info.id, { page, index, readings, comments, items });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, readings, comments, reportedItems, index]);
  React.useEffect(() => () => ed.reportPage(info.id, null), [info.id]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useEffect(() => {
    if (page) mark('qalm:doc-loaded', { index });
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps
  const pdf = usePdfBackground(info, width, zoom, visible);
  React.useEffect(() => {
    if (pdf) mark('qalm:pdf-ready', { index });
  }, [pdf]); // eslint-disable-line react-hooks/exhaustive-deps
  const imageIds = React.useMemo(() => items.filter((i) => i.type === 'image').map((i) => (i as { assetId: string }).assetId), [items]);
  const imageUris = useAssetUris(imageIds);

  // Selection: the frame and its live edit (drawn by PageCanvas with a transform until it is committed).
  const sel = ed.selection?.pageId === info.id ? ed.selection.ids : null;
  const [live, setLive] = React.useState<LiveEdit | null>(null);
  const selSet = React.useMemo(() => new Set(sel ?? []), [sel]);
  const selItems = React.useMemo(() => (sel ? items.filter((it) => selSet.has(it.id)) : []), [items, sel, selSet]);
  const editing = ed.editingText?.pageId === info.id ? ed.editingText.itemId : null;
  const draft = ed.editingText?.pageId === info.id ? ed.editingText.draft : undefined;
  // Partial erase: the gesture so far, kept here (nothing is written until the pen lifts); the page shows it.
  const eraseRef = React.useRef<EraseSession | null>(null);
  const [eraseTick, setEraseTick] = React.useState(0);
  const shown = React.useMemo(() => {
    let out: Item[] = eraseRef.current ? eraseRef.current.view(items) : items;
    if (live?.kind === 'text') out = out.map((it) => (it.id === live.id ? ({ ...it, ...live.patch } as Item) : it));
    if (editing) out = out.filter((it) => it.id !== editing);
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, live, editing, eraseTick]);
  const liveCanvas = React.useMemo(() => (live?.kind === 'sim' && sel ? { ids: sel, transform: live.sim } : undefined), [live, sel]);

  const drawn = React.useMemo(createDrawnIds, []);
  // Ink a scribble just deleted, fading out where it was.
  const [fading, setFading] = React.useState<Fading[]>([]);
  const fadeKey = React.useRef(0);
  // Partial erase: committed once when the pen lifts (the overlay's last onErase), or soon after the last segment if that
  // never comes (a cancelled touch), or when the page goes away.
  const commitTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const pageRef = React.useRef(page);
  pageRef.current = page;
  const commitNow = React.useCallback(() => {
    if (commitTimer.current) clearTimeout(commitTimer.current);
    commitTimer.current = null;
    const session = eraseRef.current;
    eraseRef.current = null;
    if (session && pageRef.current) commitErase(pageRef.current, session);
    setEraseTick((x) => x + 1);
  }, []);
  React.useEffect(() => () => commitNow(), [commitNow]);
  const fadeDone = React.useCallback((key: number) => setFading((f) => f.filter((x) => x.key !== key)), []);
  const rootRef = React.useRef<React.ComponentRef<typeof View>>(null);
  const lastTap = React.useRef<{ id: string; at: number } | null>(null);

  /** Commits a selection edit as one undo step (line assignment re-runs for moved ink, incrementally). */
  const commit = (edit: LiveEdit) => {
    if (!page || !sel) return;
    if (edit.kind === 'sim' && isIdentity(edit.sim)) return;
    ed.touchPage(info.id);
    mark('qalm:commit-start', { items: sel.length });
    if (edit.kind === 'text') page.updateItem(edit.id, edit.patch as Partial<TextItem>);
    // On the stored points: a stroke still being rubbed out (here or elsewhere) keeps its cut on the same ink.
    else page.transformItems(sel, edit.sim);
    mark('qalm:commit-end', { items: sel.length });
  };

  /** A tap at a page point while the lasso tool is on: select what's there (Shift/Ctrl/Cmd: add or remove it). */
  const tapSelect = (x: number, y: number, insideFrame: boolean) => {
    if (!page) return;
    const all = page.items();
    const hit = hitTestPoint(all, { x, y }, TAP_TOLERANCE_PX / scale);
    const add = isAdditive();
    const cur = ed.selection?.pageId === info.id ? ed.selection.ids : [];
    const now = Date.now();
    const again = hit && lastTap.current?.id === hit && now - lastTap.current.at < DOUBLE_TAP_MS;
    lastTap.current = hit ? { id: hit, at: now } : null;
    const it = hit ? all.find((i) => i.id === hit) : undefined;
    if (it?.type === 'text' && again && !add) {
      // Double-tap a text box: edit it in place.
      ed.setSelection(null);
      ed.setEditingText({ pageId: info.id, itemId: it.id });
      return;
    }
    if (!hit) {
      if (!insideFrame && !add) ed.setSelection(null);
      return;
    }
    if (add) {
      const next = cur.includes(hit) ? cur.filter((id) => id !== hit) : [...cur, hit];
      ed.setSelection(next.length ? { pageId: info.id, ids: next } : null);
    } else if (!(insideFrame && cur.includes(hit))) ed.setSelection({ pageId: info.id, ids: [hit] });
  };

  const toPage = (wx: number, wy: number, fn: (x: number, y: number) => void) =>
    rootRef.current?.measureInWindow((x, y) => fn((wx - x) / scale, (wy - y) / scale));

  // A Markdown box's height changes as its maths fills in (MathJax loaded on demand, or a deferred time slice): pins on
  // it move with it.
  const mathFill = useMathFill(React.useMemo(() => items.some((it) => it.type === 'text' && rendersMarkdown(it)), [items]));
  const anchors = React.useMemo(
    () => (ed.showComments ? commentAnchors(comments, ed.activeCommentId, items) : []),
    [comments, ed.activeCommentId, items, ed.showComments, mathFill], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const assetUri = React.useCallback((id: string) => imageUris.get(id), [imageUris]);
  const onDrawn = React.useCallback(
    (ids: string[], complete: boolean) => {
      drawn.set(ids);
      if (complete) {
        mark('qalm:page-drawn', { index, items: ids.length });
        pageDrawn();
      } else if (ids.length) mark('qalm:page-partial', { index, items: ids.length });
    },
    [drawn, index, pageDrawn],
  );

  if (!page) return <View style={{ width, height, backgroundColor: info.paperColor === 'night' ? '#1f1f23' : info.paperColor === 'cream' ? '#fbf7ee' : '#ffffff' }} />;

  const t = ed.tools;
  const inkTool = t.tool === 'text' ? 'none' : t.tool;
  const nightInk = inkOnPaper(t.penColor, info.paperColor);

  const tapText = (x: number, y: number) => {
    // The tap that ended typing (its blur) doesn't also start a new box.
    if (Date.now() - textEndedAt < TEXT_END_MS) return;
    const hit = hitText(items, x, y);
    if (hit) {
      ed.setEditingText({ pageId: info.id, itemId: hit.id });
      return;
    }
    const id = newId();
    const item: TextItem = {
      id,
      type: 'text',
      x,
      y: y - DEFAULT_TEXT_SIZE * 0.65,
      w: Math.min(DEFAULT_TEXT_WIDTH, info.size.w - x - 12),
      text: '',
      fontSize: DEFAULT_TEXT_SIZE,
      color: nightInk,
      // New boxes render Markdown; older ones (no `format`) stay plain text.
      format: 'md',
    };
    // Not on the page yet: the first character adds it (an abandoned empty box never exists).
    ed.setEditingText({ pageId: info.id, itemId: id, draft: item });
  };

  return (
    <View ref={rootRef} style={{ width, height }}>
      <PageCanvas
        info={info}
        items={shown}
        width={width}
        live={liveCanvas}
        anchors={anchors}
        pdfImage={pdf}
        assetUri={assetUri}
        onDrawn={onDrawn}
      />
      <HandoffInkOverlay
        drawn={drawn}
        pageSize={info.size}
        tool={inkTool}
        color={t.tool === 'highlighter' ? t.hlColor : nightInk}
        width={t.tool === 'highlighter' ? t.hlWidth : t.tool === 'eraser' ? t.eraserRadius * 2 : t.penWidth}
        penStyle={t.penStyle}
        smoothing={smoothingLevel(ed.input.smoothing)}
        input={ed.input}
        // Live shapes: hold the pen still and the stroke snaps under it; drag to adjust, lift to place.
        recognizeShape={t.snapShapes && t.tool === 'pen' ? liveShape : undefined}
        adjustShape={adjustLiveShape}
        onPenSeen={ed.onPenSeen}
        onStrokeEnd={({ nativeEvent: e }) => {
          ed.touchPage(info.id);
          // Scribble to erase: a quick zig-zag over ink deletes it (one undo step) and is not kept.
          // Not a stroke ruled along the ruler (back and forth along it would look like a scribble).
          if (e.tool === 'pen' && !e.shape && !e.ruler && ed.input.scribbleErase) {
            const gone = scribbleErase(page, e.points, e.width);
            if (gone) {
              drawn.dismiss(e.id);
              setFading((f) => [...f, { key: ++fadeKey.current, items: gone }]);
              return;
            }
          }
          const stroke = makeStroke(e);
          if (e.shape && t.snapShapes && e.tool === 'pen') commitSnapped(page, stroke, e.shape);
          else page.addItem(stroke);
        }}
        onErase={({ nativeEvent: e }) => {
          if (t.eraserMode === 'partial') {
            const session = (eraseRef.current ??= new EraseSession(newId));
            if (eraseAlong(page, ed.undo, e.path, t.eraserRadius, 'partial', newId, session)) {
              ed.touchPage(info.id);
              setEraseTick((x) => x + 1); // shows the gesture so far
            }
            if (e.final) commitNow();
            else {
              if (commitTimer.current) clearTimeout(commitTimer.current);
              commitTimer.current = setTimeout(commitNow, COMMIT_AFTER_MS);
            }
          } else if (eraseAlong(page, ed.undo, e.path, t.eraserRadius, t.eraserMode, newId)) ed.touchPage(info.id);
        }}
        lassoMode={t.lassoMode}
        eraserMode={t.eraserMode}
        laserMode={t.laserMode}
        // The ruler (window coordinates): a pen stroke starting near its edge follows it.
        ruler={ed.ruler}
        getRuler={ed.getRuler}
        onLasso={({ nativeEvent: e }) => {
          const pts = e.polygon;
          const last = pts[pts.length - 1];
          if (!last) return;
          const [x0, y0, x1, y1] = pointsBBox(pts);
          if (Math.max(x1 - x0, y1 - y0) * scale < TAP_SLOP_PX) return tapSelect(last.x, last.y, false);
          const all = page.items();
          const ids = t.lassoMode === 'rect' ? boxSelect(all, pts[0]!, last) : lassoSelect(all, pts);
          const cur = isAdditive() && ed.selection?.pageId === info.id ? ed.selection.ids : [];
          const next = [...new Set([...cur, ...ids])];
          ed.setSelection(next.length ? { pageId: info.id, ids: next } : null);
        }}
        onPenButton={() => ed.onPenButton()}
      />
      <EraseFade fading={fading} size={info.size} onDone={fadeDone} />
      {t.tool === 'text' ? (
        <Pressable
          accessibilityLabel={`Add text on page ${index + 1}`}
          style={StyleSheet.absoluteFill}
          onPress={(e) => {
            // locationX/Y are relative to whatever child was hit (unreliable on web); measure the page instead.
            const { pageX, pageY } = e.nativeEvent;
            rootRef.current?.measureInWindow((x, y) => tapText((pageX - x) / scale, (pageY - y) / scale));
          }}
        />
      ) : null}
      {selItems.length && t.tool === 'lasso' ? (
        <SelectionFrame
          items={selItems}
          scale={scale}
          live={live}
          onLive={setLive}
          onCommit={commit}
          onTap={(wx, wy) => toPage(wx, wy, (x, y) => tapSelect(x, y, true))}
          night={info.paperColor === 'night'}
        />
      ) : null}
      {anchors.map((a) => {
        const c = comments.find((x) => x.id === a.id);
        return c ? (
          <Pressable
            key={a.id}
            accessibilityLabel={`Comment from ${c.author.name}`}
            onPress={() => ed.setActiveComment(c.id)}
            style={{ position: 'absolute', left: (a.bbox[2] + 9) * scale - 22, top: (a.bbox[1] + 5) * scale - 22, width: 44, height: 44 }}
          />
        ) : null;
      })}
      {editing ? (
        <TextEditor
          key={editing}
          page={page}
          itemId={editing}
          draft={draft}
          scale={scale}
          night={info.paperColor === 'night'}
          onDone={() => {
            textEndedAt = Date.now();
            ed.setEditingText(null);
          }}
        />
      ) : null}
    </View>
  );
});


function TextEditor({ page, itemId, draft, scale, night, onDone }: { page: Page; itemId: string; draft?: TextItem; scale: number; night: boolean; onDone(): void }) {
  const ed = useEditor();
  const stored = page.item(itemId);
  const item = stored?.type === 'text' ? stored : draft;
  const [text, setText] = React.useState(item?.text ?? '');
  const input = React.useRef<React.ComponentRef<typeof TextInput>>(null);
  // The latest text and selection, for the format bar (it acts between renders).
  const latest = React.useRef(text);
  latest.current = text;
  const selection = React.useRef<Sel>({ start: text.length, end: text.length });
  const pendingSel = React.useRef<Sel | null>(null);
  // The format bar: Markdown around the selection, as one step with the typing (the box becomes Markdown).
  React.useEffect(() => {
    ed.textFormatter.current = (kind) => {
      // A box from before Markdown: its text is escaped first, so `price *5*` doesn't turn italic.
      const cur = page.item(itemId);
      const legacy = cur?.type === 'text' && cur.format !== 'md';
      const { text: v, sel } = applyFormatTo(latest.current, selection.current, kind, legacy);
      latest.current = v;
      setText(v);
      const isNew = !page.item(itemId);
      if (formatText(page, ed.undo, itemId, v, draft) && isNew && ed.editingText) ed.touchPage(ed.editingText.pageId);
      selection.current = sel;
      pendingSel.current = sel;
    };
    return () => {
      ed.textFormatter.current = null;
    };
  });
  // After a format, put the caret (or selection) back where the bar left it, and the focus in the box.
  React.useEffect(() => {
    const sel = pendingSel.current;
    if (!sel) return;
    pendingSel.current = null;
    const el = input.current as unknown as { focus?(): void; setSelectionRange?(a: number, b: number): void; setSelection?(a: number, b: number): void } | null;
    el?.focus?.();
    if (el?.setSelectionRange) el.setSelectionRange(sel.start, sel.end);
    else el?.setSelection?.(sel.start, sel.end);
  }, [text]);
  const dropIfEmpty = React.useCallback(() => void dropEmptyText(page, ed.undo, itemId), [page, ed.undo, itemId]);
  // Leaving mid-edit (back to the library, the page unmounting) still drops an emptied box.
  React.useEffect(() => dropIfEmpty, [dropIfEmpty]);
  if (!item) return null;
  const finish = () => {
    dropIfEmpty();
    onDone();
  };
  return (
    <TextInput
      ref={input}
      autoFocus
      multiline
      value={text}
      onChangeText={(v) => {
        latest.current = v;
        setText(v);
        // The first character adds a new box; it and the typing that follows are one undo step.
        const isNew = !page.item(itemId);
        if (typeText(page, ed.undo, itemId, v, draft) && isNew && ed.editingText) ed.touchPage(ed.editingText.pageId);
      }}
      onSelectionChange={(e) => {
        selection.current = e.nativeEvent.selection;
      }}
      onBlur={finish}
      // Escape finishes typing (web and hardware keyboards).
      onKeyPress={(e) => {
        if (e.nativeEvent.key === 'Escape') input.current?.blur();
      }}
      placeholder="Type here"
      placeholderTextColor={night ? '#71717a' : '#8b8b95'}
      style={[
        styles.textEditor,
        {
          borderColor: night ? PAPER_ACCENT.night.line : PAPER_ACCENT.light.line,
          left: item.x * scale - 4,
          top: item.y * scale - 4,
          width: item.w * scale + 8,
          minHeight: item.fontSize * TEXT_LINE_HEIGHT * scale + 8,
          // Grow with the text (a multiline input on web doesn't): the measured height, as the frame and canvas use.
          height: textHeight({ text: text || ' ', w: item.w, fontSize: item.fontSize }) * scale + 8 + item.fontSize * 0.3 * scale,
          fontSize: item.fontSize * scale,
          lineHeight: item.fontSize * TEXT_LINE_HEIGHT * scale,
          color: item.color,
        },
        // A turned text box is edited turned, about its top-left corner (the box sits 4 px out from it).
        item.rot ? { transform: [{ rotate: `${item.rot}rad` }], transformOrigin: '4px 4px' } : null,
        Platform.OS === 'web' && ({ outlineStyle: 'none' } as object),
      ]}
    />
  );
}

const styles = StyleSheet.create({
  textEditor: {
    position: 'absolute',
    padding: 3,
    borderWidth: 1,
    borderRadius: 4,
    fontFamily: font.regular,
    backgroundColor: 'transparent',
    textAlignVertical: 'top',
  },
});
