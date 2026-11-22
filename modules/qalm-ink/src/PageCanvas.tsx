import type { BBox, ImageItem, Item, PageInfo, ShapeItem, StrokeItem, TextItem } from '@qalm/core';
import { paperPattern, strokeOutline } from '@qalm/core';
import {
  Canvas,
  Circle,
  DashPathEffect,
  Group,
  Image,
  Paragraph,
  Path,
  Rect,
  RoundedRect,
  Skia,
  TextAlign,
  useFonts,
  useImage,
  type SkPath,
  type SkTypefaceFontProvider,
} from '@shopify/react-native-skia';
import * as React from 'react';

import figtree from '../assets/fonts/Figtree-Regular.ttf';
import { HIGHLIGHTER_ALPHA } from './freehand';
import { traceOutline } from './outlinePath';

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
  const p0 = pts[0];
  if (!p0) return b.detach();
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const box = Skia.XYWHRect(Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  switch (s.kind) {
    case 'ellipse':
      b.addOval(box);
      break;
    case 'rect':
      if (pts.length === 2) b.addRect(box);
      else b.addPoly(pts.map(([x, y]) => ({ x, y })), true);
      break;
    case 'triangle':
      b.addPoly(pts.map(([x, y]) => ({ x, y })), true);
      break;
    case 'line':
    case 'arrow': {
      const p1 = pts[pts.length - 1]!;
      b.moveTo(p0[0], p0[1]).lineTo(p1[0], p1[1]);
      if (s.kind === 'arrow') {
        const a = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]);
        const len = Math.max(8, s.width * 5);
        for (const da of [Math.PI * 0.85, -Math.PI * 0.85]) {
          b.moveTo(p1[0], p1[1]).lineTo(p1[0] + len * Math.cos(a + da), p1[1] + len * Math.sin(a + da));
        }
      }
      break;
    }
  }
  return b.detach();
}

function itemBBox(it: Item): BBox {
  switch (it.type) {
    case 'stroke':
      return it.bbox;
    case 'image':
      return [it.x, it.y, it.x + it.w, it.y + it.h];
    case 'text':
      return [it.x, it.y, it.x + it.w, it.y + it.fontSize * 1.25 * Math.max(1, it.text.split('\n').length)];
    case 'shape': {
      const xs = it.pts.map((p) => p[0]);
      const ys = it.pts.map((p) => p[1]);
      const r = it.width / 2;
      return [Math.min(...xs) - r, Math.min(...ys) - r, Math.max(...xs) + r, Math.max(...ys) + r];
    }
  }
}

/** Caches stroke paths across renders; a stroke is rebuilt only when its geometry changes. */
function useStrokePaths(items: Item[]): Map<string, SkPath> {
  const cache = React.useRef(new Map<string, { key: string; path: SkPath }>());
  return React.useMemo(() => {
    const next = new Map<string, { key: string; path: SkPath }>();
    const out = new Map<string, SkPath>();
    for (const it of items) {
      if (it.type !== 'stroke') continue;
      const key = `${it.tool}|${it.width}|${it.points.length}|${it.bbox.join(',')}`;
      const hit = cache.current.get(it.id);
      const entry = hit && hit.key === key ? hit : { key, path: outlineToPath(strokeOutline(it)) };
      next.set(it.id, entry);
      out.set(it.id, entry.path);
    }
    cache.current = next;
    return out;
  }, [items]);
}

function StrokeNode({ item, path }: { item: StrokeItem; path: SkPath }) {
  if (item.tool === 'highlighter') {
    return <Path path={path} color={item.color} opacity={HIGHLIGHTER_ALPHA} blendMode="multiply" />;
  }
  return <Path path={path} color={item.color} />;
}

function TextNode({ item, fonts }: { item: TextItem; fonts: SkTypefaceFontProvider }) {
  const paragraph = React.useMemo(() => {
    const p = Skia.ParagraphBuilder.Make({ textAlign: TextAlign.Left }, fonts)
      .pushStyle({ color: Skia.Color(item.color), fontFamilies: ['Figtree'], fontSize: item.fontSize })
      .addText(item.text)
      .pop()
      .build();
    p.layout(item.w);
    return p;
  }, [item.color, item.fontSize, item.text, item.w, fonts]);
  return <Paragraph paragraph={paragraph} x={item.x} y={item.y} width={item.w} />;
}

function ImageNode({ item, uri }: { item: ImageItem; uri: string }) {
  const image = useImage(uri);
  if (!image) return null;
  return <Image image={image} x={item.x} y={item.y} width={item.w} height={item.h} fit="fill" />;
}

/**
 * The one renderer for finished page content (tech-spec §3): paper, PDF background, items in z-order,
 * selection outline and comment anchors. Runs on iOS/Android (Skia) and web/Electron (CanvasKit).
 */
export function PageCanvas({ info, items, selection, anchors, pdfImage, width, assetUri }: PageCanvasProps) {
  const { w: pageW, h: pageH } = info.size;
  const scale = width / pageW;
  const height = Math.round(pageH * scale);
  const fonts = useFonts({ Figtree: [figtree] });
  const pdf = useImage(pdfImage);
  const strokePaths = useStrokePaths(items);

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

        {items.map((it) => {
          switch (it.type) {
            case 'stroke': {
              const path = strokePaths.get(it.id);
              return path ? <StrokeNode key={it.id} item={it} path={path} /> : null;
            }
            case 'shape':
              return (
                <Path
                  key={it.id}
                  path={shapePath(it)}
                  color={it.color}
                  style="stroke"
                  strokeWidth={it.width}
                  strokeCap="round"
                  strokeJoin="round"
                />
              );
            case 'text':
              return fonts ? <TextNode key={it.id} item={it} fonts={fonts} /> : null;
            case 'image': {
              const uri = assetUri?.(it.assetId);
              return uri ? <ImageNode key={it.id} item={it} uri={uri} /> : null;
            }
          }
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
    </Canvas>
  );
}
