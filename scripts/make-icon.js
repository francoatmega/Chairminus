'use strict';
// Renders the logo (src/shared/logo.js) into build/icon.ico (Windows) and, on macOS, build/icon.icns.
// Runs inside Electron: `npm run icon`. Optional arguments name different output files (*.icns, *.ico).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { app, BrowserWindow } = require('electron');
const { LOGO_SVG } = require('../src/shared/logo');

const args = process.argv.slice(2);
const buildDir = path.join(__dirname, '..', 'build');
const icnsOut = path.resolve(args.find((a) => a.endsWith('.icns')) || path.join(buildDir, 'icon.icns'));
const icoOut = path.resolve(args.find((a) => a.endsWith('.ico')) || path.join(buildDir, 'icon.ico'));
// iconutil expects exactly these files.
const ICNS_SIZES = [[16, 'icon_16x16'], [32, 'icon_16x16@2x'], [32, 'icon_32x32'], [64, 'icon_32x32@2x'], [128, 'icon_128x128'], [256, 'icon_128x128@2x'],
  [256, 'icon_256x256'], [512, 'icon_256x256@2x'], [512, 'icon_512x512'], [1024, 'icon_512x512@2x']];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

/** An .ico file whose images are PNGs (supported since Windows Vista). */
function ico(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, at);
    header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt16LE(1, at + 4); // colour planes
    header.writeUInt16LE(32, at + 6); // bits per pixel
    header.writeUInt32LE(data.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.data)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, webPreferences: { offscreen: true } });
  const page = `<body style="margin:0;background:transparent">${LOGO_SVG.replace('<svg ', '<svg width="1024" height="1024" style="display:block" ')}</body>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page));
  await new Promise((r) => setTimeout(r, 300));
  const image = await win.webContents.capturePage();
  const png = (size) => image.resize({ width: size, height: size, quality: 'best' }).toPNG();

  fs.mkdirSync(path.dirname(icoOut), { recursive: true });
  fs.writeFileSync(icoOut, ico(ICO_SIZES.map((size) => ({ size, data: png(size) }))));
  console.log(`Wrote ${icoOut}`);

  if (process.platform === 'darwin') {
    const iconset = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chairminus-icon-')), 'icon.iconset');
    fs.mkdirSync(iconset);
    for (const [size, name] of ICNS_SIZES) fs.writeFileSync(path.join(iconset, `${name}.png`), png(size));
    fs.mkdirSync(path.dirname(icnsOut), { recursive: true });
    execFileSync('iconutil', ['-c', 'icns', '-o', icnsOut, iconset]);
    console.log(`Wrote ${icnsOut}`);
  }
  app.quit();
}).catch((e) => { console.error(e); app.exit(1); });
