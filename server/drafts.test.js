import { hashSecret } from './auth.js';
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const proxyKey = 'synthetic-test-proxy-key-not-for-deployments';
let root, child, base;
const member = (user) => ({ 'X-Agentglade-Proxy-Key': proxyKey, 'Remote-User': user, 'Remote-Name': user });
const hash = (value, length) => crypto.createHash('sha256').update(value).digest('hex').slice(0, length);
const draftPath = (user, scope) => path.join(root, 'data/.drafts', hash('member:' + user, 32), hash('scope:' + scope, 24));
async function start() {
  const authFile = path.join(root, 'auth.json');
  await fs.writeFile(authFile, JSON.stringify({ proxyTokenHash: hashSecret(proxyKey) }), { mode: 0o600 });
  child = spawn(process.execPath, [new URL('./server.js', import.meta.url).pathname], { env: { ...process.env, NODE_ENV: 'production', PORT: '0', AUTH_CONFIG_FILE: authFile, MAX_UPLOAD_MB: '1',
    DATA_DIR: path.join(root, 'data'), MEDIA_DIR: path.join(root, 'media'), MEMBER_ACCOUNTS: JSON.stringify({ sam: { name: 'Sam' }, alex: { name: 'Alex' } }), MEMBER_ADMINS: '["sam"]' }, stdio: ['ignore', 'pipe', 'pipe'] });
  base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not start')), 10000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Server exited')); });
    child.stdout.on('data', (data) => { const match = /listening on :(\d+)/.exec(data.toString()); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
  });
}
async function stop() { if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } }
async function call(route, { user = 'sam', method = 'GET', json, body, headers = {} } = {}) {
  const response = await fetch(base + route, { method, body: json === undefined ? body : JSON.stringify(json),
    headers: { ...member(user), ...(json === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers } });
  const type = response.headers.get('content-type') || '';
  return { status: response.status, headers: response.headers, body: type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()) };
}
const png = (size = 8, color = '#336699') => sharp({ create: { width: size, height: size, channels: 3, background: color } }).png().toBuffer();
async function upload(data, { user = 'sam', scope = 'new', type = 'image/png', name = 'photo.png' } = {}) {
  const body = new FormData(); body.set('media', new Blob([data], { type }), name);
  return call(`/api/drafts/media?scope=${encodeURIComponent(scope)}`, { user, method: 'POST', body });
}
const save = (fields, media = [], { user = 'sam', scope = 'new' } = {}) => call(`/api/drafts?scope=${encodeURIComponent(scope)}`, { user, method: 'PUT', json: { fields, media } });

beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentglade-draft-tests-')); await fs.mkdir(path.join(root, 'data')); await start(); });
afterEach(async () => { await stop(); await fs.rm(root, { recursive: true, force: true }); });

test('a draft keeps its text and photos on the member’s account, privately', async () => {
  const photo = await png();
  const added = await upload(photo);
  assert.equal(added.status, 201); assert.match(added.body.id, /^[a-f0-9]{32}$/);
  assert.equal((await save({ text: 'Started on my phone', milestoneOn: true, milestone: 'First draft', when: '2026-11-14T09:30' }, [{ id: added.body.id, alt: 'A blue square' }])).status, 200);
  const draft = (await call('/api/drafts?scope=new')).body;
  assert.equal(draft.fields.text, 'Started on my phone'); assert.equal(draft.fields.milestone, 'First draft');
  assert.deepEqual(draft.media, [{ name: 'photo.png', type: 'image/png', size: photo.length, addedAt: draft.media[0].addedAt, id: added.body.id, alt: 'A blue square' }]);
  const served = await call(`/api/drafts/media/${added.body.id}?scope=new`);
  assert.equal(served.status, 200); assert.equal(served.headers.get('content-type'), 'image/png'); assert.deepEqual(served.body, photo);
  assert.match(served.headers.get('content-security-policy'), /sandbox/); assert.equal(served.headers.get('cache-control'), 'private, no-store');
  // Another member sees nothing; folders are named by hashes, not accounts.
  assert.deepEqual((await call('/api/drafts?scope=new', { user: 'alex' })).body, { fields: null });
  assert.equal((await call(`/api/drafts/media/${added.body.id}?scope=new`, { user: 'alex' })).status, 404);
  assert.equal((await fs.readdir(path.join(root, 'data/.drafts'), { recursive: true })).some((name) => name.includes('sam')), false);
  assert.equal((await fetch(base + '/api/drafts?scope=new')).status, 401);
  for (const [fields, scope] of [[{ text: 'x', secret: true }, 'new'], [{ text: 'x'.repeat(20001) }, 'new'], [{ text: 'x' }, 'other']]) assert.equal((await save(fields, [], { scope })).status, 400);
  assert.equal((await upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), { type: 'image/svg+xml', name: 'x.svg' })).status, 415);
  assert.equal((await call(`/api/drafts/media/${added.body.id}?scope=new`, { method: 'DELETE', headers: { Origin: 'https://other.example' } })).status, 403);
  assert.equal((await call(`/api/drafts/media/${added.body.id}?scope=new`, { method: 'DELETE' })).status, 204);
  assert.deepEqual((await call('/api/drafts?scope=new')).body.media, []);
});

test('posting from a draft uses its uploaded photos in order and clears the draft', async () => {
  const first = (await upload(await png(1600, '#aa3333'), { name: 'first.png' })).body, second = (await upload(await png(8, '#33aa33'), { name: 'second.png' })).body;
  await save({ text: 'Posting from the draft' }, [{ id: first.id, alt: 'Red' }, { id: second.id, alt: 'Green' }]);
  const body = new FormData(); body.set('text', 'Posting from the draft'); body.set('draftScope', 'new');
  body.set('draftMedia', JSON.stringify([{ id: second.id, alt: 'Green' }, { id: first.id, alt: 'Red' }]));
  const created = await call('/api/posts', { method: 'POST', body });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.media.map((m) => [m.alt, m.width]), [['Green', 8], ['Red', 1600]]);
  assert.match(created.body.media[1].previewSrc, /\.preview\.webp$/);
  const finished = await call('/api/drafts?scope=new');
  assert.equal(finished.status, 200); assert.equal(finished.body.fields, null); assert.ok(Date.parse(finished.body.finishedAt) <= Date.now());
  await assert.rejects(fs.stat(draftPath('sam', 'new')), { code: 'ENOENT' });
  // Starting a new draft in the same place clears the marker.
  await save({ text: 'Next one' });
  assert.equal((await call('/api/drafts?scope=new')).body.fields.text, 'Next one');
  // Refused: files and draft photos together, and another member's draft photo.
  const mixed = new FormData(); mixed.set('text', 'Mixed'); mixed.set('draftScope', 'new'); mixed.set('draftMedia', '[]');
  mixed.append('media', new Blob([await png()], { type: 'image/png' }), 'inline.png');
  assert.equal((await call('/api/posts', { method: 'POST', body: mixed })).status, 400);
  const theirs = (await upload(await png(), { user: 'alex' })).body;
  const stolen = new FormData(); stolen.set('text', 'Not mine'); stolen.set('draftScope', 'new'); stolen.set('draftMedia', JSON.stringify([{ id: theirs.id }]));
  assert.equal((await call('/api/posts', { method: 'POST', body: stolen })).status, 400);
});

test('drafts are limited in files, size, and number per member', async () => {
  const big = crypto.randomBytes(700 * 1024);
  assert.equal((await upload(big, { scope: 'edit:a' })).status, 201);
  assert.equal((await upload(big, { scope: 'edit:a' })).status, 413); // Over the 1 MiB limit in this test.
  for (let i = 0; i < 20; i++) assert.equal((await upload(await png(), { scope: 'edit:b' })).status, 201);
  assert.equal((await upload(await png(), { scope: 'edit:b' })).status, 409);
  for (let i = 0; i < 8; i++) assert.equal((await save({ text: `Draft ${i}` }, [], { scope: `edit:post-${i}` })).status, 200);
  assert.equal((await save({ text: 'One too many' }, [], { scope: 'edit:post-9' })).status, 409);
  assert.equal((await save({ text: 'Another member is unaffected' }, [], { user: 'alex', scope: 'edit:post-9' })).status, 200);
});

test('stale drafts and unclaimed uploads are swept at startup', async () => {
  const kept = (await upload(await png())).body, orphan = (await upload(await png())).body;
  await save({ text: 'Keep me' }, [{ id: kept.id, alt: '' }]);
  await save({ text: 'Forgotten' }, [], { scope: 'edit:old' });
  await stop();
  const old = path.join(draftPath('sam', 'edit:old'), 'draft.json');
  await fs.writeFile(old, JSON.stringify({ ...JSON.parse(await fs.readFile(old, 'utf8')), updatedAt: new Date(Date.now() - 100 * 86400000).toISOString() }));
  const orphanMeta = path.join(draftPath('sam', 'new'), 'media', `${orphan.id}.json`);
  await fs.writeFile(orphanMeta, JSON.stringify({ ...JSON.parse(await fs.readFile(orphanMeta, 'utf8')), addedAt: new Date(Date.now() - 2 * 86400000).toISOString() }));
  await start();
  await assert.rejects(fs.stat(draftPath('sam', 'edit:old')), { code: 'ENOENT' });
  assert.deepEqual((await fs.readdir(path.join(draftPath('sam', 'new'), 'media'))).sort(), [kept.id, `${kept.id}.json`].sort());
  assert.equal((await call('/api/drafts?scope=new')).body.fields.text, 'Keep me');
});
