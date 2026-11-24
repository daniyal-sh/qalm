import { env } from 'cloudflare:test';
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

describe('Play / Pause AI: review fixes', () => {
  it('a device that missed a Pause while offline cannot bring sharing back by reconnecting', async () => {
    const t = await signIn('missed@example.com');
    const n = await notebook(t, 'msnb', 'Missed', { live: false });
    const token = await connectAgent('missed@example.com', { comment: true, transcribe: true }, 'Claude');
    const s = sessionOf('msnb');
    const live = async () => !(await tool(token, 'read', { ref: 'outline', s })).isError;
    // The tablet plays; its Wi-Fi drops (socket gone).
    const tablet = await YClient.connect(t.accessToken, 'nb:msnb');
    tablet.play();
    await until(() => tablet.epoch() !== null);
    const epoch = tablet.epoch()!;
    tablet.close();
    // Meanwhile the laptop plays and the user presses Pause there.
    n.nbc.play();
    await until(live);
    n.nbc.pause();
    await until(async () => !(await live()));
    // The tablet reconnects and tries to resume: refused, told it's paused, and its heartbeats do nothing.
    const back = await YClient.connect(t.accessToken, 'nb:msnb');
    back.resume(epoch);
    await until(() => back.texts.includes('ai:paused'));
    await pause(1000);
    expect(await live()).toBe(false);
    // Without a Pause in between, a reconnect resumes at once.
    back.play();
    await until(() => back.epoch() !== null);
    const e2 = back.epoch()!;
    back.close();
    const again = await YClient.connect(t.accessToken, 'nb:msnb');
    again.resume(e2);
    await until(live);
    expect(again.texts).toContain(`ai:playing:${e2}`);
    again.close();
    n.nbc.close();
    n.pgc.close();
  });

  it('a heartbeat that crosses a Pause, or arrives on a socket that never played, is ignored', async () => {
    const t = await signIn('crossed@example.com');
    const n = await notebook(t, 'crnb', 'Crossed', { live: false });
    const token = await connectAgent('crossed@example.com', { comment: true, transcribe: true }, 'Claude');
    const s = sessionOf('crnb');
    const live = async () => !(await tool(token, 'read', { ref: 'outline', s })).isError;
    const laptop = await YClient.connect(t.accessToken, 'nb:crnb');
    // Never played: a bare heartbeat doesn't make it live.
    laptop.send('ai:live');
    await until(() => laptop.texts.includes('ai:paused'));
    expect(await live()).toBe(false);
    // Playing, then Pause on another device, then this device's heartbeat that was already on its way.
    laptop.play();
    await until(live);
    laptop.stopBeat();
    n.nbc.pause();
    await until(() => laptop.texts.filter((x) => x === 'ai:paused').length === 2);
    laptop.send('ai:live');
    await until(() => laptop.texts.filter((x) => x === 'ai:paused').length === 3);
    expect(await live()).toBe(false);
    laptop.close();
    n.nbc.close();
    n.pgc.close();
  });

  it('honours "Pause sharing" from apps before Play / Pause (meta.aiPaused) while a new device plays', async () => {
    const t = await signIn('oldapp@example.com');
    const n = await notebook(t, 'olnb', 'Old app');
    const token = await connectAgent('oldapp@example.com', { comment: true, transcribe: true }, 'Claude');
    const s = sessionOf('olnb');
    expect((await tool(token, 'read', { ref: 'outline', s })).isError).toBeFalsy();
    const waiting = tool(token, 'wait', { s });
    await pause(100);
    // The old iPad presses "Pause sharing": the pending wait ends as paused and tools are refused.
    n.nb.setMeta({ aiPaused: true });
    expect(textOf(await waiting)).toBe(`#q s=${s} paused`);
    expect(textOf(await tool(token, 'read', { ref: 'outline', s }))).toContain(PAUSED);
    expect(textOf(await tool(token, 'wait'))).toBe(`#q sessions
s=${s} paused`);
    // The new app clears it on Play.
    n.nb.setMeta({ aiPaused: false });
    n.nbc.play();
    await until(async () => !(await tool(token, 'read', { ref: 'outline', s })).isError);
    n.nbc.close();
    n.pgc.close();
  });

  it('the page room re-checks right before an agent write, so nothing lands once paused', async () => {
    const t = await signIn('gate@example.com');
    const n = await notebook(t, 'gtnb', 'Gate', { live: false });
    n.page.addItem(stroke('a', 50, 100, 200, 120));
    await pause(300);
    const pg = `pg:gtnb:${n.pageId}`;
    const stub = env.DOC_ROOM.get(env.DOC_ROOM.idFromName(pg));
    const edit = { op: 'comment' as const, ref: 'p1', text: 'too late', agentName: 'Claude' };
    const r = await stub.applyAgentEdit(pg, edit, 'nb:gtnb');
    expect(r).toMatchObject({ ok: false });
    expect(r.text).toContain(PAUSED);
    await pause(300);
    expect(n.page.comments()).toEqual([]);
    // Live: the same call writes.
    n.nbc.play();
    await until(async () => (await env.DOC_ROOM.get(env.DOC_ROOM.idFromName('nb:gtnb')).agentLiveError('nb:gtnb')) === null);
    expect(await stub.applyAgentEdit(pg, edit, 'nb:gtnb')).toMatchObject({ ok: true });
    await until(() => n.page.comments().length === 1);
    n.nbc.close();
    n.pgc.close();
  });

  it('lists paused sessions by session id, not by when they were last edited', async () => {
    const t = await signIn('order@example.com');
    const zz = await notebook(t, 'zzpaused', 'Zed', { live: false });
    const aa = await notebook(t, 'aapaused', 'Ay', { live: false });
    const mm = await notebook(t, 'mmlive', 'Live one');
    const token = await connectAgent('order@example.com', { comment: true, transcribe: true }, 'Claude');
    // Edit zz last: before, it would have been listed first.
    zz.page.addItem(stroke('z', 50, 100, 200, 120));
    await pause(500);
    expect(textOf(await tool(token, 'wait'))).toBe(['#q sessions', 's=mmlive "Live one" live', 's=aapaused paused', 's=zzpaused paused'].join(String.fromCharCode(10)));
    for (const x of [zz, aa, mm]) {
      x.nbc.close();
      x.pgc.close();
    }
  });
});
