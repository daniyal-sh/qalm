import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Notebook, Page } from '@qalm/core';
import { YClient, call, signIn, stroke, ticket, until } from './helpers';
import { b64url, connectAgent, mcp, tool, textOf, serverDoc, editLibrary, serverAi, aiRow, notebook, inkOf } from './mcp-helpers';
import { sessionOf } from '../src/grants';

describe('mcp', () => {
  it('rejects requests without an OAuth token', async () => {
    const r = await call('/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(r.status).toBe(401);
    expect(r.headers.get('WWW-Authenticate')).toContain('resource_metadata');
    // App access tokens are not MCP tokens.
    const app = await signIn('mcp-app@example.com');
    expect((await call('/mcp', { method: 'POST', token: app.accessToken, body: '{}' })).status).toBe(401);
  });

  it('wait / read / transcribe / comment end to end', async () => {
    const t = await signIn('student@example.com');
    const n = await notebook(t, 'calc2nb', 'Calc 2');
    const other = await notebook(t, 'secretnb', 'Diary');
    other.page.addItem(stroke('x1', 50, 100, 150, 120));
    const token = await connectAgent('student@example.com', { notebooks: ['calc2nb'], comment: true, transcribe: true });

    const init = await mcp(token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    expect(init.result.serverInfo.name).toBe('qalm');
    const list = await mcp(token, 'tools/list');
    expect(list.result.tools.map((x: { name: string }) => x.name).sort()).toEqual(['comment', 'read', 'transcribe', 'wait']);

    // No s: lists only the granted notebook.
    const sessions = textOf(await tool(token, 'wait'));
    const s = sessionOf('calc2nb');
    expect(sessions).toContain(`s=${s} "Calc 2"`);
    expect(sessions).not.toContain('Diary');

    // The first wait registers the agent; then the student writes two rows far apart and pauses.
    const waiting = tool(token, 'wait', { s });
    await new Promise((r) => setTimeout(r, 50));
    n.page.addItem(stroke('s1', 50, 100, 200, 120));
    n.page.addItem(stroke('s2', 50, 200, 200, 220));
    const up = await waiting;
    const text = textOf(up);
    // The agent's first update for the page: a first look, one region per cluster, each a row of the image.
    expect(text).toBe([`#q s=${s} r=1 p1 1000x1415 first look`, 'R1 [1] p1 @84,168 253x34', 'R2 [2] p1 @84,336 253x34'].join('\n'));
    const img = up.content.find((c) => c.type === 'image') as { data: string; mimeType: string } | undefined;
    expect(img?.mimeType).toBe('image/png');
    const png = Uint8Array.from(atob(img!.data), (c) => c.charCodeAt(0));
    expect([...png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);

    const before = inkOf(n.page);
    // transcribe saves a reading of the region's strokes.
    const tr = await tool(token, 'transcribe', { ref: 'R1', text: 'x^3/3' });
    expect(textOf(tr)).toBe('Saved R1');
    await until(() => n.page.readings().some((r) => r.text === 'x^3/3'));
    expect(n.page.readings()[0]).toMatchObject({ ids: ['s1'], src: 'agent', by: 'Tutor' }); // the agent's name, shown with the reading
    const read = textOf(await tool(token, 'read', { ref: 'p1', s }));
    expect(read).toBe(['#q p1 1000x1415', 'R1 p1 @84,168 253x34 "x^3/3"', 'R2 [1] p1 @84,336 253x34'].join('\n'));

    // comment starts a thread on the region's strokes.
    const cm = await tool(token, 'comment', { ref: 'R2', text: 'Check the sign' });
    expect(textOf(cm)).toBe('Commented on R2 as thread C1');
    await until(() => n.page.comments().length === 1);
    const c = n.page.comments()[0]!;
    expect(c).toMatchObject({ anchorIds: ['s2'], text: 'Check the sign', author: { kind: 'agent', name: 'Tutor' } });

    // No tool changed the ink.
    expect(inkOf(n.page)).toBe(before);
    expect(n.page.items().map((i) => i.id).sort()).toEqual(['s1', 's2']);

    // An Ask wakes the agent at once, with the question.
    const asked = tool(token, 'wait', { s });
    await new Promise((r) => setTimeout(r, 50));
    n.nb.addAsk(n.pageId, 'is R2 right?');
    const at = Date.now();
    const askText = textOf(await asked);
    expect(Date.now() - at).toBeLessThan(700);
    expect(askText).toContain('ask "is R2 right?"');

    // Bad refs fail softly.
    expect((await tool(token, 'comment', { ref: 'R99', text: 'x' })).isError).toBe(true);
    expect((await tool(token, 'comment', { ref: 'p1:L2', text: 'x' })).isError).toBe(true);
    expect((await tool(token, 'transcribe', { ref: 'p1', text: 'x' })).isError).toBe(true);
    expect((await tool(token, 'read', { ref: 'p9' })).isError).toBe(true);
    expect((await tool(token, 'read', { ref: 'nonsense' })).isError).toBe(true);
    // Another notebook is outside the grant.
    expect((await tool(token, 'read', { ref: 'p1', s: sessionOf('secretnb') })).isError).toBe(true);

    // Activity is logged for the student.
    const act = (await (await call('/ai/activity', { token: t.accessToken })).json()) as { activity: { tool: string }[] };
    expect(new Set(act.activity.map((a) => a.tool))).toEqual(new Set(['wait', 'read', 'transcribe', 'comment']));
    for (const x of [n.nbc, n.pgc, other.nbc, other.pgc]) x.close();
  });

  it('wait merges edits into one net diff and rate-limits wakes', async () => {
    const t = await signIn('netdiff@example.com');
    const n = await notebook(t, 'netnb', 'Net');
    const token = await connectAgent('netdiff@example.com', { notebooks: ['netnb'], comment: false, transcribe: false });
    const s = sessionOf('netnb');
    const first = tool(token, 'wait', { s });
    await new Promise((r) => setTimeout(r, 50));
    n.page.addItem(stroke('a1', 50, 100, 200, 120));
    expect(textOf(await first)).toContain('R1 [1] p1 @');

    // Written and erased between updates: it never appears.
    const t0 = Date.now();
    const second = tool(token, 'wait', { s });
    n.page.addItem(stroke('gone', 50, 300, 200, 320));
    n.page.removeItems(['gone']);
    n.page.addItem(stroke('a2', 50, 200, 200, 220));
    const text = textOf(await second);
    // The test min interval is 800 ms.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(700);
    expect(text.split('\n').slice(1)).toEqual(['R2 [1] p1 @84,336 253x34 +1']); // no trace of the stroke written and erased
    n.nbc.close();
    n.pgc.close();
  });

  it('enforces the transcribe and comment switches, and revocation', async () => {
    const t = await signIn('locked@example.com');
    const n = await notebook(t, 'locknb', 'Locked');
    n.page.addItem(stroke('k1', 50, 100, 200, 120));
    const token = await connectAgent('locked@example.com', { notebooks: ['locknb'], comment: false, transcribe: false }, 'Viewer');
    const s = sessionOf('locknb');
    expect(textOf(await tool(token, 'read', { ref: 'p1', s }))).toContain('R1 [1]');
    const tr = await tool(token, 'transcribe', { ref: 'R1', text: 'hi' });
    expect(tr.isError).toBe(true);
    expect(textOf(tr)).toContain('may not save transcriptions');
    const cm = await tool(token, 'comment', { ref: 'R1', text: 'hi' });
    expect(cm.isError).toBe(true);
    expect(n.page.comments()).toHaveLength(0);
    expect(n.page.readings()).toHaveLength(0);

    const grants = (await (await call('/ai/grants', { token: t.accessToken })).json()) as { grants: { id: string; clientName: string }[] };
    const g = grants.grants.find((x) => x.clientName === 'Viewer')!;

    // The student turns comments on in Settings → AI access.
    const patch = await call(`/ai/grants/${g.id}`, { method: 'PATCH', token: t.accessToken, body: JSON.stringify({ canComment: true, notebookIds: ['locknb', 'not-mine'] }) });
    expect(patch.status).toBe(200);
    const pg = ((await patch.json()) as { grant: { canComment: boolean; canTranscribe: boolean; notebookIds: string[] } }).grant;
    expect(pg).toMatchObject({ canComment: true, canTranscribe: false, notebookIds: ['locknb'] });
    expect((await tool(token, 'comment', { ref: 'R1', text: 'now allowed' })).isError).toBeFalsy();
    const pre = await call('/ai/grants', { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'PATCH' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBe('*');

    // Then revokes access.
    expect((await call(`/ai/grants/${g.id}`, { method: 'DELETE', token: t.accessToken })).status).toBe(200);
    const after = await call('/mcp', { method: 'POST', token, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(after.status).toBe(401);
    n.nbc.close();
    n.pgc.close();
  });

  it("transcribe never overwrites the student's own text", async () => {
    const t = await signIn('typed@example.com');
    const n = await notebook(t, 'typednb', 'Typed');
    n.page.addItem(stroke('u1', 50, 100, 200, 120));
    n.page.setReading(['u1'], 'my words', 'user');
    const token = await connectAgent('typed@example.com', { notebooks: ['typednb'], comment: true, transcribe: true });
    await until(async () => {
      const id = `pg:typednb:${n.pageId}`;
      const st = await env.DOC_ROOM.get(env.DOC_ROOM.idFromName(id)).getState(id);
      const d = new Y.Doc();
      Y.applyUpdate(d, st);
      return new Page(d).readings()[0]?.src === 'user';
    });
    // The student's reading goes out as text.
    expect(textOf(await tool(token, 'read', { ref: 'p1', s: sessionOf('typednb') }))).toContain('R1 p1 @84,168 253x34 "my words"');
    const r = await tool(token, 'transcribe', { ref: 'R1', text: 'agent words', s: sessionOf('typednb') });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('wrote their own reading of R1');
    const box = await tool(token, 'transcribe', { ref: 'p1@80,160,300,50', text: 'agent words', s: sessionOf('typednb') });
    expect(box.isError).toBe(true);
    expect(n.page.readings().map((x) => x.text)).toEqual(['my words']);
    n.nbc.close();
    n.pgc.close();
  });

  it('the AI access switch hides a notebook from every tool at once; turning it on restores it', async () => {
    const t = await signIn('aiswitch@example.com');
    const n = await notebook(t, 'ainb', 'Physics');
    const off = await notebook(t, 'aioffnb', 'Private', { ai: false });
    n.page.addItem(stroke('a1', 50, 100, 200, 120));
    let html = '';
    const token = await connectAgent('aiswitch@example.com', { notebooks: ['ainb', 'aioffnb'], comment: true, transcribe: true }, 'Tutor', (h) => (html = h));
    // The consent page marks notebooks whose AI access is off.
    expect(html).toContain('Private <span class="m">· AI access off</span>');
    expect(html).not.toContain('Physics <span class="m">· AI access off');
    const s = sessionOf('ainb');

    // Granted but switched off: never listed or readable.
    let list = textOf(await tool(token, 'wait'));
    expect(list).toContain(`s=${s} "Physics"`);
    expect(list).not.toContain('Private');
    const hidden = await tool(token, 'read', { ref: 'outline', s: sessionOf('aioffnb') });
    expect(hidden.isError).toBe(true);
    expect(textOf(hidden)).toContain('AI access is off');
    expect(textOf(await tool(token, 'read', { ref: 'p1', s }))).toContain('R1 [1]');

    // A pending wait ends as soon as the switch goes off.
    const pending = tool(token, 'wait', { s });
    await new Promise((r) => setTimeout(r, 50));
    n.nb.setMeta({ aiAccess: false });
    const w = await pending;
    expect(w.isError).toBe(true);
    expect(textOf(w)).toContain('AI access is off');
    await serverAi('ainb', false);
    list = textOf(await tool(token, 'wait'));
    expect(list).not.toContain('Physics');
    const calls: [string, Record<string, unknown>][] = [
      ['wait', { s }],
      ['read', { ref: 'p1', s }],
      ['transcribe', { ref: 'R1', text: 'x', s }],
      ['comment', { ref: 'R1', text: 'x', s }],
    ];
    for (const [name, args] of calls) {
      const r = await tool(token, name, args);
      expect(r.isError, name).toBe(true);
      expect(textOf(r), name).toContain('AI access is off');
    }
    expect(n.page.comments()).toHaveLength(0);
    expect(n.page.readings()).toHaveLength(0);
    // The D1 mirror follows the switch.
    await until(async () => (await aiRow('ainb')) === 0);

    // On again: everything works.
    n.nb.setMeta({ aiAccess: true });
    await serverAi('ainb', true);
    expect(textOf(await tool(token, 'wait'))).toContain(`s=${s} "Physics"`);
    expect(textOf(await tool(token, 'read', { ref: 'p1', s }))).toContain('R1 [1]');
    expect((await tool(token, 'comment', { ref: 'R1', text: 'back', s })).isError).toBeFalsy();
    await until(() => n.page.comments().length === 1);
    await until(async () => (await aiRow('ainb')) === 1);
    for (const x of [n.nbc, n.pgc, off.nbc, off.pgc]) x.close();
  });

  it('trashed and deleted-forever notebooks are invisible to agents and consent; tickets are refused after delete', async () => {
    const t = await signIn('trash@example.com');
    const keep = await notebook(t, 'keepnb', 'Keep');
    const trash = await notebook(t, 'trashnb', 'Trashed');
    const gone = await notebook(t, 'gonenb', 'Gone');
    gone.page.addItem(stroke('g1', 50, 100, 200, 120));
    await until(async () => new Page(await serverDoc(`pg:gonenb:${gone.pageId}`)).items().length === 1);
    const token = await connectAgent('trash@example.com', { notebooks: ['keepnb', 'trashnb', 'gonenb'], comment: true, transcribe: true });

    // Trashed: hidden from agents and the consent page; restoring brings it back.
    await editLibrary(t, (lib) => lib.updateEntry('trashnb', { deletedAt: Date.now() }));
    let list = textOf(await tool(token, 'wait'));
    expect(list).toContain('"Keep"');
    expect(list).not.toContain('Trashed');
    expect((await tool(token, 'read', { ref: 'outline', s: sessionOf('trashnb') })).isError).toBe(true);
    let html = '';
    await connectAgent('trash@example.com', { notebooks: ['keepnb'], comment: false, transcribe: false }, 'Other', (h) => (html = h));
    expect(html).toContain('Keep');
    expect(html).not.toContain('Trashed');
    await editLibrary(t, (lib) => lib.updateEntry('trashnb', { deletedAt: null }));
    expect(textOf(await tool(token, 'wait'))).toContain('"Trashed"');

    // Delete forever is owner only; the app removes the library entry and calls DELETE /notebooks/{id}.
    const stranger = await signIn('stranger@example.com');
    expect((await call('/notebooks/gonenb', { method: 'DELETE', token: stranger.accessToken })).status).toBe(404);
    expect((await call('/notebooks/gonenb', { method: 'DELETE' })).status).toBe(401);
    await editLibrary(t, (lib) => lib.removeEntry('gonenb'));
    expect((await call('/notebooks/gonenb', { method: 'DELETE', token: t.accessToken })).status).toBe(200);
    const row = await env.DB.prepare('SELECT deleted_at FROM notebooks WHERE id = ?1').bind('gonenb').first<{ deleted_at: number | null }>();
    expect(row?.deleted_at).toBeGreaterThan(0);
    expect((await ticket(t.accessToken, 'nb:gonenb')).status).toBe(403);
    expect((await ticket(t.accessToken, `pg:gonenb:${gone.pageId}`)).status).toBe(403);
    // The rooms' storage is purged.
    expect(new Notebook(await serverDoc('nb:gonenb')).pages()).toHaveLength(0);
    expect(new Page(await serverDoc(`pg:gonenb:${gone.pageId}`)).items()).toHaveLength(0);
    expect(textOf(await tool(token, 'wait'))).not.toContain('Gone');
    expect((await tool(token, 'read', { ref: 'p1', s: sessionOf('gonenb') })).isError).toBe(true);

    // A D1 row without a library entry is not resurrected.
    await editLibrary(t, (lib) => lib.removeEntry('keepnb'));
    expect(textOf(await tool(token, 'wait'))).not.toContain('Keep');
    for (const x of [keep, trash, gone]) {
      x.nbc.close();
      x.pgc.close();
    }
  });
});
