'use strict';
// Packages the app for macOS (dist/Chairminus-darwin-<arch>/Chairminus.app) or Windows
// (dist/Chairminus-win32-<arch>/Chairminus.exe, plus a .zip of that folder).
//   node scripts/package.js [--platform darwin|win32] [--arch x64|arm64]
// Defaults to the current system. Run through `npm run dist`, `dist:mac` or `dist:win`, which build the renderer first.
const fs = require('fs');
const path = require('path');
const { packager } = require('@electron/packager');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

const root = path.join(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const { execFileSync } = require('child_process');

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i === -1 ? undefined : process.argv[i + 1]; };
const platform = arg('platform') || process.env.CHAIRMINUS_PLATFORM || process.platform;
const arch = arg('arch') || process.env.CHAIRMINUS_ARCH || process.arch;
if (!['darwin', 'win32'].includes(platform)) throw new Error(`Packaging for ${platform} is not set up; use darwin or win32`);
const icon = path.join(root, 'build', platform === 'win32' ? 'icon.ico' : 'icon.icns');

// Only what the app needs at run time goes into app.asar: the main process, the preload script, the shared
// modules, the renderer page with its bundle, and the production dependencies (packager prunes the rest).
const KEEP = ['/package.json', '/node_modules', '/src/main', '/src/preload', '/src/shared', '/src/renderer/index.html', '/src/renderer/styles.css', '/src/renderer/bundle'];
const keep = (file) => KEEP.some((k) => file === k || file.startsWith(k + '/') || k.startsWith(file + '/'));

// ssh2's optional native add-ons (its crypto binding and cpu-features) are left out: a copy compiled by
// `npm install` targets the system Node, not Electron, and ssh2 falls back to its JavaScript implementation.
const nativeBuild = (file) => /\/node_modules\/\.bin(\/|$)/.test(file) || /\/buildcheck\.gypi$/.test(file)
  || (/\/build$/.test(file) && fs.existsSync(path.join(root, file, 'config.gypi'))) || /\/build\/(Release|Debug|deps)(\/|$)/.test(file);

async function main() {
  if (!fs.existsSync(path.join(root, 'src', 'renderer', 'bundle', 'app.js'))) throw new Error('Build the renderer first: npm run build');
  const [appPath] = await packager({
    dir: root,
    out: path.join(root, 'dist'),
    overwrite: true,
    name: pkg.productName,
    platform,
    arch,
    appBundleId: 'app.chairminus.desktop',
    appVersion: pkg.version,
    appCopyright: `${pkg.productName} ${pkg.version}`,
    appCategoryType: 'public.app-category.developer-tools',
    icon: fs.existsSync(icon) ? icon : undefined,
    asar: true,
    prune: true,
    ignore: (file) => file !== '' && (!keep(file) || nativeBuild(file)),
    extendInfo: {
      LSMinimumSystemVersion: '12.0',
      CFBundleDocumentTypes: [
        { CFBundleTypeName: 'SQLite database', CFBundleTypeRole: 'Editor', LSHandlerRank: 'Alternate', CFBundleTypeExtensions: ['sqlite', 'sqlite3', 'db', 'db3'] },
        { CFBundleTypeName: 'SQL file', CFBundleTypeRole: 'Editor', LSHandlerRank: 'Alternate', CFBundleTypeExtensions: ['sql'] },
      ],
    },
    win32metadata: {
      CompanyName: pkg.author,
      FileDescription: pkg.productName,
      ProductName: pkg.productName,
      InternalName: pkg.productName,
      OriginalFilename: `${pkg.productName}.exe`,
    },
  });

  const app = path.join(appPath, platform === 'win32' ? `${pkg.productName}.exe` : `${pkg.productName}.app`);
  await flipFuses(app, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: platform === 'darwin',
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });
  console.log(`Packaged ${app}`);

  if (platform === 'win32') {
    // A portable build: unzip anywhere and run Chairminus.exe. bsdtar (macOS, Windows 10+) writes zip files.
    const zip = path.join(root, 'dist', `${pkg.productName}-${pkg.version}-win32-${arch}.zip`);
    fs.rmSync(zip, { force: true });
    execFileSync('tar', ['-a', '-c', '-f', zip, '-C', path.dirname(appPath), path.basename(appPath)]);
    console.log(`Wrote ${zip}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
