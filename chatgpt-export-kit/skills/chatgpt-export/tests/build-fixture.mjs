// Genera assets/sample-conversation.json: conversación SINTÉTICA (no son datos reales)
// que reproduce la estructura del JSON de /backend-api/conversation/{id}.
import fs from 'node:fs';
const T0 = 1764000000; // 2025-11-24T16:00:00Z
const mapping = {};
let t = T0;
function node(id, parent, message) {
  mapping[id] = { id, parent, children: [], message };
  if (parent) mapping[parent].children.push(id);
}
const msg = (id, role, content, extra = {}) => ({
  id, author: { role, name: extra.name ?? null, metadata: {} },
  create_time: extra.noTime ? null : (t += 30), update_time: null,
  content, status: 'finished_successfully', end_turn: role === 'assistant' ? true : null,
  weight: 1, metadata: extra.metadata ?? {}, recipient: extra.recipient ?? 'all',
});
const text = (s) => ({ content_type: 'text', parts: [s] });
node('root', null, null);
node('sys', 'root', msg('sys', 'system', text(''), { metadata: { is_visually_hidden_from_conversation: true } }));
node('ctx', 'sys', msg('ctx', 'user', { content_type: 'user_editable_context', user_profile: 'Ingeniero de datos', user_instructions: 'Responde en español.' }, { metadata: { is_visually_hidden_from_conversation: true } }));
node('u1', 'ctx', msg('u1', 'user', text('Escribe un script `etl.py` que lea un CSV y calcule la media por columna.')));
node('a1', 'u1', msg('a1', 'assistant', text('Aquí tienes una primera versión.\n\n**etl.py**\n```python\nimport csv\n\ndef medias(path):\n    with open(path) as f:\n        rows = list(csv.DictReader(f))\n    return {k: sum(float(r[k]) for r in rows) / len(rows) for k in rows[0]}\n```\n\nEjecuta `python etl.py`.'), { metadata: { model_slug: 'gpt-5' } }));
node('a1b', 'u1', msg('a1b', 'assistant', text('Versión regenerada:\n\n```python\n# etl.py\nimport pandas as pd\n\ndef medias(path):\n    df = pd.read_csv(path)\n    return df.mean(numeric_only=True).to_dict()\n```'), { metadata: { model_slug: 'gpt-5' } }));
node('u2', 'a1', msg('u2', 'user', text('Mejóralo: maneja valores vacíos y añade CLI.')));
node('th', 'u2', msg('th', 'assistant', { content_type: 'thoughts', thoughts: [{ summary: 'Planificando mejoras', content: 'Ignorar celdas vacías y usar argparse.' }] }));
node('a2', 'th', msg('a2', 'assistant', text('### Versión mejorada\n\n- Ignora celdas vacías\n- Añade CLI con argparse\n\n**etl.py**\n```python\nimport csv\nimport argparse\n\ndef medias(path):\n    with open(path) as f:\n        rows = list(csv.DictReader(f))\n    out = {}\n    for k in rows[0]:\n        vals = [float(r[k]) for r in rows if r[k].strip()]\n        out[k] = sum(vals) / len(vals) if vals else None\n    return out\n\nif __name__ == "__main__":\n    p = argparse.ArgumentParser()\n    p.add_argument("csv")\n    print(medias(p.parse_args().csv))\n```')));
node('u3', 'a2', msg('u3', 'user', text('Crea un informe en canvas con los resultados.')));
node('c1', 'u3', msg('c1', 'assistant', { content_type: 'code', language: 'json', text: JSON.stringify({ name: 'Informe ETL', type: 'document', content: '# Informe ETL\n\nResultados preliminares.\n\nConclusión: pendiente.' }) }, { recipient: 'canmore.create_textdoc' }));
node('c1t', 'c1', msg('c1t', 'tool', text('Successfully created text document'), { name: 'canmore.create_textdoc', metadata: { canvas: { textdoc_id: 'doc123', version: 1 } } }));
node('u4', 'c1t', msg('u4', 'user', text('Mejora la conclusión.')));
node('c2', 'u4', msg('c2', 'assistant', { content_type: 'code', language: 'json', text: JSON.stringify({ updates: [{ pattern: 'Conclusión: pendiente\\.', multiple: false, replacement: 'Conclusión: la columna B presenta la media más alta (4,2).' }] }) }, { recipient: 'canmore.update_textdoc' }));
node('c2t', 'c2', msg('c2t', 'tool', text('Successfully updated text document'), { name: 'canmore.update_textdoc', metadata: { canvas: { textdoc_id: 'doc123', version: 2 } } }));
node('py', 'c2t', msg('py', 'assistant', { content_type: 'code', language: 'python', text: 'import pandas as pd\npd.DataFrame({"a":[1]}).to_csv("/mnt/data/medias.csv")' }, { recipient: 'python' }));
node('pyo', 'py', msg('pyo', 'tool', { content_type: 'execution_output', text: 'OK' }, { name: 'python' }));
node('a3', 'pyo', msg('a3', 'assistant', text('He generado el archivo: [medias.csv](sandbox:/mnt/data/medias.csv)'), { noTime: true }));
node('img', 'a3', msg('img', 'tool', { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-IMG123', width: 1024, height: 1024 }] }, { name: 'dalle.text2im' }));
node('u5', 'img', msg('u5', 'user', text('Gracias 😀 — ¿alguna nota final?')));
node('a5', 'u5', msg('a5', 'assistant', text('Nota con cita \uE200cite\uE202turn0search1\uE201 y tabla:\n\n| Col | Media |\n|---|---|\n| A | 3,1 |\n| B | 4,2 |\n\n> Revisión pendiente de validación humana.')));
const conv = { id: '00000000-0000-4000-8000-000000000001', conversation_id: '00000000-0000-4000-8000-000000000001',
  title: 'Fixture sintético: ETL con versiones', create_time: T0, update_time: t + 60, mapping, current_node: 'a5',
  default_model_slug: 'gpt-5', gizmo_id: null, is_archived: false };
fs.writeFileSync(new URL('../assets/sample-conversation.json', import.meta.url), JSON.stringify(conv, null, 2));
console.log('nodos:', Object.keys(mapping).length);
