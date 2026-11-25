/**
 * Cliente HTTP para el backend web de ChatGPT con:
 *  - throttling (intervalo mínimo entre peticiones)
 *  - reintentos con backoff exponencial + jitter para 429 / 5xx / errores de red
 *  - respeto de la cabecera Retry-After (segundos o fecha HTTP)
 *  - renovación automática del token ante 401/403 cuando hay cookie de sesión
 *  - detección de desafíos anti-bot (respuesta HTML)
 *
 * Lógica inspirada en chatgpt-exporter (npm, MIT): ApiClient + withRetry.
 */
import { AuthExpiredError, NotFoundError, RateLimitError, UpstreamError } from './errors.js';
import { BROWSER_UA } from './auth.js';
import { sleep } from './util.js';

export const ENDPOINTS = {
  CONVERSATIONS: '/backend-api/conversations',
  CONVERSATION: (id) => `/backend-api/conversation/${encodeURIComponent(id)}`,
  PROJECTS_SIDEBAR: '/backend-api/gizmos/snorlax/sidebar',
  PROJECT_CONVERSATIONS: (gizmoId) => `/backend-api/gizmos/${encodeURIComponent(gizmoId)}/conversations`,
  FILE_DOWNLOAD: (fileId) => `/backend-api/files/download/${encodeURIComponent(fileId)}`,
  // NO VERIFICADO contra documentación oficial (no existe); usado como "best effort" para
  // archivos generados por el intérprete de código (enlaces sandbox:/mnt/data/...).
  INTERPRETER_DOWNLOAD: (conversationId, messageId, sandboxPath) =>
    `/backend-api/conversation/${encodeURIComponent(conversationId)}/interpreter/download?message_id=${encodeURIComponent(
      messageId,
    )}&sandbox_path=${encodeURIComponent(sandboxPath)}`,
};

/** Interpreta Retry-After (segundos o fecha HTTP) → ms, o undefined. */
export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

export class ChatGPTClient {
  /**
   * @param {import('./auth.js').CredentialProvider} credentials
   * @param {{baseUrl?: string, maxRetries?: number, baseDelayMs?: number, maxDelayMs?: number,
   *          minIntervalMs?: number, timeoutMs?: number, fetchImpl?: typeof fetch, logger?: (msg: string) => void}} [opts]
   */
  constructor(credentials, opts = {}) {
    this.credentials = credentials;
    this.baseUrl = (opts.baseUrl ?? credentials.baseUrl).replace(/\/$/, '');
    this.maxRetries = opts.maxRetries ?? 5;
    this.baseDelayMs = opts.baseDelayMs ?? 1000;
    this.maxDelayMs = opts.maxDelayMs ?? 60_000;
    this.minIntervalMs = opts.minIntervalMs ?? 350;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.log = opts.logger ?? (() => {});
    this._last = 0;
    this._chain = Promise.resolve();
    this.stats = { requests: 0, retries: 0, rateLimited: 0, refreshed: 0 };
  }

  /** Serializa y espacia las peticiones para no disparar el rate limit. */
  async _throttle() {
    const run = this._chain.then(async () => {
      const wait = this._last + this.minIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      this._last = Date.now();
    });
    this._chain = run.catch(() => {});
    return run;
  }

  _backoff(attempt, retryAfterMs) {
    if (retryAfterMs !== undefined) return Math.min(retryAfterMs + 250, this.maxDelayMs * 2);
    const exp = Math.min(this.baseDelayMs * 2 ** attempt, this.maxDelayMs);
    return Math.round(exp / 2 + Math.random() * (exp / 2)); // "equal jitter"
  }

  async _headers(sameOrigin) {
    if (!sameOrigin) return { 'User-Agent': BROWSER_UA };
    const token = await this.credentials.getAccessToken();
    const h = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': BROWSER_UA,
      Referer: `${this.baseUrl}/`,
      Origin: this.baseUrl,
    };
    if (this.credentials.accountId) h['ChatGPT-Account-Id'] = this.credentials.accountId;
    return h;
  }

  /**
   * Petición genérica con reintentos. Devuelve el objeto Response (cuerpo sin consumir).
   * @param {string} pathOrUrl ruta relativa (/backend-api/...) o URL absoluta
   */
  async request(pathOrUrl, { method = 'GET', body, expectJson = true } = {}) {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${this.baseUrl}${pathOrUrl}`;
    const sameOrigin = new URL(url).origin === new URL(this.baseUrl).origin;
    let refreshedOnce = false;

    for (let attempt = 0; ; attempt++) {
      await this._throttle();
      this.stats.requests++;
      let res;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: { ...(await this._headers(sameOrigin)), ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (cause) {
        if (cause instanceof AuthExpiredError || cause?.code === 'CF_CHALLENGE') throw cause;
        if (attempt >= this.maxRetries) throw new UpstreamError(`Error de red tras ${attempt + 1} intentos: ${url}`, { cause });
        const d = this._backoff(attempt);
        this.stats.retries++;
        this.log(`Error de red (${cause?.message}); reintento ${attempt + 1} en ${d} ms`);
        await sleep(d);
        continue;
      }

      if (res.ok) {
        if (expectJson && sameOrigin) {
          const ct = res.headers.get('content-type') || '';
          if (ct.includes('text/html')) {
            throw new UpstreamError('ChatGPT devolvió HTML en lugar de JSON (posible desafío anti-bot o sesión inválida).', {
              code: 'CF_CHALLENGE',
              details: { url, status: res.status },
            });
          }
        }
        return res;
      }

      // 401/403: token caducado o rechazado.
      if (sameOrigin && (res.status === 401 || res.status === 403)) {
        await res.body?.cancel().catch(() => {});
        if (this.credentials.canRefresh && !refreshedOnce) {
          refreshedOnce = true;
          this.stats.refreshed++;
          this.log('Token rechazado; renovando mediante /api/auth/session…');
          this.credentials.invalidate();
          await this.credentials.refresh();
          attempt--; // la renovación no consume un reintento
          continue;
        }
        throw new AuthExpiredError(`ChatGPT rechazó el token (HTTP ${res.status}).`, { details: { url, status: res.status } });
      }

      if (res.status === 404) {
        await res.body?.cancel().catch(() => {});
        throw new NotFoundError(`Recurso no encontrado o sin acceso: ${url}`, { details: { url } });
      }

      const retryable = res.status === 429 || res.status === 408 || res.status >= 500;
      if (!retryable) {
        const text = await res.text().catch(() => '');
        throw new UpstreamError(`HTTP ${res.status} en ${url}`, { details: { url, status: res.status, body: text.slice(0, 500) } });
      }

      const retryAfterMs = parseRetryAfter(res.headers.get('retry-after'));
      await res.body?.cancel().catch(() => {});
      if (res.status === 429) this.stats.rateLimited++;
      if (attempt >= this.maxRetries) {
        if (res.status === 429) {
          throw new RateLimitError(`Rate limit persistente tras ${attempt + 1} intentos.`, { retryAfterMs, details: { url } });
        }
        throw new UpstreamError(`HTTP ${res.status} persistente en ${url}`, { details: { url, status: res.status } });
      }
      const d = this._backoff(attempt, retryAfterMs);
      this.stats.retries++;
      this.log(`HTTP ${res.status}; reintento ${attempt + 1}/${this.maxRetries} en ${d} ms`);
      await sleep(d);
    }
  }

  async json(path, opts) {
    const res = await this.request(path, opts);
    try {
      return await res.json();
    } catch (cause) {
      throw new UpstreamError(`Respuesta JSON inválida en ${path}`, { cause });
    }
  }

  async raw(url) {
    const res = await this.request(url, { expectJson: false });
    return {
      buffer: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') || 'application/octet-stream',
      contentDisposition: res.headers.get('content-disposition') || '',
    };
  }
}
