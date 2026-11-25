/** Cifrado AES-256-GCM de las credenciales de ChatGPT en reposo y utilidades de tokens. */
import crypto from 'node:crypto';

export class Vault {
  /** @param {Buffer} key 32 bytes */
  constructor(key) {
    this.key = key;
  }

  seal(obj) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
  }

  open(sealed) {
    const buf = Buffer.from(sealed, 'base64url');
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
  }
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

/** Firma HMAC para enlaces de descarga temporales. */
export function signDownload(key, name, exp) {
  return crypto.createHmac('sha256', key).update(`${name}:${exp}`).digest('base64url');
}

export function verifyDownload(key, name, exp, sig) {
  if (!sig || !exp || Number(exp) * 1000 < Date.now()) return false;
  const expected = Buffer.from(signDownload(key, name, exp));
  const got = Buffer.from(String(sig));
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}
