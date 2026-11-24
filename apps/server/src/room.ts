import { DurableObject } from 'cloudflare:workers';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { AI_LIVE, AI_LIVE_TTL_MS, AI_PAUSE, AI_PAUSED, AI_PLAY, AI_PLAYING, AI_RESUME, AI_STOP, LectureDoc, Notebook, inkSig, Page, inkInBox, migratePage, summarizeThreads, type LectureCrop, type LectureMeta, type ThreadSummary, type TranscriptSegment } from '@qalm/core';
import { num, type Env } from './env';
import { parseDocId, nbDocId, pgDocId, lecDocId, room, type DocRef } from './docs';
import { LectureCrops, lectureCfg, recordLectureAssets, type BaseSeen, type LectureInfo } from './lecture';
import { AgentHub, type AgentConfig, type AgentResult, type AgentEdit, type AgentWho, type PageEdit, type Presence } from './agent';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_QUERY_AWARENESS = 3;

/** Updates kept before they are folded into one snapshot. */
export const COMPACT_EVERY = 200;
/** Snapshot chunk size (SQLite rows in a Durable Object are limited to 2 MB). */
const CHUNK = 1 << 20;
/** How long after a write the room reports its stored size to D1 (doc_sizes), so bursts of strokes cost one write. */
export const SIZE_REPORT_DELAY_MS = 5_000;

interface Attachment {
  userId: string;
  /** Awareness client ids announced on this socket, with their last clock. */
  aw: Record<string, number>;
  /** Notebook rooms: this socket's device is playing AI sharing until then (ms; see core aiLive.ts). */
  liveUntil?: number;
}

/** Whether Yjs type `t` is `root` or nested inside it. */
function isUnder(t: Y.AbstractType<any>, root: Y.AbstractType<any>): boolean {
  for (let x: Y.AbstractType<any> | null = t; x; x = (x._item?.parent as Y.AbstractType<any> | undefined) ?? null) if (x === root) return true;
  return false;
}

const isSocket = (o: unknown): o is WebSocket => typeof o === 'object' && o !== null && 'send' in o && 'serializeAttachment' in o;

/**
 * One Yjs document (`nb:`, `pg:` or `lib:`): sync + awareness over hibernating WebSockets, persisted in
 * SQLite storage as a snapshot plus an update log that is compacted every 200 updates.
 * Notebook rooms also hold Q-ink labels and per-agent state (see agent.ts).
 */
export class DocRoom extends DurableObject<Env> {
  doc = new Y.Doc({ gc: true });
  private sql: SqlStorage;
  private updateCount = 0;
  /** Bytes this doc takes in storage: snapshot parts plus the update log (what counts towards the owner's cap). */
  private storedBytes = 0;
  private sizeAlarm = false;
  private docId: string | null = null;
  private ref: DocRef | null = null;
  private hub: AgentHub | null = null;
  private crops: LectureCrops | null = null;
  /** When the notebook room should next look for lecture crops (alarms are shared with the size report). */
  private lectureDue: number | null = null;
  private syncedMeta = '';
  /** A client's transaction touched this page's comments (set just before the update event reports it). */
  private commentTouched = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    // Client heartbeat (app sync provider): answered by the runtime, so it never wakes a hibernating room.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    this.createTables();
    this.load();
    const id = this.kvGet<string>('docId');
    if (id) this.setDocId(id);
    this.listen();
  }

  private listen(): void {
    const comments = this.doc.getMap('comments');
    // afterTransaction runs before the transaction's 'update' event, so onClientUpdate sees the flag.
    this.doc.on('afterTransaction', (tx: Y.Transaction) => {
      if (isSocket(tx.origin) && [...tx.changed.keys()].some((t) => isUnder(t, comments))) this.commentTouched = true;
    });
    this.doc.on('update', (update: Uint8Array, origin: unknown) => this.onUpdate(update, origin));
  }

  // ---- storage ----

  private createTables(): void {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS updates (seq INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS snapshot (part INTEGER PRIMARY KEY, data BLOB NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
  }

  kvGet<T>(k: string): T | undefined {
    const row = this.sql.exec<{ v: string }>('SELECT v FROM kv WHERE k = ?', k).toArray()[0];
    return row ? (JSON.parse(row.v) as T) : undefined;
  }

  kvPut(k: string, v: unknown): void {
    this.sql.exec('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, JSON.stringify(v));
  }

  private load(): void {
    const parts = this.sql.exec<{ data: ArrayBuffer }>('SELECT data FROM snapshot ORDER BY part').toArray();
    if (parts.length) {
      const total = parts.reduce((n, p) => n + p.data.byteLength, 0);
      const buf = new Uint8Array(total);
      let o = 0;
      for (const p of parts) {
        buf.set(new Uint8Array(p.data), o);
        o += p.data.byteLength;
      }
      Y.applyUpdate(this.doc, buf, 'load');
      this.storedBytes = total;
    }
    const ups = this.sql.exec<{ data: ArrayBuffer }>('SELECT data FROM updates ORDER BY seq').toArray();
    for (const u of ups) {
      Y.applyUpdate(this.doc, new Uint8Array(u.data), 'load');
      this.storedBytes += u.data.byteLength;
    }
    this.updateCount = ups.length;
  }

  private compact(): void {
    const state = Y.encodeStateAsUpdate(this.doc);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM snapshot');
      for (let i = 0, part = 0; i < state.length; i += CHUNK, part++) {
        this.sql.exec('INSERT INTO snapshot (part, data) VALUES (?, ?)', part, state.subarray(i, i + CHUNK));
      }
      this.sql.exec('DELETE FROM updates');
    });
    this.updateCount = 0;
    this.storedBytes = state.length;
  }

  // ---- stored size (storage cap) ----

  /** Schedules one size report a few seconds out; later writes before it fires ride along. */
  private sizeChanged(): void {
    if (this.sizeAlarm) return;
    this.sizeAlarm = true;
    this.ctx.storage.setAlarm(Date.now() + SIZE_REPORT_DELAY_MS).catch((e: unknown) => {
      this.sizeAlarm = false;
      console.error('setAlarm failed', e);
    });
  }

  override async alarm(): Promise<void> {
    this.sizeAlarm = false;
    await this.reportSize();
    if (this.ref?.kind === 'nb') {
      this.lectureDue = null;
      const next = await this.lectureCrops().tick();
      if (next !== null) this.scheduleLecture(next);
    }
  }

  /** Asks for an alarm at `at` for lecture crops (an earlier pending alarm is kept). */
  private scheduleLecture(at: number): void {
    if (this.lectureDue !== null && this.lectureDue <= at) return;
    this.lectureDue = at;
    this.ctx.storage
      .getAlarm()
      .then((cur) => (cur === null || cur > at ? this.ctx.storage.setAlarm(at) : undefined))
      .catch((e: unknown) => console.error('setAlarm failed', e));
  }

  /** The user whose cap this doc counts against: the library's user, or the notebook's owner. */
  private async ownerId(): Promise<string | null> {
    const ref = this.ref;
    if (!ref) return null;
    if (ref.kind === 'lib') return ref.userId;
    const row = await this.env.DB.prepare('SELECT owner_id FROM notebooks WHERE id = ?1').bind(ref.notebookId).first<{ owner_id: string }>();
    return row?.owner_id ?? null;
  }

  /** Writes this doc's stored size to D1 (doc_sizes) if it changed since the last report. */
  async reportSize(): Promise<number> {
    const bytes = this.storedBytes;
    if (!this.docId || this.kvGet<number>('reportedBytes') === bytes) return bytes;
    const owner = await this.ownerId();
    if (!owner) return bytes;
    await this.env.DB.prepare(
      'INSERT INTO doc_sizes (doc_id, user_id, bytes, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(doc_id) DO UPDATE SET user_id = excluded.user_id, bytes = excluded.bytes, updated_at = excluded.updated_at',
    )
      .bind(this.docId, owner, bytes, Date.now())
      .run();
    this.kvPut('reportedBytes', bytes);
    return bytes;
  }

  private onUpdate(update: Uint8Array, origin: unknown): void {
    if (origin === 'load') return;
    if (update.byteLength > CHUNK) this.compact();
    else {
      this.sql.exec('INSERT INTO updates (data) VALUES (?)', update);
      this.storedBytes += update.byteLength;
      if (++this.updateCount >= COMPACT_EVERY) this.compact();
    }
    this.sizeChanged();
    const msg = encoding.createEncoder();
    encoding.writeVarUint(msg, MSG_SYNC);
    syncProtocol.writeUpdate(msg, update);
    this.broadcast(encoding.toUint8Array(msg), origin);
    if (isSocket(origin)) this.onClientUpdate();
  }

  /** Number of updates in the log (for tests). */
  pendingUpdates(): number {
    return this.updateCount;
  }

  // ---- identity ----

  private setDocId(docId: string): void {
    if (this.docId === docId) return;
    if (this.docId && this.docId !== docId) throw new Error(`Room ${this.docId} addressed as ${docId}`);
    const ref = parseDocId(docId);
    if (!ref) throw new Error(`Bad doc id ${docId}`);
    this.docId = docId;
    this.ref = ref;
    if (this.kvGet<string>('docId') !== docId) this.kvPut('docId', docId);
  }

  private lectureCrops(): LectureCrops {
    if (this.ref?.kind !== 'nb') throw new Error('Lecture crops live in notebook rooms');
    return (this.crops ??= new LectureCrops(this, this.env, this.ref.notebookId));
  }

  private agents(): AgentHub {
    if (this.ref?.kind !== 'nb') throw new Error('Agent calls go to notebook rooms');
    return (this.hub ??= new AgentHub(this, this.env, this.ref.notebookId));
  }

  // ---- client updates ----

  private onClientUpdate(): void {
    const ref = this.ref;
    if (!ref) return;
    const at = Date.now();
    if (ref.kind === 'pg') {
      const comment = this.commentTouched;
      this.commentTouched = false;
      // A student's comment or reply: the notebook room mirrors this page's threads into its thread index.
      const threads = comment ? this.threadSummaries(ref.pageId) : undefined;
      room(this.env, nbDocId(ref.notebookId))
        .pageChanged(nbDocId(ref.notebookId), ref.pageId, at, comment, threads)
        .catch((e: unknown) => console.error('pageChanged failed', e));
    } else if (ref.kind === 'nb') {
      this.agents().onIndexChanged();
      this.syncNotebookRow(ref.notebookId);
    } else if (ref.kind === 'lec') {
      // The notebook room keeps each session's state: crops while it records, transcript lines for agents.
      const lec = new LectureDoc(this.doc);
      const m = lec.meta();
      const info: LectureInfo = { state: m.state, startedAt: m.startedAt, durationMs: m.durationMs, lastT: m.lastT, count: lec.transcriptCount(), ...(m.title ? { title: m.title } : {}) };
      room(this.env, nbDocId(ref.notebookId))
        .lectureChanged(nbDocId(ref.notebookId), ref.sessionId, info)
        .catch((e: unknown) => console.error('lectureChanged failed', e));
      this.recordAssets(lec).catch((e: unknown) => console.error('recordLectureAssets failed', e));
    }
  }

  /** Session room: the assets its doc references go into `lecture_assets` (only the new ones). */
  private async recordAssets(lec: LectureDoc): Promise<void> {
    if (!this.docId) return;
    const known = new Set(this.kvGet<string[]>('assetRefs') ?? []);
    const fresh = lec.assetShas().filter((s) => s && !known.has(s));
    if (!fresh.length) return;
    const owner = await this.ownerId();
    if (!owner) return;
    await recordLectureAssets(this.env, this.docId, owner, fresh);
    this.kvPut('assetRefs', [...new Set([...(this.kvGet<string[]>('assetRefs') ?? []), ...fresh])]);
  }

  /** Keeps `notebooks.title` / `ai_access` in D1 in step with the index doc. */
  private syncNotebookRow(notebookId: string): void {
    const meta = new Notebook(this.doc).meta();
    const key = JSON.stringify([meta.title ?? '', !!meta.aiAccess]);
    if (key === this.syncedMeta) return;
    this.syncedMeta = key;
    this.ctx.waitUntil(
      this.env.DB.prepare('UPDATE notebooks SET title = ?2, ai_access = ?3, updated_at = ?4 WHERE id = ?1')
        .bind(notebookId, meta.title ?? '', meta.aiAccess === true ? 1 : 0, Date.now())
        .run()
        .catch((e: unknown) => {
          // Retry on the next update.
          if (this.syncedMeta === key) this.syncedMeta = '';
          console.error('notebook row sync failed', e);
        }),
    );
  }

  // ---- WebSocket (hibernation API) ----

  override async fetch(req: Request): Promise<Response> {
    const docId = req.headers.get('X-Doc-Id');
    const userId = req.headers.get('X-User-Id');
    if (!docId || !userId || req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
    this.setDocId(docId);
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ userId, aw: {} } satisfies Attachment);

    const step1 = encoding.createEncoder();
    encoding.writeVarUint(step1, MSG_SYNC);
    syncProtocol.writeSyncStep1(step1, this.doc);
    server.send(encoding.toUint8Array(step1));
    // Ask the others to re-announce their awareness so the newcomer sees them.
    const q = encoding.createEncoder();
    encoding.writeVarUint(q, MSG_QUERY_AWARENESS);
    this.broadcast(encoding.toUint8Array(q), server);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === 'string') return this.onText(ws, message);
    const data = new Uint8Array(message);
    try {
      const decoder = decoding.createDecoder(data);
      const type = decoding.readVarUint(decoder);
      if (type === MSG_SYNC) {
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MSG_SYNC);
        syncProtocol.readSyncMessage(decoder, encoder, this.doc, ws);
        if (encoding.length(encoder) > 1) ws.send(encoding.toUint8Array(encoder));
      } else if (type === MSG_AWARENESS) {
        this.trackAwareness(ws, decoding.readVarUint8Array(decoder));
        this.broadcast(data, ws);
      } else if (type === MSG_QUERY_AWARENESS) {
        this.broadcast(data, ws);
      }
    } catch (e) {
      console.error('bad sync message', e);
      ws.close(1003, 'Bad message');
    }
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.dropAwareness(ws);
    this.dropLive(ws);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'closed');
    } catch {
      /* already closed */
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.dropAwareness(ws);
    this.dropLive(ws);
  }

  // ---- AI sharing liveness (Play / Pause AI; core aiLive.ts) ----

  /**
   * Until when this notebook is live for agents (ms), or 0 when it isn't: the latest Play heartbeat of any open socket
   * (each is one of the owner's devices or tabs; sync tickets only go to the owner). Never stored or synced, so a
   * restarted room, a closed socket or a device that stopped sending is paused.
   */
  liveUntil(): number {
    if (this.ref?.kind !== 'nb') return 0;
    let until = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.liveUntil && a.liveUntil > until) until = a.liveUntil;
    }
    return until > Date.now() ? until : 0;
  }

  private onText(ws: WebSocket, message: string): void {
    if (this.ref?.kind !== 'nb' || !message.startsWith('ai:')) return;
    const was = this.liveUntil() > 0;
    const att = ws.deserializeAttachment() as Attachment;
    const live = (on: boolean) => ws.serializeAttachment({ ...att, liveUntil: on ? Date.now() + num(this.env.AI_LIVE_TTL_MS, AI_LIVE_TTL_MS) : 0 });
    const reply = (m: string) => {
      try {
        ws.send(m);
      } catch {
        /* closing */
      }
    };
    // Every Pause bumps the epoch (stored: Pause is rare, and a restarted room must still refuse a stale resume).
    const epoch = this.kvGet<number>('aiPauseEpoch') ?? 0;
    if (message === AI_PLAY) {
      live(true);
      reply(`${AI_PLAYING}${epoch}`);
    } else if (message === AI_LIVE) {
      // Only keeps a live socket live: a heartbeat that crossed a Pause, or one after the socket expired, does nothing.
      if ((att.liveUntil ?? 0) > Date.now()) live(true);
      else reply(AI_PAUSED);
    } else if (message.startsWith(AI_RESUME)) {
      // A reconnect: live again only if nobody pressed Pause since this device's Play.
      if (Number(message.slice(AI_RESUME.length)) === epoch) {
        live(true);
        reply(`${AI_PLAYING}${epoch}`);
      } else reply(AI_PAUSED);
    } else if (message === AI_STOP) {
      // This device alone (backgrounded, notebook closing): other devices keep playing.
      live(false);
    } else if (message === AI_PAUSE) {
      // Pause on one device pauses them all, and the others' editors switch to paused.
      this.kvPut('aiPauseEpoch', epoch + 1);
      for (const s of this.ctx.getWebSockets()) {
        const a = s.deserializeAttachment() as Attachment | null;
        if (a?.liveUntil) s.serializeAttachment({ ...a, liveUntil: 0 });
        if (s !== ws) {
          try {
            s.send(AI_PAUSED);
          } catch {
            /* closing */
          }
        }
      }
    }
    if (was !== this.liveUntil() > 0) this.agents().onLiveChanged();
  }

  /** A socket that closes stops its device's sharing at once. */
  private dropLive(ws: WebSocket): void {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att?.liveUntil) return;
    ws.serializeAttachment({ ...att, liveUntil: 0 });
    if (this.ref?.kind === 'nb') this.agents().onLiveChanged();
  }

  private broadcast(msg: Uint8Array, except?: unknown): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try {
        ws.send(msg);
      } catch {
        /* closing */
      }
    }
  }

  /** Records which awareness client ids live on this socket, so they can be removed when it closes. */
  private trackAwareness(ws: WebSocket, update: Uint8Array): void {
    const att = ws.deserializeAttachment() as Attachment;
    const d = decoding.createDecoder(update);
    const n = decoding.readVarUint(d);
    for (let i = 0; i < n; i++) {
      const id = String(decoding.readVarUint(d));
      const clock = decoding.readVarUint(d);
      const state = decoding.readVarString(d);
      if (state === 'null') delete att.aw[id];
      else att.aw[id] = clock;
    }
    ws.serializeAttachment(att);
  }

  private dropAwareness(ws: WebSocket): void {
    const att = ws.deserializeAttachment() as Attachment | null;
    const ids = Object.entries(att?.aw ?? {});
    if (!ids.length) return;
    const u = encoding.createEncoder();
    encoding.writeVarUint(u, ids.length);
    for (const [id, clock] of ids) {
      encoding.writeVarUint(u, Number(id));
      encoding.writeVarUint(u, clock + 1);
      encoding.writeVarString(u, 'null');
    }
    const msg = encoding.createEncoder();
    encoding.writeVarUint(msg, MSG_AWARENESS);
    encoding.writeVarUint8Array(msg, encoding.toUint8Array(u));
    this.broadcast(encoding.toUint8Array(msg), ws);
    ws.serializeAttachment({ ...att!, aw: {} });
  }

  // ---- RPC ----

  /** Notebook room: purges every page room it knows of, then itself ("Delete forever"). */
  async purgeNotebook(docId: string): Promise<void> {
    this.setDocId(docId);
    if (this.ref?.kind !== 'nb') throw new Error('Not a notebook room');
    const notebookId = this.ref.notebookId;
    const pageIds = new Set([...new Notebook(this.doc).pages().map((p) => p.id), ...Object.keys(this.kvGet<Record<string, number>>('changed') ?? {})]);
    await Promise.all(
      [...pageIds].map(async (pid) => {
        const id = pgDocId(notebookId, pid);
        await room(this.env, id).purge(id);
      }),
    );
    // Its lecture sessions too.
    await Promise.all(
      Object.keys(this.kvGet<Record<string, unknown>>('lectures') ?? {}).map(async (sid) => {
        const id = lecDocId(notebookId, sid);
        await room(this.env, id).purge(id);
      }),
    );
    await this.purge(docId);
  }

  /** Closes every socket and deletes this room's storage. The in-memory doc goes when the object is evicted. */
  async purge(docId: string): Promise<void> {
    this.setDocId(docId);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(4404, 'deleted');
      } catch {
        /* closing */
      }
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    this.createTables();
    this.kvPut('docId', docId);
    this.updateCount = 0;
    this.storedBytes = 0;
    this.sizeAlarm = false;
    await this.env.DB.prepare('DELETE FROM doc_sizes WHERE doc_id = ?1').bind(docId).run();
    this.hub = null;
    this.crops = null;
    this.lectureDue = null;
    this.doc.destroy();
    this.doc = new Y.Doc({ gc: true });
    this.listen();
  }

  /** The whole doc as one Yjs update. */
  getState(docId: string): Uint8Array {
    this.setDocId(docId);
    return Y.encodeStateAsUpdate(this.doc);
  }

  /** Page room → notebook room, on every client update of a page. */
  pageChanged(docId: string, pageId: string, at: number, comment = false, threads?: ThreadSummary[]): void {
    this.setDocId(docId);
    if (threads?.length) this.putThreads(threads);
    this.agents().onPageChanged(pageId, at, comment);
    // A session recording here gets its crop once the pen rests (the agent wake rules): look again then.
    if (this.lectureCrops().live().length) this.scheduleLecture(at + lectureCfg(this.env).idleMs);
  }

  // ---- lecture mode (docs/lecture-mode.md) ----

  /** Session room → notebook room, on each client update of the session doc. */
  async lectureChanged(docId: string, sessionId: string, info: LectureInfo): Promise<void> {
    this.setDocId(docId);
    const r = this.lectureCrops().update(sessionId, info);
    if (r.ignored) return; // deleted: a device re-syncing its copy changes nothing here
    if (r.grew) this.agents().onLectureChanged();
    if (r.flush) {
      const next = await this.lectureCrops().tick(sessionId);
      if (next !== null) this.scheduleLecture(next);
    } else if (info.state !== 'stopped') this.scheduleLecture(Date.now() + lectureCfg(this.env).idleMs); // crops, expiry
  }

  /** Notebook room: every session it has heard of (for "Delete forever"). */
  lectureIds(docId: string): string[] {
    this.setDocId(docId);
    return Object.keys(this.kvGet<Record<string, unknown>>('lectures') ?? {});
  }

  /** A session was deleted (DELETE /lectures/…). */
  lectureRemoved(docId: string, sessionId: string): void {
    this.setDocId(docId);
    this.lectureCrops().remove(sessionId);
  }

  /** Session room: meta, transcript and crops (MCP read). */
  lectureData(docId: string): { meta: LectureMeta; transcript: TranscriptSegment[]; crops: LectureCrop[] } {
    this.setDocId(docId);
    const lec = new LectureDoc(this.doc);
    return { meta: lec.meta(), transcript: lec.transcript(), crops: lec.crops() };
  }

  /**
   * Session room: transcript segments in arrival order from `from`, at most `max` (live MCP lines). `next` is past
   * all of them; `restT0` is the earliest time among those left out (chunks can arrive out of order), or null.
   */
  lectureTranscript(docId: string, from: number, max?: number): { segs: TranscriptSegment[]; next: number; restT0: number | null } {
    this.setDocId(docId);
    const all = new LectureDoc(this.doc).transcriptFrom(from);
    if (max === undefined || all.segs.length <= max) return { ...all, restT0: null };
    const rest = all.segs.slice(max);
    return { segs: all.segs.slice(0, max), next: all.next, restT0: Math.min(...rest.map((s) => s.t0)) };
  }

  /**
   * Session room: each page's ink at the session start, from its `base` event (ids), with the earliest copy of any
   * base item the session later erased or changed (its signature as it was then). Pages without a base: left out.
   */
  lectureBaseSeen(docId: string, pageIds: string[]): Record<string, BaseSeen> {
    this.setDocId(docId);
    const want = new Set(pageIds);
    const out: Record<string, BaseSeen> = {};
    for (const e of new LectureDoc(this.doc).events()) {
      if (e.k === 'base' && want.has(e.p) && !out[e.p]) out[e.p] = { ids: [...e.ids], early: {} };
      if ((e.k === 'erase' || e.k === 'update') && out[e.p]) {
        const b = out[e.p]!;
        const base = new Set(b.ids);
        const olds = e.k === 'update' ? (e.before ?? []) : e.items;
        for (const it of olds) if (base.has(it.id) && !(it.id in b.early)) b.early[it.id] = inkSig(it);
      }
    }
    return out;
  }

  /** Notebook room: the shas of its page assets (PDFs, images). */
  notebookAssetShas(docId: string): string[] {
    this.setDocId(docId);
    return new Notebook(this.doc).assets().map((a) => a.sha256).filter(Boolean);
  }

  /** Session room: every asset it holds (audio, crop PNGs), for deletion. */
  lectureAssets(docId: string): string[] {
    this.setDocId(docId);
    return new LectureDoc(this.doc).assetShas();
  }

  /** Session room: the notebook room's crop (server origin: not reported back as a client update). */
  addLectureCrop(docId: string, crop: LectureCrop): void {
    this.setDocId(docId);
    if (this.ref?.kind !== 'lec') throw new Error('Not a lecture room');
    const lec = new LectureDoc(this.doc);
    lec.addCrop(crop);
    this.recordAssets(lec).catch((e: unknown) => console.error('recordLectureAssets failed', e));
  }

  /** Notebook room: writes thread summaries from a page room into the index doc's thread index (see Notebook.putThreads). */
  putThreads(threads: ThreadSummary[]): void {
    if (this.ref?.kind !== 'nb') throw new Error('Not a notebook room');
    new Notebook(this.doc).putThreads(threads);
  }

  /** Page room: the summaries of this page's threads, for the notebook's thread index. */
  private threadSummaries(pageId: string): ThreadSummary[] {
    const page = new Page(this.doc);
    return summarizeThreads(pageId, page.comments(), page.readings());
  }

  lastClientUpdateAt(docId: string): number {
    this.setDocId(docId);
    return this.agents().lastClientUpdateAt();
  }

  /** Null while agents may use this notebook, else the message they should get (AI access off, or paused). */
  agentLiveError(docId: string): string | null {
    this.setDocId(docId);
    try {
      this.agents().requireLive();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  /**
   * For the session list: the live AI access switch (unknown → off), whether it is playing, the last client update,
   * and a recording lecture (`lecture L2 recording 12:40`, only while live; else null).
   */
  agentInfo(docId: string): { aiAccess: boolean; live: boolean; at: number; lecture: string | null } {
    this.setDocId(docId);
    const a = this.agents();
    return { aiAccess: a.aiAccess(), live: a.isLive(), at: a.lastClientUpdateAt(), lecture: a.liveLecture() };
  }

  /** For the editor's presence pill (GET /ai/presence). */
  agentPresence(docId: string): Presence {
    this.setDocId(docId);
    return this.agents().presence();
  }

  async agentWait(docId: string, who: AgentWho, session: string, cfg: AgentConfig, waitId?: string): Promise<AgentResult> {
    this.setDocId(docId);
    try {
      return await this.agents().wait(who, session, cfg, waitId);
    } catch (e) {
      return { text: e instanceof Error ? e.message : String(e), svg: null, changed: false, error: true };
    }
  }

  /** The MCP client of wait `waitId` disconnected: end that wait without delivering. */
  agentCancel(docId: string, waitId: string): void {
    this.setDocId(docId);
    this.agents().cancel(waitId);
  }

  async agentRead(docId: string, ref: string, who: AgentWho): Promise<AgentResult> {
    this.setDocId(docId);
    try {
      return await this.agents().read(ref, who);
    } catch (e) {
      return { text: e instanceof Error ? e.message : String(e), svg: null, changed: false, error: true };
    }
  }

  /** Expected failures (bad ref, line gone) come back as `{ ok: false }` rather than RPC exceptions. */
  async agentEdit(docId: string, edit: AgentEdit, who: AgentWho): Promise<{ ok: boolean; text: string }> {
    this.setDocId(docId);
    try {
      return { ok: true, text: await this.agents().edit(edit, who) };
    } catch (e) {
      return { ok: false, text: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Notebook room → page room: an agent's transcription, comment or reply. Agents never touch ink. */
  /**
   * `gate` (the notebook room's doc id): its `requireLive()` is asked right before the write. Nothing awaits between that
   * answer and the (synchronous) write, so a comment or reading never lands after the student paused.
   */
  async applyAgentEdit(docId: string, edit: PageEdit, gate?: string): Promise<{ ok: boolean; text: string; id?: string; threads?: ThreadSummary[] }> {
    try {
      const closed = gate ? await room(this.env, gate).agentLiveError(gate) : null;
      if (closed) return { ok: false, text: closed };
      return { ok: true, ...this.applyAgentEditOrThrow(docId, edit) };
    } catch (e) {
      return { ok: false, text: e instanceof Error ? e.message : String(e) };
    }
  }

  private applyAgentEditOrThrow(docId: string, edit: PageEdit): { text: string; id?: string; threads?: ThreadSummary[] } {
    this.setDocId(docId);
    if (this.ref?.kind !== 'pg') throw new Error('Not a page room');
    migratePage(this.doc); // a page nobody has opened since regions (the app migrates on load too)
    const page = new Page(this.doc);
    if (edit.op === 'reply') {
      if (!page.replyToComment(edit.commentId, { kind: 'agent', name: edit.agentName }, edit.text)) throw new Error(`Thread ${edit.ref} no longer exists`);
      if (edit.resolve) page.resolveComment(edit.commentId);
      return { text: `Replied in ${edit.ref}${edit.resolve ? ' and resolved it' : ''}`, threads: this.threadSummaries(this.ref.pageId) };
    }
    const items = page.items();
    const onPage = new Set(items.map((i) => i.id));
    // A region's strokes still on the page, or the ink in a box.
    const ids = edit.ids ? edit.ids.filter((id) => onPage.has(id)) : edit.box ? inkInBox(items, edit.box) : [];
    if (edit.op === 'transcribe') {
      if (!ids.length) throw new Error(`There is no ink in ${edit.ref} any more; read the page for what is there now`);
      if (page.readings().some((r) => r.src === 'user' && r.ids.some((id) => ids.includes(id)))) {
        throw new Error(`The student wrote their own reading of ${edit.ref}; leave a comment instead`);
      }
      page.setReading(ids, edit.text, 'agent', edit.agentName);
      return { text: `Saved ${edit.ref}` };
    }
    // A thread on strokes follows them; the box is where it sits if they are all erased (or there were none).
    const id = page.addComment({ author: { kind: 'agent', name: edit.agentName }, text: edit.text, ...(ids.length ? { anchorIds: ids } : {}), ...(edit.box ? { anchor: edit.box } : {}) });
    return { text: `Commented on ${edit.ref}`, id, threads: this.threadSummaries(this.ref.pageId) };
  }
}
