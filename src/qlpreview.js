// Markdown -> HTML for the Quick Look extension.
//
// The extension can't run the live editor (Quick Look previews are static and
// scripts stay disabled), so this is a one-way render: the same remark parser
// family the editor uses, straight to HTML, with KaTeX math rendered to
// markup server-side. It runs inside JavaScriptCore in the extension process —
// no DOM, no network — and the result is displayed by a WKWebView whose
// JavaScript is off, so raw HTML in previewed files is inert by construction.
//
// Bundled as an IIFE with global name MWQL (see build.mjs); the extension
// calls MWQL.render(markdown) and gets back an HTML string for the <body>.
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkRehype from 'remark-rehype'
import rehypeRaw from 'rehype-raw'
import rehypeKatex from 'rehype-katex'
import rehypeStringify from 'rehype-stringify'

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath, { singleDollarTextMath: true })
  // allowDangerousHtml + rehype-raw keep the HTML Markwise itself writes —
  // <img … width>, <sup>/<sub>, <br /> — as real elements. Anything hostile a
  // downloaded file might carry is neutralised by the viewer: scripts are
  // disabled wholesale in the preview web view.
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeKatex, { output: 'html' })
  .use(rehypeStringify, { allowDangerousHtml: false })

export function render(markdown) {
  return String(processor.processSync(String(markdown ?? '')))
}
