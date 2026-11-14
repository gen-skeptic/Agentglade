// Agentglade: public feed, private publishing, and independent agent credentials.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { preparePhoto } from './photos.js';
import { createAgentService } from './agents.js';
import { createHumanAuth } from './auth.js';
import { createMemberAccess } from './member-access.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE_DIR = path.resolve(process.env.SITE_DIR || path.join(HERE, '..'));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(SITE_DIR, 'data'));
const MEDIA_DIR = path.resolve(process.env.MEDIA_DIR || path.join(SITE_DIR, 'media'));
const SEED_DIR = path.join(SITE_DIR, 'data');
const PORT = Number(process.env.PORT || 8080);
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB || 64) * 1024 * 1024;
const publicUrl = new URL(process.env.PUBLIC_ORIGIN || 'http://localhost:8080');
if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) throw new Error('PUBLIC_ORIGIN must be an HTTP(S) origin without credentials or a path.');
const PUBLIC_ORIGIN = publicUrl.origin;
const humanAuth = await createHumanAuth({ configFile: process.env.AUTH_CONFIG_FILE, origin: PUBLIC_ORIGIN });
// Optional proxy accounts bind exact stable subjects to public profiles.
const MEMBER_ACCOUNTS = { ...(process.env.MEMBER_ACCOUNTS ? JSON.parse(process.env.MEMBER_ACCOUNTS) : {}), ...(humanAuth.localSubject ? { [humanAuth.localSubject]: humanAuth.localAccount } : {}) };
if (MEMBER_ACCOUNTS !== null && (typeof MEMBER_ACCOUNTS !== 'object' || Array.isArray(MEMBER_ACCOUNTS)
  || Object.entries(MEMBER_ACCOUNTS).some(([user, profile]) => !user || !profile || typeof profile !== 'object'
    || Array.isArray(profile) || (profile.name !== undefined && (typeof profile.name !== 'string' || !profile.name.trim()))))) {
  throw new Error('MEMBER_ACCOUNTS must map proxy Remote-User values to profile objects.');
}
const community = createMemberAccess({ directory: DATA_DIR, accounts: MEMBER_ACCOUNTS,
  owners: [...JSON.parse(process.env.MEMBER_ADMINS || '[]'), ...(humanAuth.localSubject ? [humanAuth.localSubject] : [])], requiredRoles: process.env.MEMBER_ROLES
    ? JSON.parse(process.env.MEMBER_ROLES) : process.env.MEMBER_ROLE ? [process.env.MEMBER_ROLE] : [] });

// Only these top-level paths are served from SITE_DIR.
const PUBLIC_TOP = new Set(['', 'index.html', 'robots.txt', 'assets', 'compose', 'manage', 'profiles', 'welcome', 'login']);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.avif': 'image/avif', '.heic': 'image/heic', '.heif': 'image/heif', '.tiff': 'image/tiff', '.woff2': 'font/woff2',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
};
const EXT = Object.fromEntries(Object.entries(MIME).filter(([, m]) => /^(image|video)\//.test(m)).map(([e, m]) => [m, e]));
EXT['image/jpeg'] = '.jpg';
// SVG remains available for bundled artwork, but uploaded media is passive.
delete EXT['image/svg+xml'];

/* ---------- helpers ---------- */
function send(res, status, body, headers = {}) {
  const isObj = body && typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': isObj ? MIME['.json'] : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(isObj ? JSON.stringify(body) : body);
}

function forwardedIdentity(req) { return humanAuth.identity(req); }
function identity(req) {
  const forwarded = forwardedIdentity(req);
  return forwarded ? community.session(forwarded) : null;
}
async function ensureIdentity(req) {
  const forwarded = forwardedIdentity(req);
  if (community.allowed(forwarded)) await withLock(async () => {
    const doc = await readProfiles(), profile = await community.ensure(forwarded, doc.profiles);
    if (!profile) return;
    const file = path.join(DATA_DIR, 'profiles.json'), tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify({ ...doc, profiles: [...doc.profiles, profile] }, null, 2) + '\n');
    await fsp.rename(tmp, file);
    await migrateProfiles();
  });
  return identity(req);
}
function requireEdit(who, item, kind) {
  if (!community.canEdit(who, item, kind)) fail(403, 'You can only edit your own posts and profile.');
}
async function readJSON(req) {
  if (!sameOrigin(req)) fail(403, 'Cross-site request refused.');
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) fail(415, 'Expected JSON.');
  const chunks = []; let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 16384) { req.resume(); fail(413, 'Request too large.'); }
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'Invalid JSON.'); }
}

// Browser mutations must come from the configured public origin.
function sameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin === PUBLIC_ORIGIN;
}

const initials = (name) => name.split(/[\s@._-]+/).filter(Boolean).map((w) => w[0]).join('').slice(0, 2).toUpperCase() || '?';
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };
const version = (post) => crypto.createHash('sha256').update(JSON.stringify(post)).digest('hex');
const editable = (post) => ({ ...post, version: version(post) });
function checkVersion(req, post) {
  if (!req.headers['if-match']) fail(428, 'Reload this post before changing it.');
  if (req.headers['if-match'] !== `"${version(post)}"`) fail(412, 'This post changed in another window. Reload the latest post before saving or deleting.');
}

/* ---------- data ---------- */
async function seed() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(MEDIA_DIR, { recursive: true });
  for (const f of ['posts.json', 'site.json', 'profiles.json']) {
    const dest = path.join(DATA_DIR, f);
    if (!fs.existsSync(dest) && DATA_DIR !== SEED_DIR) await fsp.copyFile(path.join(SEED_DIR, f), dest);
  }
}

let writeChain = Promise.resolve();
function withLock(fn) {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => {});
  return run;
}

async function readPosts() {
  return JSON.parse(await fsp.readFile(path.join(DATA_DIR, 'posts.json'), 'utf8'));
}
async function writePosts(doc) {
  const file = path.join(DATA_DIR, 'posts.json');
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(doc, null, 2) + '\n');
  await fsp.rename(tmp, file);
}
async function readProfiles() {
  return JSON.parse(await fsp.readFile(path.join(DATA_DIR, 'profiles.json'), 'utf8'));
}
const profileIdFor = (who) => who.profileId || null;
async function postAuthor(who) {
  const id = profileIdFor(who);
  const profile = id && (await readProfiles()).profiles.find((item) => item.id === id);
  if (who.user.startsWith('agent:') && !profile) fail(503, 'The configured agent profile does not exist.');
  return profile ? { author: profile.name, initials: initials(profile.name), authorId: who.user, profileId: profile.id }
    : { author: who.name, initials: initials(who.name), authorId: who.user };
}
async function updateProfile(req, res, who, id) {
  const form = await readMultipart(req);
  const name = form.get('name'), bio = form.get('bio') || '', removeAvatar = form.get('removeAvatar') === 'true';
  const avatar = form.get('avatar');
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 60 || typeof bio !== 'string' || bio.length > 1000) fail(400, 'Use a name up to 60 characters and a bio up to 1000 characters.');
  if (avatar && (typeof avatar !== 'object' || !avatar.type.startsWith('image/') || !EXT[avatar.type])) fail(415, 'Choose a supported photo for the profile.');
  if (avatar && removeAvatar) fail(400, 'Choose a new photo or remove the old one.');
  const updated = await withLock(async () => {
    const doc = await readProfiles(), previous = doc.profiles.find((profile) => profile.id === id);
    if (!previous) fail(404, 'Profile not found.');
    requireEdit(who, previous, 'profile');
    checkVersion(req, previous);
    const added = avatar?.size ? await storeMedia({ files: [avatar], meta: [] }, new Date().toISOString()) : [];
    const next = { ...previous, name: name.trim(), bio: bio.trim(), updatedAt: new Date().toISOString() };
    if (added.length || removeAvatar) { next.avatar = added[0]?.src || null; next.avatarPreview = added[0]?.previewSrc || null; }
    const history = path.join(DATA_DIR, '.profile-history');
    try {
      await fsp.mkdir(history, { recursive: true, mode: 0o700 });
      await fsp.writeFile(path.join(history, `${Date.now()}-${crypto.randomUUID()}.json`), JSON.stringify({ profile: previous, actor: who.user, at: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
      const file = path.join(DATA_DIR, 'profiles.json'), tmp = `${file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify({ ...doc, profiles: doc.profiles.map((profile) => profile.id === id ? next : profile) }, null, 2) + '\n');
      await fsp.rename(tmp, file);
      if (who.profileId === id) await community.finishSetup(who);
    } catch (error) { await removeUnused(added); throw error; }
    await removeUnused([{ src: previous.avatar, previewSrc: previous.avatarPreview }]);
    return next;
  });
  return send(res, 200, editable(updated));
}

// Apply account display names to old posts as well as future publications.
// Save each previous record with the same private history used for normal edits.
async function migrateProfiles() {
  const doc = await readPosts();
  const profiles = (await readProfiles()).profiles;
  let changed = false;
  for (const post of doc.posts) {
    if (post.profileId) continue;
    const configured = community.account(post.authorId);
    const profile = profiles.find((item) => item.id === configured?.profileId);
    const name = profile?.name || configured?.name;
    if (!name || (post.author === name && post.initials === initials(name) && (!profile || post.profileId === profile.id))) continue;
    await archivePost(post, { user: 'system' }, 'profile-name');
    post.author = name;
    post.initials = initials(name);
    if (profile) post.profileId = profile.id;
    changed = true;
  }
  if (changed) await writePosts(doc);

}

/* ---------- post management ---------- */
async function readMultipart(req) {
  if (!sameOrigin(req)) fail(403, 'Cross-site request refused.');
  if (!/^multipart\/form-data\b/i.test(req.headers['content-type'] || '')) fail(415, 'Expected a post with text and media.');
  const tooLarge = () => { req.resume(); fail(413, `Upload is over ${MAX_UPLOAD / 1048576} MB.`); };
  if (Number(req.headers['content-length'] || 0) > MAX_UPLOAD) tooLarge();
  const chunks = [];
  let size = 0;
  // Count actual bytes as well as Content-Length, including chunked requests.
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_UPLOAD) tooLarge();
    chunks.push(chunk);
  }
  let form;
  try {
    form = await new Request('http://local', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: Buffer.concat(chunks) }).formData();
  } catch { fail(400, 'Could not read the upload.'); }
  return form;
}
async function readForm(req) {
  const form = await readMultipart(req);
  const field = (name) => {
    const value = form.get(name);
    if (value !== null && typeof value !== 'string') fail(400, `Invalid ${name}.`);
    return value || '';
  };
  const text = field('text').trim();
  const milestone = field('milestone').trim() || null;
  if (text.length > 20000 || (milestone && milestone.length > 60)) fail(400, 'Post text or milestone is too long.');
  const date = field('publishedAt');
  if (date && Number.isNaN(new Date(date).getTime())) fail(400, 'Choose a valid post date.');
  let meta, retained;
  try { meta = JSON.parse(field('mediaMeta') || '[]'); retained = form.has('retainMedia') ? JSON.parse(field('retainMedia')) : null; }
  catch { fail(400, 'Invalid media information.'); }
  if (!Array.isArray(meta) || meta.some((m) => !m || typeof m !== 'object' || Array.isArray(m))) fail(400, 'Invalid media information.');
  if (retained !== null && (!Array.isArray(retained) || retained.some((src) => typeof src !== 'string') || new Set(retained).size !== retained.length)) fail(400, 'Invalid retained photos.');
  const files = form.getAll('media').filter((f) => typeof f === 'object' && f.size > 0);
  if (files.length > 20) fail(400, 'Up to 20 photos and videos per post.');
  for (const file of files) if (!EXT[file.type]) fail(415, `Unsupported file type: ${file.type || 'unknown'}.`);
  const dryRun = field('dryRun');
  if (dryRun && !['true', 'false'].includes(dryRun)) fail(400, 'dryRun must be true or false.');
  return { text, milestone, publishedAt: date ? new Date(date).toISOString() : null, meta, retained, files, dryRun: dryRun === 'true' };
}

function uploadedPath(src) {
  if (typeof src !== 'string' || !/^media\/\d{4}\/\d{2}\/[^/]+$/.test(src) || src.includes('..')) return null;
  return path.join(MEDIA_DIR, ...src.split('/').slice(1));
}
async function mediaReferences(doc) {
  doc ||= await readPosts();
  const refs = new Set(doc.posts.flatMap((post) => (post.media || []).flatMap((m) => [m.src, m.previewSrc].filter(Boolean))));
  const site = JSON.parse(await fsp.readFile(path.join(DATA_DIR, 'site.json'), 'utf8'));
  if (site.avatar) refs.add(site.avatar);
  for (const profile of (await readProfiles()).profiles) {
    if (profile.avatar) refs.add(profile.avatar);
    if (profile.avatarPreview) refs.add(profile.avatarPreview);
  }
  return refs;
}
async function removeUnused(items, doc) {
  const refs = await mediaReferences(doc);
  for (const src of new Set(items.flatMap((item) => [item.src, item.previewSrc].filter(Boolean)))) {
    const file = uploadedPath(src);
    if (!file || refs.has(src)) continue;
    try { await fsp.unlink(file); }
    catch (err) { if (err.code !== 'ENOENT') console.warn('Unused media cleanup failed:', path.basename(file), err.code); }
  }
}
async function storeMedia(input, publishedAt) {
  const sub = publishedAt.slice(0, 7).replace('-', '/');
  const prefix = `${publishedAt.slice(0, 10)}-${crypto.randomBytes(8).toString('hex')}`;
  await fsp.mkdir(path.join(MEDIA_DIR, sub), { recursive: true });
  const media = [];
  try {
    for (const [i, file] of input.files.entries()) {
      const photo = file.type.startsWith('image/') ? await preparePhoto(file) : null;
      const name = `${prefix}-${i + 1}${photo ? '.webp' : EXT[file.type]}`;
      const src = `media/${sub}/${name}`;
      // Track each new file before writing, so partial writes are cleaned too.
      media.push({ type: file.type.startsWith('video/') ? 'video' : 'image', src, alt: String(input.meta[i]?.alt || '').slice(0, 300) });
      if (photo) {
        const item = media.at(-1);
        Object.assign(item, { width: photo.width, height: photo.height });
        if (photo.preview) Object.assign(item, { previewSrc: `media/${sub}/${prefix}-${i + 1}.preview.webp`,
          previewWidth: photo.previewWidth, previewHeight: photo.previewHeight });
        await fsp.writeFile(uploadedPath(src), photo.master, { flag: 'wx' });
        if (photo.preview) await fsp.writeFile(uploadedPath(item.previewSrc), photo.preview, { flag: 'wx' });
        continue;
      }
      await fsp.writeFile(uploadedPath(src), Buffer.from(await file.arrayBuffer()), { flag: 'wx' });
      const width = Number(input.meta[i]?.width), height = Number(input.meta[i]?.height);
      if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0 && width <= 100000 && height <= 100000) Object.assign(media.at(-1), { width: Math.round(width), height: Math.round(height) });
    }
    return media;
  } catch (err) { await removeUnused(media); throw err; }
}
async function archivePost(post, who, action) {
  const directory = path.join(DATA_DIR, '.history');
  await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
  await fsp.writeFile(path.join(directory, `${Date.now()}-${crypto.randomUUID()}.json`),
    JSON.stringify({ post, action, actor: who.user, archivedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
}

async function createPost(req, res, who) {
  const input = await readForm(req);
  if (!input.text && !input.files.length) fail(400, 'Write something or add a photo.');
  const post = await withLock(async () => {
    who = identity(req);
    if (!who) fail(401, 'Not signed in.');
    const doc = await readPosts();
    const publishedAt = input.publishedAt || new Date().toISOString();
    const media = await storeMedia(input, publishedAt);
    const post = { id: `${publishedAt.slice(0, 10)}-${crypto.randomBytes(4).toString('hex')}`, ...(await postAuthor(who)), publishedAt, milestone: input.milestone, text: input.text, media };
    try { await writePosts({ ...doc, posts: [...doc.posts, post] }); }
    catch (err) { await removeUnused(media, doc); throw err; }
    return post;
  });
  return send(res, 201, editable(post));
}

const agentRates = new Map();
let agentPublishing = false;
async function writeAgentReceipt(file, receipt) {
  const tmp = `${file}.${crypto.randomUUID()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(receipt), { mode: 0o600, flag: 'wx' });
  await fsp.rename(tmp, file);
}
async function publishAgent(input, who, key, dryRun) {
  if (!input.text && !input.files.length) fail(400, 'Write something or add a photo.');
  if (agentPublishing) fail(429, 'Another agent post is processing. Retry with the same idempotency key.');
  agentPublishing = true;
  try {
    return await withLock(async () => {
      const requestHash = crypto.createHash('sha256').update(JSON.stringify({ text: input.text, milestone: input.milestone, publishedAt: input.publishedAt,
        files: await Promise.all(input.files.map(async (file, i) => ({ type: file.type, alt: input.meta[i]?.alt || '', hash: crypto.createHash('sha256').update(Buffer.from(await file.arrayBuffer())).digest('hex') }))) })).digest('hex');
      const directory = path.join(DATA_DIR, '.agent-receipts');
      const keyHash = crypto.createHash('sha256').update(who.user + ':' + key).digest('hex');
      const receiptPath = path.join(directory, keyHash + '.json');
      const doc = await readPosts();
      let receipt;
      try { receipt = JSON.parse(await fsp.readFile(receiptPath, 'utf8')); }
      catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      if (receipt) {
        if (receipt.requestHash !== requestHash) fail(409, 'This idempotency key was used for different content.');
        const previous = doc.posts.find((post) => post.id === receipt.postId);
        if (!previous) fail(receipt.state === 'committed' ? 410 : 409, receipt.state === 'committed' ? 'The original post was removed. It will not be recreated by a retry.' : 'The previous attempt is incomplete. Ask the owner to review it before changing the key.');
        if (receipt.state !== 'committed') await writeAgentReceipt(receiptPath, { ...receipt, state: 'committed' });
        return { post: editable(previous), url: `${PUBLIC_ORIGIN}/#${encodeURIComponent(previous.id)}`, replayed: true };
      }
      const now = Date.now(), recent = agentRates.get(who.user);
      const rate = recent && now - recent.started < 3600000 ? recent : { started: now, creates: 0, attempts: 0, minute: now };
      if (now - rate.minute >= 60000) { rate.minute = now; rate.attempts = 0; }
      if (++rate.attempts > 12 || (!dryRun && rate.creates >= 12)) fail(429, 'Agent publication limit reached. Reuse the same key after the rate window resets.');
      agentRates.set(who.user, rate);
      const author = await postAuthor(who);
      if (dryRun) {
        const photos = [];
        for (const file of input.files) if (file.type.startsWith('image/')) {
          const photo = await preparePhoto(file); photos.push({ width: photo.width, height: photo.height, format: 'webp' });
        }
        return { dryRun: true, author: author.author, profileId: author.profileId, photos, published: false };
      }
      const publishedAt = input.publishedAt || new Date().toISOString();
      const media = await storeMedia(input, publishedAt);
      const post = { id: `${publishedAt.slice(0, 10)}-${crypto.randomBytes(4).toString('hex')}`, ...author, publishedAt,
        milestone: input.milestone, text: input.text, media };
      await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
      const audit = path.join(DATA_DIR, '.agent-audit.jsonl');
      const record = { at: new Date().toISOString(), action: 'publish', actor: who.user, keyHash, postId: post.id };
      try {
        await writeAgentReceipt(receiptPath, { requestHash, postId: post.id, state: 'pending' });
        await fsp.appendFile(audit, JSON.stringify({ ...record, phase: 'prepared' }) + '\n', { mode: 0o600 });
        await writePosts({ ...doc, posts: [...doc.posts, post] });
      } catch (cause) {
        await removeUnused(media, doc);
        await fsp.unlink(receiptPath).catch(() => {});
        throw cause;
      }
      rate.creates++;
      // A crash here leaves a pending receipt plus a published post; retries find it.
      await writeAgentReceipt(receiptPath, { requestHash, postId: post.id, state: 'committed' });
      await fsp.appendFile(audit, JSON.stringify({ ...record, phase: 'committed' }) + '\n', { mode: 0o600 });
      return { post: editable(post), url: `${PUBLIC_ORIGIN}/#${encodeURIComponent(post.id)}`, replayed: false };
    });
  } finally { agentPublishing = false; }
}

async function updatePost(req, res, who, id) {
  const input = await readForm(req);
  const post = await withLock(async () => {
    const doc = await readPosts();
    const index = doc.posts.findIndex((p) => p.id === id);
    if (index < 0) fail(404, 'This post no longer exists.');
    const previous = doc.posts[index];
    requireEdit(who, previous);
    checkVersion(req, previous);
    const retained = input.retained === null ? (previous.media || []) : input.retained.map((src) => {
      const item = (previous.media || []).find((m) => m.src === src);
      if (!item) fail(400, 'A selected photo no longer belongs to this post.');
      return item;
    });
    if (!input.text && !retained.length && !input.files.length) fail(400, 'Write something or keep a photo.');
    if (retained.length + input.files.length > 20) fail(400, 'Up to 20 photos and videos per post.');
    const publishedAt = input.publishedAt || previous.publishedAt;
    const added = await storeMedia(input, publishedAt);
    const updated = { ...previous, text: input.text, milestone: input.milestone, publishedAt, media: [...retained, ...added], updatedAt: new Date(Math.max(Date.now(), (Date.parse(previous.updatedAt) || 0) + 1)).toISOString() };
    try {
      await archivePost(previous, who, 'edit');
      await writePosts({ ...doc, posts: doc.posts.map((p, i) => i === index ? updated : p) });
    } catch (err) { await removeUnused(added, doc); throw err; }
    await removeUnused(previous.media || []);
    return updated;
  });
  return send(res, 200, editable(post));
}

async function deletePost(req, res, who, id) {
  if (!sameOrigin(req)) fail(403, 'Cross-site request refused.');
  await withLock(async () => {
    const doc = await readPosts();
    const previous = doc.posts.find((p) => p.id === id);
    if (!previous) fail(404, 'This post no longer exists.');
    requireEdit(who, previous);
    checkVersion(req, previous);
    await archivePost(previous, who, 'delete');
    const updated = { ...doc, posts: doc.posts.filter((p) => p.id !== id) };
    await writePosts(updated);
    await removeUnused(previous.media || [], updated);
  });
  return send(res, 204, '');
}

function listPosts(doc, url) {
  let before;
  if (url.searchParams.has('before')) {
    try { before = JSON.parse(Buffer.from(url.searchParams.get('before'), 'base64url').toString()); }
    catch { fail(400, 'Invalid page. Refresh the post list.'); }
    if (!before || typeof before.id !== 'string' || !Number.isFinite(before.time)) fail(400, 'Invalid page. Refresh the post list.');
  }
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
  const posts = doc.posts.slice().sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt) || b.id.localeCompare(a.id));
  const remaining = before ? posts.filter((p) => Date.parse(p.publishedAt) < before.time || (Date.parse(p.publishedAt) === before.time && p.id.localeCompare(before.id) < 0)) : posts;
  const page = remaining.slice(0, limit);
  const last = page.at(-1);
  return { posts: page.map(editable), total: posts.length, nextCursor: remaining.length > page.length ? Buffer.from(JSON.stringify({ time: Date.parse(last.publishedAt), id: last.id })).toString('base64url') : null };
}

/* ---------- static files ---------- */
// The router has already decoded and normalized urlPath exactly once. Decoding it
// again would let "%2563ompose" pass the private-page check as "%63ompose" and
// then be served as "compose".
function resolveStatic(urlPath) {
  const clean = urlPath.replace(/^\/+/, '');
  if (clean.split('/').some((s) => s.startsWith('.'))) return null;
  const [top, ...rest] = clean.split('/');
  if (top === 'data') return rest.length === 1 && ['posts.json', 'site.json', 'profiles.json'].includes(rest[0]) ? path.join(DATA_DIR, rest[0]) : null;
  if (top === 'media') return path.join(MEDIA_DIR, ...rest);
  if (!PUBLIC_TOP.has(top)) return null;
  return path.join(SITE_DIR, clean);
}

async function serveStatic(req, res, urlPath) {
  let file = resolveStatic(urlPath);
  if (!file) return send(res, 404, 'Not found');
  // Filter by resolved file so encoded paths cannot expose private account subjects.
  if (file === path.join(DATA_DIR, 'posts.json')) {
    const doc = await readPosts();
    return send(res, 200, { posts: doc.posts.map(({ authorId, ...post }) => post) });
  }
  // Removed media must stop being public even if filesystem cleanup needs retrying.
  if (file.startsWith(MEDIA_DIR + path.sep)) {
    const src = 'media/' + path.relative(MEDIA_DIR, file).split(path.sep).join('/');
    if (!(await mediaReferences()).has(src)) return send(res, 404, 'Not found');
  }
  let stat;
  try {
    stat = await fsp.stat(file);
    if (stat.isDirectory()) {
      if (!urlPath.endsWith('/')) return send(res, 301, '', { Location: urlPath + '/' });
      file = path.join(file, 'index.html');
      stat = await fsp.stat(file);
    }
  } catch {
    return send(res, 404, 'Not found');
  }

  const ext = path.extname(file).toLowerCase();
  const fresh = /\.(html|json|webmanifest|js|css)$/.test(ext);
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': fresh ? 'no-cache' : file.startsWith(MEDIA_DIR) ? 'private, max-age=31536000, immutable' : 'public, max-age=604800',
    'Last-Modified': stat.mtime.toUTCString(),
    'Accept-Ranges': 'bytes',
  };

  // Byte ranges, so Safari can play videos.
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    let start = range[1] === '' ? stat.size - Number(range[2]) : Number(range[1]);
    let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : stat.size - 1;
    end = Math.min(end, stat.size - 1);
    if (start < 0 || start > end) return send(res, 416, '', { 'Content-Range': `bytes */${stat.size}` });
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return pipeline(fs.createReadStream(file, { start, end }), res).catch(() => {});
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') return res.end();
  return pipeline(fs.createReadStream(file), res).catch(() => {});
}

/* ---------- router ---------- */
const handleAgent = createAgentService({ configFile: process.env.AGENT_KEYS_FILE, publish: publishAgent,
  readMultipart: readForm, authorFor: postAuthor, origin: PUBLIC_ORIGIN });
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(self)');
  const url = new URL(req.url.replace(/^\/+/, '/'), 'http://local');
  const { pathname } = url;
  try {
    if (pathname === '/healthz') return send(res, 200, 'ok');
    if (await humanAuth.handle(req, res, pathname)) return;
    if (await handleAgent(req, res, pathname, url.search)) return;
    if (pathname.startsWith('/api/')) {
      const who = await ensureIdentity(req);
      if (!who) return send(res, 401, { error: 'Not signed in.' });
      if (pathname === '/api/me' && req.method === 'GET') {
        const author = await postAuthor(who);
        return send(res, 200, { ...who, name: author.author, profileId: author.profileId || null });
      }
      if (pathname === '/api/profiles' && req.method === 'GET') return send(res, 200, { profiles: (await readProfiles()).profiles.map(editable) });
      if (pathname === '/api/me/setup' && req.method === 'POST') {
        await readJSON(req);
        await withLock(() => community.finishSetup(who));
        return send(res, 204, '');
      }
      const profileMatch = /^\/api\/profiles\/([a-z][a-z0-9-]{0,47})$/.exec(pathname);
      if (profileMatch && req.method === 'PUT') return await updateProfile(req, res, who, profileMatch[1]);
      if (pathname === '/api/posts' && req.method === 'GET') return send(res, 200, listPosts(await readPosts(), url));
      if (pathname === '/api/posts' && req.method === 'POST') return await createPost(req, res, who);
      const match = /^\/api\/posts\/([^/]+)$/.exec(pathname);
      if (match) {
        let id;
        try { id = decodeURIComponent(match[1]); } catch { fail(400, 'Invalid post.'); }
        if (req.method === 'PUT') return await updatePost(req, res, who, id);
        if (req.method === 'DELETE') return await deletePost(req, res, who, id);
        if (req.method === 'GET') {
          const post = (await readPosts()).posts.find((p) => p.id === id);
          if (!post) fail(404, 'This post no longer exists.');
          return send(res, 200, editable(post), { ETag: `"${version(post)}"` });
        }
      }
      return send(res, 404, { error: 'Not found.' });
    }
    let staticPath;
    try { staticPath = path.posix.normalize(decodeURIComponent(pathname)); } catch { fail(400, 'Invalid path.'); }
    if (/^\/(compose|manage|profiles|welcome)(\/|$)/.test(staticPath)) {
      const who = await ensureIdentity(req);
      if (!who) {
        return send(res, 302, '', { Location: '/login/' });
      }
      if (who.needsSetup && !/^\/welcome(?:\/|$)/.test(staticPath)) return send(res, 302, '', { Location: '/welcome/' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
    return await serveStatic(req, res, staticPath);
  } catch (err) {
    if (!err.status) console.error(err);
    if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : 'Server error.' });
    else res.destroy();
  }
});

await seed();
await community.initialize();
await migrateProfiles();
server.listen(PORT, () => console.log(`agentglade listening on :${server.address().port} (data ${DATA_DIR}, media ${MEDIA_DIR})`));

for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(() => process.exit(0)); server.closeIdleConnections(); });
