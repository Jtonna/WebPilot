#!/usr/bin/env node
'use strict';

// Generates app icons from assets/logo.png.
//
// Outputs:
//   packages/electron/assets/icon.ico       — multi-resolution Windows app icon
//                                             (16/24/32/48/64/128/256)
//   packages/electron/assets/tray-icon.ico  — multi-resolution Windows tray
//                                             icon (16/24/32/48). Required on
//                                             Windows — passing a PNG to Tray()
//                                             gets composited onto a white
//                                             square at certain DPI scales.
//   packages/electron/assets/tray-icon.png  — 32x32 PNG fallback for non-Windows
//                                             platforms (macOS, Linux)
//   packages/server-web-ui/app/icon.png     — 512x512 favicon (Next.js
//                                             auto-discovers app/icon.png)
//
// ICO format reference: https://en.wikipedia.org/wiki/ICO_(file_format)
// Modern Windows (Vista+) accepts PNG-encoded images inside an .ico, so
// each ICONDIRENTRY's payload is just the raw PNG bytes at that size.

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const LOGO = path.join(ROOT, 'packages', 'electron', 'assets', 'logo.png');
const OUT_ICO = path.join(ROOT, 'packages', 'electron', 'assets', 'icon.ico');
const OUT_TRAY_ICO = path.join(ROOT, 'packages', 'electron', 'assets', 'tray-icon.ico');
const OUT_TRAY = path.join(ROOT, 'packages', 'electron', 'assets', 'tray-icon.png');
const OUT_FAVICON = path.join(ROOT, 'packages', 'server-web-ui', 'app', 'icon.png');
const OUT_SPLASH_LOGO = path.join(ROOT, 'packages', 'electron', 'electron', 'splash-logo.png');

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
// Tray icons only need small sizes; including too-large entries makes Windows
// pick the wrong one and downscale, which can re-introduce halos.
const TRAY_ICO_SIZES = [16, 20, 24, 32, 40, 48];

async function resizePng(size) {
  return sharp(LOGO)
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .ensureAlpha()
    .png({ compressionLevel: 9 })
    .toBuffer();
}

function buildIco(pngBuffers) {
  // pngBuffers: Array<{ size: number, buf: Buffer }>
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);                 // reserved
  header.writeUInt16LE(1, 2);                 // type: 1 = icon
  header.writeUInt16LE(pngBuffers.length, 4); // count

  const entrySize = 16;
  const dataOffsetStart = 6 + entrySize * pngBuffers.length;

  const entries = Buffer.alloc(entrySize * pngBuffers.length);
  let currentOffset = dataOffsetStart;
  pngBuffers.forEach(({ size, buf }, i) => {
    const off = i * entrySize;
    entries.writeUInt8(size === 256 ? 0 : size, off + 0); // width (0 = 256)
    entries.writeUInt8(size === 256 ? 0 : size, off + 1); // height
    entries.writeUInt8(0, off + 2);                       // colorCount
    entries.writeUInt8(0, off + 3);                       // reserved
    entries.writeUInt16LE(1, off + 4);                    // planes
    entries.writeUInt16LE(32, off + 6);                   // bitCount
    entries.writeUInt32LE(buf.length, off + 8);           // sizeInBytes
    entries.writeUInt32LE(currentOffset, off + 12);       // offset
    currentOffset += buf.length;
  });

  return Buffer.concat([header, entries, ...pngBuffers.map((p) => p.buf)]);
}

async function main() {
  if (!fs.existsSync(LOGO)) {
    console.error('ERROR: ' + LOGO + ' not found.');
    process.exit(1);
  }

  console.log('Resizing logo to ICO sizes:', ICO_SIZES.join(', '));
  const pngBuffers = [];
  for (const size of ICO_SIZES) {
    const buf = await resizePng(size);
    pngBuffers.push({ size, buf });
  }

  console.log('Writing ' + OUT_ICO);
  fs.writeFileSync(OUT_ICO, buildIco(pngBuffers));

  console.log('Resizing logo to tray ICO sizes:', TRAY_ICO_SIZES.join(', '));
  const trayPngBuffers = [];
  for (const size of TRAY_ICO_SIZES) {
    const buf = await resizePng(size);
    trayPngBuffers.push({ size, buf });
  }

  console.log('Writing ' + OUT_TRAY_ICO);
  fs.writeFileSync(OUT_TRAY_ICO, buildIco(trayPngBuffers));

  console.log('Writing ' + OUT_TRAY);
  fs.writeFileSync(OUT_TRAY, await resizePng(32));

  console.log('Writing ' + OUT_FAVICON);
  fs.writeFileSync(OUT_FAVICON, await resizePng(512));

  console.log('Writing ' + OUT_SPLASH_LOGO);
  fs.writeFileSync(OUT_SPLASH_LOGO, await resizePng(192));

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
