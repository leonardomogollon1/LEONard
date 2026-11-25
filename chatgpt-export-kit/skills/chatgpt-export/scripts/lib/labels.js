/** Etiquetas y textos comunes a DOCX y PDF. */
import { humanDate } from './util.js';

export const ROLE_LABEL = {
  user: 'Usuario',
  assistant: 'Asistente',
  system: 'Sistema',
  tool: 'Herramienta',
  critic: 'Crítico',
  desconocido: 'Desconocido',
};

export function roleLabel(m) {
  const base = ROLE_LABEL[m.role] ?? m.role;
  return m.authorName ? `${base} · ${m.authorName}` : base;
}

/** Línea de metadatos de un mensaje (trazabilidad). */
export function messageMetaLine(m) {
  const parts = [`#${m.seq}`, humanDate(m.createTime ?? m.effectiveTime)];
  if (m.timeInferred) parts.push('fecha inferida');
  if (m.modelSlug) parts.push(`modelo ${m.modelSlug}`);
  if (m.contentType && m.contentType !== 'text') parts.push(m.contentType);
  if (m.recipient && m.recipient !== 'all') parts.push(`→ ${m.recipient}`);
  if (m.siblingCount > 1) parts.push(`versión ${m.siblingIndex}/${m.siblingCount}`);
  if (!m.onCurrentPath) parts.push('rama alternativa');
  if (m.hidden) parts.push(`OCULTO: ${m.hiddenReason}`);
  parts.push(`id ${m.messageId}`);
  return parts.join(' · ');
}

export const IMAGE_MISSING = (b) => `[Imagen no incrustada: ${b.fileId ?? b.pointer ?? 'sin referencia'}]`;
