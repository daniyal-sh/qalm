/** Settings → AI access, against the server's app API (apps/server/src/http.ts, Bearer auth). */
import type { TokenManager } from '../auth/tokens';

export interface Grant {
  id: string;
  clientId: string;
  clientName: string;
  canComment: boolean;
  canTranscribe: boolean;
  createdAt: number;
  expiresAt: number;
  lastUsedAt: number | null;
}

export interface PendingRequest {
  id: string;
  clientId: string;
  clientName: string;
  redirectHost: string;
  createdAt: number;
}

export interface ActivityEntry {
  grantId: string;
  clientName: string;
  tool: string;
  target: string;
  tokens: number;
  at: number;
}

export interface AiOverview {
  mcpUrl: string;
  grants: Grant[];
  pending: PendingRequest[];
  activity: ActivityEntry[];
}

type Authed = Pick<TokenManager, 'fetch'>;

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `Request failed (${res.status})`;
    try {
      const b = (await res.json()) as { error?: string };
      if (b.error) msg = b.error;
    } catch {
      /* not JSON */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export async function getAiOverview(tm: Authed): Promise<AiOverview> {
  const [g, r, a] = await Promise.all([
    tm.fetch('/ai/grants').then((x) => json<{ mcpUrl: string; grants: Grant[] }>(x)),
    tm.fetch('/ai/requests').then((x) => json<{ requests: PendingRequest[] }>(x)),
    tm.fetch('/ai/activity?limit=50').then((x) => json<{ activity: ActivityEntry[] }>(x)),
  ]);
  return { mcpUrl: g.mcpUrl, grants: g.grants ?? [], pending: r.requests ?? [], activity: a.activity ?? [] };
}

/** An approved agent can read every notebook with AI access on, so only its permissions can change. */
export type GrantPatch = Partial<Pick<Grant, 'canComment' | 'canTranscribe'>>;

export async function updateGrant(tm: Authed, id: string, patch: GrantPatch): Promise<Grant> {
  const res = await tm.fetch(`/ai/grants/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return (await json<{ grant: Grant }>(res)).grant;
}

export async function revokeGrant(tm: Authed, id: string): Promise<void> {
  await json(await tm.fetch(`/ai/grants/${encodeURIComponent(id)}`, { method: 'DELETE' }));
}

export async function denyRequest(tm: Authed, id: string): Promise<void> {
  await json(await tm.fetch(`/ai/requests/${encodeURIComponent(id)}/deny`, { method: 'POST' }));
}

/** "Read + comment", "Read only", … */
export function grantSummary(g: Pick<Grant, 'canComment' | 'canTranscribe'>): string {
  if (g.canComment && g.canTranscribe) return 'Read, comment and save readings';
  if (g.canComment) return 'Read and comment';
  if (g.canTranscribe) return 'Read and save readings';
  return 'Read only';
}

/** What every approved agent can see: "3 notebooks with AI access on", "No notebook has AI access on". */
export function aiScope(entries: readonly { aiAccess: boolean; deletedAt: number | null }[]): string {
  const n = entries.filter((e) => e.aiAccess && !e.deletedAt).length;
  if (!n) return 'No notebook has AI access on';
  return `${n} notebook${n === 1 ? '' : 's'} with AI access on`;
}

/**
 * Agents following a notebook right now (GET /ai/presence): a pending wait, or a call in the last minute; and whether
 * one of the owner's devices is playing AI sharing for it (Play / Pause AI).
 */
export interface Presence {
  aiAccess: boolean;
  live: boolean;
  /** `!live` (for apps from before Play / Pause). */
  paused: boolean;
  agents: { name: string; waiting: boolean; lastAt: number; canComment: boolean; canTranscribe: boolean }[];
}

export async function getPresence(tm: Authed, notebookId: string): Promise<Presence> {
  return json<Presence>(await tm.fetch(`/ai/presence?nb=${encodeURIComponent(notebookId)}`));
}

/** "Claude", "Claude and Tutor", "Claude and 2 others". */
export function presenceNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} others`;
}

/** What the agents can do: "read and comment", … */
export function presenceCan(agents: Pick<Presence['agents'][number], 'canComment' | 'canTranscribe'>[]): string {
  return grantSummary({ canComment: agents.some((a) => a.canComment), canTranscribe: agents.some((a) => a.canTranscribe) });
}
