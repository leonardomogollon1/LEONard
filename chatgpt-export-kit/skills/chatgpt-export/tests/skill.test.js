import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseConversation } from '../scripts/lib/parser.js';
import { detectOutputs } from '../scripts/lib/outputs.js';
import { parseTarget } from '../scripts/lib/target.js';
import { CredentialProvider } from '../scripts/lib/auth.js';
import { ChatGPTClient, parseRetryAfter } from '../scripts/lib/client.js';
import { AuthExpiredError, InputError, RateLimitError } from '../scripts/lib/errors.js';
import { exportFromFile } from '../scripts/lib/offline.js';
import { exportConversation } from '../scripts/lib/pipeline.js';

const FIXTURE = new URL('../assets/sample-conversation.json', import.meta.url);
const loadFixture = async () => JSON.parse(await fs.readFile(FIXTURE, 'utf8'));
const jwt = (exp) => `x.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.y`;
const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('parser: incluye TODOS los nodos con mensaje (sistema, ocultos, ramas) en orden cronológico', async () => {
  const raw = await loadFixture();
  const conv = parseConversation(raw);
  const withMsg = Object.values(raw.mapping).filter((n) => n.message).length;
  assert.equal(conv.messages.length, withMsg);
  assert.equal(conv.stats.structuralNodes, 1);
  assert.ok(conv.messages.some((m) => m.role === 'system' && m.hidden));
  assert.ok(conv.messages.some((m) => m.contentType === 'user_editable_context' && m.hidden));
  assert.ok(conv.messages.some((m) => m.contentType === 'thoughts'));
  const alt = conv.messages.find((m) => m.nodeId === 'a1b');
  assert.equal(alt.onCurrentPath, false);
  assert.equal(alt.siblingCount, 2);
  for (let i = 1; i < conv.messages.length; i++) assert.ok(conv.messages[i].effectiveTime >= conv.messages[i - 1].effectiveTime);
  const inferred = conv.messages.find((m) => m.nodeId === 'a3');
  assert.equal(inferred.timeInferred, true);
});

test('parser: limpia marcadores privados de cita y conserva tipos desconocidos como JSON', () => {
  const conv = parseConversation({
    title: 't', create_time: 1, current_node: 'b',
    mapping: {
      a: { id: 'a', parent: null, children: ['b'], message: { id: 'a', author: { role: 'user' }, create_time: 1, content: { content_type: 'text', parts: ['x citeturn0'] } } },
      b: { id: 'b', parent: 'a', children: [], message: { id: 'b', author: { role: 'assistant' }, create_time: 2, content: { content_type: 'nuevo_tipo', foo: 1 } } },
    },
  });
  assert.equal(conv.messages[0].blocks[0].text, 'x [cite: turn0]');
  assert.equal(conv.messages[1].blocks[0].type, 'json');
});

test('outputs: agrupa versiones mejoradas (código por nombre, canvas por textdoc_id)', async () => {
  const conv = parseConversation(await loadFixture());
  const { outputs } = detectOutputs(conv);
  const etl = outputs.find((o) => o.baseName === 'etl');
  assert.ok(etl, 'debe detectar etl.py');
  assert.deepEqual(etl.versions.map((v) => v.fileStem), ['version_1', 'version_2_mejorada', 'version_3_mejorada']);
  assert.equal(etl.versions[1].onCurrentPath, false, 'la regeneración es rama alternativa');
  const canvas = outputs.find((o) => o.kind === 'canvas');
  assert.equal(canvas.versions.length, 2);
  assert.match(canvas.versions[1].content, /media más alta/);
  assert.doesNotMatch(canvas.versions[1].content, /pendiente/);
  assert.ok(outputs.some((o) => o.kind === 'file' && o.baseName === 'medias'));
  assert.ok(outputs.some((o) => o.kind === 'image'));
  assert.deepEqual(outputs.map((o) => o.index), outputs.map((_, i) => i + 1));
});

test('target: interpreta links e IDs', () => {
  const uuid = '6741f0c2-1234-4abc-8def-0123456789ab';
  assert.deepEqual(parseTarget(`https://chatgpt.com/c/${uuid}`).id, uuid);
  const p = parseTarget(`https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-mi-proyecto/c/${uuid}`);
  assert.equal(p.kind, 'conversation');
  assert.equal(p.projectId, 'g-p-0123456789abcdef0123456789abcdef');
  assert.equal(parseTarget('https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-mi-proyecto/project').kind, 'project');
  assert.equal(parseTarget('project:Mi Proyecto').projectName, 'Mi Proyecto');
  assert.equal(parseTarget(uuid).kind, 'conversation');
  assert.throws(() => parseTarget('https://chatgpt.com/share/abc'), InputError);
  assert.throws(() => parseTarget('https://example.com/c/' + uuid), InputError);
  assert.throws(() => parseTarget('https://chatgpt.com/g/g-p-0123456789abcdef0123456789abcdef-x/project', 'conversation'), InputError);
});

test('auth: detecta accessToken caducado por claim exp', async () => {
  const cred = new CredentialProvider({ accessToken: jwt(Math.floor(Date.now() / 1000) - 10) });
  await assert.rejects(cred.getAccessToken(), AuthExpiredError);
  const ok = new CredentialProvider({ accessToken: jwt(Math.floor(Date.now() / 1000) + 3600) });
  assert.ok(await ok.getAccessToken());
  assert.throws(() => new CredentialProvider({}), InputError);
});

test('client: reintenta 429 respetando Retry-After y luego tiene éxito', async () => {
  let calls = 0;
  const fetchImpl = async () => (++calls < 3 ? json(429, {}, { 'retry-after': '0' }) : json(200, { ok: true }));
  const client = new ChatGPTClient(new CredentialProvider({ accessToken: 't' }), { fetchImpl, minIntervalMs: 0, baseDelayMs: 1 });
  assert.deepEqual(await client.json('/backend-api/x'), { ok: true });
  assert.equal(calls, 3);
  assert.equal(client.stats.rateLimited, 2);
  assert.equal(parseRetryAfter('2'), 2000);
});

test('client: 429 persistente → RateLimitError', async () => {
  const fetchImpl = async () => json(429, {}, { 'retry-after': '0' });
  const client = new ChatGPTClient(new CredentialProvider({ accessToken: 't' }), { fetchImpl, minIntervalMs: 0, maxRetries: 2 });
  await assert.rejects(client.json('/backend-api/x'), RateLimitError);
});

test('client: 401 sin cookie → AuthExpiredError; con cookie → renueva vía /api/auth/session', async () => {
  const c1 = new ChatGPTClient(new CredentialProvider({ accessToken: 't' }), { fetchImpl: async () => json(401, {}), minIntervalMs: 0 });
  await assert.rejects(c1.json('/backend-api/x'), AuthExpiredError);

  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push([String(url), init?.headers?.Authorization ?? init?.headers?.Cookie]);
    if (String(url).endsWith('/api/auth/session')) return json(200, { accessToken: 'nuevo' });
    return init.headers.Authorization === 'Bearer nuevo' ? json(200, { ok: 1 }) : json(401, {});
  };
  const cred = new CredentialProvider({ accessToken: 'viejo', sessionToken: 'cookie', fetchImpl });
  const c2 = new ChatGPTClient(cred, { fetchImpl, minIntervalMs: 0 });
  assert.deepEqual(await c2.json('/backend-api/x'), { ok: 1 });
  assert.equal(c2.stats.refreshed, 1);
  assert.ok(seen.some(([u, h]) => u.endsWith('/api/auth/session') && h === '__Secure-next-auth.session-token=cookie'));
});

test('client: respuesta HTML (desafío anti-bot) → CF_CHALLENGE', async () => {
  const fetchImpl = async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } });
  const client = new ChatGPTClient(new CredentialProvider({ accessToken: 't' }), { fetchImpl, minIntervalMs: 0 });
  await assert.rejects(client.json('/backend-api/x'), (e) => e.code === 'CF_CHALLENGE');
});

async function listZip(zipPath) {
  return execFileSync('unzip', ['-Z1', zipPath], { encoding: 'utf8' }).trim().split('\n');
}

test('pipeline offline: ZIP con estructura documentos/ outputs/ metadatos/resumen.json', async () => {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cgx-'));
  const r = await exportFromFile({ file: FIXTURE.pathname, outDir });
  const files = await listZip(r.zipPath);
  const root = r.rootDir;
  assert.match(root, /^export_.+_\d{8}T\d{6}Z$/);
  for (const f of ['documentos/conversacion_completa.docx', 'documentos/conversacion_completa.pdf', 'metadatos/resumen.json', 'outputs/01_etl/version_1.py', 'outputs/01_etl/version_3_mejorada.py']) {
    assert.ok(files.includes(`${root}/${f}`), `falta ${f}`);
  }
  assert.equal(r.resumen.totales.mensajes, 20);
  assert.equal(r.resumen.completo, false, 'offline no descarga binarios → incompleto y declarado');
  await fs.rm(outDir, { recursive: true, force: true });
});

test('pipeline online (fetch simulado): descarga conversación y adjuntos', async () => {
  const raw = await loadFixture();
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const fetchImpl = async (url) => {
    const u = String(url);
    if (u.includes('/backend-api/conversation/') && !u.includes('interpreter')) return json(200, raw);
    if (u.includes('/backend-api/files/download/')) return json(200, { download_url: 'https://files.example/img.png', file_name: 'img.png' });
    if (u.startsWith('https://files.example/')) return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
    if (u.includes('interpreter/download')) return json(404, {});
    return json(404, {});
  };
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cgx-'));
  const cred = new CredentialProvider({ accessToken: 't', fetchImpl });
  const r = await exportConversation({ input: raw.id, credentials: cred, outDir, options: { http: { fetchImpl, minIntervalMs: 0 }, pdf: false } });
  const files = await listZip(r.zipPath);
  assert.ok(files.some((f) => /outputs\/04_imagen_generada_18\/version_1\.png$/.test(f)));
  assert.ok(files.some((f) => /outputs\/03_medias\/version_1\.FALTANTE\.txt$/.test(f)), 'sandbox no disponible → marcador FALTANTE');
  assert.equal(r.resumen.adjuntosFallidos.length, 1);
  await fs.rm(outDir, { recursive: true, force: true });
});
