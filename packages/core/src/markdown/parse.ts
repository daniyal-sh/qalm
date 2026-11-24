import MarkdownItCtor, { type MarkdownIt, type StateBlock, type StateInline, type Token } from 'markdown-it';

/**
 * The Markdown qalm renders in text boxes (with `format: 'md'`) and comments: bold, italic, strikethrough, headings,
 * bullet and numbered lists, blockquotes, inline code and code blocks, links and TeX maths (`$x^2$`, `$$…$$`).
 * Raw HTML is never rendered: it shows as the text it is (so `0<x and y>1` or `<T>` stay as typed). Images show their
 * alt text (nothing is ever fetched), and a single newline is a line break, as people type in a note. Parsed into a small tree that every renderer (Skia on the page, pdf-lib,
 * SVG for agents' crops, React Native for comments) draws the same way.
 */

export interface Marks {
  b?: true;
  i?: true;
  s?: true;
  code?: true;
  /** A link's target (http, https or mailto only). */
  href?: string;
}
export type MdInline = { t: 'text'; text: string; m: Marks } | { t: 'math'; tex: string; m: Marks } | { t: 'br' };
export type MdBlock =
  | { t: 'p'; c: MdInline[] }
  | { t: 'h'; level: number; c: MdInline[] }
  | { t: 'code'; text: string }
  | { t: 'math'; tex: string }
  | { t: 'quote'; c: MdBlock[] }
  | { t: 'list'; ordered: boolean; start: number; items: MdBlock[][] }
  | { t: 'hr' };

/** Link targets that may be opened: never `javascript:`, `data:`, `file:` and the like. */
export function safeHref(href: string): string | null {
  const h = href.trim();
  return /^(https?:|mailto:)/i.test(h) ? h : null;
}

const DOLLAR = 0x24;
const BACKSLASH = 0x5c;

/** Where the `$` (or `$$`) closing maths that opened just before `from` is, skipping escaped ones; -1 if none. */
function closingDollar(src: string, from: number, delim: string): number {
  for (let end = from; ; end++) {
    end = src.indexOf(delim, end);
    if (end < 0) return -1;
    let backslashes = 0;
    for (let k = end - 1; src.charCodeAt(k) === BACKSLASH; k--) backslashes++;
    if (backslashes % 2 === 0) return end;
  }
}

/**
 * `$…$` inline maths (and `$$…$$` inside a line). Like most Markdown maths: no space just inside single dollars, and
 * `$5 and $6` stays text.
 */
function mathInline(state: StateInline, silent: boolean): boolean {
  const src = state.src;
  const start = state.pos;
  if (src.charCodeAt(start) !== DOLLAR) return false;
  const delim = src.charCodeAt(start + 1) === DOLLAR ? '$$' : '$';
  const from = start + delim.length;
  const first = src.charCodeAt(from);
  if (Number.isNaN(first) || (delim === '$' && (first === 0x20 || first === 0x0a))) return false;
  const end = closingDollar(src, from, delim);
  if (end <= from) return false;
  if (delim === '$') {
    const before = src.charCodeAt(end - 1);
    const after = src.charCodeAt(end + 1);
    if (before === 0x20 || before === 0x0a || (after >= 0x30 && after <= 0x39)) return false;
  }
  if (!silent) {
    const tok = state.push('math_inline', 'math', 0);
    tok.content = src.slice(from, end).trim();
    tok.markup = delim;
  }
  state.pos = end + delim.length;
  return true;
}

/** `$$…$$` display maths: a line that is just `$$…$$`, or `$$` … lines … a line ending in `$$`. */
function mathBlock(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const lineText = (n: number) => state.src.slice(state.bMarks[n]! + state.tShift[n]!, state.eMarks[n]!);
  if (state.sCount[startLine]! - state.blkIndent >= 4) return false;
  const open = lineText(startLine);
  if (!open.startsWith('$$')) return false;
  const rest = open.slice(2);
  const close = closingDollar(rest, 0, '$$');
  let content: string;
  let next = startLine;
  if (close >= 0) {
    // One line: only a block when nothing follows the closing `$$` (else it's maths inside a paragraph).
    if (rest.slice(close + 2).trim()) return false;
    content = rest.slice(0, close);
  } else {
    const lines = [rest];
    let found = false;
    while (!found && ++next < endLine) {
      if (state.sCount[next]! < state.blkIndent) break;
      const line = lineText(next).trimEnd();
      if (line.endsWith('$$')) {
        lines.push(line.slice(0, -2));
        found = true;
      } else lines.push(line);
    }
    if (!found) return false;
    content = lines.join('\n');
  }
  if (silent) return true;
  state.line = next + 1;
  const tok = state.push('math_block', 'math', 0);
  tok.block = true;
  tok.content = content.trim();
  tok.map = [startLine, state.line];
  tok.markup = '$$';
  return true;
}

let md: MarkdownIt | null = null;
function parser(): MarkdownIt {
  if (md) return md;
  // html: false: tags are plain text. (Dropping HTML tokens deleted ordinary text like `if 0<x and y>1`, and a `<pre>`
  // or `<!--` line hid the rest of the box.)
  md = new MarkdownItCtor('commonmark', { html: false, breaks: true, linkify: false, typographer: false });
  md.enable('strikethrough');
  md.validateLink = (url) => safeHref(url) !== null || !/^[a-z][a-z0-9+.-]*:/i.test(url.trim());
  md.inline.ruler.after('escape', 'math_inline', mathInline);
  md.block.ruler.after('blockquote', 'math_block', mathBlock, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
  return md;
}

function inlines(children: readonly Token[]): MdInline[] {
  const out: MdInline[] = [];
  const m: Marks = {};
  const hrefs: (string | undefined)[] = [];
  const text = (s: string, extra?: Marks) => {
    if (!s) return;
    const marks: Marks = { ...m, ...extra };
    const last = out[out.length - 1];
    if (last?.t === 'text' && sameMarks(last.m, marks)) last.text += s;
    else out.push({ t: 'text', text: s, m: marks });
  };
  for (const tok of children) {
    switch (tok.type) {
      case 'text':
        text(tok.content);
        break;
      case 'code_inline':
        text(tok.content, { code: true });
        break;
      case 'math_inline':
        out.push({ t: 'math', tex: tok.content, m: { ...m } });
        break;
      case 'softbreak':
      case 'hardbreak':
        out.push({ t: 'br' });
        break;
      case 'strong_open':
        m.b = true;
        break;
      case 'strong_close':
        delete m.b;
        break;
      case 'em_open':
        m.i = true;
        break;
      case 'em_close':
        delete m.i;
        break;
      case 's_open':
        m.s = true;
        break;
      case 's_close':
        delete m.s;
        break;
      case 'link_open': {
        const href = safeHref(String(tok.attrGet('href') ?? '')) ?? undefined;
        hrefs.push(m.href);
        if (href) m.href = href;
        else delete m.href;
        break;
      }
      case 'link_close': {
        const prev = hrefs.pop();
        if (prev) m.href = prev;
        else delete m.href;
        break;
      }
      case 'image':
        // Never fetched: an image shows its alt text.
        text(tok.children ? tok.children.map((c) => c.content).join('') : tok.content);
        break;
    }
  }
  return out;
}

const sameMarks = (a: Marks, b: Marks) => a.b === b.b && a.i === b.i && a.s === b.s && a.code === b.code && a.href === b.href;

function blocks(tokens: readonly Token[], from: number, to: number): MdBlock[] {
  const out: MdBlock[] = [];
  let i = from;
  /** Index of the token closing the one at `open` (same nesting level). */
  const closeOf = (open: number) => {
    let depth = 0;
    for (let k = open; k < to; k++) {
      depth += tokens[k]!.nesting;
      if (depth === 0) return k;
    }
    return to - 1;
  };
  while (i < to) {
    const tok = tokens[i]!;
    switch (tok.type) {
      case 'paragraph_open': {
        const inline = tokens[i + 1];
        const c = inline?.type === 'inline' ? inlines(inline.children ?? []) : [];
        if (c.length) out.push({ t: 'p', c });
        i = closeOf(i) + 1;
        continue;
      }
      case 'heading_open': {
        const inline = tokens[i + 1];
        out.push({ t: 'h', level: Number(tok.tag.slice(1)) || 1, c: inline?.type === 'inline' ? inlines(inline.children ?? []) : [] });
        i = closeOf(i) + 1;
        continue;
      }
      case 'blockquote_open': {
        const end = closeOf(i);
        out.push({ t: 'quote', c: blocks(tokens, i + 1, end) });
        i = end + 1;
        continue;
      }
      case 'bullet_list_open':
      case 'ordered_list_open': {
        const end = closeOf(i);
        const items: MdBlock[][] = [];
        for (let k = i + 1; k < end; ) {
          if (tokens[k]!.type === 'list_item_open') {
            const itemEnd = closeOf(k);
            items.push(blocks(tokens, k + 1, itemEnd));
            k = itemEnd + 1;
          } else k++;
        }
        const ordered = tok.type === 'ordered_list_open';
        out.push({ t: 'list', ordered, start: ordered ? Number(tok.attrGet('start') ?? 1) || 1 : 1, items });
        i = end + 1;
        continue;
      }
      case 'fence':
      case 'code_block':
        out.push({ t: 'code', text: tok.content.replace(/\n$/, '') });
        break;
      case 'math_block':
        out.push({ t: 'math', tex: tok.content });
        break;
      case 'hr':
        out.push({ t: 'hr' });
        break;
    }
    i++;
  }
  return out;
}

/** Parses Markdown into blocks (see the module comment for what's supported). */
export function parseMarkdown(src: string): MdBlock[] {
  const tokens = parser().parse(src, {});
  return blocks(tokens, 0, tokens.length);
}

function plainInline(c: readonly MdInline[]): string {
  return c.map((x) => (x.t === 'text' ? x.text : x.t === 'math' ? texToPlain(x.tex) : '\n')).join('');
}

function plainBlocks(bs: readonly MdBlock[]): string[] {
  const out: string[] = [];
  for (const b of bs) {
    if (b.t === 'p' || b.t === 'h') out.push(plainInline(b.c));
    else if (b.t === 'code' || b.t === 'math') out.push(b.t === 'math' ? texToPlain(b.tex) : b.text);
    else if (b.t === 'quote') out.push(...plainBlocks(b.c));
    else if (b.t === 'list') b.items.forEach((it, k) => out.push(`${b.ordered ? `${b.start + k}.` : '•'} ${plainBlocks(it).join(' ')}`));
  }
  return out;
}

/** The text of some Markdown without its syntax (comment previews, toasts, accessibility labels). */
export function markdownToPlain(src: string): string {
  return plainBlocks(parseMarkdown(src)).join('\n');
}

/** TeX commands with a one-character (or word) plain form, for previews. */
const TEX_SYMBOLS: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ',
  vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ',
  upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ',
  Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  int: '∫', iint: '∬', oint: '∮', sum: '∑', prod: '∏', infty: '∞', partial: '∂', nabla: '∇', sqrt: '√',
  cdot: '·', times: '×', div: '÷', pm: '±', mp: '∓', le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠',
  approx: '≈', equiv: '≡', sim: '∼', propto: '∝', to: '→', rightarrow: '→', leftarrow: '←', Rightarrow: '⇒',
  Leftarrow: '⇐', leftrightarrow: '↔', Leftrightarrow: '⇔', mapsto: '↦', implies: '⇒', iff: '⇔', in: '∈', notin: '∉',
  subset: '⊂', subseteq: '⊆', supset: '⊃', cup: '∪', cap: '∩', emptyset: '∅', forall: '∀', exists: '∃', neg: '¬',
  land: '∧', lor: '∨', angle: '∠', degree: '°', circ: '∘', ldots: '…', cdots: '⋯', dots: '…', prime: '′',
  langle: '⟨', rangle: '⟩', lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', mid: '|', vert: '|',
  quad: ' ', qquad: '  ', ',': ' ', ';': ' ', ':': ' ', '!': '', ' ': ' ', '{': '{', '}': '}', '%': '%', '$': '$', '#': '#', '&': '&', '_': '_',
};
const SUPERSCRIPT: Record<string, string> = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ' };
const SUBSCRIPT: Record<string, string> = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎' };

/**
 * A readable plain form of TeX for previews (comment cards, accessibility labels): `\int_0^1 x^2\,dx` → `∫₀¹ x² dx`,
 * `\frac{a}{b}` → `a/b`. Approximate by design; unknown commands lose their backslash.
 */
export function texToPlain(tex: string): string {
  let i = 0;
  /** The next argument: a {group} or one character / command. */
  const arg = (): string => {
    while (tex[i] === ' ') i++;
    if (tex[i] === '{') {
      let depth = 0;
      const start = ++i;
      for (; i < tex.length; i++) {
        if (tex[i] === '\\') i++;
        else if (tex[i] === '{') depth++;
        else if (tex[i] === '}' && depth-- === 0) break;
      }
      const inner = tex.slice(start, i);
      i++;
      return texToPlain(inner);
    }
    return item();
  };
  const script = (map: Record<string, string>, mark: string) => {
    const a = arg();
    const all = [...a].every((ch) => map[ch]);
    return all ? [...a].map((ch) => map[ch]).join('') : `${mark}${a.length > 1 ? `(${a})` : a}`;
  };
  const item = (): string => {
    const ch = tex[i];
    if (ch === undefined) return '';
    if (ch === '\\') {
      const m = /^\\([A-Za-z]+|.)/.exec(tex.slice(i));
      const name = m?.[1] ?? '';
      i += 1 + name.length;
      if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
        const a = arg();
        const b = arg();
        const wrap = (s: string) => (s.length > 1 && /[^\w.]/.test(s) ? `(${s})` : s);
        return `${wrap(a)}/${wrap(b)}`;
      }
      if (name === 'sqrt') {
        const a = arg();
        return `√${a.length > 1 ? `(${a})` : a}`;
      }
      if (/^(text|mathrm|mathbf|mathit|mathsf|mathtt|mathcal|mathbb|operatorname|boldsymbol|textbf|textit|mbox)$/.test(name)) return arg();
      if (name === 'left' || name === 'right' || name === 'big' || name === 'Big' || name === 'bigg' || name === 'Bigg') return '';
      if (name in TEX_SYMBOLS) return TEX_SYMBOLS[name]!;
      return name;
    }
    i++;
    if (ch === '^') return script(SUPERSCRIPT, '^');
    if (ch === '_') return script(SUBSCRIPT, '_');
    if (ch === '{' || ch === '}') return '';
    if (ch === '~') return ' ';
    return ch;
  };
  let out = '';
  while (i < tex.length) out += item();
  return out.replace(/\s+/g, ' ').trim();
}
