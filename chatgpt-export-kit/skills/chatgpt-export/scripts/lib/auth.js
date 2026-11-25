/**
 * Gestión de credenciales de ChatGPT.
 *
 * Dos modos (ver references/chatgpt-backend-api.md):
 *  A) accessToken (JWT Bearer) copiado de https://chatgpt.com/api/auth/session → no renovable.
 *  B) cookie de sesión (`__Secure-next-auth.session-token`, o cabecera Cookie completa) → el
 *     proveedor llama a /api/auth/session para obtener/renovar el accessToken.
 *
 * Ninguno de los dos es una API pública documentada por OpenAI: el endpoint puede cambiar o
 * quedar protegido por un desafío anti-bot (Cloudflare) cuando se llama desde un servidor.
 */
import { AuthExpiredError, InputError, UpstreamError } from './errors.js';
import { decodeJwtPayload } from './util.js';

export const DEFAULT_BASE_URL = 'https://chatgpt.com';
export const SESSION_COOKIE_NAME = '__Secure-next-auth.session-token';
export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Margen de seguridad antes de `exp` para considerar el token caducado. */
const EXPIRY_SKEW_S = 60;

export class CredentialProvider {
  /**
   * @param {{accessToken?: string, sessionToken?: string, baseUrl?: string, fetchImpl?: typeof fetch}} opts
   */
  constructor({ accessToken, sessionToken, baseUrl = DEFAULT_BASE_URL, fetchImpl = fetch } = {}) {
    this.accessToken = accessToken?.trim().replace(/^Bearer\s+/i, '') || null;
    this.sessionToken = sessionToken?.trim() || null;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
    this.accountId = null;
    if (!this.accessToken && !this.sessionToken) {
      throw new InputError(
        'Falta la credencial de ChatGPT. Define CHATGPT_ACCESS_TOKEN (accessToken de /api/auth/session) ' +
          'o CHATGPT_SESSION_TOKEN (cookie de sesión).',
      );
    }
  }

  /** Construye el proveedor a partir de variables de entorno. */
  static fromEnv(env = process.env) {
    return new CredentialProvider({
      accessToken: env.CHATGPT_ACCESS_TOKEN,
      sessionToken: env.CHATGPT_SESSION_TOKEN,
      baseUrl: env.CHATGPT_BASE_URL || DEFAULT_BASE_URL,
    });
  }

  get canRefresh() {
    return Boolean(this.sessionToken);
  }

  /** Segundos epoch de caducidad según el claim `exp` del JWT (sin verificar firma), o null. */
  get expiresAt() {
    const p = this.accessToken ? decodeJwtPayload(this.accessToken) : null;
    return typeof p?.exp === 'number' ? p.exp : null;
  }

  isExpired(nowS = Date.now() / 1000) {
    const exp = this.expiresAt;
    return exp !== null && exp - EXPIRY_SKEW_S <= nowS;
  }

  /** Devuelve un accessToken utilizable, renovándolo si es posible. */
  async getAccessToken() {
    if (!this.accessToken || this.isExpired()) {
      if (this.canRefresh) return this.refresh();
      if (!this.accessToken) throw new AuthExpiredError('No hay accessToken disponible.');
      throw new AuthExpiredError('El accessToken de ChatGPT ha caducado (claim exp vencido).', {
        details: { expiredAt: new Date(this.expiresAt * 1000).toISOString() },
      });
    }
    return this.accessToken;
  }

  /** Obtiene un accessToken nuevo desde /api/auth/session usando la cookie de sesión. */
  async refresh() {
    if (!this.canRefresh) throw new AuthExpiredError('El token fue rechazado y no hay cookie de sesión para renovarlo.');
    const cookie = this.sessionToken.includes('=') ? this.sessionToken : `${SESSION_COOKIE_NAME}=${this.sessionToken}`;
    let res;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/auth/session`, {
        headers: { Cookie: cookie, 'User-Agent': BROWSER_UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (cause) {
      throw new UpstreamError('No se pudo contactar /api/auth/session.', { cause });
    }
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      throw new UpstreamError(
        '/api/auth/session devolvió HTML (probable desafío anti-bot). Usa el modo accessToken copiado del navegador.',
        { code: 'CF_CHALLENGE', details: { status: res.status } },
      );
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body?.accessToken) {
      throw new AuthExpiredError('La cookie de sesión de ChatGPT no es válida o ha caducado.', {
        details: { status: res.status },
      });
    }
    this.accessToken = body.accessToken;
    this.accountId = body?.account?.id ?? this.accountId;
    return this.accessToken;
  }

  /** Invalida el accessToken actual (tras un 401) para forzar renovación. */
  invalidate() {
    if (this.canRefresh) this.accessToken = null;
  }
}
