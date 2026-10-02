// hosted/scripts/build-icons.mjs
// Rasterise hosted/brand/icon.svg into the favicon / PWA / splash sizes hosted/static/ needs.
// The icon is the only source of truth — Task 1 ships it, Task 15 (this) renders it.

import sharp from 'sharp';
import { readFileSync } from 'node:fs';

const svg = readFileSync('hosted/brand/icon.svg');

const sizes = [
  { out: 'hosted/static/favicon-32.png', size: 32 },
  { out: 'hosted/static/icon-192.png',    size: 192 },
  { out: 'hosted/static/icon-512.png',    size: 512 },
  { out: 'hosted/static/apple-touch-icon.png', size: 180 },
];

for (const { out, size } of sizes) {
  await sharp(svg).resize(size, size).png().toFile(out);
  console.log(`wrote ${out}`);
}
await sharp(svg).resize(32, 32).toFile('hosted/static/favicon.ico');
console.log('wrote hosted/static/favicon.ico');
