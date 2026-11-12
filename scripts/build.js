'use strict';
// Bundles the renderer (src/renderer/src/app.js, the shared modules it imports and CodeMirror)
// into the single script that index.html loads: src/renderer/bundle/app.js.
const path = require('path');
const esbuild = require('esbuild');

const root = path.join(__dirname, '..');

esbuild.build({
  entryPoints: [path.join(root, 'src', 'renderer', 'src', 'app.js')],
  outfile: path.join(root, 'src', 'renderer', 'bundle', 'app.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  minify: !process.argv.includes('--dev'),
  sourcemap: process.argv.includes('--dev') ? 'inline' : false,
  legalComments: 'none',
  logLevel: 'info',
}).catch(() => process.exit(1));
