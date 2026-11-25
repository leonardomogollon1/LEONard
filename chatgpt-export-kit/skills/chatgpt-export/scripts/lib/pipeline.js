/**
 * Orquestación del flujo completo: entrada → credencial → descarga → parseo → outputs →
 * DOCX + PDF → ZIP → resumen. Usado por la CLI (scripts/export.js) y por el servidor MCP.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { CredentialProvider } from './auth.js';
import { ChatGPTClient } from './client.js';
import { AuthExpiredError, ExportError, RateLimitError } from './errors.js';
import { downloadFile, downloadSandboxFile, fetchConversation, listProjectConversations, resolveProject } from './fetcher.js';
import { parseConversation } from './parser.js';
import { detectOutputs } from './outputs.js';
import { buildDocx } from './docx-builder.js';
import { buildPdf } from './pdf-builder.js';
import { writeZip } from './zipper.js';
import { parseTarget } from './target.js';
import { compactTimestamp, mapLimit, pad, safeFileName, slugify } from './util.js';

export const SKILL_VERSION = '1.0.0';

/**
 * @typedef {object} ExportOptions
 * @property {boolean} [docx=true]
 * @property {boolean} [pdf=true]
 * @property {boolean} [attachments=true]   descargar adjuntos/imágenes/archivos generados
 * @property {boolean} [includeRaw=true]    incluir el JSON original en metadatos/ (auditoría)
 * @property {number}  [maxConversations]   límite para proyectos
 * @property {number}  [downloadConcurrency=3]
 * @property {object}  [outputDetection]    {minCodeLines, similarityThreshold, dedupe}
 * @property {object}  [http]               opciones de ChatGPTClient (maxRetries, minIntervalMs…)
 * @property {(msg: string) => void} [logger]
 */

function makeClient({ credentials, env, options }) {
  const cred = credentials instanceof CredentialProvider ? credentials : credentials ? new CredentialProvider(credentials) : CredentialProvider.fromEnv(env);
  return new ChatGPTClient(cred, { logger: options.logger, ...(options.http ?? {}) });
}

/** Errores que deben abortar toda la exportación (no tiene sentido seguir). */
const isFatal = (e) => e instanceof AuthExpiredError || e instanceof RateLimitError || e?.code === 'CF_CHALLENGE';

/** Descarga todos los binarios referenciados por una conversación. */
async function collectAssets(client, conv, outputs, options, log) {
  const assets = new Map();
  const failed = [];
  if (options.attachments === false) return { assets, failed };

  const jobs = new Map();
  for (const m of conv.messages) {
    for (const b of m.blocks) if (b.type === 'image' && b.fileId) jobs.set(b.fileId, { kind: 'file', fileId: b.fileId });
    for (const a of m.attachments) if (!jobs.has(a.fileId)) jobs.set(a.fileId, { kind: 'file', fileId: a.fileId, name: a.name });
  }
  for (const o of outputs) {
    for (const v of o.versions) {
      if (v.fileRef?.sandboxPath) {
        const key = `sandbox:${v.fileRef.messageId}:${v.fileRef.sandboxPath}`;
        jobs.set(key, { kind: 'sandbox', key, ...v.fileRef });
      }
    }
  }

  await mapLimit([...jobs.values()], options.downloadConcurrency ?? 3, async (job) => {
    try {
      if (job.kind === 'file') {
        assets.set(job.fileId, await downloadFile(client, job.fileId, job.name));
      } else {
        assets.set(job.key, await downloadSandboxFile(client, conv.id, job.messageId, job.sandboxPath));
      }
    } catch (e) {
      if (isFatal(e)) throw e;
      failed.push({ ref: job.fileId ?? job.key, motivo: e.message, codigo: e.code ?? null });
      log(`Adjunto no recuperado ${job.fileId ?? job.key}: ${e.message}`);
    }
  });
  return { assets, failed };
}

/** Entradas ZIP de outputs/ para una conversación. */
function outputEntries(outputs, assets, prefix) {
  const entries = [];
  for (const o of outputs) {
    for (const v of o.versions) {
      const dir = `outputs/${prefix}${o.folder}`;
      if (v.content !== null && v.content !== undefined) {
        entries.push({ path: `${dir}/${v.fileStem}.${o.ext || 'txt'}`, data: v.content });
        continue;
      }
      const key = v.fileRef?.fileId ?? (v.fileRef?.sandboxPath ? `sandbox:${v.fileRef.messageId}:${v.fileRef.sandboxPath}` : null);
      const asset = key ? assets.get(key) : null;
      if (asset) {
        const ext = asset.fileName.includes('.') ? asset.fileName.split('.').pop() : o.ext || 'bin';
        v.file = `${v.fileStem}.${ext}`;
        entries.push({ path: `${dir}/${v.file}`, data: asset.buffer });
      } else {
        v.file = `${v.fileStem}.FALTANTE.txt`;
        entries.push({
          path: `${dir}/${v.file}`,
          data: `No se pudo descargar este output.\nReferencia: ${key}\nMensaje #${v.messageSeq} (${v.nodeId})\nVer metadatos/resumen.json → adjuntosFallidos.\n`,
        });
      }
    }
  }
  return entries;
}

function attachmentEntries(conv, assets, prefix) {
  const entries = [];
  const seen = new Set();
  for (const m of conv.messages) {
    const refs = [...m.attachments.map((a) => a.fileId), ...m.blocks.filter((b) => b.type === 'image' && b.fileId && m.role === 'user').map((b) => b.fileId)];
    for (const id of refs) {
      if (seen.has(id) || !assets.has(id)) continue;
      seen.add(id);
      const a = assets.get(id);
      entries.push({ path: `adjuntos/${prefix}${pad(m.seq, 4)}_${safeFileName(a.fileName, id)}`, data: a.buffer });
    }
  }
  return entries;
}

function outputSummary(outputs) {
  return outputs.map((o) => ({
    indice: o.index,
    carpeta: o.folder,
    tipo: o.kind,
    nombreBase: o.baseName,
    extension: o.ext,
    versiones: o.versions.map((v) => ({
      archivo: v.file ?? `${v.fileStem}.${o.ext || 'txt'}`,
      version: v.version,
      mejorada: v.version > 1,
      mensajeSeq: v.messageSeq,
      nodeId: v.nodeId,
      fecha: v.createTime,
      ramaPrincipal: v.onCurrentPath,
      origen: v.source,
      sha256: v.hash ?? null,
      notas: v.notes?.length ? v.notes : undefined,
    })),
  }));
}

function convSummary(conv, outputs) {
  return {
    id: conv.id,
    titulo: conv.title,
    creada: conv.createTime,
    actualizada: conv.updateTime,
    modelo: conv.model,
    proyectoId: conv.projectId,
    archivada: conv.isArchived,
    numeroMensajes: conv.stats.messages,
    mensajesPorRol: conv.stats.byRole,
    mensajesOcultos: conv.stats.hidden,
    mensajesRamasAlternativas: conv.stats.alternativeBranchMessages,
    gruposDeVersiones: conv.stats.versionGroups,
    nodosEstructuralesSinMensaje: conv.stats.structuralNodes,
    fechasInferidas: conv.stats.inferredTimestamps,
    outputsDetectados: outputs.length,
    outputs: outputSummary(outputs),
  };
}

export async function finalizeExport({ kind, input, project, items, client, options, outDir, idForName, failedAssets, errors, duplicatesSkipped }) {
  const log = options.logger ?? (() => {});
  const generatedAt = new Date().toISOString();
  const exportId = `${slugify(idForName, 40)}_${compactTimestamp(new Date(generatedAt))}`;
  const rootDir = `export_${exportId}`;
  const entries = [];
  const multi = kind === 'proyecto';
  const warnings = [];

  const allAssets = new Map();
  for (const it of items) for (const [k, v] of it.assets) allAssets.set(k, v);

  for (const [i, it] of items.entries()) {
    const prefix = multi ? `${pad(i + 1)}_${slugify(it.conv.title, 40)}/` : '';
    const docInput = {
      conversations: [{ conv: it.conv, outputs: it.outputs }],
      assets: it.assets,
      meta: { exportId, generatedAt, projectName: project?.name, title: it.conv.title },
    };
    if (options.docx !== false) {
      log(`Generando DOCX: ${it.conv.title}`);
      entries.push({ path: `documentos/${prefix}conversacion_completa.docx`, data: await buildDocx(docInput) });
    }
    if (options.pdf !== false) {
      log(`Generando PDF: ${it.conv.title}`);
      try {
        entries.push({ path: `documentos/${prefix}conversacion_completa.pdf`, data: await buildPdf({ ...docInput, onWarning: (w) => warnings.push({ conversacion: it.conv.id, etapa: 'pdf', mensaje: w }) }) });
      } catch (e) {
        errors.push({ conversacion: it.conv.id, etapa: 'pdf', mensaje: e.message, codigo: e.code ?? null });
        log(`PDF fallido (${e.code ?? 'error'}): ${e.message}`);
      }
    }
    entries.push(...outputEntries(it.outputs, it.assets, prefix));
    entries.push(...attachmentEntries(it.conv, it.assets, prefix));
    if (options.includeRaw !== false) entries.push({ path: `metadatos/raw/${prefix}conversacion_${it.conv.id}.json`, data: JSON.stringify(it.raw, null, 2) });
  }

  const resumen = {
    schemaVersion: 1,
    exportId,
    fechaExportacion: generatedAt,
    tipo: kind,
    fuente: input,
    proyecto: project ? { id: project.id, nombre: project.name, resueltoEnBarraLateral: !project.unresolved } : null,
    // false si alguna conversación, documento o adjunto no pudo exportarse (ver errores/adjuntosFallidos).
    completo: errors.length === 0 && failedAssets.length === 0,
    totales: {
      conversaciones: items.length,
      mensajes: items.reduce((s, it) => s + it.conv.stats.messages, 0),
      outputsDetectados: items.reduce((s, it) => s + it.outputs.length, 0),
      versionesDeOutputs: items.reduce((s, it) => s + it.outputs.reduce((a, o) => a + o.versions.length, 0), 0),
      adjuntosDescargados: allAssets.size,
      adjuntosFallidos: failedAssets.length,
      versionesDuplicadasOmitidas: duplicatesSkipped,
    },
    conversaciones: items.map((it) => convSummary(it.conv, it.outputs)),
    adjuntosFallidos: failedAssets,
    errores: errors,
    advertencias: warnings,
    estadisticasHttp: client.stats,
    notas: [
      'Se incluyen todos los nodos con mensaje del árbol (sistema, herramientas, ocultos y ramas alternativas).',
      'La detección de outputs es heurística; ver references/output-detection.md.',
      'Fuente de datos: backend web no documentado de ChatGPT; puede cambiar sin aviso.',
    ],
    generador: { skill: 'chatgpt-export', version: SKILL_VERSION, node: process.version },
  };
  entries.push({ path: 'metadatos/resumen.json', data: JSON.stringify(resumen, null, 2) });

  await fs.mkdir(outDir, { recursive: true });
  const zipPath = path.join(outDir, `${rootDir}.zip`);
  log(`Empaquetando ${entries.length} archivos → ${zipPath}`);
  const zip = await writeZip(zipPath, rootDir, entries);
  return { ...zip, exportId, rootDir, resumen };
}

async function processConversation(client, id, options, log) {
  log(`Descargando conversación ${id}`);
  const raw = await fetchConversation(client, id);
  const conv = parseConversation(raw);
  const { outputs, duplicatesSkipped } = detectOutputs(conv, options.outputDetection);
  log(`${conv.stats.messages} mensajes · ${outputs.length} outputs detectados`);
  const { assets, failed } = await collectAssets(client, conv, outputs, options, log);
  return { raw, conv, outputs, assets, failed, duplicatesSkipped };
}

/**
 * Exporta una conversación.
 * @param {{input: string, credentials?: CredentialProvider|{accessToken?: string, sessionToken?: string}, env?: object,
 *          outDir?: string, options?: ExportOptions}} args
 */
export async function exportConversation({ input, credentials, env = process.env, outDir = path.join(os.tmpdir(), 'chatgpt-exports'), options = {} }) {
  const log = options.logger ?? (() => {});
  const target = parseTarget(input, 'conversation');
  const client = makeClient({ credentials, env, options });
  const it = await processConversation(client, target.id, options, log);
  return finalizeExport({
    kind: 'conversacion', input, project: null, items: [it], client, options, outDir,
    idForName: target.id, failedAssets: it.failed, errors: [], duplicatesSkipped: it.duplicatesSkipped,
  });
}

/**
 * Exporta todas las conversaciones de un proyecto.
 * Un fallo no fatal en una conversación se registra en resumen.errores y se continúa.
 */
export async function exportProject({ input, credentials, env = process.env, outDir = path.join(os.tmpdir(), 'chatgpt-exports'), options = {} }) {
  const log = options.logger ?? (() => {});
  const target = parseTarget(input, 'project');
  const client = makeClient({ credentials, env, options });
  const project = await resolveProject(client, target);
  log(`Proyecto: ${project.name} (${project.id})`);
  let list = await listProjectConversations(client, project.id);
  list.sort((a, b) => (Date.parse(a.create_time) || a.create_time || 0) - (Date.parse(b.create_time) || b.create_time || 0));
  if (options.maxConversations) list = list.slice(0, options.maxConversations);
  if (!list.length) throw new ExportError(`El proyecto "${project.name}" no tiene conversaciones accesibles.`, { code: 'EMPTY_PROJECT' });
  log(`${list.length} conversaciones en el proyecto`);

  const items = [];
  const errors = [];
  const failedAssets = [];
  let duplicatesSkipped = 0;
  for (const c of list) {
    try {
      const it = await processConversation(client, c.id, options, log);
      items.push(it);
      failedAssets.push(...it.failed.map((f) => ({ ...f, conversacion: c.id })));
      duplicatesSkipped += it.duplicatesSkipped;
    } catch (e) {
      if (isFatal(e)) throw e;
      errors.push({ conversacion: c.id, titulo: c.title ?? null, etapa: 'descarga', mensaje: e.message, codigo: e.code ?? null });
      log(`Conversación ${c.id} omitida por error: ${e.message}`);
    }
  }
  if (!items.length) throw new ExportError('No se pudo exportar ninguna conversación del proyecto.', { code: 'EXPORT_FAILED', details: { errors } });
  return finalizeExport({ kind: 'proyecto', input, project, items, client, options, outDir, idForName: project.id, failedAssets, errors, duplicatesSkipped });
}
