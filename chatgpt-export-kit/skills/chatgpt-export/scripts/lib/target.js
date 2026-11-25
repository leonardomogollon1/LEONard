/**
 * Interpreta el link o ID recibido.
 *
 * Formatos admitidos (observados en la web de ChatGPT; no hay especificación oficial):
 *   https://chatgpt.com/c/<uuid>                              → conversación
 *   https://chatgpt.com/g/g-p-<id>-<slug>/c/<uuid>            → conversación dentro de un proyecto
 *   https://chatgpt.com/g/g-p-<id>-<slug>/project             → proyecto
 *   https://chat.openai.com/c/<uuid>                          → conversación (dominio antiguo)
 *   <uuid>                                                    → conversación
 *   g-p-<id>                                                  → proyecto
 *   project:<nombre exacto>                                   → proyecto por nombre
 * No admitido: enlaces públicos /share/<id> (no pertenecen al backend autenticado del usuario).
 */
import { InputError } from './errors.js';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
// Los IDs de proyecto observados son "g-p-" + 32 hex; se admite un formato más laxo como respaldo.
const PROJECT_STRICT = /g-p-[0-9a-f]{32}/i;
const PROJECT_LAX = /g-p-[A-Za-z0-9]+/;

/**
 * @param {string} input
 * @param {'auto'|'conversation'|'project'} [expect]
 * @returns {{kind: 'conversation'|'project', id?: string, projectId?: string, projectName?: string, source: string}}
 */
export function parseTarget(input, expect = 'auto') {
  const raw = String(input ?? '').trim();
  if (!raw) throw new InputError('Debes indicar un link o ID de conversación/proyecto.');

  if (/^project:/i.test(raw)) {
    const name = raw.slice('project:'.length).trim();
    if (!name) throw new InputError('Nombre de proyecto vacío.');
    return finalize({ kind: 'project', projectName: name, source: raw }, expect);
  }

  let path = raw;
  if (/^https?:\/\//i.test(raw)) {
    let u;
    try {
      u = new URL(raw);
    } catch {
      throw new InputError(`URL no válida: ${raw}`);
    }
    if (!/(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/i.test(u.hostname)) {
      throw new InputError(`El dominio ${u.hostname} no es de ChatGPT.`);
    }
    if (u.pathname.startsWith('/share/')) {
      throw new InputError('Los enlaces públicos /share/ no se admiten: abre la conversación original y usa su URL /c/<id>.');
    }
    path = u.pathname;
  }

  const projectMatch = path.match(PROJECT_STRICT) ?? path.match(PROJECT_LAX);
  const convMatch = path.match(new RegExp(`/c/(${UUID.source})`, 'i')) ?? (UUID.test(path) && !projectMatch ? path.match(UUID) : null);

  if (convMatch) {
    const id = (convMatch[1] ?? convMatch[0]).toLowerCase();
    return finalize({ kind: 'conversation', id, projectId: projectMatch?.[0], source: raw }, expect);
  }
  if (projectMatch) {
    return finalize({ kind: 'project', projectId: projectMatch[0], source: raw }, expect);
  }
  if (expect === 'project') return { kind: 'project', projectName: raw, source: raw };
  throw new InputError(`No se reconoce el link/ID: "${raw}". Usa una URL /c/<uuid>, un UUID, un ID g-p-… o project:<nombre>.`);
}

function finalize(t, expect) {
  if (expect === 'conversation' && t.kind !== 'conversation') {
    throw new InputError('Se esperaba una conversación y se recibió un proyecto. Usa export_project.');
  }
  if (expect === 'project' && t.kind === 'conversation') {
    if (t.projectId) return { kind: 'project', projectId: t.projectId, source: t.source };
    throw new InputError('Se esperaba un proyecto y se recibió una conversación suelta. Usa export_conversation.');
  }
  return t;
}
