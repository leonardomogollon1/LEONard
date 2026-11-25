/**
 * Prueba de extremo a extremo del servidor contra un backend de ChatGPT SIMULADO (fixture sintético).
 * Cubre: metadatos RFC 9728/8414, registro dinámico, consentimiento, PKCE S256, token, MCP tools/call,
 * descarga firmada, rotación de refresh token y re-autorización por token de ChatGPT caducado.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const FIXTURE = JSON.parse(await fs.readFile(new URL('../../skills/chatgpt-export/assets/sample-conversation.json', import.meta.url), 'utf8'));
const EXPIRED_CONV = '11111111-1111-4111-8111-111111111111';
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const jwt = (exp) => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;

let mock, server, base, exportDir;
const state = {};

before(async () => {
  // ChatGPT simulado
  const mockPort = await freePort();
  mock = http.createServer((req, res) => {
    const send = (s, b) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.url.startsWith(`/backend-api/conversation/${EXPIRED_CONV}`)) return send(401, { detail: 'expired' });
    if (req.url.startsWith('/backend-api/conversations')) return send(200, { items: [], total: 0, limit: 1, offset: 0 });
    if (req.url.startsWith('/backend-api/conversation/')) return send(200, FIXTURE);
    return send(404, {});
  }).listen(mockPort);

  const port = await freePort();
  base = `http://localhost:${port}`;
  exportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cgx-srv-'));
  Object.assign(process.env, {
    PORT: String(port), PUBLIC_BASE_URL: base, EXPORT_DIR: exportDir, CHATGPT_BASE_URL: `http://127.0.0.1:${mockPort}`,
    TOKEN_ENC_KEY: crypto.randomBytes(32).toString('base64'), DOWNLOAD_SIGNING_KEY: crypto.randomBytes(32).toString('base64'),
  });
  const { createApp } = await import('../index.js');
  const { app } = createApp();
  server = app.listen(port);
});

after(async () => {
  server?.close();
  mock?.close();
  await fs.rm(exportDir, { recursive: true, force: true });
});

test('metadatos OAuth publicados', async () => {
  const prm = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json();
  assert.equal(prm.resource, `${base}/mcp`);
  assert.deepEqual(prm.authorization_servers, [`${base}/`]);
  const as = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.equal(as.authorization_response_iss_parameter_supported, true);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  state.as = as;
});

test('MCP sin token → 401 con WWW-Authenticate resource_metadata', async () => {
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate'), /resource_metadata="http:\/\/localhost:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
});

async function authorize(accessToken) {
  const redirect = 'http://localhost:9/callback';
  const reg = await (await fetch(state.as.registration_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'test', redirect_uris: [redirect], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
  })).json();
  assert.ok(reg.client_id);
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'st8', scope: 'export', resource: `${base}/mcp` });
  const page = await (await fetch(`${state.as.authorization_endpoint}?${q}`)).text();
  const requestId = page.match(/name="request_id" value="([^"]+)"/)[1];
  const consent = await fetch(`${base}/oauth/consent`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ request_id: requestId, action: 'approve', access_token: accessToken }),
  });
  assert.equal(consent.status, 302);
  const loc = new URL(consent.headers.get('location'));
  assert.equal(loc.searchParams.get('state'), 'st8');
  assert.equal(loc.searchParams.get('iss'), base);
  const tok = await fetch(state.as.token_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: loc.searchParams.get('code'), code_verifier: verifier, client_id: reg.client_id, redirect_uri: redirect, resource: `${base}/mcp` }),
  });
  assert.equal(tok.status, 200);
  const tokens = await tok.json();
  // El código es de un solo uso
  const replay = await fetch(state.as.token_endpoint, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: loc.searchParams.get('code'), code_verifier: verifier, client_id: reg.client_id, redirect_uri: redirect }),
  });
  assert.equal(replay.status, 400);
  return { tokens, clientId: reg.client_id };
}

async function mcpClient(accessToken) {
  const client = new Client({ name: 't', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
  return client;
}

test('flujo completo: OAuth → tools/list → export_conversation → descarga firmada', async () => {
  const { tokens, clientId } = await authorize(jwt(Math.floor(Date.now() / 1000) + 3600));
  state.tokens = tokens;
  state.clientId = clientId;
  const client = await mcpClient(tokens.access_token);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['export_conversation', 'export_project']);
  assert.deepEqual(tools[0]._meta?.securitySchemes, [{ type: 'oauth2', scopes: ['export'] }]);

  const res = await client.callTool({ name: 'export_conversation', arguments: { conversation: `https://chatgpt.com/c/${FIXTURE.id}`, include_pdf: false } });
  assert.ok(!res.isError, JSON.stringify(res.content));
  const sc = res.structuredContent;
  assert.equal(sc.totals.mensajes, 20);
  assert.ok(res.content.some((c) => c.type === 'resource_link'));

  const dl = await fetch(sc.download_url);
  assert.equal(dl.status, 200);
  const buf = Buffer.from(await dl.arrayBuffer());
  assert.equal(crypto.createHash('sha256').update(buf).digest('hex'), sc.sha256);
  const tampered = new URL(sc.download_url);
  tampered.searchParams.set('exp', String(Number(tampered.searchParams.get('exp')) + 1));
  assert.equal((await fetch(tampered)).status, 403);
  await client.close();
});

test('refresh token con rotación', async () => {
  const body = (rt) => new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: state.clientId });
  const r1 = await fetch(state.as.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body(state.tokens.refresh_token) });
  assert.equal(r1.status, 200);
  const r2 = await fetch(state.as.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body(state.tokens.refresh_token) });
  assert.equal(r2.status, 400, 'el refresh token anterior queda invalidado');
});

test('token de ChatGPT rechazado → error TOKEN_EXPIRED y revocación del grant (401 después)', async () => {
  const { tokens } = await authorize(jwt(Math.floor(Date.now() / 1000) + 3600));
  const client = await mcpClient(tokens.access_token);
  const res = await client.callTool({ name: 'export_conversation', arguments: { conversation: EXPIRED_CONV } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /TOKEN_EXPIRED/);
  await client.close().catch(() => {});
  const after = await fetch(`${base}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(after.status, 401);
});

test('API REST protegida y con validación de entrada', async () => {
  const { tokens } = await authorize(jwt(Math.floor(Date.now() / 1000) + 3600));
  const r = await fetch(`${base}/api/v1/export/conversation`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' }, body: JSON.stringify({}) });
  assert.equal(r.status, 400);
  const ok = await fetch(`${base}/api/v1/export/conversation`, { method: 'POST', headers: { Authorization: `Bearer ${tokens.access_token}`, 'content-type': 'application/json' }, body: JSON.stringify({ conversation: FIXTURE.id, include_pdf: false }) });
  assert.equal(ok.status, 200);
  const j = await ok.json();
  assert.ok(j.download_url && !('local_path' in j));
});
