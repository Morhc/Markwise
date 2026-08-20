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

// The Quick Look extension's renderer: markdown -> HTML inside JavaScriptCore
// (no DOM, no network), so the bundle must avoid browser globals. Two packages
// probe the DOM at module load and need their non-DOM variants picked by hand:
// decode-named-character-reference (creates an <i> element) and
// hast-util-from-html-isomorphic (instantiates DOMParser).
await esbuild.build({
  entryPoints: ['src/qlpreview.js'],
  bundle: true,
  format: 'iife',
  globalName: 'MWQL',
  outfile: 'app/ql/qlpreview.js',
  minify: true,
  sourcemap: false,
  legalComments: 'none',
  alias: {
    'decode-named-character-reference':
      './node_modules/decode-named-character-reference/index.js',
    'hast-util-from-html-isomorphic':
      './node_modules/hast-util-from-html-isomorphic/lib/index.js',
  },
})

// The preview stylesheet, with KaTeX's fonts inlined the same way as the app's.
await esbuild.build({
  entryPoints: ['src/qlpreview.css'],
  bundle: true,
  outfile: 'app/ql/qlpreview.css',
  minify: true,
  legalComments: 'none',
  loader: {
    '.woff': 'dataurl',
    '.woff2': 'dataurl',
    '.ttf': 'dataurl',
  },
})

console.log('bundled -> app/ql/qlpreview.js (+ qlpreview.css)')
