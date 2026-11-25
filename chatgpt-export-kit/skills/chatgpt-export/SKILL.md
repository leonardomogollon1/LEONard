---
name: chatgpt-export
description: Exporta una conversación o un Proyecto completo de ChatGPT (todos los mensajes, incluidos sistema, ocultos y ramas alternativas, más adjuntos y outputs con sus versiones mejoradas) a un DOCX y un PDF profesionales y a un ZIP organizado en documentos/, outputs/ y metadatos/resumen.json. Usar cuando el usuario pida exportar, archivar, respaldar o descargar una conversación o proyecto de ChatGPT a partir de su link o ID.
---

# ChatGPT Export

Convierte un link/ID de ChatGPT en `export_{id}_{timestamp}.zip`:

```
export_{id}_{timestamp}/
├── documentos/
│   ├── conversacion_completa.docx
│   └── conversacion_completa.pdf
├── outputs/
│   ├── 01_{nombre_output}/
│   │   ├── version_1.ext
│   │   └── version_2_mejorada.ext
│   └── ...
├── adjuntos/                 (archivos subidos por el usuario, si los hay)
└── metadatos/
    ├── resumen.json          (fecha, proyecto, nº de mensajes, outputs, fallos)
    └── raw/conversacion_{id}.json   (JSON original, para auditoría; desactivable con --no-raw)
```

En un proyecto, `documentos/`, `outputs/` y `adjuntos/` contienen una subcarpeta `NN_{titulo}/` por conversación.

## Requisitos

- Node.js ≥ 20. Instalar dependencias una vez desde la raíz del kit: `npm install`
  (o `npm install` dentro de esta carpeta si se usa la skill sola).
- Una credencial de ChatGPT de la cuenta propietaria de la conversación, en variables de entorno:
  - `CHATGPT_ACCESS_TOKEN`: valor `accessToken` de `https://chatgpt.com/api/auth/session` (abrir con la sesión iniciada). Caduca.
  - o `CHATGPT_SESSION_TOKEN`: cookie `__Secure-next-auth.session-token`; permite renovar el accessToken automáticamente.
  - **Nunca** pedir al usuario que pegue la credencial en el chat ni escribirla en archivos del repositorio.

## Flujo (ejecutar en este orden)

1. **Identificar el objetivo.** Aceptar `https://chatgpt.com/c/<uuid>`, `…/g/g-p-<id>-<slug>/c/<uuid>`, `…/g/g-p-<id>-<slug>/project`, un UUID, `g-p-<id>` o `project:<nombre exacto>`. Los enlaces `/share/` no se admiten: pedir la URL original `/c/…`.
2. **Comprobar credencial.** Si no hay `CHATGPT_ACCESS_TOKEN` ni `CHATGPT_SESSION_TOKEN`, indicar al usuario cómo obtenerla (paso anterior) y detenerse.
3. **Ejecutar la exportación** (desde la raíz de esta skill):
   - Conversación: `node scripts/export.js "<link-o-id>" --out ./exports`
   - Proyecto: `node scripts/export.js "<link-proyecto|g-p-id|project:Nombre>" --project --out ./exports`
   - Opciones: `--no-pdf`, `--no-docx`, `--no-attachments`, `--no-raw`, `--max-conversations N`, `--json` (resumen completo), `--quiet`.
   - Sin red / desde la exportación oficial de datos de ChatGPT: `node scripts/export.js --from-file conversations.json --out ./exports`.
4. **Leer el JSON de stdout.** Contiene `zipPath`, `sha256`, `totales`, `completo` y `errores`.
5. **Entregar el ZIP** al usuario como archivo descargable (o enlace temporal si se usa el plugin MCP). Informar siempre:
   - nº de mensajes y de outputs/versiones;
   - si `completo` es `false`, qué falló (`errores`, `adjuntosFallidos` en `metadatos/resumen.json`). No presentar una exportación incompleta como completa.

## Qué hace internamente

| Paso | Módulo | Detalle |
|---|---|---|
| Link → objetivo | `scripts/lib/target.js` | Reconoce conversación/proyecto |
| Credencial | `scripts/lib/auth.js` | Lee `exp` del JWT; renueva vía `/api/auth/session` si hay cookie |
| HTTP | `scripts/lib/client.js` | Throttling, reintentos con backoff+jitter, `Retry-After`, renovación ante 401/403, detección de desafío anti-bot |
| Descarga | `scripts/lib/fetcher.js` | `/backend-api/conversation/{id}`, proyectos (`gizmos/…`), archivos (`files/download/{id}`) |
| Parseo | `scripts/lib/parser.js` | Todos los nodos del árbol `mapping`; orden cronológico; marca ocultos, ramas y versiones |
| Outputs | `scripts/lib/outputs.js` | Canvas, bloques de código, archivos del intérprete e imágenes; agrupa versiones mejoradas |
| DOCX | `scripts/lib/docx-builder.js` | Librería `docx`: portada, resumen, índice, hilo, tabla de outputs |
| PDF | `scripts/lib/pdf-builder.js` | Librería `pretext-pdf`: mismo contenido, marcadores, cabecera/pie |
| ZIP | `scripts/lib/zipper.js` | Librería `archiver`; SHA-256 del ZIP |

## Errores y cómo actuar

| Código (`error`) | Exit | Acción |
|---|---|---|
| `INVALID_INPUT` | 2 | Pedir un link/ID válido |
| `TOKEN_EXPIRED` | 3 | Pedir un accessToken nuevo (o la cookie de sesión) |
| `RATE_LIMITED` | 4 | Esperar (`retryAfterMs` si existe) y reintentar; para proyectos grandes usar `--max-conversations` |
| `NOT_FOUND` | 5 | Verificar que la conversación pertenece a la cuenta de la credencial |
| `CF_CHALLENGE` / `UPSTREAM_ERROR` | 6 | ChatGPT bloqueó la petición o cambió su backend; usar `--from-file` con la exportación oficial de datos |

## Reglas

- No omitir mensajes: el documento incluye sistema, herramientas, contexto oculto, razonamiento y ramas alternativas, marcados como tales.
- La detección de outputs y de "versión mejorada" es heurística: ver `references/output-detection.md` antes de afirmar que una agrupación es exacta.
- La fuente es el backend web **no documentado** de ChatGPT (ver `references/chatgpt-backend-api.md`): puede cambiar sin aviso y su uso automatizado puede estar sujeto a los Términos de OpenAI. Exportar solo conversaciones de la propia cuenta del usuario.

## Referencias

- `references/chatgpt-backend-api.md` — endpoints, autenticación, paginación, límites.
- `references/message-schema.md` — estructura de `mapping`, tipos de contenido y cómo se representan.
- `references/output-detection.md` — reglas de outputs y versiones; limitaciones.
- `references/resumen-schema.md` — esquema de `metadatos/resumen.json`.
- `references/dependencies.md` — versiones verificadas y problemas conocidos de las librerías.
- `assets/sample-conversation.json` — conversación **sintética** para pruebas (`npm test`).
