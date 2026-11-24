import { describe, expect, it } from 'vitest';
import { call, signIn, stroke, until, YClient } from './helpers';
import { connectAgent, notebook, textOf, tool } from './mcp-helpers';
import { sessionOf } from '../src/grants';

interface Presence { aiAccess: boolean; live: boolean; paused: boolean; agents: { name: string; waiting: boolean; lastAt: number }[] }
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const PAUSED = "The student hasn't turned on AI for this notebook right now";

describe('Play / Pause AI (server-verified liveness)', () => {
  it('shows who follows a notebook; Pause stops updates and tools without revoking; Stop turns AI off', async () => {
    const t = await signIn('presence@example.com');
    const n = await notebook(t, 'presnb', 'Presence');
    const presence = async (nb = 'presnb') => {
      const r = await call(`/ai/presence?nb=${nb}`, { token: t.accessToken });
      return { status: r.status, body: (r.status === 200 ? await r.json() : null) as Presence | null };
    };
    expect((await presence()).body).toEqual({ aiAccess: true, live: true, paused: false, agents: [] });
    // Only the owner can ask.
    const other = await signIn('someone-else@example.com');
    expect((await call('/ai/presence?nb=presnb', { token: other.accessToken })).status).toBe(404);
    expect((await call('/ai/presence?nb=presnb')).status).toBe(401);

    const token = await connectAgent('presence@example.com', { comment: true, transcribe: true }, 'Claude');
    const s = sessionOf('presnb');
    const waiting = tool(token, 'wait', { s });
    await pause(100);
    expect((await presence()).body!.agents).toMatchObject([{ name: 'Claude', waiting: true, canComment: true, canTranscribe: true }]);

    // Pause mid-wait: the wait ends as "paused" at once, ink written meanwhile isn't delivered, and tools are refused.
    n.nbc.pause();
    expect(textOf(await waiting)).toBe(`#q s=${s} paused`);
    n.page.addItem(stroke('p1', 50, 100, 200, 120));
    const calls: [string, Record<string, unknown>][] = [
      ['read', { ref: 'p1', s }],
      ['comment', { ref: 'p1', text: 'hi', s }],
      ['transcribe', { ref: 'p1@0,0,500,500', text: 'x', s }],
    ];
    for (const [name, args] of calls) {
      const r = await tool(token, name, args);
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain(PAUSED);
    }
    expect(n.page.comments()).toEqual([]);
    // Listed without its title.
    const list = textOf(await tool(token, 'wait'));
    expect(list).toContain(`s=${s} paused`);
    expect(list).not.toContain('Presence');
    expect((await presence()).body).toMatchObject({ live: false, paused: true, agents: [{ name: 'Claude' }] });

    // A wait on a paused notebook parks; Play wakes it and it catches up on what was written meanwhile.
    const resumed = tool(token, 'wait', { s });
    await pause(300);
    n.nbc.play();
    expect(textOf(await resumed)).toContain('R1 [1] p1 @');
    expect(textOf(await tool(token, 'wait'))).toContain(`s=${s} "Presence" live`);

    // Stop = AI access off: nobody is shown following.
    n.nb.setMeta({ aiAccess: false });
    await until(async () => (await presence()).body!.aiAccess === false);
    expect((await presence()).body).toEqual({ aiAccess: false, live: false, paused: true, agents: [] });
    n.nbc.close();
    n.pgc.close();
  });

  it('a notebook that is open but not playing is never shared; a wait that starts paused parks as paused', async () => {
    const t = await signIn('notplaying@example.com');
    const n = await notebook(t, 'npnb', 'Secret diary', { live: false });
    n.page.addItem(stroke('a', 50, 100, 200, 120));
    const token = await connectAgent('notplaying@example.com', { comment: true, transcribe: true }, 'Claude');
    const s = sessionOf('npnb');
    expect(textOf(await tool(token, 'wait'))).toBe(`#q sessions\ns=${s} paused`);
    const r = await tool(token, 'read', { ref: 'outline', s });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain(PAUSED);
    const t0 = Date.now();
    expect(textOf(await tool(token, 'wait', { s }))).toBe(`#q s=${s} paused`);
    expect(Date.now() - t0).toBeGreaterThan(3500); // parked for the whole long-poll, not a busy loop
    // While live, the whole notebook is readable.
    n.nbc.play();
    await until(async () => !(await tool(token, 'read', { ref: 'outline', s })).isError);
    expect(textOf(await tool(token, 'read', { ref: 'p1', s }))).toContain('R1');
    n.nbc.close();
    n.pgc.close();
  });

  it('expires when heartbeats stop (device asleep) and ends when the socket closes', async () => {
    const t = await signIn('expiry@example.com');
    const n = await notebook(t, 'exnb', 'Expiry');
    const token = await connectAgent('expiry@example.com', { comment: true, transcribe: true }, 'Claude');
    const s = sessionOf('exnb');
    expect((await tool(token, 'read', { ref: 'outline', s })).isError).toBeFalsy();
    // Heartbeats stop without a Pause: a pending wait ends as paused once the 2.5 s test window lapses (the test long-poll is 4 s).
    const waiting = tool(token, 'wait', { s });
    await pause(100);
    const t0 = Date.now();
    n.nbc.stopBeat();
    expect(textOf(await waiting)).toBe(`#q s=${s} paused`);
    expect(Date.now() - t0).toBeLessThan(3800);
    expect(textOf(await tool(token, 'read', { ref: 'outline', s }))).toContain(PAUSED);
    // Playing again, then the socket closes (notebook closed, signed out, connection lost): paused at once.
    n.nbc.play();
    await until(async () => !(await tool(token, 'read', { ref: 'outline', s })).isError);
    n.nbc.close();
    await until(async () => textOf(await tool(token, 'read', { ref: 'outline', s })).includes(PAUSED), 1000);
    n.pgc.close();
  });

  it('multiple devices: live while any plays; Pause on one pauses all and tells the others', async () => {
    const t = await signIn('devices@example.com');
    const n = await notebook(t, 'dvnb', 'Devices', { live: false });
    const tablet = await YClient.connect(t.accessToken, 'nb:dvnb');
    const token = await connectAgent('devices@example.com', { comment: true, transcribe: true }, 'Claude');
    const s = sessionOf('dvnb');
    const live = async () => !(await tool(token, 'read', { ref: 'outline', s })).isError;
    n.nbc.play();
    tablet.play();
    await until(live);
    // One device closes (say a second tab): the other keeps it live, past the TTL, on its own heartbeats.
    n.nbc.close();
    await pause(3000);
    expect(await live()).toBe(true);
    // A reconnect is a new socket that plays on its own heartbeat. One device stopping alone (backgrounded) leaves
    // the other playing; Pause on the tablet pauses the laptop too.
    const laptop = await YClient.connect(t.accessToken, 'nb:dvnb');
    laptop.play();
    tablet.stop();
    await pause(100);
    expect(await live()).toBe(true);
    expect(laptop.texts).not.toContain('ai:paused');
    tablet.play();
    tablet.pause();
    await until(() => laptop.texts.includes('ai:paused'));
    expect(await live()).toBe(false);
    expect(tablet.texts).not.toContain('ai:paused');
    tablet.close();
    laptop.close();
    n.pgc.close();
  });

  it('comments the student writes while paused are held until Play', async () => {
    const t = await signIn('held@example.com');
    const n = await notebook(t, 'hdnb', 'Held');
    const token = await connectAgent('held@example.com', { comment: true, transcribe: true }, 'Claude');
    const s = sessionOf('hdnb');
    const first = tool(token, 'wait', { s });
    await pause(50);
    n.page.addItem(stroke('a', 50, 100, 200, 120));
    expect(textOf(await first)).toContain('first look');
    n.nbc.pause();
    n.page.addComment({ author: { kind: 'user', name: 'You' }, text: 'can you check this?', anchor: [40, 90, 220, 130], anchorIds: ['a'] });
    expect(textOf(await tool(token, 'wait', { s }))).toBe(`#q s=${s} paused`);
    n.nbc.play();
    const got = textOf(await tool(token, 'wait', { s }));
    expect(got).toContain('note C1');
    expect(got).toContain('can you check this?');
    n.nbc.close();
    n.pgc.close();
  });
});
