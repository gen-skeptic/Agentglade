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
import { openPostStore } from './post-store.js';
import { createVideoProcessor, sniffVideo } from './videos.js';
import { openLoveStore, memberKey, visitorKey } from './loves.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SITE_DIR = path.resolve(process.env.SITE_DIR || path.join(HERE, '..'));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(SITE_DIR, 'data'));
const MEDIA_DIR = path.resolve(process.env.MEDIA_DIR || path.join(SITE_DIR, 'media'));
const SEED_DIR = path.join(SITE_DIR, 'data');
const PORT = Number(process.env.PORT || 8080);
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 64);
// A typo such as "64MB" would be NaN, and every size comparison against NaN is false.
if (!Number.isFinite(MAX_UPLOAD_MB) || MAX_UPLOAD_MB <= 0) throw new Error('MAX_UPLOAD_MB must be a positive number of MiB, such as 64.');
const MAX_UPLOAD = MAX_UPLOAD_MB * 1024 * 1024;
const publicUrl = new URL(process.env.PUBLIC_ORIGIN || 'http://localhost:8080');
if (!['http:', 'https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) throw new Error('PUBLIC_ORIGIN must be an HTTP(S) origin without credentials or a path.');
const PUBLIC_ORIGIN = publicUrl.origin;
let trustedProxies;
try { trustedProxies = JSON.parse(process.env.TRUSTED_PROXIES || '[]'); }
catch { throw new Error('TRUSTED_PROXIES must be a JSON array of IP addresses or CIDR ranges, such as ["10.0.0.0/8"].'); }
const humanAuth = await createHumanAuth({ configFile: process.env.AUTH_CONFIG_FILE, origin: PUBLIC_ORIGIN, trustedProxies });
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
// Every script, style, font, and image is served from this origin; previews of
// photos and videos chosen in the composer use blob: URLs. The policy is a second
// layer behind HTML escaping, and frame-ancestors stops other sites from framing
// the management pages to trick a signed-in member into clicking Delete.
const CONTENT_SECURITY_POLICY = ["default-src 'self'", "img-src 'self' blob:", "media-src 'self' blob:", "object-src 'none'",
  "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'"].join('; ');
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
  // Only a first (or interrupted) sign-in creates a profile. Every other request
  // skips the write lock, so a long upload never stalls unrelated page loads.
  if (community.allowed(forwarded) && community.needsProfile(forwarded, (await readProfiles()).profiles)) await withLock(async () => {
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
// What a signed-in member sees: the stored author subject (an SSO account ID) stays
// private, and the server says whether this viewer may edit or delete the post.
// What anyone may see: a post without its author's private account subject.
const publicView = ({ authorId, ...post }) => post;
const postView = (post, who) => { const { authorId, ...shown } = post; return { ...shown, version: version(post), canEdit: community.canEdit(who, post) }; };
function checkVersion(req, post) {
  if (!req.headers['if-match']) fail(428, 'Reload this post before changing it.');
  if (req.headers['if-match'] !== `"${version(post)}"`) fail(412, 'This post changed in another window. Reload the latest post before saving or deleting.');
}

/* ---------- data ---------- */
async function seed() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(MEDIA_DIR, { recursive: true });
  for (const f of ['site.json', 'profiles.json']) {
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

// Opened at startup, before the server listens.
let posts, videos, loves;
const newPostId = (publishedAt) => {
  let id;
  do id = `${publishedAt.slice(0, 10)}-${crypto.randomBytes(4).toString('hex')}`; while (posts.has(id));
  return id;
};
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
  const editableProfile = (doc) => {
    const previous = doc.profiles.find((profile) => profile.id === id);
    if (!previous) fail(404, 'Profile not found.');
    requireEdit(who, previous, 'profile');
    checkVersion(req, previous);
    return previous;
  };
  // Check access before spending time on the photo, then process it outside the
  // write lock. The checks run again under the lock in case the profile changed.
  editableProfile(await readProfiles());
  const added = avatar?.size ? (await storeMedia({ files: [avatar], meta: [] }, new Date().toISOString())).media : [];
  let updated;
  try {
    updated = await withLock(async () => {
      const doc = await readProfiles(), previous = editableProfile(doc);
      const next = { ...previous, name: name.trim(), bio: bio.trim(), updatedAt: new Date().toISOString() };
      if (added.length || removeAvatar) { next.avatar = added[0]?.src || null; next.avatarPreview = added[0]?.previewSrc || null; }
      const history = path.join(DATA_DIR, '.profile-history');
      await fsp.mkdir(history, { recursive: true, mode: 0o700 });
      await fsp.writeFile(path.join(history, `${Date.now()}-${crypto.randomUUID()}.json`), JSON.stringify({ profile: previous, actor: who.user, at: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
      const file = path.join(DATA_DIR, 'profiles.json'), tmp = `${file}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify({ ...doc, profiles: doc.profiles.map((profile) => profile.id === id ? next : profile) }, null, 2) + '\n');
      await fsp.rename(tmp, file);
      if (who.profileId === id) await community.finishSetup(who);
      await removeUnused([{ src: previous.avatar, previewSrc: previous.avatarPreview }]);
      return next;
    });
  } catch (error) { await removeUnused(added); throw error; }
  return send(res, 200, editable(updated));
}

// Apply account display names to old posts as well as future publications.
// Save each previous record with the same private history used for normal edits.
async function migrateProfiles() {
  const profiles = (await readProfiles()).profiles;
  for (const post of [...posts.all()]) {
    if (post.profileId) continue;
    const configured = community.account(post.authorId);
    const profile = profiles.find((item) => item.id === configured?.profileId);
    const name = profile?.name || configured?.name;
    if (!name || (post.author === name && post.initials === initials(name) && (!profile || post.profileId === profile.id))) continue;
    await archivePost(post, { user: 'system' }, 'profile-name');
    await posts.put({ ...post, author: name, initials: initials(name), ...(profile ? { profileId: profile.id } : {}) });
  }
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
  // Post IDs and media folders come from the ISO date, which needs a four-digit year.
  if (date && (Number.isNaN(new Date(date).getTime()) || !/^\d{4}-/.test(new Date(date).toISOString()))) fail(400, 'Choose a valid post date.');
  let meta, retained;
  try { meta = JSON.parse(field('mediaMeta') || '[]'); retained = form.has('retainMedia') ? JSON.parse(field('retainMedia')) : null; }
  catch { fail(400, 'Invalid media information.'); }
  if (!Array.isArray(meta) || meta.some((m) => !m || typeof m !== 'object' || Array.isArray(m))) fail(400, 'Invalid media information.');
  // Kept photos are listed by src, optionally with an updated description: "src" or { src, alt }.
  if (retained !== null) {
    if (!Array.isArray(retained)) fail(400, 'Invalid retained photos.');
    retained = retained.map((entry) => typeof entry === 'string' ? { src: entry } : entry);
    if (retained.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.src !== 'string' || (entry.alt !== undefined && typeof entry.alt !== 'string'))
      || new Set(retained.map((entry) => entry.src)).size !== retained.length) fail(400, 'Invalid retained photos.');
  }
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
async function mediaReferences() {
  const refs = new Set(posts.all().flatMap((post) => (post.media || []).flatMap((m) => [m.src, m.previewSrc, m.posterSrc].filter(Boolean))));
  const site = JSON.parse(await fsp.readFile(path.join(DATA_DIR, 'site.json'), 'utf8'));
  if (site.avatar) refs.add(site.avatar);
  for (const profile of (await readProfiles()).profiles) {
    if (profile.avatar) refs.add(profile.avatar);
    if (profile.avatarPreview) refs.add(profile.avatarPreview);
  }
  return refs;
}
// Serving a photo checks that a post or profile still uses it. Rebuilding that set
// per photo is slow for a large feed, so keep it until a post changes or the site
// or profiles file is replaced or modified. Writes replace files by rename, which
// changes the inode, so a deletion takes effect on the next request.
const REFERENCE_FILES = ['site.json', 'profiles.json'];
let referenceCache = { key: null, refs: null };
async function servedMediaReferences() {
  // Key before reading: the set is never older than the key it is stored under.
  const stats = await Promise.all(REFERENCE_FILES.map((name) => fsp.stat(path.join(DATA_DIR, name), { bigint: true })));
  const key = [posts.generation, ...stats.map((s) => `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`)].join('|');
  if (referenceCache.key !== key) referenceCache = { key, refs: await mediaReferences() };
  return referenceCache.refs;
}
async function removeUnused(items) {
  const refs = await mediaReferences();
  for (const src of new Set(items.flatMap((item) => [item.src, item.previewSrc, item.posterSrc].filter(Boolean)))) {
    const file = uploadedPath(src);
    if (!file || refs.has(src)) continue;
    try { await fsp.unlink(file); }
    catch (err) { if (err.code !== 'ENOENT') console.warn('Unused media cleanup failed:', path.basename(file), err.code); }
  }
}
// Photos are processed now. Videos are saved privately and converted in the
// background: start the returned jobs once the post is saved (or discard them).
async function storeMedia(input, publishedAt) {
  const sub = publishedAt.slice(0, 7).replace('-', '/');
  const prefix = `${publishedAt.slice(0, 10)}-${crypto.randomBytes(8).toString('hex')}`;
  await fsp.mkdir(path.join(MEDIA_DIR, sub), { recursive: true });
  const media = [], jobs = [];
  try {
    for (const [i, file] of input.files.entries()) {
      if (file.type.startsWith('video/')) {
        if (!videos.available) fail(503, 'Video uploads need ffmpeg on the server. Ask the site owner to install it.');
        const data = Buffer.from(await file.arrayBuffer()), format = sniffVideo(data.subarray(0, 12));
        if (!format) fail(415, `${file.name}: choose an MP4, MOV, or WebM video.`);
        const base = `media/${sub}/${prefix}-${i + 1}`;
        media.push({ type: 'video', src: `${base}.mp4`, status: 'processing', alt: String(input.meta[i]?.alt || '').trim().slice(0, 300) });
        jobs.push(await videos.stage({ data, format, src: `${base}.mp4`, posterSrc: `${base}.poster.webp` }));
        continue;
      }
      const photo = file.type.startsWith('image/') ? await preparePhoto(file) : null;
      const name = `${prefix}-${i + 1}${photo ? '.webp' : EXT[file.type]}`;
      const src = `media/${sub}/${name}`;
      // Track each new file before writing, so partial writes are cleaned too.
      media.push({ type: file.type.startsWith('video/') ? 'video' : 'image', src, alt: String(input.meta[i]?.alt || '').trim().slice(0, 300) });
      if (photo) {
        const item = media.at(-1);
        Object.assign(item, { width: photo.width, height: photo.height });
        if (photo.preview) Object.assign(item, { previewSrc: `media/${sub}/${prefix}-${i + 1}.preview.webp`,
          previewWidth: photo.previewWidth, previewHeight: photo.previewHeight });
        await fsp.writeFile(uploadedPath(src), photo.master, { flag: 'wx' });
        if (photo.preview) await fsp.writeFile(uploadedPath(item.previewSrc), photo.preview, { flag: 'wx' });
        continue;
      }
    }
    return { media, jobs };
  } catch (err) { await removeUnused(media); await discardVideos(jobs); throw err; }
}
const startVideos = (jobs) => { for (const job of jobs) videos.start(job); };
const discardVideos = (jobs) => Promise.all(jobs.map((job) => videos.discard(job)));

// A finished conversion replaces the placeholder (or, for a video published before
// conversion existed, the original file) unless the post or video was removed meanwhile.
async function finishVideo(job, result) {
  await withLock(async () => {
    const post = posts.all().find((item) => (item.media || []).some((m) => m.type === 'video' && m.src === job.match));
    const video = post?.media.find((m) => m.src === job.match);
    if (!video || (job.sourceSrc ? video.posterSrc : video.status !== 'processing')) return;
    let next;
    if (result.error) next = job.sourceSrc ? { ...video, transcodeFailed: true } : { ...video, status: 'failed' };
    else {
      await fsp.rename(result.tmpVideo, uploadedPath(job.src));
      await fsp.rename(result.tmpPoster, uploadedPath(job.posterSrc));
      const { status, transcodeFailed, width, height, duration, ...rest } = video;
      next = { ...rest, src: job.src, posterSrc: job.posterSrc, width: result.width, height: result.height, ...(result.duration ? { duration: result.duration } : {}) };
    }
    await posts.put({ ...post, media: post.media.map((m) => m === video ? next : m) });
    if (job.sourceSrc && !result.error) await removeUnused([{ src: job.sourceSrc }]);
  });
}

// At startup: resume conversions a post still waits for, and convert videos that
// were published unprocessed by earlier releases (they keep playing meanwhile).
async function resumeVideos() {
  // Jobs start only after this pass, so a quick conversion cannot race its writes.
  const pending = await videos.pending(), waiting = new Set(), start = [];
  for (const job of pending) {
    const video = posts.all().flatMap((post) => post.media || []).find((m) => m.type === 'video' && m.src === job.match);
    const wanted = video && (job.sourceSrc ? !video.posterSrc : video.status === 'processing');
    if (!wanted) { await videos.discard(job); continue; }
    waiting.add(job.match);
    if (videos.available) start.push(job);
  }
  for (const post of [...posts.all()]) {
    let changed = false;
    const media = await Promise.all((post.media || []).map(async (video) => {
      if (video.type !== 'video' || video.posterSrc || video.transcodeFailed || waiting.has(video.src)) return video;
      if (video.status === 'processing') { changed = true; return { ...video, status: 'failed' }; } // Its upload was lost.
      if (video.status || !videos.available) return video;
      let format = null;
      try { const handle = await fsp.open(uploadedPath(video.src)); try { const { buffer } = await handle.read(Buffer.alloc(12), 0, 12, 0); format = sniffVideo(buffer); } finally { await handle.close(); } } catch {}
      if (!format) { changed = true; return { ...video, transcodeFailed: true }; }
      const base = video.src.replace(/\.[^./]+$/, '') + '-web';
      start.push(await videos.stageExisting({ sourceSrc: video.src, format, src: `${base}.mp4`, posterSrc: `${base}.poster.webp` }));
      return video;
    }));
    if (changed) await posts.put({ ...post, media });
  }
  startVideos(start);
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
  const publishedAt = input.publishedAt || new Date().toISOString();
  // Photo processing can take minutes for a large post. New files stay private
  // until the post that references them is written, so do it before locking.
  const { media, jobs } = await storeMedia(input, publishedAt);
  let post;
  try {
    post = await withLock(async () => {
      who = identity(req);
      if (!who) fail(401, 'Not signed in.');
      const post = { id: newPostId(publishedAt), ...(await postAuthor(who)), publishedAt, milestone: input.milestone, text: input.text, media };
      await posts.put(post);
      return post;
    });
  } catch (err) { await removeUnused(media); await discardVideos(jobs); throw err; }
  startVideos(jobs);
  return send(res, 201, postView(post, who));
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
  // One agent publication at a time in this process, so no other request can
  // claim this idempotency key while its photos are processed below.
  if (agentPublishing) fail(429, 'Another agent post is processing. Retry with the same idempotency key.');
  agentPublishing = true;
  try {
    const requestHash = crypto.createHash('sha256').update(JSON.stringify({ text: input.text, milestone: input.milestone, publishedAt: input.publishedAt,
      files: await Promise.all(input.files.map(async (file, i) => ({ type: file.type, alt: input.meta[i]?.alt || '', hash: crypto.createHash('sha256').update(Buffer.from(await file.arrayBuffer())).digest('hex') }))) })).digest('hex');
    const directory = path.join(DATA_DIR, '.agent-receipts');
    const keyHash = crypto.createHash('sha256').update(who.user + ':' + key).digest('hex');
    const receiptPath = path.join(directory, keyHash + '.json');
    // Answer a retry from its receipt. Called under the write lock.
    const replay = async () => {
      let receipt;
      try { receipt = JSON.parse(await fsp.readFile(receiptPath, 'utf8')); }
      catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
      if (!receipt) return null;
      if (receipt.requestHash !== requestHash) fail(409, 'This idempotency key was used for different content.');
      const previous = posts.get(receipt.postId);
      if (!previous) fail(receipt.state === 'committed' ? 410 : 409, receipt.state === 'committed' ? 'The original post was removed. It will not be recreated by a retry.' : 'The previous attempt is incomplete. Ask the owner to review it before changing the key.');
      if (receipt.state !== 'committed') await writeAgentReceipt(receiptPath, { ...receipt, state: 'committed' });
      return { post: editable(previous), url: `${PUBLIC_ORIGIN}/#${encodeURIComponent(previous.id)}`, replayed: true };
    };
    const admitted = await withLock(async () => {
      const replayed = await replay();
      if (replayed) return { replayed };
      const now = Date.now(), recent = agentRates.get(who.user);
      const rate = recent && now - recent.started < 3600000 ? recent : { started: now, creates: 0, attempts: 0, minute: now };
      if (now - rate.minute >= 60000) { rate.minute = now; rate.attempts = 0; }
      if (++rate.attempts > 12 || (!dryRun && rate.creates >= 12)) fail(429, 'Agent publication limit reached. Reuse the same key after the rate window resets.');
      agentRates.set(who.user, rate);
      return { rate, author: await postAuthor(who) };
    });
    if (admitted.replayed) return admitted.replayed;
    const { rate, author } = admitted;
    // Photo processing runs outside the write lock so members are not held up.
    if (dryRun) {
      const photos = [];
      for (const file of input.files) if (file.type.startsWith('image/')) {
        const photo = await preparePhoto(file); photos.push({ width: photo.width, height: photo.height, format: 'webp' });
      }
      return { dryRun: true, author: author.author, profileId: author.profileId, photos, published: false };
    }
    const publishedAt = input.publishedAt || new Date().toISOString();
    const { media, jobs } = await storeMedia(input, publishedAt);
    let committed = false;
    try {
      const result = await withLock(async () => {
        const replayed = await replay(); // Cannot happen while agentPublishing is held; checked anyway.
        if (replayed) { await removeUnused(media); await discardVideos(jobs); return replayed; }
        const post = { id: newPostId(publishedAt), ...author, publishedAt,
          milestone: input.milestone, text: input.text, media };
        await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
        const audit = path.join(DATA_DIR, '.agent-audit.jsonl');
        const record = { at: new Date().toISOString(), action: 'publish', actor: who.user, keyHash, postId: post.id };
        try {
          await writeAgentReceipt(receiptPath, { requestHash, postId: post.id, state: 'pending' });
          await fsp.appendFile(audit, JSON.stringify({ ...record, phase: 'prepared' }) + '\n', { mode: 0o600 });
          await posts.put(post);
          committed = true;
        } catch (cause) {
          await fsp.unlink(receiptPath).catch(() => {});
          throw cause;
        }
        rate.creates++;
        // A crash here leaves a pending receipt plus a published post; retries find it.
        await writeAgentReceipt(receiptPath, { requestHash, postId: post.id, state: 'committed' });
        await fsp.appendFile(audit, JSON.stringify({ ...record, phase: 'committed' }) + '\n', { mode: 0o600 });
        return { post: editable(post), url: `${PUBLIC_ORIGIN}/#${encodeURIComponent(post.id)}`, replayed: false };
      });
      if (committed) startVideos(jobs);
      return result;
    } catch (cause) { await removeUnused(media); if (!committed) await discardVideos(jobs); else startVideos(jobs); throw cause; }
  } finally { agentPublishing = false; }
}

// Locate the post and check access, version, and photo selection. updatePost runs
// this before processing new photos and again under the write lock, so a post that
// changed in the meantime is still refused with 412.
function planUpdate(req, who, id, input) {
  const previous = posts.get(id);
  if (!previous) fail(404, 'This post no longer exists.');
  requireEdit(who, previous);
  checkVersion(req, previous);
  const retained = input.retained === null ? (previous.media || []) : input.retained.map(({ src, alt }) => {
    const item = (previous.media || []).find((m) => m.src === src);
    if (!item) fail(400, 'A selected photo no longer belongs to this post.');
    return alt === undefined ? item : { ...item, alt: alt.trim().slice(0, 300) };
  });
  if (!input.text && !retained.length && !input.files.length) fail(400, 'Write something or keep a photo.');
  if (retained.length + input.files.length > 20) fail(400, 'Up to 20 photos and videos per post.');
  return { previous, retained, publishedAt: input.publishedAt || previous.publishedAt };
}

async function updatePost(req, res, who, id) {
  const input = await readForm(req);
  const { publishedAt } = planUpdate(req, who, id, input);
  const { media: added, jobs } = await storeMedia(input, publishedAt);
  let post;
  try {
    post = await withLock(async () => {
      const { previous, retained } = planUpdate(req, who, id, input);
      const updated = { ...previous, text: input.text, milestone: input.milestone, publishedAt, media: [...retained, ...added], updatedAt: new Date(Math.max(Date.now(), (Date.parse(previous.updatedAt) || 0) + 1)).toISOString() };
      await archivePost(previous, who, 'edit');
      await posts.put(updated);
      await removeUnused(previous.media || []);
      return updated;
    });
  } catch (err) { await removeUnused(added); await discardVideos(jobs); throw err; }
  startVideos(jobs);
  return send(res, 200, postView(post, who));
}

async function deletePost(req, res, who, id) {
  if (!sameOrigin(req)) fail(403, 'Cross-site request refused.');
  await withLock(async () => {
    const previous = posts.get(id);
    if (!previous) fail(404, 'This post no longer exists.');
    requireEdit(who, previous);
    checkVersion(req, previous);
    await archivePost(previous, who, 'delete');
    await posts.remove(id);
    await loves.forget(id);
    await removeUnused(previous.media || []);
  });
  return send(res, 204, '');
}

// One page of posts (already sorted newest first), shown through view(post).
function listPosts(sorted, url, view) {
  let before;
  if (url.searchParams.has('before')) {
    try { before = JSON.parse(Buffer.from(url.searchParams.get('before'), 'base64url').toString()); }
    catch { fail(400, 'Invalid page. Refresh the post list.'); }
    if (!before || typeof before.id !== 'string' || !Number.isFinite(before.time)) fail(400, 'Invalid page. Refresh the post list.');
  }
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
  const remaining = before ? sorted.filter((p) => Date.parse(p.publishedAt) < before.time || (Date.parse(p.publishedAt) === before.time && p.id.localeCompare(before.id) < 0)) : sorted;
  const page = remaining.slice(0, limit);
  const last = page.at(-1);
  return { posts: page.map(view), total: sorted.length, nextCursor: remaining.length > page.length ? Buffer.from(JSON.stringify({ time: Date.parse(last.publishedAt), id: last.id })).toString('base64url') : null };
}

/* ---------- public feed ---------- */
// Readers page through the feed instead of downloading every post. These routes
// are public and show only what /data/posts.json always has.
const FEED_FILTERS = { all: () => true, photos: (post) => (post.media || []).length > 0, milestones: (post) => !!post.milestone };
function feedSelection(url) {
  const filter = url.searchParams.get('filter') || 'all', profile = url.searchParams.get('profile');
  if (!Object.hasOwn(FEED_FILTERS, filter)) fail(400, 'Unknown feed filter.');
  if (profile !== null && !/^[a-z][a-z0-9-]{0,47}$/.test(profile)) fail(400, 'Unknown profile.');
  return { filter, profile };
}
const ofProfile = (profile) => (post) => !profile || post.profileId === profile;
let summaryCache = { generation: -1, byProfile: new Map() };
function feedSummary(profile) {
  if (summaryCache.generation !== posts.generation) summaryCache = { generation: posts.generation, byProfile: new Map() };
  const key = profile || '';
  if (!summaryCache.byProfile.has(key)) {
    const shown = posts.all().filter(ofProfile(profile));
    const counts = Object.fromEntries(Object.entries(FEED_FILTERS).map(([name, keep]) => [name, shown.filter(keep).length]));
    const recentPhotos = [];
    for (const post of shown) {
      for (const [index, media] of (post.media || []).entries()) {
        if (media.type === 'image' && recentPhotos.length < 9) recentPhotos.push({ postId: post.id, index, src: media.src, previewSrc: media.previewSrc, alt: media.alt || '' });
      }
      if (recentPhotos.length >= 9) break;
    }
    const milestones = shown.filter(FEED_FILTERS.milestones).slice(0, 20).map((post) => ({ postId: post.id, milestone: post.milestone, publishedAt: post.publishedAt }));
    if (summaryCache.byProfile.size > 200) summaryCache.byProfile.clear();
    summaryCache.byProfile.set(key, { counts, recentPhotos, milestones });
  }
  return summaryCache.byProfile.get(key);
}
// Who is loving: a signed-in member (password session or identity proxy), or else this
// browser's random visitor ID, which a member's browser links to their account.
function loverKey(req) {
  const who = identity(req);
  return who ? memberKey(who.user) : visitorKey(req.headers['x-agentglade-visitor']);
}
const withLoves = (view, key) => (post) => ({ ...view(post), loves: loves.count(post.id), loved: loves.has(post.id, key) });
const loveRates = new Map();
function limitLoves(req) {
  const now = Date.now(), address = humanAuth.clientAddress(req);
  for (const [client, rate] of loveRates) if (now - rate.started >= 60000) loveRates.delete(client);
  const rate = loveRates.get(address) || { started: now, count: 0 };
  loveRates.set(address, rate);
  if (++rate.count > 30 || loveRates.size > 50000) fail(429, 'Too many loves at once. Try again in a minute.');
}
async function handleLoves(req, res, pathname) {
  const match = /^\/api\/feed\/posts\/([^/]+)\/love$/.exec(pathname);
  if (pathname !== '/api/feed/loves/import' && !match) return false;
  const key = loverKey(req);
  if (pathname === '/api/feed/loves/import') {
    // Loves saved only in this browser by earlier releases move to the server once.
    if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' }, { Allow: 'POST' }), true;
    const body = await readJSON(req);
    if (!key) fail(400, 'Missing visitor ID.');
    if (!Array.isArray(body?.ids) || body.ids.length > 300 || body.ids.some((id) => typeof id !== 'string')) fail(400, 'Send up to 300 post IDs.');
    limitLoves(req);
    if (loves.lovedBy(key) > 0) fail(409, 'This browser already keeps its loves on the server.');
    const ids = [...new Set(body.ids)].filter((id) => posts.has(id));
    for (const id of ids) await loves.set(id, key, true);
    return send(res, 200, { imported: ids.length }), true;
  }
  if (req.method !== 'PUT' && req.method !== 'DELETE') return send(res, 405, { error: 'Use PUT or DELETE.' }, { Allow: 'PUT, DELETE' }), true;
  if (!sameOrigin(req)) fail(403, 'Cross-site request refused.');
  let id;
  try { id = decodeURIComponent(match[1]); } catch { fail(400, 'Invalid post.'); }
  if (!posts.has(id)) fail(404, 'This post no longer exists.');
  if (!key) fail(400, 'Missing visitor ID.');
  limitLoves(req);
  await loves.set(id, key, req.method === 'PUT');
  return send(res, 200, { loves: loves.count(id), loved: loves.has(id, key) }), true;
}
async function handleFeed(req, res, pathname, url) {
  if (pathname !== '/api/feed' && !pathname.startsWith('/api/feed/')) return false;
  if (await handleLoves(req, res, pathname)) return true;
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Use GET.' }, { Allow: 'GET, HEAD' }), true;
  const view = withLoves(publicView, loverKey(req));
  if (pathname === '/api/feed') {
    const { filter, profile } = feedSelection(url);
    const keep = FEED_FILTERS[filter], mine = ofProfile(profile);
    return send(res, 200, listPosts(posts.all().filter((post) => keep(post) && mine(post)), url, view)), true;
  }
  if (pathname === '/api/feed/summary') return send(res, 200, feedSummary(feedSelection(url).profile)), true;
  const match = /^\/api\/feed\/posts\/([^/]+)$/.exec(pathname);
  if (!match) return send(res, 404, { error: 'Not found.' }), true;
  let id;
  try { id = decodeURIComponent(match[1]); } catch { fail(400, 'Invalid post.'); }
  const post = posts.get(id);
  if (!post) fail(404, 'This post no longer exists.');
  return send(res, 200, view(post)), true;
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
  if (file === path.join(DATA_DIR, 'posts.json')) return send(res, 200, { posts: posts.all().map(publicView) });
  // Removed media must stop being public even if filesystem cleanup needs retrying.
  if (file.startsWith(MEDIA_DIR + path.sep)) {
    const src = 'media/' + path.relative(MEDIA_DIR, file).split(path.sep).join('/');
    if (!(await servedMediaReferences()).has(src)) return send(res, 404, 'Not found');
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
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Frame-Options', 'DENY');
  const url = new URL(req.url.replace(/^\/+/, '/'), 'http://local');
  const { pathname } = url;
  try {
    if (pathname === '/healthz') return send(res, 200, 'ok');
    if (await humanAuth.handle(req, res, pathname)) return;
    if (await handleAgent(req, res, pathname, url.search)) return;
    if (await handleFeed(req, res, pathname, url)) return;
    if (pathname.startsWith('/api/')) {
      const who = await ensureIdentity(req);
      if (!who) return send(res, 401, { error: 'Not signed in.' });
      if (pathname === '/api/me' && req.method === 'GET') {
        const author = await postAuthor(who);
        return send(res, 200, { ...who, name: author.author, profileId: author.profileId || null });
      }
      if (pathname === '/api/profiles' && req.method === 'GET') return send(res, 200, { profiles: (await readProfiles()).profiles.map(editable) });
      if (pathname === '/api/me/visitor' && req.method === 'POST') {
        const visitor = visitorKey((await readJSON(req))?.token);
        if (!visitor) fail(400, 'Invalid visitor ID.');
        await loves.link(visitor, memberKey(who.user));
        return send(res, 204, '');
      }
      if (pathname === '/api/me/setup' && req.method === 'POST') {
        await readJSON(req);
        await withLock(() => community.finishSetup(who));
        return send(res, 204, '');
      }
      const profileMatch = /^\/api\/profiles\/([a-z][a-z0-9-]{0,47})$/.exec(pathname);
      if (profileMatch && req.method === 'PUT') return await updateProfile(req, res, who, profileMatch[1]);
      if (pathname === '/api/posts' && req.method === 'GET') return send(res, 200, listPosts(posts.all(), url, withLoves((post) => postView(post, who), memberKey(who.user))));
      if (pathname === '/api/posts' && req.method === 'POST') return await createPost(req, res, who);
      const match = /^\/api\/posts\/([^/]+)$/.exec(pathname);
      if (match) {
        let id;
        try { id = decodeURIComponent(match[1]); } catch { fail(400, 'Invalid post.'); }
        if (req.method === 'PUT') return await updatePost(req, res, who, id);
        if (req.method === 'DELETE') return await deletePost(req, res, who, id);
        if (req.method === 'GET') {
          const post = posts.get(id);
          if (!post) fail(404, 'This post no longer exists.');
          return send(res, 200, postView(post, who), { ETag: `"${version(post)}"` });
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
posts = await openPostStore(DATA_DIR);
await community.initialize();
await migrateProfiles();
loves = await openLoveStore(DATA_DIR);
await loves.compact((id) => posts.has(id));
videos = await createVideoProcessor({ dataDir: DATA_DIR, mediaPath: uploadedPath, complete: finishVideo });
await resumeVideos();
server.listen(PORT, () => console.log(`agentglade listening on :${server.address().port} (data ${DATA_DIR}, media ${MEDIA_DIR})`));

for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { videos?.stop(); server.close(() => process.exit(0)); server.closeIdleConnections(); });
