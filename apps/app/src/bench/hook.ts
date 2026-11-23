/**
 * Benchmark hook for `scripts/bench` (web export built with EXPO_PUBLIC_QALM_BENCH=1 only): seeds big notebooks
 * into this browser profile and reports what is held in memory. Never part of a normal build's behaviour.
 */
import { Library } from '@qalm/core';
import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import * as Y from 'yjs';

import type { AssetService } from '../assets/assetService';
import { entryFor } from '../library/actions';
import { importPdf } from '../library/ops';
import { docIds, openLoaded, type DocManager } from '../sync/docs';
import { A4, buildMixedIndex, fillPage, MIXED } from './gen';

export const BENCH = process.env.EXPO_PUBLIC_QALM_BENCH === '1';

/** performance.mark, only in bench builds. */
export function mark(name: string, detail?: unknown): void {
  if (BENCH && typeof performance !== 'undefined' && performance.mark) performance.mark(name, { detail });
}

async function makePdf(pages: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    const p = pdf.addPage([595, 842]);
    p.drawText(`Lecture slide ${i + 1}`, { x: 50, y: 780, size: 28, font, color: rgb(0.1, 0.1, 0.3) });
    for (let l = 0; l < 30; l++) p.drawText(`Line ${l + 1} of page ${i + 1}: the quick brown fox jumps over the lazy dog.`, { x: 50, y: 730 - l * 22, size: 12, font });
    for (let k = 0; k < 40; k++) p.drawRectangle({ x: 50 + (k % 10) * 50, y: 60 + Math.floor(k / 10) * 20, width: 40, height: 14, color: rgb((k * 37) % 255 / 255, 0.6, 0.8) });
  }
  return pdf.save();
}

export function installBenchHook(dm: DocManager, assets: AssetService, getLibrary: () => Library | null): void {
  if (!BENCH || typeof window === 'undefined') return;
  const w = window as unknown as Record<string, unknown>;
  w.__qalmBench = {
    /** Seeds the 300-page mixed notebook and a 300-page PDF notebook; returns their ids. */
    async seed(): Promise<{ mixed: string; pdf: string; ms: number }> {
      const t0 = performance.now();
      const library = getLibrary();
      if (!library) throw new Error('library not ready');
      const spec = MIXED;
      const idx = await openLoaded(dm, docIds.notebook(spec.id));
      Y.applyUpdate(idx.doc, Y.encodeStateAsUpdate(buildMixedIndex(spec)));
      idx.release();
      for (let i = 0; i < spec.pages; i++) {
        const n = spec.strokesOn(i);
        if (!n) continue;
        const h = await openLoaded(dm, docIds.page(spec.id, `p${i}`));
        if (h.doc.getArray('order').length === 0) fillPage(h.doc, n, A4, i + 1);
        h.release();
      }
      library.putEntry({ ...entryFor({ id: spec.id, title: spec.title, cover: '#4338ca', aiAccess: false }, null) });
      const bytes = await makePdf(300);
      const pdf = await importPdf({ dm, assets, library }, { bytes, name: 'bench 300-page lecture.pdf', mime: 'application/pdf', uri: '' }, null, '#0f766e');
      await dm.flushAll();
      return { mixed: spec.id, pdf, ms: performance.now() - t0 };
    },
    /** What the doc manager holds right now. */
    stats(): Record<string, number> {
      return dm.stats();
    },
  };
}
