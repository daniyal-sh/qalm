// A throwaway local qalm server for the captures: `wrangler dev --local` with its own state directory and port, an
// email sign-in (the code is read from the console email), and a real MCP agent connected through OAuth.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const b64url = (b) => Buffer.from(b).toString('base64url');

export async function startServer({ root, port, state }) {
  rmSync(state, { recursive: true, force: true });
  mkdirSync(state, { recursive: true });
  const cwd = join(root, 'apps', 'server');
  const wrangler = join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
  const env = { ...process.env, NODE_OPTIONS: '--max-old-space-size=2048', WRANGLER_SEND_METRICS: 'false' };
  delete env.ELECTRON_RUN_AS_NODE;
  const mig = spawnSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'qalm', '--local', '--persist-to', state], { cwd, env, encoding: 'utf8', input: 'y\n' });
  if (mig.status !== 0) throw new Error(`migrations failed:\n${mig.stdout}\n${mig.stderr}`);
  const base = `http://127.0.0.1:${port}`;
  const vars = {
    JWT_SECRET: 'showcase-only-secret-0123456789-abcdefghij',
    PUBLIC_URL: base,
    MAGIC_LINK_URL: `${base}/auth/email/verify`,
    EMAIL_PROVIDER: 'console',
  };
  const args = [wrangler, 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(port + 1), '--persist-to', state, '--show-interactive-dev-session=false'];
  for (const [k, v] of Object.entries(vars)) args.push('--var', `${k}:${v}`);
  const proc = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {}
    if (proc.exitCode !== null || i > 240) throw new Error(`wrangler dev did not start:\n${log.slice(-3000)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  const call = (path, init = {}) => {
    const headers = { ...(init.headers ?? {}) };
    if (init.token) headers.Authorization = `Bearer ${init.token}`;
    if (typeof init.body === 'string' && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    return fetch(base + path, { ...init, headers, redirect: 'manual' });
  };
  /** The newest console email to `to` after `from` (log offset). */
  const mail = async (to, from) => {
    for (let i = 0; i < 80; i++) {
      const at = log.lastIndexOf(`[email] to=${to} `);
      if (at >= from) {
        const text = log.slice(at, at + 4000);
        return { code: /code[^\d]*(\d{6})/.exec(text)?.[1], link: /(https?:\/\/\S+token=\S+)/.exec(text)?.[1] };
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`no email to ${to}`);
  };

  return {
    base,
    get log() {
      return log;
    },
    call,
    /** Signs in by email (link token + device nonce, as the app does). Returns the app's tokens and the user id. */
    async signIn(email) {
      const nonce = randomUUID();
      const nonceHash = createHash('sha256').update(nonce).digest('hex');
      const from = log.length;
      const r = await call('/auth/email/start', { method: 'POST', body: JSON.stringify({ email, nonceHash }) });
      if (!r.ok) throw new Error(`email start ${r.status} ${await r.text()}`);
      const m = await mail(email, from);
      const token = new URL(m.link).searchParams.get('token');
      const v = await call('/auth/email/verify', { method: 'POST', body: JSON.stringify({ token, nonce }) });
      if (!v.ok) throw new Error(`verify ${v.status} ${await v.text()}`);
      return v.json();
    },
    /** DCR → sign-in on the consent page → approve (comment + transcribe) → PKCE token. Returns the MCP access token. */
    async connectAgent(email, clientName) {
      const REDIRECT = 'https://agent.example/cb';
      const reg = await call('/oauth/register', { method: 'POST', body: JSON.stringify({ client_name: clientName, redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }) });
      if (reg.status !== 201) throw new Error(`register ${reg.status}`);
      const { client_id } = await reg.json();
      const verifier = b64url(randomBytes(32));
      const challenge = b64url(createHash('sha256').update(verifier).digest());
      const q = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 's1' });
      const authorizePath = `/authorize?${q}`;
      const cookies = new Map();
      const take = (res) => {
        for (const c of res.headers.getSetCookie?.() ?? []) {
          const [kv] = c.split(';');
          const i = kv.indexOf('=');
          cookies.set(kv.slice(0, i), kv.slice(i + 1));
        }
      };
      const cookie = () => [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
      await call(authorizePath);
      const from = log.length;
      const form = (o) => ({ body: new URLSearchParams(o), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      await call('/authorize/signin', { method: 'POST', ...form({ email, return: authorizePath }) });
      const m = await mail(email, from);
      const page = await (await fetch(m.link, { redirect: 'manual' })).text();
      const tok = /name="token" value="([^"]*)"/.exec(page)[1].replace(/&#(\d+);/g, (_, c) => String.fromCharCode(+c));
      const back = await call('/auth/email/verify', { method: 'POST', ...form({ token: tok }) });
      take(back);
      const consent = await call(authorizePath, { headers: { Cookie: cookie() } });
      take(consent);
      const html = await consent.text();
      const dec = (s) => s.replace(/&#(\d+);/g, (_, c) => String.fromCharCode(+c));
      const handle = dec(/name="handle" value="([^"]*)"/.exec(html)[1]);
      const rid = /name="rid" value="([^"]*)"/.exec(html)[1];
      const ok = await call('/authorize', { method: 'POST', body: new URLSearchParams({ handle, rid, decision: 'approve', comment: '1', transcribe: '1' }), headers: { Cookie: cookie(), 'Content-Type': 'application/x-www-form-urlencoded' } });
      const to = new URL(ok.headers.get('Location'));
      const t = await call('/oauth/token', { method: 'POST', ...form({ grant_type: 'authorization_code', code: to.searchParams.get('code'), redirect_uri: REDIRECT, client_id, code_verifier: verifier }) });
      if (!t.ok) throw new Error(`token ${t.status} ${await t.text()}`);
      return (await t.json()).access_token;
    },
    /** One MCP JSON-RPC call; returns the tool's text. */
    async mcp(token, name, args, signal) {
      const r = await fetch(`${base}/mcp`, {
        method: 'POST',
        signal,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'tools/call', params: { name, arguments: args } }),
      });
      const text = await r.text();
      const json = text.startsWith('{') ? JSON.parse(text) : JSON.parse(/data: (.*)/.exec(text)?.[1] ?? '{}');
      return json.result?.content?.map((c) => c.text).join('\n') ?? JSON.stringify(json.error ?? json);
    },
    async stop() {
      proc.kill();
      await new Promise((r) => setTimeout(r, 800));
      if (proc.exitCode === null) spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F']);
    },
  };
}
