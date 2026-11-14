// Posts live one file each in DATA_DIR/posts and are served from memory, so a save
// writes one small file instead of rewriting every post in the feed. The server is
// the only writer: it serializes changes with its write lock, and files edited by
// hand are read at the next start.
import fs from 'node:fs/promises';
import path from 'node:path';

const fileName = (id) => {
  const name = `${encodeURIComponent(id)}.json`;
  if (name.length > 200) throw new Error(`Post ID is too long to store: ${id.slice(0, 40)}…`);
  return name;
};
export const newestFirst = (a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || b.id.localeCompare(a.id);
async function writeAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n');
  await fs.rename(tmp, file);
}

// Earlier releases kept every post in one posts.json. Split it once, through a
// staging directory so an interrupted migration starts over cleanly, and keep the
// original beside it as posts.json.migrated.
async function migrate(directory, legacy) {
  try { await fs.access(directory); return; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let doc;
  try { doc = JSON.parse(await fs.readFile(legacy, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.mkdir(directory, { recursive: true });
    return;
  }
  if (!Array.isArray(doc?.posts)) throw new Error('posts.json does not hold a post list; refusing to migrate it.');
  const staging = `${directory}.migrating`, seen = new Set();
  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(staging);
  for (const post of doc.posts) {
    if (typeof post?.id !== 'string' || !post.id || seen.has(post.id)) throw new Error('posts.json has a post without a unique ID; refusing to migrate it.');
    seen.add(post.id);
    await writeAtomic(path.join(staging, fileName(post.id)), post);
  }
  await fs.rename(staging, directory);
  await fs.rename(legacy, `${legacy}.migrated`);
}

export async function openPostStore(dataDir) {
  const directory = path.join(dataDir, 'posts');
  await migrate(directory, path.join(dataDir, 'posts.json'));
  const posts = new Map();
  for (const name of await fs.readdir(directory)) {
    if (name.endsWith('.tmp')) { await fs.rm(path.join(directory, name), { force: true }); continue; }
    if (!name.endsWith('.json')) continue;
    const post = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
    if (typeof post?.id !== 'string' || fileName(post.id) !== name) throw new Error(`posts/${name} does not match the post ID inside it; refusing to guess.`);
    posts.set(post.id, post);
  }
  let sorted = null, generation = 0;
  const changed = () => { sorted = null; generation++; };
  return {
    /** Every post, newest first. Treat the array and its posts as read-only. */
    all: () => (sorted ||= [...posts.values()].sort(newestFirst)),
    get: (id) => posts.get(id),
    has: (id) => posts.has(id),
    get size() { return posts.size; },
    /** Increases on every change, for caches derived from the posts. */
    get generation() { return generation; },
    async put(post) { await writeAtomic(path.join(directory, fileName(post.id)), post); posts.set(post.id, post); changed(); },
    async remove(id) { await fs.rm(path.join(directory, fileName(id)), { force: true }); posts.delete(id); changed(); },
  };
}
