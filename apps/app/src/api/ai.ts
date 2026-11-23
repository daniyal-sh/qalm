/**
 * The server's JSON API for Settings (AI access, account). tech-spec §4 does not pin these down yet;
 * the app expects the shapes below (see the report). Every call needs a signed-in TokenManager.
 */
import type { TokenManager } from '../auth/tokens';

export interface ConnectedAgent {
  clientId: string;
  name: string;
  /** e.g. ["Calculus II", "Folder: Semester 2"] */
  scopes: string[];
  canComment: boolean;
  canTranscribe: boolean;
  lastActiveAt?: number;
  expiresAt?: number;
}

export interface PendingRequest {
  id: string;
  clientName: string;
  requestedAt: number;
  /** Worker-served consent page (mockup screen 5). */
  reviewUrl?: string;
}

export interface ActivityEntry {
  at: number;
  agent: string;
  tool: string;
  target: string;
  tokens?: number;
}

export interface AiOverview {
  mcpUrl: string;
  agents: ConnectedAgent[];
  pending: PendingRequest[];
  activity: ActivityEntry[];
}

export interface Account {
  id: string;
  email?: string;
  name?: string;
  storageUsed?: number;
  storageQuota?: number;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status}`);
  return (await res.json()) as T;
}

export async function getAiOverview(tm: TokenManager, serverUrl: string): Promise<AiOverview> {
  const [agents, pending, activity] = await Promise.all([
    tm.fetch('/api/ai/agents').then((r) => json<{ agents: ConnectedAgent[] }>(r)),
    tm.fetch('/api/ai/requests').then((r) => json<{ requests: PendingRequest[] }>(r)),
    tm.fetch('/api/ai/activity?limit=50').then((r) => json<{ activity: ActivityEntry[] }>(r)),
  ]);
  return { mcpUrl: `${serverUrl}/mcp`, agents: agents.agents ?? [], pending: pending.requests ?? [], activity: activity.activity ?? [] };
}

export async function revokeAgent(tm: TokenManager, clientId: string): Promise<void> {
  await json(await tm.fetch(`/api/ai/agents/${encodeURIComponent(clientId)}`, { method: 'DELETE' }).then(okOrEmpty));
}

export async function denyRequest(tm: TokenManager, id: string): Promise<void> {
  await json(await tm.fetch(`/api/ai/requests/${encodeURIComponent(id)}/deny`, { method: 'POST' }).then(okOrEmpty));
}

export async function getAccount(tm: TokenManager): Promise<Account> {
  return json<Account>(await tm.fetch('/api/me'));
}

export async function startEmailSignIn(serverUrl: string, email: string, redirect: string): Promise<void> {
  const res = await fetch(`${serverUrl}/auth/email/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, redirect }),
  });
  if (!res.ok) throw new Error(`email sign-in failed (${res.status})`);
}

function okOrEmpty(r: Response): Response {
  return r.status === 204 ? new Response('{}', { status: 200 }) : r;
}
