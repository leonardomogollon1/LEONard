/**
 * Servicio de exportación compartido por las herramientas MCP y la API REST:
 * cuotas por usuario, ejecución del pipeline de la skill, enlaces temporales firmados y limpieza.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { exportConversation, exportProject } from 'chatgpt-export-skill/pipeline';
import { CredentialProvider } from 'chatgpt-export-skill/auth';
import { ChatGPTClient } from 'chatgpt-export-skill/client';
import { ExportError } from 'chatgpt-export-skill/errors';
import { signDownload } from './vault.js';

export const ChatGPTClientFor = (cred) => new ChatGPTClient(cred, { maxRetries: 2 });

export class QuotaError extends ExportError {
  constructor(message, retryAfterS) {
    super(message, { code: 'QUOTA_EXCEEDED', details: { retryAfterS } });
    this.retryAfterS = retryAfterS;
  }
}

export class ExportService {
  /**
   * @param {{config: any, provider?: import('./oauth-provider.js').ExportOAuthProvider, logger?: (m: string) => void}} deps
   */
  constructor({ config, provider, logger = (m) => console.error(m) }) {
    this.config = config;
    this.provider = provider;
    this.log = logger;
    this.running = new Map(); // userKey → count
    this.history = new Map(); // userKey → timestamps[]
  }

  _checkQuota(userKey) {
    if ((this.running.get(userKey) ?? 0) >= this.config.maxConcurrentExportsPerUser) {
      throw new QuotaError('Ya hay una exportación en curso para esta cuenta. Espera a que termine.', 30);
    }
    const hourAgo = Date.now() - 3600_000;
    const recent = (this.history.get(userKey) ?? []).filter((t) => t > hourAgo);
    if (recent.length >= this.config.exportsPerHour) {
      throw new QuotaError(`Límite de ${this.config.exportsPerHour} exportaciones por hora alcanzado.`, Math.ceil((recent[0] + 3600_000 - Date.now()) / 1000));
    }
    recent.push(Date.now());
    this.history.set(userKey, recent);
  }

  /**
   * @param {{kind: 'conversation'|'project', input: string, grantId?: string, credential?: object,
   *          options?: {pdf?: boolean, docx?: boolean, attachments?: boolean, maxConversations?: number}}} req
   */
  async run({ kind, input, grantId, credential, options = {} }) {
    const userKey = grantId ?? 'local';
    this._checkQuota(userKey);
    const raw = credential ?? this.provider?.credentialFor(grantId);
    if (!raw) throw new ExportError('No hay credencial de ChatGPT asociada a esta autorización.', { code: 'TOKEN_EXPIRED' });
    const cred = new CredentialProvider({ ...raw, baseUrl: this.config.chatgptBaseUrl });
    const before = cred.accessToken;

    this.running.set(userKey, (this.running.get(userKey) ?? 0) + 1);
    try {
      const fn = kind === 'project' ? exportProject : exportConversation;
      const result = await fn({
        input,
        credentials: cred,
        outDir: this.config.exportDir,
        options: { ...options, logger: (m) => this.log(`[export ${userKey.slice(0, 8)}] ${m}`) },
      });
      if (grantId && cred.accessToken && cred.accessToken !== before) {
        this.provider?.updateCredential(grantId, { accessToken: cred.accessToken, sessionToken: raw.sessionToken });
      }
      return this.describe(result);
    } catch (e) {
      if (e?.code === 'TOKEN_EXPIRED' && grantId) {
        // Fuerza re-autorización: los tokens MCP de este grant dejan de ser válidos.
        this.provider?.revokeGrant(grantId);
        e.reauthorize = true;
      }
      throw e;
    } finally {
      this.running.set(userKey, (this.running.get(userKey) ?? 1) - 1);
    }
  }

  /** Resultado público con enlace temporal firmado. */
  describe(result) {
    const name = path.basename(result.zipPath);
    const exp = Math.floor(Date.now() / 1000) + this.config.downloadTtlS;
    const sig = signDownload(this.config.downloadSigningKey, name, exp);
    const url = new URL(`/downloads/${encodeURIComponent(name)}`, this.config.publicBaseUrl);
    url.searchParams.set('exp', String(exp));
    url.searchParams.set('sig', sig);
    const r = result.resumen;
    return {
      download_url: url.href,
      expires_at: new Date(exp * 1000).toISOString(),
      file_name: name,
      local_path: result.zipPath,
      bytes: result.bytes,
      sha256: result.sha256,
      export_id: result.exportId,
      complete: r.completo,
      totals: r.totales,
      conversations: r.conversaciones.map((c) => ({ id: c.id, title: c.titulo, messages: c.numeroMensajes, outputs: c.outputsDetectados })),
      errors: r.errores,
      warnings: r.advertencias ?? [],
      failed_attachments: r.adjuntosFallidos.length,
    };
  }

  /** Borra los ZIP más antiguos que el TTL de descarga. */
  async cleanup() {
    const dir = this.config.exportDir;
    const entries = await fs.readdir(dir).catch(() => []);
    const limit = Date.now() - this.config.downloadTtlS * 1000;
    for (const f of entries) {
      if (!f.endsWith('.zip')) continue;
      const p = path.join(dir, f);
      const st = await fs.stat(p).catch(() => null);
      if (st && st.mtimeMs < limit) await fs.rm(p, { force: true });
    }
  }
}
