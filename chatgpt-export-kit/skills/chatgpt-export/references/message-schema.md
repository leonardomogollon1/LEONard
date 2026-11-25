# Estructura de una conversación y cómo se representa

## Árbol `mapping`

```jsonc
{
  "title": "…", "create_time": 1764000000.0, "update_time": …,
  "current_node": "<id del último nodo de la rama visible>",
  "mapping": {
    "<nodeId>": {
      "id": "<nodeId>",
      "parent": "<nodeId|null>",
      "children": ["<nodeId>", …],          // >1 hijo = regeneración o edición
      "message": {                           // null en nodos estructurales (raíz)
        "id": "…",
        "author": { "role": "system|user|assistant|tool", "name": "python|dalle.text2im|canmore.…|null" },
        "create_time": 1764000030.1,         // puede ser null
        "content": { "content_type": "text", "parts": ["…"] },
        "recipient": "all|python|canmore.create_textdoc|…",
        "metadata": { "is_visually_hidden_from_conversation": true, "attachments": [], "model_slug": "…", "canvas": {…} }
      }
    }
  }
}
```

## Reglas del parser (`scripts/lib/parser.js`)

1. **Todos** los nodos con `message` se convierten en mensajes; nada se filtra. Los nodos sin
   mensaje se cuentan en `nodosEstructuralesSinMensaje`.
2. Recorrido DFS desde cada raíz (y desde nodos huérfanos), para no perder nodos inconsistentes.
3. Orden: `create_time` ascendente; si falta, hereda el del nodo DFS anterior (`fecha inferida`);
   empate → posición DFS. Resultado determinista.
4. `onCurrentPath`: el nodo está en la cadena `current_node → raíz` (rama mostrada en la UI). Los demás
   se marcan como **rama alternativa**.
5. `versionGroup` / `siblingIndex/siblingCount`: si el padre tiene varios hijos con mensaje
   (regeneración de respuesta o edición del mensaje del usuario), se etiqueta "versión i/n".
6. `hidden` + `hiddenReason`: oculto en la interfaz, sistema, contexto/memoria, razonamiento,
   salida de herramienta o llamada a herramienta (`recipient ≠ all`). Se incluyen y se marcan.

## Tipos de contenido

| `content_type` | Representación |
|---|---|
| `text`, `multimodal_text` | Markdown → texto + bloques de código; `image_asset_pointer` → imagen (se incrusta si se descargó); `audio_transcription` → texto "[Audio]" |
| `code` | Bloque de código (lenguaje de `language`) |
| `execution_output` | Bloque "Resultado de ejecución" |
| `tether_quote` | Cita con título y URL |
| `tether_browsing_display` | Resumen/resultado de navegación |
| `system_error` | Texto "[!] Error del sistema" |
| `thoughts` | Lista de pensamientos (resumen + contenido) |
| `reasoning_recap` | Texto |
| `user_editable_context` | Perfil e instrucciones personalizadas del usuario |
| `model_editable_context` | Memoria del modelo |
| Cualquier otro | JSON original íntegro (bloque `json`) — garantiza que no se pierde contenido |

Limpieza de texto: los marcadores privados de citas `U+E200…U+E201` se convierten en `[cite: …]` y
se eliminan caracteres de control inválidos en XML. En el PDF, los emoji (sin glifo en las fuentes
embebidas) se sustituyen por `[U+XXXX]`; el DOCX los conserva.
