/**
 * Settings → Delete account. Platform-free: the network and local storage are injected (tested in test/account.test.ts).
 * 1. explain what goes, 2. the user types their email, 3. POST /account/delete/start emails a 6-digit code,
 * 4. POST /account/delete {code} deletes everything on the server; then this device forgets the account.
 */
type AuthedFetch = (path: string, init?: RequestInit) => Promise<Response>;

export type DeleteStep = 'explain' | 'email' | 'code';

/** What the explanation lists, in order. */
export const DELETED_ITEMS = [
  'Every notebook in this account, with its pages, handwriting, text, comments and readings',
  'The PDFs and images you imported',
  'AI connections and their activity log',
  'Your sign-in sessions on every device, and the account itself',
] as const;

const norm = (s: string) => s.trim().toLowerCase();

/** Whether the typed address is the account's (case and spaces don't matter). */
export const emailMatches = (typed: string, account: string | undefined | null) => !!account && norm(typed) === norm(account) && norm(typed) !== '';

async function post(fetchFn: AuthedFetch, path: string, body: unknown, fallback: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new Error('Couldn’t reach the server. Try again when you’re online.');
  }
  if (!res.ok) {
    let msg = res.status === 429 ? 'Too many emails. Try again later.' : fallback;
    try {
      const b = (await res.json()) as { error?: string };
      if (b.error) msg = b.error;
    } catch {
      /* not JSON */
    }
    throw new Error(msg);
  }
  return res.json();
}

/** Emails the deletion code. The server checks `email` is the account's. */
export async function startAccountDeletion(fetchFn: AuthedFetch, email: string): Promise<void> {
  await post(fetchFn, '/account/delete/start', { email: email.trim() }, 'Couldn’t send the code');
}

/** Deletes the account on the server for good. Safe to call again if a call failed halfway. */
export async function confirmAccountDeletion(fetchFn: AuthedFetch, code: string): Promise<void> {
  const r = (await post(fetchFn, '/account/delete', { code: code.replace(/\D/g, '') }, 'Couldn’t delete the account')) as { deleted?: boolean };
  if (!r.deleted) throw new Error('Couldn’t delete the account');
}

/**
 * The local docs that belong to the deleted account: its library, and the notebooks (index and pages) in it that
 * aren't also in this device's signed-out library.
 */
export function accountDocIds(localDocs: string[], userId: string, accountNotebooks: string[], localNotebooks: string[]): string[] {
  const keep = new Set(localNotebooks);
  const nbs = new Set(accountNotebooks.filter((id) => !keep.has(id)));
  return localDocs.filter((d) => {
    if (d === `lib:${userId}`) return true;
    const m = /^(?:nb|pg):([^:]+)/.exec(d);
    return !!m && nbs.has(m[1]!);
  });
}

export interface ForgetDeps {
  /** Every doc id stored on this device. */
  list(): Promise<string[]>;
  /** Closes a doc held in memory without saving it again. */
  drop(docId: string): Promise<void>;
  /** Deletes a doc's local copy (IndexedDB database or snapshot file). */
  remove(docId: string): Promise<void>;
}

/** Removes the deleted account's docs from this device. Each failure is skipped, so the rest still goes. */
export async function forgetAccountDocs(d: ForgetDeps, userId: string, accountNotebooks: string[], localNotebooks: string[]): Promise<string[]> {
  const ids = accountDocIds(await d.list().catch(() => []), userId, accountNotebooks, localNotebooks);
  if (!ids.includes(`lib:${userId}`)) ids.push(`lib:${userId}`);
  for (const id of ids) {
    await d.drop(id).catch(() => undefined);
    await d.remove(id).catch(() => undefined);
  }
  return ids;
}
