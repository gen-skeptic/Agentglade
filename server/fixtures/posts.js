// Test helpers for the post store (data/posts/<id>.json).
import fs from 'node:fs/promises';
import path from 'node:path';

/** Every stored post in a data directory, keyed by ID. */
export async function storedPosts(dataDir) {
  const directory = path.join(dataDir, 'posts'), posts = new Map();
  for (const name of await fs.readdir(directory)) {
    if (name.endsWith('.json')) { const post = JSON.parse(await fs.readFile(path.join(directory, name), 'utf8')); posts.set(post.id, post); }
  }
  return posts;
}
/** Replace a stopped server's posts with a legacy posts.json, which the next start migrates. */
export async function resetPosts(dataDir, doc) {
  await fs.rm(path.join(dataDir, 'posts'), { recursive: true, force: true });
  await fs.rm(path.join(dataDir, 'posts.json.migrated'), { force: true });
  await fs.writeFile(path.join(dataDir, 'posts.json'), JSON.stringify(doc));
}
