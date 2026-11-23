import type { Env, McpProps } from './env';
import { num } from './env';
import { nbDocId, room } from './docs';
import { activeGrant, grantedNotebooks, sessionOf, type GrantRow, type NotebookChoice } from './grants';
import { svgToPng } from './png';
import { b64, json, now } from './util';
import type { AgentResult } from './agent';

/**
 * MCP over Streamable HTTP (stateless, JSON responses). POST /mcp carries JSON-RPC; there is no server-initiated
 * stream, so GET answers 405 as the transport spec allows.
 */
const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS =
  'qalm notebooks in Q-ink Live format. Call wait() to list sessions, then wait(s) in a loop to follow live writing. ' +
  'Each update lists regions: "R7 [1] p6 @120,300 260x80 +5 -1" is region R7, row [1] of the attached image, on page 6 at ' +
  'x,y with width x height on a 0-1000 grid across the page width (the header gives the page size). In the image, new ink is ' +
  'black, the ink around it grey (context) and erased strokes faint red dashed; read the handwriting yourself. "(was R3)" ' +
  'means R7 replaces R3. A region with a quoted text instead of a row has a saved reading. Save your reading of a region with ' +
  'transcribe(R7, text) and later updates send that text instead of an image. Comment on a region, a box "p6@120,300,260,80" ' +
  'or a page "p6" with comment; the comment follows the ink. "note C5 …", "re C3 …" and "ask C6 R9 …" are the student writing ' +
  'to you: answer with comment(thread). "open C2 …" is a thread from before you joined, with its latest message; read("C2") ' +
  'shows all of it. You can never change ink.';

const sArg = { type: 'string', description: 'Session (from wait with no arguments). Defaults to the last session you waited on.' };
const REF = 'a region "R7", a box "p6@120,300,260,80" (x,y,w,h on the 0-1000 grid)';
const TOOLS = [
  {
    name: 'wait',
    description: 'Waits for the next update of a live session (long-poll). Without s, lists the sessions you can see.',
    inputSchema: { type: 'object', properties: { s: { type: 'string', description: 'Session to follow' } }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'read',
    description:
      `Reads on demand: "outline", a page "p3" (all its ink as regions), ${REF} (a crop), the PDF behind a page "pdf:p2", ` +
      'or a whole comment thread "C5". Text plus an image where needed.',
    inputSchema: { type: 'object', properties: { ref: { type: 'string' }, s: sArg }, required: ['ref'], additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'transcribe',
    description:
      `Saves your reading of the strokes in ${REF}, e.g. "u = x^2". While they are unchanged, updates send this text instead of an image; ` +
      'if the student adds to or erases them, the reading is marked stale and you get an image again. Refused where the student wrote their own reading.',
    inputSchema: { type: 'object', properties: { ref: { type: 'string' }, text: { type: 'string' }, s: sArg }, required: ['ref', 'text'], additionalProperties: false },
  },
  {
    name: 'comment',
    description:
      `Starts a comment thread on ${REF} or a page "p3" (it follows the ink when moved), or replies in a thread (thread "C3", e.g. to answer a note, re or ask). ` +
      'Set resolve only when the thread is trivially done (e.g. the student said thanks). Never changes ink.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'What to start a thread on: "R7", "p3@120,300,260,80" or "p3"' },
        thread: { type: 'string', description: 'Thread to reply in, e.g. "C3" (instead of ref)' },
        text: { type: 'string' },
        resolve: { type: 'boolean', description: 'With thread: also mark it resolved' },
        s: sArg,
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
];

interface RpcMsg { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> }
type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
interface ToolResult { content: Content[]; isError?: boolean }

class ToolError extends Error {}

const LIVE_MS = 10 * 60 * 1000;
const MAX_TEXT = 4000;

export const mcpHandler = {
  async fetch(req: Request, env: Env, ctx: ExecutionContext & { props: McpProps }): Promise<Response> {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
    }
    const batch = Array.isArray(body);
    const msgs = (batch ? body : [body]) as RpcMsg[];
    const out = [];
    for (const m of msgs) {
      const r = await handle(m, env, ctx.props);
      if (r) out.push(r);
    }
    if (!out.length) return new Response(null, { status: 202 });
    return json(batch ? out : out[0]);
  },
};

async function handle(m: RpcMsg, env: Env, props: McpProps): Promise<object | null> {
  if (!m || typeof m !== 'object' || typeof m.method !== 'string') {
    return m && 'id' in m ? { jsonrpc: '2.0', id: m.id ?? null, error: { code: -32600, message: 'Invalid request' } } : null;
  }
  if (m.id === undefined || m.id === null) return null; // notification
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id: m.id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id: m.id, error: { code, message } });
  switch (m.method) {
    case 'initialize': {
      const asked = String(m.params?.protocolVersion ?? '');
      return ok({
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'qalm', title: 'qalm by Apollo', version: '0.1.0' },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call': {
      const name = String(m.params?.name ?? '');
      const args = (m.params?.arguments ?? {}) as Record<string, unknown>;
      if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `Unknown tool: ${name}`);
      try {
        return ok(await callTool(env, props, name, args));
      } catch (e) {
        if (e instanceof ToolError || e instanceof Error) return ok({ content: [{ type: 'text', text: e.message }], isError: true });
        throw e;
      }
    }
    default:
      return fail(-32601, `Method not found: ${m.method}`);
  }
}

const str = (v: unknown, name: string, max = MAX_TEXT): string => {
  if (typeof v !== 'string' || !v.trim()) throw new ToolError(`${name} is required`);
  if (v.length > max) throw new ToolError(`${name} is too long (max ${max} characters)`);
  return v;
};

function agentCfg(env: Env) {
  return {
    idleMs: num(env.WAKE_IDLE_MS, 6000),
    minIntervalMs: num(env.WAKE_MIN_INTERVAL_MS, 20000),
    timeoutMs: num(env.WAIT_TIMEOUT_MS, 45000),
  };
}

/** Picks the notebook a call is about, and checks it is inside the grant. */
async function target(env: Env, g: GrantRow, s: unknown): Promise<NotebookChoice> {
  const nbs = await grantedNotebooks(env, g);
  const want = typeof s === 'string' && s ? s.toLowerCase() : g.last_session;
  if (!want) {
    if (nbs.length === 1) return nbs[0]!;
    throw new ToolError('Pass s (call wait with no arguments to list sessions)');
  }
  const hit = nbs.find((n) => sessionOf(n.id) === want || n.id === want);
  if (!hit) throw new ToolError(`No session ${want} in this grant`);
  return hit;
}

async function callTool(env: Env, props: McpProps, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const g = await activeGrant(env, props.grantId);
  if (!g || g.user_id !== props.userId) throw new ToolError('Access to qalm has expired or was revoked. Reconnect to continue.');

  if (name === 'wait' && (args.s === undefined || args.s === '')) {
    const nbs = await grantedNotebooks(env, g);
    const t = now();
    const infos = await Promise.all(nbs.map(async (n) => ({ n, ...(await room(env, nbDocId(n.id)).agentInfo(nbDocId(n.id))) })));
    // Only notebooks whose AI access is on right now.
    const rows = infos.filter((r) => r.aiAccess);
    rows.sort((a, b) => b.at - a.at);
    const lines = ['#q sessions', ...rows.map(({ n, at, paused }) => `s=${sessionOf(n.id)} ${JSON.stringify(n.title)}${t - at < LIVE_MS ? ' live' : ''}${paused ? ' paused' : ''}`)];
    const text = lines.join('\n');
    await log(env, g, 'wait', 'sessions', text, null);
    return { content: [{ type: 'text', text }] };
  }

  const nb = await target(env, g, args.s);
  const docId = nbDocId(nb.id);
  const stub = room(env, docId);
  const session = sessionOf(nb.id);
  const who = { clientId: props.clientId, name: g.client_name, canComment: !!g.can_comment, canTranscribe: !!g.can_transcribe };
  await env.DB.prepare('UPDATE grants SET last_used_at = ?2, last_session = ?3 WHERE id = ?1').bind(g.id, now(), session).run();

  if (name === 'wait') {
    const r = await stub.agentWait(docId, who, session, agentCfg(env));
    return result(env, g, 'wait', `${nb.title}${r.changed ? '' : ' (no changes)'}`, r);
  }
  if (name === 'read') {
    const ref = str(args.ref, 'ref', 64);
    const r = await stub.agentRead(docId, ref, who);
    return result(env, g, 'read', `${nb.title} ${ref}`, r);
  }
  const text = str(args.text, 'text');
  if (name === 'comment') {
    if (!g.can_comment) throw new ToolError('This connection may not leave comments. The student can turn this on in Settings → AI access.');
    const thread = args.thread === undefined || args.thread === '' ? undefined : str(args.thread, 'thread', 16);
    const cref = thread ? undefined : str(args.ref, 'ref', 64);
    if (args.resolve !== undefined && typeof args.resolve !== 'boolean') throw new ToolError('resolve must be true or false');
    const resolve = thread ? args.resolve === true : undefined;
    const msg = await edited(stub.agentEdit(docId, { op: 'comment', ref: cref, thread, text, resolve, agentName: g.client_name }, who));
    await log(env, g, 'comment', `${nb.title} ${thread ?? cref}`, text, null);
    return { content: [{ type: 'text', text: msg }] };
  }
  const ref = str(args.ref, 'ref', 64);
  if (name === 'transcribe') {
    if (!g.can_transcribe) throw new ToolError('This connection may not save transcriptions. The student can turn this on in Settings → AI access.');
    const msg = await edited(stub.agentEdit(docId, { op: 'transcribe', ref, text }, who));
    await log(env, g, 'transcribe', `${nb.title} ${ref}`, text, null);
    return { content: [{ type: 'text', text: msg }] };
  }
  throw new ToolError(`Unknown tool: ${name}`);
}

async function edited(p: Promise<{ ok: boolean; text: string }>): Promise<string> {
  const r = await p;
  if (!r.ok) throw new ToolError(r.text);
  return r.text;
}

async function result(env: Env, g: GrantRow, tool: string, targetLabel: string, r: AgentResult): Promise<ToolResult> {
  if (r.error) throw new ToolError(r.text);
  const content: Content[] = [{ type: 'text', text: r.text }];
  let img: { width: number; height: number } | null = null;
  if (r.svg) {
    const png = await svgToPng(r.svg);
    img = png;
    content.push({ type: 'image', data: b64(png.png), mimeType: 'image/png' });
  }
  await log(env, g, tool, targetLabel, r.text, img);
  return { content };
}

/** Activity log with a rough token estimate: ~4 characters per token, images at width × height / 750. */
async function log(env: Env, g: GrantRow, tool: string, targetLabel: string, text: string, img: { width: number; height: number } | null) {
  const tokens = Math.ceil(text.length / 4) + (img ? Math.ceil((img.width * img.height) / 750) : 0);
  await env.DB.prepare('INSERT INTO activity (user_id, grant_id, client_name, tool, target, tokens, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
    .bind(g.user_id, g.id, g.client_name, tool, targetLabel, tokens, now())
    .run();
}
