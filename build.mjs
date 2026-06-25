// Bundles the editor + all CSS/fonts/icons into a single self-contained JS + CSS
// pair under app/web/, so the native app needs no network and no node_modules.
import * as esbuild from 'esbuild'

await esbuild.build({
  entryPoints: ['src/editor.js'],
  bundle: true,
  format: 'iife',
  outfile: 'app/web/bundle.js',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  loader: {
    '.css': 'css',
    // Inline every asset as a data URI so the output is fully self-contained.
    '.woff': 'dataurl',
    '.woff2': 'dataurl',
    '.ttf': 'dataurl',
    '.eot': 'dataurl',
    '.svg': 'dataurl',
    '.png': 'dataurl',
    '.jpg': 'dataurl',
    '.gif': 'dataurl',
  },
})

console.log('bundled -> app/web/bundle.js (+ bundle.css)')
