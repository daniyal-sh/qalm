/** The official TypeScript SDK client (v2, 2026-07-28) against our worker, in each of its version-negotiation modes. */
import { SELF } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport, type VersionNegotiationMode } from '@modelcontextprotocol/client';
import { BASE, signIn } from './helpers';
import { connectAgent, notebook } from './mcp-helpers';
import { sessionOf } from '../src/grants';

type Sent = { method: string; headers: Headers; body: { method?: string; params?: { _meta?: Record<string, unknown> } } };

async function connect(token: string, mode: VersionNegotiationMode) {
  const sent: Sent[] = [];
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
    fetch: async (url, init) => {
      const req = new Request(url, init);
      if (req.method === 'POST') sent.push({ method: req.method, headers: req.headers, body: await req.clone().json() });
      return SELF.fetch(req);
    },
  });
  const client = new Client({ name: 'sdk-test', version: '1.0.0' }, { versionNegotiation: { mode } });
  await client.connect(transport);
  return { client, sent };
}

const textOf = (r: { content: unknown }) => (r.content as { type: string; text?: string }[]).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

describe('mcp with the official SDK client', () => {
  it('auto: probes with server/discover, stays modern, lists and calls tools', async () => {
    const t = await signIn('sdk-auto@example.com');
    await notebook(t, 'sdkauto', 'SDK auto');
    const token = await connectAgent('sdk-auto@example.com', { comment: true, transcribe: true });
    const { client, sent } = await connect(token, 'auto');
    try {
      expect(client.getProtocolEra()).toBe('modern');
      expect(client.getServerVersion()).toMatchObject({ name: 'qalm' });
      expect(client.getServerCapabilities()).toMatchObject({ tools: {} });
      expect(client.getInstructions()).toContain('wait()');

      const { tools } = await client.listTools();
      expect(tools.map((x) => x.name)).toEqual(['wait', 'read', 'transcribe', 'comment']);
      const r = await client.callTool({ name: 'wait', arguments: {} });
      expect(textOf(r)).toContain(`s=${sessionOf('sdkauto')} "SDK auto"`);

      // Every request was modern: no initialize, the version in _meta and the mirrored headers.
      expect(sent[0]!.body.method).toBe('server/discover');
      expect(sent.some((s) => s.body.method === 'initialize')).toBe(false);
      const callReq = sent.find((s) => s.body.method === 'tools/call')!;
      expect(callReq.body.params!._meta!['io.modelcontextprotocol/protocolVersion']).toBe('2026-07-28');
      expect(callReq.headers.get('MCP-Protocol-Version')).toBe('2026-07-28');
      expect(callReq.headers.get('Mcp-Name')).toBe('wait');
    } finally {
      await client.close();
    }
  });

  it('pinned 2026-07-28: connects without fallback', async () => {
    await signIn('sdk-pin@example.com');
    const token = await connectAgent('sdk-pin@example.com', { comment: false, transcribe: false });
    const { client } = await connect(token, { pin: '2026-07-28' });
    try {
      expect(client.getProtocolEra()).toBe('modern');
      expect((await client.listTools()).tools).toHaveLength(4);
    } finally {
      await client.close();
    }
  });

  it('legacy: the plain initialize handshake, as 2025-era clients do', async () => {
    const t = await signIn('sdk-legacy@example.com');
    await notebook(t, 'sdklegacy', 'SDK legacy');
    const token = await connectAgent('sdk-legacy@example.com', { comment: true, transcribe: true });
    const { client, sent } = await connect(token, 'legacy');
    try {
      expect(client.getProtocolEra()).toBe('legacy');
      expect(sent[0]!.body.method).toBe('initialize');
      expect(client.getServerVersion()).toMatchObject({ name: 'qalm' });
      expect((await client.listTools()).tools.map((x) => x.name)).toEqual(['wait', 'read', 'transcribe', 'comment']);
      const r = await client.callTool({ name: 'wait', arguments: {} });
      expect(textOf(r)).toContain(`s=${sessionOf('sdklegacy')} "SDK legacy"`);
      expect(sent.some((s) => s.body.method === 'server/discover')).toBe(false);
    } finally {
      await client.close();
    }
  });
});
