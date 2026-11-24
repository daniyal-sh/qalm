/**
 * The text box format bar: inserts Markdown syntax around the selection (or at the caret), and takes it away again
 * when the selection already has it. Pure, so it behaves the same on every platform.
 */
export type FormatKind = 'bold' | 'italic' | 'strike' | 'heading' | 'bullet' | 'numbered' | 'quote' | 'code' | 'link' | 'math';

export interface Sel {
  start: number;
  end: number;
}
export interface Formatted {
  text: string;
  sel: Sel;
}

export const FORMAT_KINDS: readonly FormatKind[] = ['bold', 'italic', 'strike', 'heading', 'bullet', 'numbered', 'quote', 'code', 'link', 'math'];

const WRAP: Partial<Record<FormatKind, string>> = { bold: '**', italic: '*', strike: '~~', code: '`', math: '$' };

const clampSel = (text: string, sel: Sel): Sel => {
  const a = Math.max(0, Math.min(text.length, Math.min(sel.start, sel.end)));
  const b = Math.max(0, Math.min(text.length, Math.max(sel.start, sel.end)));
  return { start: a, end: b };
};

/** Wraps the selection in `mark` (or unwraps it when it is already wrapped, inside or just outside the selection). */
function wrap(text: string, { start, end }: Sel, mark: string, closing = mark): Formatted {
  const inner = text.slice(start, end);
  const n = mark.length;
  const m = closing.length;
  // Stars count: `*x*` is italic, `**x**` bold, `***x***` both, so italic and bold toggle independently.
  if (mark === '*' || mark === '**') {
    const stars = (t: string) => t.length - t.replace(/^\*+/, '').length;
    const rev = (t: string) => [...t].reverse().join('');
    const has = (k: number) => (mark === '*' ? k % 2 === 1 : k >= 2);
    // The marks inside the selection (`**bold**` selected with them).
    const kin = Math.min(stars(inner), stars(rev(inner)));
    if (inner.length > 2 * kin && has(kin)) {
      const out = inner.slice(n, inner.length - n);
      return { text: text.slice(0, start) + out + text.slice(end), sel: { start, end: start + out.length } };
    }
    // The marks just outside it.
    const kout = Math.min(stars(rev(text.slice(0, start))), stars(text.slice(end)));
    if (has(kout)) return { text: text.slice(0, start - n) + inner + text.slice(end + n), sel: { start: start - n, end: end - n } };
  } else {
    if (inner.length >= n + m && inner.startsWith(mark) && inner.endsWith(closing)) {
      const out = inner.slice(n, inner.length - m);
      return { text: text.slice(0, start) + out + text.slice(end), sel: { start, end: start + out.length } };
    }
    if (start >= n && text.slice(start - n, start) === mark && text.slice(end, end + m) === closing) {
      return { text: text.slice(0, start - n) + inner + text.slice(end + m), sel: { start: start - n, end: end - n } };
    }
  }
  // Keep spaces the selection caught at its edges outside the marks (`** bold**` isn't bold).
  const lead = inner.length - inner.trimStart().length;
  const trail = inner.length - inner.trimEnd().length;
  const core = inner.trim();
  if (!core) return { text: text.slice(0, start) + mark + closing + text.slice(start), sel: { start: start + n, end: start + n } };
  const s = start + lead;
  const out = text.slice(0, s) + mark + core + closing + text.slice(end - trail);
  return { text: out, sel: { start: s + n, end: s + n + core.length } };
}

/** The start of the line `i` is on, and the end of the line `j` is on. */
const lineStart = (text: string, i: number) => text.lastIndexOf('\n', i - 1) + 1;
const lineEnd = (text: string, j: number) => {
  const k = text.indexOf('\n', j);
  return k < 0 ? text.length : k;
};

/** Applies a per-line edit to every line the selection touches, keeping the selection over the same lines. */
function eachLine(text: string, sel: Sel, edit: (lines: string[]) => string[]): Formatted {
  const a = lineStart(text, sel.start);
  // A selection ending at the start of a line doesn't include that line.
  const endAt = sel.end > sel.start && text[sel.end - 1] === '\n' ? sel.end - 1 : sel.end;
  const b = lineEnd(text, endAt);
  const lines = edit(text.slice(a, b).split('\n'));
  const block = lines.join('\n');
  const out = text.slice(0, a) + block + text.slice(b);
  if (sel.start === sel.end) {
    // A caret stays at the end of its (only) line.
    const caret = a + block.length - (text.slice(sel.start, b).length);
    return { text: out, sel: { start: Math.max(a, caret), end: Math.max(a, caret) } };
  }
  return { text: out, sel: { start: a, end: a + block.length } };
}

const BULLET = /^(\s*)[-*+] /;
const NUMBER = /^(\s*)\d+[.)] /;
const QUOTE = /^()> ?/;
const HEADING = /^(#{1,6}) /;

/** Toggles a line prefix: removed when every non-empty line has it, else added (replacing another list marker). */
function prefixLines(text: string, sel: Sel, kind: 'bullet' | 'numbered' | 'quote'): Formatted {
  const test = kind === 'bullet' ? BULLET : kind === 'numbered' ? NUMBER : QUOTE;
  return eachLine(text, sel, (lines) => {
    const filled = lines.filter((l) => l.trim());
    const all = filled.length > 0 && filled.every((l) => test.test(l));
    let k = 0;
    return lines.map((l) => {
      if (all) return l.replace(test, '$1');
      if (!l.trim() && lines.length > 1) return l;
      if (kind === 'quote') return `> ${l}`;
      const bare = l.replace(BULLET, '$1').replace(NUMBER, '$1');
      const indent = bare.length - bare.trimStart().length;
      return `${bare.slice(0, indent)}${kind === 'bullet' ? '- ' : `${++k}. `}${bare.slice(indent)}`;
    });
  });
}

/** Cycles the line's heading: none → # → ## → ### → none. */
function heading(text: string, sel: Sel): Formatted {
  return eachLine(text, sel, (lines) =>
    lines.map((l) => {
      const m = HEADING.exec(l);
      const level = m ? m[1]!.length : 0;
      const bare = m ? l.slice(m[0].length) : l;
      return level >= 3 ? bare : `${'#'.repeat(level + 1)} ${bare}`;
    }),
  );
}

/** `[text](https://)` with the URL selected, so typing replaces it; a selected URL becomes the link's target. */
function link(text: string, { start, end }: Sel): Formatted {
  const inner = text.slice(start, end);
  if (/^(https?:\/\/|mailto:)\S+$/i.test(inner.trim())) {
    const out = `[](${inner.trim()})`;
    return { text: text.slice(0, start) + out + text.slice(end), sel: { start: start + 1, end: start + 1 } };
  }
  const label = inner || 'link';
  const url = 'https://';
  const out = `[${label}](${url})`;
  const u = start + label.length + 3;
  return { text: text.slice(0, start) + out + text.slice(end), sel: { start: u, end: u + url.length } };
}

/** Applies a format bar action to `text` with the selection `sel`; returns the new text and selection. */
export function applyFormat(text: string, sel: Sel, kind: FormatKind): Formatted {
  const s = clampSel(text, sel);
  const multiline = text.slice(s.start, s.end).includes('\n');
  switch (kind) {
    case 'bullet':
    case 'numbered':
    case 'quote':
      return prefixLines(text, s, kind);
    case 'heading':
      return heading(text, s);
    case 'link':
      return link(text, s);
    case 'code':
      // Several lines become a code block.
      if (multiline) return wrap(text, s, '```\n', '\n```');
      return wrap(text, s, '`');
    case 'math':
      if (multiline) return wrap(text, s, '$$\n', '\n$$');
      return wrap(text, s, '$');
    default:
      return wrap(text, s, WRAP[kind]!);
  }
}

/** Characters Markdown may read as syntax anywhere in a line (a backslash before any of them shows it as typed). */
const INLINE_SPECIAL = new Set(['\\', '`', '*', '_', '~', '$', '[', ']', '<', '>', '&']);
/** A line start Markdown reads as a heading, list item, rule or setext underline. */
const LINE_START = /^( {0,3})(#|[-+](?= |$)|\d{1,9}(?=[.)](?: |$))|-+ *$|=+ *$)/;

/**
 * Escapes text written as plain (a text box from before Markdown) so it reads the same as Markdown: `price *5*` stays
 * `price *5*`, `# x` isn't a heading, an indented line isn't code (and keeps its indentation). Returns the escaped text and where each old index lands in it.
 */
export function escapeMarkdown(text: string): { text: string; at(i: number): number } {
  const out: string[] = [];
  // map[i]: the index in the output of the input's index i (text.length maps to the end).
  const map: number[] = [];
  let n = 0;
  const lines = text.split('\n');
  lines.forEach((line, li) => {
    // A heading, list or rule marker at the start of a line: escape its first character (for "1." the dot).
    const m = LINE_START.exec(line);
    const escAt = m ? m[1]!.length + (/^\d/.test(m[2]!) ? m[2]!.length : 0) : -1;
    // Leading indentation: 4 spaces or a tab would start a code block, and less is dropped. Its first character becomes
    // an entity, so the line starts with text and the indentation shows (whitespace-only lines stay blank).
    const indented = /^[ \t]/.test(line) && line.trim() !== '';
    for (let i = 0; i < line.length; i++) {
      map.push(n);
      const ch = line[i]!;
      if (i === 0 && indented) {
        const entity = ch === '\t' ? '&#9;' : '&#32;';
        out.push(entity);
        n += entity.length;
        continue;
      }
      if (i === escAt || INLINE_SPECIAL.has(ch)) {
        out.push('\\');
        n++;
      }
      out.push(ch);
      n++;
    }
    if (li < lines.length - 1) {
      map.push(n);
      out.push('\n');
      n++;
    }
  });
  map.push(n);
  return { text: out.join(''), at: (i) => map[Math.max(0, Math.min(map.length - 1, i))]! };
}

/**
 * The format bar on a box that isn't Markdown yet (`legacy`): its text is escaped first, so the box keeps reading as
 * typed and only the new formatting takes effect.
 */
export function applyFormatTo(text: string, sel: Sel, kind: FormatKind, legacy: boolean): Formatted {
  if (!legacy) return applyFormat(text, sel, kind);
  const e = escapeMarkdown(text);
  return applyFormat(e.text, { start: e.at(sel.start), end: e.at(sel.end) }, kind);
}
