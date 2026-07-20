// Markwise editor — wraps Milkdown Crepe (Typora-style WYSIWYG) and exposes a
// tiny bridge for the native Swift host to drive open/save.
import { Crepe } from '@milkdown/crepe'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/frame.css'
import { $inputRule } from '@milkdown/kit/utils'
import { InputRule } from '@milkdown/kit/prose/inputrules'
import { linkSchema } from '@milkdown/kit/preset/commonmark'
import { editorViewCtx } from '@milkdown/kit/core'
import { uploadConfig } from '@milkdown/kit/plugin/upload'
import { codeMirrorTheme, codeLanguages } from './codeblock.js'

// Read a File as a self-contained data: URL so dropped/pasted images persist in
// the saved markdown (Crepe's default uploader uses ephemeral blob: URLs).
function fileToDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(r.result)
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

// Auto-convert `[text](url)` into a real link as soon as the closing `)` is typed.
const linkInputRule = $inputRule((ctx) =>
  new InputRule(/\[([^\]]+)\]\(([^)\s]+)\)$/, (state, match, start, end) => {
    const [matched, text, href] = match
    if (!matched) return null
    // Don't hijack image syntax: `![alt](url)` must fall through to the built-in
    // image input rule. Without this guard, this rule matches the `[alt](url)`
    // substring first and turns the image into a plain link.
    if (start > 0 && state.doc.textBetween(start - 1, start) === '!') return null
    const mark = linkSchema.type(ctx).create({ href })
    const node = state.schema.text(text, [mark])
    return state.tr.replaceRangeWith(start, end, node)
  })
)

// Convert `![alt](src "caption")` as you type. A standalone image (the whole
// paragraph) becomes a block image — which supports a caption and resizing —
// while an image typed among other text becomes an inline image.
const imageInputRule = $inputRule(() =>
  new InputRule(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/, (state, match, start, end) => {
    const [, alt = '', src, title] = match
    if (!src) return null
    const { schema } = state
    const $start = state.doc.resolve(start)
    const standalone =
      $start.parent.type.name === 'paragraph' &&
      $start.parentOffset === 0 &&
      end >= $start.end()
    if (standalone && schema.nodes['image-block']) {
      const block = schema.nodes['image-block'].createAndFill({ src, caption: title || alt || '' })
      if (block) return state.tr.replaceRangeWith($start.before(), $start.after(), block)
    }
    const img = schema.nodes.image.create({ src, alt, title: title || null })
    return state.tr.replaceRangeWith(start, end, img)
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
// The live ProseMirror view (set after each create) — used for image editing.
let view = null
// Position of the image whose source the native host is currently editing.
let pendingImagePos = null
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


// Paste of a web image (copied from a browser) arrives as text/html containing
// just an <img>, with no file — Milkdown's HTML→markdown paste drops it. Detect
// an image-only paste and insert the image node(s) ourselves. (Raw image files
// arrive as clipboardData.files and are handled by the upload plugin instead.)
document.addEventListener('paste', (e) => {
  if (!view) return
  const cd = e.clipboardData
  if (!cd || (cd.files && cd.files.length)) return
  const html = cd.getData('text/html')
  if (!html) return
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  const imgs = parsed.querySelectorAll('img[src]')
  const text = (parsed.body.textContent || '').trim()
  if (!imgs.length || text) return // not an image-only paste — let Milkdown handle it
  const srcs = [...imgs].map((img) => img.getAttribute('src')).filter(Boolean)
  if (!srcs.length) return
  e.preventDefault()
  e.stopPropagation()
  insertImages(srcs, null, null)
}, true)

// Build image nodes (block images, so they support captions) for the given
// sources and insert them at `pos` (or the current selection).
function insertImagesAt(srcs, pos) {
  if (!view || !Array.isArray(srcs) || !srcs.length) return
  const type = view.state.schema.nodes['image-block'] || view.state.schema.nodes.image
  if (!type) return
  const nodes = srcs.map((s) => type.createAndFill({ src: s })).filter(Boolean)
  if (!nodes.length) return
  const at = pos == null ? view.state.selection.from : pos
  view.dispatch(view.state.tr.replaceWith(at, at, nodes).scrollIntoView())
}

// Open (or replace) the document with the given markdown text.
async function open(markdown) {
  const root = document.getElementById('app')
  loading = true
  view = null
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
      // Flash a "Copied!" confirmation when the link tooltip's copy button is used.
      [Crepe.Feature.LinkTooltip]: {
        onCopyLink: () => {
          const icon = document.querySelector('.link-preview .link-icon')
          if (!icon) return
          icon.classList.add('mw-copied')
          setTimeout(() => icon.classList.remove('mw-copied'), 1200)
        },
      },
    },
  })
  crepe.editor.use(linkInputRule)
  crepe.editor.use(taskListInputRule)
  // Typing `![alt](src)` doesn't create an image by default (commonmark ships an
  // image input rule but doesn't register it). Use our own, which prefers a
  // block image (caption + resize) for a standalone image.
  crepe.editor.use(imageInputRule)
  // Drag-and-drop or paste image files -> embed as data: URLs so they survive a
  // save (web images copied with HTML still paste as their URL via ProseMirror).
  crepe.editor.config((ctx) => {
    ctx.update(uploadConfig.key, (prev) => ({
      ...prev,
      uploader: async (files, schema) => {
        const type = schema.nodes['image-block'] || schema.nodes.image
        if (!type) return []
        const nodes = []
        for (let i = 0; i < files.length; i++) {
          const file = files.item(i)
          if (!file || !file.type.startsWith('image/')) continue
          try {
            const node = type.createAndFill({ src: await fileToDataURL(file) })
            if (node) nodes.push(node)
          } catch (e) { /* skip unreadable file */ }
        }
        return nodes
      },
    }))
  })
  crepe.on((listener) => {
    listener.markdownUpdated((_ctx, md) => {
      if (loading) {
        // Keep the baseline in sync with the editor's own setup/normalization.
        baseline = md
        return
      }
      post({ type: md === baseline ? 'clean' : 'dirty' })
      scheduleOutline()
    })
  })
  await crepe.create()
  // Make the link mark non-inclusive so typing immediately before or after a
  // link does NOT extend the link onto the new text (ProseMirror marks are
  // inclusive by default). `spec.inclusive` is read live by ResolvedPos.marks().
  crepe.editor.action((ctx) => {
    try {
      view = ctx.get(editorViewCtx)
      const linkMark = view.state.schema.marks.link
      if (linkMark) linkMark.spec.inclusive = false
    } catch (e) { /* view not ready — ignore */ }
  })
  baseline = crepe.getMarkdown()
  // Let async setup transactions (e.g. code-block features) settle, folding
  // them into the baseline, before we start reporting user edits.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    baseline = crepe.getMarkdown()
    loading = false
    post({ type: 'opened' })
    post({ type: 'clean' })
    scheduleOutline()
    // Focus the editor so you can start typing immediately (Typora-style).
    try { view && view.focus() } catch (e) { /* noop */ }
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

// --- Block handle: keep it from getting stranded on layout changes ----------
// The block plugin only repositions its `+`/drag handle on hover, so on window
// resize / scroll it can sit in the wrong place. Hide it; it re-anchors
// correctly the next time the pointer moves over a block.
function hideBlockHandle() {
  const h = document.querySelector('.milkdown-block-handle')
  if (h) h.dataset.show = 'false'
}
window.addEventListener('resize', hideBlockHandle)

// --- Document outline (toggle-able, off by default) -------------------------
let outlineVisible = false
let outlineTimer = null

function editorEl() {
  return document.querySelector('.milkdown .editor') ||
         document.querySelector('.milkdown')
}

function buildOutline() {
  const panel = document.getElementById('outline')
  if (!panel) return
  panel.innerHTML = ''
  const title = document.createElement('div')
  title.className = 'outline-title'
  title.textContent = 'Outline'
  panel.appendChild(title)

  const root = editorEl()
  const heads = root ? root.querySelectorAll('h1,h2,h3,h4,h5,h6') : []
  if (!heads.length) {
    const empty = document.createElement('div')
    empty.className = 'outline-empty'
    empty.textContent = 'No headings yet'
    panel.appendChild(empty)
    return
  }
  const list = document.createElement('div')
  list.className = 'outline-list'
  heads.forEach((h) => {
    const item = document.createElement('a')
    item.className = 'outline-item ' + h.tagName.toLowerCase()
    item.textContent = (h.textContent || '').trim() || 'Untitled'
    item.href = '#'
    item.addEventListener('click', (e) => {
      e.preventDefault()
      h.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
    list.appendChild(item)
  })
  panel.appendChild(list)
}

function scheduleOutline() {
  if (!outlineVisible) return
  clearTimeout(outlineTimer)
  outlineTimer = setTimeout(buildOutline, 150)
}

// Set outline visibility explicitly (the native host is the source of truth so
// the View-menu checkmark stays in sync).
function setOutline(visible) {
  outlineVisible = !!visible
  document.body.classList.toggle('outline-open', outlineVisible)
  hideBlockHandle()
  if (outlineVisible) buildOutline()
}

// Toggle and report the new state back to the caller.
function toggleOutline() {
  setOutline(!outlineVisible)
  return outlineVisible
}

// --- Image source editing ---------------------------------------------------
// Find the document position of the image node whose DOM contains `el`. Robust
// against zero-size broken images (unlike coordinate hit-testing).
function imageNodePos(el) {
  if (!view) return null
  let found = null
  view.state.doc.descendants((node, pos) => {
    if (found != null) return false
    if (node.type.name === 'image' || node.type.name === 'image-block') {
      const dom = view.nodeDOM(pos)
      if (dom && (dom === el || (dom.contains && dom.contains(el)))) {
        found = pos
        return false
      }
    }
    return true
  })
  return found
}

// Called by the native host with a new source (URL or file path) for the image
// the user double-clicked. An empty/undefined value leaves the image unchanged.
function setImageSrc(newSrc) {
  if (!view || pendingImagePos == null) return
  const pos = pendingImagePos
  pendingImagePos = null
  if (typeof newSrc !== 'string' || !newSrc) return
  const node = view.state.doc.nodeAt(pos)
  if (!node) return
  view.dispatch(
    view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: newSrc })
  )
}

// Insert one or more images (data URLs / paths) at a drop point (or the cursor).
// Called by the native host after a file drag-and-drop, and by the web-image
// paste handler.
function insertImages(srcs, x, y) {
  if (!view) return
  let pos = null
  if (typeof x === 'number' && typeof y === 'number') {
    const at = view.posAtCoords({ left: x, top: y })
    if (at) pos = at.pos
  }
  insertImagesAt(srcs, pos)
}

window.MW = { open, getMarkdown, markSaved, setOutline, toggleOutline, setImageSrc, insertImages }

// Double-click an image to change the file/URL it points to (handy for fixing
// broken paths). The native host presents the picker and replies via setImageSrc.
document.addEventListener('dblclick', (e) => {
  if (!view) return
  // Match the image itself or its node-view container (a real click can land on
  // the selection overlay/padding, not the <img>).
  const el = e.target.closest &&
    e.target.closest('img, .milkdown-image-block, .milkdown-image-inline')
  let pos = el ? imageNodePos(el) : null
  // Fall back to hit-testing the click coordinates.
  if (pos == null) {
    const at = view.posAtCoords({ left: e.clientX, top: e.clientY })
    if (at && at.inside >= 0) {
      const n = view.state.doc.nodeAt(at.inside)
      if (n && (n.type.name === 'image' || n.type.name === 'image-block')) pos = at.inside
    }
  }
  if (pos == null) return
  const node = view.state.doc.nodeAt(pos)
  if (!node) return
  e.preventDefault()
  e.stopPropagation()
  pendingImagePos = pos
  post({ type: 'editImage', src: node.attrs.src || '' })
}, true)

// Cmd/Ctrl-click a link to open it in the default browser (plain click still
// places the cursor for editing). The native host performs the actual open.
document.addEventListener('click', (e) => {
  if (!(e.metaKey || e.ctrlKey)) return
  const a = e.target.closest && e.target.closest('a[href]')
  if (!a) return
  const href = a.getAttribute('href')
  if (!href) return
  e.preventDefault()
  e.stopPropagation()
  post({ type: 'openLink', href })
}, true)

// Hide the block handle while scrolling so it doesn't lag behind the content.
document.getElementById('app')?.addEventListener('scroll', hideBlockHandle, { passive: true })

// Tell the host we're loaded and ready to receive a document.
post({ type: 'ready' })
// Start with an empty doc so the editor is visible even with no file.
open('')
