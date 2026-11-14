import { hashSecret } from './auth.js';
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import sharp from 'sharp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const proxyKey = 'synthetic-test-proxy-key-not-for-deployments';
const fetch = (url, options = {}) => globalThis.fetch(url, { ...options, redirect: 'manual', headers: { 'X-Agentglade-Proxy-Key': proxyKey, ...options.headers } });
const tokens = { atlas: 'agentglade_' + Buffer.alloc(32, 1).toString('base64url'), nova: 'agentglade_' + Buffer.alloc(32, 2).toString('base64url') };
const hash = (token) => crypto.createHash('sha256').update(token).digest('hex');
const credentials = () => ({ agents: Object.entries(tokens).map(([id, token]) => ({ id, profileId: id, tokenHash: hash(token), enabled: true, expiresAt: null })) });
let root, child, base, keyFile;
async function stop() { if (child && child.exitCode === null && child.signalCode === null) { const exit = once(child, 'exit'); child.kill(); await exit; } }
async function start() {
  const authFile = path.join(root, 'test-auth.json');
  await fs.writeFile(authFile, JSON.stringify({ proxyTokenHash: hashSecret(proxyKey) }), { mode: 0o600 });
  child = spawn(process.execPath, [new URL('./server.js', import.meta.url).pathname], { env: { ...process.env, NODE_ENV: 'production', PORT: '0', AUTH_CONFIG_FILE: authFile, PUBLIC_ORIGIN: 'https://feed.example.test',
    MEMBER_ADMINS: JSON.stringify(['admin-subject']), DATA_DIR: path.join(root, 'data'), MEDIA_DIR: path.join(root, 'media'), AGENT_KEYS_FILE: keyFile,
    MEMBER_ACCOUNTS: JSON.stringify({ 'admin-subject': { name: 'Admin', profileId: 'admin' }, 'editor-subject': { name: 'Editor', profileId: 'editor' } }) }, stdio: ['ignore', 'pipe', 'pipe'] });
  base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Test server did not start')), 10000);
    child.once('error', reject); child.once('exit', () => { clearTimeout(timer); reject(new Error('Test server exited')); });
    child.stdout.on('data', (chunk) => { const match = /listening on :(\d+)/.exec(chunk.toString()); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
  });
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentglade-agent-tests-'));
  await fs.mkdir(path.join(root, 'data'));
  await fs.writeFile(path.join(root, 'data/posts.json'), '{"posts":[]}');
  keyFile = path.join(root, 'agent-keys.json'); await fs.writeFile(keyFile, JSON.stringify(credentials()), { mode: 0o600 });
  await start();
});
afterEach(async () => { await stop(); await fs.rm(root, { recursive: true, force: true }); });
async function call(route, { agent, community, token, json, headers = {}, method = 'GET', body } = {}) {
  const response = await fetch(base + route, { method, body: json !== undefined ? JSON.stringify(json) : body,
    headers: { 'X-Forwarded-Host': 'feed.example.test', ...(agent || token ? { Authorization: `Bearer ${token || tokens[agent]}` } : {}),
      ...(community ? { 'Remote-User': `${community}-subject`, 'Remote-Name': community === 'editor' ? 'Morgan' : 'authentik Default Admin' } : {}),
      ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers } });
  return { status: response.status, body: await response.json().catch(() => null), response };
}
const create = (agent, key = 'test-request-00000001', text = 'An owner-requested update', extra = {}) => call('/api/agent/posts', { agent, method: 'POST', json: { text, ...extra }, headers: { 'Idempotency-Key': key } });
const posts = async () => JSON.parse(await fs.readFile(path.join(root, 'data/posts.json'))).posts;
const profiles = async () => (await call('/api/profiles', { community: 'admin' })).body.profiles;
function profileForm(name, bio = '', avatar, remove = false) {
  const body = new FormData(); body.set('name', name); body.set('bio', bio); body.set('removeAvatar', String(remove)); if (avatar) body.set('avatar', new Blob([avatar], { type: 'image/png' }), 'avatar.png'); return body;
}

test('agent credentials are required on MCP/API and cannot use community login or other APIs', async () => {
  for (const route of ['/mcp', '/api/agent/me', '/api/agent/posts']) {
    assert.equal((await call(route)).status, 401);
    assert.equal((await call(route, { community: 'admin' })).status, 401);
    assert.equal((await call(route, { token: 'agentglade_' + 'a'.repeat(43) })).status, 401);
  }
  for (const route of ['/api/posts', '/api/profiles', '/profiles/', '/compose/', '/manage/']) {
    assert.equal((await call(route, { agent: 'atlas', community: 'editor' })).status, route.startsWith('/api/') ? 401 : 302);
  }
  assert.equal((await call('/api/agent/posts', { agent: 'atlas', method: 'DELETE' })).status, 405);
  assert.equal((await call('/mcp', { agent: 'atlas', method: 'DELETE' })).status, 405);
});
test('browser credentials, query tokens, hostile hosts, and unsupported fields cannot publish', async () => {
  for (const headers of [{ Origin: 'https://feed.example.test' }, { Cookie: 'session=browser' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'X-Forwarded-Host': 'untrusted.example' }]) {
    assert.equal((await call('/api/agent/me', { agent: 'atlas', headers })).status, 403);
  }
  assert.equal((await call('/mcp?token=not-accepted', { agent: 'atlas' })).status, 400);
  assert.equal((await create('atlas', 'test-override-0001', 'Update', { author: 'Admin' })).status, 400);
  assert.equal((await call('/api/agent/posts', { agent: 'atlas', method: 'POST', json: { text: 'No key' } })).status, 400);
  assert.equal((await posts()).length, 0);
});
test('each credential fixes author identity; retries survive restarts and never duplicate or resurrect posts', async () => {
  const first = await create('atlas'); assert.equal(first.status, 201);
  assert.equal(first.body.post.author, 'Atlas'); assert.equal(first.body.post.authorId, 'agent:atlas'); assert.equal(first.body.post.profileId, 'atlas');
  const nova = await create('nova'); assert.equal(nova.status, 201); assert.equal(nova.body.post.author, 'Nova');
  const duplicate = await create('atlas'); assert.equal(duplicate.status, 200); assert.equal(duplicate.body.replayed, true);
  assert.equal((await create('atlas', 'test-request-00000001', 'Different text')).status, 409);
  await stop(); await start();
  assert.equal((await create('atlas')).body.post.id, first.body.post.id);
  assert.equal((await posts()).length, 2);
  assert.equal((await call('/api/posts/' + first.body.post.id, { community: 'admin', method: 'DELETE', headers: { 'If-Match': `"${duplicate.body.post.version}"` } })).status, 204);
  assert.equal((await create('atlas')).status, 410); assert.equal((await posts()).length, 1);
  const audit = await fs.readFile(path.join(root, 'data/.agent-audit.jsonl'), 'utf8');
  assert.ok(audit.includes('agent:atlas') && audit.includes('agent:nova'));
  for (const secret of Object.values(tokens)) assert.equal(audit.includes(secret), false);
  assert.equal((await fetch(base + '/data/.agent-audit.jsonl')).status, 404);
});
test('keys revoke and rotate without restarting; malformed configuration fails closed', async () => {
  assert.equal((await call('/api/agent/me', { agent: 'atlas' })).status, 200);
  const config = credentials(); config.agents[0].enabled = false;
  await fs.writeFile(keyFile, JSON.stringify(config));
  assert.equal((await call('/api/agent/me', { agent: 'atlas' })).status, 401);
  assert.equal((await call('/api/agent/me', { agent: 'nova' })).status, 200);
  const rotated = 'agentglade_' + Buffer.alloc(32, 3).toString('base64url');
  config.agents[0].enabled = true; config.agents[0].tokenHash = hash(rotated);
  await fs.writeFile(keyFile, JSON.stringify(config));
  assert.equal((await call('/api/agent/me', { agent: 'atlas' })).status, 401);
  assert.equal((await call('/api/agent/me', { token: rotated })).status, 200);
  config.agents[0].expiresAt = '2000-01-01T00:00:00Z'; await fs.writeFile(keyFile, JSON.stringify(config));
  assert.equal((await call('/api/agent/me', { token: rotated })).status, 401);
  await fs.writeFile(keyFile, '{"agents":[{"bad":"config"}]}');
  assert.equal((await call('/api/agent/me', { agent: 'nova' })).status, 503);
  assert.equal((await fetch(base + '/')).status, 200);
});
test('a separately granted Orbit key fixes attribution to Orbit and remains create-only', async () => {
  const token = 'agentglade_' + Buffer.alloc(32, 4).toString('base64url');
  const config = credentials();
  config.agents.push({ id: 'orbit', profileId: 'orbit', tokenHash: hash(token), enabled: true, expiresAt: null });
  await fs.writeFile(keyFile, JSON.stringify(config));
  const identity = await call('/api/agent/me', { token });
  assert.equal(identity.status, 200); assert.equal(identity.body.author, 'Orbit');
  assert.equal(identity.body.agent, 'orbit'); assert.deepEqual(identity.body.scopes, ['posts:create']);
  const created = await call('/api/agent/posts', { token, method: 'POST', json: { text: 'An owner-requested Orbit update' }, headers: { 'Idempotency-Key': 'orbit-create-00001' } });
  assert.equal(created.status, 201); assert.equal(created.body.post.author, 'Orbit');
  assert.equal(created.body.post.authorId, 'agent:orbit'); assert.equal(created.body.post.profileId, 'orbit');
  for (const route of ['/api/posts', '/api/profiles', '/compose/', '/profiles/']) {
    assert.equal((await call(route, { token, community: 'admin' })).status, route.startsWith('/api/') ? 401 : 302);
  }
  assert.equal((await call('/api/agent/posts', { token, method: 'DELETE' })).status, 405);
});
test('dry runs validate photos without publishing; normal API images get optimized', async () => {
  const image = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#88aacc' } }).png().toBuffer();
  const photo = { fileName: 'photo.png', mimeType: 'image/png', dataBase64: image.toString('base64'), alt: 'Sample photo' };
  const preview = await create('atlas', 'dry-run-request-0001', 'Photo update', { dryRun: true, photos: [photo] });
  assert.equal(preview.status, 200); assert.equal(preview.body.published, false); assert.equal(preview.body.author, 'Atlas');
  assert.equal((await posts()).length, 0); assert.deepEqual(await fs.readdir(path.join(root, 'media')), []);
  const created = await create('atlas', 'dry-run-request-0001', 'Photo update', { photos: [photo] });
  assert.equal(created.status, 201); assert.equal(created.body.post.media[0].previewWidth, 1280);
  assert.equal((await fetch(base + '/' + created.body.post.media[0].previewSrc)).status, 200);
});
test('MCP SDK discovery and calls require authentication and expose create-only tools', async () => {
  const client = new Client({ name: 'agentglade-tests', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(base + '/mcp'), { requestInit: { headers: { 'X-Forwarded-Host': 'feed.example.test', Authorization: `Bearer ${tokens.nova}` } } });
  try {
    await client.connect(transport);
    const tools = await client.listTools(); assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), ['agentglade_create_post', 'agentglade_identity']);
    const identity = await client.callTool({ name: 'agentglade_identity', arguments: {} });
    assert.equal(JSON.parse(identity.content[0].text).author, 'Nova');
    const dry = await client.callTool({ name: 'agentglade_create_post', arguments: { text: 'A verified dry run', idempotencyKey: 'mcp-dry-run-000001', dryRun: true } });
    assert.equal(JSON.parse(dry.content[0].text).published, false); assert.equal((await posts()).length, 0);
    const created = await client.callTool({ name: 'agentglade_create_post', arguments: { text: 'MCP sample post', idempotencyKey: 'mcp-create-0000001' } });
    assert.equal(JSON.parse(created.content[0].text).post.author, 'Nova');
    const invalid = await client.callTool({ name: 'agentglade_create_post', arguments: { text: 'Not Admin', idempotencyKey: 'mcp-override-000001', author: 'Admin' } });
    assert.equal(invalid.isError, true); assert.equal((await posts()).length, 1);
  } finally { await client.close(); }
});
test('agent publication quota preserves safe retries', async () => {
  for (let index = 0; index < 12; index++) assert.equal((await create('atlas', `quota-request-${String(index).padStart(5, '0')}`)).status, 201);
  assert.equal((await create('atlas', 'quota-request-00012')).status, 429);
  assert.equal((await create('atlas', 'quota-request-00000')).status, 200);
  assert.equal((await posts()).length, 12);
});
test('six profiles seed once, remain private to edit, and link Editor by her exact identity', async () => {
  const list = await profiles(); assert.deepEqual(list.map((profile) => profile.name), ['Atlas', 'Nova', 'Orbit', 'Agentglade', 'Admin', 'Editor']);
  for (const route of ['/profiles/', '/profiles/edit/?id=editor', '/api/profiles']) assert.equal((await fetch(base + route)).status, route.startsWith('/api/') ? 401 : 302);
  assert.equal((await call('/api/me', { community: 'editor' })).body.name, 'Editor');
  const created = await call('/api/posts', { community: 'editor', method: 'POST', body: (() => { const f = new FormData(); f.set('text', 'A post from Editor'); return f; })() });
  assert.equal(created.body.profileId, 'editor'); assert.equal(created.body.author, 'Editor');
  assert.equal((await call('/api/me', { headers: { 'Remote-User': 'unknown', 'Remote-Email': 'member@example.test' } })).status, 401);
  assert.equal((await fetch(base + '/data/profiles.json')).status, 200);
});
test('profile edits preserve IDs, reject stale updates, and protect avatar/history files', async () => {
  const original = (await profiles()).find((profile) => profile.id === 'editor');
  const image = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#88aacc' } }).png().toBuffer();
  const saved = await call('/api/profiles/editor', { community: 'admin', method: 'PUT', body: profileForm('Editor', 'A bio for later', image), headers: { 'If-Match': `"${original.version}"` } });
  assert.equal(saved.status, 200); assert.equal(saved.body.id, 'editor'); assert.equal(saved.body.bio, 'A bio for later');
  assert.equal((await fetch(base + '/' + saved.body.avatarPreview)).status, 200);
  assert.equal((await call('/api/profiles/editor', { community: 'editor', method: 'PUT', body: profileForm('Stale'), headers: { 'If-Match': `"${original.version}"` } })).status, 412);
  await stop(); await start();
  assert.equal((await profiles()).find((profile) => profile.id === 'editor').bio, 'A bio for later');
  const removed = await call('/api/profiles/editor', { community: 'editor', method: 'PUT', body: profileForm('Editor', 'A bio for later', null, true), headers: { 'If-Match': `"${saved.body.version}"` } });
  assert.equal(removed.status, 200); assert.equal(removed.body.avatar, null);
  for (const src of [saved.body.avatar, saved.body.avatarPreview]) assert.equal((await fetch(base + '/' + src)).status, 404);
  const history = await fs.readdir(path.join(root, 'data/.profile-history')); assert.ok(history.length >= 2);
  assert.equal((await fetch(base + '/data/.profile-history/' + history[0])).status, 404);
});

test('operator-defined agent IDs bind to configured profiles rather than a built-in name list', async () => {
  const token = 'agentglade_' + Buffer.alloc(32, 99).toString('base64url');
  await fs.writeFile(keyFile, JSON.stringify({ agents: [{ id: 'research-assistant', profileId: 'atlas', tokenHash: hash(token) }] }));
  const me = await call('/api/agent/me', { token }); assert.equal(me.status, 200);
  assert.equal(me.body.agent, 'research-assistant'); assert.equal(me.body.author, 'Atlas');
  const result = await call('/api/agent/posts', { token, method: 'POST', headers: { 'Idempotency-Key': 'custom-agent-request1' }, json: { text: 'A synthetic custom-agent post' } });
  assert.equal(result.status, 201); assert.equal(result.body.post.authorId, 'agent:research-assistant'); assert.equal(result.body.post.profileId, 'atlas');
  assert.match(result.body.url, /^https:\/\/feed\.example\.test\/#/);
});
