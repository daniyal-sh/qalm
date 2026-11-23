import type { BBox, ImageItem, Item, PageInfo, ShapeItem, TextItem } from '@qalm/core';
import { inkPaint, itemBBox, paperPattern, shapePolylines, strokeOutline } from '@qalm/core';
import {
  BlendMode,
  Canvas,
  Circle,
  DashPathEffect,
  Group,
  Image,
  PaintStyle,
  Paragraph,
  Path,
  Picture,
  Rect,
  RoundedRect,
  Skia,
  StrokeCap,
  StrokeJoin,
  useFonts,
  type SkPaint,
  type SkPath,
  type SkPicture,
  type SkRect,
  type SkTypefaceFontProvider,
} from '@shopify/react-native-skia';
import * as React from 'react';

import figtree from '../assets/fonts/Figtree-Regular.ttf';
import notoMath from '../assets/fonts/NotoSansMath-Subset.ttf';
import { disposeLater } from './dispose';
import { provideTextFonts, textParagraph } from './textMetrics';
import { INK_CHUNK, inkGeometryKey, inkRuns, sameItems, type InkItem, type Run } from './inkRuns';
import { traceOutline } from './outlinePath';
import { usePageImage } from './usePageImage';

export interface CommentAnchor {
  lineKey: string;
  bbox: BBox;
  active: boolean;
}

export interface PageCanvasProps {
  info: PageInfo;
  items: Item[];
  selection?: string[];
  anchors?: CommentAnchor[];
  /** PDF background image uri (from QalmInk.renderPdfPage) */
  pdfImage?: string;
  /** px; height follows the page's aspect ratio */
  width: number;
  /** Resolves an ImageItem's assetId to a loadable uri. Images without one are skipped. */
  assetUri?: (assetId: string) => string | undefined;
  /**
   * Called with the item ids in z-order once Skia has committed them, i.e. its new picture has been handed to the
   * view. Feed the newest ones to InkOverlay's `committedIds` so the live stroke stays until Skia shows it. `complete` is
   * false while a page's ink is still being built over a few frames (only ids already drawn are listed).
   */
  onDrawn?: (ids: string[], complete: boolean) => void;
  /**
   * Draws these items moved / scaled / turned while a selection is being dragged, without rebuilding their paths:
   * p' = o + s·R(r)·(p − o) + d (the same as core's `Sim`).
   */
  live?: { ids: string[]; transform: LiveTransform };
}

export interface LiveTransform {
  s: number;
  r: number;
  ox: number;
  oy: number;
  dx: number;
  dy: number;
}

// Brand tokens (docs/brand.md). Paper stays light, so the light tokens apply except on night paper.
const ACCENT = '#4338ca';
const ANCHOR = {
  light: { pin: '#1d4ed8', soft: '#ebf0fc', line: '#bfcdf4' },
  night: { pin: '#60a5fa', soft: '#1d2a3d', line: '#2f4b72' },
};
const PAPER_LINE_WIDTH = 0.5; // page units
const PAPER_DOT_RADIUS = 0.8;
const PIN_RADIUS = 5;

function outlineToPath(outline: [number, number][]): SkPath {
  const b = Skia.PathBuilder.Make();
  traceOutline(outline, b);
  return b.detach();
}

function shapePath(s: ShapeItem): SkPath {
  const b = Skia.PathBuilder.Make();
  const pts = s.pts;
  if (!pts[0]) return b.detach();
  if (s.kind === 'ellipse' && pts.length === 2) {
    // Older upright ellipses: their box.
    const a = pts[0];
    const c = pts[1] ?? a;
    b.addOval(Skia.XYWHRect(Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.abs(c[0] - a[0]), Math.abs(c[1] - a[1])));
    return b.detach();
  }
  // Same outlines as the PDF and SVG export (core's shapePolylines), so turned shapes draw alike everywhere.
  for (const pl of shapePolylines(s)) {
    pl.forEach(([x, y], i) => (i ? b.lineTo(x, y) : b.moveTo(x, y)));
    const first = pl[0];
    const last = pl[pl.length - 1];
    if (pl.length > 2 && first && last && first[0] === last[0] && first[1] === last[1]) b.close();
  }
  return b.detach();
}

/** Turns a text box or image about its top-left corner (`rot`, radians). */
function turned(x: number, y: number, rot: number | undefined) {
  return rot ? [{ translateX: x }, { translateY: y }, { rotate: rot }, { translateX: -x }, { translateY: -y }] : undefined;
}

/** A live selection transform (move, scale, rotate about an origin), as Skia transforms. */
function liveTransform(f: LiveTransform) {
  return [
    { translateX: f.ox + f.dx },
    { translateY: f.oy + f.dy },
    { rotate: f.r },
    { scale: f.s },
    { translateX: -f.ox },
    { translateY: -f.oy },
  ];
}

/** The Skia paint for an ink item: colour and alpha from core's `inkPaint` (a `#rrggbbaa` highlighter carries its own alpha). */
function skiaInkPaint(it: InkItem): SkPaint {
  const p = Skia.Paint();
  p.setAntiAlias(true);
  const c = inkPaint(it.type === 'stroke' ? it.tool : 'pen', it.color);
  p.setColor(Skia.Color(c.rgb));
  if (it.type === 'stroke') {
    if (it.tool === 'highlighter') {
      p.setAlphaf(c.alpha);
      p.setBlendMode(BlendMode.Multiply);
    }
  } else {
    p.setStyle(PaintStyle.Stroke);
    p.setStrokeWidth(it.width);
    p.setStrokeCap(StrokeCap.Round);
    p.setStrokeJoin(StrokeJoin.Round);
  }
  return p;
}

const paintKey = (it: InkItem) => (it.type === 'stroke' ? `s|${it.tool}|${it.color}` : `h|${it.color}|${it.width}`);

interface InkCache {
  paths: Map<string, { key: string; path: SkPath }>;
  pictures: Map<string, { items: InkItem[]; picture: SkPicture }>;
}

/**
 * Ink (strokes and shapes) is drawn from recorded pictures, one per chunk of up to 256 consecutive ink items, so a page
 * with thousands of strokes is a handful of Skia nodes instead of one React element per stroke. Zooming only changes
 * the group's scale; adding a stroke re-records only the last chunk; a path is rebuilt only when its item's geometry
 * changes. Replaced paths and pictures are freed (CanvasKit objects are never garbage-collected on web).
 *
 * Building paths for a page seen for the first time is spread over 8 ms slices in the background (newest chunk
 * first), so mounting a page with thousands of strokes while scrolling never blocks the main thread for long.
 */
const FRAME_BUDGET_MS = 8;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

interface Ink {
  runs: Run[];
  pictures: Map<string, SkPicture>;
  /** Ids of items drawn as they are now (all non-ink items, and ink in up-to-date chunks). */
  drawnIds: string[];
  complete: boolean;
  /** Ink items still without a path (newest first), built in the background. */
  pending: InkItem[];
}

/** `live`: ids of a selection being dragged; their ink is recorded in chunks of its own, drawn inside the live transform. */
function useInk(items: Item[], bounds: SkRect, live: ReadonlySet<string> | null): Ink {
  const cache = React.useRef<InkCache>({ paths: new Map(), pictures: new Map() });
  const [pass, setPass] = React.useState(0);
  const result = React.useMemo((): Ink => {
    const t0 = now();
    const prev = cache.current;
    const next: InkCache = { paths: new Map(), pictures: new Map() };
    const runs = inkRuns(items, INK_CHUNK, live);
    const pathOf = (it: InkItem): SkPath => {
      const key = inkGeometryKey(it);
      const hit = next.paths.get(it.id) ?? prev.paths.get(it.id);
      const entry = hit && hit.key === key ? hit : { key, path: it.type === 'stroke' ? outlineToPath(strokeOutline(it)) : shapePath(it) };
      next.paths.set(it.id, entry);
      return entry.path;
    };
    const current = new Set<string>();
    let complete = true;
    const pending: InkItem[] = [];
    let built = 0;
    // Newest chunks first: the stroke just written is in the last one.
    for (let r = runs.length - 1; r >= 0; r--) {
      const run = runs[r]!;
      if (run.kind !== 'ink') continue;
      const old = prev.pictures.get(run.key);
      if (old && sameItems(old.items, run.items)) {
        for (const it of run.items) if (prev.paths.has(it.id)) next.paths.set(it.id, prev.paths.get(it.id)!);
        next.pictures.set(run.key, old);
        current.add(run.key);
        continue;
      }
      // Build the chunk's missing paths within the time slice; record it once they are all there.
      let ready = true;
      for (const it of run.items) {
        const hit = next.paths.get(it.id) ?? prev.paths.get(it.id);
        if (hit && hit.key === inkGeometryKey(it)) {
          next.paths.set(it.id, hit);
          continue;
        }
        if (!ready || (built > 0 && now() - t0 > FRAME_BUDGET_MS)) {
          ready = false;
          if (hit) next.paths.set(it.id, hit);
          pending.push(it);
          continue;
        }
        pathOf(it);
        built++;
      }
      if (!ready) {
        // Out of time: keep showing the chunk's previous picture (if any); the rest is built in the background.
        complete = false;
        if (old) next.pictures.set(run.key, old);
        continue;
      }
      const rec = Skia.PictureRecorder();
      const canvas = rec.beginRecording(bounds);
      const paints = new Map<string, SkPaint>();
      for (const it of run.items) {
        const k = paintKey(it);
        let paint = paints.get(k);
        if (!paint) paints.set(k, (paint = skiaInkPaint(it)));
        canvas.drawPath(pathOf(it), paint);
      }
      next.pictures.set(run.key, { items: run.items, picture: rec.finishRecordingAsPicture() });
      current.add(run.key);
      disposeLater(...paints.values(), rec);
    }
    for (const [id, e] of prev.paths) if (next.paths.get(id) !== e) disposeLater(e.path);
    for (const [key, e] of prev.pictures) if (next.pictures.get(key) !== e) disposeLater(e.picture);
    cache.current = next;
    const drawnIds: string[] = [];
    for (const run of runs) {
      if (run.kind === 'item') drawnIds.push(run.item.id);
      else if (current.has(run.key)) for (const it of run.items) drawnIds.push(it.id);
    }
    return { runs, pictures: new Map([...next.pictures].map(([k, v]) => [k, v.picture])), drawnIds, complete, pending };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, pass, live]);
  React.useEffect(() => {
    if (result.complete) return;
    // Build the remaining paths in 8 ms slices without re-rendering (each Skia redraw of a heavy page is costly), and
    // show progress about every 120 ms.
    let i = 0;
    let shown = now();
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      const t0 = now();
      const paths = cache.current.paths;
      while (i < result.pending.length && now() - t0 < FRAME_BUDGET_MS) {
        const it = result.pending[i++]!;
        const key = inkGeometryKey(it);
        const hit = paths.get(it.id);
        if (hit && hit.key === key) continue;
        if (hit) disposeLater(hit.path);
        paths.set(it.id, { key, path: it.type === 'stroke' ? outlineToPath(strokeOutline(it)) : shapePath(it) });
      }
      if (i >= result.pending.length || now() - shown > 120) {
        shown = now();
        setPass((p) => p + 1);
        if (i >= result.pending.length) return;
      }
      timer = setTimeout(step, 0);
    };
    timer = setTimeout(step, 0);
    return () => clearTimeout(timer);
  }, [result]);
  // Free everything once the page unmounts (not on StrictMode's immediate re-mount).
  const mounted = React.useRef(true);
  React.useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      setTimeout(() => {
        if (mounted.current) return;
        const c = cache.current;
        disposeLater(...[...c.paths.values()].map((e) => e.path), ...[...c.pictures.values()].map((e) => e.picture));
        cache.current = { paths: new Map(), pictures: new Map() };
      }, 0);
    };
  }, []);
  return result;
}

/**
 * Rendered inside <Canvas>, so its effect runs when Skia's own reconciler commits (after the new recording has been
 * dispatched to the view), not when React commits PageCanvas: on web that is often several frames later.
 */
function DrawnProbe({ ink, onDrawn }: { ink: Ink; onDrawn?: (ids: string[], complete: boolean) => void }) {
  const cb = React.useRef(onDrawn);
  cb.current = onDrawn;
  React.useEffect(() => {
    cb.current?.(ink.drawnIds, ink.complete);
  }, [ink]);
  return null;
}

function TextNode({ item, fonts }: { item: TextItem; fonts: SkTypefaceFontProvider }) {
  const paragraph = React.useMemo(() => textParagraph(item, fonts), [item.color, item.fontSize, item.text, item.w, fonts]); // eslint-disable-line react-hooks/exhaustive-deps
  const t = turned(item.x, item.y, item.rot);
  const node = <Paragraph paragraph={paragraph} x={item.x} y={item.y} width={item.w} />;
  return t ? <Group transform={t}>{node}</Group> : node;
}

function ImageNode({ item, uri }: { item: ImageItem; uri: string }) {
  const image = usePageImage(uri);
  if (!image) return null;
  const node = <Image image={image} x={item.x} y={item.y} width={item.w} height={item.h} fit="fill" />;
  const t = turned(item.x, item.y, item.rot);
  return t ? <Group transform={t}>{node}</Group> : node;
}

/**
 * The one renderer for finished page content (tech-spec §3): paper, PDF background, items in z-order,
 * selection outline and comment anchors. Runs on iOS/Android (Skia) and web/Electron (CanvasKit).
 */
export const PageCanvas = React.memo(function PageCanvas({ info, items, selection, anchors, pdfImage, width, assetUri, onDrawn, live }: PageCanvasProps) {
  const { w: pageW, h: pageH } = info.size;
  const scale = width / pageW;
  const height = Math.round(pageH * scale);
  // Figtree, falling back to Noto Sans Math (maths symbols and Greek): see `TEXT_FONTS`.
  const fonts = useFonts({ Figtree: [figtree], NotoSansMath: [notoMath] });
  // Text boxes' heights (frames, hit boxes) are measured with this font once it has loaded.
  if (fonts) provideTextFonts(fonts);
  const pdf = usePageImage(pdfImage);
  const bounds = React.useMemo(() => Skia.XYWHRect(-pageW, -pageH, pageW * 3, pageH * 3), [pageW, pageH]);
  const liveIds = React.useMemo(() => (live?.ids.length ? new Set(live.ids) : null), [live?.ids]);
  const liveMatrix = live ? liveTransform(live.transform) : undefined;
  const ink = useInk(items, bounds, liveIds);

  const paper = React.useMemo(() => {
    const pattern = paperPattern(info.paper, info.paperColor, info.size);
    const lines = Skia.PathBuilder.Make();
    for (const [x0, y0, x1, y1] of pattern.lines) lines.moveTo(x0, y0).lineTo(x1, y1);
    const dots = Skia.PathBuilder.Make();
    for (const [x, y] of pattern.dots) dots.addCircle(x, y, PAPER_DOT_RADIUS);
    return { bg: pattern.bg, stroke: pattern.stroke, lines: lines.detach(), dots: dots.detach() };
  }, [info.paper, info.paperColor, info.size]);

  const anchorColors = info.paperColor === 'night' ? ANCHOR.night : ANCHOR.light;
  const hairline = 1 / scale; // 1 px in page units

  const selectionBox = React.useMemo(() => {
    if (!selection?.length) return null;
    const ids = new Set(selection);
    let box: BBox | null = null;
    for (const it of items) {
      if (!ids.has(it.id)) continue;
      const b = itemBBox(it);
      box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])] : b;
    }
    return box;
  }, [items, selection]);

  return (
    <Canvas style={{ width, height }}>
      <Group transform={[{ scale }]}>
        <Rect x={0} y={0} width={pageW} height={pageH} color={paper.bg} />
        {pdf ? <Image image={pdf} x={0} y={0} width={pageW} height={pageH} fit="fill" /> : null}
        <Path path={paper.lines} color={paper.stroke} style="stroke" strokeWidth={PAPER_LINE_WIDTH} />
        <Path path={paper.dots} color={paper.stroke} />

        {anchors?.filter((a) => a.active).map((a) => {
          const r = { x: a.bbox[0] - 3, y: a.bbox[1] - 3, width: a.bbox[2] - a.bbox[0] + 6, height: a.bbox[3] - a.bbox[1] + 6, r: 4 };
          return (
            <Group key={`hl-${a.lineKey}`}>
              <RoundedRect {...r} color={anchorColors.soft} />
              <RoundedRect {...r} color={anchorColors.line} style="stroke" strokeWidth={hairline} />
            </Group>
          );
        })}

        {ink.runs.map((run) => {
          if (run.kind === 'ink') {
            const picture = ink.pictures.get(run.key);
            if (!picture) return null;
            return run.live ? (
              <Group key={run.key} transform={liveMatrix}>
                <Picture picture={picture} />
              </Group>
            ) : (
              <Picture key={run.key} picture={picture} />
            );
          }
          const it = run.item;
          let node: React.ReactElement | null = null;
          if (it.type === 'text') node = fonts ? <TextNode key={it.id} item={it} fonts={fonts} /> : null;
          else {
            const uri = assetUri?.(it.assetId);
            node = uri ? <ImageNode key={it.id} item={it} uri={uri} /> : null;
          }
          return node && liveIds?.has(it.id) ? (
            <Group key={it.id} transform={liveMatrix}>
              {node}
            </Group>
          ) : (
            node
          );
        })}

        {selectionBox ? (
          <Rect
            x={selectionBox[0] - 4}
            y={selectionBox[1] - 4}
            width={selectionBox[2] - selectionBox[0] + 8}
            height={selectionBox[3] - selectionBox[1] + 8}
            color={ACCENT}
            style="stroke"
            strokeWidth={1.5 * hairline}
          >
            <DashPathEffect intervals={[6 * hairline, 4 * hairline]} />
          </Rect>
        ) : null}

        {anchors?.map((a) => (
          <Group key={`pin-${a.lineKey}`}>
            <Circle cx={a.bbox[2] + PIN_RADIUS + 4} cy={a.bbox[1] + PIN_RADIUS} r={a.active ? PIN_RADIUS * 1.2 : PIN_RADIUS} color={anchorColors.pin} />
            <Circle cx={a.bbox[2] + PIN_RADIUS + 4} cy={a.bbox[1] + PIN_RADIUS} r={PIN_RADIUS * 0.4} color="#ffffff" />
          </Group>
        ))}
      </Group>
      <DrawnProbe ink={ink} onDrawn={onDrawn} />
    </Canvas>
  );
});
