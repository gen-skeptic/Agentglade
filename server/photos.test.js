import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import sharp from 'sharp';
import { preparePhoto } from './photos.js';

const file = (buffer, name = 'photo.jpg', type = 'image/jpeg') => new File([buffer], name, { type });
test('48 megapixel photos become a 4K master and a smaller feed preview', async () => {
  const input = await sharp({ create: { width: 8000, height: 6000, channels: 3, background: '#8899aa' } }).jpeg({ quality: 95 }).toBuffer();
  const photo = await preparePhoto(file(input));
  assert.equal(photo.width, 3840); assert.equal(photo.height, 2880);
  assert.equal(photo.previewWidth, 1280); assert.equal(photo.previewHeight, 960);
  const master = await sharp(photo.master).metadata(), preview = await sharp(photo.preview).metadata();
  assert.equal(master.format, 'webp'); assert.equal(master.width, 3840);
  assert.equal(preview.format, 'webp'); assert.equal(preview.width, 1280);
  assert.ok(photo.master.length + photo.preview.length < input.length);
});
test('orientation is applied before the long edge cap and EXIF is stripped', async () => {
  const input = await sharp({ create: { width: 4000, height: 2000, channels: 3, background: '#887799' } })
    .withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const photo = await preparePhoto(file(input));
  assert.equal(photo.width, 1920); assert.equal(photo.height, 3840);
  const metadata = await sharp(photo.master).metadata();
  assert.equal(metadata.orientation, undefined); assert.equal(metadata.exif, undefined);
});
test('HEIC originals decode without browser support and small photos are not enlarged', async () => {
  const input = await fs.readFile(new URL('./fixtures/sample.heic', import.meta.url));
  const photo = await preparePhoto(file(input, 'phone.heic', 'image/heic'));
  assert.equal(photo.width, 32); assert.equal(photo.height, 24);
  assert.equal(photo.preview, undefined);
  assert.equal((await sharp(photo.master).metadata()).format, 'webp');
});
test('broken images and disguised SVG are rejected rather than stored as broken posts', async () => {
  for (const input of [Buffer.from('not a photo'), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>')]) {
    await assert.rejects(preparePhoto(file(input)), (error) => error.status === 422 && error.message.includes('could not be decoded'));
  }
});
test('oversized decoded dimensions fail before allocating the pixel data', async () => {
  const jpeg = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#fff' } }).jpeg().toBuffer();
  const offset = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
  assert.ok(offset > 0);
  jpeg.writeUInt16BE(20000, offset + 5); jpeg.writeUInt16BE(10000, offset + 7);
  await assert.rejects(preparePhoto(file(jpeg)), (error) => error.status === 422 && error.message.includes('120 megapixel'));
});
