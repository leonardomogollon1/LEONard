/**
 * Modo offline: exporta desde un JSON local sin llamar a ChatGPT.
 * Acepta:
 *  - el JSON de /backend-api/conversation/{id} (un objeto con `mapping`), o
 *  - el `conversations.json` de la exportación oficial de datos de ChatGPT
 *    (Settings → Data controls → Export data), que es un array de objetos con `mapping`.
 * En este modo no se descargan adjuntos (no hay credencial); quedan registrados como no recuperados.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { InputError } from './errors.js';
import { parseConversation } from './parser.js';
import { detectOutputs } from './outputs.js';
import { finalizeExport } from './pipeline.js';

export async function exportFromFile({ file, outDir = path.join(os.tmpdir(), 'chatgpt-exports'), options = {}, conversationIds }) {
  let data;
  try {
    data = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (e) {
    throw new InputError(`No se pudo leer/parsear ${file}: ${e.message}`);
  }
  let list = Array.isArray(data) ? data : [data];
  list = list.filter((c) => c && typeof c === 'object' && c.mapping);
  if (conversationIds?.length) list = list.filter((c) => conversationIds.includes(c.id ?? c.conversation_id));
  if (!list.length) throw new InputError('El archivo no contiene conversaciones con "mapping".');

  const items = [];
  const failedAssets = [];
  let duplicatesSkipped = 0;
  for (const raw of list) {
    raw.id ??= raw.conversation_id;
    const conv = parseConversation(raw);
    const r = detectOutputs(conv, options.outputDetection);
    duplicatesSkipped += r.duplicatesSkipped;
    const refs = new Set();
    for (const m of conv.messages) {
      for (const b of m.blocks) if (b.type === 'image' && b.fileId) refs.add(b.fileId);
      for (const a of m.attachments) refs.add(a.fileId);
    }
    for (const ref of refs) failedAssets.push({ ref, conversacion: conv.id, motivo: 'modo offline: sin descarga de binarios', codigo: 'OFFLINE' });
    items.push({ raw, conv, outputs: r.outputs, assets: new Map(), failed: [] });
  }

  return finalizeExport({
    kind: items.length > 1 ? 'proyecto' : 'conversacion',
    input: `file:${path.basename(file)}`,
    project: items.length > 1 ? { id: 'lote-offline', name: path.basename(file), unresolved: true } : null,
    items,
    client: { stats: { requests: 0, retries: 0, rateLimited: 0, refreshed: 0 } },
    options,
    outDir,
    idForName: items.length > 1 ? 'lote' : items[0].conv.id ?? 'conversacion',
    failedAssets,
    errors: [],
    duplicatesSkipped,
  });
}
