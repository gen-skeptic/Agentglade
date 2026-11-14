import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { hashPassword, hashSecret } from './auth.js';
let root, child, base;
const origin = 'https://feed.example.test', password = 'synthetic-test-password', proxyKey = 'synthetic-proxy-key';
before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentglade-auth-test-'));
  const configFile = path.join(root, 'auth.json');
  await fs.writeFile(configFile, JSON.stringify({ localAdmin: { username: 'operator', name: 'Alex', passwordHash: await hashPassword(password) }, proxyTokenHash: hashSecret(proxyKey) }), { mode: 0o600 });
  child = spawn(process.execPath, ['server/server.js'], { env: { ...process.env, NODE_ENV: 'production', PORT: '0', PUBLIC_ORIGIN: origin,
    AUTH_CONFIG_FILE: configFile, DATA_DIR: path.join(root, 'data'), MEDIA_DIR: path.join(root, 'media'), MEMBER_ACCOUNTS: '{}', MEMBER_ADMINS: '[]', MEMBER_ROLES: '["Publishers"]' }, stdio: ['ignore', 'pipe', 'pipe'] });
  base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Authentication test server did not start')), 10000);
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Authentication test server exited')); });
    child.stdout.on('data', (buffer) => { const match = /listening on :(\d+)/.exec(buffer.toString()); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
  });
});
after(async () => { if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } if (root) await fs.rm(root, { recursive: true, force: true }); });
const login = (body, extra = {}) => fetch(base + '/api/auth/login', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...extra }, body: JSON.stringify(body) });
test('local login issues a secure cookie, permits administration, and logout revokes it', async () => {
  assert.equal((await login({ username: 'operator', password: 'incorrect' })).status, 401);
  for (const body of [null, 7, 'operator']) assert.equal((await login(body)).status, 400);
  assert.equal((await login({ username: 'operator', password }, { Origin: 'https://evil.example' })).status, 403);
  const response = await login({ username: 'operator', password }); assert.equal(response.status, 200);
  const cookie = response.headers.get('set-cookie'); assert.match(cookie, /HttpOnly; SameSite=Strict/); assert.match(cookie, /; Secure/);
  const headers = { Cookie: cookie.split(';')[0], Origin: origin };
  const me = await (await fetch(base + '/api/me', { headers })).json();
  assert.equal(me.role, 'admin'); assert.equal(me.name, 'Admin');
  const body = new FormData(); body.set('text', 'A synthetic login test post');
  const saved = await fetch(base + '/api/posts', { method: 'POST', headers, body }); assert.equal(saved.status, 201);
  const publicPosts = await (await fetch(base + '/data/posts.json')).json();
  assert.equal(publicPosts.posts.length, 1); assert.equal('authorId' in publicPosts.posts[0], false);
  for (const route of ['/%64ata/posts.json', '/data/%70osts.json', '/data//posts.json']) {
    const alternate = await (await fetch(base + route)).json();
    assert.equal(alternate.posts.length, 1); assert.equal('authorId' in alternate.posts[0], false);
  }
  assert.equal((await fetch(base + '/api/auth/logout', { method: 'POST', headers })).status, 200);
  assert.equal((await fetch(base + '/api/me', { headers })).status, 401);
});
test('forged forwarding headers and agent keys never become a human login', async () => {
  for (const extra of [{}, { 'X-Agentglade-Proxy-Key': 'incorrect' }, { Authorization: 'Bearer agentglade_' + 'a'.repeat(43), 'X-Agentglade-Proxy-Key': proxyKey }]) {
    assert.equal((await fetch(base + '/api/me', { headers: { 'Remote-User': 'sso-subject-123', 'Remote-Name': 'Admin', 'Remote-Role': 'Publishers', ...extra } })).status, 401);
  }
  assert.equal((await fetch(base + '/compose/', { redirect: 'manual' })).headers.get('location'), '/login/');
});
test('proxy authentication supports arbitrary stable subjects and never promotes a display name', async () => {
  const response = await fetch(base + '/api/me', { headers: { 'X-Agentglade-Proxy-Key': proxyKey, 'Remote-User': 'provider-subject:1234', 'Remote-Name': 'Admin', 'Remote-Role': 'Publishers' } });
  assert.equal(response.status, 200); const me = await response.json();
  assert.equal(me.role, 'contributor'); assert.notEqual(me.profileId, 'admin');
  assert.equal((await fetch(base + '/api/me', { headers: { 'X-Agentglade-Proxy-Key': proxyKey, 'Remote-User': 'local:operator', 'Remote-Role': 'Publishers' } })).status, 401);
});
test('password attempts are rate limited independently of spoofed forwarded IPs', async () => {
  let limited = false;
  for (let i = 0; i < 12; i++) limited ||= (await login({ username: 'operator', password: 'wrong' }, { 'X-Forwarded-For': `192.0.2.${i}` })).status === 429;
  assert.equal(limited, true);
});
