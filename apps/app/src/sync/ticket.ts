/** Sync auth (tech-spec §4): POST /sync/ticket {docId} with Bearer → single-use ticket (30 s), then GET /sync/{docId}?ticket=. */
export type AuthedFetch = (path: string, init?: RequestInit) => Promise<Response>;

export class TicketError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function fetchTicket(authFetch: AuthedFetch, docId: string): Promise<string> {
  const res = await authFetch('/sync/ticket', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ docId }),
  });
  if (!res.ok) throw new TicketError(`ticket ${res.status}`, res.status);
  const body = (await res.json()) as { ticket?: unknown };
  if (typeof body.ticket !== 'string' || !body.ticket) throw new TicketError('ticket missing', res.status);
  return body.ticket;
}

/** ws(s)://host/sync/{docId}?ticket=… (doc ids contain ':' so they are URI-encoded). */
export function syncSocketUrl(httpBase: string, docId: string, ticket: string): string {
  const ws = httpBase.replace(/^http(s?):\/\//, (_m, s: string) => `ws${s}://`).replace(/\/+$/, '');
  return `${ws}/sync/${encodeURIComponent(docId)}?ticket=${encodeURIComponent(ticket)}`;
}
