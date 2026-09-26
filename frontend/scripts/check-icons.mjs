import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const expected = [
  ['frontend/public/icons/icon-16x16.png', 16],
  ['frontend/public/icons/icon-32x32.png', 32],
  ['frontend/public/icons/icon-180x180.png', 180],
  ['frontend/public/icons/icon-192x192.png', 192],
  ['frontend/public/icons/icon-512x512.png', 512],
  ['frontend/public/icons/icon-512x512-maskable.png', 512],
  ['android/store-listing/icon-512x512.png', 512],
];

for (const [relativePath, size] of expected) {
  const path = `${root}/${relativePath}`;
  const png = readFileSync(path);
  const signature = png.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') throw new Error(`${relativePath}: expected a PNG`);
  const dimensions = `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`;
  if (dimensions !== `${size}x${size}`) {
    throw new Error(`${relativePath}: expected ${size}x${size}, got ${dimensions}`);
  }
}

const playIcon = `${root}/android/store-listing/icon-512x512.png`;
const colorType = readFileSync(playIcon)[25];
if (colorType !== 6) throw new Error('Play icon must be a 32-bit RGBA PNG');
if (statSync(playIcon).size > 1024 * 1024) throw new Error('Play icon exceeds 1,024 KB');

console.log('Icon assets meet the required dimensions and Play upload format.');
