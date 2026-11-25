/** Empaquetado ZIP con `archiver` (streaming a disco). */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { ZipArchive } from 'archiver';
import { ExportError } from './errors.js';

/**
 * @param {string} zipPath ruta del .zip a crear
 * @param {string} rootDir carpeta raíz dentro del zip (export_{id}_{timestamp})
 * @param {Array<{path: string, data: Buffer|string}>} entries rutas relativas a rootDir
 * @returns {Promise<{zipPath: string, bytes: number, sha256: string, entries: number}>}
 */
export function writeZip(zipPath, rootDir, entries) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(zipPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    const fail = (cause) => reject(new ExportError(`No se pudo crear el ZIP: ${cause?.message}`, { code: 'ZIP_FAILED', cause }));
    archive.on('warning', (w) => (w.code === 'ENOENT' ? undefined : fail(w)));
    archive.on('error', fail);
    out.on('error', fail);
    out.on('close', () => {
      const hash = crypto.createHash('sha256');
      fs.createReadStream(zipPath)
        .on('data', (d) => hash.update(d))
        .on('error', fail)
        .on('end', () => resolve({ zipPath, bytes: archive.pointer(), sha256: hash.digest('hex'), entries: entries.length }));
    });
    archive.pipe(out);
    const seen = new Set();
    for (const e of entries) {
      let p = `${rootDir}/${e.path}`.replace(/\/{2,}/g, '/');
      // Evita colisiones de nombre silenciosas.
      for (let i = 2; seen.has(p); i++) p = p.replace(/(\.[^./]+)?$/, (ext) => `_${i}${ext ?? ''}`);
      seen.add(p);
      archive.append(Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8'), { name: p, date: e.date ?? new Date() });
    }
    // Directorios explícitos para que la estructura exista aunque estén vacíos.
    for (const dir of ['documentos/', 'outputs/', 'metadatos/']) archive.append('', { name: `${rootDir}/${dir}` });
    archive.finalize().catch(fail);
  });
}
