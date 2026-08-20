// Markwise editor — wraps Milkdown Crepe (Typora-style WYSIWYG) and exposes a
// tiny bridge for the native Swift host to drive open/save.
import { Crepe } from '@milkdown/crepe'
import '@milkdown/crepe/theme/common/style.css'
import '@milkdown/crepe/theme/frame.css'
import { $inputRule } from '@milkdown/kit/utils'
import { InputRule } from '@milkdown/kit/prose/inputrules'
import { linkSchema } from '@milkdown/kit/preset/commonmark'
import { editorViewCtx, remarkStringifyOptionsCtx, parserCtx, serializerCtx } from '@milkdown/kit/core'
import { uploadConfig } from '@milkdown/kit/plugin/upload'
import { blockConfig } from '@milkdown/kit/plugin/block'
import { toggleMark } from '@milkdown/kit/prose/commands'
import { TextSelection } from '@milkdown/kit/prose/state'
import { codeMirrorTheme, codeLanguages } from './codeblock.js'
import { mathPlugins, MATH_INLINE } from './latex.js'
import { supSubPlugins, supSubStringifyHandlers } from './supsub.js'
import { patchImageBlock } from './imageblock.js'
import { imageResizePlugins } from './imageresize.js'

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
      const block = schema.nodes['image-block'].createAndFill({ src, alt, caption: title || '' })
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

// --- Request/response over the bridge ---------------------------------------
// postMessage is one-way, so requests that need an answer (saving an image and
// getting its path back) carry an id the host echoes to `nativeReply`.
let requestSeq = 0
const pendingRequests = new Map()

function requestNative(type, payload) {
  if (!window.webkit?.messageHandlers?.bridge) return Promise.resolve(null)
  const id = ++requestSeq
  return new Promise((resolve) => {
    pendingRequests.set(id, resolve)
    // Don't hang the paste forever if the host never answers.
    setTimeout(() => {
      if (pendingRequests.delete(id)) resolve(null)
    }, 20000)
    post({ type, id, ...payload })
  })
}

function nativeReply(id, value) {
  const resolve = pendingRequests.get(id)
  if (!resolve) return
  pendingRequests.delete(id)
  resolve(value ?? null)
}

// Ask the host to write an image next to the document and hand back a path
// relative to it. Returns null when there's nowhere to put it (an unsaved
// document) or the write failed, in which case callers keep what they had.
function saveImageBeside({ data, url, name }) {
  return requestNative('saveImage', { data, url, name })
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

// Pasting a URL onto selected text turns the selection into a link (the way
// Google Docs, Notion and GitHub behave) instead of replacing the words with
// the bare address. Only a lone URL triggers this; pasting prose that happens
// to contain a link, or pasting with nothing selected, behaves as before.
// Capture phase, like the image paste above: Crepe has its own URL-paste
// handling that would otherwise swallow the event first.
document.addEventListener('paste', (e) => {
  if (!view) return
  const text = e.clipboardData?.getData('text/plain')?.trim() ?? ''
  if (!/^(https?:\/\/|www\.)\S+$/i.test(text)) return
  const { selection } = view.state
  if (selection.empty || !(selection instanceof TextSelection)) return
  // Inside a code block the paste should stay literal.
  if (selection.$from.parent.type.spec.code) return
  const linkType = view.state.schema.marks.link
  if (!linkType) return
  e.preventDefault()
  e.stopPropagation()
  const href = /^www\./i.test(text) ? `https://${text}` : text
  view.dispatch(view.state.tr.addMark(selection.from, selection.to, linkType.create({ href })))
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

// Point relative URLs (image `src`s, mostly) at the directory holding the file
// being edited, instead of at the app bundle's own web/ folder. Rendering is
// resolved through <base>, so the markdown keeps the relative path it came with
// rather than being rewritten to an absolute one on save.
function setBaseURL(href) {
  let base = document.getElementById('mw-base')
  if (!base) {
    base = document.createElement('base')
    base.id = 'mw-base'
    document.head.appendChild(base)
  }
  // An empty href would resolve against the page itself; drop the element.
  if (href) base.href = href
  else base.remove()
}

// Open (or replace) the document with the given markdown text. `baseHref` is
// the directory of the file it came from, if any.
//
// Calls are queued: building an editor is asynchronous, and two overlapping
// opens would race over `crepe`/`view` and could leave the visible editor and
// the one we hold references to being different objects.
let openQueue = Promise.resolve()
function open(markdown, baseHref) {
  openQueue = openQueue.then(() => openNow(markdown, baseHref)).catch(() => {})
  return openQueue
}

async function openNow(markdown, baseHref) {
  const root = document.getElementById('app')
  if (baseHref !== undefined) setBaseURL(baseHref)
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
  // Inline-equation editing, adjacent-equation merging (see src/latex.js).
  mathPlugins({ isLoading: () => loading }).forEach((p) => crepe.editor.use(p))
  // <sup>/<sub> marks (see src/supsub.js).
  crepe.editor.use(supSubPlugins)
  crepe.editor.config((ctx) => {
    ctx.update(remarkStringifyOptionsCtx, (prev) => ({
      ...prev,
      handlers: { ...(prev?.handlers ?? {}), ...supSubStringifyHandlers },
    }))
  })
  // Typing `![alt](src)` doesn't create an image by default (commonmark ships an
  // image input rule but doesn't register it). Use our own, which prefers a
  // block image (caption + resize) for a standalone image.
  crepe.editor.use(imageInputRule)
  // Drag-and-drop or paste image files -> embed as data: URLs so they survive a
  // save (web images copied with HTML still paste as their URL via ProseMirror).
  // The block (+/drag) handle hit-tests at the horizontal centre of the editor,
  // so an inline node sitting under that line — typically an equation — wins
  // over the paragraph and the handle jumps to it. Only ever anchor to blocks.
  // Stop image alt text being overwritten with the aspect ratio.
  crepe.editor.config(patchImageBlock)
  // Corner-drag image resizing, persisted as `<img … width="N">` (see
  // src/imageresize.js).
  crepe.editor.use(imageResizePlugins)
  crepe.editor.config((ctx) => {
    ctx.update(blockConfig.key, (prev) => ({
      ...prev,
      filterNodes: ($pos, node) => {
        if (node?.type.isInline) return false
        return prev.filterNodes ? prev.filterNodes($pos, node) : true
      },
    }))
  })
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
            const data = await fileToDataURL(file)
            // Prefer a file on disk beside the document; fall back to embedding.
            const src = (await saveImageBeside({ data, name: file.name })) || data
            const node = type.createAndFill({ src, alt: '' })
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
      // Crepe marks inline equations draggable, which makes WebKit begin a drag
      // instead of a text selection when you drag across one. Dragging a lone
      // equation is far rarer than selecting a sentence containing it.
      const math = view.state.schema.nodes[MATH_INLINE]
      if (math) math.spec.draggable = false
    } catch (e) { /* view not ready — ignore */ }
  })
  // Focus the moment the editor exists, not after the settle below: animation
  // frames don't run on a schedule you can rely on while the window is still
  // being put on screen, and waiting for them left the document visible but
  // unfocused for as much as several seconds — it looks ready, but typing goes
  // nowhere.
  try { view && view.focus() } catch (e) { /* noop */ }

  baseline = crepe.getMarkdown()
  // Let async setup transactions (e.g. code-block features) settle, folding
  // them into the baseline, before we start reporting user edits. Callers await
  // this, so anything they post afterwards lands after the "clean" below.
  await settled()
  baseline = crepe.getMarkdown()
  loading = false
  post({ type: 'opened' })
  post({ type: 'clean' })
  scheduleOutline()
  // If source view is open (e.g. a file was opened, or reloaded from disk,
  // while showing it), show the new document's markdown rather than the old.
  if (sourceVisible && sourceEl) {
    sourceOpenText = baseline
    sourceEl.value = baseline
  }
  try { view && view.focus() } catch (e) { /* noop */ }
}

/// Wait for the editor's own setup transactions to land — two animation frames
/// normally, but a timer wins if frames aren't being served, which is the case
/// while a window is still coming up. Waiting on frames alone stalled opening a
/// document for seconds.
function settled(fallbackMs = 120) {
  return new Promise((resolve) => {
    let done = false
    const finish = () => {
      if (done) return
      done = true
      resolve()
    }
    requestAnimationFrame(() => requestAnimationFrame(finish))
    setTimeout(finish, fallbackMs)
  })
}

// Return the current document as markdown (called synchronously by the host on
// save). In source view the textarea is the document, so ⌘S saves what's shown.
function getMarkdown() {
  if (sourceVisible) return sourceEl ? sourceEl.value : ''
  return crepe ? crepe.getMarkdown() : ''
}

// Called by the host after a successful save: the current content is now clean.
function markSaved() {
  if (crepe) baseline = crepe.getMarkdown()
}

// --- Text size --------------------------------------------------------------
// This is a *text* size, not a magnifier, so it drives font-size (see the
// calc() overrides in index.html), never CSS `zoom`. Zoom scaled the whole
// layout: images grew with the text, anything sized relative to the scaled
// column changed width, and WebKit drew the caret at the unzoomed coordinates
// after the factor changed. Font-size leaves layout, images and the caret
// alone; Crepe hard-codes its type scale in px, so index.html restates those
// px values multiplied by this property. It's applied as a custom property
// rather than an inline style so it survives the editor being rebuilt on
// every open.
function setTextScale(percent) {
  const pct = Math.min(300, Math.max(50, Math.round(Number(percent) || 100)))
  document.documentElement.style.setProperty('--mw-scale', String(pct / 100))
  return pct
}

// --- Font ---------------------------------------------------------------
// View ▸ Font. The chosen family lands in `--mw-font`, which index.html feeds
// into both of Crepe's faces (body and headings); empty restores the theme's
// own stacks. An inline custom property survives editor rebuilds and rides
// into the PDF export unchanged, so print uses the same face as the screen.
// `-apple-system` is passed through unquoted: macOS hides its system fonts
// from web content by family name, and only the keyword reaches San Francisco.
function setFontFamily(family) {
  const name = String(family ?? '').trim()
  const root = document.documentElement
  if (!name) {
    root.style.removeProperty('--mw-font')
    return
  }
  const css = name === '-apple-system'
    ? '-apple-system, sans-serif'
    : `'${name.replace(/['"\\]/g, '')}', sans-serif`
  root.style.setProperty('--mw-font', css)
}

// --- PDF export -------------------------------------------------------------
// Native hosts generate the PDF, while the shared renderer owns the temporary
// printable state. This keeps both platforms visually consistent and ensures
// raw source edits are rendered before capture.
let pdfExportState = null

function waitWithTimeout(promise, timeoutMs) {
  return Promise.race([
    Promise.resolve(promise).catch(() => null),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ])
}

async function waitForPdfImages(timeoutMs = 10000) {
  const images = [...document.querySelectorAll('.milkdown .editor img')]
    .filter((img) => Boolean(img.getAttribute('src') || img.currentSrc))
  const pending = images.map((img) => {
    if (img.complete) return Promise.resolve()
    return new Promise((resolve) => {
      img.addEventListener('load', resolve, { once: true })
      img.addEventListener('error', resolve, { once: true })
    })
  })
  await waitWithTimeout(Promise.all(pending), timeoutMs)
  return images
    .filter((img) => !img.complete || img.naturalWidth === 0)
    .map((img) => img.currentSrc || img.getAttribute('src') || '(unknown image)')
}

async function preparePdfExport(options) {
  if (pdfExportState) return { ok: false, busy: true, missingImages: [] }

  const appScroller = document.getElementById('app')
  const active = document.activeElement
  const state = {
    sourceWasVisible: sourceVisible,
    appScrollTop: appScroller?.scrollTop || 0,
    sourceScrollTop: sourceEl?.scrollTop || 0,
    sourceSelectionStart: sourceEl?.selectionStart || 0,
    sourceSelectionEnd: sourceEl?.selectionEnd || 0,
    editorHadFocus: Boolean(active && active.closest && active.closest('.milkdown')),
  }
  pdfExportState = state

  if (sourceVisible) await setSource(false)
  // The export's Scale option is a typography scale, not a magnifier: 50%
  // means half-size text that re-wraps to fill the full printable width, so
  // more words fit per line — not the 100% layout photocopied smaller (which
  // is what NSPrintInfo.scalingFactor does, so the native side leaves that
  // at 1). Applied through the same font-size mechanism as the on-screen
  // text size; mw-pdf-export swaps `--mw-scale` for this print value.
  const textScale = Math.min(2, Math.max(0.25, Number(options?.textScale) || 1))
  document.documentElement.style.setProperty('--mw-print-scale', String(textScale))
  document.documentElement.classList.add('mw-pdf-export')
  try { document.activeElement?.blur() } catch (e) { /* noop */ }
  hideBlockHandle()
  await settled(200)
  if (document.fonts?.ready) await waitWithTimeout(document.fonts.ready, 10000)
  const missingImages = await waitForPdfImages()
  await settled(200)
  return { ok: missingImages.length === 0, busy: false, missingImages }
}

async function finishPdfExport() {
  const state = pdfExportState
  if (!state) return
  pdfExportState = null
  document.documentElement.classList.remove('mw-pdf-export')
  document.documentElement.style.removeProperty('--mw-print-scale')

  if (state.sourceWasVisible) {
    await setSource(true)
    if (sourceEl) {
      sourceEl.scrollTop = state.sourceScrollTop
      sourceEl.setSelectionRange(state.sourceSelectionStart, state.sourceSelectionEnd)
    }
    return
  }

  const appScroller = document.getElementById('app')
  if (appScroller) appScroller.scrollTop = state.appScrollTop
  if (state.editorHadFocus) {
    try { view && view.focus() } catch (e) { /* noop */ }
  }
}

// --- Merging ----------------------------------------------------------------
// Round markdown through the parser and serializer without disturbing the open
// document. Used before a three-way merge: the editor rewrites markdown into its
// own dialect (list markers, wrapping), so comparing raw file text against
// editor output would report those rewrites as edits and manufacture conflicts
// that the user never made. Normalising every side first leaves only real edits.
function normalize(text) {
  if (!crepe || typeof text !== 'string') return text ?? ''
  try {
    return crepe.editor.action((ctx) => {
      const parser = ctx.get(parserCtx)
      const serializer = ctx.get(serializerCtx)
      const doc = parser(text)
      return doc ? serializer(doc) : text
    })
  } catch (e) {
    return text
  }
}

/// The three sides a three-way merge needs, all in the same dialect:
/// the document as it was opened, the document now, and the file on disk.
function mergeInputs(baseText, diskText) {
  return { base: normalize(baseText), mine: getMarkdown(), theirs: normalize(diskText) }
}

// --- Spell checking ---------------------------------------------------------
// WebKit only spell-checks the block the caret is in (or text it has watched
// being edited), so a freshly opened document carries no marks until you visit
// each paragraph yourself. There's no API to check a document outright, but
// moving the caret through a block provokes the same per-block check.
//
// Only the blocks on screen are primed, and only once things have settled.
// Priming the whole document meant one caret move per animation frame for every
// block in the file — four seconds of them on a 240-block document — each one
// putting the scroll position back where it started, which reads as the window
// refusing to scroll for the first few seconds after opening.
const primedBlocks = new WeakSet()
let primeTimer = null
let primeRunning = false
let primeInterrupted = false

// Any sign of the reader doing something stops the walk: their caret and their
// scroll position win over a background nicety. The timestamp also tells a
// user's scroll apart from one the primer caused itself.
let lastUserInputAt = 0
// Where the caret was before the walk borrowed it, so a keystroke that arrives
// mid-walk can put it back first.
let primeOriginalPos = null

for (const type of ['wheel', 'keydown', 'mousedown', 'touchstart']) {
  document.addEventListener(type, (e) => {
    lastUserInputAt = Date.now()
    if (!primeRunning) return
    primeInterrupted = true
    // A keystroke would otherwise be typed wherever the walk had moved the
    // caret to. This listener runs before the editor handles the key, so
    // putting the caret back here means the character lands where the reader
    // left it. (A click sets its own position, so it needs no help.)
    if (e.type === 'keydown' && view && primeOriginalPos != null) {
      try {
        const at = Math.min(primeOriginalPos, view.state.doc.content.size)
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)))
      } catch (err) { /* document moved on — leave the selection be */ }
    }
  }, { capture: true, passive: true })
}

function schedulePrime(delay = 200) {
  clearTimeout(primeTimer)
  primeTimer = setTimeout(primeVisibleBlocks, delay)
}

function restoreScroll(scroller, value) {
  if (!scroller || scroller.scrollTop === value) return
  scroller.scrollTop = value
}

function primeVisibleBlocks() {
  if (!view || sourceVisible || primeRunning) return

  const scroller = document.getElementById('app')
  const viewportBottom = scroller ? scroller.clientHeight : window.innerHeight
  const targets = []
  view.state.doc.descendants((node, pos) => {
    // Never step into a code block: there's nothing to spell-check in code, and
    // moving the caret there hands focus to the embedded CodeMirror editor,
    // which then swallows shortcuts like ⌘/ that belong to the app.
    if (node.type.name === 'code_block' || node.type.spec.code) return false
    if (!node.isTextblock) return true
    if (node.textContent.trim() && !primedBlocks.has(node)) {
      const dom = view.nodeDOM(pos)
      const rect = dom && dom.getBoundingClientRect ? dom.getBoundingClientRect() : null
      if (rect && rect.bottom > 0 && rect.top < viewportBottom) targets.push({ pos, node })
    }
    return false // no need to walk inside a text block
  })
  if (!targets.length) return

  primeRunning = true
  primeInterrupted = false
  const original = view.state.selection
  primeOriginalPos = original.from
  const scrollTop = scroller ? scroller.scrollTop : 0
  let i = 0

  const finish = () => {
    primeRunning = false
    primeOriginalPos = null
    if (primeInterrupted || !view) return // the reader took over; leave them be
    try {
      const at = Math.min(original.from, view.state.doc.content.size)
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)))
    } catch (e) { /* document moved on — leave the selection be */ }
    // Putting the caret back reveals it, which scrolls the view to wherever it
    // was — the top, for a freshly opened document. Undo that.
    restoreScroll(scroller, scrollTop)
  }

  const step = () => {
    if (primeInterrupted || !view || i >= targets.length) return finish()
    const target = targets[i++]
    try {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, target.pos + 1)))
      primedBlocks.add(target.node)
    } catch (e) { /* position no longer resolves — skip it */ }
    // The targets are already on screen, so this is normally a no-op; it only
    // catches a block that was partly below the fold.
    if (!primeInterrupted) restoreScroll(scroller, scrollTop)
    requestAnimationFrame(step)
  }
  requestAnimationFrame(step)
}

/// Called by the host once a document has finished loading.
function primeSpellCheck() {
  schedulePrime(150)
}

// Check whatever the reader scrolls into view, once scrolling stops. Only a
// scroll the reader actually drove counts: the primer's own scroll corrections
// raise scroll events too, and acting on those would loop — correct, scroll,
// prime, correct — walking the document on its own.
{
  const scroller = document.getElementById('app')
  if (scroller) {
    scroller.addEventListener('scroll', () => {
      if (Date.now() - lastUserInputAt > 1200) return
      schedulePrime(300)
    }, { passive: true })
  }
}

// --- Markdown source view ---------------------------------------------------
// A plain textarea over the rendered document, so you can see and edit the raw
// markdown. Toggled from the View menu (⌘/).
let sourceVisible = false
let sourceEl = null
// The markdown as it stood when source view opened, to spot real edits.
let sourceOpenText = ''

function ensureSourceEl() {
  if (sourceEl) return sourceEl
  sourceEl = document.getElementById('source')
  if (sourceEl) {
    sourceEl.addEventListener('input', () => {
      post({ type: sourceEl.value === baseline ? 'clean' : 'dirty' })
    })
  }
  return sourceEl
}

async function setSource(visible) {
  const el = ensureSourceEl()
  if (!el || !!visible === sourceVisible) return sourceVisible

  if (visible) {
    sourceOpenText = getMarkdown()
    el.value = sourceOpenText
    sourceVisible = true
    document.body.classList.add('source-open')
    hideBlockHandle()
    el.focus()
    el.setSelectionRange(0, 0)
    return sourceVisible
  }

  const text = el.value
  sourceVisible = false
  document.body.classList.remove('source-open')
  if (text !== sourceOpenText) {
    // Rebuild the rendered document from the edited source, keeping the
    // unsaved-changes state that the edit implies.
    const dirty = text !== baseline
    await open(text)
    if (dirty) post({ type: 'dirty' })
  } else {
    try { view && view.focus() } catch (e) { /* noop */ }
  }
  return sourceVisible
}

// --- Inline formatting ------------------------------------------------------
// Toggle a mark by name over the selection (the native Format menu drives this
// for superscript/subscript).
function toggleTextMark(name) {
  if (!view) return false
  const type = view.state.schema.marks[name]
  if (!type) return false
  const applied = toggleMark(type)(view.state, view.dispatch)
  view.focus()
  return applied
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

// Copy an image that came from elsewhere — a web page, or an embedded blob —
// to a file beside the document, so the markdown ends up with a relative path
// instead of a network dependency or a base64 blob. Anything already local, or
// that can't be saved, is passed through untouched.
async function localizeImageSrc(src) {
  if (typeof src !== 'string' || !src) return src
  if (/^https?:/i.test(src)) return (await saveImageBeside({ url: src })) || src
  if (/^data:image\//i.test(src)) return (await saveImageBeside({ data: src })) || src
  return src
}

// Insert one or more images (URLs / data URLs / paths) at a drop point (or the
// cursor). Called by the native host after a file drag-and-drop, and by the
// web-image paste handler.
async function insertImages(srcs, x, y) {
  if (!view) return
  let pos = null
  if (typeof x === 'number' && typeof y === 'number') {
    const at = view.posAtCoords({ left: x, top: y })
    if (at) pos = at.pos
  }
  const localized = await Promise.all((srcs || []).map(localizeImageSrc))
  insertImagesAt(localized, pos)
}

window.MW = {
  open, getMarkdown, markSaved, setOutline, toggleOutline, setImageSrc, insertImages,
  toggleMark: toggleTextMark,
  setSource, setBaseURL, primeSpellCheck, nativeReply, mergeInputs, setTextScale,
  setFontFamily,
  preparePdfExport, finishPdfExport,
  // Test hook: lets the offscreen-WKWebView harness drive the document model
  // directly. Not used by the app itself.
  __view: () => view,
}

// Tell the native host which image (if any) a right-click landed on, so it
// can offer "Copy Text from Image" in the context menu. The message races the
// menu opening, but the click that picks a menu item comes long after this
// has landed.
document.addEventListener('contextmenu', (e) => {
  const img = e.target.closest && e.target.closest('img')
  post({ type: 'contextImage', src: img ? img.currentSrc || img.src || '' : '' })
})

// Double-click an image to change the file/URL it points to (handy for fixing
// broken paths). The native host presents the picker and replies via setImageSrc.
document.addEventListener('dblclick', (e) => {
  if (!view) return
  // Double-clicking a link opens it, the way ⌘-click does. (Single click still
  // just places the cursor, so the link text stays editable.)
  const link = e.target.closest && e.target.closest('a[href]')
  if (link) {
    const href = link.getAttribute('href')
    if (href) {
      e.preventDefault()
      e.stopPropagation()
      post({ type: 'openLink', href })
      return
    }
  }
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
// Only build an empty editor when nothing is on its way. The host sets this
// flag before the page loads if the window was opened for a file: otherwise we
// would build an editor here and immediately tear it down when the file arrived
// a moment later, which wastes the work and leaves focus pointing at a
// destroyed view — the window looks ready while typing goes nowhere.
if (!window.MW_PENDING_DOC) open('')
