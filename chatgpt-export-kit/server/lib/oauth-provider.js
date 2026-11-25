/**
 * Servidor de autorización OAuth 2.1 embebido (implementa OAuthServerProvider del SDK MCP).
 *
 *  - Authorization Code + PKCE S256 obligatorio (validado por el SDK con challengeForAuthorizationCode).
 *  - Registro dinámico de clientes (RFC 7591) con lista opcional de hosts de redirect permitidos.
 *  - Tokens opacos (256 bits) almacenados solo como hash SHA-256; refresh tokens con rotación.
 *  - Indicador de recurso (RFC 8707): el token queda ligado al recurso /mcp solicitado.
 *  - Pantalla de consentimiento donde el usuario vincula su credencial de ChatGPT; la credencial se
 *    cifra (AES-256-GCM) y queda asociada al "grant". Las herramientas la recuperan por grantId.
 *
 * Almacenamiento: en memoria (adecuado para una instancia). Para producción multi-instancia,
 * sustituir los Map por Redis/DB manteniendo la misma interfaz.
 */
import { InvalidGrantError, InvalidTokenError, InvalidClientMetadataError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { hashToken, randomToken } from './vault.js';

const CODE_TTL_MS = 10 * 60 * 1000;
const PENDING_TTL_MS = 15 * 60 * 1000;
export const SCOPES = ['export'];

export class ExportOAuthProvider {
  /**
   * @param {{config: ReturnType<import('./config.js').loadConfig>, vault: import('./vault.js').Vault,
   *          renderConsent: (res: any, ctx: object) => void}} deps
   */
  constructor({ config, vault, renderConsent }) {
    this.config = config;
    this.vault = vault;
    this.renderConsent = renderConsent;
    this.clients = new Map();
    this.pending = new Map(); // requestId → {clientId, params, exp}
    this.codes = new Map(); // code → {...}
    this.accessTokens = new Map(); // hash → {...}
    this.refreshTokens = new Map(); // hash → {...}
    this.grants = new Map(); // grantId → {sealedCredential, clientId, scopes, createdAt}
    const self = this;
    this.clientsStore = {
      getClient: (id) => self.clients.get(id),
      registerClient: (client) => self._registerClient(client),
    };
  }

  _registerClient(client) {
    for (const uri of client.redirect_uris ?? []) {
      const u = new URL(uri);
      const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
      if (u.protocol !== 'https:' && !local) throw new InvalidClientMetadataError(`redirect_uri debe ser https: ${uri}`);
      if (this.config.allowedRedirectHosts.length && !this.config.allowedRedirectHosts.includes(u.hostname)) {
        throw new InvalidClientMetadataError(`Host de redirect no permitido: ${u.hostname}`);
      }
    }
    const full = { ...client, client_id: `cli_${randomToken(16)}`, client_id_issued_at: Math.floor(Date.now() / 1000) };
    this.clients.set(full.client_id, full);
    return full;
  }

  /** Paso 1: muestra la pantalla de consentimiento. */
  async authorize(client, params, res) {
    this._gc();
    const requestId = randomToken(24);
    this.pending.set(requestId, { clientId: client.client_id, clientName: client.client_name ?? client.client_id, params, exp: Date.now() + PENDING_TTL_MS });
    this.renderConsent(res, { requestId, clientName: client.client_name ?? client.client_id, redirectHost: new URL(params.redirectUri).host, scopes: params.scopes?.length ? params.scopes : SCOPES });
  }

  /** Recupera (y consume si `consume`) una solicitud pendiente. */
  takePending(requestId, { consume = false } = {}) {
    const p = this.pending.get(requestId);
    if (!p || p.exp < Date.now()) {
      this.pending.delete(requestId);
      return null;
    }
    if (consume) this.pending.delete(requestId);
    return p;
  }

  /** Paso 2 (tras aprobar): crea el grant con la credencial cifrada y emite el código. */
  approve(pending, credential) {
    const grantId = `grt_${randomToken(16)}`;
    const scopes = pending.params.scopes?.length ? pending.params.scopes.filter((s) => SCOPES.includes(s)) : SCOPES;
    this.grants.set(grantId, { sealedCredential: this.vault.seal(credential), clientId: pending.clientId, scopes, createdAt: Date.now() });
    const code = randomToken(32);
    this.codes.set(code, {
      grantId,
      clientId: pending.clientId,
      codeChallenge: pending.params.codeChallenge,
      redirectUri: pending.params.redirectUri,
      resource: pending.params.resource?.href ?? null,
      scopes,
      exp: Date.now() + CODE_TTL_MS,
    });
    const url = new URL(pending.params.redirectUri);
    url.searchParams.set('code', code);
    if (pending.params.state !== undefined) url.searchParams.set('state', pending.params.state);
    url.searchParams.set('iss', this.config.publicBaseUrl.href.replace(/\/$/, '')); // RFC 9207
    return url.href;
  }

  denyUrl(pending) {
    const url = new URL(pending.params.redirectUri);
    url.searchParams.set('error', 'access_denied');
    url.searchParams.set('error_description', 'El usuario denegó la autorización');
    if (pending.params.state !== undefined) url.searchParams.set('state', pending.params.state);
    url.searchParams.set('iss', this.config.publicBaseUrl.href.replace(/\/$/, ''));
    return url.href;
  }

  async challengeForAuthorizationCode(client, code) {
    const c = this.codes.get(code);
    if (!c || c.clientId !== client.client_id) throw new InvalidGrantError('Código de autorización inválido');
    return c.codeChallenge;
  }

  async exchangeAuthorizationCode(client, code, _verifier, redirectUri, resource) {
    const c = this.codes.get(code);
    this.codes.delete(code); // un solo uso
    if (!c || c.exp < Date.now()) throw new InvalidGrantError('Código caducado o ya utilizado');
    if (c.clientId !== client.client_id) throw new InvalidGrantError('El código no pertenece a este cliente');
    if (redirectUri && redirectUri !== c.redirectUri) throw new InvalidGrantError('redirect_uri no coincide');
    if (resource && c.resource && resource.href !== c.resource) throw new InvalidGrantError('resource no coincide');
    if (!this.grants.has(c.grantId)) throw new InvalidGrantError('Autorización revocada');
    return this._issue(c.grantId, client.client_id, c.scopes, c.resource);
  }

  async exchangeRefreshToken(client, refreshToken, scopes, resource) {
    const h = hashToken(refreshToken);
    const r = this.refreshTokens.get(h);
    this.refreshTokens.delete(h); // rotación: el refresh token anterior deja de valer
    if (!r || r.exp < Date.now() || r.clientId !== client.client_id || !this.grants.has(r.grantId)) {
      throw new InvalidGrantError('Refresh token inválido, caducado o revocado');
    }
    if (resource && r.resource && resource.href !== r.resource) throw new InvalidGrantError('resource no coincide');
    const granted = scopes?.length ? scopes.filter((s) => r.scopes.includes(s)) : r.scopes;
    return this._issue(r.grantId, client.client_id, granted, r.resource);
  }

  _issue(grantId, clientId, scopes, resource) {
    const access = randomToken(32);
    const refresh = randomToken(32);
    const now = Date.now();
    this.accessTokens.set(hashToken(access), { grantId, clientId, scopes, resource, exp: now + this.config.accessTokenTtlS * 1000 });
    this.refreshTokens.set(hashToken(refresh), { grantId, clientId, scopes, resource, exp: now + this.config.refreshTokenTtlS * 1000 });
    return { access_token: access, token_type: 'Bearer', expires_in: this.config.accessTokenTtlS, refresh_token: refresh, scope: scopes.join(' ') };
  }

  async verifyAccessToken(token) {
    const t = this.accessTokens.get(hashToken(token));
    if (!t || t.exp < Date.now() || !this.grants.has(t.grantId)) throw new InvalidTokenError('Token inválido o caducado');
    return {
      token,
      clientId: t.clientId,
      scopes: t.scopes,
      expiresAt: Math.floor(t.exp / 1000),
      resource: t.resource ? new URL(t.resource) : undefined,
      extra: { grantId: t.grantId },
    };
  }

  async revokeToken(_client, { token }) {
    const h = hashToken(token);
    this.accessTokens.delete(h);
    this.refreshTokens.delete(h);
  }

  /** Credencial de ChatGPT descifrada asociada a un grant. */
  credentialFor(grantId) {
    const g = this.grants.get(grantId);
    return g ? this.vault.open(g.sealedCredential) : null;
  }

  /** Actualiza la credencial (p. ej. tras renovar el accessToken con la cookie). */
  updateCredential(grantId, credential) {
    const g = this.grants.get(grantId);
    if (g) g.sealedCredential = this.vault.seal(credential);
  }

  /**
   * Revoca un grant y todos sus tokens (se usa cuando la credencial de ChatGPT caduca: el
   * siguiente request MCP recibe 401 + WWW-Authenticate y el cliente debe re-autorizar).
   */
  revokeGrant(grantId) {
    this.grants.delete(grantId);
    for (const m of [this.accessTokens, this.refreshTokens]) for (const [k, v] of m) if (v.grantId === grantId) m.delete(k);
  }

  _gc() {
    const now = Date.now();
    for (const m of [this.pending, this.codes, this.accessTokens, this.refreshTokens]) for (const [k, v] of m) if (v.exp < now) m.delete(k);
  }
}
