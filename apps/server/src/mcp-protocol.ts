import { json } from './util';

/**
 * MCP protocol eras on one endpoint (a "dual-era" server, spec 2026-07-28 basic/versioning).
 *
 * - **Legacy** (2025-11-25 and older): an `initialize` handshake picks the version; mcp.ts serves these unchanged.
 * - **Modern** (2026-07-28): no handshake. Every request names its version in `params._meta`, mirrors it and the method
 *   in HTTP headers, and is served on its own. This file decides the era of a POST and, for a modern one, validates
 *   it, answers `server/discover`, and shapes the results of the tool methods, which mcp.ts runs for both eras.
 */
export const MODERN_VERSIONS = ['2026-07-28'];
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
/** Everything this server speaks, newest first: `server/discover` and -32022 list both eras, like the spec's example. */
export const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];
export const SERVER_INFO = { name: 'qalm', title: 'qalm by Apollo', version: '0.1.0' };

const PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const SERVER_INFO_KEY = 'io.modelcontextprotocol/serverInfo';

const HEADER_MISMATCH = -32020;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

/** Tools never vary by user and only change on deploy. */
const CACHE = { ttlMs: 60 * 60 * 1000, cacheScope: 'public' } as const;
/** Methods whose name or uri goes in the `Mcp-Name` header, and the param it mirrors. */
const NAMED: Record<string, string> = { 'tools/call': 'name', 'resources/read': 'uri', 'prompts/get': 'name' };

export interface RpcRequest { jsonrpc: '2.0'; id: string | number; method: string; params: Record<string, unknown> }
/** Runs a request the way mcp.ts does for legacy clients: a JSON-RPC response with a result or an error. */
type Dispatch = (m: RpcRequest) => Promise<object | null>;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const metaOf = (m: unknown) => (isObj(m) && isObj(m.params) && isObj(m.params._meta) ? m.params._meta : undefined);
const isModernVersion = (v: string) => !LEGACY_VERSIONS.includes(v) && v >= MODERN_VERSIONS[MODERN_VERSIONS.length - 1]!;

/**
 * Whether a POST body is modern. Legacy clients never put a protocol version in `_meta`, so any `_meta` version that isn't
 * a legacy one makes the request modern (including an unknown one, which then gets -32022), as does `server/discover`
 * (modern only) or an `MCP-Protocol-Version` header naming a modern version. Anything else, `initialize` included, stays
 * on the legacy path exactly as before.
 */
export function isModern(req: Request, body: unknown): boolean {
  const header = req.headers.get('MCP-Protocol-Version');
  if (header !== null && isModernVersion(header)) return true;
  return (Array.isArray(body) ? body : [body]).some((m) => {
    const v = metaOf(m)?.[PROTOCOL_VERSION];
    if (v !== undefined && !(typeof v === 'string' && LEGACY_VERSIONS.includes(v))) return true;
    return isObj(m) && m.method === 'server/discover';
  });
}

const fail = (status: number, id: unknown, code: number, message: string, data?: unknown) =>
  json({ jsonrpc: '2.0', id: typeof id === 'string' || typeof id === 'number' ? id : null, error: { code, message, ...(data === undefined ? {} : { data }) } }, status);

/** A header value, Base64-sentinel decoded (`=?base64?…?=`); null when it isn't valid. */
function headerValue(v: string): string | null {
  if (!/^[\x20-\x7e\t]*$/.test(v)) return null;
  // Clients must encode any value shaped like the sentinel, so one that doesn't decode is malformed, not literal.
  if (!(v.startsWith('=?base64?') && v.endsWith('?=') && v.length >= 11)) return v;
  const b64 = v.slice(9, -2);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** Serves one modern (2026-07-28) POST: stateless, validated against its headers, with modern result fields. */
export async function serveModern(req: Request, body: unknown, instructions: string, dispatch: Dispatch): Promise<Response> {
  if (Array.isArray(body)) return fail(400, null, -32600, 'Invalid request: one JSON-RPC message per POST');
  if (!isObj(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') return fail(400, isObj(body) ? body.id : null, -32600, 'Invalid request');
  // 2026-07-28 defines no client notifications over HTTP; accept and ignore any.
  if (body.id === undefined) return new Response(null, { status: 202 });
  const id = body.id;
  if (typeof id !== 'string' && typeof id !== 'number') return fail(400, null, -32600, 'Invalid request: id must be a string or number');
  const method = body.method;
  const params = body.params ?? {};
  if (!isObj(params)) return fail(400, id, -32602, 'Invalid params: params must be an object');

  // Streamable HTTP "Server Validation": the standard headers are required and must match the body.
  const mismatch = (what: string) => fail(400, id, HEADER_MISMATCH, `Header mismatch: ${what}`);
  const hVersion = req.headers.get('MCP-Protocol-Version');
  const hMethod = req.headers.get('Mcp-Method');
  if (hVersion === null) return mismatch('missing MCP-Protocol-Version header');
  if (hMethod === null) return mismatch('missing Mcp-Method header');
  if (hMethod !== method) return mismatch(`Mcp-Method header value '${hMethod}' does not match body value '${method}'`);
  const nameParam = NAMED[method];
  if (nameParam) {
    const raw = req.headers.get('Mcp-Name');
    if (raw === null) return mismatch('missing Mcp-Name header');
    const name = headerValue(raw);
    if (name === null) return mismatch('malformed Mcp-Name header');
    if (name !== params[nameParam]) return mismatch(`Mcp-Name header value '${raw}' does not match body value '${String(params[nameParam])}'`);
  }

  // Per-request protocol fields (basic/index `_meta`): a request without them is malformed.
  const meta = params._meta;
  if (!isObj(meta) || typeof meta[PROTOCOL_VERSION] !== 'string') return fail(400, id, -32602, `Invalid params: missing _meta "${PROTOCOL_VERSION}"`);
  if (!isObj(meta[CLIENT_CAPABILITIES])) return fail(400, id, -32602, `Invalid params: missing _meta "${CLIENT_CAPABILITIES}"`);
  const version = meta[PROTOCOL_VERSION];
  if (hVersion !== version) return mismatch(`MCP-Protocol-Version header value '${hVersion}' does not match _meta value '${version}'`);
  const known = method === 'server/discover' ? SUPPORTED_VERSIONS : MODERN_VERSIONS;
  if (!known.includes(version)) {
    return fail(400, id, UNSUPPORTED_PROTOCOL_VERSION, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested: version });
  }

  const complete = (result: Record<string, unknown>) =>
    json({ jsonrpc: '2.0', id, result: { ...result, resultType: 'complete', _meta: { ...(isObj(result._meta) ? result._meta : {}), [SERVER_INFO_KEY]: SERVER_INFO } } });
  const run = async (extra?: Record<string, unknown>) => {
    const r = (await dispatch({ jsonrpc: '2.0', id, method, params })) as { result?: Record<string, unknown> } | null;
    if (!r?.result) return json(r ?? { jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error' } });
    return complete({ ...r.result, ...extra });
  };

  switch (method) {
    case 'server/discover':
      return complete({ supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: {} }, instructions, ...CACHE });
    case 'tools/list':
      // One page: there is never a cursor to continue from.
      if (params.cursor !== undefined) return fail(200, id, -32602, 'Invalid cursor');
      return run(CACHE);
    case 'tools/call':
      if (typeof params.name !== 'string') return fail(200, id, -32602, 'Invalid params for tools/call: name must be a string');
      if (params.arguments !== undefined && !isObj(params.arguments)) return fail(200, id, -32602, "Invalid params for tools/call: 'arguments' must be an object");
      return run();
    default:
      // initialize, ping and everything else 2026-07-28 removed or we don't serve.
      return fail(404, id, -32601, `Method not found: ${method}`);
  }
}
