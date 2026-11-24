import { createUndoManager, Page, type TextItem } from '@qalm/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { applyFormat, type FormatKind } from '../src/editor/format.logic';
import { formatText, typeText } from '../src/editor/items';
import { pastedText } from '../src/editor/systemPaste';
import { CrossPageUndo } from '../src/editor/undoStack';

/** `text` with the selection marked by `[` and `]` (or a caret `|`), formatted, written back the same way. */
function fmt(marked: string, kind: FormatKind): string {
  const caret = marked.indexOf('|');
  const start = caret >= 0 ? caret : marked.indexOf('[');
  const plain = marked.replace(/[[\]|]/g, '');
  const end = caret >= 0 ? caret : marked.indexOf(']') - 1;
  const { text, sel } = applyFormat(plain, { start, end }, kind);
  if (sel.start === sel.end) return `${text.slice(0, sel.start)}|${text.slice(sel.start)}`;
  return `${text.slice(0, sel.start)}[${text.slice(sel.start, sel.end)}]${text.slice(sel.end)}`;
}

describe('format bar', () => {
  it('wraps the selection, and unwraps it again', () => {
    expect(fmt('a [word] b', 'bold')).toBe('a **[word]** b');
    expect(fmt('a **[word]** b', 'bold')).toBe('a [word] b');
    expect(fmt('a [**word**] b', 'bold')).toBe('a [word] b');
    expect(fmt('a [word] b', 'strike')).toBe('a ~~[word]~~ b');
    expect(fmt('a ~~[word]~~ b', 'strike')).toBe('a [word] b');
    expect(fmt('[x^2]', 'math')).toBe('$[x^2]$');
    expect(fmt('[f(x)]', 'code')).toBe('`[f(x)]`');
  });

  it('toggles italic and bold independently', () => {
    expect(fmt('**[w]**', 'italic')).toBe('***[w]***');
    expect(fmt('***[w]***', 'italic')).toBe('**[w]**');
    expect(fmt('***[w]***', 'bold')).toBe('*[w]*');
    expect(fmt('*[w]*', 'italic')).toBe('[w]');
    expect(fmt('*[w]*', 'bold')).toBe('***[w]***');
  });

  it('keeps spaces caught at the edges outside the marks', () => {
    expect(fmt('a[ word ]b', 'bold')).toBe('a **[word]** b');
  });

  it('puts the caret between new marks when nothing is selected', () => {
    expect(fmt('ab|', 'bold')).toBe('ab**|**');
    expect(fmt('|', 'math')).toBe('$|$');
  });

  it('turns several lines into a code or maths block', () => {
    expect(fmt('[a\nb]', 'code')).toBe('```\n[a\nb]\n```');
    expect(fmt('[x\ny]', 'math')).toBe('$$\n[x\ny]\n$$');
  });

  it('prefixes every selected line, and toggles back', () => {
    expect(fmt('[a\nb]', 'bullet')).toBe('[- a\n- b]');
    expect(fmt('[- a\n- b]', 'bullet')).toBe('[a\nb]');
    expect(fmt('[a\nb]', 'numbered')).toBe('[1. a\n2. b]');
    expect(fmt('[- a\n- b]', 'numbered')).toBe('[1. a\n2. b]');
    expect(fmt('[a\nb]', 'quote')).toBe('[> a\n> b]');
    expect(fmt('[> a\n> b]', 'quote')).toBe('[a\nb]');
    // A caret on a line: that line only, caret kept at its end.
    expect(fmt('one\ntwo|', 'bullet')).toBe('one\n- two|');
  });

  it('cycles headings', () => {
    expect(fmt('Title|', 'heading')).toBe('# Title|');
    expect(fmt('# Title|', 'heading')).toBe('## Title|');
    expect(fmt('### Title|', 'heading')).toBe('Title|');
  });

  it('makes a link with its URL selected to type over', () => {
    expect(fmt('see [docs]', 'link')).toBe('see [docs]([https://])');
    expect(fmt('[https://a.b]', 'link')).toBe('[|](https://a.b)');
  });
});

describe('markdown flag on text boxes', () => {
  function setup() {
    let t = 0;
    const undo = new CrossPageUndo(() => t);
    const doc = new Y.Doc();
    const page = new Page(doc);
    undo.attach('p', createUndoManager(page));
    return { undo, page, doc, tick: (ms: number) => (t += ms) };
  }
  const plain: TextItem = { id: 'old', type: 'text', x: 10, y: 10, w: 200, text: 'price *5* each', fontSize: 16, color: '#27272a' };

  it('typing never turns an old plain box into Markdown', () => {
    const { undo, page } = setup();
    page.addItem(plain);
    typeText(page, undo, plain.id, 'price *6* each');
    const it = page.item(plain.id) as TextItem;
    expect(it.text).toBe('price *6* each');
    expect(it.format).toBeUndefined();
  });

  it('formatting a plain box makes it Markdown, and one undo takes both back', () => {
    const { undo, page, tick } = setup();
    page.addItem(plain);
    tick(5000);
    formatText(page, undo, plain.id, '**price** *5* each');
    expect(page.item(plain.id)).toMatchObject({ text: '**price** *5* each', format: 'md' });
    undo.undo();
    const back = page.item(plain.id) as TextItem;
    expect(back.text).toBe('price *5* each');
    expect(back.format).toBeUndefined();
  });

  it('a new box formatted before typing is added as Markdown', () => {
    const { undo, page } = setup();
    const draft: TextItem = { ...plain, id: 'new', text: '' };
    expect(formatText(page, undo, draft.id, '****', draft)).toBe(true);
    expect(page.item('new')).toMatchObject({ format: 'md' });
  });

  it('the flag syncs to another device through the Yjs doc', () => {
    const { undo, page, doc } = setup();
    page.addItem(plain);
    formatText(page, undo, plain.id, '**bold**');
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc));
    expect(new Page(other).item(plain.id)).toMatchObject({ text: '**bold**', format: 'md' });
  });

  it('pasted text makes a Markdown box', () => {
    expect(pastedText('**hi**', { x: 100, y: 100 }, { w: 595, h: 842 }, '#000', 'p1').format).toBe('md');
  });
});
