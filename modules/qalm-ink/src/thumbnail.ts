import { inkPaint, itemsOnPaper, paperPattern, shapePolylines, textHeight, type Item, type PageInfo } from '@qalm/core';
import { BlendMode, ImageFormat, PaintStyle, Skia, StrokeCap, StrokeJoin, type SkImage, type SkPaint } from '@shopify/react-native-skia';


export interface ThumbnailInput {
  info: PageInfo;
  items: Item[];
  /** PDF page background (a small `renderPdfPage` uri), if any. */
  background?: string;
  /** px */
  width: number;
}

/**
 * Renders a small page preview to a JPEG data uri, for the page navigator. It draws into an offscreen CPU surface (no
 * GPU context per thumbnail; browsers allow only a few WebGL contexts), and cheaply: strokes are their centre lines at
 * their width (no perfect-freehand outline), text boxes are grey bars and images grey boxes. At thumbnail size this
 * reads the same as the page.
 */
/** CPU decode (a texture-backed image, as PageCanvas uses on web, can't be drawn into a CPU surface). */
async function decodeCpu(uri: string): Promise<SkImage | null> {
  return Skia.Image.MakeImageFromEncoded(await Skia.Data.fromURI(uri));
}

export async function renderThumbnail({ info, items, background, width }: ThumbnailInput): Promise<string> {
  const scale = width / info.size.w;
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(info.size.h * scale));
  const surface = Skia.Surface.Make(w, h);
  if (!surface) throw new Error('no surface');
  const bg = background ? await decodeCpu(background).catch(() => null) : null;
  const canvas = surface.getCanvas();
  const pattern = paperPattern(info.paper, info.paperColor, info.size);
  const disposables: { dispose?: () => void }[] = [];
  const paint = (setup: (p: SkPaint) => void) => {
    const p = Skia.Paint();
    p.setAntiAlias(true);
    setup(p);
    disposables.push(p);
    return p;
  };
  canvas.drawColor(Skia.Color(pattern.bg));
  canvas.save();
  canvas.scale(scale, scale);
  if (bg) {
    canvas.drawImageRect(bg, Skia.XYWHRect(0, 0, bg.width(), bg.height()), Skia.XYWHRect(0, 0, info.size.w, info.size.h), paint(() => undefined));
    disposables.push(bg);
  }
  if (pattern.lines.length) {
    const b = Skia.PathBuilder.Make();
    for (const [x0, y0, x1, y1] of pattern.lines) b.moveTo(x0, y0).lineTo(x1, y1);
    const path = b.detach();
    disposables.push(path);
    canvas.drawPath(path, paint((p) => (p.setStyle(PaintStyle.Stroke), p.setStrokeWidth(1 / scale), p.setColor(Skia.Color(pattern.stroke)))));
  }
  /** Turns what follows about (x, y) by `rot` radians (text and images turn about their top-left corner); restore after. */
  const turn = (x: number, y: number, rot: number | undefined) => {
    canvas.save();
    if (rot) {
      canvas.translate(x, y);
      canvas.rotate((rot * 180) / Math.PI, 0, 0);
      canvas.translate(-x, -y);
    }
  };
  const strokePaints = new Map<string, SkPaint>();
  for (const it of itemsOnPaper(items, info.paperColor)) {
    if (it.type === 'stroke' || it.type === 'shape') {
      const key = `${it.type}|${it.type === 'stroke' ? it.tool : ''}|${it.color}|${it.width}`;
      let p = strokePaints.get(key);
      if (!p) {
        p = paint((q) => {
          q.setStyle(PaintStyle.Stroke);
          q.setStrokeWidth(Math.max(it.width * (it.type === 'stroke' && it.tool === 'pen' ? 0.8 : 1), 0.7 / scale));
          q.setStrokeCap(StrokeCap.Round);
          q.setStrokeJoin(StrokeJoin.Round);
          // Colour and alpha as every renderer paints ink (a #rrggbbaa highlighter carries its own alpha).
          const ink = inkPaint(it.type === 'stroke' ? it.tool : 'pen', it.color);
          q.setColor(Skia.Color(ink.rgb));
          if (it.type === 'stroke' && it.tool === 'highlighter') {
            q.setAlphaf(ink.alpha);
            q.setBlendMode(BlendMode.Multiply);
          }
        });
        strokePaints.set(key, p);
      }
      const b = Skia.PathBuilder.Make();
      if (it.type === 'stroke') {
        const pts = it.points;
        if (!pts.length) continue;
        b.moveTo(pts[0]!.x, pts[0]!.y);
        // Every other point is plenty at this size.
        for (let i = 1; i < pts.length; i += 2) b.lineTo(pts[i]!.x, pts[i]!.y);
        const last = pts[pts.length - 1]!;
        b.lineTo(last.x, last.y);
      } else if (it.kind === 'ellipse' && it.pts.length === 2) {
        // Older upright ellipses: their box.
        const [q0, q1] = [it.pts[0]!, it.pts[1]!];
        b.addOval(Skia.XYWHRect(Math.min(q0[0], q1[0]), Math.min(q0[1], q1[1]), Math.abs(q1[0] - q0[0]), Math.abs(q1[1] - q0[1])));
      } else {
        // Every shape kind, turned or not: the same outlines as PageCanvas and the exports.
        for (const pl of shapePolylines(it)) pl.forEach(([x, y], i) => (i ? b.lineTo(x, y) : b.moveTo(x, y)));
      }
      const path = b.detach();
      canvas.drawPath(path, p);
      path.dispose?.();
    } else if (it.type === 'text') {
      turn(it.x, it.y, it.rot);
      // A Markdown box's rows come from its layout (headings, lists, maths); a plain one's from its lines.
      const lines = it.format === 'md' ? Math.max(1, Math.round(textHeight(it) / (it.fontSize * 1.3))) : Math.max(1, it.text.split('\n').length);
      const grey = paint((q) => q.setColor(Skia.Color(inkPaint('pen', it.color).rgb)));
      grey.setAlphaf(0.35);
      for (let l = 0; l < lines; l++) canvas.drawRect(Skia.XYWHRect(it.x, it.y + l * it.fontSize * 1.3 + it.fontSize * 0.25, it.w * 0.9, it.fontSize * 0.6), grey);
      canvas.restore();
    } else if (it.type === 'image') {
      turn(it.x, it.y, it.rot);
      canvas.drawRect(Skia.XYWHRect(it.x, it.y, it.w, it.h), paint((q) => q.setColor(Skia.Color('#d3d3d9'))));
      canvas.restore();
    }
  }
  canvas.restore();
  surface.flush();
  const image = surface.makeImageSnapshot();
  const b64 = image.encodeToBase64(ImageFormat.JPEG, 85);
  image.dispose?.();
  surface.dispose?.();
  for (const d of disposables) d.dispose?.();
  return `data:image/jpeg;base64,${b64}`;
}
