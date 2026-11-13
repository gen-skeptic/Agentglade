// Resize decoded photos before upload, one at a time to protect phone memory.
// The server normalizes every photo again, including HEIC this browser cannot read.
export const MAX_EDGE = 3840;
export const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  avif: 'image/avif', gif: 'image/gif', heic: 'image/heic', heif: 'image/heif', tif: 'image/tiff', tiff: 'image/tiff',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };

export function normalizeFile(file) {
  const type = file.type || TYPES[file.name.split('.').pop().toLowerCase()];
  if (!type || !Object.values(TYPES).includes(type)) throw new Error(`${file.name}: choose a photo or an MP4, MOV, or WebM video.`);
  return file.type ? file : new File([file], file.name, { type, lastModified: file.lastModified });
}
async function decode(file) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* Try Safari's image decoder. */ }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return image;
  } finally { URL.revokeObjectURL(url); }
}
async function prepareImage(file, maxEdge = MAX_EDGE, quality = 0.88) {
  let image;
  try { image = await decode(file); }
  catch { return { file, serverProcessing: true }; }
  const width = image.naturalWidth || image.width, height = image.naturalHeight || image.height;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas unavailable');
    context.fillStyle = '#fff'; context.fillRect(0, 0, w, h);
    context.drawImage(image, 0, 0, w, h);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob) throw new Error('Photo encoding unavailable');
    return { file: new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' }), width: w, height: h };
  } catch { return { file, serverProcessing: true }; }
  finally { image.close?.(); canvas.width = canvas.height = 0; }
}
export async function preparePreview(file) {
  const result = await prepareImage(file, 1280, 0.76);
  return result.serverProcessing ? null : result.file;
}
function videoSize(file) {
  return new Promise((resolve) => {
    const video = document.createElement('video'), url = URL.createObjectURL(file);
    let done = false;
    const finish = (value) => { if (done) return; done = true; clearTimeout(timer); video.removeAttribute('src'); video.load(); URL.revokeObjectURL(url); resolve(value); };
    const timer = setTimeout(() => finish({}), 5000);
    video.preload = 'metadata';
    video.onloadedmetadata = () => finish({ width: video.videoWidth, height: video.videoHeight });
    video.onerror = () => finish({});
    video.src = url;
  });
}
export async function prepareMedia(files, { onProgress } = {}) {
  const prepared = [];
  for (const [index, source] of files.entries()) {
    const file = normalizeFile(source);
    onProgress?.(`Preparing ${index + 1} of ${files.length}…`);
    prepared.push(file.type.startsWith('image/') ? await prepareImage(file) : { file, ...(await videoSize(file)) });
    // Give the browser a chance to paint progress between large photos.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (prepared.reduce((total, item) => total + item.file.size, 0) > MAX_UPLOAD_BYTES - 256 * 1024) {
    throw new Error('This post exceeds the 64 MiB upload limit after photo compression. Use fewer photos or shorter videos; your draft is still here.');
  }
  return prepared;
}
