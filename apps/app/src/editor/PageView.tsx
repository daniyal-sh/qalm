import { boxSelect, hitTestErase, hitTestPoint, isIdentity, lassoSelect, LOCAL_ORIGIN, Page, snapShape, type Item, type PageInfo, type TextItem } from '@qalm/core';
import { InkOverlay, PageCanvas, QalmInk, type InkOverlayProps } from 'qalm-ink';
import * as React from 'react';
import { PixelRatio, Platform, Pressable, StyleSheet, TextInput, View } from 'react-native';

import { newId } from '../lib/id';
import { docIds } from '../sync/docs';
import { useDoc, useSession, useVersion } from '../state/session';
import { smoothingLevel } from '../theme/ThemeProvider';
import { font } from '../theme/tokens';
import { useEditor } from './context';
import { DEFAULT_TEXT_SIZE, DEFAULT_TEXT_WIDTH, hitText, makeStroke, pointsBBox, transformPatch } from './items';
import { isAdditive } from './modifiers';
import { SelectionFrame, type LiveEdit } from './SelectionFrame';
import { RecognitionScheduler } from './recognition';
import { commentAnchors, pdfBucketWidth } from './view';

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

function usePdfBackground(info: PageInfo, width: number, zoom: number): string | undefined {
  const bg = info.background;
  const assetId = bg.kind === 'pdf' ? bg.assetId : null;
  const uris = useAssetUris(assetId ? [assetId] : []);
  const fileUri = assetId ? uris.get(assetId) : undefined;
  const target = pdfBucketWidth(width, width / zoom, PixelRatio.get());
  const [png, setPng] = React.useState<string | undefined>();
  React.useEffect(() => {
    if (!fileUri || bg.kind !== 'pdf') return;
    let alive = true;
    QalmInk.renderPdfPage(fileUri, bg.pageIndex, target)
      .then((u) => alive && setPng(u))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [fileUri, bg.kind === 'pdf' ? bg.pageIndex : -1, target]);
  return png;
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
}

export function PageView({ info, index, width, zoom }: PageViewProps) {
  const ed = useEditor();
  const h = useDoc(docIds.page(ed.notebookId, info.id));
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

  const pdf = usePdfBackground(info, width, zoom);
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

  /** Commits a selection edit as one undo step (line assignment re-runs for moved ink). */
  const commit = (edit: LiveEdit) => {
    if (!page || !sel) return;
    if (edit.kind === 'sim' && isIdentity(edit.sim)) return;
    ed.touchPage(info.id);
    page.doc.transact(() => {
      if (edit.kind === 'text') page.updateItem(edit.id, edit.patch as Partial<TextItem>);
      else
        for (const id of sel) {
          const it = page.item(id);
          if (it) page.updateItem(id, transformPatch(it, edit.sim));
        }
    }, LOCAL_ORIGIN);
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

  if (!page) return <View style={{ width, height, backgroundColor: '#ffffff' }} />;

  const t = ed.tools;
  const inkTool = t.tool === 'text' ? 'none' : t.tool;
  const nightInk = info.paperColor === 'night' && t.penColor === '#27272a' ? '#e4e4e7' : t.penColor;
  const anchors = commentAnchors(lines, comments, ed.activeCommentId, items);

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
        assetUri={(id) => imageUris.get(id)}
        onDrawn={drawn.set}
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
}

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
