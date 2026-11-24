import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Page, mathReady, threadBox, transformPatch } from '@qalm/core';
import { signIn, stroke, until } from './helpers';
import { connectAgent, inkOf, notebook, serverDoc, textOf, tool } from './mcp-helpers';
import { sessionOf } from '../src/grants';

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const hasImage = (r: Awaited<ReturnType<typeof tool>>) => r.content.some((c) => c.type === 'image');

describe('regions end to end', () => {
  it('wait → regions → transcribe → text instead of an image → a stroke makes it stale → a comment on R# follows the ink', async () => {
    const t = await signIn('regions@example.com');
    const n = await notebook(t, 'regnb', 'Regions');
    const token = await connectAgent('regions@example.com', { comment: true, transcribe: true });
    const s = sessionOf('regnb');

    // The student writes one expression; the agent's first look has it as one region.
    let w = tool(token, 'wait', { s });
    await pause(50);
    n.page.addItems([stroke('e1', 50, 100, 100, 120), stroke('e2', 105, 100, 150, 120)]);
    let up = await w;
    expect(textOf(up)).toBe([`#q s=${s} r=1 p1 1000x1415 first look`, 'R1 [1] p1 @84,168 169x34'].join('\n'));
    expect(hasImage(up)).toBe(true);

    // The agent reads it and saves its reading.
    expect(textOf(await tool(token, 'transcribe', { ref: 'R1', text: 'x + 1' }))).toBe('Saved R1');
    await until(() => n.page.readings().some((r) => r.text === 'x + 1'));

    // Far-away writing is a region of its own; R1 isn't sent again. Read the page: R1 comes as text, no image row.
    w = tool(token, 'wait', { s });
    await pause(50);
    n.page.addItem(stroke('f1', 50, 400, 150, 420));
    up = await w;
    expect(textOf(up)).toBe([`#q s=${s} r=2 p1 1000x1415`, 'R2 [1] p1 @84,672 169x34 +1'].join('\n'));
    const page1 = await tool(token, 'read', { ref: 'p1', s });
    expect(textOf(page1)).toBe(['#q p1 1000x1415', 'R1 p1 @84,168 169x34 "x + 1"', 'R2 [1] p1 @84,672 169x34'].join('\n'));

    // The student adds to the expression: the reading goes stale (kept), and the update shows the new stroke with
    // the old ones as context, replacing R1.
    w = tool(token, 'wait', { s });
    await pause(50);
    n.page.addItem(stroke('e3', 155, 100, 170, 120));
    expect(n.page.readings()[0]).toMatchObject({ text: 'x + 1', stale: true });
    up = await w;
    expect(textOf(up)).toBe([`#q s=${s} r=3 p1 1000x1415`, 'R3 [1] p1 @84,168 202x34 +1 (was R1)'].join('\n'));
    await until(async () => new Page(await serverDoc(`pg:regnb:${n.pageId}`)).readings()[0]?.stale === true);
    // A stale reading isn't trusted: the region is an image again, and read(R3) shows the stale text.
    expect(textOf(await tool(token, 'read', { ref: 'p1', s })).split('\n')[1]).toBe('R3 [1] p1 @84,168 202x34');
    expect(textOf(await tool(token, 'read', { ref: 'R3', s }))).toBe('#q R3 [1] p1 @84,168 202x34\nagent stale "x + 1"');

    // Read again: fresh, and text again.
    await tool(token, 'transcribe', { ref: 'R3', text: 'x + 1 = 2' });
    await until(() => n.page.readings().length === 1 && n.page.readings()[0]!.text === 'x + 1 = 2');
    expect(textOf(await tool(token, 'read', { ref: 'p1', s })).split('\n')[1]).toBe('R3 p1 @84,168 202x34 "x + 1 = 2"');

    // A comment on R3 sits on its strokes and follows them when the student moves them.
    expect(textOf(await tool(token, 'comment', { ref: 'R3', text: 'Check the sign' }))).toBe('Commented on R3 as thread C1');
    await until(() => n.page.comments().length === 1);
    const c = n.page.comments()[0]!;
    expect(new Set(c.anchorIds)).toEqual(new Set(['e1', 'e2', 'e3']));
    const before = inkOf(n.page);
    n.page.updateItems(['e1', 'e2', 'e3'].map((id) => [id, transformPatch(n.page.item(id)!, { s: 1, r: 0, ox: 0, oy: 0, dx: 0, dy: 200 })] as const));
    expect(threadBox(n.page.comments()[0]!, n.page.items())).toEqual([49.1, 299.1, 170.9, 320.9]); // moved 200 down (transformPatch pads the bbox by half the width)
    expect(n.page.readings()[0]!.stale).toBeUndefined(); // moving read ink keeps its reading
    await until(async () => (new Page(await serverDoc(`pg:regnb:${n.pageId}`)).item('e1') as { bbox: number[] }).bbox[1]! > 290);
    expect(textOf(await tool(token, 'read', { ref: 'C1', s })).split('\n')[0]).toBe('#q C1 p1@82,502,206,38');
    expect(before).not.toBe(inkOf(n.page));

    // A box ref works for transcribe and comment too; a page ref for comments.
    expect(textOf(await tool(token, 'transcribe', { ref: 'p1@84,672,169,34', text: 'y' }))).toBe('Saved p1@84,672,169,34');
    expect(textOf(await tool(token, 'comment', { ref: 'p1', text: 'Nice page' }))).toBe('Commented on p1 as thread C2');
    await until(() => n.page.comments().length === 2 && n.page.readings().length === 2);
    expect(n.page.readings().find((r) => r.text === 'y')!.ids).toEqual(['f1']);
    expect(n.page.comments().find((x) => x.text === 'Nice page')!.anchorIds).toBeUndefined();
    n.nbc.close();
    n.pgc.close();
  });

  it('a box crop draws a Markdown text box; comments reach agents as the Markdown they were written in', async () => {
    const t = await signIn('markdown@example.com');
    const n = await notebook(t, 'mdnb', 'Markdown');
    const token = await connectAgent('markdown@example.com', { comment: true, transcribe: true });
    const s = sessionOf('mdnb');
    n.page.addItem({ id: 'tb', type: 'text', x: 50, y: 100, w: 240, text: '**Area** is $\\int_0^1 x^2\\,dx$\n- `done`', fontSize: 16, color: '#27272a', format: 'md' });
    await until(async () => !!new Page(await serverDoc(`pg:mdnb:${n.pageId}`)).item('tb'));
    // The crop is rendered by resvg with the Markdown fonts (bold, mono, maths); it comes back as an image. MathJax is
    // loaded on demand, for the page with maths, before regions are measured and the crop drawn (no placeholder).
    expect(mathReady()).toBe(false);
    const crop = await tool(token, 'read', { ref: 'p1@50,140,500,150', s });
    expect(hasImage(crop)).toBe(true);
    expect(mathReady()).toBe(true);
    // An agent's Markdown comment is stored as written, and read back raw.
    expect(textOf(await tool(token, 'comment', { ref: 'p1', text: 'Use **u-substitution**: $u = x^2$' }))).toBe('Commented on p1 as thread C1');
    await until(() => n.page.comments().length === 1);
    expect(n.page.comments()[0]!.text).toBe('Use **u-substitution**: $u = x^2$');
    expect(textOf(await tool(token, 'read', { ref: 'C1', s }))).toContain('**u-substitution**');
    n.nbc.close();
    n.pgc.close();
  });

  it('migrates a page from before regions when an agent reads it, and when it edits it', async () => {
    const t = await signIn('legacy@example.com');
    const n = await notebook(t, 'legnb', 'Legacy');
    n.page.addItems([stroke('l1', 50, 100, 100, 120), stroke('l2', 105, 100, 150, 120)]);
    // As the app stored a line before regions: items' line fields and a `lines` entry with the student's text.
    n.pgc.doc.transact(() => {
      const items = n.pgc.doc.getMap<Y.Map<unknown>>('items');
      items.get('l1')!.set('line', 'l1');
      items.get('l2')!.set('line', 'l1');
      const e = new Y.Map<unknown>();
      n.pgc.doc.getMap('lines').set('l1', e);
      e.set('kind', 'line');
      e.set('text', 'x+1');
      e.set('textSrc', 'user');
    });
    await until(async () => (await serverDoc(`pg:legnb:${n.pageId}`)).getMap('lines').size === 1);
    const token = await connectAgent('legacy@example.com', { comment: true, transcribe: true });
    const s = sessionOf('legnb');
    // The student's line text is a reading of its strokes: the agent gets it as text.
    expect(textOf(await tool(token, 'read', { ref: 'p1', s }))).toBe('#q p1 1000x1415\nR1 p1 @84,168 169x34 "x+1"');
    // An agent edit migrates the stored page for good.
    await tool(token, 'comment', { ref: 'R1', text: 'ok' });
    await until(() => n.page.comments().length === 1);
    expect(n.pgc.doc.getMap('lines').size).toBe(0);
    expect(n.page.readings()).toMatchObject([{ id: 'm:l1', ids: ['l1', 'l2'], text: 'x+1', src: 'user' }]);
    n.nbc.close();
    n.pgc.close();
  });
});
