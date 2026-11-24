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
  it('crops show only ink written in the session; failures back off; a stop during back-off keeps its last crop', async () => {
    const t = await signIn('rev-crops@example.com');
    const n = await notebook(t, 'revcrop', 'Crops', { ai: false });
    // Ink from before the lecture: never part of its crops (the app logs it as the page's `base`).
    n.page.addItem(stroke('old', 50, 100, 300, 140));
    await pause(400);
    const s1 = await startLecture(t, 'revcrop', 's1');
    await until(async () => (await lecOnServer('revcrop', 's1')).meta().state === 'recording');
    s1.lec.appendEvents([{ t: 0, k: 'start', at: 1 }, { t: 0, k: 'base', p: n.pageId, ids: ['old'] }, { t: 100, k: 'pause' }]);
    s1.lec.setMeta({ state: 'paused' });
    await pause(1500);
    expect((await lecOnServer('revcrop', 's1')).crops()).toHaveLength(0);

    // Resume; every crop attempt fails: the retries back off (400 ms doubling in tests), not one per pen-up.
    const tries: number[] = [];
    setTestCropHook(() => {
      tries.push(Date.now());
      throw new Error('render failed');
    });
    s1.lec.setMeta({ state: 'recording' });
    for (let i = 0; i < 6; i++) {
      n.page.addItem(stroke(`n${i}`, 50, 200 + i * 40, 300, 220 + i * 40));
      s1.lec.appendEvents([{ t: 1000 + i * 500, k: 'add', p: n.pageId, items: [] }]);
      await pause(300);
    }
    await until(async () => tries.length >= 3, 8000);
    const gaps = tries.slice(1).map((x, i) => x - tries[i]!);
    expect(gaps[0]).toBeGreaterThanOrEqual(350);
    expect(gaps[1]).toBeGreaterThanOrEqual(700);

    // Stop while backing off: the last crop is not lost; it is made once the retry works.
    s1.lec.setMeta({ state: 'paused' });
    s1.lec.setMeta({ state: 'stopped' });
    setTestCropHook(null);
    await until(async () => (await lecOnServer('revcrop', 's1')).crops().length === 1, 10_000);
    const last = (await lecOnServer('revcrop', 's1')).crops()[0]!;
    expect(last.text).not.toContain('first look');
    expect(last.regions.reduce((a, r) => a + r.add, 0)).toBe(6); // the session's strokes, not 'old'

    // A second session on the same notebook gets crops; the stopped one never again.
    const s2 = await startLecture(t, 'revcrop', 's2');
    await until(async () => (await lecOnServer('revcrop', 's2')).meta().state === 'recording');
    s2.lec.appendEvents([{ t: 0, k: 'base', p: n.pageId, ids: ['old', 'n0', 'n1', 'n2', 'n3', 'n4', 'n5'] }]);
    await pause(50);
    n.page.addItem(stroke('late', 50, 500, 300, 540));
    s2.lec.appendEvents([{ t: 300, k: 'add', p: n.pageId, items: [] }]);
    await until(async () => (await lecOnServer('revcrop', 's2')).crops().length === 1, 8000);
    expect((await lecOnServer('revcrop', 's1')).crops()).toHaveLength(1);
    // s2's first crop of the page is only what it wrote (one stroke), not a first look at the whole page.
    const c2 = (await lecOnServer('revcrop', 's2')).crops()[0]!;
    expect(c2.text).not.toContain('first look');
    expect(c2.regions.reduce((a, r) => a + r.add, 0)).toBe(1);
    for (const x of [s1, s2]) x.c.close();
    n.nbc.close();
    n.pgc.close();
  });

  it('a crop whose storage fails is retried (storage only), not lost', async () => {
    const t = await signIn('rev-store@example.com');
    const n = await notebook(t, 'revstore', 'Store', { ai: false });
    const s = await startLecture(t, 'revstore', 's1');
    await until(async () => (await lecOnServer('revstore', 's1')).meta().state === 'recording');
    s.lec.appendEvents([{ t: 0, k: 'start', at: 1 }, { t: 0, k: 'base', p: n.pageId, ids: [] }]);
    const phases: string[] = [];
    let failStore = true;
    setTestCropHook((_ids, phase) => {
      phases.push(phase);
      if (phase === 'store' && failStore) {
        failStore = false;
        throw new Error('R2 down'); // after the labels and ink-seen state were saved
      }
    });
    n.page.addItem(stroke('a', 50, 100, 300, 140));
    s.lec.appendEvents([{ t: 500, k: 'add', p: n.pageId, items: [] }]);
    await until(async () => (await lecOnServer('revstore', 's1')).crops().length === 1, 8000);
    expect(phases).toEqual(['start', 'store', 'store']); // the retry stored the same crop, it didn't make a new one
    expect((await lecOnServer('revstore', 's1')).crops()[0]!.regions.reduce((a, r) => a + r.add, 0)).toBe(1);
    s.c.close();
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

  it('parallel requests pass the monthly cap by at most one request; a long chunk is charged in full', async () => {
    const t = await signIn('rev-cap@example.com');
    fakeWhisper(50);
    // 40 kB of audio (10 s at 32 kbps, at most 53 s at the 6 kbps floor), claimed as 1 s and heard as 50 s each.
    const chunk = (i: number) => new Uint8Array(40_000).fill(i + 1);
    const rs = await Promise.all([0, 1, 2].map((i) => transcribe(t, chunk(i), { 'X-Audio-Duration-Ms': '1000' })));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 200, 402]);
    const used = async () => (await env.DB.prepare('SELECT COALESCE(SUM(ms), 0) AS ms FROM transcribe_usage WHERE user_id = ?1').bind(t.userId).first<{ ms: number }>())!.ms;
    expect(await used()).toBe(100_000); // the cap (60 s) passed by the one request that took what was left
    await env.DB.prepare('UPDATE transcribe_usage SET at = at - 120000 WHERE user_id = ?1').bind(t.userId).run();
    expect((await transcribe(t, chunk(5))).status).toBe(402);

    // 30 minutes heard is charged as 30 minutes (no 10-minute clamp).
    const t2 = await signIn('rev-long@example.com');
    fakeWhisper(1800);
    const r = await transcribe(t2, chunk(6));
    expect(r.status).toBe(200);
    expect(((await r.json()) as { durationMs: number }).durationMs).toBe(1_800_000);
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
    // 35 lines; the 5 left out arrived last but are earlier on the timeline (an older chunk transcribed late).
    const t0 = (i: number) => (i < 30 ? 10_000 + 1000 * i : 9000 - 1000 * (i - 30));
    lec.addTranscript(Array.from({ length: 35 }, (_, i) => ({ t0: t0(i), t1: t0(i) + 500, text: `line ${i + 1}`, src: 'cloud' as const })));
    const lines = textOf(await w).split('\n');
    expect(lines.filter((l) => l.startsWith('L1 '))).toHaveLength(30);
    expect(lines.at(-1)).toBe('more: read("L1@00:05")'); // the earliest line left out
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

describe('review 2: uploads, imports, shared page assets', () => {
  it('lecture audio uploads name their session: recorded at once while it lives, refused once it is deleted', async () => {
    const t = await signIn('rev-tag@example.com');
    const n = await notebook(t, 'revtag', 'Tag', { ai: false });
    const s = await startLecture(t, 'revtag', 's1');
    const doc = lectureDocId('revtag', 's1');
    const put = async (bytes: Uint8Array) => {
      const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
      const r = await call(`/assets/${sha}`, { method: 'PUT', token: t.accessToken, body: bytes as unknown as BodyInit, headers: { 'Content-Type': 'audio/webm', 'X-Qalm-Lecture': doc } });
      return { sha, status: r.status };
    };
    // The app sends the header cross-origin (app:// → the API): the preflight must allow it, or uploads never go.
    const pre = await call(`/assets/${'0'.repeat(64)}`, { method: 'OPTIONS', headers: { Origin: 'app://qalm', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type,x-qalm-lecture' } });
    expect(pre.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toContain('x-qalm-lecture');
    const first = await put(new Uint8Array(200).fill(4));
    expect(first.status).toBe(201);
    expect(await refs(doc)).toEqual([first.sha]); // before the session doc even mentions it
    expect(await (await call('/lectures/revtag/s1', { token: t.accessToken })).json()).toEqual({ deleted: false });
    const other = await signIn('rev-tag-other@example.com');
    expect((await call('/lectures/revtag/s1', { token: other.accessToken })).status).toBe(404);
    s.c.close();
    expect((await call('/lectures/revtag/s1', { method: 'DELETE', token: t.accessToken })).status).toBe(200);
    expect(await owns(t.userId, first.sha)).toBe(false);
    // Its status says deleted (a device that crashed while recording it asks before touching it again).
    expect(await (await call('/lectures/revtag/s1', { token: t.accessToken })).json()).toEqual({ deleted: true });
    // A queued upload that lands after the delete is refused: nothing to count against storage.
    const late = await put(new Uint8Array(200).fill(5));
    expect(late.status).toBe(410);
    expect(await owns(t.userId, late.sha)).toBe(false);
    n.nbc.close();
    n.pgc.close();
  });

  it('an imported (stopped) session sends no live lines; read("L…") still has its transcript', async () => {
    const email = 'rev-imp@example.com';
    const t = await signIn(email);
    const n = await notebook(t, 'revimp', 'Imported');
    const token = await connectAgent(email, { comment: true, transcribe: true });
    const s = sessionOf('revimp');
    const w = tool(token, 'wait', { s }); // the agent follows from here
    await pause(100);
    const imp = await startLecture(t, 'revimp', 'imp', 'stopped');
    imp.lec.setMeta({ durationMs: 5000 });
    imp.lec.addTranscript([{ t0: 1000, t1: 2000, text: 'from the import', src: 'cloud' }]);
    expect(textOf(await w)).toBe(`#q s=${s} no changes`);
    await until(async () => textOf(await tool(token, 'read', { ref: 'outline', s })).includes('L1'));
    expect(textOf(await tool(token, 'read', { ref: 'L1', s }))).toContain('00:01 "from the import"');
    imp.c.close();
    n.nbc.close();
    n.pgc.close();
  });

  it('deleting a session keeps an asset a notebook page also uses', async () => {
    const t = await signIn('rev-page@example.com');
    const n = await notebook(t, 'revpage', 'Pages', { ai: false });
    const bytes = new Uint8Array(250).fill(8);
    const sha = await putAsset(t, bytes, 'image/png');
    n.nb.addAsset({ id: 'img1', sha256: sha, mime: 'image/png', name: 'diagram.png', bytes: 250 });
    await until(async () => (await serverNotebookAssets('revpage')).includes(sha));
    const s = await startLecture(t, 'revpage', 's1');
    s.lec.addCrop({ t: 1, sha, w: 1, h: 1, text: '', regions: [] }, 'client'); // the same bytes, as a crop
    await until(async () => (await refs(lectureDocId('revpage', 's1'))).includes(sha));
    s.c.close();
    expect((await call('/lectures/revpage/s1', { method: 'DELETE', token: t.accessToken })).status).toBe(200);
    expect(await owns(t.userId, sha)).toBe(true);
    expect(await env.ASSETS.head(sha)).not.toBeNull();
    n.nbc.close();
    n.pgc.close();
  });
});

async function serverNotebookAssets(id: string): Promise<string[]> {
  const { Notebook } = await import('@qalm/core');
  return new Notebook(await serverDoc(`nb:${id}`)).assets().map((a) => a.sha256);
}
