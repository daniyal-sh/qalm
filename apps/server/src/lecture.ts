/**
 * Lecture mode on the server (docs/lecture-mode.md):
 *   - `LectureCrops`, in a notebook's DocRoom: follows each recording session as a virtual agent `lecture:{sid}` and
 *     stores the region crops an agent would have received at each writing pause (same engine, same R labels).
 *   - `handleLectures`: POST /lectures/transcribe (Whisper on Workers AI) and DELETE /lectures/{nb}/{sid}.
 */
import * as Y from 'yjs';
import {
  Notebook,
  Page,
  emptyLectures,
  emptyRegions,
  emptyThreads,
  encodeQinkUpdate,
  lectureLabel,
  migratePage,
  pageInk,
  parseCropRegions,
  renderRegionsSvg,
  type InkSeen,
  type RegionRow,
  type LectureCrop,
  type LectureMeta,
  type QinkLectures,
  type QinkRegions,
  type TranscriptSegment,
} from '@qalm/core';
import type { Env } from './env';
import { num } from './env';
import { canAccess, lecDocId, nbDocId, parseDocId, pgDocId, room } from './docs';
import { requireUser } from './auth';
import { svgToPng } from './png';
import { sessionOf } from './grants';
import type { DocRoom } from './room';
import { b64, HttpError, json, now, sha256Hex } from './util';

/** What a notebook room knows about one of its sessions (kv `lectures`), reported by the session's room. */
export interface LectureInfo {
  state: LectureMeta['state'];
  startedAt: number;
  durationMs: number;
  /** The newest timeline event's time: crops are stamped with it. */
  lastT: number;
  /** Transcript segments so far (in arrival order). */
  count: number;
  title?: string;
  /** Server time of the session room's last report (any client update): a live session silent for long expires. */
  seenAt?: number;
  /** Set by the notebook room when a live session went silent (crashed app, closed tab): it shows as stopped. */
  expired?: boolean;
  /**
   * The notebook room saw it recording or paused at least once. A session that only ever arrived stopped (an import,
   * or one finished offline) never sends its transcript to agents as live lines.
   */
  liveSeen?: boolean;
}

/** A crop whose labels and ink-seen state are saved but whose PNG and session-doc entry are still to be stored. */
interface PendingCrop { crop: LectureCrop; rows: RegionRow[] | null; pageIds: string[] }

/** A page's ink at the session start, as the agent-style "seen" state, from the session's `base` event for it. */
export interface BaseSeen { ids: string[]; early: Record<string, string> }

function seedSeen(page: Page, base: BaseSeen | undefined): InkSeen | undefined {
  if (!base) return undefined; // the session never logged this page's base ink: a first look
  const now = pageInk(page);
  const out: InkSeen = {};
  for (const id of base.ids) {
    // The base item as it was then: its copy from the first erase or update that touched it, else as it is now.
    const sig = base.early[id] ?? now[id];
    if (sig) out[id] = sig;
  }
  return out;
}

/**
 * A session's crop state in its notebook room (kv `lecture:{sid}`). `failures` / `retryAt`: a crop that failed backs
 * off instead of being retried on every pen-up; after `CROP_MAX_FAILURES` the pending changes are skipped.
 */
interface CropState { deliveredAt: number; lastCropAt: number; rev: number; flushed?: boolean; deleted?: boolean; failures?: number; retryAt?: number; pending?: PendingCrop }

/** 15 s, 30 s, 1, 2, 4, 8 and 10 minutes between tries (about 26 minutes in all), then the changes are given up. */
const CROP_MAX_FAILURES = 8;
const cropBackoffMs = (env: Env, failures: number) => Math.min(10 * 60_000, num(env.LECTURE_CROP_BACKOFF_MS, 15_000) * 2 ** (failures - 1));
/** A recording session that reported nothing for this long (no strokes, no audio chunk every 2 min) is expired. */
export const LECTURE_SILENT_RECORDING_MS = 15 * 60_000;
/** A paused one gets longer (a break), then it is expired too. */
export const LECTURE_SILENT_PAUSED_MS = 6 * 3600_000;

const MODEL = '@cf/openai/whisper-large-v3-turbo';
const cropClient = (sid: string) => `lecture:${sid}`;
const inkKey = (sid: string, pageId: string) => `ink:${cropClient(sid)}:${pageId}`;
/** Region lines of an update (header, other pages and regions); threads and asks are not part of a crop. */
const CROP_LINE = /^(#q |p\d+ |R\d+ )/;

export function lectureCfg(env: Env) {
  const silent = env.LECTURE_SILENT_MS ? num(env.LECTURE_SILENT_MS, 0) : 0;
  return {
    idleMs: num(env.WAKE_IDLE_MS, 6000),
    minIntervalMs: num(env.WAKE_MIN_INTERVAL_MS, 20000),
    silentRecordingMs: silent || LECTURE_SILENT_RECORDING_MS,
    silentPausedMs: silent || LECTURE_SILENT_PAUSED_MS,
  };
}

export class LectureCrops {
  constructor(private readonly r: DocRoom, private readonly env: Env, private readonly notebookId: string) {}

  lectures(): Record<string, LectureInfo> {
    return this.r.kvGet<Record<string, LectureInfo>>('lectures') ?? {};
  }

  labels(): QinkLectures {
    return this.r.kvGet<QinkLectures>('lectureLabels') ?? emptyLectures();
  }

  label(sid: string): string {
    const l = this.labels();
    const known = l.byId[sid];
    if (known) return known;
    const label = lectureLabel(l, sid);
    this.r.kvPut('lectureLabels', l);
    return label;
  }

  /**
   * The session's room reported a change. Returns whether its transcript grew (agents should wake) and whether the
   * session just paused or stopped (its last crop is due now). A deleted session is ignored for good.
   */
  update(sid: string, info: LectureInfo, t = now()): { grew: boolean; flush: boolean; ignored?: true } {
    const st = this.r.kvGet<CropState>(`lecture:${sid}`);
    if (st?.deleted) return { grew: false, flush: false, ignored: true };
    const all = this.lectures();
    const prev = all[sid];
    const same =
      !!prev && !prev.expired && prev.state === info.state && prev.count === info.count && prev.lastT === info.lastT &&
      prev.durationMs === info.durationMs && prev.title === info.title && prev.startedAt === info.startedAt;
    // Only rewrite the kv when something agents or crops see changed (seenAt is refreshed at most once a minute).
    const liveSeen = !!prev?.liveSeen || info.state !== 'stopped';
    if (!same || t - (prev.seenAt ?? 0) > 60_000 || !!prev.liveSeen !== liveSeen) {
      all[sid] = { ...info, seenAt: t, liveSeen };
      this.r.kvPut('lectures', all);
    }
    this.label(sid);
    if (!st) {
      // Crops start at the session's start, never before: ink from earlier is not this lecture's. A session that
      // arrives stopped (an import, or one recorded offline and finished) gets no crops: it is flushed at once.
      const start = Math.min(info.startedAt > 0 ? info.startedAt : t, t);
      this.r.kvPut(`lecture:${sid}`, { deliveredAt: start, lastCropAt: 0, rev: 0, ...(info.state === 'stopped' ? { flushed: true } : {}) } satisfies CropState);
      return { grew: info.count > 0, flush: false };
    }
    // An expired session that reports again (a device back online, still recording) gets crops again.
    if (prev?.expired && info.state !== 'stopped' && st.flushed) this.r.kvPut(`lecture:${sid}`, { ...st, flushed: false });
    const wasLive = prev ? prev.state !== 'stopped' && !prev.expired : true;
    const flush = (info.state === 'stopped' && wasLive) || (info.state === 'paused' && prev?.state === 'recording');
    return { grew: info.count > (prev?.count ?? 0), flush };
  }

  /** A deleted session: forgotten, and later reports from it (another device re-syncing it) are ignored. */
  remove(sid: string): void {
    const all = this.lectures();
    delete all[sid];
    this.r.kvPut('lectures', all);
    this.r.kvPut(`lecture:${sid}`, { deliveredAt: Infinity, lastCropAt: 0, rev: 0, flushed: true, deleted: true } satisfies CropState);
  }

  /** Sessions still being recorded (or paused), expired ones left out. */
  live(): [string, LectureInfo][] {
    return Object.entries(this.lectures()).filter(([, l]) => l.state !== 'stopped' && !l.expired);
  }

  /** Expires live sessions that went silent; returns when the next one would (null: none live). */
  private expire(t: number): number | null {
    const all = this.lectures();
    let next: number | null = null;
    let changed = false;
    for (const [sid, l] of Object.entries(all)) {
      if (l.state === 'stopped' || l.expired) continue;
      const cfg = lectureCfg(this.env);
      const until = (l.seenAt ?? t) + (l.state === 'recording' ? cfg.silentRecordingMs : cfg.silentPausedMs);
      if (t >= until) {
        all[sid] = { ...l, expired: true };
        changed = true;
        const st = this.r.kvGet<CropState>(`lecture:${sid}`);
        if (st && !st.flushed) this.r.kvPut(`lecture:${sid}`, { ...st, flushed: true });
      } else next = next === null ? until : Math.min(next, until);
    }
    if (changed) this.r.kvPut('lectures', all);
    return next;
  }

  /**
   * Makes the crops that are due; returns when to look again (null: nothing pending). `force`: a session that just
   * paused or stopped gets its crop now, without waiting for the pen-idle rule.
   */
  async tick(force?: string): Promise<number | null> {
    const cfg = lectureCfg(this.env);
    const changed = this.r.kvGet<Record<string, number>>('changed') ?? {};
    const lastUpdate = this.r.kvGet<number>('lastClientUpdateAt') ?? 0;
    let next = this.expire(now());
    const later = (at: number) => (next = next === null ? at : Math.min(next, at));
    for (const [sid, info] of Object.entries(this.lectures())) {
      let st = this.r.kvGet<CropState>(`lecture:${sid}`);
      if (!st || st.deleted || (st.flushed && !st.pending)) continue;
      const t = now();
      if (st.retryAt && t < st.retryAt) {
        later(st.retryAt); // backing off; a stop meanwhile keeps its last crop for the retry
        continue;
      }
      // A crop whose storage failed: retry only the storage (its labels and ink-seen are already saved).
      if (st.pending) {
        try {
          st = await this.storePending(sid, st);
        } catch (e) {
          this.failed(sid, st, info, t, e, later);
          continue;
        }
        if (st.flushed) continue;
      }
      // A stopped session gets one last crop as it stops (force, or the retry of a failed one), never later ones.
      const stopped = info.state === 'stopped';
      if (stopped && force !== sid && !st.failures) {
        this.r.kvPut(`lecture:${sid}`, { ...st, flushed: true });
        continue;
      }
      const ids = Object.entries(changed).filter(([, at]) => at > st!.deliveredAt).map(([id]) => id);
      if (!ids.length) {
        if (stopped) this.r.kvPut(`lecture:${sid}`, { ...st, flushed: true, failures: 0 });
        continue;
      }
      const ready = force === sid || info.state !== 'recording' || st.failures ? t : Math.max(lastUpdate + cfg.idleMs, st.lastCropAt + cfg.minIntervalMs);
      if (t < ready) {
        later(ready);
        continue;
      }
      try {
        await this.crop(sid, info, st, ids, t);
      } catch (e) {
        this.failed(sid, this.r.kvGet<CropState>(`lecture:${sid}`) ?? st, info, t, e, later);
      }
    }
    return next;
  }

  /** A crop (or its storage) failed: back off, or after CROP_MAX_FAILURES give the pending changes up. */
  private failed(sid: string, st: CropState, info: LectureInfo, t: number, e: unknown, later: (at: number) => void): void {
    const failures = (st.failures ?? 0) + 1;
    console.error(`lecture crop failed (${sid}, ${failures}x)`, e);
    if (failures >= CROP_MAX_FAILURES) {
      // Give up on these changes (the timeline still has every stroke); later ink gets crops again.
      const { pending: _drop, ...rest } = st;
      this.r.kvPut(`lecture:${sid}`, { ...rest, deliveredAt: Math.max(st.deliveredAt, t), failures: 0, retryAt: 0, ...(info.state === 'stopped' ? { flushed: true } : {}) });
      return;
    }
    const retryAt = t + cropBackoffMs(this.env, failures);
    this.r.kvPut(`lecture:${sid}`, { ...st, failures, retryAt });
    later(retryAt);
  }

  /**
   * One crop. Everything that reads and writes the notebook-wide region registry and the session's ink-seen state
   * happens with no await in between (another call could allocate labels meanwhile), and is saved together with the
   * crop as `pending`; the PNG and the session doc entry are made after, by `storePending`, which a failure retries.
   */
  private async crop(sid: string, info: LectureInfo, st: CropState, pageIds: string[], at: number): Promise<void> {
    testCropHook?.(pageIds, 'start');
    const nb = new Notebook(this.r.doc);
    const live = new Set(nb.pages().map((p) => p.id));
    const ids = pageIds.filter((id) => live.has(id));
    const pages = await this.loadPages(ids);
    // Pages this session hasn't cropped yet start from their ink at the session's start (the `base` event), so the
    // first crop shows only what was written during the lecture, not the page's older ink.
    const unseen = ids.filter((id) => !this.r.kvGet<InkSeen>(inkKey(sid, id)));
    const docId = lecDocId(this.notebookId, sid);
    const base: Record<string, BaseSeen> = unseen.length ? await room(this.env, docId).lectureBaseSeen(docId, unseen) : {};
    // ---- no await from here to the kvPuts ----
    const regions = this.r.kvGet<QinkRegions>('regions') ?? emptyRegions();
    const prev: Record<string, InkSeen | undefined> = {};
    for (const id of ids) prev[id] = this.r.kvGet<InkSeen>(inkKey(sid, id)) ?? seedSeen(pages[id]!, base[id]);
    const u = encodeQinkUpdate(nb, pages, regions, prev, { session: sessionOf(this.notebookId), rev: st.rev + 1, client: cropClient(sid), threads: emptyThreads(), seen: {} });
    const text = u.text.split('\n').filter((l) => CROP_LINE.test(l)).join('\n');
    const next: CropState = { ...st, deliveredAt: at, failures: 0, retryAt: 0, ...(info.state === 'stopped' ? { flushed: true } : {}) };
    const hasRegions = text.includes('\nR');
    this.r.kvPut('regions', regions);
    for (const [id, ink] of Object.entries(u.ink)) this.r.kvPut(inkKey(sid, id), ink);
    if (!hasRegions) {
      this.r.kvPut(`lecture:${sid}`, next);
      return;
    }
    const pending: PendingCrop = { crop: { t: info.lastT, sha: '', w: 0, h: 0, text, regions: parseCropRegions(text) }, rows: u.image?.rows.length ? u.image.rows : null, pageIds: ids };
    const withPending: CropState = { ...next, pending };
    this.r.kvPut(`lecture:${sid}`, withPending);
    await this.storePending(sid, withPending);
  }

  /** Renders and stores a pending crop's PNG and adds the crop to the session doc; then it is no longer pending. */
  private async storePending(sid: string, st: CropState): Promise<CropState> {
    const p = st.pending;
    if (!p) return st;
    testCropHook?.(p.pageIds, 'store');
    let crop = p.crop;
    if (p.rows) {
      const pages = await this.loadPages(p.pageIds);
      const png = await svgToPng(renderRegionsSvg(pages, p.rows).svg);
      const sha = await sha256Hex(png.png);
      await this.storeAsset(sha, png.png);
      crop = { ...crop, sha, w: png.width, h: png.height };
    }
    const docId = lecDocId(this.notebookId, sid);
    await room(this.env, docId).addLectureCrop(docId, crop);
    const cur = this.r.kvGet<CropState>(`lecture:${sid}`) ?? st;
    const { pending: _done, ...rest } = cur;
    const done: CropState = { ...rest, rev: cur.rev + 1, lastCropAt: now(), failures: 0, retryAt: 0 };
    this.r.kvPut(`lecture:${sid}`, done);
    return done;
  }

  private async loadPages(ids: readonly string[]): Promise<Record<string, Page>> {
    const pages: Record<string, Page> = {};
    await Promise.all(
      ids.map(async (id) => {
        const docId = pgDocId(this.notebookId, id);
        const doc = new Y.Doc();
        Y.applyUpdate(doc, await room(this.env, docId).getState(docId));
        migratePage(doc);
        pages[id] = new Page(doc);
      }),
    );
    return pages;
  }

  /** A crop PNG as an asset of the notebook's owner: in R2 and counted in user_assets (never refused, like ink). */
  private async storeAsset(sha: string, png: Uint8Array): Promise<void> {
    const owner = await this.env.DB.prepare('SELECT owner_id FROM notebooks WHERE id = ?1').bind(this.notebookId).first<{ owner_id: string }>();
    if (!(await this.env.ASSETS.head(sha))) await this.env.ASSETS.put(sha, png, { httpMetadata: { contentType: 'image/png' }, sha256: sha });
    if (owner) {
      await this.env.DB.prepare('INSERT INTO user_assets (user_id, sha256, bytes, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT DO NOTHING')
        .bind(owner.owner_id, sha, png.byteLength, now())
        .run();
    }
  }
}

/** Tests: called at each crop attempt with its pages (throw to make it fail). */
let testCropHook: ((pageIds: string[], phase: 'start' | 'store') => void) | null = null;
export function setTestCropHook(fn: ((pageIds: string[], phase: 'start' | 'store') => void) | null): void {
  testCropHook = fn;
}

// ---- HTTP ----

/** Workers AI, or the test double (tests can't reach Workers AI). */
type AiRun = (model: string, input: Record<string, unknown>) => Promise<unknown>;
let testAi: AiRun | false | null = null;
/** Tests: a fake model, `false` for "no AI binding", or null for the real binding. */
export function setTestAi(fn: AiRun | false | null): void {
  testAi = fn;
}

/** The lowest bitrate a speech chunk is assumed to have (kbps = bits per ms): its upper bound on length. */
const MIN_KBPS = 6;
const AUDIO_TYPES = /^audio\/(webm|ogg|mp4|m4a|x-m4a|aac|mpeg|mp3|wav|x-wav)\b/;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

interface WhisperWord { word?: string; start?: number; end?: number }
interface WhisperSegment { start?: number; end?: number; text?: string; words?: WhisperWord[] }
interface WhisperOut { text?: string; segments?: WhisperSegment[]; transcription_info?: { duration?: number } }

const monthStart = (t: number) => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};

async function usedMs(env: Env, userId: string, t: number, beforeId: number): Promise<number> {
  const r = await env.DB.prepare('SELECT COALESCE(SUM(ms), 0) AS ms FROM transcribe_usage WHERE user_id = ?1 AND at >= ?2 AND id < ?3')
    .bind(userId, monthStart(t), beforeId)
    .first<{ ms: number }>();
  return r?.ms ?? 0;
}

/** Local end-to-end runs only (`--var WHISPER_FAKE:1`): a canned transcript instead of Workers AI. */
const fakeWhisper: AiRun = async (_model, input) => {
  const secs = Math.max(1, Math.round(String(input.audio ?? '').length / 5300)); // ~32 kbps of base64
  return { text: 'this is the fake whisper transcript', transcription_info: { duration: secs }, segments: [{ start: 0.2, end: Math.min(secs, 2), text: ' this is the fake whisper transcript' }] };
};

/** Whisper's output as timeline segments (ms), shifted by nothing: the client adds the chunk's start. */
export function whisperSegments(out: WhisperOut): TranscriptSegment[] {
  const segs = out.segments?.length ? out.segments : out.text?.trim() ? [{ start: 0, end: out.transcription_info?.duration ?? 0, text: out.text }] : [];
  return segs
    .filter((s) => (s.text ?? '').trim())
    .map((s) => {
      const words = (s.words ?? [])
        .filter((w) => (w.word ?? '').trim())
        .map((w) => ({ w: (w.word ?? '').trim(), t0: Math.round((w.start ?? 0) * 1000), t1: Math.round((w.end ?? 0) * 1000) }));
      return { t0: Math.round((s.start ?? 0) * 1000), t1: Math.round((s.end ?? 0) * 1000), text: (s.text ?? '').trim(), ...(words.length ? { words } : {}), src: 'cloud' as const };
    });
}

/** The body, refusing it (413) as soon as it passes `max` bytes, with or without a Content-Length. */
async function readLimited(req: Request, max: number): Promise<Uint8Array> {
  const len = Number(req.headers.get('Content-Length') ?? NaN);
  if (Number.isFinite(len) && len > max) throw new HttpError(413, 'Audio chunk too large (max 8 MB)');
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, 'Audio chunk too large (max 8 MB)');
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

async function liveUser(req: Request, env: Env): Promise<string> {
  const userId = await requireUser(req, env);
  const ok = await env.DB.prepare('SELECT 1 FROM users WHERE id = ?1 AND deleting_at IS NULL').bind(userId).first();
  if (!ok) throw new HttpError(401, 'This account no longer exists');
  return userId;
}

/**
 * POST /lectures/transcribe?lang=xx   body: one audio chunk → {segments, durationMs, usedMinutes, limitMinutes}
 * DELETE /lectures/{notebookId}/{sessionId}   deletes a session: its room, audio and crops.
 */
export async function handleLectures(req: Request, env: Env, path: string): Promise<Response | null> {
  if (path === '/lectures/transcribe' && req.method === 'POST') return transcribe(req, env);
  const m = /^\/lectures\/([^/]+)\/([^/]+)$/.exec(path);
  if (m && req.method === 'DELETE') {
    const userId = await requireUser(req, env);
    const docId = lecDocId(decodeURIComponent(m[1]!), decodeURIComponent(m[2]!));
    const ref = parseDocId(docId);
    if (!ref || ref.kind !== 'lec' || !(await canAccess(env, userId, ref))) throw new HttpError(404, 'Not found');
    await deleteLecture(env, userId, ref.notebookId, ref.sessionId);
    return json({ ok: true });
  }
  return null;
}

async function transcribe(req: Request, env: Env): Promise<Response> {
  const userId = await liveUser(req, env);
  const ai: AiRun | null =
    testAi === false ? null : (testAi ?? (env.WHISPER_FAKE === '1' ? fakeWhisper : env.AI ? (model, input) => env.AI!.run(model as never, input as never) : null));
  if (!ai) throw new HttpError(503, 'Cloud transcription is not set up on this server');
  const type = (req.headers.get('Content-Type') ?? '').toLowerCase();
  if (!AUDIO_TYPES.test(type)) throw new HttpError(415, 'Send one audio chunk (audio/webm, audio/ogg, audio/mp4, audio/mpeg or audio/wav)');
  const body = await readLimited(req, MAX_AUDIO_BYTES);
  if (!body.length) throw new HttpError(400, 'Empty audio');

  // Reserve first, then count the reservations made before this one (by row id, so concurrent requests are ordered):
  // parallel requests can't all slip under the per-minute limit or the monthly cap. On overflow it is taken back.
  const t = now();
  const perMinute = num(env.TRANSCRIBE_PER_MINUTE, 6);
  const limitMs = num(env.TRANSCRIBE_MINUTES_PER_MONTH, 600) * 60_000;
  const limitMinutes = Math.round(limitMs / 60_000);
  // The most this chunk can hold: its bytes at a floor of 6 kbps (no speech codec goes lower), or the client's claim if
  // larger. Reserved before Whisper runs (clamped to what's left below), so parallel requests see it.
  const upper = Math.max(num(req.headers.get('X-Audio-Duration-Ms') ?? undefined, 0), Math.ceil((body.length * 8) / MIN_KBPS));
  const row = await env.DB.prepare('INSERT INTO transcribe_usage (user_id, at, ms) VALUES (?1, ?2, ?3) RETURNING id').bind(userId, t, upper).first<{ id: number }>();
  const release = () => env.DB.prepare('DELETE FROM transcribe_usage WHERE id = ?1').bind(row!.id).run();
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM transcribe_usage WHERE user_id = ?1 AND at > ?2 AND id <= ?3')
    .bind(userId, t - 60_000, row!.id)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) > perMinute) {
    await release();
    return json({ error: 'Too many transcription requests. Try again in a minute.', code: 'rate_limited' }, 429, { 'Retry-After': '60' });
  }
  const used = await usedMs(env, userId, t, row!.id); // this month before this request, earlier reservations included
  if (used >= limitMs) {
    await release();
    return json({ error: `You've used this month's ${limitMinutes} minutes of cloud transcription.`, code: 'transcribe_quota', usedMinutes: Math.round(used / 60_000), limitMinutes }, 402);
  }
  // The reservation never claims more than is left: a request after this one sees the month as full and is refused.
  // This one is charged what Whisper hears, so the cap is passed by at most this one request.
  const budget = limitMs - used;
  const reserved = Math.min(upper, budget);
  if (reserved < upper) await env.DB.prepare('UPDATE transcribe_usage SET ms = ?2 WHERE id = ?1').bind(row!.id, reserved).run();
  const lang = new URL(req.url).searchParams.get('lang');
  let out: WhisperOut;
  try {
    out = (await ai(MODEL, { audio: b64(body), task: 'transcribe', vad_filter: true, ...(lang && /^[a-z]{2}$/.test(lang) ? { language: lang } : {}) })) as WhisperOut;
  } catch (e) {
    console.error('whisper failed', e);
    // Kept as 0 ms: no minutes are charged, but it still counts towards the per-minute limit (a chunk that always
    // fails can't be retried in a tight loop).
    await env.DB.prepare('UPDATE transcribe_usage SET ms = 0 WHERE id = ?1').bind(row!.id).run();
    throw new HttpError(502, 'Transcription failed; it will be retried');
  }
  // Charged what Whisper heard (no clamp: a long chunk is charged in full). Whisper not saying: its bytes at 32 kbps.
  const heard = Math.round((out.transcription_info?.duration ?? 0) * 1000);
  const durationMs = heard > 0 ? heard : Math.min(reserved, Math.round(body.length / 4));
  await env.DB.prepare('UPDATE transcribe_usage SET ms = ?2 WHERE id = ?1').bind(row!.id, durationMs).run();
  return json({ segments: whisperSegments(out), durationMs, usedMinutes: Math.round((used + durationMs) / 60_000), limitMinutes });
}

/**
 * Records which assets a session doc references (`lecture_assets`): content-addressed audio and crops can be shared
 * by several sessions (an export imported again, identical crops), so deleting one only frees what no other uses.
 */
export async function recordLectureAssets(env: Env, docId: string, userId: string, shas: readonly string[]): Promise<void> {
  const ok = shas.filter((s) => /^[0-9a-f]{64}$/.test(s));
  for (let i = 0; i < ok.length; i += 40) {
    const part = ok.slice(i, i + 40);
    await env.DB.batch(
      part.map((sha) => env.DB.prepare('INSERT INTO lecture_assets (doc_id, user_id, sha256) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING').bind(docId, userId, sha)),
    );
  }
}

/** True when the session was deleted: it can't be synced (or recreated) again. */
export async function lectureDeleted(env: Env, docId: string): Promise<boolean> {
  return !!(await env.DB.prepare('SELECT 1 FROM deleted_lectures WHERE doc_id = ?1').bind(docId).first());
}

/**
 * Frees assets a deleted session held: a sha stays while any other session of the user still references it; else the
 * user's `user_assets` row goes, and the R2 object too when no other user holds it.
 */
/** Every page asset sha (PDFs, images) in the user's notebooks that aren't deleted forever, from their index docs. */
async function pageAssetShas(env: Env, userId: string): Promise<Set<string>> {
  const nbs = (await env.DB.prepare('SELECT id FROM notebooks WHERE owner_id = ?1 AND deleted_at IS NULL').bind(userId).all<{ id: string }>()).results;
  const out = new Set<string>();
  for (const { id } of nbs) {
    try {
      for (const sha of await room(env, nbDocId(id)).notebookAssetShas(nbDocId(id))) out.add(sha);
    } catch (e) {
      console.error('notebookAssetShas failed', e);
      throw e; // unsure: keep the assets rather than delete something a page uses
    }
  }
  return out;
}

async function releaseLectureAssets(env: Env, userId: string, shas: readonly string[]): Promise<void> {
  for (let i = 0; i < shas.length; i += 50) {
    const part = shas.slice(i, i + 50);
    const marks = part.map((_, j) => `?${j + 2}`).join(',');
    const used = new Set(
      (await env.DB.prepare(`SELECT DISTINCT sha256 FROM lecture_assets WHERE user_id = ?1 AND sha256 IN (${marks})`).bind(userId, ...part).all<{ sha256: string }>()).results.map(
        (r) => r.sha256,
      ),
    );
    let free = part.filter((s) => !used.has(s));
    // A page asset (PDF, image) of any of the user's notebooks with the same bytes keeps it too.
    if (free.length) {
      const inPages = await pageAssetShas(env, userId);
      free = free.filter((s) => !inPages.has(s));
    }
    if (!free.length) continue;
    const fm = free.map((_, j) => `?${j + 2}`).join(',');
    await env.DB.prepare(`DELETE FROM user_assets WHERE user_id = ?1 AND sha256 IN (${fm})`).bind(userId, ...free).run();
    const held = new Set(
      (await env.DB.prepare(`SELECT DISTINCT sha256 FROM user_assets WHERE user_id != ?1 AND sha256 IN (${fm})`).bind(userId, ...free).all<{ sha256: string }>()).results.map(
        (r) => r.sha256,
      ),
    );
    const gone = free.filter((s) => !held.has(s));
    if (gone.length) await env.ASSETS.delete(gone);
  }
}

/**
 * Deletes one session: tombstones it first (no new sync tickets, so no device can recreate it), then purges its room
 * (and doc_sizes row), frees the audio and crop assets no other session of the user references, and forgets it in
 * the notebook room. `notebookRoom: false` when the notebook room is being purged anyway ("Delete forever").
 */
export async function deleteLecture(env: Env, userId: string, notebookId: string, sessionId: string, opts: { notebookRoom?: boolean } = {}): Promise<void> {
  const docId = lecDocId(notebookId, sessionId);
  await env.DB.prepare('INSERT INTO deleted_lectures (doc_id, user_id, at) VALUES (?1, ?2, ?3) ON CONFLICT DO NOTHING').bind(docId, userId, now()).run();
  await env.DB.prepare('DELETE FROM sync_tickets WHERE doc_id = ?1').bind(docId).run();
  const stub = room(env, docId);
  const fromDoc = await stub.lectureAssets(docId);
  const fromRows = (await env.DB.prepare('SELECT sha256 FROM lecture_assets WHERE doc_id = ?1').bind(docId).all<{ sha256: string }>()).results.map((r) => r.sha256);
  await stub.purge(docId);
  await env.DB.prepare('DELETE FROM lecture_assets WHERE doc_id = ?1').bind(docId).run();
  await releaseLectureAssets(env, userId, [...new Set([...fromDoc, ...fromRows])]);
  if (opts.notebookRoom !== false) await room(env, nbDocId(notebookId)).lectureRemoved(nbDocId(notebookId), sessionId);
}

/** Every session id a notebook has had (its room's list, sizes reported, assets recorded), for "Delete forever". */
export async function notebookLectureIds(env: Env, notebookId: string, fromRoom: readonly string[]): Promise<string[]> {
  const prefix = `lec:${notebookId}:`;
  const q = (table: string) =>
    env.DB.prepare(`SELECT DISTINCT doc_id FROM ${table} WHERE substr(doc_id, 1, ?2) = ?1`).bind(prefix, prefix.length).all<{ doc_id: string }>();
  const rows = [...(await q('doc_sizes')).results, ...(await q('lecture_assets')).results];
  return [...new Set([...fromRoom, ...rows.map((r) => r.doc_id.slice(prefix.length))])];
}
