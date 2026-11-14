import { hashSecret } from './auth.js';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import crypto from 'node:crypto';

const proxyKey = 'synthetic-test-proxy-key-not-for-deployments';
let root, child, base, slowPhoto;
const agentToken = 'agentglade_' + Buffer.alloc(32, 7).toString('base64url');
const asAgent = (key) => ({ Authorization: `Bearer ${agentToken}`, 'Idempotency-Key': key, 'X-Forwarded-Host': 'feed.example.test' });
const as = (user) => ({ 'X-Agentglade-Proxy-Key': proxyKey, 'Remote-User': user, 'Remote-Name': user });
const timed = (started, promise) => promise.then(async (response) => ({ status: response.status, body: await response.json().catch(() => null), at: Date.now() - started }));
function photoForm(text, files = []) {
  const body = new FormData(); body.set('text', text);
  for (const data of files) body.append('media', new Blob([data], { type: 'image/jpeg' }), 'photo.jpg');
  return body;
}

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentglade-concurrency-tests-'));
  await fs.mkdir(path.join(root, 'data'));
  await fs.writeFile(path.join(root, 'data/posts.json'), '{"posts":[]}');
  const authFile = path.join(root, 'auth.json');
  await fs.writeFile(authFile, JSON.stringify({ proxyTokenHash: hashSecret(proxyKey) }), { mode: 0o600 });
  const agentFile = path.join(root, 'agents.json');
  await fs.writeFile(agentFile, JSON.stringify({ agents: [{ id: 'atlas', profileId: 'atlas', tokenHash: crypto.createHash('sha256').update(agentToken).digest('hex') }] }), { mode: 0o600 });
  child = spawn(process.execPath, [new URL('./server.js', import.meta.url).pathname], { env: { ...process.env, NODE_ENV: 'production', PORT: '0',
    AUTH_CONFIG_FILE: authFile, AGENT_KEYS_FILE: agentFile, PUBLIC_ORIGIN: 'https://feed.example.test', DATA_DIR: path.join(root, 'data'), MEDIA_DIR: path.join(root, 'media'),
    MEMBER_ACCOUNTS: JSON.stringify({ uploader: {}, reader: {} }), MEMBER_ADMINS: '[]' }, stdio: ['ignore', 'pipe', 'pipe'] });
  base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not start')), 10000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Server exited')); });
    child.stdout.on('data', (data) => { const match = /listening on :(\d+)/.exec(data.toString()); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
  });
  // Noise does not compress, so this photo takes the server a noticeable time to decode and resize.
  slowPhoto = await sharp({ create: { width: 8000, height: 6000, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 40 } } }).jpeg({ quality: 85 }).toBuffer();
  // Both members sign in and finish onboarding before the timing checks.
  for (const user of ['uploader', 'reader']) {
    assert.equal((await fetch(base + '/api/me', { headers: as(user) })).status, 200);
    assert.equal((await fetch(base + '/api/me/setup', { method: 'POST', headers: { ...as(user), 'Content-Type': 'application/json' }, body: '{}' })).status, 204);
  }
});
after(async () => {
  if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
  if (root) await fs.rm(root, { recursive: true, force: true });
});

test('a slow photo upload does not stall other members’ pages, reads, or text posts', async () => {
  const started = Date.now();
  const upload = timed(started, fetch(base + '/api/posts', { method: 'POST', headers: as('uploader'), body: photoForm('A large photo', [slowPhoto]) }));
  await new Promise((resolve) => setTimeout(resolve, 250));
  const me = timed(started, fetch(base + '/api/me', { headers: as('reader') }));
  const page = timed(started, fetch(base + '/manage/', { headers: as('reader'), redirect: 'manual' }));
  const text = timed(started, fetch(base + '/api/posts', { method: 'POST', headers: as('reader'), body: photoForm('A quick text update') }));
  const results = { upload: await upload, me: await me, page: await page, text: await text };
  assert.equal(results.upload.status, 201); assert.equal(results.me.status, 200);
  assert.equal(results.page.status, 200); assert.equal(results.text.status, 201);
  for (const name of ['me', 'page', 'text']) assert.ok(results[name].at < results.upload.at, `${name} finished at ${results[name].at} ms, after the upload at ${results.upload.at} ms`);
});

test('a post edited while new photos are processing refuses the stale save and removes its photos', async () => {
  const created = (await fetch(base + '/api/posts', { method: 'POST', headers: as('uploader'), body: photoForm('Before') }).then((r) => r.json()));
  const before = await fs.readdir(path.join(root, 'media'), { recursive: true });
  const slow = fetch(base + '/api/posts/' + created.id, { method: 'PUT', headers: { ...as('uploader'), 'If-Match': `"${created.version}"` }, body: photoForm('Stale photo edit', [slowPhoto]) });
  await new Promise((resolve) => setTimeout(resolve, 250));
  const quick = await fetch(base + '/api/posts/' + created.id, { method: 'PUT', headers: { ...as('uploader'), 'If-Match': `"${created.version}"` }, body: photoForm('Newer text edit') });
  assert.equal(quick.status, 200);
  assert.equal((await slow).status, 412);
  const saved = await fetch(base + '/api/posts/' + created.id, { headers: as('uploader') }).then((r) => r.json());
  assert.equal(saved.text, 'Newer text edit'); assert.deepEqual(saved.media, []);
  const files = (await fs.readdir(path.join(root, 'media'), { recursive: true })).filter((name) => name.endsWith('.webp'));
  assert.deepEqual(files, before.filter((name) => name.endsWith('.webp')));
});

test('an agent’s slow photo post does not hold up members, and its retry still replays', async () => {
  const started = Date.now();
  const agent = timed(started, fetch(base + '/api/agent/posts', { method: 'POST', headers: asAgent('slow-agent-photo-0001'), body: photoForm('An agent photo update', [slowPhoto]) }));
  await new Promise((resolve) => setTimeout(resolve, 250));
  const text = timed(started, fetch(base + '/api/posts', { method: 'POST', headers: as('reader'), body: photoForm('Posted while the agent photo processes') }));
  const results = { agent: await agent, text: await text };
  assert.equal(results.agent.status, 201); assert.equal(results.text.status, 201);
  assert.ok(results.text.at < results.agent.at, `the text post finished at ${results.text.at} ms, after the agent post at ${results.agent.at} ms`);
  const retry = await fetch(base + '/api/agent/posts', { method: 'POST', headers: asAgent('slow-agent-photo-0001'), body: photoForm('An agent photo update', [slowPhoto]) });
  const replay = await retry.json();
  assert.equal(retry.status, 200); assert.equal(replay.replayed, true); assert.equal(replay.post.id, results.agent.body.post.id);
  const stored = JSON.parse(await fs.readFile(path.join(root, 'data/posts.json'))).posts;
  assert.equal(stored.filter((post) => post.text === 'An agent photo update').length, 1);
});
