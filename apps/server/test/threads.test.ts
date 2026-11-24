import { describe, expect, it, vi } from 'vitest';
import { signIn, stroke, until } from './helpers';
import { connectAgent, inkOf, notebook, textOf, tool } from './mcp-helpers';
import { sessionOf } from '../src/grants';

const you = { kind: 'user' as const, name: 'You' };
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('comment threads and selection asks', () => {
  it('threads go both ways: notes and replies reach the agent at once; the agent replies in-thread', async () => {
    const t = await signIn('threads@example.com');
    const n = await notebook(t, 'thrnb', 'Threads');
    const token = await connectAgent('threads@example.com', { notebooks: ['thrnb'], comment: true, transcribe: false });
    const s = sessionOf('thrnb');

    const first = tool(token, 'wait', { s });
    await pause(50);
    // One update, so a slow machine can't split the three strokes across two deliveries (R3 would then be R1 of the next).
    n.pgc.doc.transact(() => {
      n.page.addItem(stroke('a1', 50, 100, 200, 120));
      n.page.addItem(stroke('a2', 50, 200, 200, 220));
      n.page.addItem(stroke('a3', 50, 300, 200, 320));
    });
    expect(textOf(await first)).toContain('R3 [3] p1 @84,504 253x34');

    // The agent starts a thread; the reply names it.
    const cm = await tool(token, 'comment', { ref: 'R1', text: 'Check the sign' });
    expect(textOf(cm)).toBe('Commented on R1 as thread C1');
    await until(() => n.page.comments().length === 1);
    const agentThread = n.page.comments()[0]!.id;

    // The student replies to it and starts their own thread. Both arrive without waiting for a pen pause or the rate limit.
    // Proven without a stopwatch: the pen keeps writing (a dot every 50 ms, well inside the 300 ms idle), so ink alone
    // can never wake the agent while this runs; only the urgent path for comments can.
    const second = tool(token, 'wait', { s });
    await pause(50);
    n.page.replyToComment(agentThread, you, 'which sign?');
    const mine = n.page.addComment({ anchorIds: ['a2'], anchor: [50, 200, 200, 220], author: you, text: 'is this step ok?' });
    let writing = true;
    const writer = (async () => {
      for (let i = 0; writing; i++) {
        n.page.addItem(stroke(`w${i}`, 400, 700 + (i % 20), 402, 701 + (i % 20)));
        await pause(50);
      }
    })();
    const up = textOf(await second);
    writing = false;
    await writer;
    const before = inkOf(n.page);
    expect(up).toContain('re C1 "which sign?"');
    // Both entries may arrive in one update or the first alone; collect until the note shows up.
    let all = up;
    if (!all.includes('note C2')) all += `\n${textOf(await tool(token, 'wait', { s }))}`;
    expect(all).toContain('note C2 p1@84,336,253,34 "is this step ok?"');
    expect(all).not.toContain('Check the sign'); // the agent's own words are never echoed

    // The agent answers in the student's thread and resolves it.
    const re = await tool(token, 'comment', { thread: 'c2', text: 'Yes, it is', resolve: true });
    expect(textOf(re)).toBe('Replied in C2 and resolved it');
    await until(() => n.page.comments().find((c) => c.id === mine)?.resolved === true);
    expect(n.page.comments().find((c) => c.id === mine)!.replies).toMatchObject([{ author: { kind: 'agent', name: 'Tutor' }, text: 'Yes, it is' }]);
    // Plain replies don't resolve.
    await tool(token, 'comment', { thread: 'C1', text: 'the minus in R1' });
    await until(() => n.page.comments().find((c) => c.id === agentThread)!.replies.length === 2);
    expect(n.page.comments().find((c) => c.id === agentThread)!.resolved).toBe(false);

    // Bad threads and missing targets fail softly.
    expect((await tool(token, 'comment', { thread: 'C9', text: 'x' })).isError).toBe(true);
    expect((await tool(token, 'comment', { thread: 'L1', text: 'x' })).isError).toBe(true);
    expect((await tool(token, 'comment', { text: 'x' })).isError).toBe(true);

    expect(inkOf(n.page)).toBe(before);
    n.nbc.close();
    n.pgc.close();
  });

  it('mirrors every thread into the notebook index doc (agent comments and replies, student notes and replies)', async () => {
    const t = await signIn('threadindex@example.com');
    const n = await notebook(t, 'idxnb', 'Index');
    const token = await connectAgent('threadindex@example.com', { notebooks: ['idxnb'], comment: true, transcribe: false });
    const s = sessionOf('idxnb');
    const first = tool(token, 'wait', { s });
    await pause(50);
    n.page.addItem(stroke('i1', 50, 100, 200, 120));
    await first;
    const byText = (text: string) => n.nb.threads().find((x) => x.text === text);

    // An agent's comment reaches the index (and so every device) without the page doc being open there.
    await tool(token, 'comment', { ref: 'R1', text: 'Nice start' });
    await until(() => !!byText('Nice start'));
    expect(byText('Nice start')).toMatchObject({ pageId: n.pageId, onSelection: true, kinds: 'a', resolved: false, lastAgent: { name: 'Tutor' } });

    // A student's reply and a new student thread are mirrored by the page room.
    const id = byText('Nice start')!.id;
    n.page.replyToComment(id, you, 'thanks');
    n.page.addComment({ anchorIds: ['i1'], author: you, text: 'mine' });
    await until(() => byText('Nice start')?.kinds === 'au' && !!byText('mine'));
    expect(byText('Nice start')!.last).toMatchObject({ author: you, text: 'thanks' });

    // An agent reply that resolves the thread.
    await tool(token, 'comment', { thread: 'C1', text: 'Done', resolve: true });
    await until(() => byText('Nice start')?.kinds === 'aua');
    expect(byText('Nice start')).toMatchObject({ resolved: true, last: { text: 'Done' } });
    n.nbc.close();
    n.pgc.close();
  });

  it('an Ask about a selection sends it as a region row (even read ink) and is answered in its thread', async () => {
    const t = await signIn('selask@example.com');
    const n = await notebook(t, 'selnb', 'Selection');
    const token = await connectAgent('selask@example.com', { notebooks: ['selnb'], comment: true, transcribe: true });
    const s = sessionOf('selnb');

    const first = tool(token, 'wait', { s });
    await pause(50);
    n.page.addItem(stroke('b1', 50, 100, 200, 120));
    n.page.addItem(stroke('b2', 50, 200, 200, 220));
    n.page.addItem(stroke('b3', 50, 300, 200, 320));
    await first;
    // R2 gets a reading: a selection still sends it as an image row.
    await tool(token, 'transcribe', { ref: 'R2', text: 'x=2' });
    await until(() => n.page.readings().some((r) => r.text === 'x=2'));

    const asked = tool(token, 'wait', { s });
    await pause(50);
    const sel = { itemIds: ['b2', 'b3'], bbox: [50, 200, 200, 320] as [number, number, number, number] };
    const commentId = n.page.addComment({ anchorIds: sel.itemIds, author: you, text: 'why?', anchor: sel.bbox, ask: true });
    n.nb.addAsk(n.pageId, 'why?', { sel, commentId });
    let up = textOf(await asked);
    if (!up.includes('ask ')) up = textOf(await tool(token, 'wait', { s })); // the thread's comment may land first
    expect(up).toMatch(/^ask C1 R4 \[1\] p1 @84,336 253x202 "why\?"$/m);
    expect(up).not.toContain('note');
    const re = await tool(token, 'comment', { thread: 'C1', text: 'Because x=2' });
    expect(re.isError).toBeFalsy();
    await until(() => n.page.comments().find((c) => c.id === commentId)!.replies.length === 1);

    // Ink and a text box: both drawn in the row (its ink is R1's, so it keeps that label).
    const askedCrop = tool(token, 'wait', { s });
    await pause(50);
    n.page.addItem({ id: 'tx', type: 'text', x: 260, y: 100, w: 80, text: 'hm', fontSize: 14, color: '#000' });
    const sel2 = { itemIds: ['b1', 'tx'], bbox: [50, 100, 340, 125] as [number, number, number, number] };
    n.nb.addAsk(n.pageId, 'and this?', { sel: sel2 });
    const crop = await askedCrop;
    const ct = textOf(crop);
    expect(ct).toMatch(/^ask R1 \[1\] p1 @84,168 488x34 "and this\?"$/m);
    expect(crop.content.some((c) => c.type === 'image')).toBe(true);
    n.nbc.close();
    n.pgc.close();
  });

  it('a malformed selection ask is skipped: wait keeps delivering, to every agent', async () => {
    const t = await signIn('badask@example.com');
    const n = await notebook(t, 'badnb', 'Bad ask');
    const token = await connectAgent('badask@example.com', { notebooks: ['badnb'], comment: true, transcribe: false });
    const s = sessionOf('badnb');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const first = tool(token, 'wait', { s });
    await pause(50);
    n.page.addItem(stroke('m1', 50, 100, 200, 120));
    await first;
    // A client writes a broken ask straight into Yjs: a selection without a box.
    const asked = tool(token, 'wait', { s });
    await pause(50);
    n.nbc.doc.getArray('asks').push([{ id: 'bad', pageId: n.pageId, text: 'what?', at: Date.now(), sel: { itemIds: ['m1'] } }]);
    const up = await asked;
    expect(up.isError).toBeFalsy();
    expect(textOf(up)).toMatch(/^ask "what\?"$/m);
    await until(() => warn.mock.calls.some((c) => String(c[0]).includes('bad sel')));

    // Later updates still flow, and a second agent connecting now isn't stuck on it either.
    const next = tool(token, 'wait', { s });
    await pause(50);
    n.page.addItem(stroke('m2', 50, 200, 200, 220));
    expect(textOf(await next)).toMatch(/^R2 \[1\] p1 @84,336 253x34 \+1$/m);
    const other = await connectAgent('badask@example.com', { notebooks: ['badnb'], comment: false, transcribe: false });
    const w2 = tool(other, 'wait', { s });
    await pause(50);
    n.nbc.doc.transact(() => {
      n.nbc.doc.getArray('asks').push([null, { id: 'bad2', pageId: n.pageId, text: 'no box', sel: 'x' }]);
      n.nb.addAsk(n.pageId, 'and now?');
    });
    const r2 = await w2;
    expect(r2.isError).toBeFalsy();
    expect(textOf(r2)).toMatch(/^ask "no box"\nask "and now\?"$/m);
    warn.mockRestore();
    n.nbc.close();
    n.pgc.close();
  });

  it("a new agent's first update has only the open threads (latest message), and read(C1) shows a whole thread", async () => {
    const t = await signIn('history@example.com');
    const n = await notebook(t, 'histnb', 'History');
    n.page.addItem(stroke('h1', 50, 100, 200, 120));
    n.page.addItem(stroke('h2', 50, 200, 200, 220));
    const old = n.page.addComment({ anchorIds: ['h1'], author: you, text: 'old comment from last week' });
    n.page.resolveComment(old);
    const open = n.page.addComment({ anchorIds: ['h2'], author: you, text: 'is this right?' });
    n.page.replyToComment(open, { kind: 'agent', name: 'Earlier' }, 'Check the sign');
    n.page.replyToComment(open, you, 'which sign?');
    await pause(100);

    const token = await connectAgent('history@example.com', { notebooks: ['histnb'], comment: true, transcribe: false });
    const s = sessionOf('histnb');
    const first = tool(token, 'wait', { s });
    await pause(50);
    n.page.addItem(stroke('h3', 50, 300, 200, 320));
    const up = textOf(await first);
    expect(up).toMatch(/^open C1 p1@84,336,253,34 student "which sign\?"$/m);
    expect(up).not.toContain('old comment');
    expect(up).not.toContain('is this right');
    expect(up).not.toMatch(/^(note|re) /m);

    const th = textOf(await tool(token, 'read', { ref: 'C1' }));
    expect(th).toBe(['#q C1 p1@84,336,253,34', 'student "is this right?"', 'agent "Check the sign"', 'student "which sign?"'].join('\n'));

    // From here on, only new entries.
    const next = tool(token, 'wait', { s });
    await pause(50);
    n.page.replyToComment(open, you, 'the minus?');
    expect(textOf(await next)).toMatch(/^re C1 "the minus\?"$/m);
    n.nbc.close();
    n.pgc.close();
  });
});

