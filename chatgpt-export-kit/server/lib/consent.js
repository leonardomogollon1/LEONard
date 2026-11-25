/** Página de consentimiento y endpoint POST /oauth/consent. */
import express from 'express';
import { CredentialProvider } from 'chatgpt-export-skill/auth';
import { ChatGPTClientFor } from './exports.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function renderConsent(res, { requestId, clientName, redirectHost, scopes, error }) {
  res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store');
  res.status(error ? 400 : 200).type('html').send(`<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Autorizar exportación de ChatGPT</title>
<style>
 body{font:15px/1.5 system-ui,sans-serif;max-width:560px;margin:40px auto;padding:0 16px;color:#111;background:#fff}
 h1{font-size:20px} .box{border:1px solid #ddd;border-radius:8px;padding:16px;margin:16px 0}
 label{display:block;font-weight:600;margin-top:12px} input[type=password]{width:100%;padding:8px;box-sizing:border-box}
 .muted{color:#555;font-size:13px} .err{background:#fee;border:1px solid #f99;padding:8px;border-radius:6px}
 button{padding:10px 16px;margin-right:8px;border-radius:6px;border:1px solid #333;cursor:pointer}
 .primary{background:#111;color:#fff}
</style></head><body>
<h1>Autorizar a «${esc(clientName)}»</h1>
<p>La aplicación solicita permiso (<code>${esc(scopes.join(' '))}</code>) para exportar tus conversaciones y proyectos de ChatGPT a DOCX, PDF y ZIP. Tras aprobar volverás a <b>${esc(redirectHost)}</b>.</p>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<form method="post" action="/oauth/consent" autocomplete="off">
 <input type="hidden" name="request_id" value="${esc(requestId)}">
 <div class="box">
  <label for="at">accessToken de ChatGPT</label>
  <input id="at" name="access_token" type="password" placeholder="eyJhbGciOi…">
  <p class="muted">Ábrelo en <code>https://chatgpt.com/api/auth/session</code> con tu sesión iniciada y copia el valor de <code>accessToken</code>. Caduca en unos días.</p>
  <label for="st">Cookie de sesión (opcional, permite renovar el token)</label>
  <input id="st" name="session_token" type="password" placeholder="__Secure-next-auth.session-token">
  <p class="muted">La credencial se guarda cifrada (AES-256-GCM) en este servidor, solo se usa para leer tus conversaciones y se elimina al revocar la autorización. ChatGPT no ofrece una API oficial para esto: usa el backend web no documentado.</p>
 </div>
 <button class="primary" name="action" value="approve" type="submit">Autorizar</button>
 <button name="action" value="deny" type="submit">Denegar</button>
</form></body></html>`);
}

/**
 * @param {{provider: import('./oauth-provider.js').ExportOAuthProvider, config: any}} deps
 */
export function consentRouter({ provider, config }) {
  const r = express.Router();
  r.post('/oauth/consent', express.urlencoded({ extended: false, limit: '32kb' }), async (req, res) => {
    const { request_id: requestId, action } = req.body ?? {};
    const pending = provider.takePending(requestId);
    if (!pending) return res.status(400).type('text').send('Solicitud de autorización caducada o inválida. Vuelve a iniciar la conexión.');

    if (action !== 'approve') {
      provider.takePending(requestId, { consume: true });
      return res.redirect(302, provider.denyUrl(pending));
    }
    const accessToken = String(req.body.access_token ?? '').trim();
    const sessionToken = String(req.body.session_token ?? '').trim();
    const again = (error) => renderConsent(res, { requestId, clientName: pending.clientName, redirectHost: new URL(pending.params.redirectUri).host, scopes: pending.params.scopes?.length ? pending.params.scopes : ['export'], error });
    if (!accessToken && !sessionToken) return again('Introduce el accessToken o la cookie de sesión.');

    const credential = { accessToken: accessToken || undefined, sessionToken: sessionToken || undefined };
    if (config.verifyOnConsent) {
      try {
        const cred = new CredentialProvider({ ...credential, baseUrl: config.chatgptBaseUrl });
        await ChatGPTClientFor(cred).json('/backend-api/conversations?offset=0&limit=1');
        credential.accessToken = cred.accessToken ?? credential.accessToken;
      } catch (e) {
        return again(`No se pudo validar la credencial con ChatGPT (${e.code ?? 'error'}): ${e.message}`);
      }
    }
    provider.takePending(requestId, { consume: true });
    res.redirect(302, provider.approve(pending, credential));
  });
  return r;
}
