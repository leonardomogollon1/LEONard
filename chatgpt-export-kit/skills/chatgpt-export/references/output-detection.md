# Detección de outputs y agrupación de versiones mejoradas

Implementación: `scripts/lib/outputs.js`. Es **heurística**: ChatGPT no marca explícitamente qué es un
"output" ni qué versión mejora a cuál, salvo en Canvas. Toda agrupación queda trazada en
`metadatos/resumen.json` (mensaje de origen, nodo, fecha, rama, SHA-256) para revisión humana.

## Tipos y reglas

| Tipo | Origen | Agrupación en un mismo output | Fiabilidad |
|---|---|---|---|
| `canvas` | Mensajes del asistente con `recipient` `canmore.create_textdoc` / `canmore.update_textdoc` | Por `textdoc_id` (de `metadata.canvas` en la respuesta de la herramienta); si falta, el último canvas creado. Cada `update` aplica sus `updates[].pattern → replacement` (regex) sobre la versión anterior | Alta (estructura explícita); el resultado reconstruido puede diferir si el patrón no coincide (queda en `notas`) |
| `code` | Bloques ``` del asistente (`recipient = all`) con ≥ 3 líneas no vacías (`minCodeLines`) | 1) Mismo nombre de archivo detectado (info string `title=`/nombre, comentario en 1.ª línea `# app.py`, o última línea del texto previo `**app.py**` / `` `app.py`: ``). 2) Regeneración hermana: mismo `versionGroup` y misma posición de bloque. 3) Similitud de Jaccard por líneas ≥ 0,35 (`similarityThreshold`) con la última versión de un output del mismo lenguaje | Media |
| `file` | Enlaces `sandbox:/mnt/data/<archivo>` en el texto del asistente | Mismo nombre de archivo en mensajes distintos = nueva versión | Media (descarga NO VERIFICADA) |
| `image` | `image_asset_pointer` en mensajes `tool`/`assistant` | Una carpeta por turno de generación; cada imagen del turno es una versión | Baja para "mejoras" entre turnos (no se enlazan) |

Los bloques de `execution_output` y las llamadas a herramientas (`recipient ≠ all`) no se tratan como outputs.

## Numeración y nombres

- Outputs ordenados por la primera aparición → carpetas `01_<nombre>`, `02_<nombre>`…
- Versiones ordenadas cronológicamente → `version_1.<ext>`, `version_2_mejorada.<ext>`, `version_3_mejorada.<ext>`…
  "mejorada" significa **posterior** a la versión 1 dentro del mismo grupo; incluye regeneraciones de
  ramas alternativas (marcadas `ramaPrincipal: false` en el resumen).
- Extensión: del nombre detectado; si no, del lenguaje (`LANG_EXT`); `document` de Canvas → `.md`.
- Deduplicación: una versión con contenido idéntico (SHA-256) a otra del mismo output se omite y se
  cuenta en `versionesDuplicadasOmitidas` (`dedupe: false` para desactivarlo). Los mensajes nunca se omiten.
- Binarios no descargables → `version_N.FALTANTE.txt` con la referencia y el motivo.

## Parámetros (`options.outputDetection`)

| Parámetro | Por defecto | Efecto |
|---|---|---|
| `minCodeLines` | 3 | Ignora fragmentos triviales (p. ej. `npm install`) |
| `similarityThreshold` | 0,35 | Más alto = menos agrupación (más outputs separados) |
| `dedupe` | `true` | Omite versiones idénticas |

## Limitaciones conocidas

- Un bloque sin nombre y reescrito casi por completo (similitud < umbral) se tratará como output nuevo.
- Dos archivos distintos sin nombre y muy parecidos en el mismo lenguaje pueden agruparse.
- Imágenes editadas en turnos posteriores no se vinculan con la original.
- Si OpenAI cambia los nombres `canmore.*` o la estructura de `metadata.canvas`, la detección de Canvas
  dejará de funcionar (los mensajes seguirán apareciendo íntegros en el DOCX/PDF).
