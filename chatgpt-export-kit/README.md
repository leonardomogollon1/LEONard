# ChatGPT Export Kit — Skill + Plugin MCP

Exporta conversaciones y Proyectos de ChatGPT a **DOCX**, **PDF** y un **ZIP organizado**:

```
export_{id}_{timestamp}/
├── documentos/   conversacion_completa.docx · conversacion_completa.pdf
├── outputs/      01_{output}/version_1.ext · version_2_mejorada.ext …
├── adjuntos/     archivos subidos por el usuario (si los hay)
└── metadatos/    resumen.json · raw/conversacion_{id}.json
```

| Componente | Ruta | Qué es |
|---|---|---|
| Skill | `skills/chatgpt-export/` | `SKILL.md` + `scripts/` (CLI y librería Node.js) + `references/` + `assets/` |
| Servidor MCP | `server/` | `index.js` (Streamable HTTP + OAuth 2.1, o stdio), `openapi.yaml` |
| Manifiesto | `plugin.json` (+ copia en `.codex-plugin/plugin.json`) y `.mcp.json` | Empaquetado como plugin |

> **Aviso importante (leer antes de desplegar).** OpenAI no ofrece API pública ni OAuth para leer
> conversaciones de chatgpt.com. Este kit usa el **backend web no documentado** (el mismo que
> `chatgpt-exporter`), autenticado con el `accessToken` de `/api/auth/session` o con la cookie de sesión
> del usuario. Puede dejar de funcionar sin aviso, recibir desafíos anti-bot desde servidores, y su uso
> automatizado puede estar restringido por los Términos de OpenAI. Úsalo solo con la cuenta propia de
> cada usuario y valida el encaje legal/contractual antes de ofrecerlo a terceros. La alternativa
> oficial es *Settings → Data controls → Export data* + `--from-file`.
> El **OAuth 2.1** de este kit autoriza a los clientes MCP frente a **este servidor**; no es un OAuth de OpenAI.

---

## 1. Requisitos

- Node.js ≥ 20 (verificado con 22.23.5), npm ≥ 9.
- Linux x64/arm64, macOS o Windows con binarios precompilados de `@napi-rs/canvas` (se instalan solos).
- Para producción: dominio con HTTPS (requisito de OAuth 2.1) y almacenamiento persistente opcional.

## 2. Instalación

```bash
cd chatgpt-export-kit
npm install          # instala skill + servidor (workspaces) con las versiones fijadas
npm test             # 11 pruebas de la skill + 6 de extremo a extremo del servidor (sin red)
```

`package.json` fija `@cantoo/pdf-lib@2.7.4` y `zod@^4.6.7` mediante `overrides`. **No los quites**:
con `@cantoo/pdf-lib` ≥ 2.8 el PDF falla (ver `skills/chatgpt-export/references/dependencies.md`).

## 3. Uso como skill (CLI)

```bash
export CHATGPT_ACCESS_TOKEN='eyJhbGciOi…'     # https://chatgpt.com/api/auth/session → "accessToken"
# o bien (renovable): export CHATGPT_SESSION_TOKEN='<cookie __Secure-next-auth.session-token>'

# Conversación
node skills/chatgpt-export/scripts/export.js "https://chatgpt.com/c/<uuid>" --out ./exports

# Proyecto (URL, ID g-p-… o nombre)
node skills/chatgpt-export/scripts/export.js "project:Mi proyecto" --project --out ./exports

# Sin red, desde la exportación oficial de datos (o un JSON de conversación)
node skills/chatgpt-export/scripts/export.js --from-file conversations.json --out ./exports
```

Opciones: `--no-pdf`, `--no-docx`, `--no-attachments`, `--no-raw`, `--max-conversations N`, `--json`, `--quiet`.
Salida: JSON en stdout (`zipPath`, `sha256`, `totales`, `completo`, `errores`). Códigos de salida:
`2` entrada inválida · `3` token caducado · `4` rate limit · `5` no encontrado · `6` error/bloqueo de ChatGPT.

Para instalar la skill en un agente (Codex u otro compatible con `SKILL.md`), copia o enlaza
`skills/chatgpt-export/` en su directorio de skills y ejecuta `npm install` dentro de ella.

## 4. Servidor MCP

### 4.1 Variables de entorno

| Variable | Obligatoria | Por defecto | Descripción |
|---|---|---|---|
| `PUBLIC_BASE_URL` | Sí (prod) | `http://localhost:8787` | URL pública https; es el *issuer* OAuth. El recurso MCP es `<PUBLIC_BASE_URL>/mcp` |
| `PORT` | No | `8787` | Puerto de escucha |
| `TOKEN_ENC_KEY` | Sí (prod) | efímera | 32 bytes base64 (AES-256-GCM de las credenciales de ChatGPT). `openssl rand -base64 32` |
| `DOWNLOAD_SIGNING_KEY` | Sí (prod) | efímera | 32 bytes base64 (HMAC de enlaces de descarga) |
| `NODE_ENV` | No | — | `production` exige https y las dos claves |
| `EXPORT_DIR` | No | `$TMPDIR/chatgpt-export-mcp` | Carpeta de ZIPs generados |
| `DOWNLOAD_TTL_SECONDS` | No | `3600` | Vida del enlace temporal; los ZIP más antiguos se borran cada 10 min |
| `ACCESS_TOKEN_TTL_SECONDS` / `REFRESH_TOKEN_TTL_SECONDS` | No | `3600` / `2592000` | Vida de los tokens OAuth del servidor |
| `ALLOWED_REDIRECT_HOSTS` | Recomendado | (cualquiera https/localhost) | Hosts admitidos en `redirect_uri` del registro dinámico, separados por comas |
| `VERIFY_CHATGPT_ON_CONSENT` | No | `true` | Valida la credencial contra ChatGPT al aprobar |
| `EXPORTS_PER_HOUR` | No | `20` | Cuota por autorización (además: 1 exportación simultánea y 60 req/min por IP) |
| `CHATGPT_BASE_URL` | No | `https://chatgpt.com` | Solo para pruebas con un backend simulado |

### 4.2 Arranque local

```bash
cd server
TOKEN_ENC_KEY=$(openssl rand -base64 32) DOWNLOAD_SIGNING_KEY=$(openssl rand -base64 32) npm start
# MCP: http://localhost:8787/mcp   ·   Metadatos: /.well-known/oauth-protected-resource
```

Modo stdio (cliente MCP local, sin OAuth; credencial por entorno):

```bash
CHATGPT_ACCESS_TOKEN='…' node server/index.js --stdio
```

### 4.3 Endpoints

| Ruta | Función |
|---|---|
| `POST /mcp` | MCP Streamable HTTP (sin estado, respuestas JSON). Herramientas `export_conversation`, `export_project` |
| `/.well-known/oauth-protected-resource[/mcp]` | RFC 9728 |
| `/.well-known/oauth-authorization-server` | RFC 8414 (incluye `authorization_response_iss_parameter_supported: true`) |
| `/register`, `/authorize`, `/token`, `/revoke` | OAuth 2.1: registro dinámico (RFC 7591), código + PKCE S256, refresh con rotación |
| `POST /oauth/consent` | Pantalla de consentimiento: el usuario vincula su credencial de ChatGPT (se guarda cifrada) |
| `POST /api/v1/export/{conversation,project}` | API REST equivalente (ver `server/openapi.yaml`) |
| `GET /downloads/{name}?exp&sig` | Descarga del ZIP con enlace temporal HMAC |
| `GET /healthz`, `GET /docs/openapi.yaml` | Salud y especificación |

### 4.4 Flujo de autorización

1. El cliente MCP llama a `/mcp` sin token → `401` con `WWW-Authenticate: Bearer resource_metadata="…"`.
2. Descubre el servidor de autorización, se registra en `/register` y abre `/authorize` (PKCE S256, `resource=<PUBLIC_BASE_URL>/mcp`).
3. El usuario pega su `accessToken` (y opcionalmente la cookie de sesión) y aprueba. Redirect con `code`, `state` e `iss`.
4. El cliente canjea el código en `/token` y llama a las herramientas con `Authorization: Bearer`.
5. **Token de ChatGPT caducado/rechazado:** si había cookie, se renueva automáticamente; si no, la herramienta
   devuelve `TOKEN_EXPIRED`, el servidor **revoca el grant** y la siguiente llamada recibe `401` → el cliente
   repite la autorización.
6. **Rate limit de ChatGPT:** reintentos con `Retry-After`/backoff; si persiste, `RATE_LIMITED` (REST: `429` + `Retry-After`).

### 4.5 Despliegue (producción)

```bash
# Ejemplo con contenedor Node (cualquier PaaS con HTTPS sirve)
NODE_ENV=production PUBLIC_BASE_URL=https://export.midominio.com \
TOKEN_ENC_KEY=… DOWNLOAD_SIGNING_KEY=… ALLOWED_REDIRECT_HOSTS=chatgpt.com \
EXPORT_DIR=/data/exports node server/index.js
```

- Detrás de un proxy TLS (se usa `trust proxy = 1`). Timeout del proxy ≥ 10 min: un proyecto grande tarda.
- **Una sola instancia**: clientes, códigos, tokens y grants viven en memoria (se pierden al reiniciar → los
  usuarios re-autorizan). Para varias instancias, sustituye los `Map` de `server/lib/oauth-provider.js` por
  Redis/BD y usa almacenamiento compartido para `EXPORT_DIR`.
- Gestiona `TOKEN_ENC_KEY` y `DOWNLOAD_SIGNING_KEY` en un gestor de secretos; nunca en el repositorio.
- Sustituye `YOUR-HOST.example.com` en `.mcp.json` y `server/openapi.yaml`, y `author` en `plugin.json`.

### 4.6 Conectarlo a un cliente

- **Plugin (Codex/OpenAI):** `plugin.json` declara `skills: ./skills/` y `mcpServers: ./.mcp.json`
  (copia en `.codex-plugin/plugin.json` por compatibilidad). Ver nota de verificación (§6).
- **ChatGPT (Apps/conectores):** añade `https://<host>/mcp` como servidor MCP remoto con OAuth.
- **Cualquier cliente MCP con OAuth:** URL `https://<host>/mcp`.

## 5. Pruebas manuales

```bash
# 1) Sin red, con el fixture sintético
node skills/chatgpt-export/scripts/export.js --from-file skills/chatgpt-export/assets/sample-conversation.json --out /tmp/x
unzip -l /tmp/x/export_*.zip

# 2) Con una conversación real (credencial propia)
CHATGPT_ACCESS_TOKEN='…' node skills/chatgpt-export/scripts/export.js "https://chatgpt.com/c/<uuid>" --out /tmp/x

# 3) Servidor: metadatos y 401
curl -s localhost:8787/.well-known/oauth-protected-resource | jq
curl -si -X POST localhost:8787/mcp | grep -i www-authenticate

# 4) Inspector MCP (flujo OAuth interactivo)
npx @modelcontextprotocol/inspector   # URL: http://localhost:8787/mcp, transporte Streamable HTTP
```

Comprobaciones de aceptación: el nº de mensajes de `resumen.json` = nº de nodos con mensaje del JSON
`raw/`; los mensajes aparecen en orden de `create_time`; los ocultos y las ramas alternativas están
marcados; cada carpeta de `outputs/` tiene `version_1` y, si procede, `version_N_mejorada`.

## 6. Estado de verificación

| Elemento | Estado |
|---|---|
| Pipeline completo (parseo, outputs, DOCX, PDF, ZIP) | VERIFICADO con fixture sintético y backend simulado (`npm test`); DOCX y PDF revisados visualmente |
| OAuth 2.1 (DCR, PKCE, código de un uso, rotación de refresh, 401 + `resource_metadata`, revocación por token caducado) | VERIFICADO por pruebas de extremo a extremo |
| Endpoints de ChatGPT de conversación, proyectos y archivos | Tomados de `chatgpt-exporter` 1.1.0; **NO probados contra chatgpt.com** desde este entorno |
| Descarga de archivos del intérprete (`interpreter/download`) | **NO VERIFICADO**; si falla queda `*.FALTANTE.txt` y `completo: false` |
| Esquema de `plugin.json` / `.codex-plugin/plugin.json` / `.mcp.json` | Basado en búsqueda sobre la documentación de OpenAI (developers.openai.com no fue accesible desde aquí); **validar** contra la versión vigente antes de publicar |
| `_meta.securitySchemes` y `_meta["mcp/www_authenticate"]` (Apps SDK) | Según la guía de autenticación del Apps SDK; **validar** con la versión vigente |
| OpenAPI | Validado con `@apidevtools/swagger-parser` |

## 7. Estructura del repositorio

```
chatgpt-export-kit/
├── plugin.json · .codex-plugin/plugin.json · .mcp.json · package.json
├── skills/chatgpt-export/
│   ├── SKILL.md · package.json
│   ├── scripts/export.js
│   ├── scripts/lib/{auth,client,target,fetcher,parser,outputs,markdown,labels,docx-builder,pdf-builder,zipper,pipeline,offline,errors,util}.js
│   ├── references/{chatgpt-backend-api,message-schema,output-detection,resumen-schema,dependencies}.md
│   ├── assets/{sample-conversation.json, fonts/DejaVuSansMono*.ttf}
│   └── tests/{skill.test.js, build-fixture.mjs}
└── server/
    ├── index.js · package.json · openapi.yaml
    ├── lib/{config,vault,oauth-provider,consent,exports,tools}.js
    └── tests/server.test.js
```
