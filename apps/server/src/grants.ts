import * as Y from 'yjs';
import { Library, type Folder, type LibraryEntry } from '@qalm/core';
import type { Env } from './env';
import { libDocId, nbDocId, room } from './docs';
import { now } from './util';

export interface GrantRow {
  id: string;
  client_id: string;
  client_name: string;
  user_id: string;
  /** Unused since grants cover every AI-enabled notebook (kept so older rows and Workers still read). */
  notebook_ids: string;
  /** Unused, like notebook_ids. */
  folder_ids: string;
  can_comment: number;
  can_transcribe: number;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
  last_session: string | null;
}

export const GRANT_TTL_MS = 30 * 24 * 3600 * 1000;

/** The grant, if it is still valid. */
export async function activeGrant(env: Env, grantId: string): Promise<GrantRow | null> {
  const g = await env.DB.prepare('SELECT * FROM grants WHERE id = ?1').bind(grantId).first<GrantRow>();
  if (!g || g.revoked_at || g.expires_at <= now()) return null;
  return g;
}

export async function loadLibrary(env: Env, userId: string): Promise<{ folders: Folder[]; entries: LibraryEntry[] }> {
  const id = libDocId(userId);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, await room(env, id).getState(id));
  const lib = new Library(doc);
  return { folders: lib.folders(), entries: lib.entries().filter((e) => !e.deletedAt) };
}

export interface NotebookChoice {
  id: string;
  title: string;
  folderId: string | null;
  /** The notebook's AI access switch as mirrored into D1 (unknown → off). Agent calls check the live value in the room. */
  aiAccess: boolean;
}

/**
 * The user's live notebooks: library entries that are not in the trash, owned by the user in D1 and not deleted
 * forever. D1 rows that are not in the library are never shown.
 */
export async function userNotebooks(env: Env, userId: string): Promise<{ folders: Folder[]; notebooks: NotebookChoice[] }> {
  const [lib, rows] = await Promise.all([
    loadLibrary(env, userId),
    env.DB.prepare('SELECT id, title, ai_access FROM notebooks WHERE owner_id = ?1 AND deleted_at IS NULL')
      .bind(userId)
      .all<{ id: string; title: string; ai_access: number }>(),
  ]);
  const owned = new Map(rows.results.map((r) => [r.id, r]));
  const out: NotebookChoice[] = [];
  for (const e of lib.entries) {
    const row = owned.get(e.id);
    if (!row) continue;
    out.push({ id: e.id, title: e.title || row.title || 'Untitled', folderId: e.folderId, aiAccess: row.ai_access === 1 });
  }
  return { folders: lib.folders, notebooks: out };
}

export interface GrantedNotebook extends NotebookChoice {
  /** Playing AI sharing in qalm right now (the only time agents get its data). */
  live: boolean;
  /** The student's last edit in the notebook (ms). */
  at: number;
  /** `lecture L2 recording 12:40` while a lecture session records (docs/lecture-mode.md §7), else null. */
  lecture: string | null;
}

/**
 * Notebooks a grant covers right now: every live notebook of the grant's user whose AI access is on, now and in the
 * future. There is no per-agent notebook choice; older grants' `notebook_ids` / `folder_ids` are ignored. The switch is
 * read live from each notebook's room (the D1 mirror can lag), so turning it off hides the notebook at once.
 */
export async function grantedNotebooks(env: Env, g: GrantRow): Promise<GrantedNotebook[]> {
  const { notebooks } = await userNotebooks(env, g.user_id);
  const infos = await Promise.all(
    notebooks.map(async (n) => {
      const info = await room(env, nbDocId(n.id)).agentInfo(nbDocId(n.id));
      return { ...n, aiAccess: info.aiAccess, live: info.live, at: info.at, lecture: info.lecture };
    }),
  );
  return infos.filter((n) => n.aiAccess);
}

/** Short, stable session name for a notebook (`s=` in Q-ink). */
export const sessionOf = (notebookId: string) => notebookId.replace(/-/g, '').slice(0, 8).toLowerCase();
