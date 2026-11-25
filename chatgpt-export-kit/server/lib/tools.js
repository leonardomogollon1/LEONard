/** Registro de las herramientas MCP export_conversation y export_project. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const OPTIONS_SHAPE = {
  include_pdf: z.boolean().default(true).describe('Generar conversacion_completa.pdf'),
  include_docx: z.boolean().default(true).describe('Generar conversacion_completa.docx'),
  download_attachments: z.boolean().default(true).describe('Descargar adjuntos, imágenes y archivos generados'),
};

const OUTPUT_SHAPE = {
  download_url: z.string().describe('Enlace temporal firmado al ZIP'),
  expires_at: z.string(),
  file_name: z.string(),
  bytes: z.number(),
  sha256: z.string(),
  export_id: z.string(),
  complete: z.boolean().describe('false si algún mensaje/adjunto/documento no pudo exportarse'),
  totals: z.record(z.string(), z.any()),
  conversations: z.array(z.object({ id: z.string().nullable(), title: z.string(), messages: z.number(), outputs: z.number() })),
  errors: z.array(z.any()),
  warnings: z.array(z.any()),
  failed_attachments: z.number(),
};

const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true };
// Apps SDK de OpenAI: declara que la herramienta requiere OAuth con el scope "export".
// (Campo según la guía de autenticación del Apps SDK; validar contra la versión vigente.)
const SECURITY_META = { securitySchemes: [{ type: 'oauth2', scopes: ['export'] }] };

function toOptions(a) {
  return { pdf: a.include_pdf, docx: a.include_docx, attachments: a.download_attachments, maxConversations: a.max_conversations };
}

function success(r, { localMode }) {
  const { local_path: localPath, ...pub } = r;
  const structured = localMode ? { ...pub, download_url: `file://${localPath}` } : pub;
  const lines = [
    `Exportación ${r.complete ? 'completa' : 'INCOMPLETA (ver errors / failed_attachments)'}.`,
    `${r.totals.conversaciones} conversación(es), ${r.totals.mensajes} mensajes, ${r.totals.outputsDetectados} outputs (${r.totals.versionesDeOutputs} versiones).`,
    localMode ? `ZIP: ${localPath}` : `Descarga (caduca ${r.expires_at}): ${r.download_url}`,
    `SHA-256: ${r.sha256}`,
  ];
  return {
    content: [
      { type: 'text', text: lines.join('\n') },
      { type: 'resource_link', uri: structured.download_url, name: r.file_name, mimeType: 'application/zip', description: 'ZIP con documentos/, outputs/ y metadatos/' },
    ],
    structuredContent: structured,
  };
}

function failure(e, { publicBaseUrl }) {
  const msg = [`Error ${e.code ?? 'EXPORT_ERROR'}: ${e.message}`];
  if (e.remediation) msg.push(e.remediation);
  if (e.retryAfterMs || e.retryAfterS) msg.push(`Reintenta en ~${Math.ceil((e.retryAfterMs ?? e.retryAfterS * 1000) / 1000)} s.`);
  const result = { isError: true, content: [{ type: 'text', text: msg.join('\n') }] };
  if (e.reauthorize && publicBaseUrl) {
    // Señal de re-autorización para clientes que la soportan (Apps SDK); el resto recibirá 401 en la próxima llamada.
    result._meta = {
      'mcp/www_authenticate': [
        `Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource', publicBaseUrl).href}", error="invalid_token", error_description="La credencial de ChatGPT ha caducado"`,
      ],
    };
  }
  return result;
}

/**
 * @param {{service: import('./exports.js').ExportService, grantId?: string, credential?: object,
 *          localMode?: boolean, publicBaseUrl?: URL}} ctx
 */
export function buildMcpServer(ctx) {
  const server = new McpServer({ name: 'chatgpt-export', version: '1.0.0' }, { capabilities: { logging: {} } });
  const run = (kind) => async (args) => {
    try {
      const r = await ctx.service.run({ kind, input: kind === 'project' ? args.project : args.conversation, grantId: ctx.grantId, credential: ctx.credential, options: toOptions(args) });
      return success(r, ctx);
    } catch (e) {
      return failure(e, ctx);
    }
  };

  server.registerTool(
    'export_conversation',
    {
      title: 'Exportar conversación de ChatGPT',
      description:
        'Exporta una conversación completa de ChatGPT (todos los mensajes, incluidos sistema, ocultos y ramas alternativas, ' +
        'en orden cronológico) a DOCX y PDF, extrae los outputs generados agrupando sus versiones mejoradas y devuelve un ZIP ' +
        'descargable (documentos/, outputs/, metadatos/resumen.json). Acepta URL https://chatgpt.com/c/<id> o el UUID.',
      inputSchema: { conversation: z.string().min(1).describe('URL o ID de la conversación'), ...OPTIONS_SHAPE },
      outputSchema: OUTPUT_SHAPE,
      annotations: ANNOTATIONS,
      _meta: SECURITY_META,
    },
    run('conversation'),
  );

  server.registerTool(
    'export_project',
    {
      title: 'Exportar proyecto de ChatGPT',
      description:
        'Exporta todas las conversaciones de un Proyecto de ChatGPT (una carpeta por conversación en documentos/ y outputs/) ' +
        'en un único ZIP descargable. Acepta URL https://chatgpt.com/g/g-p-…/project, el ID g-p-… o "project:<nombre exacto>".',
      inputSchema: {
        project: z.string().min(1).describe('URL, ID g-p-… o project:<nombre>'),
        max_conversations: z.number().int().positive().max(500).optional().describe('Límite opcional de conversaciones'),
        ...OPTIONS_SHAPE,
      },
      outputSchema: OUTPUT_SHAPE,
      annotations: ANNOTATIONS,
      _meta: SECURITY_META,
    },
    run('project'),
  );

  return server;
}
