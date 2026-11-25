/**
 * Conversor mínimo de markdown (subset usado por ChatGPT) a una estructura neutra que
 * consumen los generadores DOCX y PDF. Los bloques de código ya vienen separados por el parser.
 */

/** Divide una línea en runs con **negrita**, *cursiva* o _cursiva_, `código` y [texto](url). */
export function parseInline(text) {
  const runs = [];
  const re = /(\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\*([^*\s][^*]*)\*|(?<![A-Za-z0-9])_([^_\s][^_]*)_(?![A-Za-z0-9])|\[([^\]]+)\]\(([^)\s]+)\))/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index) });
    if (m[2] ?? m[3]) runs.push({ text: m[2] ?? m[3], bold: true });
    else if (m[4]) runs.push({ text: m[4], code: true });
    else if (m[5] ?? m[6]) runs.push({ text: m[5] ?? m[6], italic: true });
    else if (m[7]) runs.push({ text: m[7], link: m[8] });
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs.length ? runs : [{ text: '' }];
}

export const plain = (runs) => runs.map((r) => (r.link ? `${r.text} (${r.link})` : r.text)).join('');

/**
 * @returns {Array<{kind: 'heading'|'bullet'|'numbered'|'para'|'quote'|'hr'|'table', level?: number,
 *          marker?: string, runs?: any[], rows?: string[][]}>}
 */
export function parseMarkdown(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) out.push({ kind: 'para', runs: parseInline(para.join(' ')) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t) {
      flush();
      continue;
    }
    let m;
    if ((m = t.match(/^(#{1,6})\s+(.*)$/))) {
      flush();
      out.push({ kind: 'heading', level: Math.min(m[1].length, 4), runs: parseInline(m[2]) });
    } else if (/^([-*_])\1{2,}$/.test(t)) {
      flush();
      out.push({ kind: 'hr' });
    } else if ((m = line.match(/^(\s*)[-*+]\s+(.*)$/))) {
      flush();
      out.push({ kind: 'bullet', level: Math.floor(m[1].length / 2), runs: parseInline(m[2]) });
    } else if ((m = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/))) {
      flush();
      out.push({ kind: 'numbered', level: Math.floor(m[1].length / 2), marker: `${m[2]}.`, runs: parseInline(m[3]) });
    } else if (t.startsWith('>')) {
      flush();
      out.push({ kind: 'quote', runs: parseInline(t.replace(/^>\s?/, '')) });
    } else if (t.startsWith('|') && t.endsWith('|')) {
      flush();
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const cells = lines[i].trim().slice(1, -1).split('|').map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      i--;
      out.push({ kind: 'table', rows });
    } else {
      para.push(t);
    }
  }
  flush();
  return out;
}
