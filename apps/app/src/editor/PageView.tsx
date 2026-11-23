import { boxSelect, inkOnPaper, textHeight, hitTestErase, hitTestPoint, isIdentity, lassoSelect, Page, snapShape, type Item, type PageInfo, type TextItem } from '@qalm/core';
import { InkOverlay, PageCanvas, QalmInk, type InkOverlayProps } from 'qalm-ink';
import * as React from 'react';
import { PixelRatio, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { mark } from '../bench/hook';
import { newId } from '../lib/id';
import { docIds, openLoaded, type DocHandle } from '../sync/docs';
import { useSession, useVersion } from '../state/session';
import { smoothingLevel } from '../theme/ThemeProvider';
import { font } from '../theme/tokens';
import { useEditor } from './context';
import { DEFAULT_TEXT_SIZE, DEFAULT_TEXT_WIDTH, hitText, makeStroke, pointsBBox, transformPatch } from './items';
import { isAdditive } from './modifiers';
import { SelectionFrame, type LiveEdit } from './SelectionFrame';
import { RecognitionScheduler } from './recognition';
import { pageDocQueue, pdfQueue } from './renderQueue';
import { commentAnchors, pdfRenderWidth } from './view';

const ACCENT = '#4338ca';
/** A lasso that moved less than this (px) is a tap. */
const TAP_SLOP_PX = 6;
/** A tap selects the nearest item within this many px. */
const TAP_TOLERANCE_PX = 10;
const DOUBLE_TAP_MS = 450;

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
  const lines = React.useMemo(() => page?.lines() ?? [], [page, v]);
  const comments = React.useMemo(() => page?.comments() ?? [], [page, v]);
  const scale = width / info.size.w;
  const height = Math.round(info.size.h * scale);

  // Undo manager and on-device recognition while the page is mounted.
  React.useEffect(() => {
    if (!page) return;
    ed.undoManagerFor(info.id, page);
    const rec = new RecognitionScheduler(page, (lines, lang) => QalmInk.recognize(lines, lang));
    return rec.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, info.id]);

  // Comments and lines for the comments panel.
  React.useEffect(() => {
    if (!page) return;
    ed.reportPage(info.id, { page, index, lines, comments, items });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, lines, comments, items, index]);
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
  const shown = React.useMemo(() => {
    let out: Item[] = items;
    if (live?.kind === 'text') out = out.map((it) => (it.id === live.id ? ({ ...it, ...live.patch } as Item) : it));
    if (editing) out = out.filter((it) => it.id !== editing);
    return out;
  }, [items, live, editing]);
  const liveCanvas = React.useMemo(() => (live?.kind === 'sim' && sel ? { ids: sel, transform: live.sim } : undefined), [live, sel]);

  const drawn = React.useMemo(createDrawnIds, []);
  const rootRef = React.useRef<React.ComponentRef<typeof View>>(null);
  const lastTap = React.useRef<{ id: string; at: number } | null>(null);

  /** Commits a selection edit as one undo step (line assignment re-runs for moved ink, incrementally). */
  const commit = (edit: LiveEdit) => {
    if (!page || !sel) return;
    if (edit.kind === 'sim' && isIdentity(edit.sim)) return;
    ed.touchPage(info.id);
    mark('qalm:commit-start', { items: sel.length });
    if (edit.kind === 'text') page.updateItem(edit.id, edit.patch as Partial<TextItem>);
    else
      page.updateItems(
        sel.flatMap((id) => {
          const it = page.item(id);
          return it ? [[id, transformPatch(it, edit.sim)] as const] : [];
        }),
      );
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

  const anchors = React.useMemo(() => commentAnchors(lines, comments, ed.activeCommentId, items), [lines, comments, ed.activeCommentId, items]);
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
    };
    page.addItem(item);
    ed.touchPage(info.id);
    ed.setEditingText({ pageId: info.id, itemId: id });
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
        onStrokeEnd={({ nativeEvent: e }) => {
          ed.touchPage(info.id);
          const shape = t.snapShapes && e.tool === 'pen' ? snapShape(e.points, e.heldMs) : null;
          // A snapped shape takes the stroke's id, so the overlay hands it off without flicker.
          if (shape) page.addItem({ ...shape, id: e.id, color: e.color, width: e.width });
          else page.addItem(makeStroke(e));
        }}
        onErase={({ nativeEvent: e }) => {
          const ids = hitTestErase(page.items(), e.path, t.eraserRadius);
          if (ids.length) ed.undo.merging('erase', () => page.removeItems(ids));
        }}
        lassoMode={t.lassoMode}
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
        />
      ) : null}
      {anchors.map((a) => {
        const c = comments.find((x) => x.id === a.lineKey) ?? comments.find((x) => x.lineKey === a.lineKey && !x.anchor && !x.anchorIds?.length && !x.resolved) ?? comments.find((x) => x.lineKey === a.lineKey);
        return c ? (
          <Pressable
            key={a.lineKey}
            accessibilityLabel={`Comment from ${c.author.name}`}
            onPress={() => ed.setActiveComment(c.id)}
            style={{ position: 'absolute', left: (a.bbox[2] + 9) * scale - 14, top: (a.bbox[1] + 5) * scale - 14, width: 28, height: 28 }}
          />
        ) : null;
      })}
      {editing ? <TextEditor page={page} itemId={editing} scale={scale} onDone={() => ed.setEditingText(null)} /> : null}
    </View>
  );
});


function TextEditor({ page, itemId, scale, onDone }: { page: Page; itemId: string; scale: number; onDone(): void }) {
  const ed = useEditor();
  const item = page.item(itemId);
  const [text, setText] = React.useState(item?.type === 'text' ? item.text : '');
  if (!item || item.type !== 'text') return null;
  const finish = () => {
    if (!text.trim()) page.removeItems([itemId]);
    onDone();
  };
  return (
    <TextInput
      autoFocus
      multiline
      value={text}
      onChangeText={(v) => {
        setText(v);
        ed.undo.merging(`text:${itemId}`, () => page.updateItem(itemId, { text: v } as Partial<TextItem>), 2000);
      }}
      onBlur={finish}
      placeholder="Type here"
      placeholderTextColor="#8b8b95"
      style={[
        styles.textEditor,
        {
          left: item.x * scale - 4,
          top: item.y * scale - 4,
          width: item.w * scale + 8,
          minHeight: item.fontSize * 1.3 * scale + 8,
          // Grow with the text (a multiline input on web doesn't): the same wrapping estimate as the selection frame.
          height: textHeight({ text: text || ' ', w: item.w, fontSize: item.fontSize }) * scale + 8 + item.fontSize * 0.3 * scale,
          fontSize: item.fontSize * scale,
          lineHeight: item.fontSize * 1.3 * scale,
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
    borderColor: ACCENT,
    borderRadius: 4,
    fontFamily: font.regular,
    backgroundColor: 'transparent',
    textAlignVertical: 'top',
  },
});
