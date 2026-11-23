import { describe, expect, it } from 'vitest';
import { call, signIn, stroke } from './helpers';
import { connectAgent, notebook, serverDoc, textOf, tool } from './mcp-helpers';
import { Notebook } from '@qalm/core';
import { until } from './helpers';
import { sessionOf } from '../src/grants';

interface Presence { aiAccess: boolean; paused: boolean; agents: { name: string; waiting: boolean; lastAt: number }[] }
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('agent presence and pause', () => {
  it('shows who follows a notebook; pause stops updates and tools without revoking; Stop turns AI off', async () => {
    const t = await signIn('presence@example.com');
    const n = await notebook(t, 'presnb', 'Presence');
    const presence = async (nb = 'presnb') => {
      const r = await call(`/ai/presence?nb=${nb}`, { token: t.accessToken });
      return { status: r.status, body: (r.status === 200 ? await r.json() : null) as Presence | null };
    };
    expect((await presence()).body).toEqual({ aiAccess: true, paused: false, agents: [] });
    // Only the owner can ask.
    const other = await signIn('someone-else@example.com');
    expect((await call('/ai/presence?nb=presnb', { token: other.accessToken })).status).toBe(404);
    expect((await call('/ai/presence?nb=presnb')).status).toBe(401);

    const token = await connectAgent('presence@example.com', { notebooks: ['presnb'], comment: true, transcribe: false }, 'Claude');
    const s = sessionOf('presnb');
    const waiting = tool(token, 'wait', { s });
    await pause(100);
    const p1 = (await presence()).body!;
    expect(p1.agents).toMatchObject([{ name: 'Claude', waiting: true, canComment: true, canTranscribe: false }]);

    // Pause sharing: ink written meanwhile isn't delivered, the wait ends as "paused", and tools are refused.
    n.nb.setMeta({ aiPaused: true });
    await until(async () => new Notebook(await serverDoc('nb:presnb')).meta().aiPaused === true);
    n.page.addItem(stroke('p1', 50, 100, 200, 120));
    expect(textOf(await waiting)).toBe(`#q s=${s} paused`);
    const read = await tool(token, 'read', { ref: 'p1', s });
    expect(read.isError).toBe(true);
    expect(textOf(read)).toContain('paused sharing');
    expect(textOf(await tool(token, 'wait'))).toContain(`s=${s} "Presence" live paused`);
    expect((await presence()).body).toMatchObject({ paused: true, agents: [{ name: 'Claude', waiting: false }] });

    // Resume: a pending wait wakes and catches up.
    const resumed = tool(token, 'wait', { s });
    await pause(100);
    n.nb.setMeta({ aiPaused: false });
    expect(textOf(await resumed)).toContain('R1 [1] p1 @');

    // Stop = AI access off: nobody is shown following.
    n.nb.setMeta({ aiAccess: false });
    await until(async () => new Notebook(await serverDoc('nb:presnb')).meta().aiAccess === false);
    expect((await presence()).body).toEqual({ aiAccess: false, paused: false, agents: [] });
    n.nbc.close();
    n.pgc.close();
  });
});
