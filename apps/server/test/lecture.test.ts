import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { LectureDoc, lectureDocId } from '@qalm/core';
import { YClient, call, signIn, stroke, ticket, until, type Tokens } from './helpers';
import { connectAgent, notebook, serverDoc, textOf, tool } from './mcp-helpers';
import { sessionOf } from '../src/grants';
import { setTestAi } from '../src/lecture';

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Never reach the real Workers AI from tests: every test sets a fake (or "no binding") first.
afterEach(() => setTestAi(false));
setTestAi(false);

/** A recording session on notebook `nb` over sync: its doc client and wrapper. */
async function startLecture(t: Tokens, nb: string, sid: string) {
  const c = await YClient.connect(t.accessToken, lectureDocId(nb, sid));
  const lec = new LectureDoc(c.doc);
  lec.setMeta({ id: sid, notebookId: nb, startedAt: Date.now(), state: 'recording', transcriber: 'cloud' });
  return { c, lec };
}

const lecOnServer = async (nb: string, sid: string) => new LectureDoc(await serverDoc(lectureDocId(nb, sid)));

function fakeWhisper(calls: Record<string, unknown>[]) {
  setTestAi(async (model, input) => {
    calls.push({ model, ...input });
    return {
      text: 'today we integrate',
      transcription_info: { duration: 12.5 },
      segments: [
        { start: 0.4, end: 2.1, text: ' today we', words: [{ word: 'today', start: 0.4, end: 0.9 }, { word: 'we', start: 1, end: 1.2 }] },
        { start: 2.5, end: 4, text: ' integrate', words: [{ word: 'integrate', start: 2.5, end: 3.9 }] },
      ],
    };
  });
}

const transcribe = (t: Tokens, body: Uint8Array, headers: Record<string, string> = {}) =>
  call('/lectures/transcribe?lang=en', { method: 'POST', token: t.accessToken, body: body as unknown as BodyInit, headers: { 'Content-Type': 'audio/webm;codecs=opus', ...headers } });

describe('lecture sessions: sync and storage', () => {
  it('syncs a session doc that counts towards its owner and no one else can open', async () => {
    const t = await signIn('lec-store@example.com');
    const other = await signIn('lec-other@example.com');
    const n = await notebook(t, 'lecstore', 'Lectures', { ai: false });
    const { c, lec } = await startLecture(t, 'lecstore', 's1');
    lec.appendEvents([{ t: 0, k: 'start', at: 1 }, { t: 10, k: 'add', p: n.pageId, items: [stroke('a', 1, 1, 50, 50)] }]);
    await until(async () => (await lecOnServer('lecstore', 's1')).events().length === 2);
    // The other user can't get a ticket for it.
    expect((await ticket(other.accessToken, lectureDocId('lecstore', 's1'))).status).toBe(403);
    // Its stored size lands in doc_sizes for the notebook's owner (the room reports a few seconds after a write).
    await until(async () => !!(await env.DB.prepare('SELECT bytes FROM doc_sizes WHERE doc_id = ?1 AND user_id = ?2').bind(lectureDocId('lecstore', 's1'), t.userId).first()), 9000);
    const usage = (await (await call('/me/storage', { token: t.accessToken })).json()) as { notebookBytes: number };
    const row = await env.DB.prepare('SELECT bytes FROM doc_sizes WHERE doc_id = ?1').bind(lectureDocId('lecstore', 's1')).first<{ bytes: number }>();
    expect(usage.notebookBytes).toBeGreaterThanOrEqual(row!.bytes);
    // Page docs stay free of lecture data.
    expect([...(await serverDoc(`pg:lecstore:${n.pageId}`)).share.keys()].some((k) => /timeline|lect/.test(k))).toBe(false);
    c.close();
    n.nbc.close();
    n.pgc.close();
  });
});

describe('POST /lectures/transcribe', () => {
  it('returns timed segments from Whisper and counts the minutes', async () => {
    const t = await signIn('lec-asr@example.com');
    const calls: Record<string, unknown>[] = [];
    fakeWhisper(calls);
    const r = await transcribe(t, new Uint8Array([26, 69, 223, 163, 1, 2, 3]), { 'X-Audio-Duration-Ms': '12000' });
    expect(r.status).toBe(200);
    const body = (await r.json()) as { segments: unknown[]; durationMs: number; limitMinutes: number };
    expect(body.durationMs).toBe(12500);
    expect(body.limitMinutes).toBe(1);
    expect(body.segments).toEqual([
      { t0: 400, t1: 2100, text: 'today we', words: [{ w: 'today', t0: 400, t1: 900 }, { w: 'we', t0: 1000, t1: 1200 }], src: 'cloud' },
      { t0: 2500, t1: 4000, text: 'integrate', words: [{ w: 'integrate', t0: 2500, t1: 3900 }], src: 'cloud' },
    ]);
    expect(calls[0]).toMatchObject({ model: '@cf/openai/whisper-large-v3-turbo', language: 'en', task: 'transcribe' });
    expect(typeof calls[0]!.audio).toBe('string'); // base64
    const used = await env.DB.prepare('SELECT SUM(ms) AS ms FROM transcribe_usage WHERE user_id = ?1').bind(t.userId).first<{ ms: number }>();
    expect(used!.ms).toBe(12500);
  });

  it('needs sign-in and audio, rate-limits per user and caps minutes per month', async () => {
    const t = await signIn('lec-limit@example.com');
    fakeWhisper([]);
    expect((await call('/lectures/transcribe', { method: 'POST', body: 'x', headers: { 'Content-Type': 'audio/webm' } })).status).toBe(401);
    expect((await transcribe(t, new Uint8Array([1]), { 'Content-Type': 'text/plain' })).status).toBe(415);
    // 3 per minute in tests (TRANSCRIBE_PER_MINUTE).
    for (let i = 0; i < 3; i++) expect((await transcribe(t, new Uint8Array([1, i]))).status).toBe(200);
    const limited = await transcribe(t, new Uint8Array([9]));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
    // 1 minute a month in tests: the 3 chunks used 37.5 s; one more long chunk passes the cap.
    await env.DB.prepare('UPDATE transcribe_usage SET at = at - 120000 WHERE user_id = ?1').bind(t.userId).run();
    expect((await transcribe(t, new Uint8Array([2]), { 'X-Audio-Duration-Ms': '30000' })).status).toBe(200);
    await env.DB.prepare('UPDATE transcribe_usage SET at = at - 120000 WHERE user_id = ?1').bind(t.userId).run();
    const quota = await transcribe(t, new Uint8Array([3]));
    expect(quota.status).toBe(402);
    expect(((await quota.json()) as { code: string }).code).toBe('transcribe_quota');
  });

  it('answers 503 without the AI binding and doesn\'t count a failed run', async () => {
    const t = await signIn('lec-noai@example.com');
    setTestAi(false);
    expect((await transcribe(t, new Uint8Array([1]))).status).toBe(503);
    setTestAi(async () => {
      throw new Error('model down');
    });
    expect((await transcribe(t, new Uint8Array([1]))).status).toBe(502);
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM transcribe_usage WHERE user_id = ?1').bind(t.userId).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });
});

describe('lecture crops and MCP', () => {
  it('stores the crops an agent would get, sends live transcript lines, and reads a finished lecture', async () => {
    const email = 'lec-mcp@example.com';
    const t = await signIn(email);
    const n = await notebook(t, 'lecmcp', 'Calculus');
    const token = await connectAgent(email, { comment: true, transcribe: true });
    const s = sessionOf('lecmcp');
    const { c, lec } = await startLecture(t, 'lecmcp', 'sess1');
    await until(async () => (await lecOnServer('lecmcp', 'sess1')).meta().state === 'recording');
    expect(textOf(await tool(token, 'wait'))).toContain('lecture L1 recording');
    // The agent is following; it gets no replay of what was said before (nothing yet).

    // The teacher writes; the client logs it and flushes the timeline.
    let w = tool(token, 'wait', { s });
    await pause(50);
    n.page.addItems([stroke('e1', 50, 100, 100, 120), stroke('e2', 105, 100, 150, 120)]);
    lec.appendEvents([{ t: 4200, k: 'add', p: n.pageId, items: [stroke('e1', 50, 100, 100, 120), stroke('e2', 105, 100, 150, 120)] }]);
    const up = await w;
    expect(textOf(up).split('\n')[1]).toBe('R1 [1] p1 @84,168 169x34');

    // At the pause, the session got the same region as a crop: a PNG asset of the owner, stamped with the last event.
    await until(async () => (await lecOnServer('lecmcp', 'sess1')).crops().length === 1, 8000);
    const crop = (await lecOnServer('lecmcp', 'sess1')).crops()[0]!;
    expect(crop).toMatchObject({ t: 4200, regions: [{ row: 1, page: 1, box: [84, 168, 169, 34], add: 0, erase: 0 }] });
    expect(crop.regions[0]!.label).toMatch(/^R\d+$/);
    expect(crop.text).toContain(`#q s=${s} r=1 p1 1000x1415 first look`);
    expect(crop.sha).toMatch(/^[0-9a-f]{64}$/);
    expect(await env.ASSETS.head(crop.sha)).not.toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM user_assets WHERE user_id = ?1 AND sha256 = ?2').bind(t.userId, crop.sha).first()).not.toBeNull();
    // The crop's label is a real region: the agent can read it.
    expect(textOf(await tool(token, 'read', { ref: crop.regions[0]!.label, s }))).toContain(`#q ${crop.regions[0]!.label} [1] p1`);

    // Transcript lines arrive with the next update (talk alone wakes a wait, after the rate limit).
    w = tool(token, 'wait', { s });
    await pause(50);
    lec.addTranscript([{ t0: 3000, t1: 5000, text: 'the integral of two x', src: 'cloud' }]);
    const talk = await w;
    expect(textOf(talk)).toBe([`#q s=${s} r=2`, 'L1 00:03 "the integral of two x"'].join('\n'));

    // Erasing then pausing: the pause flushes a crop at once.
    n.page.removeItems(['e2']);
    lec.appendEvents([{ t: 9000, k: 'erase', p: n.pageId, items: [stroke('e2', 105, 100, 150, 120)] }, { t: 9000, k: 'pause' }]);
    lec.setMeta({ state: 'paused' });
    await until(async () => (await lecOnServer('lecmcp', 'sess1')).crops().length === 2, 8000);
    expect((await lecOnServer('lecmcp', 'sess1')).crops()[1]).toMatchObject({ t: 9000, regions: [{ erase: 1 }] });

    // Stopped: read it back, transcript and crops interleaved, images included.
    lec.setMeta({ state: 'stopped' });
    await until(async () => (await lecOnServer('lecmcp', 'sess1')).meta().state === 'stopped');
    await until(async () => !textOf(await tool(token, 'read', { ref: 'outline', s })).includes('recording'));
    expect(textOf(await tool(token, 'read', { ref: 'outline', s }))).toMatch(/\nL1 \d{4}-\d{2}-\d{2} 00:09 stopped$/);
    const read = await tool(token, 'read', { ref: 'L1', s });
    expect(read.content.map((x) => x.type)).toEqual(['text', 'image', 'text', 'image']);
    const lines = textOf(read).split('\n');
    expect(lines[0]).toBe('#q L1 00:00-00:09 of 00:09 stopped');
    expect(lines[1]).toBe('00:03 "the integral of two x"');
    expect(lines[2]).toMatch(/^00:04 R\d+ \[1\] p1 @84,168 169x34$/);
    expect(lines[3]).toMatch(/^00:09 R\d+ \[1\] p1 @\d+,\d+ \d+x\d+ -1$/);
    expect((await tool(token, 'read', { ref: 'L9', s })).isError).toBe(true);
    c.close();
    n.nbc.close();
    n.pgc.close();
  });
});

describe('deleting lectures', () => {
  it('DELETE /lectures/{nb}/{sid} frees its room, audio and crops', async () => {
    const t = await signIn('lec-del@example.com');
    const other = await signIn('lec-del-other@example.com');
    const n = await notebook(t, 'lecdel', 'Delete me', { ai: false });
    const { c, lec } = await startLecture(t, 'lecdel', 's1');
    const audio = new Uint8Array(400).fill(7);
    const sha = [...new Uint8Array(await crypto.subtle.digest('SHA-256', audio))].map((b) => b.toString(16).padStart(2, '0')).join('');
    expect((await call(`/assets/${sha}`, { method: 'PUT', token: t.accessToken, body: audio as unknown as BodyInit, headers: { 'Content-Type': 'audio/webm' } })).status).toBe(201);
    lec.addAudio({ sha, mime: 'audio/webm', t0: 0, dur: 1000, bytes: 400 });
    await until(async () => (await lecOnServer('lecdel', 's1')).audio().length === 1);
    c.close();
    expect((await call('/lectures/lecdel/s1', { method: 'DELETE', token: other.accessToken })).status).toBe(404);
    expect((await call('/lectures/lecdel/s1', { method: 'DELETE', token: t.accessToken })).status).toBe(200);
    expect(Y.encodeStateAsUpdate(await serverDoc(lectureDocId('lecdel', 's1'))).byteLength).toBeLessThanOrEqual(2);
    expect(await env.ASSETS.head(sha)).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM user_assets WHERE sha256 = ?1').bind(sha).first()).toBeNull();
    expect(await env.DB.prepare('SELECT 1 FROM doc_sizes WHERE doc_id = ?1').bind(lectureDocId('lecdel', 's1')).first()).toBeNull();
    n.nbc.close();
    n.pgc.close();
  });

  it('account deletion removes lecture rooms and transcription usage', async () => {
    const email = 'lec-acct@example.com';
    const t = await signIn(email);
    const n = await notebook(t, 'lecacct', 'Bye', { ai: false });
    const { c, lec } = await startLecture(t, 'lecacct', 's1');
    lec.appendEvents([{ t: 0, k: 'start', at: 1 }]);
    await until(async () => (await lecOnServer('lecacct', 's1')).events().length === 1);
    await until(async () => !!(await env.DB.prepare('SELECT 1 FROM doc_sizes WHERE doc_id = ?1').bind(lectureDocId('lecacct', 's1')).first()), 9000);
    fakeWhisper([]);
    expect((await transcribe(t, new Uint8Array([1]))).status).toBe(200);
    c.close();
    n.nbc.close();
    n.pgc.close();
    // Delete the account with the emailed code (as account.test.ts does).
    const { deleteAccount } = await import('../src/account');
    await env.DB.prepare('UPDATE users SET deleting_at = 1 WHERE id = ?1').bind(t.userId).run();
    await deleteAccount(env, { id: t.userId, email, deleting_at: 1 });
    expect(Y.encodeStateAsUpdate(await serverDoc(lectureDocId('lecacct', 's1'))).byteLength).toBeLessThanOrEqual(2);
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM transcribe_usage WHERE user_id = ?1').bind(t.userId).first<{ n: number }>())!.n).toBe(0);
  });

  it('delete forever of a notebook purges its lecture rooms', async () => {
    const t = await signIn('lec-nbdel@example.com');
    const n = await notebook(t, 'lecnbdel', 'Gone', { ai: false });
    const { c, lec } = await startLecture(t, 'lecnbdel', 's1');
    lec.appendEvents([{ t: 0, k: 'start', at: 1 }]);
    await until(async () => (await lecOnServer('lecnbdel', 's1')).events().length === 1);
    c.close();
    n.nbc.close();
    n.pgc.close();
    await until(async () => !!(await env.DB.prepare('SELECT 1 FROM doc_sizes WHERE doc_id = ?1').bind(lectureDocId('lecnbdel', 's1')).first()), 9000);
    expect((await call('/notebooks/lecnbdel', { method: 'DELETE', token: t.accessToken })).status).toBe(200);
    expect(Y.encodeStateAsUpdate(await serverDoc(lectureDocId('lecnbdel', 's1'))).byteLength).toBeLessThanOrEqual(2);
    expect(await env.DB.prepare('SELECT 1 FROM doc_sizes WHERE doc_id = ?1').bind(lectureDocId('lecnbdel', 's1')).first()).toBeNull();
  });
});
