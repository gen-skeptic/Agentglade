import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openPostStore } from './post-store.js';

const post = (id, publishedAt = '2026-11-12T12:00:00.000Z', extra = {}) => ({ id, author: 'Atlas', publishedAt, text: `Post ${id}`, media: [], ...extra });
async function directory() { return fs.mkdtemp(path.join(os.tmpdir(), 'agentglade-store-test-')); }

test('a legacy posts.json migrates into one file per post and is kept as a backup', async () => {
  const dir = await directory();
  try {
    const legacy = { posts: [post('2026-11-10-aaaa', '2026-11-10T08:00:00.000Z'), post('legacy grandma/1'), post('2026-11-11-bbbb', '2026-11-11T08:00:00.000Z')] };
    await fs.writeFile(path.join(dir, 'posts.json'), JSON.stringify(legacy));
    const store = await openPostStore(dir);
    assert.deepEqual(store.all().map((p) => p.id), ['legacy grandma/1', '2026-11-11-bbbb', '2026-11-10-aaaa']);
    assert.deepEqual(store.get('legacy grandma/1'), legacy.posts[1]);
    assert.deepEqual((await fs.readdir(path.join(dir, 'posts'))).sort(), ['2026-11-10-aaaa.json', '2026-11-11-bbbb.json', 'legacy%20grandma%2F1.json']);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'posts.json.migrated'))), legacy);
    await assert.rejects(fs.stat(path.join(dir, 'posts.json')), { code: 'ENOENT' });
    // A second open reads the files and migrates nothing.
    assert.equal((await openPostStore(dir)).size, 3);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('bad legacy data stops startup and leaves posts.json untouched', async () => {
  for (const doc of [{ posts: [post('same'), post('same')] }, { posts: [{ text: 'no id' }] }, { notPosts: [] }]) {
    const dir = await directory();
    try {
      await fs.writeFile(path.join(dir, 'posts.json'), JSON.stringify(doc));
      await assert.rejects(openPostStore(dir), /refusing to migrate/);
      assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, 'posts.json'))), doc);
      await assert.rejects(fs.stat(path.join(dir, 'posts')), { code: 'ENOENT' });
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  }
});

test('an interrupted migration starts over, and stale temporary files are removed', async () => {
  const dir = await directory();
  try {
    await fs.writeFile(path.join(dir, 'posts.json'), JSON.stringify({ posts: [post('one'), post('two')] }));
    await fs.mkdir(path.join(dir, 'posts.migrating'));
    await fs.writeFile(path.join(dir, 'posts.migrating/one.json'), '{"half":');
    let store = await openPostStore(dir);
    assert.equal(store.size, 2);
    await assert.rejects(fs.stat(path.join(dir, 'posts.migrating')), { code: 'ENOENT' });
    await fs.writeFile(path.join(dir, 'posts/one.json.123.tmp'), '{"partial":');
    store = await openPostStore(dir);
    assert.equal(store.size, 2);
    assert.deepEqual((await fs.readdir(path.join(dir, 'posts'))).sort(), ['one.json', 'two.json']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('a post file whose name does not match its ID stops startup', async () => {
  const dir = await directory();
  try {
    await fs.mkdir(path.join(dir, 'posts'));
    await fs.writeFile(path.join(dir, 'posts/renamed.json'), JSON.stringify(post('original')));
    await assert.rejects(openPostStore(dir), /does not match the post ID/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('put and remove write single files, keep newest-first order, and bump the generation', async () => {
  const dir = await directory();
  try {
    const store = await openPostStore(dir);
    assert.equal(store.size, 0);
    const start = store.generation;
    await store.put(post('older', '2026-01-01T00:00:00.000Z'));
    await store.put(post('newer', '2026-06-01T00:00:00.000Z'));
    await store.put(post('older', '2026-01-01T00:00:00.000Z', { text: 'Edited' }));
    assert.deepEqual(store.all().map((p) => p.id), ['newer', 'older']);
    assert.equal(store.get('older').text, 'Edited');
    await store.remove('newer');
    assert.equal(store.has('newer'), false);
    assert.equal(store.generation, start + 4);
    assert.deepEqual(await fs.readdir(path.join(dir, 'posts')), ['older.json']);
    await assert.rejects(store.put(post('x'.repeat(300))), /too long/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
