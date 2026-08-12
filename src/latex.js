// Inline-LaTeX behaviour on top of Crepe's math feature.
//
// Crepe renders `$x$` as an atom `math_inline` node, but three things about it
// are wrong for a writing app:
//
//  1. Its own "edit this equation" tooltip is broken upstream (7.21.2): the Vue
//     render function never dereferences `innerView.value`, so the ref callback
//     that would mount the editable field never re-fires and the popup shows a
//     confirm button next to an empty box. We hide it and supply our own.
//  2. Deleting the space between two equations leaves them adjacent, which
//     doesn't round-trip through markdown (`$a$$b$` is not two equations), so
//     adjacent equations are merged into one.
//  3. The node is `draggable`, which makes WebKit start a drag instead of a
//     text selection whenever a drag begins on top of an equation.
import katex from 'katex'
import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'

export const MATH_INLINE = 'math_inline'

// --- Merge adjacent equations ----------------------------------------------
// Runs as a normalization step rather than a Backspace keybinding so it applies
// however the equations ended up side by side (delete, paste, drag, undo) and
// doesn't depend on winning a keymap precedence fight with the base keymap.
function mergeAdjacent(state) {
  const type = state.schema.nodes[MATH_INLINE]
  if (!type) return null

  let pair = null
  state.doc.descendants((node, pos, parent, index) => {
    if (pair) return false
    if (node.type === type && parent) {
      const next = parent.maybeChild(index + 1)
      if (next && next.type === type) {
        pair = { from: pos, to: pos + node.nodeSize + next.nodeSize, value: node.attrs.value + next.attrs.value }
        return false
      }
    }
    return true
  })
  if (!pair) return null

  const merged = type.create({ value: pair.value })
  const tr = state.tr.replaceWith(pair.from, pair.to, merged)
  // Only take over the cursor if it was inside the equations we just replaced;
  // a merge triggered elsewhere in the document shouldn't move the caret.
  const { from, to } = state.selection
  if (from >= pair.from && to <= pair.to) {
    tr.setSelection(TextSelection.create(tr.doc, pair.from + merged.nodeSize))
  }
  return tr
}

// --- Inline equation editor -------------------------------------------------
// A small floating field holding the raw LaTeX, with a live KaTeX preview.
// Opened by clicking an equation; commits on Enter or blur, cancels on Escape.
class MathInlineEditor {
  constructor(view) {
    this.view = view
    this.pos = null
    this.closing = false

    this.dom = document.createElement('div')
    this.dom.className = 'mw-math-edit'
    this.dom.dataset.show = 'false'

    this.input = document.createElement('input')
    this.input.type = 'text'
    this.input.spellcheck = false
    this.input.className = 'mw-math-input'
    this.input.setAttribute('aria-label', 'LaTeX source')

    this.preview = document.createElement('div')
    this.preview.className = 'mw-math-preview'

    this.dom.append(this.input, this.preview)
    document.body.appendChild(this.dom)

    this.input.addEventListener('input', () => this.renderPreview())
    this.input.addEventListener('blur', () => this.commit())
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        this.commit(true)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        this.cancel()
      }
    })
    // Keep clicks inside the popup from reaching the document (which would
    // move the selection and close us mid-edit).
    this.dom.addEventListener('mousedown', (e) => e.stopPropagation(), true)
  }

  open(pos, node) {
    this.pos = pos
    this.input.value = node.attrs.value ?? ''
    this.renderPreview()
    this.dom.dataset.show = 'true'
    this.reposition()
    this.input.focus({ preventScroll: true })
    this.input.select()
  }

  reposition() {
    if (this.pos == null) return
    const el = this.view.nodeDOM(this.pos)
    if (!el || !el.getBoundingClientRect) return
    const r = el.getBoundingClientRect()
    // Measure before clamping so the popup can't hang off the window edge.
    const w = this.dom.offsetWidth || 240
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8))
    this.dom.style.left = `${Math.round(left)}px`
    this.dom.style.top = `${Math.round(r.bottom + 6)}px`
  }

  renderPreview() {
    try {
      katex.render(this.input.value, this.preview, { throwOnError: false, displayMode: false })
    } catch (e) {
      this.preview.textContent = this.input.value
    }
  }

  /// Write the field back to the document. `refocus` returns the caret to the
  /// text after the equation (used for Enter, not for click-away).
  commit(refocus = false) {
    if (this.pos == null || this.closing) return
    const pos = this.pos
    const value = this.input.value.trim()
    this.hide()

    const node = this.view.state.doc.nodeAt(pos)
    if (!node || node.type.name !== MATH_INLINE) return

    let tr = null
    if (!value) {
      // Emptying the field removes the equation rather than leaving a blank one.
      tr = this.view.state.tr.delete(pos, pos + node.nodeSize)
    } else if (node.attrs.value !== value) {
      tr = this.view.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, value })
    }
    if (refocus) {
      const target = tr ?? this.view.state.tr
      const at = value ? pos + 1 : pos
      target.setSelection(TextSelection.create(target.doc, Math.min(at, target.doc.content.size)))
      tr = target
    }
    if (tr) this.view.dispatch(tr)
    if (refocus) this.view.focus()
  }

  cancel() {
    this.hide()
    this.view.focus()
  }

  hide() {
    this.closing = true
    this.pos = null
    this.dom.dataset.show = 'false'
    this.closing = false
  }

  update(view) {
    if (this.pos == null) return
    // Close if the node we were editing is gone or no longer selected.
    const node = view.state.doc.nodeAt(this.pos)
    if (!node || node.type.name !== MATH_INLINE) {
      this.hide()
      return
    }
    this.reposition()
  }

  destroy() {
    this.dom.remove()
  }
}

/// All Markwise-side inline-LaTeX plugins. `isLoading` lets the merge pass sit
/// out document loads, so opening a file never rewrites its content.
export function mathPlugins({ isLoading }) {
  let editor = null

  const merge = $prose(
    () =>
      new Plugin({
        key: new PluginKey('MW_mathMerge'),
        appendTransaction: (trs, _oldState, newState) => {
          if (isLoading() || !trs.some((tr) => tr.docChanged)) return null
          return mergeAdjacent(newState)
        },
      })
  )

  const edit = $prose(
    () =>
      new Plugin({
        key: new PluginKey('MW_mathEdit'),
        view: (view) => {
          editor = new MathInlineEditor(view)
          return editor
        },
        props: {
          // Only a pointer click opens the field. Selecting an equation by
          // arrowing over it shouldn't yank focus out of the document.
          handleClickOn: (view, _pos, node, nodePos) => {
            if (node.type.name !== MATH_INLINE || !editor) return false
            editor.open(nodePos, node)
            return true
          },
        },
      })
  )

  return [merge, edit]
}
