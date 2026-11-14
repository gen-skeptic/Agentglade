import { hashSecret } from './auth.js';
import { storedPosts, resetPosts } from './fixtures/posts.js';
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const proxyKey = 'synthetic-test-proxy-key-not-for-deployments';
const fetch = (url, options = {}) => globalThis.fetch(url, { ...options, redirect: 'manual', headers: { 'X-Agentglade-Proxy-Key': proxyKey, ...options.headers } });
const admin = '1'.repeat(64), editor = '2'.repeat(64), guest = '3'.repeat(64), other = '4'.repeat(64);
let root, child, base;
async function stop() { if (child && child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.kill(); await ended; } }
async function start(extra = {}) {
  const authFile = path.join(root, 'test-auth.json');
  await fs.writeFile(authFile, JSON.stringify({ proxyTokenHash: hashSecret(proxyKey) }), { mode: 0o600 });
  child = spawn(process.execPath, [new URL('./server.js', import.meta.url).pathname], { env: { ...process.env, NODE_ENV: 'production', PORT: '0', AUTH_CONFIG_FILE: authFile, PUBLIC_ORIGIN: 'https://feed.example.test',
    DATA_DIR: path.join(root, 'data'), MEDIA_DIR: path.join(root, 'media'), MEMBER_ADMINS: JSON.stringify([admin]), MEMBER_ROLE: 'Agentglade Community',
    MEMBER_ACCOUNTS: JSON.stringify({ [admin]: { name: 'Admin', profileId: 'admin' }, [editor]: { name: 'Editor', profileId: 'editor' } }), ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
  base = await new Promise((resolve, reject) => {
    let errors = ''; const timer = setTimeout(() => reject(new Error('Server did not start')), 10000);
    child.stderr.on('data', (data) => { errors += data; }); child.once('exit', () => { clearTimeout(timer); reject(new Error(errors)); }); child.once('error', reject);
    child.stdout.on('data', (data) => { const match = /listening on :(\d+)/.exec(data.toString()); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
  });
}
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentglade-first-login-')); await fs.mkdir(path.join(root, 'data')); await start(); });
afterEach(async () => { await stop(); await fs.rm(root, { recursive: true, force: true }); });
async function call(route, { user = admin, role = user === admin ? 'Admin' : 'Agentglade Community', method = 'GET', json, body, headers = {} } = {}) {
  const response = await fetch(base + route, { method, body: json === undefined ? body : JSON.stringify(json), redirect: 'manual',
    headers: { ...(user ? { 'Remote-User': user } : {}), ...(role ? { 'Remote-Role': role } : {}), 'Remote-Name': user === guest ? 'Taylor' : 'Community member',
      ...(json === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers } });
  return { status: response.status, body: await response.json().catch(() => null), response };
}
const profiles = async () => JSON.parse(await fs.readFile(path.join(root, 'data/profiles.json'))).profiles;
function form(text = 'An update') { const body = new FormData(); body.set('text', text); return body; }
const post = (user) => call('/api/posts', { user, method: 'POST', body: form() });
const edit = (route, item, user, body, method = 'PUT') => call(route, { user, method, body, headers: { 'If-Match': `"${item.version}"` } });

test('eligible first login automatically creates one stable profile, including simultaneous requests', async () => {
  const responses = await Promise.all(Array.from({ length: 8 }, () => call('/api/me', { user: guest })));
  const id = responses[0].body.profileId;
  for (const result of responses) { assert.equal(result.status, 200); assert.equal(result.body.profileId, id); assert.equal(result.body.name, 'Taylor'); assert.equal(result.body.role, 'contributor'); }
  assert.equal((await profiles()).length, 7); assert.match(id, /^member-[a-f0-9]{40}$/);
  await stop(); await start(); assert.equal((await call('/api/me', { user: guest })).body.profileId, id);
  assert.equal((await profiles()).length, 7);
});
test('the community role is exact and required; names, email, generic Admin and old mappings grant nothing', async () => {
  for (const user of [guest, editor, 'local:proxy-admin', null]) {
    for (const role of [null, 'Member', 'Admin', 'Not Agentglade Community', 'Agentglade Community Extra']) {
      for (const route of ['/compose/', '/welcome/', '/%77elcome/', '//welcome/', '/api/me', '/api/posts']) {
        assert.equal((await call(route, { user, role, headers: { 'Remote-Name': 'Admin', 'Remote-Email': 'editor@example.test' } })).status, route.startsWith('/api/') ? 401 : 302);
      }
    }
  }
  assert.equal((await profiles()).length, 6);
  assert.equal((await call('/api/me', { user: null, headers: { 'Remote-Email': admin } })).status, 401);
  assert.equal((await call('/api/me', { user: guest, role: 'Member, Agentglade Community' })).status, 200);
  assert.equal((await call('/api/me', { user: 'local:proxy-admin', role: 'Agentglade Community' })).status, 401);
  assert.equal((await call('/api/me', { user: guest, headers: { Authorization: 'Bearer agentglade_' + 'a'.repeat(43) } })).status, 401);
});
test('first login links legacy posts only by their exact author identity and preserves their content', async () => {
  const original = { id: 'legacy-grandma', author: 'Old name', authorId: guest, text: 'Keep this memory', publishedAt: '2026-11-12T12:00:00Z', media: [] };
  const unrelated = { ...original, id: 'different-account', authorId: other };
  await stop(); await resetPosts(path.join(root, 'data'), { posts: [original, unrelated] }); await start();
  const me = (await call('/api/me', { user: guest })).body;
  const saved = (await call('/api/posts/' + original.id)).body;
  assert.equal(saved.profileId, me.profileId); assert.equal(saved.author, 'Taylor');
  assert.equal(saved.text, original.text); assert.equal(saved.publishedAt, original.publishedAt); assert.deepEqual(saved.media, original.media);
  assert.equal((await call('/api/posts/' + unrelated.id)).body.author, 'Old name');
});
test('Admin keeps his exact existing identity and profile as the only Admin; Editor stays Editor', async () => {
  const owner = await call('/api/me'); assert.equal(owner.body.profileId, 'admin'); assert.equal(owner.body.name, 'Admin'); assert.equal(owner.body.role, 'admin'); assert.equal(owner.body.needsSetup, false);
  const mother = await call('/api/me', { user: editor, headers: { 'Remote-Name': 'Morgan' } });
  assert.equal(mother.body.profileId, 'editor'); assert.equal(mother.body.name, 'Editor'); assert.equal(mother.body.role, 'contributor'); assert.equal(mother.body.needsSetup, false);
  const fake = await call('/api/me', { user: guest, headers: { 'Remote-Name': 'Admin', 'Remote-Email': 'admin@example.test' } });
  assert.equal(fake.body.role, 'contributor'); assert.notEqual(fake.body.profileId, 'admin');
  const agentName = await call('/api/me', { user: other, headers: { 'Remote-Name': 'Atlas' } }); assert.notEqual(agentName.body.profileId, 'atlas');
});
test('the combined Workspace/Agentglade role admits community members without granting site administration', async () => {
  await stop(); await start({ MEMBER_ROLE: '', MEMBER_ROLES: JSON.stringify(['Agentglade Community', 'Workspace and Agentglade Community']) });
  for (const role of ['Agentglade Community', 'Workspace and Agentglade Community', 'Member, Workspace and Agentglade Community']) {
    const me = await call('/api/me', { user: guest, role });
    assert.equal(me.status, 200); assert.equal(me.body.role, 'contributor');
    assert.equal((await call('/api/posts', { user: guest, role, method: 'POST', body: form('Shared community update') })).status, 201);
  }
  const admins = (await post(admin)).body;
  const changed = await call('/api/posts/' + admins.id, { user: guest, role: 'Workspace and Agentglade Community', method: 'PUT', body: form(), headers: { 'If-Match': `"${admins.version}"` } });
  assert.equal(changed.status, 403);
  for (const role of ['Workspace Community', 'Admin', 'Not Workspace and Agentglade Community']) assert.equal((await call('/api/me', { user: guest, role })).status, 401);
  assert.equal((await call('/api/me')).body.role, 'admin');
});
test('all community members edit only their own posts/profile; only Admin edits others and agent posts', async () => {
  const guestMe = (await call('/api/me', { user: guest })).body;
  const own = (await post(guest)).body, admins = (await post(admin)).body, editors = (await post(editor)).body;
  assert.equal(own.author, 'Taylor'); assert.equal(own.profileId, guestMe.profileId); assert.equal('authorId' in own, false); assert.equal(own.canEdit, true);
  assert.equal((await storedPosts(path.join(root, 'data'))).get(own.id).authorId, guest);
  for (const user of [editor, guest]) {
    for (const target of [admins, user === editor ? own : editors]) {
      assert.equal((await edit('/api/posts/' + target.id, target, user, form())).status, 403);
      assert.equal((await edit('/api/posts/' + target.id, target, user, undefined, 'DELETE')).status, 403);
    }
  }
  const updated = await edit('/api/posts/' + own.id, own, guest, form('Own edit')); assert.equal(updated.status, 200);
  assert.equal((await edit('/api/posts/' + editors.id, editors, admin, form('Admin edit'))).status, 200);
  const list = (await call('/api/profiles')).body.profiles;
  for (const item of list) {
    const body = new FormData(); body.set('name', item.name); body.set('bio', 'Updated');
    assert.equal((await edit('/api/profiles/' + item.id, item, guest, body)).status, item.id === guestMe.profileId ? 200 : 403);
  }
  const data = list.find((p) => p.id === 'atlas'), body = new FormData(); body.set('name', 'Atlas'); body.set('bio', 'Admin can edit');
  assert.equal((await edit('/api/profiles/atlas', data, admin, body)).status, 200);
  assert.equal((await edit('/api/posts/' + own.id, updated.body, guest, undefined, 'DELETE')).status, 204);
});
test('post APIs never reveal account subjects and report edit rights for the viewer', async () => {
  const own = (await post(guest)).body, admins = (await post(admin)).body;
  const expect = { [guest]: { [own.id]: true, [admins.id]: false }, [editor]: { [own.id]: false, [admins.id]: false }, [admin]: { [own.id]: true, [admins.id]: true } };
  for (const [user, rights] of Object.entries(expect)) {
    const list = (await call('/api/posts', { user })).body.posts;
    for (const [id, canEdit] of Object.entries(rights)) {
      const listed = list.find((item) => item.id === id), single = (await call('/api/posts/' + id, { user })).body;
      for (const view of [listed, single]) { assert.equal(view.canEdit, canEdit); assert.equal('authorId' in view, false); }
      assert.equal(JSON.stringify(single).includes(guest) || JSON.stringify(single).includes(admin), false);
    }
  }
});
test('first login opens welcome; saving or skipping setup persists and cannot modify another account', async () => {
  const first = await call('/compose/', { user: guest }); assert.equal(first.status, 302); assert.equal(first.response.headers.get('location'), '/welcome/');
  assert.equal((await call('/welcome/', { user: guest })).status, 200);
  const me = (await call('/api/me', { user: guest })).body; assert.equal(me.needsSetup, true);
  assert.equal((await call('/api/me/setup', { user: guest, method: 'POST', json: {}, headers: { Origin: 'https://evil.example' } })).status, 403);
  const item = (await call('/api/profiles')).body.profiles.find((p) => p.id === me.profileId), body = new FormData(); body.set('name', 'Taylor June'); body.set('bio', 'A community bio');
  assert.equal((await edit('/api/profiles/' + item.id, item, guest, body)).status, 200);
  assert.equal((await call('/api/me', { user: guest })).body.needsSetup, false);
  assert.equal((await call('/compose/', { user: guest })).status, 200);
  await call('/api/me', { user: other });
  assert.equal((await call('/api/me/setup', { user: other, method: 'POST', json: { subject: admin, role: 'admin', profileId: 'admin' } })).status, 204);
  const otherMe = (await call('/api/me', { user: other })).body; assert.equal(otherMe.role, 'contributor'); assert.notEqual(otherMe.profileId, 'admin');
  await stop(); await start(); assert.equal((await call('/api/me', { user: guest })).body.needsSetup, false);
});
test('loss of the upstream role denies access despite a stored profile; restoring membership reuses it', async () => {
  const me = (await call('/api/me', { user: guest })).body, created = (await post(guest)).body;
  assert.equal((await call('/api/me', { user: guest, role: 'Member' })).status, 401);
  assert.equal((await call('/api/posts', { user: guest, role: null, method: 'POST', body: form() })).status, 401);
  await stop(); await start();
  assert.equal((await call('/api/me', { user: guest, role: null })).status, 401);
  assert.equal((await call('/api/me', { user: guest })).body.profileId, me.profileId);
  assert.equal((await call('/api/posts/' + created.id)).status, 200);
  assert.equal((await profiles()).length, 7);
  assert.equal((await call('/api/community', { user: guest, method: 'PUT', json: { role: 'admin' } })).status, 404);
  assert.equal((await call('/api/profiles', { user: guest, method: 'POST', json: { name: 'Admin', id: 'admin' } })).status, 404);
});
test('a committed binding repairs interrupted profile creation and private mappings are never served', async () => {
  const me = (await call('/api/me', { user: guest })).body;
  await stop(); const list = await profiles(); await fs.writeFile(path.join(root, 'data/profiles.json'), JSON.stringify({ profiles: list.filter((p) => p.id !== me.profileId) })); await start();
  assert.equal((await call('/api/me', { user: guest })).body.profileId, me.profileId); assert.equal((await profiles()).length, 7);
  assert.equal((await fs.stat(path.join(root, 'data/.member-profiles.json'))).mode & 0o777, 0o600);
  for (const route of ['/data/.member-profiles.json', '/.member-profiles.json']) assert.equal((await call(route, { user: null })).status, 404);
  for (const profile of await profiles()) assert.equal('subject' in profile || 'email' in profile, false);
});
test('accounts configured after the first start get their configured profile without moving existing bindings', async () => {
  const later = '5'.repeat(64), unsigned = '6'.repeat(64), conflicting = '7'.repeat(64);
  const base = { [admin]: { name: 'Admin', profileId: 'admin' }, [editor]: { name: 'Editor', profileId: 'editor' } };
  await stop(); await start({ MEMBER_ACCOUNTS: JSON.stringify({ ...base, [unsigned]: {} }) });
  await stop(); await start({ MEMBER_ACCOUNTS: JSON.stringify({ ...base, [unsigned]: { profileId: 'orbit' }, [later]: { name: 'Nova', profileId: 'nova' }, [conflicting]: { profileId: 'editor' } }) });
  const added = (await call('/api/me', { user: later })).body;
  assert.equal(added.profileId, 'nova'); assert.equal(added.name, 'Nova'); assert.equal(added.needsSetup, false);
  // Listed on an earlier start but never signed in, so nothing was bound yet.
  assert.equal((await call('/api/me', { user: unsigned })).body.profileId, 'orbit');
  // A profile that already belongs to someone is never reassigned.
  const refused = (await call('/api/me', { user: conflicting })).body;
  assert.match(refused.profileId, /^member-[a-f0-9]{40}$/); assert.equal(refused.needsSetup, true);
  assert.equal((await call('/api/me', { user: editor })).body.profileId, 'editor');
  // A restart with the same configuration changes nothing further.
  const ledger = await fs.readFile(path.join(root, 'data/.member-profiles.json'), 'utf8');
  await stop(); await start({ MEMBER_ACCOUNTS: JSON.stringify({ ...base, [unsigned]: { profileId: 'orbit' }, [later]: { name: 'Nova', profileId: 'nova' }, [conflicting]: { profileId: 'editor' } }) });
  assert.equal(await fs.readFile(path.join(root, 'data/.member-profiles.json'), 'utf8'), ledger);
});
test('malformed binding data fails closed rather than guessing by name or email', async () => {
  await stop(); await fs.writeFile(path.join(root, 'data/.member-profiles.json'), '{"schema":1,"accounts":[{"name":"Admin"}]}');
  await assert.rejects(start(), /Invalid community profile ledger/);
});
