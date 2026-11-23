import type { Author, Comment, Reading } from '../types';

/**
 * A light, notebook-wide summary of one comment thread, mirrored into the notebook's index doc (`threads` map) so the
 * app can list threads, count unread agent replies and notice new ones on pages it hasn't loaded. The page doc stays
 * the source of truth; the summary is rewritten from it by whoever changes the thread (tech-spec §2, thread index).
 */
export interface ThreadSummary {
  id: string;
  pageId: string;
  /** Anchored to ink or a box (not the whole page). */
  onSelection?: boolean;
  /** The reading of its strokes, when there is one. */
  quote?: string;
  /** Who started the thread. */
  author: Author;
  /** The first message (cut to SUMMARY_TEXT characters). */
  text: string;
  /** The latest entry (the first message if there are no replies). */
  last: { author: Author; text: string; at: number };
  /** One character per entry, oldest first: 'a' agent, 'u' student. Unread counts come from this. */
  kinds: string;
  /** The newest agent entry, if any (for "… commented" toasts). */
  lastAgent?: { name: string; at: number };
  resolved: boolean;
  ask?: boolean;
  createdAt: number;
  /** The newest entry's time. */
  updatedAt: number;
}

export const SUMMARY_TEXT = 280;

/** Origin of thread-index writes: not undoable, not a student edit. */
export const THREADS_ORIGIN = 'qalm.threads';

const cut = (s: string) => (s.length > SUMMARY_TEXT ? `${s.slice(0, SUMMARY_TEXT - 1)}…` : s);

export function summarizeThread(pageId: string, c: Comment, readings: readonly Reading[] = []): ThreadSummary {
  const entries = [{ author: c.author, text: c.text, at: c.createdAt }, ...c.replies];
  const last = entries[entries.length - 1]!;
  const s: ThreadSummary = {
    id: c.id,
    pageId,
    author: { kind: c.author.kind, name: c.author.name },
    text: cut(c.text),
    last: { author: { kind: last.author.kind, name: last.author.name }, text: cut(last.text), at: last.at },
    kinds: entries.map((e) => (e.author.kind === 'agent' ? 'a' : 'u')).join(''),
    resolved: c.resolved,
    createdAt: c.createdAt,
    updatedAt: entries.reduce((m, e) => Math.max(m, e.at), 0),
  };
  if (c.anchor || c.anchorIds?.length) s.onSelection = true;
  const ids = new Set(c.anchorIds ?? []);
  const quote = readings
    .filter((r) => r.ids.some((id) => ids.has(id)))
    .map((r) => r.text.trim())
    .filter(Boolean)
    .join(' / ');
  if (quote) s.quote = cut(quote);
  if (c.ask) s.ask = true;
  for (const e of entries) if (e.author.kind === 'agent' && (!s.lastAgent || e.at >= s.lastAgent.at)) s.lastAgent = { name: e.author.name, at: e.at };
  return s;
}

export function summarizeThreads(pageId: string, comments: readonly Comment[], readings: readonly Reading[] = []): ThreadSummary[] {
  return comments.map((c) => summarizeThread(pageId, c, readings));
}

/**
 * What to store for thread `t` given the index's `cur`, or null to keep `cur`: fewer entries than `cur` is an older
 * copy; with as many, a thread resolved in `cur` stays resolved (only a new entry reopens it).
 */
export function threadNewer(cur: ThreadSummary | undefined, t: ThreadSummary): ThreadSummary | null {
  if (!cur) return t;
  if (t.kinds.length < cur.kinds.length) return null;
  const next = t.kinds.length === cur.kinds.length && cur.resolved && !t.resolved ? { ...t, resolved: true } : t;
  return JSON.stringify(next) === JSON.stringify(cur) ? null : next;
}

/** Agent entries in a thread after the first `seen` entries. */
export function agentEntriesAfter(t: Pick<ThreadSummary, 'kinds'>, seen = 0): number {
  let n = 0;
  for (let i = seen; i < t.kinds.length; i++) if (t.kinds[i] === 'a') n++;
  return n;
}
