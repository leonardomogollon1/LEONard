/**
 * Detección de outputs generados y agrupación de versiones mejoradas.
 * Reglas completas y limitaciones: references/output-detection.md
 *
 * Tipos de output:
 *  - canvas : documentos/código de Canvas (canmore.create_textdoc / canmore.update_textdoc).
 *             Cada update se aplica sobre la versión previa → versión mejorada.
 *  - code   : bloques de código del asistente (``` … ```) con nombre de archivo detectado
 *             o agrupados por similitud con un output anterior del mismo lenguaje.
 *  - file   : archivos generados por el intérprete de código (enlaces sandbox:/mnt/data/…).
 *  - image  : imágenes generadas por herramientas (image_asset_pointer en mensajes tool/assistant).
 */
import { lineJaccard, sha256, slugify } from './util.js';

export const LANG_EXT = {
  javascript: 'js', js: 'js', jsx: 'jsx', mjs: 'mjs', cjs: 'cjs', typescript: 'ts', ts: 'ts', tsx: 'tsx',
  python: 'py', py: 'py', python3: 'py', bash: 'sh', sh: 'sh', shell: 'sh', zsh: 'sh', powershell: 'ps1', ps1: 'ps1',
  json: 'json', jsonc: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml', html: 'html', css: 'css', scss: 'scss',
  sql: 'sql', markdown: 'md', md: 'md', java: 'java', kotlin: 'kt', swift: 'swift', go: 'go', rust: 'rs', rs: 'rs',
  c: 'c', cpp: 'cpp', 'c++': 'cpp', csharp: 'cs', cs: 'cs', php: 'php', ruby: 'rb', rb: 'rb', r: 'r', dart: 'dart',
  scala: 'scala', lua: 'lua', perl: 'pl', dockerfile: 'Dockerfile', makefile: 'mk', ini: 'ini', csv: 'csv', tex: 'tex',
  latex: 'tex', vue: 'vue', svelte: 'svelte', graphql: 'graphql', proto: 'proto', text: 'txt', txt: 'txt', plaintext: 'txt',
  mermaid: 'mmd', vba: 'bas', excel: 'txt', document: 'md', react: 'jsx',
};

const FILENAME_RE = /([A-Za-z0-9_\-./]+\.(?:[A-Za-z0-9]{1,6}))/;
const FILENAME_LINE_RE = [
  /^\s*(?:\/\/|#|--|;|\/\*+|<!--)\s*(?:file(?:name)?|archivo|fichero|path|ruta)?\s*:?\s*([A-Za-z0-9_\-./]+\.[A-Za-z0-9]{1,6})\s*(?:\*\/|-->)?\s*$/i,
];

export function extFor(language, fallback = 'txt') {
  const l = String(language ?? '').toLowerCase().replace(/^code\//, '');
  return LANG_EXT[l] ?? (l && /^[a-z0-9]{1,6}$/.test(l) ? l : fallback);
}

/** Intenta inferir el nombre de archivo de un bloque de código. */
export function detectFilename(block, precedingText) {
  if (block.filenameHint) {
    const t = block.filenameHint.match(/(?:title|file(?:name)?)=["']?([^"'\s]+)/i)?.[1] ?? block.filenameHint;
    const m = t.match(FILENAME_RE);
    if (m) return m[1];
  }
  const firstLine = block.text.split('\n', 1)[0] ?? '';
  for (const re of FILENAME_LINE_RE) {
    const m = firstLine.match(re);
    if (m) return m[1];
  }
  if (precedingText) {
    const lastLine = precedingText.trim().split('\n').pop() ?? '';
    // p. ej. "**src/app.js**", "`index.html`:", "Archivo app.py:"
    const m = lastLine.match(/[`*"]+([A-Za-z0-9_\-./]+\.[A-Za-z0-9]{1,6})[`*"]+\s*:?\s*$/) ?? lastLine.match(/([A-Za-z0-9_\-./]+\.[A-Za-z0-9]{1,6})\s*:\s*$/);
    if (m) return m[1];
  }
  return null;
}

function parseJsonLoose(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function canvasPayload(msg) {
  const rc = msg.rawContent ?? {};
  const text = typeof rc.text === 'string' ? rc.text : Array.isArray(rc.parts) ? rc.parts.filter((p) => typeof p === 'string').join('') : '';
  return parseJsonLoose(text);
}

function applyCanvasUpdates(prev, updates) {
  let out = prev ?? '';
  const notes = [];
  for (const u of updates ?? []) {
    try {
      const re = new RegExp(u.pattern ?? '', u.multiple ? 'g' : '');
      // En canmore, el reemplazo se interpreta como texto literal salvo referencias $n.
      out = out.replace(re, u.replacement ?? '');
    } catch (e) {
      notes.push(`Patrón inválido "${u.pattern}": ${e.message}`);
      out = u.replacement ?? out;
    }
  }
  return { content: out, notes };
}

/**
 * @param {import('./parser.js').ParsedConversation} conv
 * @param {{minCodeLines?: number, similarityThreshold?: number, dedupe?: boolean}} [opts]
 */
export function detectOutputs(conv, opts = {}) {
  const minCodeLines = opts.minCodeLines ?? 3;
  const threshold = opts.similarityThreshold ?? 0.35;
  const dedupe = opts.dedupe ?? true;

  /** @type {Array<any>} */
  const outputs = [];
  const byKey = new Map();
  let lastCanvasKey = null;
  let duplicatesSkipped = 0;

  const getOrCreate = (key, init) => {
    let o = byKey.get(key);
    if (!o) {
      o = { key, versions: [], firstSeq: Infinity, ...init };
      byKey.set(key, o);
      outputs.push(o);
    }
    return o;
  };

  const addVersion = (o, v) => {
    if (dedupe && v.content !== undefined && v.content !== null) {
      const h = sha256(v.content);
      if (o.versions.some((x) => x.hash === h)) {
        duplicatesSkipped++;
        return;
      }
      v.hash = h;
    }
    o.firstSeq = Math.min(o.firstSeq, v.messageSeq);
    o.versions.push(v);
  };

  const baseVersion = (msg) => ({
    messageSeq: msg.seq,
    nodeId: msg.nodeId,
    createTime: msg.createTime,
    onCurrentPath: msg.onCurrentPath,
    role: msg.role,
  });

  const toolReplyTo = (msg) => conv.messages.find((m) => m.parentId === msg.nodeId && m.role === 'tool');

  for (const msg of conv.messages) {
    // ---- Canvas ----------------------------------------------------------------------------
    if (msg.role === 'assistant' && /^canmore\.(create|update)_textdoc$/.test(msg.recipient)) {
      const payload = canvasPayload(msg);
      const reply = toolReplyTo(msg);
      const docId = reply?.canvas?.textdoc_id ?? msg.canvas?.textdoc_id ?? null;
      if (msg.recipient === 'canmore.create_textdoc' && payload) {
        const key = `canvas:${docId ?? slugify(payload.name ?? `canvas_${msg.seq}`)}`;
        const o = getOrCreate(key, {
          kind: 'canvas',
          baseName: payload.name ?? 'canvas',
          ext: payload.type === 'document' ? 'md' : extFor(payload.type, 'txt'),
        });
        addVersion(o, { ...baseVersion(msg), content: payload.content ?? '', source: 'canmore.create_textdoc' });
        lastCanvasKey = key;
      } else if (msg.recipient === 'canmore.update_textdoc' && payload) {
        const key = docId && byKey.has(`canvas:${docId}`) ? `canvas:${docId}` : lastCanvasKey;
        const o = key ? byKey.get(key) : getOrCreate(`canvas:huerfano_${msg.seq}`, { kind: 'canvas', baseName: 'canvas_sin_origen', ext: 'txt' });
        const prev = o.versions.at(-1)?.content ?? '';
        const { content, notes } = applyCanvasUpdates(prev, payload.updates);
        addVersion(o, { ...baseVersion(msg), content, source: 'canmore.update_textdoc', notes });
        lastCanvasKey = o.key;
      }
      continue; // el JSON de la llamada no se trata como bloque de código
    }

    // ---- Imágenes generadas ----------------------------------------------------------------
    if (msg.role === 'tool' || msg.role === 'assistant') {
      const imgs = msg.blocks.filter((b) => b.type === 'image' && b.fileId);
      if (imgs.length) {
        const o = getOrCreate(`image:${msg.nodeId}`, { kind: 'image', baseName: `imagen_generada_${msg.seq}`, ext: null });
        for (const b of imgs) addVersion(o, { ...baseVersion(msg), content: null, fileRef: { fileId: b.fileId }, source: 'image_asset_pointer' });
      }
    }

    // ---- Archivos del intérprete (sandbox) ------------------------------------------------
    for (const p of msg.sandboxLinks ?? []) {
      const name = p.split('/').pop();
      const o = getOrCreate(`file:${name}`, { kind: 'file', baseName: name.replace(/\.[^.]+$/, ''), ext: name.includes('.') ? name.split('.').pop() : 'bin' });
      // Mismo nombre en mensajes distintos = versión nueva; mismo mensaje = no duplicar.
      if (!o.versions.some((v) => v.nodeId === msg.nodeId)) {
        addVersion(o, { ...baseVersion(msg), content: null, fileRef: { sandboxPath: p, messageId: msg.messageId }, source: 'sandbox' });
      }
    }

    // ---- Bloques de código del asistente --------------------------------------------------
    if (msg.role !== 'assistant' || msg.recipient !== 'all') continue;
    let preceding = '';
    msg.blocks.forEach((b, idx) => {
      if (b.type === 'text') {
        preceding = b.text;
        return;
      }
      if (b.type !== 'code' || b.executionOutput) return;
      const lines = b.text.split('\n').filter((l) => l.trim()).length;
      if (lines < minCodeLines) return;
      const filename = detectFilename(b, preceding);
      const ext = filename?.includes('.') ? filename.split('.').pop() : extFor(b.language);
      let o = null;
      if (filename) {
        o = getOrCreate(`code:file:${filename.toLowerCase()}`, { kind: 'code', baseName: filename.replace(/\.[^.]+$/, ''), ext, language: b.language });
      } else {
        // Regeneración hermana: mismo grupo de versiones y misma posición de bloque.
        if (msg.versionGroup) {
          o = outputs.find((x) => x.kind === 'code' && x.versions.some((v) => v.versionGroup === msg.versionGroup && v.blockIndex === idx));
        }
        if (!o) {
          let best = null;
          let bestScore = 0;
          for (const x of outputs) {
            if (x.kind !== 'code' || extFor(x.language) !== extFor(b.language)) continue;
            const score = lineJaccard(x.versions.at(-1).content, b.text);
            if (score >= threshold && score >= bestScore) {
              best = x;
              bestScore = score;
            }
          }
          o = best;
        }
        if (!o) {
          const n = outputs.filter((x) => x.kind === 'code').length + 1;
          const heading = preceding.match(/^#{1,4}\s+(.+)$/m)?.[1];
          o = getOrCreate(`code:auto:${msg.nodeId}:${idx}`, {
            kind: 'code',
            baseName: heading ? heading.slice(0, 50) : `${b.language || 'codigo'}_bloque_${n}`,
            ext,
            language: b.language,
          });
        }
      }
      addVersion(o, { ...baseVersion(msg), content: b.text.endsWith('\n') ? b.text : b.text + '\n', source: 'code_block', blockIndex: idx, versionGroup: msg.versionGroup, language: b.language });
      preceding = '';
    });
  }

  const finalOutputs = outputs
    .filter((o) => o.versions.length > 0)
    .sort((a, b) => a.firstSeq - b.firstSeq)
    .map((o, i) => {
      const index = i + 1;
      const versions = o.versions
        .sort((a, b) => a.messageSeq - b.messageSeq)
        .map((v, k) => ({ ...v, version: k + 1, fileStem: k === 0 ? 'version_1' : `version_${k + 1}_mejorada` }));
      return { ...o, index, folder: `${String(index).padStart(2, '0')}_${slugify(o.baseName, 50)}`, versions };
    });

  return { outputs: finalOutputs, duplicatesSkipped };
}
