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
  parseCropRegions,
  renderRegionsSvg,
  type InkSeen,
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
}

/** A session's crop state in its notebook room (kv `lecture:{sid}`). */
interface CropState { deliveredAt: number; lastCropAt: number; rev: number; flushed?: boolean }

const MODEL = '@cf/openai/whisper-large-v3-turbo';
const cropClient = (sid: string) => `lecture:${sid}`;
const inkKey = (sid: string, pageId: string) => `ink:${cropClient(sid)}:${pageId}`;
/** Region lines of an update (header, other pages and regions); threads and asks are not part of a crop. */
const CROP_LINE = /^(#q |p\d+ |R\d+ )/;

export function lectureCfg(env: Env) {
  return { idleMs: num(env.WAKE_IDLE_MS, 6000), minIntervalMs: num(env.WAKE_MIN_INTERVAL_MS, 20000) };
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
    const label = lectureLabel(l, sid);
    this.r.kvPut('lectureLabels', l);
    return label;
  }

  /** The session's room reported a change. Returns whether its transcript grew (agents should wake). */
  update(sid: string, info: LectureInfo): { grew: boolean; flush: boolean } {
    const all = this.lectures();
    const prev = all[sid];
    all[sid] = info;
    this.r.kvPut('lectures', all);
    this.label(sid);
    if (!this.r.kvGet<CropState>(`lecture:${sid}`)) {
      // Crops start from now: ink written before the session is a first look at its first crop of each page.
      this.r.kvPut(`lecture:${sid}`, { deliveredAt: 0, lastCropAt: 0, rev: 0 } satisfies CropState);
    }
    return { grew: info.count > (prev?.count ?? 0), flush: info.state !== 'recording' && prev?.state === 'recording' };
  }

  remove(sid: string): void {
    const all = this.lectures();
    delete all[sid];
    this.r.kvPut('lectures', all);
    this.r.kvPut(`lecture:${sid}`, { deliveredAt: Infinity, lastCropAt: 0, rev: 0, flushed: true } satisfies CropState);
  }

  /** Sessions still being recorded (or paused). */
  live(): [string, LectureInfo][] {
    return Object.entries(this.lectures()).filter(([, l]) => l.state !== 'stopped');
  }

  /**
   * Makes the crops that are due; returns when to look again (null: nothing pending). `force`: a session that just
   * paused or stopped gets its crop now, without waiting for the pen-idle rule.
   */
  async tick(force?: string): Promise<number | null> {
    const cfg = lectureCfg(this.env);
    const changed = this.r.kvGet<Record<string, number>>('changed') ?? {};
    const lastUpdate = this.r.kvGet<number>('lastClientUpdateAt') ?? 0;
    let next: number | null = null;
    for (const [sid, info] of Object.entries(this.lectures())) {
      const st = this.r.kvGet<CropState>(`lecture:${sid}`);
      if (!st || st.flushed) continue;
      const ids = Object.entries(changed).filter(([, at]) => at > st.deliveredAt).map(([id]) => id);
      if (!ids.length) {
        if (info.state === 'stopped') this.r.kvPut(`lecture:${sid}`, { ...st, flushed: true });
        continue;
      }
      const t = now();
      const ready = force === sid || info.state !== 'recording' ? t : Math.max(lastUpdate + cfg.idleMs, st.lastCropAt + cfg.minIntervalMs);
      if (t < ready) {
        next = next === null ? ready : Math.min(next, ready);
        continue;
      }
      try {
        await this.crop(sid, info, st, ids, t);
      } catch (e) {
        console.error(`lecture crop failed (${sid})`, e);
      }
    }
    return next;
  }

  private async crop(sid: string, info: LectureInfo, st: CropState, pageIds: string[], at: number): Promise<void> {
    const nb = new Notebook(this.r.doc);
    const live = new Set(nb.pages().map((p) => p.id));
    const pages: Record<string, Page> = {};
    await Promise.all(
      pageIds.filter((id) => live.has(id)).map(async (id) => {
        const docId = pgDocId(this.notebookId, id);
        const doc = new Y.Doc();
        Y.applyUpdate(doc, await room(this.env, docId).getState(docId));
        migratePage(doc);
        pages[id] = new Page(doc);
      }),
    );
    const regions = this.r.kvGet<QinkRegions>('regions') ?? emptyRegions();
    const prev: Record<string, InkSeen | undefined> = {};
    for (const id of Object.keys(pages)) prev[id] = this.r.kvGet<InkSeen>(inkKey(sid, id));
    const u = encodeQinkUpdate(nb, pages, regions, prev, { session: sessionOf(this.notebookId), rev: st.rev + 1, client: cropClient(sid), threads: emptyThreads(), seen: {} });
    this.r.kvPut('regions', regions);
    for (const [id, ink] of Object.entries(u.ink)) this.r.kvPut(inkKey(sid, id), ink);
    const text = u.text.split('\n').filter((l) => CROP_LINE.test(l)).join('\n');
    const next: CropState = { ...st, deliveredAt: at, ...(info.state === 'stopped' ? { flushed: true } : {}) };
    if (!text.includes('\nR')) {
      this.r.kvPut(`lecture:${sid}`, next);
      return;
    }
    let crop: LectureCrop = { t: info.lastT, sha: '', w: 0, h: 0, text, regions: parseCropRegions(text) };
    if (u.image?.rows.length) {
      const png = await svgToPng(renderRegionsSvg(pages, u.image.rows).svg);
      const sha = await sha256Hex(png.png);
      await this.storeAsset(sha, png.png);
      crop = { ...crop, sha, w: png.width, h: png.height };
    }
    const docId = lecDocId(this.notebookId, sid);
    await room(this.env, docId).addLectureCrop(docId, crop);
    this.r.kvPut(`lecture:${sid}`, { ...next, rev: st.rev + 1, lastCropAt: now() });
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

// ---- HTTP ----

/** Workers AI, or the test double (tests can't reach Workers AI). */
type AiRun = (model: string, input: Record<string, unknown>) => Promise<unknown>;
let testAi: AiRun | false | null = null;
/** Tests: a fake model, `false` for "no AI binding", or null for the real binding. */
export function setTestAi(fn: AiRun | false | null): void {
  testAi = fn;
}

const AUDIO_TYPES = /^audio\/(webm|ogg|mp4|m4a|x-m4a|aac|mpeg|mp3|wav|x-wav)\b/;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

interface WhisperWord { word?: string; start?: number; end?: number }
interface WhisperSegment { start?: number; end?: number; text?: string; words?: WhisperWord[] }
interface WhisperOut { text?: string; segments?: WhisperSegment[]; transcription_info?: { duration?: number } }

const monthStart = (t: number) => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
};

async function usedMs(env: Env, userId: string, t: number): Promise<number> {
  const r = await env.DB.prepare('SELECT COALESCE(SUM(ms), 0) AS ms FROM transcribe_usage WHERE user_id = ?1 AND at >= ?2').bind(userId, monthStart(t)).first<{ ms: number }>();
  return r?.ms ?? 0;
}

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
  const ai: AiRun | null = testAi === false ? null : (testAi ?? (env.AI ? (model, input) => env.AI!.run(model as never, input as never) : null));
  if (!ai) throw new HttpError(503, 'Cloud transcription is not set up on this server');
  const type = (req.headers.get('Content-Type') ?? '').toLowerCase();
  if (!AUDIO_TYPES.test(type)) throw new HttpError(415, 'Send one audio chunk (audio/webm, audio/ogg, audio/mp4, audio/mpeg or audio/wav)');
  const len = Number(req.headers.get('Content-Length') ?? NaN);
  if (Number.isFinite(len) && len > MAX_AUDIO_BYTES) throw new HttpError(413, 'Audio chunk too large (max 8 MB)');

  const t = now();
  const perMinute = num(env.TRANSCRIBE_PER_MINUTE, 6);
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM transcribe_usage WHERE user_id = ?1 AND at > ?2').bind(userId, t - 60_000).first<{ n: number }>();
  if ((recent?.n ?? 0) >= perMinute) return json({ error: 'Too many transcription requests. Try again in a minute.', code: 'rate_limited' }, 429, { 'Retry-After': '60' });
  const limitMinutes = num(env.TRANSCRIBE_MINUTES_PER_MONTH, 600);
  const used = await usedMs(env, userId, t);
  if (used >= limitMinutes * 60_000) {
    return json({ error: `You've used this month's ${limitMinutes} minutes of cloud transcription.`, code: 'transcribe_quota', usedMinutes: Math.round(used / 60_000), limitMinutes }, 402);
  }

  const body = new Uint8Array(await req.arrayBuffer());
  if (!body.length) throw new HttpError(400, 'Empty audio');
  if (body.length > MAX_AUDIO_BYTES) throw new HttpError(413, 'Audio chunk too large (max 8 MB)');
  // Counted before the model runs, so concurrent requests hit the rate limit; the real length is written after.
  const declared = Math.max(0, Math.min(10 * 60_000, num(req.headers.get('X-Audio-Duration-Ms') ?? undefined, 0)));
  const row = await env.DB.prepare('INSERT INTO transcribe_usage (user_id, at, ms) VALUES (?1, ?2, ?3) RETURNING id').bind(userId, t, declared).first<{ id: number }>();
  const lang = new URL(req.url).searchParams.get('lang');
  let out: WhisperOut;
  try {
    out = (await ai(MODEL, { audio: b64(body), task: 'transcribe', vad_filter: true, ...(lang && /^[a-z]{2}$/.test(lang) ? { language: lang } : {}) })) as WhisperOut;
  } catch (e) {
    console.error('whisper failed', e);
    await env.DB.prepare('DELETE FROM transcribe_usage WHERE id = ?1').bind(row!.id).run();
    throw new HttpError(502, 'Transcription failed; it will be retried');
  }
  const durationMs = Math.max(declared, Math.round((out.transcription_info?.duration ?? 0) * 1000));
  await env.DB.prepare('UPDATE transcribe_usage SET ms = ?2 WHERE id = ?1').bind(row!.id, durationMs).run();
  return json({ segments: whisperSegments(out), durationMs, usedMinutes: Math.round((used + durationMs) / 60_000), limitMinutes });
}

/** Deletes one session: its room (and doc_sizes row), its audio and crop assets, and its entry in the notebook room. */
export async function deleteLecture(env: Env, userId: string, notebookId: string, sessionId: string): Promise<void> {
  const docId = lecDocId(notebookId, sessionId);
  const stub = room(env, docId);
  const shas = await stub.lectureAssets(docId);
  await stub.purge(docId);
  await env.DB.prepare('DELETE FROM sync_tickets WHERE doc_id = ?1').bind(docId).run();
  for (let i = 0; i < shas.length; i += 50) {
    const part = shas.slice(i, i + 50);
    const marks = part.map((_, j) => `?${j + 2}`).join(',');
    // R2 objects no one else holds go; the user's rows go either way.
    const shared = (
      await env.DB.prepare(`SELECT DISTINCT sha256 FROM user_assets WHERE user_id != ?1 AND sha256 IN (${marks})`).bind(userId, ...part).all<{ sha256: string }>()
    ).results.map((r) => r.sha256);
    await env.DB.prepare(`DELETE FROM user_assets WHERE user_id = ?1 AND sha256 IN (${marks})`).bind(userId, ...part).run();
    const gone = part.filter((s) => !shared.includes(s));
    if (gone.length) await env.ASSETS.delete(gone);
  }
  await room(env, nbDocId(notebookId)).lectureRemoved(nbDocId(notebookId), sessionId);
}
