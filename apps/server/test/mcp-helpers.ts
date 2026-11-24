/** OAuth + MCP + sync helpers shared by the MCP tests. */
import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect } from 'vitest';
import * as Y from 'yjs';
import { Library, Notebook, Page, createNotebookDoc, type LibraryEntry } from '@qalm/core';
import { BASE, YClient, call, captureLink, consentSignIn, cookieJar, signIn, stroke, ticket, until, type Tokens } from './helpers';
import { sessionOf } from '../src/grants';

const REDIRECT = 'https://client.test/cb';

export function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Runs the whole OAuth 2.1 flow (DCR → magic-link sign-in → consent → PKCE code exchange) and returns an MCP access token. */
export async function connectAgent(
  email: string,
  pick: { comment: boolean; transcribe: boolean },
  clientName = 'Tutor',
  onConsent?: (html: string) => void,
): Promise<string> {
  const reg = await call('/oauth/register', {
    method: 'POST',
    body: JSON.stringify({ client_name: clientName, redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
  });
  expect(reg.status).toBe(201);
  const { client_id } = (await reg.json()) as { client_id: string };

  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const q = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'st1' });
  const authorizePath = `/authorize?${q}`;

  // Not signed in: the worker shows a sign-in form, then a magic link brings the browser back with a web cookie.
  const jar = cookieJar();
  const first = await call(authorizePath);
  expect(first.status).toBe(200);
  expect(await first.text()).toContain('Sign in to qalm');
  const link = await captureLink(() =>
    call('/authorize/signin', { method: 'POST', body: new URLSearchParams({ email, return: authorizePath }) }),
  );
  const back = await consentSignIn(link);
  expect(back.status).toBe(302);
  expect(back.headers.get('Location')).toBe(authorizePath);
  jar.take(back);

  const consent = await call(authorizePath, { headers: { Cookie: jar.header() } });
  expect(consent.status).toBe(200);
  jar.take(consent);
  const html = await consent.text();
  expect(html).toContain(`${clientName} wants to read your notes`);
  onConsent?.(html);
  const handle = /name="handle" value="([^"]*)"/.exec(html)![1]!;
  const rid = /name="rid" value="([^"]*)"/.exec(html)![1]!;

  const form = new URLSearchParams({ handle: handle.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c))), rid, decision: 'approve' });
  if (pick.comment) form.set('comment', '1');
  if (pick.transcribe) form.set('transcribe', '1');
  const approved = await call('/authorize', { method: 'POST', body: form, headers: { Cookie: jar.header() } });
  expect(approved.status).toBe(302);
  const to = new URL(approved.headers.get('Location')!);
  expect(to.origin + to.pathname).toBe(REDIRECT);
  expect(to.searchParams.get('state')).toBe('st1');

  const tok = await call('/oauth/token', {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'authorization_code', code: to.searchParams.get('code')!, redirect_uri: REDIRECT, client_id, code_verifier: verifier }),
  });
  expect(tok.status).toBe(200);
  return ((await tok.json()) as { access_token: string }).access_token;
}

let rpcId = 0;
export async function mcp(token: string, method: string, params?: unknown): Promise<{ result?: any; error?: any }> {
  const r = await call('/mcp', {
    method: 'POST',
    token,
    headers: { Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  });
  expect(r.status).toBe(200);
  return r.json();
}

export async function tool(token: string, name: string, args: Record<string, unknown> = {}) {
  const r = await mcp(token, 'tools/call', { name, arguments: args });
  expect(r.error).toBeUndefined();
  return r.result as { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: boolean };
}
export const textOf = (r: Awaited<ReturnType<typeof tool>>) => r.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n');

export async function serverDoc(docId: string): Promise<Y.Doc> {
  const st = await env.DOC_ROOM.get(env.DOC_ROOM.idFromName(docId)).getState(docId);
  const d = new Y.Doc();
  Y.applyUpdate(d, st);
  return d;
}

/** Edits the user's library doc over sync and waits until the server has it. */
export async function editLibrary(t: Tokens, fn: (lib: Library) => void): Promise<void> {
  const docId = `lib:${t.userId}`;
  const c = await YClient.connect(t.accessToken, docId);
  fn(new Library(c.doc));
  const key = (l: Library) => JSON.stringify(l.entries().sort((a, b) => a.id.localeCompare(b.id)));
  const want = key(new Library(c.doc));
  await until(async () => key(new Library(await serverDoc(docId))) === want);
  c.close();
}

/** Waits until the server's index doc has this AI access value. */
export async function serverAi(id: string, on: boolean): Promise<void> {
  await until(async () => new Notebook(await serverDoc(`nb:${id}`)).meta().aiAccess === on);
}

export const aiRow = async (id: string) =>
  (await env.DB.prepare('SELECT ai_access FROM notebooks WHERE id = ?1').bind(id).first<{ ai_access: number }>())?.ai_access;

/**
 * A synced notebook with one page, in the library, with AI access on unless `ai: false`, and playing AI sharing
 * (the index client sends heartbeats) unless `live: false` or AI access is off. Returns live clients for its index
 * and first page.
 */
export async function notebook(t: Tokens, id: string, title: string, opts: { ai?: boolean; live?: boolean; entry?: Partial<LibraryEntry> } = {}) {
  const ai = opts.ai ?? true;
  const init = createNotebookDoc({ id, title, cover: '#4338ca', paper: 'ruled', paperColor: 'white', size: { w: 595, h: 842 } });
  new Notebook(init).setMeta({ aiAccess: ai });
  const nbc = await YClient.connect(t.accessToken, `nb:${id}`, init);
  const nb = new Notebook(nbc.doc);
  const pageId = nb.pages()[0]!.id;
  const pgc = await YClient.connect(t.accessToken, `pg:${id}:${pageId}`);
  await editLibrary(t, (lib) =>
    lib.putEntry({ id, title, cover: '#4338ca', folderId: null, updatedAt: Date.now(), aiAccess: ai, favorite: false, deletedAt: null, ...opts.entry }),
  );
  await serverAi(id, ai);
  if (ai && opts.live !== false) nbc.play();
  return { nb, nbc, pageId, pgc, page: new Page(pgc.doc) };
}

/** Item fields that only ink edits would change. */
export const inkOf = (p: Page) => JSON.stringify(p.items().map((i) => i));

