import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  anchorInkRemoved,
  cleanAsk,
  emptyRegions,
  emptyThreads,
  encodeQinkThread,
  encodeQinkUpdate,
  renderRegionsSvg,
  resolveThread,
  threadBox,
  threadLabel,
  summarizeThreads,
  SUMMARY_TEXT,
  agentEntriesAfter,
  THREADS_ORIGIN,
  type InkSeen,
  type Page,
  type QinkAsk,
  type QinkSeen,
  type TextItem,
} from '../src';
import { newNotebook, newPage, stroke } from './helpers';

const you = { kind: 'user' as const, name: 'You' };
const tutor = { kind: 'agent' as const, name: 'Tutor' };

/** One page with four rows of ink (40 apart). Returns an agent that has had its first look. */
function setup() {
  const nb = newNotebook();
  const pid = nb.pages()[0]!.id;
  const page = newPage();
  for (let i = 0; i < 4; i++) page.addItem(stroke(`k${i + 1}`, 50, 100 + 40 * i, 150, 120 + 40 * i));
  const pages: Record<string, Page> = { [pid]: page };
  const regions = emptyRegions();
  const threads = emptyThreads();
  let ink: Record<string, InkSeen> = {};
  let seen: QinkSeen = {};
  let rev = 0;
  const update = (asks?: QinkAsk[]) => {
    const u = encodeQinkUpdate(nb, pages, regions, ink, { session: 's', rev: ++rev, threads, seen, asks, client: 'a' });
    ink = { ...ink, ...u.ink };
    seen = u.seen;
    return u;
  };
  const u0 = update();
  return { nb, pid, page, pages, regions, threads, update, u0 };
}

describe('Q-ink threads', () => {
  afterEach(() => vi.useRealTimers());

  it("sends the student's new comments and replies once, never the agent's own", () => {
    const { pid, page, threads, update } = setup();
    // The agent comments on k3 (C1); the student replies, and starts their own thread on k4.
    const agentC = page.addComment({ anchorIds: ['k3'], anchor: [50, 180, 150, 200], author: tutor, text: 'Check the sign' });
    // The server labels an agent's thread as soon as it is created (AgentHub.applyOn).
    expect(threadLabel(threads, agentC, pid)).toBe('C1');
    expect(update().text).toBe('#q s=s r=2 p1 1000x1415');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 1000);
    page.replyToComment(agentC, you, 'why?');
    const mine = page.addComment({ anchorIds: ['k4'], anchor: [50, 220, 150, 240], author: you, text: 'is this "right"?' });
    expect(update().text).toBe(['#q s=s r=3 p1 1000x1415', 're C1 "why?"', 'note C2 p1@84,369,169,35 "is this \\"right\\"?"'].join('\n'));
    expect(resolveThread(threads, 'c2')).toEqual({ pageId: pid, commentId: mine });
    expect(() => resolveThread(threads, 'C9')).toThrow();
    // The agent answers in the thread: nothing to report back.
    page.replyToComment(mine, tutor, 'yes');
    expect(update().text).toBe('#q s=s r=4 p1 1000x1415');
  });

  it('a student reply reopens a resolved thread', () => {
    const { page } = setup();
    const id = page.addComment({ anchorIds: ['k1'], author: tutor, text: 'ok' });
    page.resolveComment(id);
    expect(page.replyToComment(id, you, 'wait')).toBe(true);
    expect(page.comments()[0]!.resolved).toBe(false);
    expect(page.replyToComment('nope', you, 'x')).toBe(false);
  });

  it('a selection ask names its thread and region; later replies come through', () => {
    const { nb, pid, page, update } = setup();
    const sel = { itemIds: ['k2'], bbox: [50, 140, 150, 160] as [number, number, number, number] };
    const commentId = page.addComment({ anchorIds: ['k2'], anchor: sel.bbox, author: you, text: 'why?', ask: true });
    nb.addAsk(pid, 'why?', { sel, commentId });
    const ask = nb.asks()[0]!;
    const u = update([ask]);
    // The ask's own thread isn't repeated as a note. The selection (k2) is black; the rows above and below are more than ½ unit away: no context.
    expect(u.text).toBe(['#q s=s r=2 p1 1000x1415', 'ask C1 R2 [1] p1 @84,235 169x34 "why?"'].join('\n'));
    expect(u.image!.rows[0]).toMatchObject({ fresh: ['k2'], context: [] });
    page.replyToComment(commentId, tutor, 'because');
    page.replyToComment(commentId, you, 'thanks');
    expect(update().text).toBe('#q s=s r=3 p1 1000x1415\nre C1 "thanks"');
  });

  it('a selection with a text box draws it in the row', () => {
    const { pid, page, pages, update } = setup();
    const text: TextItem = { id: 't1', type: 'text', x: 300, y: 300, w: 100, text: 'note', fontSize: 14, color: '#000' };
    page.addItem(text);
    const u = update([{ pageId: pid, text: 'what is this?', sel: { itemIds: ['t1'], bbox: [300, 300, 400, 320] } }]);
    expect(u.text.split('\n').at(-1)).toMatch(/^ask R\d+ \[1\] p1 @\d+,\d+ \d+x\d+ "what is this\?"$/);
    expect(renderRegionsSvg(pages, u.image!.rows).svg).toContain('>note</tspan>');
  });

  it('a thread on strokes follows its ink: live box ref, page only once the ink is gone', () => {
    const { page, update } = setup();
    page.addItem(stroke('w', 160, 100, 200, 120));
    update();
    page.addComment({ author: you, text: 'this word', anchor: [160, 100, 200, 120], anchorIds: ['w'] });
    const w = page.item('w')!;
    if (w.type !== 'stroke') throw new Error('stroke');
    page.updateItem('w', { points: w.points.map((q) => ({ ...q, y: q.y + 120 })), bbox: [160, 220, 200, 240] });
    const c = page.comments()[0]!;
    expect(threadBox(c, page.items())).toEqual([160, 220, 200, 240]);
    expect(update().text.split(/\n/).at(-1)).toBe('note C1 p1@268,369,69,35 "this word"');
    page.removeItems(['w']);
    expect(threadBox(page.comments()[0]!, page.items())).toBeNull();
    expect(anchorInkRemoved(page.comments()[0]!, page.items())).toBe(true);
    page.addComment({ author: you, text: 'gone?', anchor: [160, 220, 200, 240], anchorIds: ['w'] });
    expect(update().text.split(/\n/).at(-1)).toBe('note C2 p1 "gone?"');
  });

  it('a thread on a box keeps its box; one on the page has none', () => {
    const { page } = setup();
    page.addComment({ author: you, text: 'x', anchor: [1, 2, 3, 4] });
    page.addComment({ author: you, text: 'y' });
    const a = page.comments().find((c) => c.text === 'x');
    const b = page.comments().find((c) => c.text === 'y');
    expect(threadBox(a!, page.items())).toEqual([1, 2, 3, 4]);
    expect(threadBox(b!, page.items())).toBeNull();
    expect(anchorInkRemoved(a!, page.items())).toBe(false);
  });

  it('a malformed ask is skipped or loses its bad selection; the rest of the update still goes out', () => {
    const { pid, page, update } = setup();
    page.addItem(stroke('k5', 50, 300, 150, 320));
    const bad = [
      { pageId: pid, text: 'no box', sel: { itemIds: ['k1'] } },
      { pageId: pid, text: 'ids not an array', sel: { itemIds: 'k1', bbox: [0, 0, 1, 1] } },
      { text: 'no page' },
      null,
      { pageId: pid, text: 42, commentId: 7 },
      { pageId: pid, text: 'fine', sel: { itemIds: ['k1'], bbox: [50, 100, 150, 120] } },
    ] as never[];
    const lines = update(bad).text.split('\n');
    expect(lines[0]).toBe('#q s=s r=2 p1 1000x1415');
    expect(lines[1]).toBe('R2 [1] p1 @84,504 169x34 +1'); // more than 2 units below k4: a region of its own
    expect(lines.slice(2)).toEqual(['ask "no box"', 'ask "ids not an array"', 'ask ""', 'ask R3 [2] p1 @84,168 169x34 "fine"']);
    const why: string[] = [];
    expect(cleanAsk({ pageId: pid, sel: { itemIds: ['x'] } }, (w) => why.push(w))).toEqual({ pageId: pid, text: '' });
    expect(why).toEqual(['bad sel (dropped)']);
  });

  it("an agent's first look at a page sends only its open threads, each with the latest message", () => {
    const nb = newNotebook();
    const pid = nb.pages()[0]!.id;
    const page = newPage();
    page.addItem(stroke('k1', 50, 100, 150, 120));
    page.addItem(stroke('k2', 50, 140, 150, 160));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1000);
    const done = page.addComment({ anchorIds: ['k1'], author: you, text: 'old comment from last week' });
    page.replyToComment(done, tutor, 'answered');
    page.resolveComment(done);
    vi.setSystemTime(2000);
    const open = page.addComment({ anchorIds: ['k2'], author: you, text: 'is this right?' });
    page.replyToComment(open, tutor, 'Check the sign');
    page.replyToComment(open, you, 'which sign?');
    vi.setSystemTime(3000);
    page.addComment({ author: tutor, text: 'nice' });

    const regions = emptyRegions();
    const threads = emptyThreads();
    const pages = { [pid]: page };
    const u = encodeQinkUpdate(nb, pages, regions, {}, { session: 's', rev: 1, threads });
    expect(u.text.split('\n')).toEqual([
      '#q s=s r=1 p1 1000x1415 first look',
      'R1 [1] p1 @84,168 169x101',
      'open C1 p1@84,235,169,34 student "which sign?"',
      'open C2 p1 agent "nice"',
    ]);
    const again = encodeQinkUpdate(nb, pages, regions, u.ink, { session: 's', rev: 2, threads, seen: u.seen });
    expect(again.text).toBe('#q s=s r=2 p1 1000x1415');
    page.replyToComment(open, you, 'the minus?');
    page.replyToComment(done, you, 'one more thing');
    const later = encodeQinkUpdate(nb, pages, regions, again.ink, { session: 's', rev: 3, threads, seen: again.seen });
    expect(later.text.split('\n').slice(1)).toEqual(['re C3 "one more thing"', 're C1 "the minus?"']);

    expect(encodeQinkThread(nb, pages, threads, 'c1')).toBe(
      ['#q C1 p1@84,235,169,34', 'student "is this right?"', 'agent "Check the sign"', 'student "which sign?"', 'student "the minus?"'].join('\n'),
    );
    page.resolveComment(open);
    expect(encodeQinkThread(nb, pages, threads, 'C1').split('\n')[0]).toBe('#q C1 p1@84,235,169,34 resolved');
    expect(() => encodeQinkThread(nb, pages, threads, 'C9')).toThrow('No thread C9');
  });
});

describe('thread index', () => {
  it('summarizes threads (quoting the reading of their strokes) and never rolls an entry back', () => {
    const nb = newNotebook();
    const pid = nb.pages()[0]!.id;
    const page = newPage();
    page.addItem(stroke('q1', 50, 100, 150, 120));
    page.setReading(['q1'], 'x+1', 'agent');
    const id = page.addComment({ anchorIds: ['q1'], author: tutor, text: 'a'.repeat(400) });
    const stale = summarizeThreads(pid, page.comments(), page.readings());
    expect(stale[0]).toMatchObject({ id, pageId: pid, quote: 'x+1', onSelection: true, kinds: 'a', resolved: false, lastAgent: { name: 'Tutor' } });
    expect(stale[0]!.text).toHaveLength(SUMMARY_TEXT);
    expect(nb.putThreads(stale)).toBe(true);
    expect(nb.putThreads(stale)).toBe(false);

    page.replyToComment(id, you, 'why?');
    page.resolveComment(id);
    const fresh = summarizeThreads(pid, page.comments(), page.readings());
    expect(nb.putThreads(fresh)).toBe(true);
    expect(nb.threads()[0]).toMatchObject({ kinds: 'au', resolved: true, last: { author: you, text: 'why?' } });
    expect(nb.putThreads(stale)).toBe(false);
    expect(nb.putThreads([{ ...fresh[0]!, resolved: false }])).toBe(false);
    expect(nb.threads()[0]!.resolved).toBe(true);
    page.replyToComment(id, you, 'reopen');
    expect(nb.putThreads(summarizeThreads(pid, page.comments(), page.readings()))).toBe(true);
    expect(nb.threads()[0]).toMatchObject({ kinds: 'auu', resolved: false });
    expect(agentEntriesAfter(nb.threads()[0]!, 0)).toBe(1);
    expect(agentEntriesAfter(nb.threads()[0]!, 1)).toBe(0);
  });

  it('is written outside undo and marks new notebooks as indexed', () => {
    const nb = newNotebook();
    expect(nb.threadsIndexed()).toBe(true);
    const updates: unknown[] = [];
    nb.doc.on('update', (_u: Uint8Array, origin: unknown) => updates.push(origin));
    nb.putThreads(summarizeThreads('p', [{ id: 'c', author: you, text: 'hi', createdAt: 1, resolved: false, replies: [] }]));
    expect(updates).toEqual([THREADS_ORIGIN]);
  });
});
