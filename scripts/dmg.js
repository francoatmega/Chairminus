'use strict';
// Wraps the packaged app in a disk image with an Applications shortcut: dist/Chairminus-<version>-<arch>.dmg.
// macOS only (uses hdiutil). Run through `npm run dist:mac`, which packages the app first.
//   node scripts/dmg.js [--arch x64|arm64]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const i = process.argv.indexOf('--arch');
const arch = i === -1 ? process.env.CHAIRMINUS_ARCH || process.arch : process.argv[i + 1];

if (process.platform !== 'darwin') throw new Error('A .dmg can only be built on macOS');
const app = path.join(root, 'dist', `${pkg.productName}-darwin-${arch}`, `${pkg.productName}.app`);
if (!fs.existsSync(app)) throw new Error(`Package the app first: ${app} is missing`);

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'chairminus-dmg-'));
try {
  execFileSync('ditto', [app, path.join(stage, `${pkg.productName}.app`)]);
  fs.symlinkSync('/Applications', path.join(stage, 'Applications'));
  const out = path.join(root, 'dist', `${pkg.productName}-${pkg.version}-${arch}.dmg`);
  fs.rmSync(out, { force: true });
  execFileSync('hdiutil', ['create', '-volname', pkg.productName, '-srcfolder', stage, '-ov', '-format', 'UDZO', '-fs', 'HFS+', out], { stdio: 'inherit' });
  console.log(`Wrote ${out}`);
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
