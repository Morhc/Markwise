// Markwise editor — wraps Milkdown Crepe (Typora-style WYSIWYG) and exposes a
// tiny bridge for the native Swift host to drive open/save.
import { Crepe } from '@milkdown/crepe'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/frame.css'
import { $inputRule } from '@milkdown/kit/utils'
import { InputRule } from '@milkdown/kit/prose/inputrules'
import { linkSchema } from '@milkdown/kit/preset/commonmark'

// Auto-convert `[text](url)` into a real link as soon as the closing `)` is typed.
const linkInputRule = $inputRule((ctx) =>
  new InputRule(/\[([^\]]+)\]\(([^)\s]+)\)$/, (state, match, start, end) => {
    const [matched, text, href] = match
    if (!matched) return null
    const mark = linkSchema.type(ctx).create({ href })
    const node = state.schema.text(text, [mark])
    return state.tr.replaceRangeWith(start, end, node)
  })
)

let crepe = null

// Post a message up to the native Swift host (WKScriptMessageHandler named "bridge").
function post(msg) {
  try {
    window.webkit?.messageHandlers?.bridge?.postMessage(msg)
  } catch (e) {
    /* running outside the app shell (e.g. plain browser) — ignore */
  }
}

// Open (or replace) the document with the given markdown text.
async function open(markdown) {
  const root = document.getElementById('app')
  if (crepe) {
    try { await crepe.destroy() } catch (e) { /* noop */ }
    crepe = null
  }
  root.innerHTML = ''

  crepe = new Crepe({ root, defaultValue: markdown ?? '' })
  crepe.editor.use(linkInputRule)
  crepe.on((listener) => {
    listener.markdownUpdated((_ctx, md, prev) => {
      if (md !== prev) post({ type: 'changed' })
    })
  })
  await crepe.create()
  post({ type: 'opened' })
}

// Return the current document as markdown (called synchronously by the host on save).
function getMarkdown() {
  return crepe ? crepe.getMarkdown() : ''
}

window.MW = { open, getMarkdown }

// Tell the host we're loaded and ready to receive a document.
post({ type: 'ready' })
// Start with an empty doc so the editor is visible even with no file.
open('')
