import { Page, type Comment, type Line } from '@qalm/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { getPresence, presenceCan, presenceNames } from '../src/api/ai';
import { agentEntryCount, markAllSeen, marginCards, newestAgentEntry, startThinking, stillThinking, THINKING_MS, unreadCount } from '../src/editor/ai.logic';
import type { PageData } from '../src/editor/context';

const agent = { kind: 'agent' as const, name: 'Claude' };
const you = { kind: 'user' as const, name: 'You' };

function pageWith(build: (p: Page) => void): PageData {
  const page = new Page(new Y.Doc());
  build(page);
  return { page, index: 0, lines: page.lines(), comments: page.comments() };
}

const line = (key: string, y: number): Line => ({ key, kind: 'line', itemIds: [key], bbox: [50, y, 200, y + 20] });
const comment = (id: string, lineKey: string, extra: Partial<Comment> = {}): Comment => ({
  id,
  lineKey,
  author: agent,
  text: id,
  createdAt: 1,
  resolved: false,
  replies: [],
  ...extra,
});

describe('live agent logic', () => {
  it('counts unread agent entries and marks them read', () => {
    let a = '';
    const d = pageWith((p) => {
      a = p.addComment({ lineKey: 'k', author: agent, text: 'hi' });
      p.replyToComment(a, you, 'why');
      p.replyToComment(a, agent, 'because');
      p.addComment({ lineKey: 'k', author: you, text: 'mine' });
    });
    expect(agentEntryCount([d])).toBe(2);
    expect(unreadCount([d], {})).toBe(2);
    expect(unreadCount([d], { [a]: 2 })).toBe(1);
    const seen = markAllSeen([d], {});
    expect(unreadCount([d], seen)).toBe(0);
    expect(markAllSeen([d], seen)).toBe(seen);
    expect(newestAgentEntry([d])?.name).toBe('Claude');
  });

  it('stacks margin cards beside their lines without overlap, skipping resolved and orphaned threads', () => {
    const lines = [line('a', 100), line('b', 110), line('c', 400)];
    const cards = marginCards(
      lines,
      [comment('c1', 'a'), comment('c2', 'b'), comment('c3', 'c'), comment('gone', 'zzz'), comment('done', 'a', { resolved: true }), comment('sel', '', { anchor: [0, 300, 10, 310] })],
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
    const lines = [line('a', 380), line('b', 390), line('c', 395)];
    const cards = marginCards(lines, [comment('c1', 'a'), comment('c2', 'b'), comment('c3', 'c')], 1, 64, 8, null, 420);
    expect(cards.map((c) => c.top)).toEqual([212, 284, 356]);
    // A stack taller than the page keeps its order and overflows instead of overlapping.
    expect(marginCards(lines, [comment('c1', 'a'), comment('c2', 'b'), comment('c3', 'c')], 1, 64, 8, null, 200).map((c) => c.top)).toEqual([376, 448, 520]);
  });

  it('thinking ends when an agent writes on a page loaded at the Ask, or after a timeout', () => {
    let a = '';
    const p1 = pageWith((p) => {
      a = p.addComment({ lineKey: 'k', author: agent, text: 'earlier answer' });
    });
    const t = startThinking(new Map([['p1', p1]]), 1000);
    expect(stillThinking(t, new Map([['p1', p1]]), 2000)).toBe(true);
    // Scrolling: a page with old agent comments mounts, and the asked page unmounts. Neither ends it.
    const p2 = pageWith((p) => p.addComment({ lineKey: 'k', author: agent, text: 'old' }));
    expect(stillThinking(t, new Map([['p2', p2]]), 2000)).toBe(true);
    // The answer arrives as a reply on the page loaded at the Ask, even with other pages mounted around it.
    p1.page.replyToComment(a, agent, 'the answer');
    const p1b = { ...p1, comments: p1.page.comments() };
    expect(stillThinking(t, new Map([['p1', p1b], ['p2', p2]]), 2000)).toBe(false);
    expect(stillThinking(t, new Map([['p1', p1]]), 1000 + THINKING_MS)).toBe(false);
    expect(stillThinking(null, new Map(), 0)).toBe(false);
    expect(startThinking(new Map(), 5, 'c9')).toEqual({ before: {}, at: 5, commentId: 'c9' });
  });

  it('reads presence and names agents', async () => {
    const tm = {
      fetch: async (path: string) => {
        expect(path).toBe('/ai/presence?nb=nb%201');
        return new Response(JSON.stringify({ aiAccess: true, paused: false, agents: [{ name: 'Claude', waiting: true, lastAt: 1, canComment: true, canTranscribe: false }] }));
      },
    };
    const p = await getPresence(tm, 'nb 1');
    expect(p.agents[0]!.name).toBe('Claude');
    expect(presenceNames(['Claude'])).toBe('Claude');
    expect(presenceNames(['Claude', 'Tutor'])).toBe('Claude and Tutor');
    expect(presenceNames(['A', 'B', 'C'])).toBe('A and 2 others');
    expect(presenceCan(p.agents)).toBe('Read and comment');
  });
});

describe('selection threads', () => {
  it('pin at their selection box, keyed by comment id', async () => {
    const { commentAnchors } = await import('../src/editor/view');
    const lines = [line('a', 100)];
    const anchors = commentAnchors(lines, [comment('c1', 'a'), comment('s1', 'a', { anchor: [300, 300, 340, 330] }), comment('s2', '', { anchor: [10, 10, 20, 20], resolved: true })], 's1');
    expect(anchors).toEqual([
      { lineKey: 'a', bbox: [50, 100, 200, 120], active: false },
      { lineKey: 's1', bbox: [300, 300, 340, 330], active: true },
    ]);
  });
});
