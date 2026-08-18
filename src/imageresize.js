// Drag-resize for images, persisted portably.
//
// Crepe ships a resize handle, but it drags height only and remembers the
// result as a ratio of "how tall the image happened to render in this window",
// stored in the markdown alt text (see src/imageblock.js for why that was
// blocked). This module replaces it with a corner handle that drags width with
// the aspect ratio locked, and persists the result as an absolute pixel width:
//
//     <img src="images/x.png" alt="a diagram" width="400" />
//
// — the one spelling GitHub, Typora and Pandoc all render. An image at its
// natural size keeps the plain `![alt](src)` form; only a resized one becomes
// an <img> tag, and double-clicking the handle returns it to natural size.
//
// Three pieces close the loop, mirroring src/supsub.js:
//   - a remark transformer parses standalone `<img …>` HTML back into
//     image-block nodes (the serializer half lives in src/imageblock.js,
//     which owns the node's markdown round-trip);
//   - a ProseMirror plugin mirrors each node's width attr onto its <img> as a
//     CSS variable, since Crepe's Vue viewer knows nothing of the attr;
//   - the same plugin injects the corner handle and commits the drag as a
//     single setNodeAttribute transaction, so a resize is one undo step.
import { $prose, $remark } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'

// --- markdown -> mdast ------------------------------------------------------

/// If `value` is exactly one `<img …>` tag (and nothing else), the mdast
/// image-block node it should become; otherwise null and the HTML is left
/// exactly as it was.
function imageBlockFromHtml(value) {
  const text = String(value ?? '').trim()
  if (!/^<img[\s/>]/i.test(text)) return null
  const body = new DOMParser().parseFromString(text, 'text/html').body
  if (body.children.length !== 1 || body.children[0].tagName !== 'IMG') return null
  if ((body.textContent ?? '').trim()) return null
  const img = body.children[0]
  const width = Number.parseInt(img.getAttribute('width') ?? '', 10)
  return {
    type: 'image-block',
    url: img.getAttribute('src') ?? '',
    alt: img.getAttribute('alt') ?? '',
    title: img.getAttribute('title') ?? '',
    width: Number.isFinite(width) && width > 0 ? width : 0,
  }
}

/// A standalone tag parses as a block `html` node; one that ended up inside a
/// paragraph (with nothing beside it) is an inline `html` node. Both become
/// image blocks; anything else is untouched.
function convert(node) {
  if (!Array.isArray(node.children)) return
  node.children = node.children.map((child) => {
    if (child.type === 'html') {
      const block = imageBlockFromHtml(child.value)
      if (block) return block
    }
    if (child.type === 'paragraph' && child.children?.length === 1) {
      const only = child.children[0]
      if (only.type === 'html') {
        const block = imageBlockFromHtml(only.value)
        if (block) return block
      }
    }
    convert(child)
    return child
  })
}

export const remarkImageWidth = $remark('mwImageWidth', () => () => (tree) => {
  convert(tree)
  return tree
})

// --- width attr -> DOM, and the drag itself ---------------------------------

const MIN_WIDTH = 60

function imageOf(view, pos) {
  const dom = view.nodeDOM(pos)
  return dom?.querySelector?.('.image-wrapper img') ?? null
}

function applyWidth(img, width) {
  const wrapper = img.closest('.image-wrapper')
  if (width > 0) {
    img.style.setProperty('--mw-img-w', `${Math.round(width)}px`)
    img.setAttribute('data-mw-width', String(Math.round(width)))
    // A sized image may be wider than the text column. The wrapper is
    // fit-content with `margin: 0 auto`, which stops centring the moment the
    // content overflows, so centre it explicitly: 50% of the column minus
    // half the image. Comes out identical to auto margins when it fits, and
    // symmetric overflow into both margins when it doesn't.
    if (wrapper) wrapper.style.marginLeft = `calc(50% - ${Math.round(width / 2)}px)`
  } else {
    img.style.removeProperty('--mw-img-w')
    img.removeAttribute('data-mw-width')
    if (wrapper) wrapper.style.removeProperty('margin-left')
  }
}

/// Position of the image-block whose rendered <img> is `img`, or null. Looked
/// up at commit time rather than captured at pointerdown, in case the document
/// changed underneath the drag.
function posOfImage(view, img) {
  let found = null
  view.state.doc.descendants((node, pos) => {
    if (found != null || node.type.name !== 'image-block') return
    const dom = view.nodeDOM(pos)
    if (dom && dom.contains(img)) found = pos
  })
  return found
}

function commitWidth(view, img, width) {
  const pos = posOfImage(view, img)
  if (pos == null) return
  const node = view.state.doc.nodeAt(pos)
  const value = width > 0 ? Math.round(width) : 0
  if (!node || node.attrs.width === value) return
  view.dispatch(view.state.tr.setNodeAttribute(pos, 'width', value))
}

function startDrag(view, handle, img, event) {
  event.preventDefault()
  event.stopPropagation()
  const startX = event.clientX
  const startWidth = img.getBoundingClientRect().width
  // The ceiling is the image's own resolution — past that it only blurs — but
  // never less than the text column, so a small image can still be pulled out
  // to fill it. Growing past the column overflows it, centred (see
  // applyWidth); the window scrolls sideways if the user goes past its edge.
  const block = img.closest('.milkdown-image-block')
  const columnWidth = block ? block.getBoundingClientRect().width : Infinity
  const maxWidth = Math.max(columnWidth, img.naturalWidth || 0)
  handle.classList.add('dragging')
  try { handle.setPointerCapture(event.pointerId) } catch (e) { /* synthetic event */ }

  let width = startWidth
  const move = (e) => {
    width = Math.min(maxWidth, Math.max(MIN_WIDTH, startWidth + (e.clientX - startX)))
    applyWidth(img, width)
  }
  const up = () => {
    handle.classList.remove('dragging')
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', up)
    handle.removeEventListener('pointercancel', up)
    commitWidth(view, img, width)
  }
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', up)
  handle.addEventListener('pointercancel', up)
}

/// Give `wrapper` a corner handle if it doesn't have one. Crepe's Vue viewer
/// re-renders the wrapper's contents on its own schedule and can throw an
/// injected handle away, so this runs both from the plugin's update pass and
/// from a mouseover delegate — whichever notices the loss first heals it.
function ensureHandle(view, wrapper) {
  if (wrapper.querySelector(':scope > .mw-image-resize')) return
  const img = wrapper.querySelector('img')
  if (!img) return
  const handle = document.createElement('div')
  handle.className = 'mw-image-resize'
  handle.title = 'Drag to resize — double-click for original size'
  handle.addEventListener('pointerdown', (e) => startDrag(view, handle, img, e))
  handle.addEventListener('dblclick', (e) => {
    e.preventDefault()
    e.stopPropagation()
    applyWidth(img, 0)
    commitWidth(view, img, 0)
  })
  wrapper.appendChild(handle)
}

function sync(view) {
  view.state.doc.descendants((node, pos) => {
    if (node.type.name !== 'image-block') return
    const img = imageOf(view, pos)
    if (!img) return
    applyWidth(img, node.attrs.width ?? 0)
    const wrapper = img.closest('.image-wrapper')
    if (wrapper) ensureHandle(view, wrapper)
  })
}

export const imageResizePlugin = $prose(() => {
  return new Plugin({
    key: new PluginKey('mwImageResize'),
    view: (view) => {
      const heal = (e) => {
        const wrapper = e.target?.closest?.('.milkdown-image-block .image-wrapper')
        if (wrapper) ensureHandle(view, wrapper)
      }
      view.dom.addEventListener('mouseover', heal)
      sync(view)
      return {
        update: () => sync(view),
        destroy: () => view.dom.removeEventListener('mouseover', heal),
      }
    },
  })
})

export const imageResizePlugins = [remarkImageWidth, imageResizePlugin].flat()
