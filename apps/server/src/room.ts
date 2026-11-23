import { DurableObject } from 'cloudflare:workers';
import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { Notebook, Page } from '@qalm/core';
import type { Env } from './env';
import { parseDocId, nbDocId, room, type DocRef } from './docs';
import { AgentHub, type AgentConfig, type AgentResult, type AgentEdit } from './agent';

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_QUERY_AWARENESS = 3;

/** Updates kept before they are folded into one snapshot. */
export const COMPACT_EVERY = 200;
/** Snapshot chunk size (SQLite rows in a Durable Object are limited to 2 MB). */
const CHUNK = 1 << 20;

interface Attachment {
  userId: string;
  /** Awareness client ids announced on this socket, with their last clock. */
  aw: Record<string, number>;
}

const isSocket = (o: unknown): o is WebSocket => typeof o === 'object' && o !== null && 'send' in o && 'serializeAttachment' in o;

/**
 * One Yjs document (`nb:`, `pg:` or `lib:`): sync + awareness over hibernating WebSockets, persisted in
 * SQLite storage as a snapshot plus an update log that is compacted every 200 updates.
 * Notebook rooms also hold Q-ink labels and per-agent state (see agent.ts).
 */
export class DocRoom extends DurableObject<Env> {
  readonly doc = new Y.Doc({ gc: true });
  private sql: SqlStorage;
  private updateCount = 0;
  private docId: string | null = null;
  private ref: DocRef | null = null;
  private hub: AgentHub | null = null;
  private syncedMeta = '';

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS updates (seq INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS snapshot (part INTEGER PRIMARY KEY, data BLOB NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    this.load();
    const id = this.kvGet<string>('docId');
    if (id) this.setDocId(id);
    this.doc.on('update', (update: Uint8Array, origin: unknown) => this.onUpdate(update, origin));
  }

  // ---- storage ----

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
    }
    const ups = this.sql.exec<{ data: ArrayBuffer }>('SELECT data FROM updates ORDER BY seq').toArray();
    for (const u of ups) Y.applyUpdate(this.doc, new Uint8Array(u.data), 'load');
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
  }

  private onUpdate(update: Uint8Array, origin: unknown): void {
    if (origin === 'load') return;
    if (update.byteLength > CHUNK) this.compact();
    else {
      this.sql.exec('INSERT INTO updates (data) VALUES (?)', update);
      if (++this.updateCount >= COMPACT_EVERY) this.compact();
    }
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
      room(this.env, nbDocId(ref.notebookId))
        .pageChanged(nbDocId(ref.notebookId), ref.pageId, at)
        .catch((e: unknown) => console.error('pageChanged failed', e));
    } else if (ref.kind === 'nb') {
      this.agents().onIndexChanged();
      this.syncNotebookRow(ref.notebookId);
    }
  }

  /** Keeps `notebooks.title` / `ai_access` in D1 in step with the index doc. */
  private syncNotebookRow(notebookId: string): void {
    const meta = new Notebook(this.doc).meta();
    const key = JSON.stringify([meta.title ?? '', !!meta.aiAccess]);
    if (key === this.syncedMeta) return;
    this.syncedMeta = key;
    this.ctx.waitUntil(
      this.env.DB.prepare('UPDATE notebooks SET title = ?2, ai_access = ?3, updated_at = ?4 WHERE id = ?1')
        .bind(notebookId, meta.title ?? '', meta.aiAccess ? 1 : 0, Date.now())
        .run()
        .catch((e: unknown) => console.error('notebook row sync failed', e)),
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
    if (typeof message === 'string') return;
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
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'closed');
    } catch {
      /* already closed */
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.dropAwareness(ws);
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

  /** The whole doc as one Yjs update. */
  getState(docId: string): Uint8Array {
    this.setDocId(docId);
    return Y.encodeStateAsUpdate(this.doc);
  }

  /** Page room → notebook room, on every client update of a page. */
  pageChanged(docId: string, pageId: string, at: number): void {
    this.setDocId(docId);
    this.agents().onPageChanged(pageId, at);
  }

  lastClientUpdateAt(docId: string): number {
    this.setDocId(docId);
    return this.agents().lastClientUpdateAt();
  }

  agentWait(docId: string, clientId: string, session: string, cfg: AgentConfig): Promise<AgentResult> {
    this.setDocId(docId);
    return this.agents().wait(clientId, session, cfg);
  }

  agentRead(docId: string, ref: string): Promise<AgentResult> {
    this.setDocId(docId);
    return this.agents().read(ref);
  }

  agentEdit(docId: string, edit: AgentEdit): Promise<string> {
    this.setDocId(docId);
    return this.agents().edit(edit);
  }

  /** Notebook room → page room: an agent's transcription or comment. Agents never touch ink. */
  applyAgentEdit(docId: string, edit: AgentEdit & { lineKey: string }): string {
    this.setDocId(docId);
    if (this.ref?.kind !== 'pg') throw new Error('Not a page room');
    const page = new Page(this.doc);
    if (!page.lines().some((l) => l.key === edit.lineKey)) throw new Error(`Line ${edit.ref} no longer exists`);
    if (edit.op === 'transcribe') {
      page.setLineText(edit.lineKey, edit.text, 'agent');
      return `Saved ${edit.ref}`;
    }
    page.addComment({ lineKey: edit.lineKey, author: { kind: 'agent', name: edit.agentName }, text: edit.text });
    return `Commented on ${edit.ref}`;
  }
}
