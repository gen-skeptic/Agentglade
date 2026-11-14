import { hashSecret } from './auth.js';
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const proxyKey = 'synthetic-test-proxy-key-not-for-deployments';
const origin = 'https://feed.example.test';
let root, child, base;
const token = () => crypto.randomBytes(32).toString('base64url');
const member = (user) => ({ 'X-Agentglade-Proxy-Key': proxyKey, 'Remote-User': user, 'Remote-Name': user });
async function start() {
  const authFile = path.join(root, 'auth.json');
  await fs.writeFile(authFile, JSON.stringify({ proxyTokenHash: hashSecret(proxyKey) }), { mode: 0o600 });
  child = spawn(process.execPath, [new URL('./server.js', import.meta.url).pathname], { env: { ...process.env, NODE_ENV: 'production', PORT: '0', PUBLIC_ORIGIN: origin, AUTH_CONFIG_FILE: authFile,
    DATA_DIR: path.join(root, 'data'), MEDIA_DIR: path.join(root, 'media'), MEMBER_ACCOUNTS: JSON.stringify({ sam: { name: 'Sam' }, alex: { name: 'Alex' } }), MEMBER_ADMINS: '["sam"]' }, stdio: ['ignore', 'pipe', 'pipe'] });
  base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Server did not start')), 10000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Server exited')); });
    child.stdout.on('data', (data) => { const match = /listening on :(\d+)/.exec(data.toString()); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
  });
}
async function stop() { if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } }
async function request(route, { method = 'GET', visitor, headers = {}, json } = {}) {
  const response = await fetch(base + route, { method, body: json === undefined ? undefined : JSON.stringify(json),
    headers: { ...(visitor ? { 'X-Agentglade-Visitor': visitor } : {}), ...(json === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers } });
  return { status: response.status, body: await response.json().catch(() => null) };
}
const love = (id, options = {}) => request(`/api/feed/posts/${id}/love`, { method: 'PUT', ...options });
const unlove = (id, options = {}) => request(`/api/feed/posts/${id}/love`, { method: 'DELETE', ...options });
const view = async (id, options) => (await request(`/api/feed/posts/${id}`, options)).body;
async function post(text) {
  const body = new FormData(); body.set('text', text);
  return (await fetch(base + '/api/posts', { method: 'POST', headers: member('sam'), body }).then((r) => r.json())).id;
}
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentglade-love-tests-')); await fs.mkdir(path.join(root, 'data')); await start(); });
afterEach(async () => { await stop(); await fs.rm(root, { recursive: true, force: true }); });

test('anonymous readers love a post once per browser and see their own state', async () => {
  const id = await post('Hello'), reader = token(), other = token();
  assert.deepEqual((await love(id, { visitor: reader })).body, { loves: 1, loved: true });
  assert.deepEqual((await love(id, { visitor: reader })).body, { loves: 1, loved: true }); // Loving twice counts once.
  assert.equal((await view(id, { visitor: reader })).loved, true);
  const seenByOther = await view(id, { visitor: other });
  assert.equal(seenByOther.loves, 1); assert.equal(seenByOther.loved, false);
  assert.deepEqual((await love(id, { visitor: other })).body, { loves: 2, loved: true });
  assert.deepEqual((await unlove(id, { visitor: reader })).body, { loves: 1, loved: false });
  const page = (await request('/api/feed', { visitor: other })).body.posts[0];
  assert.equal(page.loves, 1); assert.equal(page.loved, true);
});

test('a member’s love follows them to every device, and a linked browser never counts twice', async () => {
  const id = await post('Hello'), phone = token(), laptop = token();
  assert.equal((await love(id, { visitor: phone })).body.loves, 1); // Anonymous on the public feed.
  assert.equal((await request('/api/me/visitor', { method: 'POST', headers: member('alex'), json: { token: phone } })).status, 204);
  // Signed in on another device, Alex already sees the love, and the count did not change.
  const signedIn = await view(id, { headers: member('alex'), visitor: laptop });
  assert.equal(signedIn.loved, true); assert.equal(signedIn.loves, 1);
  // The phone still counts as Alex: loving again changes nothing; unloving there removes Alex's love.
  assert.deepEqual((await love(id, { visitor: phone })).body, { loves: 1, loved: true });
  assert.deepEqual((await unlove(id, { visitor: phone })).body, { loves: 0, loved: false });
  assert.equal((await view(id, { headers: member('alex') })).loved, false);
  assert.equal((await request('/api/me/visitor', { method: 'POST', headers: member('alex'), json: { token: 'short' } })).status, 400);
  assert.equal((await request('/api/me/visitor', { method: 'POST', json: { token: phone } })).status, 401);
});

test('loves refuse cross-site requests, missing IDs, unknown posts, and floods', async () => {
  const id = await post('Hello');
  assert.equal((await love(id, { visitor: token(), headers: { Origin: 'https://other.example' } })).status, 403);
  assert.equal((await love(id)).status, 400);
  assert.equal((await love(id, { visitor: 'not-a-token' })).status, 400);
  assert.equal((await love('missing', { visitor: token() })).status, 404);
  assert.equal((await request(`/api/feed/posts/${id}/love`, { method: 'POST', visitor: token() })).status, 405);
  let limited = false;
  for (let i = 0; i < 32 && !limited; i++) limited = (await love(id, { visitor: token() })).status === 429;
  assert.equal(limited, true);
});

test('loves persist across restarts, move once from an old browser, and go with a deleted post', async () => {
  const kept = await post('Kept'), removed = await post('Removed'), reader = token();
  // Loves an earlier release saved only in this browser.
  assert.deepEqual((await request('/api/feed/loves/import', { method: 'POST', visitor: reader, json: { ids: [kept, removed, 'gone'] } })).body, { imported: 2 });
  assert.equal((await request('/api/feed/loves/import', { method: 'POST', visitor: reader, json: { ids: [kept] } })).status, 409);
  await stop(); await start();
  assert.equal((await view(kept, { visitor: reader })).loved, true);
  const version = (await (await fetch(`${base}/api/posts/${removed}`, { headers: member('sam') })).json()).version;
  assert.equal((await fetch(`${base}/api/posts/${removed}`, { method: 'DELETE', headers: { ...member('sam'), 'If-Match': `"${version}"` } })).status, 204);
  await stop(); await start();
  assert.equal((await view(kept)).loves, 1);
  // The private log holds only hashes, and is never served.
  const log = await fs.readFile(path.join(root, 'data/.loves.jsonl'), 'utf8');
  for (const secret of [reader, 'sam', 'alex']) assert.equal(log.includes(secret), false);
  assert.equal((await love(removed, { visitor: reader })).status, 404);
  assert.equal((await request('/data/.loves.jsonl')).status, 404);
});
