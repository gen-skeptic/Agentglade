// Drafts saved to a member's account, so a post started on a phone can be finished on
// a laptop. Photos and videos are uploaded as they are added; posting then refers to
// them instead of uploading them again. Everything lives under data/.drafts in
// folders named by hashes, never by account subjects.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const hash = (value, length) => crypto.createHash('sha256').update(value).digest('hex').slice(0, length);
const MEDIA_ID = /^[a-f0-9]{32}$/;
const DAY = 24 * 60 * 60 * 1000;
export const draftScope = (value) => (value === 'new' || (typeof value === 'string' && /^edit:\S{1,200}$/.test(value)) ? value : null);
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const isString = (value, max) => typeof value === 'string' && value.length <= max;

// The fields a draft keeps; anything else is refused rather than stored.
function checkedFields(fields) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) fail(400, 'Invalid draft.');
  const allowed = { text: (v) => isString(v, 20000), milestone: (v) => isString(v, 200), milestoneOn: (v) => typeof v === 'boolean', when: (v) => isString(v, 40),
    version: (v) => v === null || isString(v, 100), retained: (v) => Array.isArray(v) && v.length <= 20 && v.every((entry) => isString(entry, 300)
      || (entry && typeof entry === 'object' && isString(entry.src, 300) && (entry.alt === undefined || isString(entry.alt, 300)))) };
  for (const [key, value] of Object.entries(fields)) if (!allowed[key]?.(value) && value !== undefined) fail(400, `Invalid draft field: ${key}.`);
  return Object.fromEntries(Object.keys(allowed).filter((key) => fields[key] !== undefined).map((key) => [key, fields[key]]));
}

export async function openDraftStore({ dataDir, maxBytes, maxFiles = 20, maxDrafts = 10, keepDays = 90 }) {
  const root = path.join(dataDir, '.drafts');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const memberDir = (subject) => path.join(root, hash('member:' + subject, 32));
  const draftDir = (subject, scope) => path.join(memberDir(subject), hash('scope:' + scope, 24));
  const mediaDir = (subject, scope) => path.join(draftDir(subject, scope), 'media');
  // A posted or discarded draft leaves a marker, so another device holding an old
  // copy knows to drop it instead of saving it back.
  const finishedFile = (subject, scope) => `${draftDir(subject, scope)}.done`;
  const readJson = async (file) => { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  async function writeJson(file, value) {
    const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
    await fs.rename(tmp, file);
  }
  async function uploaded(subject, scope) {
    const dir = mediaDir(subject, scope), found = new Map();
    let names = [];
    try { names = await fs.readdir(dir); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const meta = await readJson(path.join(dir, name)), id = name.slice(0, -5);
      if (meta && MEDIA_ID.test(id)) found.set(id, meta);
    }
    return found;
  }
  // Starting a draft for a new scope counts against the member's limit.
  async function makeRoom(subject, scope) {
    const dir = draftDir(subject, scope);
    await fs.rm(finishedFile(subject, scope), { force: true });
    try { await fs.access(dir); return dir; } catch {}
    let existing = [];
    try { existing = (await fs.readdir(memberDir(subject), { withFileTypes: true })).filter((entry) => entry.isDirectory()); } catch {}
    if (existing.length >= maxDrafts) fail(409, `You have ${maxDrafts} saved drafts. Post or discard one first.`);
    await fs.mkdir(path.join(dir, 'media'), { recursive: true, mode: 0o700 });
    return dir;
  }

  return {
    /** The draft, or { finishedAt } once it was posted or discarded, or null. */
    async get(subject, scope) {
      const draft = await readJson(path.join(draftDir(subject, scope), 'draft.json'));
      if (!draft) { const finished = await readJson(finishedFile(subject, scope)); return finished?.finishedAt ? { finishedAt: finished.finishedAt } : null; }
      const media = await uploaded(subject, scope);
      return { fields: draft.fields, updatedAt: draft.updatedAt,
        media: draft.media.filter((item) => media.has(item.id)).map((item) => ({ ...media.get(item.id), id: item.id, alt: item.alt })) };
    },
    async save(subject, scope, body) {
      const fields = checkedFields(body?.fields);
      if (!Array.isArray(body?.media) || body.media.length > maxFiles || body.media.some((item) => !MEDIA_ID.test(item?.id) || !isString(item.alt ?? '', 300))) fail(400, 'Invalid draft media.');
      const dir = await makeRoom(subject, scope), media = await uploaded(subject, scope);
      const draft = { fields, media: body.media.filter((item) => media.has(item.id)).map(({ id, alt }) => ({ id, alt: alt || '' })), updatedAt: new Date().toISOString() };
      await writeJson(path.join(dir, 'draft.json'), draft);
      return { updatedAt: draft.updatedAt };
    },
    async addMedia(subject, scope, file) {
      const dir = path.join(await makeRoom(subject, scope), 'media'), media = await uploaded(subject, scope);
      if (media.size >= maxFiles) fail(409, `A draft holds up to ${maxFiles} photos and videos.`);
      const used = [...media.values()].reduce((total, item) => total + item.size, 0);
      if (used + file.size > maxBytes) fail(413, `This draft is over the ${Math.round(maxBytes / 1048576)} MiB limit. Remove a photo or video first.`);
      const id = crypto.randomBytes(16).toString('hex'), meta = { name: String(file.name || 'media').slice(0, 200), type: file.type, size: file.size, addedAt: new Date().toISOString() };
      await fs.writeFile(path.join(dir, id), Buffer.from(await file.arrayBuffer()), { mode: 0o600, flag: 'wx' });
      await writeJson(path.join(dir, `${id}.json`), meta);
      return { id, name: meta.name, type: meta.type, size: meta.size };
    },
    async media(subject, scope, id) {
      if (!MEDIA_ID.test(id || '')) return null;
      const meta = await readJson(path.join(mediaDir(subject, scope), `${id}.json`));
      return meta && { ...meta, file: path.join(mediaDir(subject, scope), id) };
    },
    async removeMedia(subject, scope, id) {
      if (!MEDIA_ID.test(id || '')) return;
      await fs.rm(path.join(mediaDir(subject, scope), `${id}.json`), { force: true });
      await fs.rm(path.join(mediaDir(subject, scope), id), { force: true });
    },
    /** Files for a post that refers to uploaded draft media, in the given order. */
    async files(subject, scope, refs) {
      if (!Array.isArray(refs) || refs.length > maxFiles || refs.some((ref) => !MEDIA_ID.test(ref?.id))) fail(400, 'Invalid draft photos.');
      const media = await uploaded(subject, scope);
      if (refs.some((ref) => !media.has(ref.id))) fail(400, 'A draft photo is missing. Reload the draft and try again.');
      if (refs.reduce((total, ref) => total + media.get(ref.id).size, 0) > maxBytes) fail(413, `This post is over the ${Math.round(maxBytes / 1048576)} MiB upload limit.`);
      return Promise.all(refs.map(async (ref) => {
        const meta = media.get(ref.id);
        return new File([await fs.readFile(path.join(mediaDir(subject, scope), ref.id))], meta.name, { type: meta.type });
      }));
    },
    async remove(subject, scope) {
      await fs.rm(draftDir(subject, scope), { recursive: true, force: true });
      await fs.mkdir(memberDir(subject), { recursive: true, mode: 0o700 });
      await writeJson(finishedFile(subject, scope), { finishedAt: new Date().toISOString() });
    },
    /** At startup: forget drafts untouched for keepDays, and uploads no draft kept after a day. */
    async sweep() {
      const now = Date.now();
      for (const member of await fs.readdir(root)) {
        const memberPath = path.join(root, member);
        for (const scope of await fs.readdir(memberPath).catch(() => [])) {
          if (scope.endsWith('.done')) {
            const finished = await readJson(path.join(memberPath, scope)).catch(() => null);
            if (now - (Date.parse(finished?.finishedAt) || 0) > keepDays * DAY) await fs.rm(path.join(memberPath, scope), { force: true });
            continue;
          }
          const dir = path.join(memberPath, scope), draft = await readJson(path.join(dir, 'draft.json')).catch(() => null);
          const touched = Date.parse(draft?.updatedAt) || (await fs.stat(dir)).mtimeMs;
          if (now - touched > keepDays * DAY) { await fs.rm(dir, { recursive: true, force: true }); continue; }
          const listed = new Set((draft?.media || []).map((item) => item.id));
          for (const name of await fs.readdir(path.join(dir, 'media')).catch(() => [])) {
            const id = name.replace(/\.json$/, '');
            if (listed.has(id)) continue;
            const meta = await readJson(path.join(dir, 'media', `${id}.json`)).catch(() => null);
            if (now - (Date.parse(meta?.addedAt) || 0) > DAY) await fs.rm(path.join(dir, 'media', name), { force: true });
          }
        }
        if (!(await fs.readdir(memberPath).catch(() => [])).length) await fs.rm(memberPath, { recursive: true, force: true });
      }
    },
  };
}
