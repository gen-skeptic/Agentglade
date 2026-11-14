import { Worker } from 'node:worker_threads';

// Decode one photo at a time across the whole process. A single large photo can
// need hundreds of MiB of native memory, so concurrent uploads wait here rather
// than decoding in parallel. This queue is separate from the post write lock, so
// waiting for photos never blocks sign-in, reads, or text-only changes.
let queue = Promise.resolve();
export function preparePhoto(file) {
  const run = queue.then(() => decode(file));
  queue = run.catch(() => {});
  return run;
}

async function decode(file) {
  const data = await file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./photo-worker.js', import.meta.url), {
      workerData: data, transferList: [data], resourceLimits: { maxOldGenerationSizeMb: 256 },
    });
    let finished = false;
    const complete = (error, result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      void worker.terminate();
      if (error) reject(Object.assign(new Error(`${file.name}: ${error}`), { status: 422 }));
      else resolve(result);
    };
    const timer = setTimeout(() => complete('Photo processing took too long. Try posting fewer photos at once.'), 60000);
    worker.once('message', (result) => complete(result.error, result));
    worker.once('error', () => complete('This photo could not be processed. Your post was not changed.'));
    worker.once('exit', () => { if (!finished) complete('Photo processing stopped. Please try again.'); });
  });
}
