/**
 * Descarga de conversaciones, proyectos y adjuntos.
 * Endpoints y paginación replicados de chatgpt-exporter (npm, MIT) — ver references/chatgpt-backend-api.md.
 */
import { ENDPOINTS } from './client.js';
import { NotFoundError, UpstreamError } from './errors.js';
import { safeFileName, sleep } from './util.js';

/** Conversación completa (incluye `mapping` con TODOS los nodos y ramas). */
export async function fetchConversation(client, id) {
  const detail = await client.json(ENDPOINTS.CONVERSATION(id));
  if (!detail || typeof detail !== 'object' || !detail.mapping || typeof detail.mapping !== 'object') {
    throw new UpstreamError(`La conversación ${id} no contiene "mapping" (formato inesperado).`);
  }
  detail.id ??= detail.conversation_id ?? id;
  return detail;
}

/** Lista todos los proyectos ("snorlax" sidebar) paginando por cursor. */
export async function listProjects(client, { delayMs = 0 } = {}) {
  const out = [];
  let cursor = null;
  let guard = 0;
  do {
    const url = cursor ? `${ENDPOINTS.PROJECTS_SIDEBAR}?cursor=${encodeURIComponent(cursor)}` : ENDPOINTS.PROJECTS_SIDEBAR;
    const res = await client.json(url);
    for (const item of res?.items ?? []) if (item?.gizmo?.id) out.push(item.gizmo);
    cursor = res?.cursor ?? null;
    if (cursor && delayMs) await sleep(delayMs);
  } while (cursor && ++guard < 500);
  return out;
}

/** Resuelve un proyecto por ID (g-p-…) o por nombre exacto (insensible a mayúsculas). */
export async function resolveProject(client, { projectId, projectName }) {
  const projects = await listProjects(client);
  const match = projects.find(
    (g) =>
      (projectId && (g.id === projectId || g.id.startsWith(projectId))) ||
      (projectName && g.display?.name?.toLowerCase() === projectName.toLowerCase()),
  );
  if (!match) {
    if (projectId) {
      // Puede ser un proyecto archivado que no aparece en la barra lateral: se intenta igualmente.
      return { id: projectId, name: projectId, unresolved: true };
    }
    throw new NotFoundError(`Proyecto "${projectName}" no encontrado. Disponibles: ${projects.map((g) => g.display?.name).join(', ')}`);
  }
  return { id: match.id, name: match.display?.name ?? match.id, raw: match };
}

/** Lista TODAS las conversaciones de un proyecto (paginación por cursor, empezando en "0"). */
export async function listProjectConversations(client, gizmoId, { delayMs = 0 } = {}) {
  const out = [];
  let cursor = '0';
  let guard = 0;
  while (cursor !== null && cursor !== undefined && guard++ < 1000) {
    const res = await client.json(`${ENDPOINTS.PROJECT_CONVERSATIONS(gizmoId)}?cursor=${encodeURIComponent(cursor)}`);
    out.push(...(res?.items ?? []));
    cursor = res?.cursor ?? null;
    if (cursor && delayMs) await sleep(delayMs);
  }
  return out;
}

const MIME_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf',
  'text/plain': 'txt', 'text/csv': 'csv', 'application/json': 'json', 'application/zip': 'zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

function nameFromDisposition(cd) {
  const m = /filename\*=UTF-8''([^;]+)|filename="?([^";]+)"?/i.exec(cd || '');
  if (!m) return null;
  try {
    return decodeURIComponent(m[1] ?? m[2]);
  } catch {
    return m[1] ?? m[2];
  }
}

/**
 * Descarga un archivo del almacén de ChatGPT (file-service / attachments).
 * @returns {Promise<{fileId: string, fileName: string, mime: string, buffer: Buffer}>}
 */
export async function downloadFile(client, fileId, hintName) {
  const meta = await client.json(ENDPOINTS.FILE_DOWNLOAD(fileId));
  if (!meta?.download_url) {
    throw new NotFoundError(`Archivo ${fileId} no disponible (sin download_url; puede haber expirado).`, {
      details: { fileId, status: meta?.status },
    });
  }
  const { buffer, contentType, contentDisposition } = await client.raw(meta.download_url);
  const mime = contentType.split(';')[0].trim();
  let fileName = meta.file_name || hintName || nameFromDisposition(contentDisposition) || fileId;
  if (!/\.[A-Za-z0-9]{1,8}$/.test(fileName) && MIME_EXT[mime]) fileName += `.${MIME_EXT[mime]}`;
  return { fileId, fileName: safeFileName(fileName, fileId), mime, buffer };
}

/**
 * Descarga "best effort" de un archivo del sandbox del intérprete de código.
 * Endpoint NO VERIFICADO; cualquier fallo se registra como adjunto no recuperado.
 */
export async function downloadSandboxFile(client, conversationId, messageId, sandboxPath) {
  const meta = await client.json(ENDPOINTS.INTERPRETER_DOWNLOAD(conversationId, messageId, sandboxPath));
  if (!meta?.download_url) throw new NotFoundError(`Archivo de sandbox no disponible: ${sandboxPath}`);
  const { buffer, contentType } = await client.raw(meta.download_url);
  return {
    fileId: `sandbox:${sandboxPath}`,
    fileName: safeFileName(sandboxPath.split('/').pop() || 'archivo'),
    mime: contentType.split(';')[0].trim(),
    buffer,
  };
}
