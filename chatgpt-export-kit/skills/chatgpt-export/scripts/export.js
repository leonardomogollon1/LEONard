#!/usr/bin/env node
/**
 * CLI de la skill chatgpt-export.
 *
 * Uso:
 *   node scripts/export.js <link|id> [--project] [--out DIR] [--no-pdf] [--no-docx] [--no-attachments]
 *                                   [--no-raw] [--max-conversations N] [--json] [--quiet]
 *   node scripts/export.js --from-file conversation.json [--out DIR]    (modo offline, sin red)
 *
 * Credenciales (variables de entorno):
 *   CHATGPT_ACCESS_TOKEN   accessToken de https://chatgpt.com/api/auth/session
 *   CHATGPT_SESSION_TOKEN  cookie __Secure-next-auth.session-token (permite renovar el token)
 *
 * Salida: JSON en stdout con zipPath, sha256 y resumen. Códigos de salida: ver lib/errors.js.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { exportConversation, exportProject } from './lib/pipeline.js';
import { exportFromFile } from './lib/offline.js';
import { exitCodeFor } from './lib/errors.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    project: { type: 'boolean', default: false },
    out: { type: 'string', default: path.resolve('exports') },
    'no-pdf': { type: 'boolean', default: false },
    'no-docx': { type: 'boolean', default: false },
    'no-attachments': { type: 'boolean', default: false },
    'no-raw': { type: 'boolean', default: false },
    'max-conversations': { type: 'string' },
    'from-file': { type: 'string' },
    json: { type: 'boolean', default: false },
    quiet: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help || (!positionals[0] && !values['from-file'])) {
  console.error((await fs.readFile(new URL(import.meta.url), 'utf8')).split('\n').slice(2, 17).join('\n'));
  process.exit(values.help ? 0 : 2);
}

const logger = values.quiet ? undefined : (m) => console.error(`[chatgpt-export] ${m}`);
const options = {
  pdf: !values['no-pdf'],
  docx: !values['no-docx'],
  attachments: !values['no-attachments'],
  includeRaw: !values['no-raw'],
  maxConversations: values['max-conversations'] ? Number(values['max-conversations']) : undefined,
  logger,
};

try {
  let result;
  if (values['from-file']) {
    result = await exportFromFile({ file: values['from-file'], outDir: values.out, options });
  } else {
    const input = positionals[0];
    const isProject = values.project || /\/project\/?$|^project:|^g-p-/i.test(input);
    result = await (isProject ? exportProject : exportConversation)({ input, outDir: values.out, options });
  }
  const { resumen, ...rest } = result;
  const payload = values.json ? { ...rest, resumen } : { ...rest, totales: resumen.totales, completo: resumen.completo, errores: resumen.errores };
  console.log(JSON.stringify(payload, null, 2));
  if (!resumen.completo) logger?.('ATENCIÓN: exportación incompleta; revisa errores y adjuntosFallidos en metadatos/resumen.json');
} catch (err) {
  const out = { error: err.code ?? 'ERROR', message: err.message, details: err.details, remediation: err.remediation };
  console.error(JSON.stringify(out, null, 2));
  process.exit(exitCodeFor(err));
}
