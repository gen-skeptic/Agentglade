import { hashSecret } from './auth.js';
import { storedPosts } from './fixtures/posts.js';
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const exec = promisify(execFile);
const ffmpeg = await exec('ffmpeg', ['-version']).then(() => true, () => false);
const skip = !ffmpeg && 'ffmpeg is not installed';
const proxyKey = 'synthetic-test-proxy-key-not-for-deployments';
const GPS = '+40.7128-074.0060+010.000/';
let root, child, base;
const as = { 'X-Agentglade-Proxy-Key': proxyKey, 'Remote-User': 'parent-a', 'Remote-Name': 'Parent A' };

// A phone-like recording: H.264 in a MOV container with GPS tags and, optionally, portrait rotation.
async function phoneVideo(name, { size = '1280x720', seconds = 2, rotate = 0 } = {}) {
  const file = path.join(root, name), plain = file + '.plain.mov';
  await exec('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30:duration=${seconds}`, '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-metadata', `location=${GPS}`, '-metadata', `com.apple.quicktime.location.ISO6709=${GPS}`, '-movflags', 'use_metadata_tags', plain]);
  await exec('ffmpeg', ['-nostdin', '-loglevel', 'error', '-y', '-display_rotation', String(rotate), '-i', plain, '-c', 'copy', '-movflags', 'use_metadata_tags', file]);
  const data = await fs.readFile(file);
  assert.ok(data.includes(GPS.slice(0, 8)), 'the test video carries GPS coordinates');
  return data;
}
async function start(env = {}) {
  const authFile = path.join(root, 'auth.json');
  await fs.writeFile(authFile, JSON.stringify({ proxyTokenHash: hashSecret(proxyKey) }), { mode: 0o600 });
  child = spawn(process.execPath, [new URL('./server.js', import.meta.url).pathname], { env: { ...process.env, NODE_ENV: 'production', PORT: '0', AUTH_CONFIG_FILE: authFile,
    DATA_DIR: path.join(root, 'data'), MEDIA_DIR: path.join(root, 'media'), MEMBER_ACCOUNTS: JSON.stringify({ 'parent-a': { name: 'Parent A' } }), MEMBER_ADMINS: '["parent-a"]', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  base = await new Promise((resolve, reject) => {
    let output = ''; const timer = setTimeout(() => reject(new Error('Server did not start')), 15000);
    child.stderr.on('data', (data) => { output += data; });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Server exited: ' + output)); });
    child.stdout.on('data', (data) => { const match = /listening on :(\d+)/.exec(data.toString()); if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); } });
  });
}
async function stop() { if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } }
function upload(text, files, method = 'POST', route = '/api/posts', headers = {}) {
  const body = new FormData(); body.set('text', text);
  for (const [name, data, type] of files) body.append('media', new Blob([data], { type }), name);
  return fetch(base + route, { method, headers: { ...as, ...headers }, body }).then(async (response) => ({ status: response.status, body: await response.json().catch(() => null) }));
}
const feedPost = async (id) => (await fetch(`${base}/api/feed/posts/${encodeURIComponent(id)}`)).json();
async function until(check, label, timeout = 60000) {
  const started = Date.now();
  for (;;) { const value = await check(); if (value) return value; if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}`); await new Promise((r) => setTimeout(r, 200)); }
}
const jobs = async () => (await fs.readdir(path.join(root, 'data/.video-jobs'))).filter((name) => !name.startsWith('.'));
const mediaFiles = async () => (await fs.readdir(path.join(root, 'media'), { recursive: true })).filter((name) => /\.(mp4|mov|webp)$/.test(name)).sort();

beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentglade-video-tests-')); await fs.mkdir(path.join(root, 'data')); });
afterEach(async () => { await stop(); await fs.rm(root, { recursive: true, force: true }); });

test('a phone video is published as H.264 MP4 with no location data, rotated, sized, and with a poster', { skip }, async () => {
  await start();
  const created = await upload('A video', [['portrait.mov', await phoneVideo('portrait.mov', { size: '2560x1440', rotate: 90 }), 'video/quicktime']]);
  assert.equal(created.status, 201);
  const [placeholder] = created.body.media;
  assert.equal(placeholder.status, 'processing'); assert.match(placeholder.src, /^media\/\d{4}\/\d{2}\/.+\.mp4$/);
  assert.equal((await fetch(base + '/' + placeholder.src)).status, 404); // Nothing is public until converted.
  const post = await until(async () => { const p = await feedPost(created.body.id); return !p.media[0].status && p; }, 'the conversion');
  const video = post.media[0];
  assert.equal(video.src, placeholder.src); assert.deepEqual([video.width, video.height], [1080, 1920]); assert.ok(video.duration >= 1.5);
  const served = await fetch(base + '/' + video.src);
  assert.equal(served.headers.get('content-type'), 'video/mp4');
  const bytes = Buffer.from(await served.arrayBuffer());
  assert.equal(bytes.includes(GPS.slice(0, 8)), false, 'no GPS coordinates in the published file');
  await fs.writeFile(path.join(root, 'out.mp4'), bytes);
  const probe = JSON.parse((await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path.join(root, 'out.mp4')])).stdout);
  assert.deepEqual(probe.streams.map((s) => s.codec_name), ['h264', 'aac']);
  const tags = [probe.format.tags, ...probe.streams.map((s) => s.tags)].flatMap((t) => Object.keys(t || {}));
  assert.equal(tags.some((tag) => /location|creation_time|com\.apple/i.test(tag)), false, `metadata tags left: ${tags}`);
  const poster = await fetch(base + '/' + video.posterSrc);
  assert.equal(poster.headers.get('content-type'), 'image/webp');
  assert.deepEqual(await jobs(), []);
});

test('files that are not videos are refused and nothing is stored', { skip }, async () => {
  await start();
  for (const [name, data] of [['clip.mp4', Buffer.from('not really a video at all')], ['list.mp4', Buffer.from('#EXTM3U\n#EXTINF:1,\nfile:///etc/passwd\n')]]) {
    assert.equal((await upload('Fake', [[name, data, 'video/mp4']])).status, 415);
  }
  assert.equal((await storedPosts(path.join(root, 'data'))).size, 0);
  assert.deepEqual(await jobs(), []);
});

test('a post deleted while its video converts never publishes the video', { skip }, async () => {
  await start();
  const created = await upload('Short-lived', [['long.mov', await phoneVideo('long.mov', { size: '1920x1080', seconds: 8 }), 'video/quicktime']]);
  const removed = await fetch(`${base}/api/posts/${created.body.id}`, { method: 'DELETE', headers: { ...as, 'If-Match': `"${created.body.version}"` } });
  assert.equal(removed.status, 204);
  await until(async () => (await jobs()).length === 0, 'the conversion to finish');
  assert.deepEqual(await mediaFiles(), []);
});

test('a restart resumes an unfinished conversion', { skip }, async () => {
  await start();
  const created = await upload('Interrupted', [['restart.mov', await phoneVideo('restart.mov', { size: '1920x1080', seconds: 6 }), 'video/quicktime']]);
  await stop();
  assert.equal((await jobs()).length, 2); // The job and its private source.
  await start();
  await until(async () => !(await feedPost(created.body.id)).media[0].status, 'the resumed conversion');
  assert.equal((await fetch(base + '/' + (await feedPost(created.body.id)).media[0].src)).status, 200);
});

test('videos published unconverted by earlier releases are converted and their originals removed', { skip }, async () => {
  const original = await phoneVideo('old.mov');
  await fs.mkdir(path.join(root, 'media/2026/10'), { recursive: true });
  await fs.writeFile(path.join(root, 'media/2026/10/old-1.mov'), original);
  await fs.writeFile(path.join(root, 'data/posts.json'), JSON.stringify({ posts: [{ id: 'legacy-video', author: 'Parent A', authorId: 'parent-a', publishedAt: '2026-10-01T12:00:00.000Z', text: 'Old', media: [{ type: 'video', src: 'media/2026/10/old-1.mov', alt: 'A test pattern' }] }] }));
  await start();
  const post = await until(async () => { const p = await feedPost('legacy-video'); return p.media[0].posterSrc && p; }, 'the legacy conversion');
  assert.equal(post.media[0].src, 'media/2026/10/old-1-web.mp4'); assert.equal(post.media[0].alt, 'A test pattern');
  assert.equal((await fetch(base + '/media/2026/10/old-1.mov')).status, 404);
  await assert.rejects(fs.stat(path.join(root, 'media/2026/10/old-1.mov')), { code: 'ENOENT' });
  assert.equal(Buffer.from(await (await fetch(base + '/' + post.media[0].src)).arrayBuffer()).includes(GPS.slice(0, 8)), false);
});

test('without ffmpeg, videos are refused with a clear message and photos still work', async () => {
  await start({ FFMPEG_PATH: path.join(root, 'no-ffmpeg-here'), FFPROBE_PATH: path.join(root, 'no-ffprobe-here') });
  const refused = await upload('Video', [['clip.mp4', Buffer.from('00000018ftypmp42', 'latin1'), 'video/mp4']]);
  assert.equal(refused.status, 503); assert.match(refused.body.error, /ffmpeg/);
  const photo = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#123456' } }).png().toBuffer();
  assert.equal((await upload('Photo', [['photo.png', photo, 'image/png']])).status, 201);
});
