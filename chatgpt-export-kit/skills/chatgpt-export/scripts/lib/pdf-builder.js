/**
 * Generación del PDF profesional con `pretext-pdf` (JSON declarativo → PDF, sin Chromium).
 *
 * Requisitos verificados con pretext-pdf 2.2.6 (ver references/dependencies.md):
 *  - `@napi-rs/canvas` es obligatorio en Node (si falta: error CANVAS_UNAVAILABLE).
 *  - `@cantoo/pdf-lib` debe fijarse a 2.7.4: con ≥ 2.8 el subsetting de fuentes falla
 *    ("Cannot read properties of undefined (reading 'pos')"). Se fija con "overrides".
 *  - El código se compone con DejaVu Sans Mono (assets/fonts), una línea por párrafo.
 *  - Los emoji no tienen glifo en las fuentes embebidas: se sustituyen por [U+XXXX] (el DOCX los conserva).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMarkdown, plain } from './markdown.js';
import { IMAGE_MISSING, messageMetaLine, roleLabel } from './labels.js';
import { imageSize } from './docx-builder.js';
import { humanDate } from './util.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.resolve(HERE, '../../assets/fonts');
const MONO = 'DejaVu Sans Mono';
const C = { primary: '#1F3864', muted: '#6B7280', user: '#1D4ED8', assistant: '#047857', hidden: '#B45309', codeBg: '#F3F4F6', border: '#D1D5DB' };
const ROLE_COLOR = { user: C.user, assistant: C.assistant };

async function loadFonts() {
  const [regular, bold] = await Promise.all([
    fs.readFile(path.join(FONT_DIR, 'DejaVuSansMono.ttf')),
    fs.readFile(path.join(FONT_DIR, 'DejaVuSansMono-Bold.ttf')),
  ]);
  return [
    { family: MONO, weight: 400, src: new Uint8Array(regular) },
    { family: MONO, weight: 700, src: new Uint8Array(bold) },
  ];
}

const spans = (runs, base = {}) =>
  runs
    .filter((r) => r.text)
    .map((r) => ({
      text: r.text,
      ...(r.bold || base.bold ? { fontWeight: 700 } : {}),
      ...(r.italic || base.italic ? { fontStyle: 'italic' } : {}),
      ...(r.code ? { fontFamily: MONO, color: '#374151' } : {}),
      ...(r.link && /^https?:/i.test(r.link) ? { url: r.link, color: C.user, underline: true } : {}),
      ...(base.color && !r.link ? { color: base.color } : {}),
    }));

function richOrPlain(runs, base = {}, extra = {}) {
  const s = spans(runs, base);
  if (!s.length) return null;
  return { type: 'rich-paragraph', spans: s, spaceAfter: 6, ...extra };
}

function markdownElements(text, base = {}) {
  const out = [];
  for (const b of parseMarkdown(text)) {
    switch (b.kind) {
      case 'heading':
        out.push({ type: 'paragraph', text: plain(b.runs), fontWeight: 700, fontSize: [15, 13.5, 12.5, 11.5][b.level - 1], color: C.primary, spaceBefore: 6, spaceAfter: 4 });
        break;
      case 'bullet':
      case 'numbered': {
        const marker = b.kind === 'bullet' ? '•' : b.marker;
        const el = richOrPlain([{ text: `${'    '.repeat(b.level)}${marker} ` }, ...b.runs], base, { spaceAfter: 2 });
        if (el) out.push(el);
        break;
      }
      case 'quote':
        out.push({ type: 'blockquote', text: plain(b.runs), borderColor: C.border, bgColor: '#FAFAFA', fontSize: 10 });
        break;
      case 'hr':
        out.push({ type: 'hr', color: C.border, spaceBefore: 4, spaceAfter: 4 });
        break;
      case 'table':
        if (b.rows.length) out.push(tableEl(b.rows));
        break;
      default: {
        const el = richOrPlain(b.runs, base);
        if (el) out.push(el);
      }
    }
  }
  return out;
}

function tableEl(rows, opts = {}) {
  const cols = Math.max(...rows.map((r) => r.length));
  return {
    type: 'table',
    columns: Array.from({ length: cols }, (_, i) => ({ width: opts.widths?.[i] ?? '1*' })),
    rows: rows.map((r, ri) => ({
      ...(ri === 0 ? { isHeader: true } : {}),
      cells: Array.from({ length: cols }, (_, ci) => ({ text: String(r[ci] ?? ''), ...(ri === 0 ? { fontWeight: 700 } : {}) })),
    })),
    headerRows: 1,
    headerBgColor: '#E5E7EB',
    borderColor: C.border,
    fontSize: 8.5,
    spaceAfter: 10,
  };
}

/**
 * Bloque de código. pretext-pdf 2.2.6 colapsa los saltos de línea dentro de `type: 'code'`
 * (verificado; contradice su tipado), por lo que se emite un párrafo monoespaciado por línea,
 * con la indentación convertida a espacios duros (U+00A0) y fondo continuo.
 */
function codeElements(text, label) {
  const out = [];
  if (label) out.push({ type: 'paragraph', text: label, fontFamily: MONO, fontSize: 7.5, color: C.muted, spaceAfter: 1 });
  const lines = String(text).replace(/\t/g, '    ').replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines.at(-1) === '') lines.pop();
  lines.forEach((line, i) =>
    out.push({
      type: 'paragraph',
      text: line.replace(/^ +/, (sp) => '\u00A0'.repeat(sp.length)).replace(/ {2,}/g, (sp) => ' ' + '\u00A0'.repeat(sp.length - 1)) || '\u00A0',
      fontFamily: MONO,
      fontSize: 8,
      lineHeight: 11,
      bgColor: C.codeBg,
      spaceAfter: i === lines.length - 1 ? 8 : 0,
    }),
  );
  return out;
}

/** Sustituye pictogramas/emoji (sin glifo en las fuentes embebidas) por su código U+XXXX. */
const PICTO = /\p{Extended_Pictographic}\uFE0F?/gu;
export function pdfSafe(value) {
  if (typeof value === 'string') return value.replace(PICTO, (c) => `[U+${c.codePointAt(0).toString(16).toUpperCase()}]`).replace(/[\u200D\uFE0F]/g, '');
  if (Array.isArray(value)) return value.map(pdfSafe);
  if (value && typeof value === 'object' && !(value instanceof Uint8Array)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, pdfSafe(v)]));
  }
  return value;
}

function imageEl(block, assets) {
  const a = block.fileId ? assets.get(block.fileId) : null;
  const size = a ? imageSize(a.buffer) : null;
  if (!a || !size || !['png', 'jpg'].includes(size.type)) {
    return { type: 'paragraph', text: IMAGE_MISSING(block), color: C.muted, fontSize: 9 };
  }
  const maxW = 380;
  const maxH = 480;
  const scale = Math.min(1, maxW / size.w, maxH / size.h);
  return { type: 'image', src: new Uint8Array(a.buffer), format: size.type, width: Math.round(size.w * scale), height: Math.round(size.h * scale), align: 'center' };
}

function messageElements(m, assets) {
  const color = m.hidden ? C.hidden : ROLE_COLOR[m.role] ?? C.primary;
  const out = [
    { type: 'heading', level: 3, text: roleLabel(m), color, fontSize: 11.5, spaceBefore: 10, spaceAfter: 1, keepTogether: true },
    { type: 'paragraph', text: messageMetaLine(m), fontSize: 7, color: C.muted, spaceAfter: 5 },
  ];
  for (const b of m.blocks) {
    switch (b.type) {
      case 'text':
        out.push(...markdownElements(b.text, m.hidden ? { color: '#4B5563' } : {}));
        break;
      case 'code':
        out.push(...codeElements(b.text, b.executionOutput ? 'Resultado de ejecución' : b.language || 'código'));
        break;
      case 'image':
        out.push(imageEl(b, assets));
        break;
      case 'quote':
        out.push({ type: 'blockquote', text: `${b.title}${b.url ? ` (${b.url})` : ''}\n${b.text}`, borderColor: C.border, fontSize: 9.5 });
        break;
      case 'thoughts':
        for (const t of b.items) out.push({ type: 'callout', style: 'note', title: t.summary || 'Pensamiento', content: t.content || ' ', fontSize: 9 });
        break;
      case 'json':
        out.push(...codeElements(b.text, `contenido ${b.label} (JSON original)`));
        break;
      default:
        out.push({ type: 'paragraph', text: b.text || ' ', color: C.muted, fontSize: 9 });
    }
  }
  if (m.attachments.length) {
    out.push({ type: 'paragraph', text: `Adjuntos: ${m.attachments.map((a) => a.name ?? a.fileId).join(', ')}`, fontSize: 8.5, color: C.muted });
  }
  return out;
}

/**
 * Misma entrada que buildDocx.
 * @returns {Promise<Buffer>}
 */
export async function buildPdf({ conversations, assets, meta, onWarning }) {
  const { render } = await import('pretext-pdf');
  const content = [];
  const totalMsgs = conversations.reduce((s, c) => s + c.conv.messages.length, 0);
  const totalOutputs = conversations.reduce((s, c) => s + c.outputs.length, 0);

  content.push(
    { type: 'spacer', height: 160 },
    { type: 'heading', level: 1, text: meta.title, align: 'center', color: C.primary, fontSize: 24 },
    { type: 'paragraph', text: meta.projectName ? `Proyecto: ${meta.projectName}` : 'Exportación de conversación de ChatGPT', align: 'center', color: C.muted, fontSize: 13, spaceBefore: 8 },
    { type: 'paragraph', text: `Generado: ${humanDate(meta.generatedAt)} · ID exportación: ${meta.exportId}`, align: 'center', color: C.muted, fontSize: 9, spaceBefore: 40 },
    { type: 'page-break' },
    { type: 'heading', level: 1, text: 'Resumen', color: C.primary },
  );
  const rows = [['Conversación', 'Creada', 'Mensajes', 'Ocultos', 'Ramas alt.', 'Outputs']];
  for (const { conv, outputs } of conversations) {
    rows.push([conv.title, humanDate(conv.createTime), String(conv.stats.messages), String(conv.stats.hidden), String(conv.stats.alternativeBranchMessages), String(outputs.length)]);
  }
  rows.push(['TOTAL', '', String(totalMsgs), '', '', String(totalOutputs)]);
  content.push(
    tableEl(rows, { widths: ['3*', '2*', '1*', '1*', '1*', '1*'] }),
    {
      type: 'callout',
      style: 'info',
      title: 'Alcance',
      content: 'Incluye todos los mensajes del árbol de la conversación (sistema, herramientas, contenido oculto y ramas alternativas) en orden cronológico. Los ocultos y alternativos se marcan en la línea de metadatos de cada mensaje.',
      fontSize: 9,
    },
    { type: 'toc', title: 'Índice', minLevel: 1, maxLevel: 2, fontSize: 10 },
    { type: 'page-break' },
  );

  conversations.forEach(({ conv, outputs }, ci) => {
    if (ci > 0) content.push({ type: 'page-break' });
    content.push(
      { type: 'heading', level: 1, text: conversations.length > 1 ? `${ci + 1}. ${conv.title}` : conv.title, color: C.primary },
      { type: 'paragraph', text: `ID ${conv.id} · creada ${humanDate(conv.createTime)} · actualizada ${humanDate(conv.updateTime)}${conv.model ? ` · modelo ${conv.model}` : ''}`, fontSize: 8, color: C.muted, spaceAfter: 10 },
    );
    for (const m of conv.messages) content.push(...messageElements(m, assets));
    if (outputs.length) {
      content.push({ type: 'page-break' }, { type: 'heading', level: 2, text: 'Outputs detectados y versiones', color: C.primary });
      const orows = [['#', 'Output', 'Tipo', 'Versión', 'Mensaje', 'Fecha', 'Rama']];
      for (const o of outputs) for (const v of o.versions) orows.push([String(o.index), o.folder, o.kind, v.fileStem, `#${v.messageSeq}`, humanDate(v.createTime), v.onCurrentPath ? 'principal' : 'alternativa']);
      content.push(tableEl(orows, { widths: ['0.5*', '3*', '1*', '2*', '1*', '2*', '1.2*'] }));
    }
  });

  const pdf = await render({
    pageSize: 'A4',
    margins: { top: 56, bottom: 56, left: 56, right: 56 },
    defaultFontSize: 10,
    fonts: await loadFonts(),
    metadata: { title: meta.title, author: 'chatgpt-export skill', subject: `Exportación ${meta.exportId}`, language: 'es' },
    bookmarks: { minLevel: 1, maxLevel: 2 },
    header: { text: meta.title, align: 'right', fontSize: 7.5, color: C.muted },
    footer: { text: 'Página {{pageNumber}} de {{totalPages}}', align: 'center', fontSize: 7.5, color: C.muted },
    content: pdfSafe(content),
  }, {
    // Las advertencias (imágenes rotas, fuentes, etc.) se reenvían al llamante para registrarlas en
    // resumen.json; solo se filtra el aviso de deprecación conocido de `callout.content` (v2.x).
    logger: { warn: (msg) => (/DEPRECATION: callout/.test(String(msg)) ? undefined : onWarning?.(String(msg))) },
  });
  return Buffer.from(pdf);
}
