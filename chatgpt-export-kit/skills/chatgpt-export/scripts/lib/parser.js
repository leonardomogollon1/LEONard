/**
 * Parser del JSON de conversación de ChatGPT (`/backend-api/conversation/{id}`).
 *
 * Garantías:
 *  - Se procesan TODOS los nodos de `mapping` que contienen mensaje, incluidos mensajes de
 *    sistema, herramientas, contexto oculto (`is_visually_hidden_from_conversation`),
 *    razonamiento y ramas alternativas (regeneraciones y ediciones). Nada se descarta.
 *  - Orden cronológico por `create_time`; los nodos sin fecha heredan la del nodo previo en
 *    recorrido DFS y el empate se resuelve por posición DFS (estable y determinista).
 *  - Las ramas se etiquetan: `onCurrentPath` (la rama visible en la UI) y, cuando un nodo
 *    padre tiene varios hijos, `versionGroup` + `siblingIndex/siblingCount`.
 *  - Los tipos de contenido desconocidos se conservan serializados en JSON (bloque `json`).
 */
import { cleanText, toEpoch, toIso } from './util.js';

const FILE_SERVICE = /^(?:file-service|sediment):\/\//;

/** Divide markdown en segmentos de texto y bloques de código delimitados por ``` o ~~~. */
export function splitFences(text) {
  const src = String(text ?? '');
  const segs = [];
  const re = /(^|\n)(```|~~~)[ \t]*([^\n`]*)\n([\s\S]*?)\n?\2[ \t]*(?=\n|$)/g;
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[1].length;
    if (start > last) segs.push({ type: 'text', text: src.slice(last, start) });
    const info = m[3].trim();
    const [language = '', ...rest] = info.split(/\s+/);
    segs.push({ type: 'code', language: language.toLowerCase(), info, filenameHint: rest.join(' ') || null, text: m[4] });
    last = m.index + m[0].length;
  }
  if (last < src.length) segs.push({ type: 'text', text: src.slice(last) });
  return segs.filter((s) => s.type === 'code' || s.text.trim() !== '');
}

function textToBlocks(text) {
  return splitFences(cleanText(text)).map((s) => (s.type === 'text' ? { type: 'text', text: s.text.trim() } : s));
}

function pretty(v) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** Convierte `message.content` en bloques normalizados. */
export function contentToBlocks(content) {
  if (!content) return [];
  const ct = content.content_type;
  const blocks = [];
  const pushParts = (parts) => {
    for (const p of parts ?? []) {
      if (typeof p === 'string') {
        if (p.trim()) blocks.push(...textToBlocks(p));
      } else if (p && typeof p === 'object') {
        if (p.content_type === 'image_asset_pointer') {
          const pointer = p.asset_pointer ?? '';
          blocks.push({
            type: 'image',
            pointer,
            fileId: FILE_SERVICE.test(pointer) ? pointer.replace(FILE_SERVICE, '') : null,
            width: p.width ?? null,
            height: p.height ?? null,
            generation: p.metadata?.dalle ?? p.metadata?.generation ?? null,
          });
        } else if (p.content_type === 'audio_transcription') {
          blocks.push({ type: 'text', text: `[Audio] Transcripción: ${cleanText(p.text ?? '')}`, audio: true });
        } else if (typeof p.text === 'string') {
          blocks.push(...textToBlocks(p.text));
        } else {
          blocks.push({ type: 'json', label: p.content_type ?? 'parte', text: pretty(p) });
        }
      }
    }
  };

  switch (ct) {
    case 'text':
    case 'multimodal_text':
      pushParts(content.parts);
      break;
    case 'code':
      blocks.push({ type: 'code', language: (content.language ?? '').toLowerCase().replace('unknown', ''), text: cleanText(content.text ?? '') });
      break;
    case 'execution_output':
      blocks.push({ type: 'code', language: 'output', text: cleanText(content.text ?? ''), executionOutput: true });
      break;
    case 'tether_quote':
      blocks.push({ type: 'quote', title: content.title ?? '', url: content.url ?? '', text: cleanText(content.text ?? '') });
      break;
    case 'tether_browsing_display':
      if (content.result || content.summary) blocks.push({ type: 'text', text: cleanText(content.summary || content.result) });
      break;
    case 'system_error':
      blocks.push({ type: 'text', text: `[!] Error del sistema (${content.name ?? 'desconocido'}): ${cleanText(content.text ?? '')}` });
      break;
    case 'thoughts':
      blocks.push({
        type: 'thoughts',
        items: (content.thoughts ?? []).map((t) => ({ summary: cleanText(t.summary ?? ''), content: cleanText(t.content ?? '') })),
      });
      break;
    case 'reasoning_recap':
      blocks.push({ type: 'text', text: cleanText(content.content ?? '') });
      break;
    case 'user_editable_context':
      if (content.user_profile) blocks.push({ type: 'text', text: `Perfil del usuario:\n${cleanText(content.user_profile)}` });
      if (content.user_instructions) blocks.push({ type: 'text', text: `Instrucciones del usuario:\n${cleanText(content.user_instructions)}` });
      break;
    case 'model_editable_context':
      blocks.push({ type: 'text', text: `Memoria del modelo:\n${cleanText(content.model_set_context ?? '')}` });
      break;
    default:
      if (Array.isArray(content.parts)) pushParts(content.parts);
      else if (typeof content.text === 'string') blocks.push(...textToBlocks(content.text));
      else blocks.push({ type: 'json', label: ct ?? 'contenido', text: pretty(content) });
  }
  // Un nodo con contenido vacío se conserva con un bloque explícito para no "desaparecer".
  if (blocks.length === 0) blocks.push({ type: 'empty', text: `(${ct ?? 'sin contenido'} vacío)` });
  return blocks;
}

function hiddenInfo(msg) {
  const md = msg.metadata ?? {};
  const role = msg.author?.role;
  const ct = msg.content?.content_type;
  if (md.is_visually_hidden_from_conversation) return 'oculto en la interfaz';
  if (role === 'system') return 'mensaje de sistema';
  if (ct === 'user_editable_context' || ct === 'model_editable_context') return 'contexto/memoria';
  if (ct === 'thoughts' || ct === 'reasoning_recap') return 'razonamiento';
  if (role === 'tool') return 'salida de herramienta';
  if (msg.recipient && msg.recipient !== 'all') return `llamada a herramienta (${msg.recipient})`;
  return null;
}

function collectAttachments(msg) {
  const out = [];
  for (const a of msg.metadata?.attachments ?? []) {
    if (a?.id) out.push({ fileId: a.id, name: a.name ?? null, mime: a.mime_type ?? null, size: a.size ?? null, source: 'attachment' });
  }
  for (const c of msg.metadata?.citations ?? []) {
    const fid = c?.metadata?.file_id ?? c?.file_id;
    if (fid) out.push({ fileId: fid, name: c?.metadata?.title ?? c?.title ?? null, mime: null, source: 'citation' });
  }
  return out;
}

/** Enlaces sandbox:/mnt/data/... en texto del asistente (archivos generados por el intérprete). */
function collectSandboxLinks(blocks) {
  const links = new Set();
  for (const b of blocks) {
    if (b.type !== 'text') continue;
    for (const m of b.text.matchAll(/sandbox:(\/mnt\/data\/[^\s)\]"']+)/g)) links.add(m[1]);
  }
  return [...links];
}

/**
 * @param {object} detail JSON crudo de la conversación
 * @returns {ParsedConversation}
 */
export function parseConversation(detail) {
  const mapping = detail.mapping ?? {};
  const ids = Object.keys(mapping);

  // Ruta actual (rama visible): de current_node hasta la raíz.
  const currentPath = new Set();
  let n = detail.current_node && mapping[detail.current_node] ? detail.current_node : null;
  while (n && mapping[n] && !currentPath.has(n)) {
    currentPath.add(n);
    n = mapping[n].parent ?? null;
  }

  // Recorrido DFS desde todas las raíces (también nodos huérfanos), sin perder ninguno.
  const roots = ids.filter((id) => !mapping[id].parent || !mapping[mapping[id].parent]);
  const dfsIndex = new Map();
  const visit = (start) => {
    const stack = [start];
    while (stack.length) {
      const id = stack.pop();
      if (dfsIndex.has(id) || !mapping[id]) continue;
      dfsIndex.set(id, dfsIndex.size);
      const kids = mapping[id].children ?? [];
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]);
    }
  };
  roots.forEach(visit);
  ids.forEach((id) => !dfsIndex.has(id) && visit(id)); // ciclos/inconsistencias

  const ordered = [...dfsIndex.keys()];
  let lastTime = toEpoch(detail.create_time) ?? 0;
  const effTime = new Map();
  for (const id of ordered) {
    const t = toEpoch(mapping[id].message?.create_time);
    if (t !== null) lastTime = t;
    effTime.set(id, t ?? lastTime);
  }

  const messages = [];
  let structuralNodes = 0;
  for (const id of ordered) {
    const node = mapping[id];
    const msg = node.message;
    if (!msg) {
      structuralNodes++;
      continue;
    }
    const parentId = node.parent ?? null;
    const siblings = parentId && mapping[parentId] ? (mapping[parentId].children ?? []).filter((c) => mapping[c]?.message) : [id];
    const blocks = contentToBlocks(msg.content);
    messages.push({
      nodeId: id,
      messageId: msg.id ?? id,
      parentId,
      childrenIds: node.children ?? [],
      role: msg.author?.role ?? 'desconocido',
      authorName: msg.author?.name ?? null,
      recipient: msg.recipient ?? 'all',
      createTime: toIso(msg.create_time),
      updateTime: toIso(msg.update_time),
      effectiveTime: effTime.get(id),
      timeInferred: msg.create_time === null || msg.create_time === undefined,
      contentType: msg.content?.content_type ?? null,
      status: msg.status ?? null,
      endTurn: msg.end_turn ?? null,
      modelSlug: msg.metadata?.model_slug ?? msg.metadata?.default_model_slug ?? null,
      hidden: hiddenInfo(msg) !== null,
      hiddenReason: hiddenInfo(msg),
      onCurrentPath: currentPath.size ? currentPath.has(id) : true,
      versionGroup: siblings.length > 1 ? parentId : null,
      siblingIndex: siblings.indexOf(id) + 1,
      siblingCount: siblings.length,
      blocks,
      attachments: collectAttachments(msg),
      sandboxLinks: msg.author?.role === 'assistant' ? collectSandboxLinks(blocks) : [],
      canvas: msg.metadata?.canvas ?? null,
      rawContent: msg.content ?? null,
      dfs: dfsIndex.get(id),
    });
  }

  messages.sort((a, b) => a.effectiveTime - b.effectiveTime || a.dfs - b.dfs);
  messages.forEach((m, i) => (m.seq = i + 1));

  const byRole = {};
  for (const m of messages) byRole[m.role] = (byRole[m.role] ?? 0) + 1;

  return {
    id: detail.id ?? detail.conversation_id ?? null,
    title: cleanText(detail.title ?? '') || 'Conversación sin título',
    createTime: toIso(detail.create_time),
    updateTime: toIso(detail.update_time),
    model: detail.default_model_slug ?? null,
    projectId: detail.gizmo_id ?? null,
    currentNode: detail.current_node ?? null,
    isArchived: Boolean(detail.is_archived),
    messages,
    stats: {
      totalNodes: ids.length,
      structuralNodes,
      messages: messages.length,
      byRole,
      hidden: messages.filter((m) => m.hidden).length,
      alternativeBranchMessages: messages.filter((m) => !m.onCurrentPath).length,
      versionGroups: new Set(messages.filter((m) => m.versionGroup).map((m) => m.versionGroup)).size,
      inferredTimestamps: messages.filter((m) => m.timeInferred).length,
    },
  };
}

/**
 * @typedef {ReturnType<typeof parseConversation>} ParsedConversation
 */
