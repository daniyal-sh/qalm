/** Greedy word wrap of a text box into rows no wider than `maxWidth`. Explicit newlines are kept. */
export function wrapText(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const rows: string[] = [];
  for (const para of text.split('\n')) {
    let row = '';
    for (const word of para.split(' ')) {
      const next = row ? `${row} ${word}` : word;
      if (row && measure(next) > maxWidth) {
        rows.push(row);
        row = word;
      } else row = next;
    }
    rows.push(row);
  }
  return rows;
}

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
