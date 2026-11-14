// Background video conversion. Phone videos usually carry the GPS location where
// they were recorded, and iPhone HEVC video does not play in every browser, so every
// uploaded video is re-encoded to H.264/AAC MP4 (at most 1920 pixels on the long
// edge) with all metadata removed, plus a WebP poster frame. Jobs survive restarts.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg', FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';
const TIMEOUT_MS = 20 * 60 * 1000;
const THREADS = String(Math.max(1, Math.min(2, os.availableParallelism?.() || 2)));

// Containers are named from their first bytes and passed to ffmpeg explicitly, so a
// playlist or concat file disguised as a video can never make it open other files.
export function sniffVideo(head) {
  if (head.length >= 12 && ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(head.toString('latin1', 4, 8))) return 'mov';
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) return 'matroska';
  return null;
}

const running = new Set();
function run(command, args, { timeout = TIMEOUT_MS, output = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', output ? 'pipe' : 'ignore', 'pipe'] });
    running.add(child);
    const chunks = []; let errors = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout?.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => { if (errors.length < 4000) errors += chunk; });
    child.once('error', (error) => { clearTimeout(timer); running.delete(child); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer); running.delete(child);
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(signal ? `${path.basename(command)} stopped (${signal})` : `${path.basename(command)} failed: ${errors.trim().split('\n').at(-1) || code}`));
    });
  });
}

export async function createVideoProcessor({ dataDir, mediaPath, complete, log = console }) {
  const jobsDir = path.join(dataDir, '.video-jobs');
  await fs.mkdir(jobsDir, { recursive: true, mode: 0o700 });
  let available = true;
  try { await run(FFMPEG, ['-version'], { timeout: 10000 }); await run(FFPROBE, ['-version'], { timeout: 10000 }); }
  catch { available = false; log.warn('ffmpeg and ffprobe were not found: video uploads are refused until they are installed.'); }
  let queue = Promise.resolve();
  const jobFile = (job) => path.join(jobsDir, `${job.id}.json`);
  const sourceFile = (job) => job.sourceSrc ? mediaPath(job.sourceSrc) : path.join(jobsDir, `${job.id}.source`);

  async function convert(job) {
    const output = mediaPath(job.src), poster = mediaPath(job.posterSrc);
    const tmpVideo = `${output}.${process.pid}.tmp.mp4`, tmpPoster = `${poster}.${process.pid}.tmp`;
    try {
      await fs.mkdir(path.dirname(output), { recursive: true });
      await run(FFMPEG, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-protocol_whitelist', 'file', '-f', job.format, '-i', sourceFile(job),
        '-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '-1', '-map_metadata:s:v', '-1', '-map_metadata:s:a', '-1', '-map_chapters', '-1',
        '-vf', "scale='min(1920,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p",
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-profile:v', 'high', '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
        '-movflags', '+faststart', '-threads', THREADS, '-f', 'mp4', tmpVideo]);
      const probe = JSON.parse(await run(FFPROBE, ['-v', 'error', '-protocol_whitelist', 'file', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', tmpVideo], { output: true, timeout: 60000 }));
      const frame = await run(FFMPEG, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-protocol_whitelist', 'file', '-f', 'mp4', '-i', tmpVideo, '-vf', 'thumbnail=30', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], { output: true, timeout: 120000 });
      const still = await sharp(frame).resize(1280, 1280, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 76 }).toBuffer();
      await fs.writeFile(tmpPoster, still);
      const { width, height } = probe.streams?.[0] || {};
      if (!width || !height) throw new Error('The converted video has no picture.');
      return { width, height, duration: Math.round(Number(probe.format?.duration) * 10) / 10 || undefined, tmpVideo, tmpPoster };
    } catch (error) {
      await fs.rm(tmpVideo, { force: true }); await fs.rm(tmpPoster, { force: true });
      throw error;
    }
  }
  async function work(job) {
    let result;
    try { result = await convert(job); }
    catch (error) { log.warn(`Video ${job.id} could not be converted: ${error.message}`); result = { error: error.message }; }
    try { await complete(job, result); }
    finally {
      if (result.tmpVideo) { await fs.rm(result.tmpVideo, { force: true }); await fs.rm(result.tmpPoster, { force: true }); }
      await forget(job);
    }
  }
  async function forget(job) {
    await fs.rm(jobFile(job), { force: true });
    if (!job.sourceSrc) await fs.rm(sourceFile(job), { force: true });
  }

  return {
    get available() { return available; },
    /** Save an upload privately for conversion. Start it once the post that uses it is saved. */
    async stage({ data, format, src, posterSrc }) {
      const job = { id: crypto.randomUUID(), format, match: src, src, posterSrc, createdAt: new Date().toISOString() };
      await fs.writeFile(sourceFile(job), data, { mode: 0o600, flag: 'wx' });
      await fs.writeFile(jobFile(job), JSON.stringify(job), { mode: 0o600, flag: 'wx' });
      return job;
    },
    /** Convert a video that was published before conversion existed, keeping it visible meanwhile. */
    async stageExisting({ sourceSrc, format, src, posterSrc }) {
      const job = { id: crypto.randomUUID(), format, match: sourceSrc, sourceSrc, src, posterSrc, createdAt: new Date().toISOString() };
      await fs.writeFile(jobFile(job), JSON.stringify(job), { mode: 0o600, flag: 'wx' });
      return job;
    },
    start(job) { const next = queue.then(() => work(job)); queue = next.catch(() => {}); return next; },
    discard: forget,
    /** Jobs saved before a restart: resume the ones a post still waits for. */
    async pending() {
      const jobs = [];
      for (const name of await fs.readdir(jobsDir)) {
        if (!name.endsWith('.json')) continue;
        try { jobs.push(JSON.parse(await fs.readFile(path.join(jobsDir, name), 'utf8'))); } catch { /* A half-written job is staged again by its upload's retry. */ }
      }
      return jobs;
    },
    /** Resolves when every queued conversion has finished (for shutdown and tests). */
    idle: () => queue,
    /** Stop running conversions at shutdown; their jobs resume at the next start. */
    stop() { for (const child of running) child.kill('SIGKILL'); },
  };
}
