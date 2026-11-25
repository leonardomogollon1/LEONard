# Dependencias: versiones verificadas y problemas conocidos

Verificado el 2026-11-25 con Node.js v22.23.5 en Linux (npm registry).

| Paquete | Versión | Uso | Nota |
|---|---|---|---|
| `docx` | ^9.16.0 | DOCX | — |
| `pretext-pdf` | **2.2.6 (fijada)** | PDF declarativo | Ver problemas abajo |
| `@napi-rs/canvas` | ^0.1.100 | Medición de texto de pretext-pdf | **Obligatoria** en Node; sin ella `render()` falla con `CANVAS_UNAVAILABLE` (el README la presenta como opcional) |
| `@cantoo/pdf-lib` | **2.7.4 (override)** | Dependencia de pretext-pdf | Con 2.8.x–2.11.x el subsetting de fuentes falla: `TypeError: Cannot read properties of undefined (reading 'pos')`. Fijada con `"overrides"` en `package.json` |
| `archiver` | ^8.0.0 | ZIP (API ESM `ZipArchive`) | `npm audit` reporta un aviso moderado en `minimatch` vía `readdir-glob`, solo usado por `archive.glob()`, que la skill no utiliza |
| `@modelcontextprotocol/sdk` | ^1.32.2 | Servidor MCP + OAuth | — |
| `zod` | ^4.6.7 (override) | Esquemas de herramientas | <4.6.6 tiene un aviso alto (GHSA-mrhx-c7xc-m3w5); el override fuerza 4.6.7 también dentro del SDK MCP. Pruebas del servidor verificadas con esta combinación |
| `chatgpt-exporter` | 1.1.0 | **Solo referencia** (no es dependencia) | Endpoints, paginación y manejo de 401/429 replicados en `client.js`/`fetcher.js` |

## Comportamientos de pretext-pdf 2.2.6 sorteados

- **Saltos de línea en `type: 'code'`**: se colapsan (verificado con `pdftotext`), aunque el tipado
  dice que se preservan. Solución: un párrafo monoespaciado por línea con indentación en U+00A0.
- **Emoji / pictogramas**: no hay glifo en Inter ni DejaVu Sans Mono → se sustituyen por `[U+XXXX]`.
- **`callout.content`**: emite aviso de deprecación (será `text` en v3, pero `text` aún no es una
  clave admitida en 2.2.6). El aviso se filtra; el resto de avisos van a `resumen.advertencias`.

## Fuente embebida

`assets/fonts/DejaVuSansMono*.ttf` (licencia Bitstream Vera / dominio público para cambios DejaVu,
ver `assets/fonts/DEJAVU-LICENSE.txt`). Inter 400/700 viene incluida en pretext-pdf.
