// Loves are kept on the server so they follow a member across devices and show a
// count to everyone. Each change appends one line to a private log (compacted at
// startup), so a tap never rewrites a large file. Only hashes are stored: never
// account subjects or a browser's visitor token.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex').slice(0, 32);
export const memberKey = (subject) => 'm' + hash('member:' + subject);
export const visitorKey = (token) => typeof token === 'string' && /^[A-Za-z0-9_-]{32,64}$/.test(token) ? 'v' + hash('visitor:' + token) : null;

export async function openLoveStore(dataDir) {
  const file = path.join(dataDir, '.loves.jsonl');
  const byPost = new Map(), byKey = new Map(), links = new Map();
  let lines = 0;
  const add = (post, key) => {
    if (!byPost.has(post)) byPost.set(post, new Set());
    if (!byKey.has(key)) byKey.set(key, new Set());
    byPost.get(post).add(key); byKey.get(key).add(post);
  };
  const drop = (post, key) => {
    byPost.get(post)?.delete(key); byKey.get(key)?.delete(post);
    if (byPost.get(post)?.size === 0) byPost.delete(post);
    if (byKey.get(key)?.size === 0) byKey.delete(key);
  };
  const apply = (entry) => {
    if (entry.v && entry.m) links.set(entry.v, entry.m);
    else if (entry.p && entry.clear) for (const key of [...(byPost.get(entry.p) || [])]) drop(entry.p, key);
    else if (entry.p && entry.k) entry.on ? add(entry.p, entry.k) : drop(entry.p, entry.k);
  };
  try {
    for (const line of (await fs.readFile(file, 'utf8')).split('\n')) {
      if (!line) continue;
      lines++;
      try { apply(JSON.parse(line)); } catch { /* An interrupted last write is ignored. */ }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // State changes at once; writes to the log are queued so they never interleave.
  let writes = Promise.resolve();
  const append = (...entries) => {
    for (const entry of entries) apply(entry);
    lines += entries.length;
    const text = entries.map((entry) => JSON.stringify(entry) + '\n').join('');
    writes = writes.catch(() => {}).then(() => fs.appendFile(file, text, { mode: 0o600 }));
    return writes;
  };
  const resolve = (key) => (key?.startsWith('v') && links.get(key)) || key;

  return {
    /** Rewrite the log as its current state; posts no longer in `exists` lose their loves. */
    async compact(exists) {
      for (const post of [...byPost.keys()]) if (!exists(post)) for (const key of [...byPost.get(post)]) drop(post, key);
      const entries = [...[...links].map(([v, m]) => ({ v, m })), ...[...byPost].flatMap(([p, keys]) => [...keys].map((k) => ({ p, k, on: true })))];
      if (lines <= entries.length + 100) return;
      await writes;
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, entries.map((entry) => JSON.stringify(entry) + '\n').join(''), { mode: 0o600 });
      await fs.rename(tmp, file);
      lines = entries.length;
    },
    resolve,
    count: (post) => byPost.get(post)?.size || 0,
    has: (post, key) => !!key && !!byPost.get(post)?.has(resolve(key)),
    lovedBy: (key) => byKey.get(resolve(key))?.size || 0,
    async set(post, key, on) {
      key = resolve(key);
      if (on !== !!byPost.get(post)?.has(key)) await append({ p: post, k: key, on });
    },
    /** A member opened a community page in this browser: its loves become the member's. */
    async link(visitor, member) {
      if (links.get(visitor) === member) return;
      const entries = [{ v: visitor, m: member }];
      for (const post of byKey.get(visitor) || []) entries.push({ p: post, k: visitor, on: false }, ...(byPost.get(post)?.has(member) ? [] : [{ p: post, k: member, on: true }]));
      await append(...entries);
    },
    async forget(post) { if (byPost.has(post)) await append({ p: post, clear: true }); },
  };
}
