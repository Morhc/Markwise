// Markwise editor — wraps Milkdown Crepe (Typora-style WYSIWYG) and exposes a
// tiny bridge for the native Swift host to drive open/save.
import { Crepe } from '@milkdown/crepe'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/frame.css'
import { $inputRule } from '@milkdown/kit/utils'
import { InputRule } from '@milkdown/kit/prose/inputrules'
import { linkSchema } from '@milkdown/kit/preset/commonmark'
import { codeMirrorTheme, codeLanguages } from './codeblock.js'

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

// Turn a list item into a checklist item when you type `[] `, `[ ] ` or `[x] `.
// More forgiving than the built-in GFM rule (which requires the inner space).
const taskListInputRule = $inputRule(() =>
  new InputRule(/^\[(\s|x|X)?\]\s$/, (state, match, start, end) => {
    const pos = state.doc.resolve(start)
    // Walk up to the enclosing list item, if any.
    let depth = 0
    let node = pos.node(depth)
    while (node && node.type.name !== 'list_item') {
      depth--
      node = pos.node(depth)
    }
    if (!node || node.attrs.checked != null) return null
    const checked = /x/i.test(match[1] ?? '')
    const listPos = pos.before(depth)
    return state.tr
      .deleteRange(start, end)
      .setNodeMarkup(listPos, undefined, { ...node.attrs, checked })
  })
)

let crepe = null
// The document content as last loaded or saved. The document is "dirty" only
// when the current markdown differs from this baseline — robust against the
// editor's own normalization and async setup transactions.
let baseline = ''
// True while a document is loading; setup events keep the baseline in sync.
let loading = false

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
  loading = true
  if (crepe) {
    try { await crepe.destroy() } catch (e) { /* noop */ }
    crepe = null
  }
  root.innerHTML = ''

  crepe = new Crepe({
    root,
    defaultValue: markdown ?? '',
    featureConfigs: {
      [Crepe.Feature.CodeMirror]: {
        theme: codeMirrorTheme,
        languages: codeLanguages,
      },
    },
  })
  crepe.editor.use(linkInputRule)
  crepe.editor.use(taskListInputRule)
  crepe.on((listener) => {
    listener.markdownUpdated((_ctx, md) => {
      if (loading) {
        // Keep the baseline in sync with the editor's own setup/normalization.
        baseline = md
        return
      }
      post({ type: md === baseline ? 'clean' : 'dirty' })
    })
  })
  await crepe.create()
  baseline = crepe.getMarkdown()
  // Let async setup transactions (e.g. code-block features) settle, folding
  // them into the baseline, before we start reporting user edits.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    baseline = crepe.getMarkdown()
    loading = false
    post({ type: 'opened' })
    post({ type: 'clean' })
  }))
}

// Return the current document as markdown (called synchronously by the host on save).
function getMarkdown() {
  return crepe ? crepe.getMarkdown() : ''
}

// Called by the host after a successful save: the current content is now clean.
function markSaved() {
  if (crepe) baseline = crepe.getMarkdown()
}

window.MW = { open, getMarkdown, markSaved }

// Tell the host we're loaded and ready to receive a document.
post({ type: 'ready' })
// Start with an empty doc so the editor is visible even with no file.
open('')
