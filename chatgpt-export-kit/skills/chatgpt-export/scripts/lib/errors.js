/**
 * Errores tipados del exportador. Cada error lleva un `code` estable que
 * consumen la CLI (código de salida) y el servidor MCP (mensaje al usuario).
 */

export class ExportError extends Error {
  /**
   * @param {string} message
   * @param {{code?: string, cause?: unknown, details?: Record<string, unknown>}} [opts]
   */
  constructor(message, opts = {}) {
    super(message, { cause: opts.cause });
    this.name = this.constructor.name;
    this.code = opts.code ?? 'EXPORT_ERROR';
    this.details = opts.details ?? {};
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

/** Entrada inválida (link/ID no reconocido, opciones incoherentes). */
export class InputError extends ExportError {
  constructor(message, opts = {}) {
    super(message, { code: 'INVALID_INPUT', ...opts });
  }
}

/**
 * Token de ChatGPT ausente, caducado o rechazado (HTTP 401/403) y sin posibilidad
 * de renovarlo automáticamente.
 */
export class AuthExpiredError extends ExportError {
  constructor(message = 'El token de sesión de ChatGPT ha caducado o no es válido.', opts = {}) {
    super(message, { code: 'TOKEN_EXPIRED', ...opts });
    this.remediation =
      'Obtén un token nuevo: abre https://chatgpt.com/api/auth/session con la sesión iniciada y copia "accessToken" ' +
      '(o proporciona la cookie de sesión para que se renueve automáticamente). En el plugin MCP: vuelve a autorizar la conexión.';
  }
}

/** HTTP 429 persistente tras agotar los reintentos. */
export class RateLimitError extends ExportError {
  /** @param {string} message @param {{retryAfterMs?: number} & Record<string, any>} [opts] */
  constructor(message = 'ChatGPT ha limitado la frecuencia de peticiones (HTTP 429).', opts = {}) {
    super(message, { code: 'RATE_LIMITED', ...opts });
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/** Recurso inexistente o no accesible con la cuenta actual (HTTP 404). */
export class NotFoundError extends ExportError {
  constructor(message, opts = {}) {
    super(message, { code: 'NOT_FOUND', ...opts });
  }
}

/** Error del servidor de ChatGPT, desafío anti-bot o respuesta inesperada. */
export class UpstreamError extends ExportError {
  constructor(message, opts = {}) {
    super(message, { code: 'UPSTREAM_ERROR', ...opts });
  }
}

/** Mapea un error a código de salida de proceso (CLI). */
export function exitCodeFor(err) {
  switch (err?.code) {
    case 'INVALID_INPUT': return 2;
    case 'TOKEN_EXPIRED': return 3;
    case 'RATE_LIMITED': return 4;
    case 'NOT_FOUND': return 5;
    case 'UPSTREAM_ERROR':
    case 'CF_CHALLENGE': return 6;
    default: return 1;
  }
}
