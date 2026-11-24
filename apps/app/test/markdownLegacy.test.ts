import { markdownToPlain, parseMarkdown } from '@qalm/core';
import { describe, expect, it } from 'vitest';

import { applyFormatTo, escapeMarkdown } from '../src/editor/format.logic';

/** Indices of `part` in `text`, as a selection. */
const sel = (text: string, part: string) => {
  const start = text.indexOf(part);
  return { start, end: start + part.length };
};

describe('formatting a box from before Markdown', () => {
  const legacy = [
    'price *5* each, 2*3*4',
    '# not a heading',
    '1. not a list',
    '- not a bullet',
    '+ nor this',
    'a line\n---',
    'a line\n===',
    '`code` and ~~strike~~ and _under_',
    'costs $5 and $x^2$ dollars',
    'List<T> & [link](https://a.b) \\ backslash',
    '> not a quote',
  ];

  it('escaping keeps every old box reading exactly as typed', () => {
    for (const s of legacy) expect(markdownToPlain(escapeMarkdown(s).text)).toBe(s);
  });

  it('escaping leaves text without Markdown characters alone', () => {
    expect(escapeMarkdown('Plain note, 42 items.').text).toBe('Plain note, 42 items.');
  });

  it('the first press escapes the old text, then formats the (remapped) selection', () => {
    const old = 'price *5* each';
    const { text, sel: s } = applyFormatTo(old, sel(old, 'each'), 'bold', true);
    expect(text).toBe('price \\*5\\* **each**');
    expect(text.slice(s.start, s.end)).toBe('each');
    const [p] = parseMarkdown(text);
    expect(p).toEqual({
      t: 'p',
      c: [
        { t: 'text', text: 'price *5* ', m: {} },
        { t: 'text', text: 'each', m: { b: true } },
      ],
    });
  });

  it('a selection inside escaped text still lands on the same characters', () => {
    const old = 'price *5* each';
    const { text } = applyFormatTo(old, sel(old, '5'), 'bold', true);
    expect(markdownToPlain(text)).toBe('price *5* each');
    const [p] = parseMarkdown(text);
    expect(p?.t === 'p' && p.c.find((x) => x.t === 'text' && x.m.b)).toMatchObject({ text: '5' });
  });

  it('a heading press on an old "# x" line makes it a heading of "# x", not of "x"', () => {
    const old = '# x';
    const { text } = applyFormatTo(old, { start: 3, end: 3 }, 'heading', true);
    expect(parseMarkdown(text)).toEqual([{ t: 'h', level: 1, c: [{ t: 'text', text: '# x', m: {} }] }]);
  });

  it('a box that is already Markdown is not escaped', () => {
    const md = 'price *5* each';
    expect(applyFormatTo(md, sel(md, 'each'), 'bold', false).text).toBe('price *5* **each**');
  });
});
