/** MCP protocol eras: legacy (initialize handshake, 2025-11-25 and older) and modern (2026-07-28, per-request _meta). */
import { describe, expect, it } from 'vitest';
import { call, signIn, stroke, until } from './helpers';
import { connectAgent, mcp, notebook } from './mcp-helpers';
import { sessionOf } from '../src/grants';

const V = '2026-07-28';
const SUPPORTED = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const META = (version = V) => ({
  'io.modelcontextprotocol/protocolVersion': version,
  'io.modelcontextprotocol/clientInfo': { name: 'era-test', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
});

let id = 1000;
/** A modern POST: `_meta` in the body and the mirrored headers, any of which a test can override or drop (null). */
async function modern(
  token: string,
  method: string,
  params: Record<string, unknown> = {},
  over: { headers?: Record<string, string | null>; meta?: unknown; body?: unknown; signal?: AbortSignal } = {},
) {
  const body = over.body ?? { jsonrpc: '2.0', id: ++id, method, params: { ...params, _meta: over.meta === undefined ? META() : over.meta } };
  const h: Record<string, string | null> = {
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': V,
    'Mcp-Method': method,
    ...(typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {}),
    ...over.headers,
  };
  const headers = Object.fromEntries(Object.entries(h).filter((e): e is [string, string] => e[1] !== null));
  const r = await call('/mcp', { method: 'POST', token, headers, body: JSON.stringify(body), signal: over.signal });
  return { status: r.status, body: r.status === 202 ? null : ((await r.json()) as { id?: unknown; result?: any; error?: any }) };
}
const text = (r: { result?: { content: { type: string; text?: string }[] } }) => r.result!.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

describe('mcp protocol eras', () => {
  it('legacy: initialize → tools/list → tools/call is served exactly as before', async () => {
    const t = await signIn('era-legacy@example.com');
    await notebook(t, 'eralegacy', 'Legacy');
    const token = await connectAgent('era-legacy@example.com', { comment: true, transcribe: true });

    const init = await mcp(token, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'old', version: '1' } });
    expect(init.result).toMatchObject({ protocolVersion: '2025-11-25', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'qalm' } });
    expect(init.result.resultType).toBeUndefined();
    // An unknown version still negotiates down to our newest legacy one; initialize never answers 2026-07-28.
    expect((await mcp(token, 'initialize', { protocolVersion: '2099-01-01', capabilities: {} })).result.protocolVersion).toBe('2025-11-25');

    const note = await call('/mcp', { method: 'POST', token, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    expect(note.status).toBe(202);
    // Legacy requests after initialize carry a legacy MCP-Protocol-Version header and no _meta.
    const after = await call('/mcp', {
      method: 'POST',
      token,
      headers: { 'MCP-Protocol-Version': '2025-11-25' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(after.status).toBe(200);
    const list = (await after.json()) as { result: Record<string, unknown> };
    expect(Object.keys(list.result)).toEqual(['tools']); // no resultType, ttlMs or cacheScope
    expect((await mcp(token, 'ping')).result).toEqual({});

    const sessions = await mcp(token, 'tools/call', { name: 'wait', arguments: {} });
    expect(sessions.result.content[0].text).toContain(`s=${sessionOf('eralegacy')} "Legacy"`);
    expect(sessions.result.resultType).toBeUndefined();
    // Legacy unknown tools and methods keep their old answers (HTTP 200, no modern error codes).
    expect((await mcp(token, 'tools/call', { name: 'nope', arguments: {} })).error.code).toBe(-32602);
    expect((await mcp(token, 'server/list')).error.code).toBe(-32601);

    // initialize selects legacy semantics even when a client already sends a modern MCP-Protocol-Version header.
    const hs = await call('/mcp', {
      method: 'POST',
      token,
      headers: { 'MCP-Protocol-Version': V, 'Mcp-Method': 'initialize' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {} } }),
    });
    expect(hs.status).toBe(200);
    expect(((await hs.json()) as { result: { protocolVersion: string } }).result.protocolVersion).toBe('2025-11-25');
    // A version header that isn't a date never counts as modern.
    for (const v of ['zzz', '9999', 'latest']) {
      const r = await call('/mcp', { method: 'POST', token, headers: { 'MCP-Protocol-Version': v }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }) });
      expect(r.status, v).toBe(200);
      expect(Object.keys(((await r.json()) as { result: object }).result), v).toEqual(['tools']);
    }
  });

  it('modern: server/discover → tools/list → tools/call with _meta, long-poll wait included', async () => {
    const t = await signIn('era-modern@example.com');
    const n = await notebook(t, 'eramodern', 'Modern');
    const token = await connectAgent('era-modern@example.com', { comment: true, transcribe: true });
    const s = sessionOf('eramodern');
    const serverInfo = { 'io.modelcontextprotocol/serverInfo': { name: 'qalm', title: 'qalm by Apollo', version: '0.1.0' } };

    const d = await modern(token, 'server/discover');
    expect(d.status).toBe(200);
    expect(d.body!.result).toMatchObject({
      resultType: 'complete',
      supportedVersions: SUPPORTED,
      capabilities: { tools: {} },
      ttlMs: 3600000,
      cacheScope: 'public',
      _meta: serverInfo,
    });
    expect(d.body!.result.instructions).toContain('wait()');

    const list = await modern(token, 'tools/list');
    expect(list.status).toBe(200);
    expect(list.body!.result).toMatchObject({ resultType: 'complete', ttlMs: 3600000, cacheScope: 'public', _meta: serverInfo });
    expect(list.body!.result.tools.map((x: { name: string }) => x.name)).toEqual(['wait', 'read', 'transcribe', 'comment']);
    expect(list.body!.result.tools.find((x: { name: string }) => x.name === 'comment').description).toContain('Markdown with TeX maths ($…$, $$…$$)');
    expect(list.body!.result.nextCursor).toBeUndefined();

    const sessions = await modern(token, 'tools/call', { name: 'wait', arguments: {} });
    expect(sessions.status).toBe(200);
    expect(sessions.body!.result).toMatchObject({ resultType: 'complete', _meta: serverInfo });
    expect(text(sessions.body!)).toContain(`s=${s} "Modern"`);

    // wait still long-polls over a modern request: it parks until the student writes and pauses.
    const waiting = modern(token, 'tools/call', { name: 'wait', arguments: { s } });
    await new Promise((r) => setTimeout(r, 50));
    n.page.addItem(stroke('m1', 50, 100, 200, 120));
    const up = await waiting;
    expect(up.status).toBe(200);
    expect(text(up.body!)).toBe([`#q s=${s} r=1 p1 1000x1415 first look`, 'R1 [1] p1 @84,168 253x34'].join('\n'));
    expect(up.body!.result.content.some((c: { type: string }) => c.type === 'image')).toBe(true);

    const cm = await modern(token, 'tools/call', { name: 'comment', arguments: { ref: 'R1', text: 'Is $x^2$ **right**?' } });
    expect(text(cm.body!)).toBe('Commented on R1 as thread C1');
    await until(() => n.page.comments().length === 1);
    expect(n.page.comments()[0]!.text).toBe('Is $x^2$ **right**?');

    // Tool errors stay results with isError; an unknown tool is a protocol error (-32602).
    const bad = await modern(token, 'tools/call', { name: 'read', arguments: { ref: 'R99', s } });
    expect(bad.body!.result).toMatchObject({ resultType: 'complete', isError: true });
    expect((await modern(token, 'tools/call', { name: 'nope', arguments: {} })).body!.error.code).toBe(-32602);
    expect((await modern(token, 'tools/call', { name: 'wait', arguments: 'x' })).body!.error.code).toBe(-32602);
    // A non-string tool name is invalid params, not a header mismatch.
    expect((await modern(token, 'tools/call', { name: 5, arguments: {} })).body!.error).toMatchObject({ code: -32602, message: expect.stringContaining('name must be a string') });
    // tools/list is one page; a cursor we never issued is invalid.
    expect((await modern(token, 'tools/list', { cursor: 'abc' })).body!.error).toMatchObject({ code: -32602, message: 'Invalid cursor' });
  });

  it('modern: an unsupported version gets -32022 with the supported list', async () => {
    await signIn('era-version@example.com');
    const token = await connectAgent('era-version@example.com', { comment: false, transcribe: false });
    for (const method of ['tools/list', 'server/discover']) {
      const r = await modern(token, method, {}, { meta: META('1900-01-01'), headers: { 'MCP-Protocol-Version': '1900-01-01' } });
      expect(r.status).toBe(400);
      expect(r.body).toMatchObject({
        jsonrpc: '2.0',
        error: { code: -32022, message: 'Unsupported protocol version', data: { supported: SUPPORTED, requested: '1900-01-01' } },
      });
    }
    // A newer revision we don't know yet, too.
    const r = await modern(token, 'tools/list', {}, { meta: META('2027-01-01'), headers: { 'MCP-Protocol-Version': '2027-01-01' } });
    expect(r.body!.error.code).toBe(-32022);
  });

  it('modern: missing or mismatched headers and _meta are rejected with 400', async () => {
    await signIn('era-headers@example.com');
    const token = await connectAgent('era-headers@example.com', { comment: false, transcribe: false });
    const expectError = async (p: ReturnType<typeof modern>, code: number, message?: RegExp) => {
      const r = await p;
      expect(r.status).toBe(400);
      expect(r.body!.error.code).toBe(code);
      if (message) expect(r.body!.error.message).toMatch(message);
    };
    const waitCall = { name: 'wait', arguments: {} };
    await expectError(modern(token, 'tools/list', {}, { headers: { 'MCP-Protocol-Version': null } }), -32020, /MCP-Protocol-Version/);
    await expectError(modern(token, 'tools/list', {}, { headers: { 'MCP-Protocol-Version': '2025-11-25' } }), -32020, /does not match _meta/);
    await expectError(modern(token, 'tools/list', {}, { headers: { 'Mcp-Method': null } }), -32020, /Mcp-Method/);
    await expectError(modern(token, 'tools/list', {}, { headers: { 'Mcp-Method': 'tools/call' } }), -32020, /Mcp-Method header value 'tools\/call'/);
    await expectError(modern(token, 'tools/call', waitCall, { headers: { 'Mcp-Name': null } }), -32020, /Mcp-Name/);
    await expectError(modern(token, 'tools/call', waitCall, { headers: { 'Mcp-Name': 'read' } }), -32020, /Mcp-Name header value 'read'/);
    await expectError(modern(token, 'tools/call', waitCall, { headers: { 'Mcp-Name': '=?base64?!!?=' } }), -32020, /malformed/);
    // A Base64-sentinel Mcp-Name is decoded before comparing.
    const b64 = await modern(token, 'tools/call', waitCall, { headers: { 'Mcp-Name': `=?base64?${btoa('wait')}?=` } });
    expect(b64.status).toBe(200);

    // Required _meta fields (a modern header with no _meta, or _meta without clientCapabilities): -32602.
    await expectError(modern(token, 'tools/list', {}, { meta: null }), -32602, /protocolVersion/);
    await expectError(modern(token, 'tools/list', {}, { meta: { 'io.modelcontextprotocol/protocolVersion': V } }), -32602, /clientCapabilities/);
    // server/discover is modern-only, so it is never served the legacy way.
    await expectError(modern(token, 'server/discover', {}, { meta: null }), -32602, /protocolVersion/);
    await expectError(modern(token, 'server/discover', {}, { meta: null, headers: { 'MCP-Protocol-Version': null } }), -32020, /MCP-Protocol-Version/);
    // One message per POST.
    await expectError(modern(token, 'tools/list', {}, { body: [{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: META() } }] }), -32600);

    // A modern request without a token is still a 401 pointing at the protected resource metadata (auth is per request).
    const anon = await call('/mcp', { method: 'POST', headers: { 'MCP-Protocol-Version': V, 'Mcp-Method': 'tools/list' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: META() } }) });
    expect(anon.status).toBe(401);
    expect(anon.headers.get('WWW-Authenticate')).toContain('resource_metadata');
  });

  it('modern: methods 2026-07-28 removed answer 404 -32601; GET and DELETE stay 405', async () => {
    await signIn('era-removed@example.com');
    const token = await connectAgent('era-removed@example.com', { comment: false, transcribe: false });
    // Unserved methods are 404 -32601 before any header check, so a dual-era probe reads them as modern, not legacy.
    for (const [method, params] of [['resources/read', { uri: 'qalm://x' }], ['prompts/get', { name: 'x' }]] as const) {
      const r = await modern(token, method, params, { headers: { 'Mcp-Name': null } });
      expect(r.status, method).toBe(404);
      expect(r.body!.error.code, method).toBe(-32601);
    }
    const mis = await modern(token, 'initialize', { protocolVersion: V, capabilities: {} }, { headers: { 'Mcp-Method': 'ping' } });
    expect([mis.status, mis.body!.error.code]).toEqual([404, -32601]);
    for (const method of ['initialize', 'ping', 'logging/setLevel', 'subscriptions/listen', 'resources/list']) {
      const r = await modern(token, method, method === 'initialize' ? { protocolVersion: V, capabilities: {} } : {});
      expect(r.status, method).toBe(404);
      expect(r.body!.error.code, method).toBe(-32601);
    }
    for (const method of ['GET', 'DELETE']) {
      const r = await call('/mcp', { method, token, headers: { 'MCP-Protocol-Version': V } });
      expect(r.status).toBe(405);
    }
    // Notifications are accepted and ignored.
    const note = await modern(token, 'notifications/cancelled', {}, { body: { jsonrpc: '2.0', method: 'notifications/cancelled', params: { _meta: META() } } });
    expect(note.status).toBe(202);
  });

  it('a wait whose client disconnects is cancelled: nothing is marked delivered, and the next wait gets the update', async () => {
    const t = await signIn('era-cancel@example.com');
    const n = await notebook(t, 'eracancel', 'Cancel');
    const token = await connectAgent('era-cancel@example.com', { comment: false, transcribe: false });
    const s = sessionOf('eracancel');
    const ac = new AbortController();
    const gone = modern(token, 'tools/call', { name: 'wait', arguments: { s } }, { signal: ac.signal }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 100));
    ac.abort();
    expect(await gone).toBeInstanceOf(Error);
    // The student writes and pauses well past WAKE_IDLE_MS: an uncancelled wait would deliver (and consume) r=1 now.
    n.page.addItem(stroke('k1', 50, 100, 200, 120));
    await new Promise((r) => setTimeout(r, 1000));
    const at = Date.now();
    const next = await modern(token, 'tools/call', { name: 'wait', arguments: { s } });
    expect(text(next.body!)).toBe([`#q s=${s} r=1 p1 1000x1415 first look`, 'R1 [1] p1 @84,168 253x34'].join('\n'));
    expect(Date.now() - at).toBeLessThan(1500); // delivered at once, not after the 2.5 s timeout
  });
});
