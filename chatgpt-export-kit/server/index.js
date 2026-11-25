#!/usr/bin/env node
/**
 * Servidor MCP "chatgpt-export".
 *
 *   node index.js           → HTTP: MCP Streamable HTTP en /mcp protegido con OAuth 2.1 + API REST + descargas firmadas
 *   node index.js --stdio   → stdio (uso local; credencial por CHATGPT_ACCESS_TOKEN / CHATGPT_SESSION_TOKEN; sin OAuth)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createOAuthMetadata, getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { loadConfig } from './lib/config.js';
import { Vault, verifyDownload } from './lib/vault.js';
import { ExportOAuthProvider, SCOPES } from './lib/oauth-provider.js';
import { consentRouter, renderConsent } from './lib/consent.js';
import { ExportService } from './lib/exports.js';
import { buildMcpServer } from './lib/tools.js';

const ZIP_NAME = /^export_[A-Za-z0-9._-]+\.zip$/;

const sameResource = (a, b) => String(a).replace(/#.*$/, '').replace(/\/$/, '') === String(b).replace(/#.*$/, '').replace(/\/$/, '');

/** Construye la app Express (exportada para pruebas). */
export function createApp(config = loadConfig()) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  const vault = new Vault(config.encryptionKey);
  const provider = new ExportOAuthProvider({ config, vault, renderConsent });
  const service = new ExportService({ config, provider });
  const issuerUrl = config.publicBaseUrl;

  // --- Metadatos OAuth (antes del router del SDK para añadir campos exigidos por clientes) ---
  const asMetadata = {
    ...createOAuthMetadata({ provider, issuerUrl, scopesSupported: SCOPES }),
    code_challenge_methods_supported: ['S256'],
    authorization_response_iss_parameter_supported: true, // RFC 9207 (requerido por ChatGPT Apps SDK)
  };
  const prm = {
    resource: config.mcpUrl.href,
    authorization_servers: [asMetadata.issuer],
    scopes_supported: SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: 'ChatGPT Export',
    resource_documentation: new URL('/docs/openapi.yaml', config.publicBaseUrl).href,
  };
  app.get('/.well-known/oauth-authorization-server', (_req, res) => res.json(asMetadata));
  app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (_req, res) => res.json(prm));

  // --- Endpoints OAuth: /authorize, /token, /register, /revoke (PKCE, DCR, rate limit del SDK) ---
  app.use(mcpAuthRouter({ provider, issuerUrl, scopesSupported: SCOPES, resourceServerUrl: config.mcpUrl, resourceName: 'ChatGPT Export' }));
  app.use(consentRouter({ provider, config }));

  // --- Protección de recursos ---
  const bearer = requireBearerAuth({ verifier: provider, requiredScopes: ['export'], resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(config.mcpUrl) });
  const audience = (req, res, next) => {
    const r = req.auth?.resource;
    if (r && !sameResource(r.href, config.mcpUrl.href)) {
      res.set('WWW-Authenticate', `Bearer error="invalid_token", error_description="Token emitido para otro recurso", resource_metadata="${getOAuthProtectedResourceMetadataUrl(config.mcpUrl)}"`);
      return res.status(401).json({ error: 'invalid_token' });
    }
    next();
  };
  const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false });

  // --- MCP Streamable HTTP (sin estado: un servidor MCP por petición, ligado al grant del token) ---
  app.post('/mcp', limiter, bearer, audience, express.json({ limit: '1mb' }), async (req, res) => {
    const server = buildMcpServer({ service, grantId: req.auth.extra.grantId, publicBaseUrl: config.publicBaseUrl });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error('[mcp] error', e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Error interno' }, id: null });
    }
  });
  const notAllowed = (_req, res) => res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Método no permitido (servidor sin estado)' }, id: null });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);

  // --- API REST (documentada en openapi.yaml) ---
  const rest = (kind) => async (req, res) => {
    const b = req.body ?? {};
    const input = kind === 'project' ? b.project : b.conversation;
    if (typeof input !== 'string' || !input.trim()) return res.status(400).json({ error: 'INVALID_INPUT', message: `Falta "${kind === 'project' ? 'project' : 'conversation'}"` });
    try {
      const r = await service.run({
        kind,
        input,
        grantId: req.auth.extra.grantId,
        options: { pdf: b.include_pdf !== false, docx: b.include_docx !== false, attachments: b.download_attachments !== false, maxConversations: b.max_conversations },
      });
      const { local_path: _lp, ...pub } = r;
      res.json(pub);
    } catch (e) {
      const status = { INVALID_INPUT: 400, TOKEN_EXPIRED: 401, NOT_FOUND: 404, RATE_LIMITED: 429, QUOTA_EXCEEDED: 429, CF_CHALLENGE: 502, UPSTREAM_ERROR: 502 }[e.code] ?? 500;
      if (status === 401) res.set('WWW-Authenticate', `Bearer error="invalid_token", error_description="Credencial de ChatGPT caducada; vuelve a autorizar", resource_metadata="${getOAuthProtectedResourceMetadataUrl(config.mcpUrl)}"`);
      const retry = e.retryAfterS ?? (e.retryAfterMs ? Math.ceil(e.retryAfterMs / 1000) : undefined);
      if (retry) res.set('Retry-After', String(retry));
      res.status(status).json({ error: e.code ?? 'EXPORT_ERROR', message: e.message, remediation: e.remediation, details: e.details });
    }
  };
  app.post('/api/v1/export/conversation', limiter, bearer, audience, express.json({ limit: '64kb' }), rest('conversation'));
  app.post('/api/v1/export/project', limiter, bearer, audience, express.json({ limit: '64kb' }), rest('project'));

  // --- Descargas temporales firmadas ---
  app.get('/downloads/:name', async (req, res) => {
    const { name } = req.params;
    if (!ZIP_NAME.test(name) || !verifyDownload(config.downloadSigningKey, name, req.query.exp, req.query.sig)) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Enlace inválido o caducado' });
    }
    const file = path.join(config.exportDir, name);
    try {
      await fs.access(file);
    } catch {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'El archivo ya no está disponible' });
    }
    res.set('Cache-Control', 'private, no-store');
    res.download(file, name);
  });

  const here = path.dirname(fileURLToPath(import.meta.url));
  app.get('/docs/openapi.yaml', (_req, res) => res.type('application/yaml').sendFile(path.join(here, 'openapi.yaml')));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  return { app, provider, service };
}

async function main() {
  const config = loadConfig();
  await fs.mkdir(config.exportDir, { recursive: true });

  if (process.argv.includes('--stdio')) {
    const service = new ExportService({ config });
    const credential = { accessToken: process.env.CHATGPT_ACCESS_TOKEN, sessionToken: process.env.CHATGPT_SESSION_TOKEN };
    const server = buildMcpServer({ service, credential, localMode: true });
    await server.connect(new StdioServerTransport());
    console.error('[chatgpt-export] servidor MCP en stdio');
    return;
  }

  const { app, service } = createApp(config);
  setInterval(() => service.cleanup().catch((e) => console.error('[cleanup]', e)), 10 * 60_000).unref();
  app.listen(config.port, () => {
    console.error(`[chatgpt-export] MCP en ${config.mcpUrl.href} · issuer ${config.publicBaseUrl.href}`);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
