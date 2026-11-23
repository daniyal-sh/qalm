import type { Env } from './env';
import { now } from './util';

const ID = '[A-Za-z0-9_-]{1,64}';
const NB = new RegExp(`^nb:(${ID})$`);
const PG = new RegExp(`^pg:(${ID}):(${ID})$`);
const LIB = new RegExp(`^lib:(${ID})$`);

export type DocRef =
  | { kind: 'nb'; id: string; notebookId: string }
  | { kind: 'pg'; id: string; notebookId: string; pageId: string }
  | { kind: 'lib'; id: string; userId: string };

export function parseDocId(id: string): DocRef | null {
  let m = NB.exec(id);
  if (m) return { kind: 'nb', id, notebookId: m[1]! };
  m = PG.exec(id);
  if (m) return { kind: 'pg', id, notebookId: m[1]!, pageId: m[2]! };
  m = LIB.exec(id);
  if (m) return { kind: 'lib', id, userId: m[1]! };
  return null;
}

export const nbDocId = (notebookId: string) => `nb:${notebookId}`;
export const pgDocId = (notebookId: string, pageId: string) => `pg:${notebookId}:${pageId}`;
export const libDocId = (userId: string) => `lib:${userId}`;

export function room(env: Env, docId: string) {
  return env.DOC_ROOM.get(env.DOC_ROOM.idFromName(docId));
}

/** The notebook's owner; the first user to ask for it claims it. */
export async function notebookOwner(env: Env, notebookId: string, claimFor?: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT owner_id FROM notebooks WHERE id = ?1').bind(notebookId).first<{ owner_id: string }>();
  if (row || !claimFor) return row?.owner_id ?? null;
  const t = now();
  await env.DB.prepare('INSERT INTO notebooks (id, owner_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?3) ON CONFLICT(id) DO NOTHING')
    .bind(notebookId, claimFor, t)
    .run();
  return (await env.DB.prepare('SELECT owner_id FROM notebooks WHERE id = ?1').bind(notebookId).first<{ owner_id: string }>())?.owner_id ?? null;
}

/** v1: owner only. */
export async function canAccess(env: Env, userId: string, doc: DocRef): Promise<boolean> {
  if (doc.kind === 'lib') return doc.userId === userId;
  return (await notebookOwner(env, doc.notebookId, userId)) === userId;
}
