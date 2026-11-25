/**
 * Generación del DOCX profesional con la librería `docx`.
 * Estructura: portada → resumen (tabla) → índice (campo TOC, se actualiza al abrir en Word)
 * → hilo completo en orden cronológico → índice de outputs y versiones.
 */
import {
  AlignmentType, BorderStyle, Document, ExternalHyperlink, Footer, Header, HeadingLevel, ImageRun, PageBreak,
  PageNumber, Packer, Paragraph, ShadingType, Table, TableCell, TableOfContents, TableRow, TextRun, WidthType,
} from 'docx';
import { parseMarkdown } from './markdown.js';
import { IMAGE_MISSING, messageMetaLine, roleLabel } from './labels.js';
import { humanDate } from './util.js';

const FONT = 'Calibri';
const MONO = 'Consolas';
const COLORS = { primary: '1F3864', muted: '6B7280', user: '1D4ED8', assistant: '047857', hidden: 'B45309', codeBg: 'F3F4F6', border: 'D1D5DB' };
const ROLE_COLOR = { user: COLORS.user, assistant: COLORS.assistant };


function runsToDocx(runs, base = {}) {
  return runs.map((r) => {
    if (r.link && /^https?:|^mailto:/i.test(r.link)) {
      return new ExternalHyperlink({ link: r.link, children: [new TextRun({ text: r.text, style: 'Hyperlink', ...base })] });
    }
    return new TextRun({
      text: r.text,
      bold: r.bold || base.bold,
      italics: r.italic || base.italics,
      font: r.code ? MONO : base.font,
      shading: r.code ? { type: ShadingType.CLEAR, fill: COLORS.codeBg, color: 'auto' } : undefined,
      color: base.color,
      size: base.size,
    });
  });
}

function markdownParagraphs(text, base = {}) {
  const out = [];
  for (const b of parseMarkdown(text)) {
    switch (b.kind) {
      case 'heading':
        out.push(new Paragraph({ children: runsToDocx(b.runs, { bold: true, ...base }), spacing: { before: 160, after: 80 }, style: `MdH${b.level}` }));
        break;
      case 'bullet':
        out.push(new Paragraph({ children: runsToDocx(b.runs, base), bullet: { level: Math.min(b.level, 8) } }));
        break;
      case 'numbered':
        out.push(new Paragraph({ children: [new TextRun({ text: `${b.marker} `, bold: true }), ...runsToDocx(b.runs, base)], indent: { left: 360 + b.level * 360, hanging: 360 } }));
        break;
      case 'quote':
        out.push(new Paragraph({ children: runsToDocx(b.runs, { italics: true, ...base }), indent: { left: 567 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: COLORS.border, space: 8 } } }));
        break;
      case 'hr':
        out.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: COLORS.border, space: 1 } } }));
        break;
      case 'table':
        if (b.rows.length) out.push(simpleTable(b.rows, true), new Paragraph({}));
        break;
      default:
        out.push(new Paragraph({ children: runsToDocx(b.runs, base), spacing: { after: 120 } }));
    }
  }
  return out;
}

function codeParagraphs(text, label) {
  const paras = [];
  if (label) paras.push(new Paragraph({ children: [new TextRun({ text: label, font: MONO, size: 16, color: COLORS.muted })], spacing: { before: 80 } }));
  const lines = String(text).split('\n');
  lines.forEach((line, i) =>
    paras.push(
      new Paragraph({
        children: [new TextRun({ text: line.length ? line : ' ', font: MONO, size: 18 })],
        shading: { type: ShadingType.CLEAR, fill: COLORS.codeBg, color: 'auto' },
        spacing: { before: 0, after: i === lines.length - 1 ? 160 : 0, line: 260 },
        indent: { left: 170, right: 170 },
      }),
    ),
  );
  return paras;
}

function simpleTable(rows, header = false) {
  const cols = Math.max(...rows.map((r) => r.length));
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: rows.map(
      (r, ri) =>
        new TableRow({
          tableHeader: header && ri === 0,
          children: Array.from({ length: cols }, (_, ci) =>
            new TableCell({
              shading: header && ri === 0 ? { type: ShadingType.CLEAR, fill: 'E5E7EB', color: 'auto' } : undefined,
              children: [new Paragraph({ children: [new TextRun({ text: String(r[ci] ?? ''), bold: header && ri === 0, size: 18 })] })],
            }),
          ),
        }),
    ),
  });
}

/** Dimensiones de PNG/JPEG/GIF leyendo la cabecera (sin dependencias). */
export function imageSize(buf) {
  try {
    if (buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), type: 'png' };
    if (buf.toString('ascii', 0, 3) === 'GIF') return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8), type: 'gif' };
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let o = 2;
      while (o < buf.length) {
        if (buf[o] !== 0xff) return null;
        const marker = buf[o + 1];
        const len = buf.readUInt16BE(o + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { h: buf.readUInt16BE(o + 5), w: buf.readUInt16BE(o + 7), type: 'jpg' };
        }
        o += 2 + len;
      }
    }
  } catch {
    /* cabecera inválida */
  }
  return null;
}

function imageParagraph(block, assets) {
  const a = block.fileId ? assets.get(block.fileId) : null;
  const size = a ? imageSize(a.buffer) : null;
  if (!a || !size) return new Paragraph({ children: [new TextRun({ text: IMAGE_MISSING(block), italics: true, color: COLORS.muted })] });
  const maxW = 450;
  const scale = Math.min(1, maxW / size.w);
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new ImageRun({ type: size.type, data: a.buffer, transformation: { width: Math.round(size.w * scale), height: Math.round(size.h * scale) } })],
  });
}

function messageBlocks(m, assets) {
  const out = [];
  const color = m.hidden ? COLORS.hidden : ROLE_COLOR[m.role] ?? COLORS.primary;
  out.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_3,
      keepNext: true,
      spacing: { before: 240, after: 40 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 4, color, space: 2 } },
      children: [new TextRun({ text: roleLabel(m), color, bold: true })],
    }),
    new Paragraph({ keepNext: true, spacing: { after: 100 }, children: [new TextRun({ text: messageMetaLine(m), size: 16, color: COLORS.muted })] }),
  );
  for (const b of m.blocks) {
    switch (b.type) {
      case 'text':
        out.push(...markdownParagraphs(b.text));
        break;
      case 'code':
        out.push(...codeParagraphs(b.text, b.executionOutput ? 'Resultado de ejecución' : b.language || 'código'));
        break;
      case 'image':
        out.push(imageParagraph(b, assets));
        break;
      case 'quote':
        out.push(new Paragraph({ children: [new TextRun({ text: `${b.title} ${b.url ? `(${b.url})` : ''}`.trim(), bold: true, size: 18 })] }), ...markdownParagraphs(b.text, { italics: true }));
        break;
      case 'thoughts':
        for (const t of b.items) {
          out.push(new Paragraph({ children: [new TextRun({ text: t.summary || 'Pensamiento', bold: true, italics: true, color: COLORS.hidden })] }), ...markdownParagraphs(t.content, { italics: true }));
        }
        break;
      case 'json':
        out.push(...codeParagraphs(b.text, `contenido ${b.label} (JSON original)`));
        break;
      default:
        out.push(new Paragraph({ children: [new TextRun({ text: b.text ?? '', italics: true, color: COLORS.muted })] }));
    }
  }
  if (m.attachments.length) {
    out.push(new Paragraph({ children: [new TextRun({ text: 'Adjuntos: ', bold: true, size: 18 }), new TextRun({ text: m.attachments.map((a) => a.name ?? a.fileId).join(', '), size: 18 })] }));
  }
  return out;
}

/**
 * @param {{conversations: Array<{conv: any, outputs: any[]}>, assets: Map<string, {buffer: Buffer, mime: string}>,
 *          meta: {exportId: string, generatedAt: string, projectName?: string, title: string}}} input
 * @returns {Promise<Buffer>}
 */
export async function buildDocx({ conversations, assets, meta }) {
  const children = [];
  const totalMsgs = conversations.reduce((s, c) => s + c.conv.messages.length, 0);
  const totalOutputs = conversations.reduce((s, c) => s + c.outputs.length, 0);

  // Portada
  children.push(
    new Paragraph({ spacing: { before: 2400 } }),
    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: meta.title, bold: true, size: 48, color: COLORS.primary })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 200 }, children: [new TextRun({ text: meta.projectName ? `Proyecto: ${meta.projectName}` : 'Exportación de conversación de ChatGPT', size: 26, color: COLORS.muted })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 600 }, children: [new TextRun({ text: `Generado: ${humanDate(meta.generatedAt)} · ID exportación: ${meta.exportId}`, size: 18, color: COLORS.muted })] }),
    new Paragraph({ children: [new PageBreak()] }),
  );

  // Resumen
  children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('Resumen')] }));
  const rows = [['Conversación', 'Creada', 'Mensajes', 'Ocultos', 'Ramas alt.', 'Outputs']];
  for (const { conv, outputs } of conversations) {
    rows.push([conv.title, humanDate(conv.createTime), String(conv.stats.messages), String(conv.stats.hidden), String(conv.stats.alternativeBranchMessages), String(outputs.length)]);
  }
  rows.push(['TOTAL', '', String(totalMsgs), '', '', String(totalOutputs)]);
  children.push(simpleTable(rows, true));
  children.push(
    new Paragraph({
      spacing: { before: 200 },
      children: [new TextRun({ text: 'Se incluyen todos los mensajes del árbol de la conversación —incluidos sistema, herramientas, contenido oculto y ramas alternativas (regeneraciones/ediciones)— en orden cronológico. Los mensajes ocultos y de ramas alternativas están marcados en su cabecera.', size: 18, color: COLORS.muted, italics: true })],
    }),
    new TableOfContents('Índice', { hyperlink: true, headingStyleRange: '1-2' }),
    new Paragraph({ children: [new PageBreak()] }),
  );

  // Hilo
  conversations.forEach(({ conv, outputs }, ci) => {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: ci > 0, children: [new TextRun(conversations.length > 1 ? `${ci + 1}. ${conv.title}` : conv.title)] }));
    children.push(new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: `ID ${conv.id} · creada ${humanDate(conv.createTime)} · actualizada ${humanDate(conv.updateTime)}${conv.model ? ` · modelo ${conv.model}` : ''}`, size: 18, color: COLORS.muted })] }));
    for (const m of conv.messages) children.push(...messageBlocks(m, assets));

    if (outputs.length) {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, pageBreakBefore: true, children: [new TextRun('Outputs detectados y versiones')] }));
      const orows = [['#', 'Output', 'Tipo', 'Versión', 'Mensaje', 'Fecha', 'Rama']];
      for (const o of outputs) for (const v of o.versions) orows.push([String(o.index), o.folder, o.kind, v.fileStem, `#${v.messageSeq}`, humanDate(v.createTime), v.onCurrentPath ? 'principal' : 'alternativa']);
      children.push(simpleTable(orows, true));
    }
  });

  const doc = new Document({
    creator: 'chatgpt-export skill',
    title: meta.title,
    description: `Exportación ${meta.exportId}`,
    features: { updateFields: true },
    styles: {
      default: { document: { run: { font: FONT, size: 21 } } },
      paragraphStyles: [1, 2, 3, 4].map((l) => ({ id: `MdH${l}`, name: `Markdown H${l}`, basedOn: 'Normal', run: { bold: true, size: [28, 25, 23, 21][l - 1], color: COLORS.primary } })),
    },
    sections: [
      {
        properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
        headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: meta.title, size: 16, color: COLORS.muted })] })] }) },
        footers: {
          default: new Footer({
            children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: ['Página ', PageNumber.CURRENT, ' de ', PageNumber.TOTAL_PAGES], size: 16, color: COLORS.muted })] })],
          }),
        },
        children,
      },
    ],
  });
  return Packer.toBuffer(doc);
}
