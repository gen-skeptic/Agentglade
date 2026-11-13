// Decode one photo away from the HTTP event loop. No originals are persisted.
import { parentPort, workerData } from 'node:worker_threads';
import sharp from 'sharp';
import decodeHeic from 'heic-decode';

sharp.cache(false);
sharp.concurrency(1);
const MAX_PIXELS = 120_000_000;
const RASTER = new Set(['jpeg', 'png', 'webp', 'gif', 'tiff', 'heif', 'avif']);
try {
  const buffer = Buffer.from(workerData);
  const brand = buffer.toString('ascii', 8, 12);
  let input = buffer, options = { limitInputPixels: MAX_PIXELS, failOn: 'warning' };
  if (['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)) {
    const images = await decodeHeic.all({ buffer });
    try {
      const first = images[0];
      if (!first) throw new Error('HEIC image missing.');
      // HEIC decodes to full RGBA before resizing. Bound its larger memory cost.
      if (first.width * first.height > 60_000_000) throw new Error('HEIC originals over 60 megapixels must be exported as JPEG first.');
      const decoded = await first.decode();
      input = decoded.data;
      options.raw = { width: decoded.width, height: decoded.height, channels: 4 };
    } finally { images.dispose(); }
  } else {
    const metadata = await sharp(buffer, options).metadata();
    if (!RASTER.has(metadata.format)) throw new Error('Unsupported photo format.');
  }
  // Orientation is applied before sizing; default output strips EXIF/GPS.
  const master = await sharp(input, options).rotate().resize(3840, 3840, { fit: 'inside', withoutEnlargement: true })
    .toColourspace('srgb').webp({ quality: 84, effort: 4 }).toBuffer({ resolveWithObject: true });
  let preview;
  if (Math.max(master.info.width, master.info.height) > 1280) {
    preview = await sharp(master.data).resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 76, effort: 3 }).toBuffer({ resolveWithObject: true });
  }
  parentPort.postMessage({ master: master.data, width: master.info.width, height: master.info.height,
    ...(preview ? { preview: preview.data, previewWidth: preview.info.width, previewHeight: preview.info.height } : {}) });
} catch (error) {
  parentPort.postMessage({ error: error.message.startsWith('HEIC originals') ? error.message : /pixel|dimensions|120 megapixels/i.test(error.message)
    ? 'This photo exceeds the 120 megapixel limit.' : 'This photo could not be decoded. Try exporting it as JPEG or PNG.' });
} finally { parentPort.close(); }
