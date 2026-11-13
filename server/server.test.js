import { hashSecret } from './auth.js';
import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';

const proxyKey = 'synthetic-test-proxy-key-not-for-deployments';
const fetch = (url, options = {}) => globalThis.fetch(url, { ...options, redirect: 'manual', headers: { 'X-Agentglade-Proxy-Key': proxyKey, ...options.headers } });
const here = path.dirname(fileURLToPath(import.meta.url));
const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#8899aa' } }).png().toBuffer();
const shared = 'media/2026/11/shared.png';
const communityAccounts = { 'parent-a': {}, 'parent-b': {}, 'admin-account': { name: 'Admin' } };
let directory, child, base;
const fixture = () => ({ posts: ['first', 'second'].map((id) => ({ id, author: 'Parent A', initials: 'PA', authorId: 'parent-a',
  publishedAt: '2026-11-12T12:00:00.000Z', text: `Original ${id}`, milestone: null,
  media: [{ type: 'image', src: shared, alt: 'Shared photo' }] })) });

async function startServer(root, env = {}) {
  const authFile = path.join(root, 'test-auth.json');
  await fs.writeFile(authFile, JSON.stringify({ proxyTokenHash: hashSecret(proxyKey) }), { mode: 0o600 });
  const process = spawn(globalThis.process.execPath, [path.join(here, 'server.js')], { env: { ...globalThis.process.env, PORT: '0',
    NODE_ENV: 'production', AUTH_CONFIG_FILE: authFile, MEMBER_ACCOUNTS: JSON.stringify(communityAccounts), MEMBER_ADMINS: JSON.stringify(['parent-b', 'admin-account']),
    DEV_USER: '', MAX_UPLOAD_MB: '0.025', DATA_DIR: path.join(root, 'data'), MEDIA_DIR: path.join(root, 'media'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not start')), 10000);
    process.once('error', reject);
    process.stdout.on('data', (data) => {
      output += data;
      const match = /listening on :(\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
    });
    process.stderr.on('data', (data) => { output += data; });
    process.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)); });
  });
  return { child: process, base: url };
}
async function stopServer(process) {
  if (process && process.exitCode === null && process.signalCode === null) { const exited = once(process, 'exit'); process.kill(); await exited; }
}
before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentglade-post-tests-'));
  ({ child, base } = await startServer(directory));
});
beforeEach(async () => {
  await fs.writeFile(path.join(directory, 'data/posts.json'), JSON.stringify(fixture()));
  await fs.writeFile(path.join(directory, 'data/site.json'), JSON.stringify({ name: 'Agentglade' }));
  await fs.rm(path.join(directory, 'media'), { recursive: true, force: true });
  await fs.mkdir(path.join(directory, 'media/2026/11'), { recursive: true });
  await fs.writeFile(path.join(directory, shared), png);
  await fs.rm(path.join(directory, 'data/.history'), { recursive: true, force: true });
});
after(async () => {
  await stopServer(child);
  if (directory) await fs.rm(directory, { recursive: true, force: true });
});

async function call(url, { auth = true, version, headers = {}, ...options } = {}) {
  const response = await fetch(base + url, { ...options, headers: {
    ...(auth ? { 'Remote-User': 'parent-a', 'Remote-Name': 'Parent A' } : {}),
    ...(version ? { 'If-Match': `"${version}"` } : {}), ...headers,
  } });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  return { status: response.status, body, headers: response.headers };
}
function form({ text = 'A community update', retained, files = [], meta = [], publishedAt, milestone } = {}) {
  const body = new FormData();
  body.set('text', text);
  body.set('mediaMeta', JSON.stringify(meta));
  if (retained !== undefined) body.set('retainMedia', JSON.stringify(retained));
  if (publishedAt !== undefined) body.set('publishedAt', publishedAt);
  if (milestone !== undefined) body.set('milestone', milestone);
  for (const file of files) body.append('media', new Blob([file.data || png], { type: file.type || 'image/png' }), file.name || 'photo.png');
  return body;
}
const read = async (id = 'first') => (await call(`/api/posts/${id}`)).body;

test('community pages and all management operations require identity', async () => {
  for (const route of ['/compose/', '/manage/']) assert.equal((await fetch(base + route)).status, 302);
  for (const [route, method] of [['/api/posts', 'GET'], ['/api/posts/first', 'GET'], ['/api/posts/first', 'PUT'], ['/api/posts/first', 'DELETE']]) {
    assert.equal((await call(route, { method, auth: false })).status, 401);
  }
  assert.equal((await fetch(base + '/')).status, 200);
});
test('only listed Authentik identities can open private pages or use APIs', async () => {
  for (const user of ['local-owner@example.test', 'unlisted-authentik-user', 'toString', '__proto__']) {
    const headers = { 'Remote-User': user, 'Remote-Name': 'authentik Default Admin', 'Remote-Email': 'admin@example.test', 'Remote-Role': 'Admin' };
    for (const route of ['/compose/', '/manage/', '/api/me', '/api/posts', '/api/posts/first']) {
      assert.equal((await fetch(base + route, { headers })).status, route.startsWith('/api/') ? 401 : 302);
    }
    for (const method of ['POST', 'PUT', 'DELETE']) {
      assert.equal((await call(method === 'POST' ? '/api/posts' : '/api/posts/first', { auth: false, method, headers, body: method === 'DELETE' ? undefined : form() })).status, 401);
    }
  }
  assert.equal((await call('/api/me', { headers: { 'Remote-User': 'parent-b', 'Remote-Name': 'Parent B' } })).body.name, 'Parent B');
});
test('Admin is tied to his account identity on the session and future posts', async () => {
  const headers = { 'Remote-User': 'admin-account', 'Remote-Name': 'authentik Default Admin' };
  assert.equal((await call('/api/me', { headers })).body.name, 'Admin');
  const saved = await call('/api/posts', { method: 'POST', headers, body: form() });
  assert.equal(saved.status, 201);
  assert.equal(saved.body.author, 'Admin');
  assert.equal(saved.body.initials, 'A');
  assert.equal(saved.body.authorId, 'admin-account');
});
test('startup links account attribution once and preserves site customization', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentglade-profile-tests-'));
  let process;
  try {
    await fs.mkdir(path.join(root, 'data'));
    const original = fixture();
    original.posts[0] = { ...original.posts[0], authorId: 'admin-account', author: 'authentik Default Admin', initials: 'AD' };
    original.posts[1].author = 'authentik Default Admin'; // Similar name must not change another account.
    await fs.writeFile(path.join(root, 'data/posts.json'), JSON.stringify(original));
    await fs.writeFile(path.join(root, 'data/site.json'), JSON.stringify({ name: 'Agentglade', bio: 'Daily notes and photos for community. Placeholder bio: edit data/site.json.' }));
    for (let attempt = 0; attempt < 2; attempt++) {
      process = (await startServer(root)).child;
      const doc = JSON.parse(await fs.readFile(path.join(root, 'data/posts.json')));
      assert.deepEqual(doc.posts[0], { ...original.posts[0], author: 'Admin', initials: 'A' });
      assert.deepEqual(doc.posts[1], original.posts[1]);
      assert.equal(JSON.parse(await fs.readFile(path.join(root, 'data/site.json'))).bio, 'Daily notes and photos for community. Placeholder bio: edit data/site.json.');
      const archives = await fs.readdir(path.join(root, 'data/.history'));
      assert.equal(archives.length, 1);
      const saved = JSON.parse(await fs.readFile(path.join(root, 'data/.history', archives[0])));
      assert.deepEqual(saved.post, original.posts[0]);
      assert.equal(saved.action, 'profile-name');
      await stopServer(process);
    }
  } finally { await stopServer(process); await fs.rm(root, { recursive: true, force: true }); }
});
test('production without an account list denies forwarded identities and ignores DEV_USER', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentglade-closed-tests-'));
  let process;
  try {
    const started = await startServer(root, { MEMBER_ACCOUNTS: '', MEMBER_ADMINS: '[]', DEV_USER: 'Unexpected admin' });
    process = started.child;
    assert.equal((await fetch(started.base + '/api/me')).status, 401);
    assert.equal((await fetch(started.base + '/api/me', { headers: { 'Remote-User': 'parent-a' } })).status, 401);
    assert.equal((await fetch(started.base + '/')).status, 200);
  } finally { await stopServer(process); await fs.rm(root, { recursive: true, force: true }); }
});
test('edits preserve the original author and archive the previous text privately', async () => {
  const original = await read();
  const response = await call('/api/posts/first', { method: 'PUT', version: original.version,
    body: form({ text: 'Edited with love', milestone: 'First laugh' }),
    headers: { 'Remote-User': 'parent-b', 'Remote-Name': 'Parent B' } });
  assert.equal(response.status, 200);
  assert.equal(response.body.author, original.author);
  assert.equal(response.body.authorId, original.authorId);
  assert.equal(response.body.publishedAt, original.publishedAt);
  assert.equal(response.body.media[0].src, shared);
  assert.notEqual(response.body.version, original.version);
  const archives = await fs.readdir(path.join(directory, 'data/.history'));
  const records = await Promise.all(archives.map(async (file) => ({ file, record: JSON.parse(await fs.readFile(path.join(directory, 'data/.history', file))) })));
  const { file: archive, record: saved } = records.find(({ record }) => record.action === 'edit' && record.post.id === original.id);
  assert.equal(saved.post.text, original.text);
  assert.equal(saved.actor, 'parent-b');
  assert.equal((await fetch(base + '/data/.history/' + archive)).status, 404);
  assert.equal((await fetch(base + '/data/private.json')).status, 404);
});
test('stale editors and missing preconditions cannot overwrite or delete a changed post', async () => {
  const original = await read();
  assert.equal((await call('/api/posts/first', { method: 'PUT', body: form() })).status, 428);
  assert.equal((await call('/api/posts/first', { method: 'PUT', version: original.version, body: form({ text: 'Newer version' }) })).status, 200);
  assert.equal((await call('/api/posts/first', { method: 'PUT', version: original.version, body: form({ text: 'Stale version' }) })).status, 412);
  assert.equal((await call('/api/posts/first', { method: 'DELETE', version: original.version })).status, 412);
  assert.equal((await read()).text, 'Newer version');
});
test('updates and deletes reject cross-site requests', async () => {
  const post = await read();
  const headers = { Origin: 'https://other.invalid', 'Sec-Fetch-Site': 'cross-site' };
  assert.equal((await call('/api/posts/first', { method: 'PUT', version: post.version, headers, body: form() })).status, 403);
  assert.equal((await call('/api/posts/first', { method: 'DELETE', version: post.version, headers })).status, 403);
  assert.equal((await read()).text, post.text);
});
test('photos can be added, retained, and removed without deleting media shared by another post', async () => {
  const post = await read();
  const saved = await call('/api/posts/first', { method: 'PUT', version: post.version,
    body: form({ retained: [], files: [{}], meta: [{ width: 1, height: 1 }] }) });
  assert.equal(saved.status, 200);
  const uploaded = saved.body.media[0].src;
  assert.equal(saved.body.media[0].width, 1);
  assert.equal((await fetch(base + '/' + uploaded)).status, 200);
  assert.equal((await fetch(base + '/' + shared)).status, 200);
  const removed = await call('/api/posts/first', { method: 'PUT', version: saved.body.version, body: form({ retained: [] }) });
  assert.equal(removed.status, 200);
  assert.equal((await fetch(base + '/' + uploaded)).status, 404);
  await assert.rejects(fs.stat(path.join(directory, uploaded)), { code: 'ENOENT' });
  assert.equal((await fetch(base + '/' + shared)).status, 200);
});
test('deletion removes the post and its exclusive uploaded media from public access', async () => {
  const created = await call('/api/posts', { method: 'POST', body: form({ files: [{}] }) });
  assert.equal(created.status, 201);
  const post = created.body;
  assert.equal((await call(`/api/posts/${post.id}`, { method: 'DELETE', version: post.version })).status, 204);
  assert.equal((await call(`/api/posts/${post.id}`)).status, 404);
  assert.equal((await fetch(base + '/' + post.media[0].src)).status, 404);
  const published = await (await fetch(base + '/data/posts.json')).json();
  assert.equal(published.posts.some((p) => p.id === post.id), false);
  assert.equal(published.posts.length, 2);
  await fs.writeFile(path.join(directory, 'media/2026/11/orphan.png'), png);
  assert.equal((await fetch(base + '/media/2026/11/orphan.png')).status, 404);
});
test('master and preview are public while referenced and are cleaned together on deletion', async () => {
  const data = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#667788' } }).png().toBuffer();
  const saved = await call('/api/posts', { method: 'POST', body: form({ files: [{ data }], meta: [{ width: 99999, height: 99999 }] }) });
  assert.equal(saved.status, 201);
  const media = saved.body.media[0];
  assert.equal(media.width, 1600); // Actual decoded size, never client-supplied metadata.
  assert.equal(media.previewWidth, 1280);
  for (const src of [media.src, media.previewSrc]) {
    const response = await fetch(base + '/' + src);
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/webp');
  }
  assert.equal((await call('/api/posts/' + saved.body.id, { method: 'DELETE', version: saved.body.version })).status, 204);
  for (const src of [media.src, media.previewSrc]) {
    assert.equal((await fetch(base + '/' + src)).status, 404);
    await assert.rejects(fs.stat(path.join(directory, src)), { code: 'ENOENT' });
  }
});
test('a broken photo leaves the post unchanged and rolls back newly generated previews', async () => {
  const original = await read();
  const data = await sharp({ create: { width: 1600, height: 900, channels: 3, background: '#667788' } }).png().toBuffer();
  const result = await call('/api/posts/first', { method: 'PUT', version: original.version,
    body: form({ files: [{ data }, { data: Buffer.from('broken photo') }] }) });
  assert.equal(result.status, 422);
  assert.equal((await read()).version, original.version);
  assert.deepEqual(await fs.readdir(path.join(directory, 'media/2026/11')), ['shared.png']);
});
test('invalid metadata and foreign retained paths leave published data unchanged', async () => {
  const post = await read();
  for (const body of [form({ meta: null }), form({ retained: ['media/2026/11/other.png'] }),
    form({ text: '', retained: [] }), form({ publishedAt: 'not-a-date' })]) {
    assert.equal((await call('/api/posts/first', { method: 'PUT', version: post.version, body })).status, 400);
  }
  assert.equal((await read()).version, post.version);
  assert.equal((await call('/api/posts', { method: 'POST', body: form({ files: [{ type: 'image/svg+xml' }] }) })).status, 415);
});
test('stable pagination continues even when the cursor post is deleted', async () => {
  const page = await call('/api/posts?limit=1');
  assert.equal(page.body.posts[0].id, 'second');
  assert.equal(page.body.total, 2);
  await call('/api/posts/second', { method: 'DELETE', version: page.body.posts[0].version });
  const older = await call('/api/posts?limit=1&before=' + encodeURIComponent(page.body.nextCursor));
  assert.deepEqual(older.body.posts.map((p) => p.id), ['first']);
  assert.equal(older.body.nextCursor, null);
  assert.equal((await call('/api/posts?before=invalid')).status, 400);
});
test('chunked uploads obey the actual byte limit', async () => {
  const boundary = 'test-boundary';
  const raw = `--${boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\n${'x'.repeat(40000)}\r\n--${boundary}--\r\n`;
  const status = await new Promise((resolve, reject) => {
    const req = http.request(base + '/api/posts', { method: 'POST', headers: {
      'X-Agentglade-Proxy-Key': proxyKey, 'Remote-User': 'parent-a', 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Transfer-Encoding': 'chunked',
    } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.write(raw.slice(0, 100)); req.end(raw.slice(100));
  });
  assert.equal(status, 413);
  assert.equal((await call('/api/posts')).body.total, 2);
});
