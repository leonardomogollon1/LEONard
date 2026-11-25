# Backend web de ChatGPT usado por la skill

> **Estado: NO DOCUMENTADO por OpenAI.** Los endpoints siguientes son los que usa la aplicación web
> de chatgpt.com y los que implementa el paquete npm `chatgpt-exporter` (v1.1.0, MIT,
> github.com/FdezRomero/chatgpt-exporter), de donde se tomaron como referencia (verificado leyendo su
> `dist/index.js` el 2026-11-25). Pueden cambiar sin aviso. No existe una API pública ni un flujo
> OAuth oficial de OpenAI para leer conversaciones de chatgpt.com.

## Autenticación

| Mecanismo | Cómo se obtiene | Uso |
|---|---|---|
| `accessToken` (JWT) | `GET https://chatgpt.com/api/auth/session` en el navegador con sesión iniciada → campo `accessToken` | `Authorization: Bearer <token>` en `/backend-api/*` |
| Cookie de sesión | Cookie `__Secure-next-auth.session-token` (puede venir troceada en `.0`, `.1`; en ese caso pasar la cabecera `Cookie` completa) | `GET /api/auth/session` con la cookie devuelve un `accessToken` nuevo |

- El JWT incluye `exp`; la skill lo lee (sin verificar firma) para detectar caducidad antes de llamar.
- 401/403 en `/backend-api/*` ⇒ token caducado/rechazado. Con cookie: se renueva una vez y se reintenta. Sin cookie: `TOKEN_EXPIRED`.
- Llamar `/api/auth/session` desde un servidor puede recibir un desafío anti-bot (HTML) ⇒ `CF_CHALLENGE`. En ese caso usar el accessToken copiado del navegador.
- Cuentas de equipo/empresa: puede requerirse la cabecera `ChatGPT-Account-Id` (se envía si `/api/auth/session` devuelve `account.id`). **NO VERIFICADO** para todos los planes.

## Endpoints

| Uso | Método y ruta | Paginación / notas |
|---|---|---|
| Conversación completa | `GET /backend-api/conversation/{id}` | Devuelve `mapping` (árbol completo con todas las ramas), `current_node`, `title`, `create_time`, `update_time`, `gizmo_id`, `default_model_slug` |
| Listado de conversaciones | `GET /backend-api/conversations?offset=&limit=` | `items`, `total`; se usa para validar la credencial |
| Proyectos (barra lateral) | `GET /backend-api/gizmos/snorlax/sidebar[?cursor=]` | `items[].gizmo.{id, display.name}`, `cursor` |
| Conversaciones de un proyecto | `GET /backend-api/gizmos/{gizmoId}/conversations?cursor=` | Empieza en `cursor=0`; termina cuando `cursor` es null |
| Metadatos de archivo | `GET /backend-api/files/download/{fileId}` | `download_url` (firmada, otro dominio → se descarga **sin** Authorization), `file_name` |
| Archivo del intérprete | `GET /backend-api/conversation/{cid}/interpreter/download?message_id=&sandbox_path=` | **NO VERIFICADO** (no aparece en chatgpt-exporter); se intenta y, si falla, el output queda como `*.FALTANTE.txt` |

Referencias a archivos dentro de los mensajes:
- `image_asset_pointer.asset_pointer` = `file-service://<fileId>` (también se acepta `sediment://`).
- `metadata.attachments[].id` (archivos subidos por el usuario).
- `metadata.citations[].metadata.file_id` (archivos citados).
- Enlaces `sandbox:/mnt/data/<archivo>` en el texto del asistente (archivos generados por el intérprete).

## Límites y reintentos (implementados en `scripts/lib/client.js`)

| Situación | Comportamiento |
|---|---|
| Intervalo mínimo entre peticiones | 350 ms (configurable `http.minIntervalMs`) |
| 429 | Respeta `Retry-After` (segundos o fecha HTTP); si no viene, backoff exponencial con jitter (1 s → 60 s) |
| 408 / 5xx / error de red | Mismo backoff |
| Reintentos máximos | 5 (configurable `http.maxRetries`), después `RATE_LIMITED` o `UPSTREAM_ERROR` |
| 404 | `NOT_FOUND` sin reintento |
| Respuesta HTML en endpoint JSON | `CF_CHALLENGE` sin reintento |

OpenAI no publica los umbrales de rate limit de este backend (DESCONOCIDO); los valores anteriores son conservadores.

## Alternativa oficial

Settings → Data controls → Export data (correo con un ZIP que incluye `conversations.json`, mismo
formato `mapping`). La skill lo procesa con `--from-file conversations.json` (sin descargar binarios).
No incluye metadatos de Proyectos en todos los casos (NO VERIFICADO).
