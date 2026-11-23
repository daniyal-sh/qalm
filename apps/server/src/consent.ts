import { AuthorizationError, CimdFetchError, type ConsentDescription } from '@cloudflare/workers-oauth-provider';
import type { Env, McpProps } from './env';
import { startMagicLink, TooManyRequests, webUser } from './auth';
import { GRANT_TTL_MS, userNotebooks, type NotebookChoice } from './grants';
import type { Folder } from '@qalm/core';
import { BRAND_FONT_STACK, D, MARK_SVG, T } from './brand';
import { escapeHtml as e, HttpError, now } from './util';

const css = `
:root{${vars(T)}}
@media (prefers-color-scheme: dark){:root{${vars(D)}}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:var(--bg);color:var(--ink);font:15px/1.45 ${BRAND_FONT_STACK};display:grid;place-items:center;padding:24px 16px;-webkit-font-smoothing:antialiased}
.card{width:min(420px,100%);background:var(--surface);border:1px solid var(--line);border-radius:12px;box-shadow:0 1px 2px rgba(0,0,0,.04);padding:24px}
.logos{display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:16px}
.av{width:44px;height:44px;border-radius:12px;display:grid;place-items:center;color:#fff;font-weight:600;font-size:16px;background:var(--assistant)}
.mark{width:44px;height:44px;border-radius:12px;display:grid;place-items:center;background:var(--surface-2);border:1px solid var(--line)}
.mark svg{width:34px;height:28px}
.sep{color:var(--faint)}
h1{margin:0 0 4px;font-size:20px;font-weight:600;letter-spacing:-.02em;text-align:center}
.sub{margin:0 0 16px;text-align:center;color:var(--muted);font-size:14px}
.who{font-size:12px;color:var(--muted);text-align:center;margin:-8px 0 16px}
.warn{background:var(--warn-soft);color:var(--warn);border-radius:8px;padding:10px 12px;font-size:13px;margin-bottom:12px}
.err{background:var(--bad-soft);color:var(--bad);border-radius:8px;padding:10px 12px;font-size:13px;margin-bottom:12px}
.label{font-size:12px;color:var(--muted);margin:12px 0 4px}
.list{max-height:260px;overflow:auto;margin:0 -4px;padding:0 4px}
.ck{display:flex;align-items:center;gap:10px;min-height:44px;padding:4px 2px;cursor:pointer}
.ck input{width:18px;height:18px;margin:0;accent-color:var(--accent);flex:none}
.ck .m{color:var(--muted);font-size:13px}
.tgl{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:52px;padding:6px 0;border-top:1px solid var(--line-2);cursor:pointer}
.tgl small{display:block;color:var(--muted);font-size:12px}
.sw{position:relative;width:40px;height:24px;flex:none}
.sw input{position:absolute;inset:0;opacity:0;margin:0;cursor:pointer}
.sw span{position:absolute;inset:0;border-radius:999px;background:var(--soft);border:1px solid var(--line);transition:background .15s}
.sw span::after{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--surface);box-shadow:0 1px 2px rgba(0,0,0,.2);transition:left .15s}
.sw input:checked+span{background:var(--accent);border-color:var(--accent)}
.sw input:checked+span::after{left:18px}
.sw input:focus-visible+span,.ck input:focus-visible,button:focus-visible,input[type=email]:focus-visible{outline:2px solid var(--accent-line);outline-offset:1px}
.info{display:flex;justify-content:space-between;align-items:center;min-height:52px;border-top:1px solid var(--line-2)}
.info small{display:block;color:var(--muted);font-size:12px}
.foot{display:flex;gap:8px;margin-top:16px}
button{font:inherit;font-weight:600;height:44px;border-radius:8px;border:1px solid var(--line);background:var(--surface);color:var(--ink);flex:1;cursor:pointer}
button.p{background:var(--accent);border-color:var(--accent);color:#fff}
button:disabled{opacity:.5;cursor:default}
a.btn{display:flex;align-items:center;justify-content:center;flex:1;height:44px;border-radius:8px;background:var(--accent);color:#fff;font-weight:600;text-decoration:none}
input[type=email]{width:100%;height:44px;border-radius:8px;border:1px solid var(--line);background:var(--surface);color:var(--ink);font:inherit;padding:0 12px}
.fine{font-size:12px;color:var(--faint);text-align:center;margin-top:14px}
@media (prefers-reduced-motion: reduce){*{transition:none!important}}
`;

function vars(t: Record<string, string>): string {
  return Object.entries(t)
    .map(([k, v]) => `--${k.replace(/[A-Z0-9]/g, (c) => '-' + c.toLowerCase())}:${v}`)
    .join(';');
}

function page(title: string, body: string, status = 200, headers?: Headers): Response {
  const h = headers ?? new Headers();
  h.set('Content-Type', 'text/html; charset=utf-8');
  h.set('Cache-Control', 'no-store');
  h.set('X-Frame-Options', 'DENY');
  h.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'unsafe-inline'; frame-ancestors 'none'");
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${e(title)}</title><link rel="preconnect" href="https://fonts.googleapis.com"><link href="https://fonts.googleapis.com/css2?family=Figtree:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${css}</style></head><body><main class="card">${body}</main></body></html>`,
    { status, headers: h },
  );
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';

const logos = (clientName: string) => `<div class="logos"><span class="av">${e(initials(clientName))}</span><span class="sep">⟷</span><span class="mark">${MARK_SVG}</span></div>`;

export function messagePage(title: string, text: string, status = 200): Response {
  return page(title, `<div class="logos"><span class="mark">${MARK_SVG}</span></div><h1>${e(title)}</h1><p class="sub">${e(text)}</p>`, status);
}

/**
 * GET /auth/email/verify: a page with a button, so following a link (mail scanners, previews) never uses it up.
 * `postToken`: MCP consent sign-in (the button POSTs the token here). `href`: an app sign-in link reached on the server (old link
 * or misconfigured MAGIC_LINK_URL); the button opens the app link, which verifies it.
 */
export function magicLinkPage(email: string, to: { postToken: string } | { href: string }): Response {
  const button =
    'postToken' in to
      ? `<form method="post" action="/auth/email/verify"><input type="hidden" name="token" value="${e(to.postToken)}"><div class="foot"><button class="p" type="submit">Continue</button></div></form>`
      : `<div class="foot"><a class="btn" href="${e(to.href)}">Continue</a></div>`;
  const res = page(
    'Sign in to Qalm',
    `<div class="logos"><span class="mark">${MARK_SVG}</span></div>
<h1>Sign in to Qalm</h1><p class="sub">Continue as <b>${e(email)}</b>. Only continue if you just asked for this link.</p>
${button}`,
  );
  res.headers.set('Referrer-Policy', 'no-referrer');
  return res;
}

function signInPage(returnTo: string, sent = false, error?: string): Response {
  if (sent) return messagePage('Check your email', 'We sent you a sign-in link. Open it in this browser to continue.');
  return page(
    'Sign in to Qalm',
    `<div class="logos"><span class="mark">${MARK_SVG}</span></div>
<h1>Sign in to Qalm</h1><p class="sub">An app wants to connect to your notes. Sign in first.</p>
${error ? `<div class="err">${e(error)}</div>` : ''}
<form method="post" action="/authorize/signin">
<input type="hidden" name="return" value="${e(returnTo)}">
<label class="label" for="email">Email</label>
<input id="email" type="email" name="email" required autocomplete="email" placeholder="you@example.com">
<div class="foot"><button class="p" type="submit">Email me a link</button></div>
</form>`,
  );
}

function consentPage(d: ConsentDescription, handle: string, rid: string, email: string | null, folders: Folder[], nbs: NotebookChoice[]): string {
  const counts = new Map<string, number>();
  for (const n of nbs) if (n.folderId) counts.set(n.folderId, (counts.get(n.folderId) ?? 0) + 1);
  const folderRows = folders
    .map((f) => {
      const c = counts.get(f.id) ?? 0;
      return `<label class="ck"><input type="checkbox" name="folder" value="${e(f.id)}">Folder · ${e(f.name)} <span class="m">(${c} notebook${c === 1 ? '' : 's'})</span></label>`;
    })
    .join('');
  const nbRows = nbs.map((n) => `<label class="ck"><input type="checkbox" name="notebook" value="${e(n.id)}">${e(n.title)}</label>`).join('');
  const origin = d.clientDomain
    ? `Published by <b>${e(d.clientDomain)}</b>. `
    : '';
  return `${logos(d.clientName)}
<h1>${e(d.clientName)} wants to read your notes</h1>
<p class="sub">Pick what it can see. You can change this at any time.</p>
${email ? `<p class="who">Signed in as ${e(email)}</p>` : ''}
${d.redirectIsLoopback ? '<div class="warn">This sends access to an app on your computer. Continue only if you just started connecting from it.</div>' : ''}
<form method="post" action="/authorize" id="f">
<input type="hidden" name="handle" value="${e(handle)}">
<input type="hidden" name="rid" value="${e(rid)}">
<div class="list">${folderRows}${nbRows || '<p class="sub">You have no synced notebooks yet.</p>'}</div>
<label class="tgl"><div>Leave comments<small>Shown as pins. Never changes ink</small></div><span class="sw"><input type="checkbox" name="comment" value="1" checked><span></span></span></label>
<label class="tgl"><div>Save readings<small>Can store its reading of a line. You can edit it</small></div><span class="sw"><input type="checkbox" name="transcribe" value="1" checked><span></span></span></label>
<div class="info"><div>Access expires<small>After 30 days</small></div></div>
<div class="foot"><button type="submit" name="decision" value="deny" formnovalidate>Deny</button><button class="p" type="submit" name="decision" value="approve" id="allow" disabled>Allow access</button></div>
</form>
<p class="fine">${origin}Access goes to <b>${e(d.redirectHost)}</b>. It can never change your ink.</p>
<script>
const f=document.getElementById('f'),a=document.getElementById('allow');
const sync=()=>{a.disabled=!f.querySelector('input[name=notebook]:checked,input[name=folder]:checked')};
f.addEventListener('change',sync);sync();
</script>`;
}

async function authError(err: unknown): Promise<Response> {
  if (err instanceof AuthorizationError && err.redirectTo) return Response.redirect(err.redirectTo, 302);
  if (err instanceof AuthorizationError) return messagePage("Can't connect", err.description || 'This request is invalid or has expired. Start again from your app.', 400);
  if (err instanceof CimdFetchError) return messagePage("Can't connect", 'This app could not be verified.', 400);
  throw err;
}

/** GET/POST /authorize and POST /authorize/signin: the MCP consent flow (mockups/screens-ai.html screen 5). */
export async function handleAuthorize(req: Request, env: Env, path: string): Promise<Response | null> {
  const oauth = env.OAUTH_PROVIDER;
  if (path === '/authorize/signin' && req.method === 'POST') {
    const form = await req.formData();
    const returnTo = String(form.get('return') ?? '');
    if (!returnTo.startsWith('/authorize?')) return messagePage("Can't connect", 'Start again from your app.', 400);
    try {
      await startMagicLink(env, req, String(form.get('email') ?? ''), { returnTo });
    } catch (err) {
      if (err instanceof TooManyRequests) {
        const res = signInPage(returnTo, false, 'Too many sign-in emails. Try again later.');
        return new Response(res.body, { status: 429, headers: new Headers([...res.headers, ['Retry-After', String(err.retryAfterS)]]) });
      }
      if (err instanceof HttpError && err.status === 400) return signInPage(returnTo, false, 'Enter a valid email address.');
      throw err;
    }
    return signInPage(returnTo, true);
  }
  if (path !== '/authorize') return null;

  if (req.method === 'GET') {
    try {
      const authReq = await oauth.parseAuthRequest(req);
      const userId = await webUser(req, env);
      const url = new URL(req.url);
      if (!userId) return signInPage(url.pathname + url.search);
      const details = await oauth.describeConsent(authReq);
      const [{ folders, notebooks }, user] = await Promise.all([
        userNotebooks(env, userId),
        env.DB.prepare('SELECT email FROM users WHERE id = ?1').bind(userId).first<{ email: string | null }>(),
      ]);
      const consent = await oauth.beginConsent(authReq);
      const rid = crypto.randomUUID();
      await env.DB.prepare('INSERT INTO auth_requests (id, user_id, client_id, client_name, redirect_host, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
        .bind(rid, userId, details.clientId, details.clientName, details.redirectHost, 'pending', now())
        .run();
      return page(`Connect ${details.clientName}`, consentPage(details, consent.handle, rid, user?.email ?? null, folders, notebooks), 200, consent.headers);
    } catch (err) {
      return authError(err);
    }
  }

  if (req.method === 'POST') {
    const userId = await webUser(req, env);
    if (!userId) return messagePage('Signed out', 'Your sign-in expired. Start again from your app.', 401);
    const form = await req.formData();
    const handle = String(form.get('handle') ?? '');
    const rid = String(form.get('rid') ?? '');
    const pending = await env.DB.prepare('SELECT status FROM auth_requests WHERE id = ?1 AND user_id = ?2').bind(rid, userId).first<{ status: string }>();
    try {
      if (form.get('decision') !== 'approve' || pending?.status !== 'pending') {
        const denied = await oauth.denyConsent(req, handle);
        await env.DB.prepare(`UPDATE auth_requests SET status = 'denied' WHERE id = ?1`).bind(rid).run();
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const { notebooks, folders } = await userNotebooks(env, userId);
      const nbSet = new Set(notebooks.map((n) => n.id));
      const fSet = new Set(folders.map((f) => f.id));
      const pickedNbs = form.getAll('notebook').map(String).filter((id) => nbSet.has(id));
      const pickedFolders = form.getAll('folder').map(String).filter((id) => fSet.has(id));
      if (!pickedNbs.length && !pickedFolders.length) return messagePage('Pick something to share', 'Go back and choose at least one notebook or folder.', 400);

      const approved = await oauth.approveConsent(req, handle);
      const client = await oauth.lookupClient(approved.request.clientId);
      const clientName = client?.clientName || approved.request.clientId;
      const grantId = crypto.randomUUID();
      const t = now();
      await env.DB.batch([
        env.DB.prepare(`UPDATE grants SET revoked_at = ?3 WHERE user_id = ?1 AND client_id = ?2 AND revoked_at IS NULL`).bind(userId, approved.request.clientId, t),
        env.DB.prepare(
          `INSERT INTO grants (id, client_id, client_name, user_id, notebook_ids, folder_ids, can_comment, can_transcribe, created_at, expires_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
        ).bind(grantId, approved.request.clientId, clientName, userId, JSON.stringify(pickedNbs), JSON.stringify(pickedFolders), form.get('comment') ? 1 : 0, form.get('transcribe') ? 1 : 0, t, t + GRANT_TTL_MS),
        env.DB.prepare(`UPDATE auth_requests SET status = 'approved' WHERE id = ?1`).bind(rid),
      ]);
      const props: McpProps = { userId, grantId, clientId: approved.request.clientId, clientName };
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId,
        metadata: { grantId, clientName },
        scope: approved.request.scope,
        props,
      });
      approved.headers.set('Location', redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    } catch (err) {
      return authError(err);
    }
  }
  return null;
}
