import crypto from 'node:crypto';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Slug seguro para nombres de archivo/carpeta (ASCII, sin separadores de ruta). */
export function slugify(input, maxLen = 60) {
  const s = String(input ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[._]+|[._]+$/g, '')
    .slice(0, maxLen)
    .replace(/[._]+$/g, '');
  return s || 'sin_nombre';
}

/** Nombre de archivo seguro preservando la extensión. */
export function safeFileName(name, fallback = 'archivo') {
  const base = String(name ?? '').split(/[\\/]/).pop() || fallback;
  const dot = base.lastIndexOf('.');
  if (dot > 0 && dot < base.length - 1) {
    const ext = base.slice(dot + 1).replace(/[^A-Za-z0-9]/g, '').slice(0, 10);
    return `${slugify(base.slice(0, dot), 80)}${ext ? '.' + ext.toLowerCase() : ''}`;
  }
  return slugify(base, 80);
}

export const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Timestamp compacto UTC: 20261125T154200Z */
export function compactTimestamp(d = new Date()) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Epoch (segundos, posiblemente decimal) o ISO → ISO 8601 o null. */
export function toIso(t) {
  if (t === null || t === undefined || t === '') return null;
  const d = typeof t === 'number' ? new Date(t * 1000) : new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Epoch (s) o ISO → epoch en segundos (number) o null. */
export function toEpoch(t) {
  if (t === null || t === undefined || t === '') return null;
  if (typeof t === 'number') return t;
  const ms = Date.parse(t);
  return Number.isNaN(ms) ? null : ms / 1000;
}

/** Fecha legible en español, en UTC para que el documento sea reproducible. */
export function humanDate(t) {
  const iso = toIso(t);
  if (!iso) return 'sin fecha';
  return iso.replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

/**
 * Normaliza texto para formatos XML/PDF:
 *  - convierte los marcadores privados de citas de ChatGPT (U+E200..U+E202) en "[cita: …]"
 *  - elimina caracteres de control inválidos en XML 1.0
 */
export function cleanText(text) {
  if (text === null || text === undefined) return '';
  let s = String(text);
  s = s.replace(/([^]*)/g, (_, inner) => `[${inner.split('').filter(Boolean).join(': ')}]`);
  s = s.replace(/[-]/g, '');
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
  return s;
}

/** Similitud de Jaccard sobre líneas no vacías normalizadas (0..1). */
export function lineJaccard(a, b) {
  const norm = (t) => new Set(String(t).split('\n').map((l) => l.trim()).filter(Boolean));
  const A = norm(a);
  const B = norm(b);
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Decodifica el payload de un JWT SIN verificar firma (solo para leer `exp`). */
export function decodeJwtPayload(token) {
  try {
    const part = String(token).split('.')[1];
    if (!part) return null;
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/** Ejecuta `fn` sobre `items` con concurrencia limitada, preservando el orden de resultados. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
