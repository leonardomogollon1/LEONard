# `metadatos/resumen.json` (schemaVersion 1)

```jsonc
{
  "schemaVersion": 1,
  "exportId": "<id>_20261125T154200Z",
  "fechaExportacion": "2026-11-25T15:42:00.000Z",
  "tipo": "conversacion | proyecto",
  "fuente": "<link o ID recibido>",
  "proyecto": { "id": "g-p-…", "nombre": "…", "resueltoEnBarraLateral": true } | null,
  "completo": true,                      // false si hubo errores o adjuntos no descargados
  "totales": {
    "conversaciones": 1, "mensajes": 20, "outputsDetectados": 4, "versionesDeOutputs": 7,
    "adjuntosDescargados": 1, "adjuntosFallidos": 0, "versionesDuplicadasOmitidas": 0
  },
  "conversaciones": [{
    "id": "…", "titulo": "…", "creada": "ISO", "actualizada": "ISO", "modelo": "…", "proyectoId": null,
    "archivada": false, "numeroMensajes": 20, "mensajesPorRol": { "user": 6, "assistant": 9, "tool": 4, "system": 1 },
    "mensajesOcultos": 10, "mensajesRamasAlternativas": 1, "gruposDeVersiones": 1,
    "nodosEstructuralesSinMensaje": 1, "fechasInferidas": 1, "outputsDetectados": 4,
    "outputs": [{
      "indice": 1, "carpeta": "01_etl", "tipo": "code|canvas|file|image", "nombreBase": "etl", "extension": "py",
      "versiones": [{
        "archivo": "version_2_mejorada.py", "version": 2, "mejorada": true, "mensajeSeq": 5,
        "nodeId": "…", "fecha": "ISO", "ramaPrincipal": false, "origen": "code_block", "sha256": "…", "notas": []
      }]
    }]
  }],
  "adjuntosFallidos": [{ "ref": "file-…", "motivo": "…", "codigo": "NOT_FOUND", "conversacion": "…" }],
  "errores": [{ "conversacion": "…", "etapa": "descarga|pdf", "mensaje": "…", "codigo": "…" }],
  "advertencias": [{ "conversacion": "…", "etapa": "pdf", "mensaje": "…" }],
  "estadisticasHttp": { "requests": 3, "retries": 0, "rateLimited": 0, "refreshed": 0 },
  "notas": ["…"],
  "generador": { "skill": "chatgpt-export", "version": "1.0.0", "node": "v22…" }
}
```

`mensajeSeq` corresponde al número `#N` que aparece en la cabecera de cada mensaje del DOCX/PDF.
