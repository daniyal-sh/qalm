import { Page, summarizeThreads, type BBox, type Comment } from '@qalm/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { getPresence, presenceCan, presenceNames } from '../src/api/ai';
import { agentEntryCount, aiUi, COMMENTS_START_OPEN, marginCards, markSeen, newestAgentEntry, startThinking, stillThinking, THINKING_MS, unreadCount, unreadIds } from '../src/editor/ai.logic';
import type { PageData } from '../src/editor/context';

const agent = { kind: 'agent' as const, name: 'Claude' };
const you = { kind: 'user' as const, name: 'You' };

function pageWith(build: (p: Page) => void): PageData {
  const page = new Page(new Y.Doc());
  build(page);
  return { page, index: 0, readings: page.readings(), comments: page.comments(), items: page.items() };
}

/** The page's threads as the thread index has them. */
const sums = (d: PageData, pageId = 'p1') => summarizeThreads(pageId, d.page.comments(), d.readings);

/** A thread on a box at row `y` (or, with `y` null, on ink that's gone). */
const at = (y: number): BBox => [50, y, 200, y + 20];
const comment = (id: string, y: number | null, extra: Partial<Comment> = {}): Comment => ({
  id,
  ...(y === null ? { anchorIds: ['zzz'] } : { anchor: at(y) }),
  author: agent,
  text: id,
  createdAt: 1,
  resolved: false,
  replies: [],
  ...extra,
});

describe('live agent logic', () => {
  it('counts unread agent entries and marks only read threads', () => {
    let a = '';
    const d = pageWith((p) => {
      a = p.addComment({ author: agent, text: 'hi' });
      p.replyToComment(a, you, 'why');
      p.replyToComment(a, agent, 'because');
      p.addComment({ author: you, text: 'mine' });
    });
    expect(agentEntryCount(sums(d))).toBe(2);
    expect(unreadCount(sums(d), {})).toBe(2);
    expect(unreadCount(sums(d), { [a]: 2 })).toBe(1);
    expect([...unreadIds(sums(d), {})]).toEqual([a]);
    // Only the threads that were read are marked (not every loaded thread).
    const other = d.page.addComment({ author: agent, text: 'later' });
    const seen = markSeen(sums(d).filter((x) => x.id === a), {});
    expect(unreadCount(sums(d), seen)).toBe(1);
    expect([...unreadIds(sums(d), seen)]).toEqual([other]);
    expect(markSeen(sums(d).filter((x) => x.id === a), seen)).toBe(seen);
    // A new reply in a read thread is unread again.
    d.page.replyToComment(a, agent, 'one more');
    expect(unreadCount(sums(d), seen)).toBe(2);
    expect(newestAgentEntry(sums(d))).toMatchObject({ name: 'Claude', pageId: 'p1' });
  });

  it('stacks margin cards beside their ink without overlap, skipping resolved and orphaned threads', () => {
    const cards = marginCards(
      [comment('c1', 100), comment('c2', 110), comment('c3', 400), comment('gone', null), comment('done', 100, { resolved: true }), comment('sel', null, { anchorIds: undefined, anchor: [0, 300, 10, 310] })],
      2,
      64,
      8,
    );
    expect(cards.map((c) => [c.comment.id, c.top])).toEqual([
      ['c1', 196],
      ['c2', 268],
      ['sel', 596],
      ['c3', 796],
    ]);
  });

  it('keeps margin cards on their page: a stack running past the bottom is pulled back up', () => {
    const three = [comment('c1', 380), comment('c2', 390), comment('c3', 395)];
    const cards = marginCards(three, 1, 64, 8, null, 420);
    expect(cards.map((c) => c.top)).toEqual([212, 284, 356]);
    // A stack taller than the page keeps its order and overflows instead of overlapping.
    expect(marginCards(three, 1, 64, 8, null, 200).map((c) => c.top)).toEqual([376, 448, 520]);
  });

  it('thinking ends when an agent writes anywhere in the notebook, or after a timeout', () => {
    let a = '';
    const p1 = pageWith((p) => {
      a = p.addComment({ author: agent, text: 'earlier answer' });
    });
    const now = Date.now();
    const t = startThinking(sums(p1), now);
    expect(stillThinking(t, sums(p1), now + 1000)).toBe(true);
    // A far page's old agent thread turning up in the index (an older notebook being indexed) doesn't end it.
    const old = pageWith((p) => p.addComment({ author: agent, text: 'old' }));
    const oldSums = sums(old, 'p9').map((x) => ({ ...x, createdAt: now - 2 * THINKING_MS }));
    expect(stillThinking(t, [...sums(p1), ...oldSums], now + 1000)).toBe(true);
    // A reply, or a new agent thread on any page, ends it.
    const fresh = pageWith((p) => p.addComment({ author: agent, text: 'new' }));
    expect(stillThinking(t, [...sums(p1), ...sums(fresh, 'p30')], now + 1000)).toBe(false);
    p1.page.replyToComment(a, agent, 'the answer');
    expect(stillThinking(t, sums(p1), now + 1000)).toBe(false);
    expect(stillThinking(t, [], now + THINKING_MS)).toBe(false);
    expect(stillThinking(null, [], 0)).toBe(false);
    expect(startThinking([], 5, 'c9')).toEqual({ before: {}, at: 5, commentId: 'c9' });
  });

  it('reads presence and names agents', async () => {
    const tm = {
      fetch: async (path: string) => {
        expect(path).toBe('/ai/presence?nb=nb%201');
        return new Response(JSON.stringify({ aiAccess: true, live: true, paused: false, agents: [{ name: 'Claude', waiting: true, lastAt: 1, canComment: true, canTranscribe: false }] }));
      },
    };
    const p = await getPresence(tm, 'nb 1');
    expect(p.agents[0]!.name).toBe('Claude');
    expect(p.live).toBe(true);
    expect(presenceNames(['Claude'])).toBe('Claude');
    expect(presenceNames(['Claude', 'Tutor'])).toBe('Claude and Tutor');
    expect(presenceNames(['A', 'B', 'C'])).toBe('A and 2 others');
    expect(presenceCan(p.agents)).toBe('Read and comment');
  });
});

describe('selection threads', () => {
  it('pin at their box, keyed by comment id; none on the whole page', async () => {
    const { commentAnchors } = await import('../src/editor/view');
    const anchors = commentAnchors([comment('c1', 100), comment('s1', null, { anchorIds: undefined, anchor: [300, 300, 340, 330] }), comment('s2', 10, { resolved: true }), comment('pg', null, { anchorIds: undefined })], 's1');
    expect(anchors).toEqual([
      { id: 'c1', bbox: [50, 100, 200, 120], active: false },
      { id: 's1', bbox: [300, 300, 340, 330], active: true },
    ]);
  });

  it('follow their ink when it moves, and lose their pin and margin card once it is deleted', async () => {
    const { commentAnchors } = await import('../src/editor/view');
    const { anchorInkRemoved, LOCAL_ORIGIN } = await import('@qalm/core');
    const page = new Page(new Y.Doc());
    const pts = (x: number, y: number) => [0, 1, 2, 3].map((i) => ({ x: x + i * 10, y: y + i * 5, p: 0.5, tilt: Math.PI / 2, az: 0, t: i * 8 }));
    page.addItem({ id: 'w', type: 'stroke', tool: 'pen', color: '#000', width: 2, points: pts(100, 100), bbox: [99, 99, 131, 116], createdAt: 0 });
    const id = page.addComment({ author: you, text: 'this', anchor: [99, 99, 131, 116], anchorIds: ['w'] });
    page.doc.transact(() => page.updateItem('w', { points: pts(100, 400), bbox: [99, 399, 131, 416] }), LOCAL_ORIGIN);
    const pins = () => commentAnchors(page.comments(), null, page.items());
    expect(pins()).toEqual([{ id, bbox: [99, 399, 131, 416], active: false }]);
    expect(marginCards(page.comments(), 1, 64, 8, null, undefined, page.items()).map((c) => c.top)).toEqual([395]);
    page.removeItems(['w']);
    expect(pins()).toEqual([]);
    expect(marginCards(page.comments(), 1, 64, 8, null, undefined, page.items())).toEqual([]);
    expect(anchorInkRemoved(page.comments()[0]!, page.items())).toBe(true);
  });
});

describe('AI parts of the editor', () => {
  it('are all hidden while the notebook has AI access off, even with unread agent comments', () => {
    expect(aiUi(false, 3)).toEqual({ comments: false, ask: false, presence: false, badge: false });
    expect(aiUi(undefined, 0)).toEqual({ comments: false, ask: false, presence: false, badge: false });
  });

  it('come back when AI access is turned on; the badge shows only with unread comments', () => {
    expect(aiUi(true, 2)).toEqual({ comments: true, ask: true, presence: true, badge: true });
    expect(aiUi(true, 0).badge).toBe(false);
  });

  it('the comments panel starts closed on every screen size', () => {
    expect(COMMENTS_START_OPEN).toBe(false);
  });
});
