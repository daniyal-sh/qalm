import * as Y from 'yjs';
import { Library, type Folder, type LibraryEntry } from '@qalm/core';
import type { Env } from './env';
import { libDocId, room } from './docs';
import { now } from './util';

export interface GrantRow {
  id: string;
  client_id: string;
  client_name: string;
  user_id: string;
  notebook_ids: string;
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

export interface NotebookChoice { id: string; title: string; folderId: string | null }

/** Every notebook the user owns: library entries first, then rows only D1 knows about. */
export async function userNotebooks(env: Env, userId: string): Promise<{ folders: Folder[]; notebooks: NotebookChoice[] }> {
  const [lib, rows] = await Promise.all([
    loadLibrary(env, userId),
    env.DB.prepare('SELECT id, title FROM notebooks WHERE owner_id = ?1 ORDER BY updated_at DESC').bind(userId).all<{ id: string; title: string }>(),
  ]);
  const owned = new Map(rows.results.map((r) => [r.id, r.title]));
  const out: NotebookChoice[] = [];
  const seen = new Set<string>();
  for (const e of lib.entries) {
    if (!owned.has(e.id)) continue;
    seen.add(e.id);
    out.push({ id: e.id, title: e.title || owned.get(e.id) || 'Untitled', folderId: e.folderId });
  }
  for (const [id, title] of owned) if (!seen.has(id)) out.push({ id, title: title || 'Untitled', folderId: null });
  return { folders: lib.folders, notebooks: out };
}

/** Notebooks a grant covers right now (folders are resolved live, so new notebooks in them are included). */
export async function grantedNotebooks(env: Env, g: GrantRow): Promise<NotebookChoice[]> {
  const ids = new Set<string>(JSON.parse(g.notebook_ids) as string[]);
  const folders = new Set<string>(JSON.parse(g.folder_ids) as string[]);
  const { notebooks } = await userNotebooks(env, g.user_id);
  return notebooks.filter((n) => ids.has(n.id) || (n.folderId !== null && folders.has(n.folderId)));
}

/** Short, stable session name for a notebook (`s=` in Q-ink). */
export const sessionOf = (notebookId: string) => notebookId.replace(/-/g, '').slice(0, 8).toLowerCase();
