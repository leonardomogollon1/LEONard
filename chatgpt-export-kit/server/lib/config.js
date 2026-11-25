/** Configuración del servidor desde variables de entorno (ver README → Variables). */
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

function keyFromEnv(name, { required }) {
  const v = process.env[name];
  if (!v) {
    if (required) throw new Error(`Falta ${name} (32 bytes en base64). Genera uno con: openssl rand -base64 32`);
    console.warn(`[config] ${name} no definido: se usa una clave efímera (los tokens se invalidan al reiniciar).`);
    return crypto.randomBytes(32);
  }
  const buf = Buffer.from(v, 'base64');
  if (buf.length !== 32) throw new Error(`${name} debe decodificar a exactamente 32 bytes.`);
  return buf;
}

export function loadConfig() {
  const prod = process.env.NODE_ENV === 'production';
  const port = Number(process.env.PORT || 8787);
  const publicBaseUrl = new URL(process.env.PUBLIC_BASE_URL || `http://localhost:${port}`);
  if (prod && publicBaseUrl.protocol !== 'https:') throw new Error('PUBLIC_BASE_URL debe ser https en producción (OAuth 2.1).');
  return {
    prod,
    port,
    publicBaseUrl,
    mcpUrl: new URL('/mcp', publicBaseUrl),
    exportDir: process.env.EXPORT_DIR || path.join(os.tmpdir(), 'chatgpt-export-mcp'),
    downloadTtlS: Number(process.env.DOWNLOAD_TTL_SECONDS || 3600),
    accessTokenTtlS: Number(process.env.ACCESS_TOKEN_TTL_SECONDS || 3600),
    refreshTokenTtlS: Number(process.env.REFRESH_TOKEN_TTL_SECONDS || 30 * 24 * 3600),
    encryptionKey: keyFromEnv('TOKEN_ENC_KEY', { required: prod }),
    downloadSigningKey: keyFromEnv('DOWNLOAD_SIGNING_KEY', { required: prod }),
    // Lista separada por comas de hosts admitidos en redirect_uri (vacío = cualquiera https/localhost).
    allowedRedirectHosts: (process.env.ALLOWED_REDIRECT_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean),
    verifyOnConsent: process.env.VERIFY_CHATGPT_ON_CONSENT !== 'false',
    maxConcurrentExportsPerUser: 1,
    exportsPerHour: Number(process.env.EXPORTS_PER_HOUR || 20),
    chatgptBaseUrl: process.env.CHATGPT_BASE_URL || 'https://chatgpt.com',
  };
}
