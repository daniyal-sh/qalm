import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import { LectureDoc, lectureDocId } from '@qalm/core';
import { YClient, call, signIn, stroke, ticket, until, type Tokens } from './helpers';
import { connectAgent, notebook, serverDoc, textOf, tool } from './mcp-helpers';
import { sessionOf } from '../src/grants';
import { setTestAi, setTestCropHook } from '../src/lecture';

// Review fixes for lecture mode on the server (crop state, deletion, tombstones, transcription limits, MCP output).
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
afterEach(() => {
  setTestAi(false);
  setTestCropHook(null);
});
setTestAi(false);

async function startLecture(t: Tokens, nb: string, sid: string, state: 'recording' | 'stopped' = 'recording') {
  const c = await YClient.connect(t.accessToken, lectureDocId(nb, sid));
  const lec = new LectureDoc(c.doc);
  lec.setMeta({ id: sid, notebookId: nb, startedAt: Date.now(), state, transcriber: 'cloud' });
  return { c, lec };
}
const lecOnServer = async (nb: string, sid: string) => new LectureDoc(await serverDoc(lectureDocId(nb, sid)));

async function putAsset(t: Tokens, bytes: Uint8Array, type = 'audio/webm'): Promise<string> {
  const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const r = await call(`/assets/${sha}`, { method: 'PUT', token: t.accessToken, body: bytes as unknown as BodyInit, headers: { 'Content-Type': type } });
  expect([200, 201]).toContain(r.status);
  return sha;
}
const refs = async (docId: string) =>
  (await env.DB.prepare('SELECT sha256 FROM lecture_assets WHERE doc_id = ?1').bind(docId).all<{ sha256: string }>()).results.map((r) => r.sha256);
const owns = async (userId: string, sha: string) => !!(await env.DB.prepare('SELECT 1 FROM user_assets WHERE user_id = ?1 AND sha256 = ?2').bind(userId, sha).first());

const transcribe = (t: Tokens, body: BodyInit, headers: Record<string, string> = {}) =>
  call('/lectures/transcribe?lang=en', { method: 'POST', token: t.accessToken, body, headers: { 'Content-Type': 'audio/webm', ...headers } });
const fakeWhisper = (secs: number) =>
  setTestAi(async () => ({ text: 'hello', transcription_info: { duration: secs }, segments: [{ start: 0, end: 1, text: ' hello' }] }));

describe('lecture crops: start, backoff, flush, expiry', () => {
  it('crops start at the session start; a failing crop backs off; a stopped session takes no later crops', async () => {
    const t = await signIn('rev-crops@example.com');
    const n = await notebook(t, 'revcrop', 'Crops', { ai: false });
    // Ink from before the lecture: never part of its crops.
    n.page.addItem(stroke('old', 50, 100, 300, 140));
    await pause(400);
    const s1 = await startLecture(t, 'revcrop', 's1');
    await until(async () => (await lecOnServer('revcrop', 's1')).meta().state === 'recording');
    s1.lec.appendEvents([{ t: 0, k: 'start', at: 1 }, { t: 100, k: 'pause' }]);
    s1.lec.setMeta({ state: 'paused' });
    await pause(1500);
    expect((await lecOnServer('revcrop', 's1')).crops()).toHaveLength(0);

    // Resume; every crop attempt fails: one attempt, then a back-off, not one per pen-up.
    let attempts = 0;
    setTestCropHook(() => {
      attempts++;
      throw new Error('render failed');
    });
    s1.lec.setMeta({ state: 'recording' });
    for (let i = 0; i < 4; i++) {
      n.page.addItem(stroke(`n${i}`, 50, 200 + i * 40, 300, 220 + i * 40));
      s1.lec.appendEvents([{ t: 1000 + i * 500, k: 'add', p: n.pageId, items: [] }]);
      await pause(500);
    }
    await until(async () => attempts >= 1, 5000);
    await pause(1500);
    expect(attempts).toBe(1);

    // Stop while paused (no crop then: still backing off), then a second session records on the same notebook:
    // only that one gets crops, the stopped one never again.
    setTestCropHook(null);
    s1.lec.setMeta({ state: 'paused' });
    s1.lec.setMeta({ state: 'stopped' });
    await until(async () => (await lecOnServer('revcrop', 's1')).meta().state === 'stopped');
    const s2 = await startLecture(t, 'revcrop', 's2');
    await until(async () => (await lecOnServer('revcrop', 's2')).meta().state === 'recording');
    await pause(50);
    n.page.addItem(stroke('late', 50, 500, 300, 540));
    s2.lec.appendEvents([{ t: 300, k: 'add', p: n.pageId, items: [] }]);
    await until(async () => (await lecOnServer('revcrop', 's2')).crops().length === 1, 8000);
    expect((await lecOnServer('revcrop', 's1')).crops()).toHaveLength(0);
    // s2's first crop covers only ink written since it started.
    expect((await lecOnServer('revcrop', 's2')).crops()[0]!.regions.reduce((a, r) => a + r.add, 0)).toBe(0); // first look
    for (const x of [s1, s2]) x.c.close();
    n.nbc.close();
    n.pgc.close();
  });

  it('an imported (stopped) session gets no crops; a live session that goes silent expires', { timeout: 40_000 }, async () => {
    const email = 'rev-expire@example.com';
    const t = await signIn(email);
    const n = await notebook(t, 'revexp', 'Expire');
    const token = await connectAgent(email, { comment: true, transcribe: true });
    const s = sessionOf('revexp');
    const imported = await startLecture(t, 'revexp', 'imp', 'stopped');
    await until(async () => (await lecOnServer('revexp', 'imp')).meta().state === 'stopped');
    const live = await startLecture(t, 'revexp', 'live');
    await until(async () => textOf(await tool(token, 'wait')).includes('recording'));
    n.page.addItem(stroke('a', 50, 100, 300, 140));
    live.lec.appendEvents([{ t: 500, k: 'add', p: n.pageId, items: [] }]);
    await until(async () => (await lecOnServer('revexp', 'live')).crops().length === 1, 8000);
    expect((await lecOnServer('revexp', 'imp')).crops()).toHaveLength(0);

    // The app crashed: nothing more is reported. After LECTURE_SILENT_MS (10 s in tests) it reads as stopped.
    live.c.close();
    await until(async () => !textOf(await tool(token, 'wait')).includes('recording'), 20_000);
    expect(textOf(await tool(token, 'read', { ref: 'outline', s }))).toMatch(/\nL2 \d{4}-\d{2}-\d{2} 00:00 stopped$/);
    imported.c.close();
    n.nbc.close();
    n.pgc.close();
  });
});

describe('deleting lectures: shared assets and tombstones', () => {
  it('keeps an asset another session still uses; a deleted session cannot be synced again', async () => {
    const t = await signIn('rev-del@example.com');
    const n = await notebook(t, 'revdel', 'Del', { ai: false });
    const sha = await putAsset(t, new Uint8Array(300).fill(3));
    const a = await startLecture(t, 'revdel', 'a');
    const b = await startLecture(t, 'revdel', 'b'); // e.g. an export of `a` imported again: same audio
    for (const x of [a, b]) x.lec.addAudio({ sha, mime: 'audio/webm', t0: 0, dur: 1000, bytes: 300 });
    await until(async () => (await refs(lectureDocId('revdel', 'a'))).length === 1 && (await refs(lectureDocId('revdel', 'b'))).length === 1);
    a.c.close();
    expect((await call('/lectures/revdel/a', { method: 'DELETE', token: t.accessToken })).status).toBe(200);
    expect(await env.ASSETS.head(sha)).not.toBeNull();
    expect(await owns(t.userId, sha)).toBe(true);
    // Tombstoned: no ticket, so another device's copy (or a queued transcript) can't bring it back.
    expect((await ticket(t.accessToken, lectureDocId('revdel', 'a'))).status).toBe(410);
    b.c.close();
    expect((await call('/lectures/revdel/b', { method: 'DELETE', token: t.accessToken })).status).toBe(200);
    expect(await env.ASSETS.head(sha)).toBeNull();
    expect(await owns(t.userId, sha)).toBe(false);
    n.nbc.close();
    n.pgc.close();
  });

  it('delete forever frees its sessions\' audio and crops (and keeps what another notebook\'s session uses)', async () => {
    const t = await signIn('rev-forever@example.com');
    const n = await notebook(t, 'revfor', 'Gone', { ai: false });
    const n2 = await notebook(t, 'revkeep', 'Kept', { ai: false });
    const only = await putAsset(t, new Uint8Array(200).fill(1));
    const both = await putAsset(t, new Uint8Array(200).fill(2));
    const a = await startLecture(t, 'revfor', 's1');
    a.lec.addAudio({ sha: only, mime: 'audio/webm', t0: 0, dur: 1000, bytes: 200 });
    a.lec.addAudio({ sha: both, mime: 'audio/webm', t0: 1000, dur: 1000, bytes: 200 });
    const k = await startLecture(t, 'revkeep', 's1');
    k.lec.addAudio({ sha: both, mime: 'audio/webm', t0: 0, dur: 1000, bytes: 200 });
    await until(async () => (await refs(lectureDocId('revfor', 's1'))).length === 2 && (await refs(lectureDocId('revkeep', 's1'))).length === 1);
    a.c.close();
    n.nbc.close();
    n.pgc.close();
    expect((await call('/notebooks/revfor', { method: 'DELETE', token: t.accessToken })).status).toBe(200);
    expect(await owns(t.userId, only)).toBe(false);
    expect(await env.ASSETS.head(only)).toBeNull();
    expect(await owns(t.userId, both)).toBe(true);
    expect(await env.ASSETS.head(both)).not.toBeNull();
    expect((await ticket(t.accessToken, lectureDocId('revfor', 's1'))).status).not.toBe(200);
    k.c.close();
    n2.nbc.close();
    n2.pgc.close();
  });
});

describe('transcription limits under concurrency', () => {
  it('parallel requests can\'t pass the per-minute limit', async () => {
    const t = await signIn('rev-par@example.com');
    fakeWhisper(1);
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => transcribe(t, new Uint8Array([1, i]))));
    const ok = rs.filter((r) => r.status === 200).length;
    expect(ok).toBeGreaterThan(0);
    expect(ok).toBeLessThanOrEqual(3);
    expect(rs.every((r) => r.status === 200 || r.status === 429)).toBe(true);
    // Rejected requests leave no usage behind.
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM transcribe_usage WHERE user_id = ?1').bind(t.userId).first<{ n: number }>();
    expect(n!.n).toBe(ok);
  });

  it('parallel requests can\'t pass the monthly cap: each is charged at most what is left', async () => {
    const t = await signIn('rev-cap@example.com');
    fakeWhisper(50);
    const rs = await Promise.all([0, 1, 2].map((i) => transcribe(t, new Uint8Array([2, i]), { 'X-Audio-Duration-Ms': '50000' })));
    expect(rs.some((r) => r.status === 200)).toBe(true);
    const used = await env.DB.prepare('SELECT COALESCE(SUM(ms), 0) AS ms FROM transcribe_usage WHERE user_id = ?1').bind(t.userId).first<{ ms: number }>();
    expect(used!.ms).toBeLessThanOrEqual(60_000); // 1 minute a month in tests
    await env.DB.prepare('UPDATE transcribe_usage SET at = at - 120000 WHERE user_id = ?1').bind(t.userId).run();
    if (used!.ms >= 60_000) expect((await transcribe(t, new Uint8Array([3]))).status).toBe(402);
  });

  it('refuses a body over 8 MB while streaming, without a Content-Length', async () => {
    const t = await signIn('rev-big@example.com');
    fakeWhisper(1);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= 9 * 1024 * 1024) return c.close();
        sent += 256 * 1024;
        c.enqueue(new Uint8Array(256 * 1024));
      },
    });
    const r = await call('/lectures/transcribe', { method: 'POST', token: t.accessToken, body, headers: { 'Content-Type': 'audio/webm' }, duplex: 'half' } as RequestInit & { token: string });
    expect(r.status).toBe(413);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM transcribe_usage WHERE user_id = ?1').bind(t.userId).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });
});

describe('lecture MCP output', () => {
  it('caps a long catch-up of live lines with a more: pointer, then carries on from the newest', async () => {
    const email = 'rev-cap-lines@example.com';
    const t = await signIn(email);
    const n = await notebook(t, 'revlines', 'Lines');
    const token = await connectAgent(email, { comment: true, transcribe: true });
    const s = sessionOf('revlines');
    const { c, lec } = await startLecture(t, 'revlines', 's1');
    await until(async () => textOf(await tool(token, 'wait')).includes('recording'));
    let w = tool(token, 'wait', { s });
    await pause(100);
    lec.addTranscript(Array.from({ length: 35 }, (_, i) => ({ t0: 1000 * (i + 1), t1: 1000 * (i + 1) + 500, text: `line ${i + 1}`, src: 'cloud' as const })));
    const lines = textOf(await w).split('\n');
    expect(lines.filter((l) => l.startsWith('L1 '))).toHaveLength(30);
    expect(lines.at(-1)).toBe('more: read("L1@00:31")');
    w = tool(token, 'wait', { s });
    await pause(100);
    lec.addTranscript([{ t0: 40_000, t1: 41_000, text: 'next', src: 'cloud' }]);
    expect(textOf(await w).split('\n').slice(1)).toEqual(['L1 00:40 "next"']);
    c.close();
    n.nbc.close();
    n.pgc.close();
  });

  it('read("L1") only sends images the notebook owner holds', async () => {
    const email = 'rev-owned@example.com';
    const t = await signIn(email);
    const other = await signIn('rev-owned-other@example.com');
    const n = await notebook(t, 'revown', 'Own');
    const token = await connectAgent(email, { comment: true, transcribe: true });
    const s = sessionOf('revown');
    const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, ...new Array(40).fill(0)]);
    const theirs = await putAsset(other, png, 'image/png');
    const { c, lec } = await startLecture(t, 'revown', 's1');
    // A client writes a crop pointing at someone else's asset.
    lec.addCrop({ t: 1000, sha: theirs, w: 1, h: 1, text: '', regions: [] }, 'client');
    lec.setMeta({ state: 'stopped', durationMs: 2000 });
    await until(async () => (await lecOnServer('revown', 's1')).crops().length === 1);
    await until(async () => textOf(await tool(token, 'read', { ref: 'outline', s })).includes('L1'));
    const read = await tool(token, 'read', { ref: 'L1', s });
    expect(read.content.map((x) => x.type)).not.toContain('image');
    expect(textOf(read)).toContain('(image missing)');
    c.close();
    n.nbc.close();
    n.pgc.close();
  });

  it('two agents waiting at once on ink and talk: no label lost or reused across the await', async () => {
    const email = 'rev-race@example.com';
    const t = await signIn(email);
    const n = await notebook(t, 'revrace', 'Race');
    const t1 = await connectAgent(email, { comment: true, transcribe: true }, 'One');
    const t2 = await connectAgent(email, { comment: true, transcribe: true }, 'Two');
    const s = sessionOf('revrace');
    const { c, lec } = await startLecture(t, 'revrace', 's1');
    await until(async () => textOf(await tool(t1, 'wait')).includes('recording'));
    const w1 = tool(t1, 'wait', { s });
    const w2 = tool(t2, 'wait', { s });
    await pause(100);
    n.page.addItems([stroke('x1', 50, 100, 200, 130), stroke('x2', 50, 400, 200, 430)]);
    lec.addTranscript([{ t0: 1000, t1: 2000, text: 'two regions', src: 'cloud' }]);
    const [u1, u2] = [textOf(await w1), textOf(await w2)];
    const labels = (u: string) => [...u.matchAll(/^(R\d+) /gm)].map((m) => m[1]!);
    expect(labels(u1)).toHaveLength(2);
    expect(labels(u2)).toHaveLength(2);
    expect(u1).toContain('L1 00:01 "two regions"');
    expect(u2).toContain('L1 00:01 "two regions"');
    // Each agent's labels are its own, never another's, and every one still resolves (none was overwritten).
    expect(new Set([...labels(u1), ...labels(u2)]).size).toBe(4);
    for (const [tok, u] of [[t1, u1], [t2, u2]] as const) for (const l of labels(u)) expect(textOf(await tool(tok, 'read', { ref: l, s }))).toContain(`#q ${l} `);
    c.close();
    n.nbc.close();
    n.pgc.close();
  });
});
