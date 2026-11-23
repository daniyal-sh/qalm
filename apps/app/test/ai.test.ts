import { Page, type Comment, type Line } from '@qalm/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { getPresence, presenceCan, presenceNames } from '../src/api/ai';
import { agentEntryCount, markAllSeen, marginCards, newestAgentEntry, stillThinking, THINKING_MS, unreadCount } from '../src/editor/ai.logic';
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

  it('thinking ends when an agent entry arrives or after a timeout', () => {
    const t = { baseline: 3, at: 1000 };
    expect(stillThinking(t, 3, 2000)).toBe(true);
    expect(stillThinking(t, 4, 2000)).toBe(false);
    expect(stillThinking(t, 3, 1000 + THINKING_MS)).toBe(false);
    expect(stillThinking(null, 0, 0)).toBe(false);
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
