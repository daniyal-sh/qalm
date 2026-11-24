import { Library, Notebook, Page, summarizeThreads, type Comment } from '@qalm/core';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';

import { aiScope, grantSummary, getAiOverview, updateGrant } from '../src/api/ai';
import { extractMagicToken } from '../src/auth/magicLink';
import { filterFor, filterRows, rowsInView, threadRows } from '../src/editor/CommentsPanel.logic';
import {
  anchoredScroll,
  clampZoom,
  commentAnchors,
  contentHeight,
  currentPageIndex,
  hitAnchor,
  layoutPages,
  threadQuote,
  mountedRange,
  pdfBucketWidth,
  penButtonTool,
  stepZoom,
} from '../src/editor/view';
import { buildNotebook, copyInto, entryFor, folderCounts, mergeLibrary, relativeTime, sizeFor, visibleEntries } from '../src/library/actions';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('magic link', () => {
  it('extracts the token from links and bare tokens', () => {
    expect(extractMagicToken('https://api.qalm.app/auth/email/verify?token=abc%2Ddef1234567890xyz')).toBe('abc-def1234567890xyz');
    expect(extractMagicToken('qalm://auth/email/verify?x=1&token=tok_1234567890abcdef')).toBe('tok_1234567890abcdef');
    expect(extractMagicToken('https://qalm.apollolearn.app/app/auth/email/verify?token=tok_1234567890abcdef')).toBe('tok_1234567890abcdef'); // the web app under /app
    expect(extractMagicToken('  Zm9vYmFyYmF6cXV4MTIzNDU2  ')).toBe('Zm9vYmFyYmF6cXV4MTIzNDU2');
    expect(extractMagicToken('hello')).toBeNull();
    expect(extractMagicToken('')).toBeNull();
  });
});

describe('AI access API', () => {
  it('loads grants, requests and activity and patches a grant', async () => {
    const calls: string[] = [];
    const tm = {
      fetch: async (path: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${path}`);
        if (path === '/ai/grants') return json({ mcpUrl: 'https://s/mcp', grants: [{ id: 'g1', clientName: 'Claude', canComment: false, canTranscribe: false }] });
        if (path === '/ai/requests') return json({ requests: [] });
        if (path.startsWith('/ai/activity')) return json({ activity: [] });
        if (path === '/ai/grants/g1') return json({ grant: { id: 'g1', clientName: 'Claude', ...JSON.parse(String(init!.body)) } });
        return json({ error: 'nope' }, 404);
      },
    };
    const o = await getAiOverview(tm);
    expect(o.mcpUrl).toBe('https://s/mcp');
    expect(o.grants).toHaveLength(1);
    const g = await updateGrant(tm, 'g1', { canComment: true });
    expect(g.canComment).toBe(true);
    expect(calls).toContain('PATCH /ai/grants/g1');
  });

  it('summarizes a grant and what it can see', () => {
    expect(grantSummary({ canComment: true, canTranscribe: false })).toBe('Read and comment');
    expect(grantSummary({ canComment: false, canTranscribe: false })).toBe('Read only');
    // Every approved agent sees the notebooks with AI access on (no per-agent picker).
    expect(aiScope([])).toBe('No notebook has AI access on');
    expect(aiScope([{ aiAccess: true, deletedAt: null }, { aiAccess: false, deletedAt: null }, { aiAccess: true, deletedAt: 5 }])).toBe('1 notebook with AI access on');
    expect(aiScope([{ aiAccess: true, deletedAt: null }, { aiAccess: true, deletedAt: null }])).toBe('2 notebooks with AI access on');
  });
});

describe('editor view maths', () => {
  const pages = [
    { id: 'a', size: { w: 595, h: 842 } },
    { id: 'b', size: { w: 842, h: 595 } },
    { id: 'c', size: { w: 595, h: 842 } },
  ];

  it('clamps and steps zoom between 0.75x and 4x', () => {
    expect(clampZoom(10)).toBe(4);
    expect(clampZoom(0.1)).toBe(0.75);
    expect(clampZoom(NaN)).toBe(1);
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(4, 1)).toBe(4);
    expect(stepZoom(1, -1)).toBe(0.75);
    expect(stepZoom(1.1, -1)).toBe(1);
  });

  it('lays pages out vertically, scaled to the widest page', () => {
    const s = layoutPages(pages, 800, 1, 20, 10);
    expect(s[1]!.width).toBe(800);
    expect(s[0]!.width).toBe(Math.round((800 * 595) / 842));
    expect(s[0]!.top).toBe(10);
    expect(s[1]!.top).toBe(10 + s[0]!.height + 20);
    expect(contentHeight(s, 20)).toBe(s[2]!.top + s[2]!.height + 20);
    const z2 = layoutPages(pages, 800, 2, 20, 10);
    expect(z2[1]!.width).toBe(1600);
  });

  it('mounts visible pages plus two either side', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, size: { w: 100, h: 100 } }));
    const s = layoutPages(many, 100, 1, 0, 0);
    expect(mountedRange(s, 450, 100)).toEqual([2, 7]);
    expect(mountedRange(s, 0, 150)).toEqual([0, 3]);
    expect(mountedRange([], 0, 100)).toEqual([0, -1]);
    expect(currentPageIndex(s, 430, 100)).toBe(4);
  });

  it('picks PDF width buckets', () => {
    expect(pdfBucketWidth(500, 500)).toBe(500);
    expect(pdfBucketWidth(700, 500)).toBe(1000);
    expect(pdfBucketWidth(1500, 500)).toBe(2000);
    expect(pdfBucketWidth(500, 500, 2)).toBe(1000);
  });

  it('keeps the viewport centre when zooming', () => {
    expect(anchoredScroll(100, 200, 1, 2)).toBe(300);
    expect(anchoredScroll(0, 200, 2, 1)).toBe(0);
  });

  it('switches to the eraser and back on the pen button', () => {
    expect(penButtonTool('eraser', 'pen', 'pen')).toBe('eraser');
    expect(penButtonTool('eraser', 'eraser', 'highlighter')).toBe('highlighter');
    expect(penButtonTool('eraser', 'eraser', 'eraser')).toBe('pen');
    expect(penButtonTool('last', 'pen', 'lasso')).toBe('lasso');
    expect(penButtonTool('none', 'pen', 'lasso')).toBe('pen');
  });

  it('anchors open comments to their strokes (live) or box; quotes the fresh reading of their strokes', () => {
    const p = new Page(new Y.Doc());
    p.addItem({ id: 's1', type: 'stroke', tool: 'pen', color: '#000', width: 1, points: [{ x: 0, y: 0, p: 0.5, tilt: 1.5, az: 0, t: 0 }, { x: 100, y: 20, p: 0.5, tilt: 1.5, az: 0, t: 8 }], bbox: [0, 0, 100, 20], createdAt: 0 });
    p.setReading(['s1'], 'x = 2', 'agent', 'Claude');
    const cm = (id: string, extra: Partial<Comment>, resolved = false): Comment => ({ id, author: { kind: 'agent', name: 'Claude' }, text: 't', createdAt: 1, resolved, replies: [], ...extra });
    const items = p.items();
    const a = commentAnchors([cm('c1', { anchorIds: ['s1'] }), cm('c2', { anchor: [0, 40, 100, 60] }, true), cm('c3', { anchorIds: ['gone'] }), cm('c4', {})], 'c1', items);
    expect(a).toEqual([{ id: 'c1', bbox: [0, 0, 100, 20], active: true }]);
    expect(commentAnchors([cm('c2', { anchor: [0, 40, 100, 60] }, true)], 'c2', items)).toHaveLength(1);
    expect(threadQuote(p.readings(), cm('c1', { anchorIds: ['s1'] }))).toBe('x = 2');
    expect(threadQuote(p.readings(), cm('c4', {}))).toBeNull();
    p.addItem({ id: 's2', type: 'stroke', tool: 'pen', color: '#000', width: 1, points: [{ x: 102, y: 0, p: 0.5, tilt: 1.5, az: 0, t: 0 }, { x: 110, y: 20, p: 0.5, tilt: 1.5, az: 0, t: 8 }], bbox: [102, 0, 110, 20], createdAt: 0 });
    expect(threadQuote(p.readings(), cm('c1', { anchorIds: ['s1'] }))).toBeNull(); // stale: no quote
    expect(hitAnchor(a, 109, 5)?.id).toBe('c1');
    expect(hitAnchor(a, 50, 50)).toBeNull();
  });
});

describe('comments panel rows', () => {
  it('lists every thread notebook-wide: live on loaded pages, from the index elsewhere', () => {
    const p1 = new Page(new Y.Doc());
    const p2 = new Page(new Y.Doc());
    const far = new Page(new Y.Doc());
    const a = p2.addComment({ author: { kind: 'agent', name: 'Claude' }, text: 'agent' });
    p1.addComment({ author: { kind: 'user', name: 'Me' }, text: 'mine' });
    const done = p1.addComment({ author: { kind: 'agent', name: 'Claude' }, text: 'old' });
    p1.resolveComment(done);
    const farId = far.addComment({ author: { kind: 'agent', name: 'Claude' }, text: 'on page 30' });
    const gone = new Page(new Y.Doc());
    gone.addComment({ author: { kind: 'user', name: 'Me' }, text: 'deleted page' });
    // The index also has a stale copy of p1's threads (live data wins) and a thread on a deleted page (left out).
    const index = [...summarizeThreads('p1', p1.comments()).map((t) => ({ ...t, text: 'stale' })), ...summarizeThreads('p30', far.comments()), ...summarizeThreads('gone', gone.comments())];
    const loaded = new Map([
      ['p2', { page: p2, index: 1, readings: [], comments: p2.comments(), items: [] }],
      ['p1', { page: p1, index: 0, readings: [], comments: p1.comments(), items: [] }],
    ]);
    const order = ['p1', 'p2', ...Array.from({ length: 27 }, (_, i) => `x${i}`), 'p30'];
    const rows = threadRows(index, loaded, order);
    // Page order; within a page newest first (sorted here, as comments made in the same millisecond tie).
    expect(rows.map((r) => r.index)).toEqual([0, 0, 1, 29]);
    expect(rows.map((r) => [r.index, r.summary.text, !!r.comment]).sort()).toEqual([
      [0, 'mine', true],
      [0, 'old', true],
      [1, 'agent', true],
      [29, 'on page 30', false],
    ]);
    expect(filterRows(rows, 'open').map((r) => r.summary.text)).toEqual(['mine', 'agent', 'on page 30']); // 'old' is resolved
    expect(filterRows(rows, 'ai').map((r) => r.summary.id)).toEqual([a, farId]);
    expect(filterRows(rows, 'resolved').map((r) => r.summary.id)).toEqual([done]);
    expect(filterRows(rows, 'all')).toHaveLength(4);
  });

  it('switches to a tab that lists the active thread (resolved threads are only under Resolved)', () => {
    const agent = { kind: 'agent' as const, name: 'Claude' };
    const me = { kind: 'user' as const, name: 'Me' };
    expect(filterFor({ resolved: true, author: me }, 'open')).toBe('resolved');
    expect(filterFor({ resolved: true, author: agent }, 'ai')).toBe('resolved');
    expect(filterFor({ resolved: false, author: me }, 'ai')).toBe('open');
    expect(filterFor({ resolved: false, author: agent }, 'ai')).toBe('ai');
    expect(filterFor({ resolved: false, author: agent }, 'resolved')).toBe('open');
    expect(filterFor({ resolved: false, author: me }, 'open')).toBe('open');
  });

  it('lists the cards on screen in the panel', () => {
    const boxes = new Map([
      ['a', { y: 0, h: 200 }],
      ['b', { y: 210, h: 200 }],
      ['c', { y: 420, h: 30 }],
      ['d', { y: 460, h: 200 }],
    ]);
    expect(rowsInView(boxes, 0, 300)).toEqual(['a', 'b']);
    expect(rowsInView(boxes, 0, 240)).toEqual(['a']); // only 30 px of b
    expect(rowsInView(boxes, 250, 300)).toEqual(['b', 'c', 'd']);
    expect(rowsInView(boxes, 0, 0)).toEqual([]);
  });
});

describe('library actions', () => {
  it('builds a notebook with the chosen paper, size and AI access', () => {
    const doc = buildNotebook('nb1', { title: '  ', cover: '#4338ca', paper: 'grid', paperColor: 'cream', size: 'A5', orientation: 'landscape', aiAccess: true });
    const target = new Y.Doc();
    copyInto(target, doc);
    const nb = new Notebook(target);
    expect(nb.meta()).toMatchObject({ id: 'nb1', title: 'Untitled notebook', paper: 'grid', paperColor: 'cream', size: { w: 595, h: 420 }, aiAccess: true });
    expect(nb.pages()).toHaveLength(1);
    expect(sizeFor('Letter', 'portrait')).toEqual({ w: 612, h: 792 });
  });

  it('filters, searches and sorts entries', () => {
    const e = (id: string, patch: object) => ({ ...entryFor({ id, title: id, cover: '#000', aiAccess: false }, null), ...patch });
    const entries = [
      e('Physics', { updatedAt: 1, favorite: true }),
      e('Calculus', { updatedAt: 3, folderId: 'f' }),
      e('Old', { updatedAt: 5, deletedAt: 9 }),
      e('AI notes', { updatedAt: 2, aiAccess: true }),
    ];
    expect(visibleEntries(entries, { kind: 'all' }).map((x) => x.id)).toEqual(['Calculus', 'AI notes', 'Physics']);
    expect(visibleEntries(entries, { kind: 'favorites' }).map((x) => x.id)).toEqual(['Physics']);
    expect(visibleEntries(entries, { kind: 'trash' }).map((x) => x.id)).toEqual(['Old']);
    expect(visibleEntries(entries, { kind: 'folder', id: 'f' }).map((x) => x.id)).toEqual(['Calculus']);
    expect(visibleEntries(entries, { kind: 'ai' }).map((x) => x.id)).toEqual(['AI notes']);
    expect(visibleEntries(entries, { kind: 'all' }, 'calc').map((x) => x.id)).toEqual(['Calculus']);
    expect(folderCounts(entries).get('f')).toBe(1);
  });

  it('merges the signed-out library into the account library on sign-in', () => {
    const local = new Library(new Y.Doc());
    const account = new Library(new Y.Doc());
    const f = local.addFolder('School');
    local.putEntry(entryFor({ id: 'n1', title: 'One', cover: '#000', aiAccess: false }, f));
    local.putEntry(entryFor({ id: 'n2', title: 'Two', cover: '#000', aiAccess: false }, null));
    account.putEntry(entryFor({ id: 'n2', title: 'Two (synced)', cover: '#000', aiAccess: false }, null));
    const existing = account.addFolder('School');
    expect(mergeLibrary(account, local)).toBe(1);
    expect(account.folders()).toHaveLength(1);
    expect(account.entry('n1')?.folderId).toBe(existing);
    expect(account.entry('n2')?.title).toBe('Two (synced)');
  });

  it('formats relative times', () => {
    const now = Date.UTC(2026, 10, 22, 12);
    expect(relativeTime(now - 10_000, now)).toBe('Just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(relativeTime(now - 3 * 3600_000, now)).toBe('3 h ago');
    expect(relativeTime(now - 26 * 3600_000, now)).toBe('Yesterday');
  });
});
