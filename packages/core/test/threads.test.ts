import { afterEach, describe, expect, it, vi } from 'vitest';
import { anchorInkRemoved, emptyThreads, encodeQinkUpdate, labelList, LOCAL_ORIGIN, renderLinesStripSvg, resolveThread, threadBox, threadLabel } from '../src';
import type { QinkLabels, TextItem } from '../src';
import { newNotebook, newPage, stroke } from './helpers';

const you = { kind: 'user' as const, name: 'You' };
const tutor = { kind: 'agent' as const, name: 'Tutor' };

/** One page with four lines of ink (rows 40 apart); L2 has trusted text. Returns a delivered first update. */
function setup() {
  const nb = newNotebook();
  const pid = nb.pages()[0]!.id;
  const page = newPage();
  for (let i = 0; i < 4; i++) page.addItem(stroke(`k${i + 1}`, 50, 100 + 40 * i, 150, 120 + 40 * i));
  page.setLineText('k2', 'y=2', 'agent');
  const labels: QinkLabels = {};
  const threads = emptyThreads();
  const u0 = encodeQinkUpdate(nb, { [pid]: page }, labels, {}, { session: 's', rev: 1, threads });
  return { nb, pid, page, labels, threads, u0 };
}

describe('Q-ink threads', () => {
  afterEach(() => vi.useRealTimers());

  it('labels range lists', () => {
    expect(labelList(['L6', 'L4', 'L5', 'D1', 'L9'])).toBe('L4-6,L9,D1');
    expect(labelList(['L2'])).toBe('L2');
  });

  it("sends the student's new comments and replies once, never the agent's own", () => {
    const { nb, pid, page, labels, threads, u0 } = setup();
    // The agent comments on L3 (C1); the student replies, and starts their own thread on L4.
    const agentC = page.addComment({ lineKey: 'k3', author: tutor, text: 'Check the sign' });
    // The server labels an agent's thread as soon as it is created (AgentHub.applyOn). Without this, C1/C2 would
    // depend on the random comment ids whenever both comments land in the same millisecond.
    expect(threadLabel(threads, agentC, pid)).toBe('C1');
    const c1 = encodeQinkUpdate(nb, { [pid]: page }, labels, u0.snapshot, { session: 's', rev: 2, threads, seen: u0.seen });
    expect(c1.text).toBe('#q s=s r=2 p1 "y=2"');
    // Entries are listed in thread order (createdAt, then id): keep the student's thread a millisecond later.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 1000);
    page.replyToComment(agentC, you, 'why?');
    const mine = page.addComment({ lineKey: 'k4', author: you, text: 'is this "right"?' });
    const u = encodeQinkUpdate(nb, { [pid]: page }, labels, c1.snapshot, { session: 's', rev: 3, threads, seen: c1.seen });
    expect(u.text).toBe(['#q s=s r=3 p1 "y=2"', 're C1 "why?"', 'note C2 p1:L4 "is this \\"right\\"?"'].join('\n'));
    expect(resolveThread(threads, 'c2')).toEqual({ pageId: pid, commentId: mine });
    expect(() => resolveThread(threads, 'C9')).toThrow();

    // The agent answers in the thread: nothing to report back.
    page.replyToComment(mine, tutor, 'yes');
    const again = encodeQinkUpdate(nb, { [pid]: page }, labels, u.snapshot, { session: 's', rev: 4, threads, seen: u.seen });
    expect(again.text).toBe('#q s=s r=4 p1 "y=2"');
  });

  it('a student reply reopens a resolved thread', () => {
    const { page } = setup();
    const id = page.addComment({ lineKey: 'k1', author: tutor, text: 'ok' });
    page.resolveComment(id);
    expect(page.replyToComment(id, you, 'wait')).toBe(true);
    expect(page.comments()[0]!.resolved).toBe(false);
    expect(page.replyToComment('nope', you, 'x')).toBe(false);
  });

  it('a selection ask of whole lines puts those lines in the image and names its thread', () => {
    const { nb, pid, page, labels, threads, u0 } = setup();
    const sel = { itemIds: ['k2', 'k3'], bbox: [50, 140, 150, 200] as [number, number, number, number] };
    const commentId = page.addComment({ lineKey: 'k2', author: you, text: 'why?', anchor: sel.bbox, ask: true });
    nb.addAsk(pid, 'why?', { sel, commentId });
    const ask = nb.asks()[0]!;
    expect(ask).toMatchObject({ sel, commentId });
    const u = encodeQinkUpdate(nb, { [pid]: page }, labels, u0.snapshot, { session: 's', rev: 2, asks: [ask], threads, seen: u0.seen });
    // The ask's own thread isn't repeated as a note.
    expect(u.text).toBe(['#q s=s r=2 p1 "y=2"', ' L2 [1] "y=2"', ' L3 [2]', 'ask C1 p1:L2-3 "why?"'].join('\n'));
    expect(u.image).toEqual({ pageId: pid, lineKeys: ['k2', 'k3'], labels: ['[1]', '[2]'] });
    // Later replies in it do come through.
    page.replyToComment(commentId, tutor, 'because');
    page.replyToComment(commentId, you, 'thanks');
    const r = encodeQinkUpdate(nb, { [pid]: page }, labels, u.snapshot, { session: 's', rev: 3, threads, seen: u.seen });
    expect(r.text).toBe('#q s=s r=3 p1 "y=2"\nre C1 "thanks"');
  });

  it('a selection that is not whole lines gets a crop row of its box', () => {
    const { nb, pid, page, labels, threads, u0 } = setup();
    const text: TextItem = { id: 't1', type: 'text', x: 300, y: 300, w: 100, text: 'note', fontSize: 14, color: '#000' };
    page.addItem(text);
    const sel = { itemIds: ['k1', 't1'], bbox: [50, 100, 400, 320] as [number, number, number, number] };
    const u = encodeQinkUpdate(nb, { [pid]: page }, labels, u0.snapshot, { session: 's', rev: 2, asks: [{ pageId: pid, text: 'what is this?', sel }], threads, seen: u0.seen });
    expect(u.text).toBe(['#q s=s r=2 p1 "y=2"', ' L1 [1]', 'ask p1:L1 [2] "what is this?"'].join('\n'));
    expect(u.image).toEqual({ pageId: pid, lineKeys: ['k1', [50, 100, 400, 320]], labels: ['[1]', '[2]'] });
    const strip = renderLinesStripSvg(page, u.image!.lineKeys, u.image!.labels);
    expect(strip.svg).toContain('clip-path="url(#crop1)"');
    expect(strip.svg).toContain('>note</tspan>');
  });

  it('a thread on a selection follows its ink: live box and line labels, unanchored once the ink is gone', () => {
    const { nb, pid, page, labels, threads, u0 } = setup();
    page.addItem(stroke('w', 160, 100, 200, 120)); // joins L1
    const u1 = encodeQinkUpdate(nb, { [pid]: page }, labels, u0.snapshot, { session: 's', rev: 2, threads, seen: u0.seen });
    const id = page.addComment({ lineKey: 'k1', author: you, text: 'this word', anchor: [160, 100, 200, 120], anchorIds: ['w'] });
    expect(page.comments()[0]!.anchorIds).toEqual(['w']);
    // Move the word down onto L4's row before the agent hears about the thread.
    const w = page.item('w')!;
    if (w.type !== 'stroke') throw new Error('stroke');
    page.doc.transact(() => page.updateItem('w', { points: w.points.map((q) => ({ ...q, y: q.y + 120 })), bbox: [160, 220, 200, 240] }), LOCAL_ORIGIN);
    const c = page.comments()[0]!;
    expect(threadBox(c, page.items(), page.lines())).toEqual([160, 220, 200, 240]);
    const u2 = encodeQinkUpdate(nb, { [pid]: page }, labels, u1.snapshot, { session: 's', rev: 3, threads, seen: u1.seen });
    expect(u2.text.split(/\n/).at(-1)).toBe('note C1 p1:L4 "this word"');
    // Delete the ink: no box, and a new thread on it names only the page.
    page.removeItems(['w']);
    expect(threadBox(page.comments()[0]!, page.items(), page.lines())).toBeNull();
    expect(anchorInkRemoved(page.comments()[0]!, page.items())).toBe(true);
    page.addComment({ lineKey: 'k1', author: you, text: 'gone?', anchor: [160, 220, 200, 240], anchorIds: ['w'] });
    const u3 = encodeQinkUpdate(nb, { [pid]: page }, labels, u2.snapshot, { session: 's', rev: 4, threads, seen: u2.seen });
    expect(u3.text.split(/\n/).at(-1)).toBe('note C2 p1 "gone?"');
    expect(id).toBeTruthy();
  });

  it('older selection threads (box only) keep their stored box', () => {
    const { page } = setup();
    page.addComment({ lineKey: '', author: you, text: 'x', anchor: [1, 2, 3, 4] });
    const c = page.comments()[0]!;
    expect(threadBox(c, page.items(), page.lines())).toEqual([1, 2, 3, 4]);
    expect(anchorInkRemoved(c, page.items())).toBe(false);
  });
});
