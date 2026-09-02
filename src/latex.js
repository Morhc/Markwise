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
import { $prose, $remark } from '@milkdown/kit/utils'
import { editorViewOptionsCtx, schemaCtx } from '@milkdown/kit/core'
import { DOMSerializer } from '@milkdown/kit/prose/model'
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'

export const MATH_INLINE = 'math_inline'

// --- Literal dollars ---------------------------------------------------------
// Markdown gives `$` two jobs, and `I paid $5 and $10` has a perfectly good
// reading as an equation whose body is "5 and ". The escape is the author's to
// write — `\$` is a literal dollar, here as everywhere else in markdown — and
// two things have to hold for that to be usable.
//
// The first is that typing the escape works. A WYSIWYG has nowhere to keep a
// backslash: the document holds the character it produces, and the serializer
// writes the escape back out (remark-stringify already escapes a bare `$` in
// text). So `\$` typed here resolves immediately to a plain `$`, and saving it
// spells it `\$` again.
//
// The second is that a literal dollar can't quietly capture a later one. It
// looks identical to a delimiter by then, so `$5 and $10 and $x$` would find
// its equation in the wrong pair. The one extra condition pandoc puts on
// inline maths settles it: the opening `$` is followed immediately by a
// non-space and the closing `$` preceded immediately by one. Nothing real is
// given up — trailing space inside an equation means nothing to LaTeX — and
// `$1$`, `$E = mc^2$`, `$^{44}$` and the rest are untouched.
function isInlineMath(value) {
  const content = String(value ?? '')
  return content.length > 0 && !/^\s/.test(content) && !/\s$/.test(content)
}

// --- Reading: demote the equations that rule rejects -------------------------
// remark-math has already made its own call by the time the tree arrives, so
// an opened file hands us `inlineMath` nodes that should have stayed text.
// Write them back as the characters they were, merged with the text around
// them so they serialize as one escaped run.
function demoteLiteralDollars(children) {
  const out = []
  for (const node of children) {
    if (Array.isArray(node.children)) node.children = demoteLiteralDollars(node.children)
    const literal =
      node.type === 'inlineMath' && !isInlineMath(node.value)
        ? { type: 'text', value: `$${node.value ?? ''}$` }
        : node
    const last = out[out.length - 1]
    if (literal.type === 'text' && last?.type === 'text') last.value += literal.value
    else out.push(literal)
  }
  return out
}

const remarkLiteralDollars = $remark('mwLiteralDollars', () => () => (tree) => {
  if (Array.isArray(tree.children)) tree.children = demoteLiteralDollars(tree.children)
  return tree
})

// --- Typing: the escape, whichever way it arrives -----------------------------
/// `\$` in the document text always means the escape, because the document
/// holds the characters a reader sees and a reader never sees an escape. Strip
/// the backslash wherever one turns up.
///
/// The keystroke guard below catches the common case a character at a time,
/// but text does not always arrive a character at a time: type quickly, dictate,
/// or let a text replacement expand and WebKit hands ProseMirror `\$` in one
/// change, with no lone `$` for `handleTextInput` to inspect. The backslash
/// then survives on screen and — worse — is itself escaped on the way out, so
/// the file ends up saying `\\$`. This pass runs on the finished document, so
/// how the characters got there stops mattering.
///
/// Inline code and code blocks are left alone: a backslash is literal there,
/// and so is a dollar. So is the rest of the document — only what this edit
/// touched is looked at, because a `\$` that came out of the parser is the two
/// characters an author wrote as `\\$`, and typing elsewhere must not eat it.
function stripDollarEscapes(oldState, newState) {
  const start = newState.doc.content.findDiffStart(oldState.doc.content)
  if (start == null) return null
  const ends = newState.doc.content.findDiffEnd(oldState.doc.content)
  // One character of slack each side: the backslash of a `\$` can predate the
  // dollar that completes it, and so sit just outside the change.
  const from = Math.max(0, start - 1)
  const to = Math.min(newState.doc.content.size, Math.max(ends?.a ?? start, start) + 1)

  const code = newState.schema.marks.code
  const positions = []
  newState.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.spec.code) return false
    if (!node.isText || (code && code.isInSet(node.marks))) return
    const text = node.text ?? ''
    for (let i = text.indexOf('\\$'); i >= 0; i = text.indexOf('\\$', i + 2)) {
      if (pos + i >= from - 1 && pos + i <= to) positions.push(pos + i)
    }
  })
  if (!positions.length) return null
  const tr = newState.tr
  // Back to front, so the earlier positions are still the positions.
  for (let i = positions.length - 1; i >= 0; i--) tr.delete(positions[i], positions[i] + 1)
  return tr
}

// --- Typing ------------------------------------------------------------------
/// Crepe's inline-math input rule fires on every `$` that closes a pair, and
/// knows about neither the escape nor the whitespace rule. It can't be
/// reconfigured or removed (the rule isn't exported), so head it off a step
/// earlier: `handleTextInput` set as a *view option* is consulted before any
/// plugin's — including the one running the input rules — so a `$` typed here,
/// reported as handled, is a `$` no rule ever sees.
export function mathInputGuard(ctx) {
  ctx.update(editorViewOptionsCtx, (prev) => ({
    ...prev,
    handleTextInput: (view, from, to, text) => {
      if (prev?.handleTextInput?.(view, from, to, text)) return true
      // Text does not always arrive a character at a time — type quickly,
      // dictate, or let a text replacement expand and several characters land
      // in one change — so this looks at whatever came in rather than at a
      // lone `$`.
      if (!text.includes('$')) return false
      const $from = view.state.doc.resolve(from)
      if (!$from.parent.isTextblock) return false
      // Atoms (an existing equation, an inline image) stand in as one
      // non-dollar character, so they can't be mistaken for an opening `$`.
      const before = view.state.doc.textBetween($from.start(), from, undefined, '￼')

      // An escape, either inside what is arriving or spanning the seam with
      // what is already there: resolve it to the dollar it was escaping. This
      // has to happen here rather than after the fact, because leaving the
      // backslash in place for even one transaction lets the input rule read
      // the escaped dollar as an equation's closing delimiter.
      const seam = before.endsWith('\\') && text.startsWith('$')
      if (seam || /\\\$/.test(text)) {
        const insert = text.replace(/\\\$/g, '$')
        view.dispatch(view.state.tr.insertText(insert, seam ? from - 1 : from, to))
        return true
      }

      // Nothing escaped. The input rule can only fire on an insertion ending
      // in a dollar, and only then is there a pair to judge.
      if (!text.endsWith('$')) return false
      const combined = before + text
      const open = combined.lastIndexOf('$', combined.length - 2)
      if (open >= 0 && isInlineMath(combined.slice(open + 1, combined.length - 1))) return false
      view.dispatch(view.state.tr.insertText(text, from, to))
      return true
    },
  }))
}

// --- The clipboard -----------------------------------------------------------
// An equation's on-screen DOM is a whole KaTeX rendering: a hidden MathML copy
// (which carries the LaTeX source in an <annotation>) beside a stack of styled
// spans that draw the glyphs. Handed to the clipboard as-is, that is what gets
// pasted — the same equation twice over, once as text and once as markup, e.g.
// `<span class="katex-mathml">26Al^{26}\mathrm{Al}</span><span class="mord
// mtight">26</span>…`.
//
// Two halves fix it. Going out, the clipboard gets its own serializer that
// renders an equation as one compact span: the marker Markwise parses back,
// with the LaTeX itself as the text so anything else receiving the paste sees
// `$^{26}\mathrm{Al}$`. Coming in, a KaTeX rendering from anywhere — an older
// Markwise copy, a web page — is reduced to that same span before ProseMirror
// parses it.

/// The LaTeX inside a KaTeX rendering, from the MathML copy KaTeX writes for
/// screen readers. `null` when this isn't a KaTeX rendering after all.
function latexOf(katexEl) {
  const annotation = katexEl.querySelector('annotation[encoding="application/x-tex"]')
  return annotation?.textContent?.trim() || null
}

function mathSpan(value) {
  const span = document.createElement('span')
  span.dataset.type = MATH_INLINE
  span.dataset.value = value
  span.textContent = `$${value}$`
  return span
}

/// Everything the clipboard needs, as one ProseMirror plugin: the schema is in
/// hand here, which `clipboardSerializer` needs and a view option can't reach.
function clipboardPlugin(ctx) {
  const schema = ctx.get(schemaCtx)
  const base = DOMSerializer.fromSchema(schema)
  const serializer = new DOMSerializer(
    { ...base.nodes, [MATH_INLINE]: (node) => mathSpan(node.attrs.value ?? '') },
    base.marks
  )
  return new Plugin({
    key: new PluginKey('MW_mathClipboard'),
    props: {
      clipboardSerializer: serializer,
      transformPastedHTML: (html) => {
        if (!html.includes('katex')) return html
        const doc = new DOMParser().parseFromString(html, 'text/html')
        for (const el of [...doc.querySelectorAll('.katex')]) {
          // A rendering Markwise itself copied is already inside the marker
          // span; replacing the wrapper takes the KaTeX markup with it.
          const target = el.closest(`[data-type="${MATH_INLINE}"]`) ?? el
          const value = latexOf(el) ?? target.getAttribute('data-value')
          if (!value) continue
          target.replaceWith(mathSpan(value))
        }
        return doc.body.innerHTML
      },
    },
  })
}

// --- Where a selection touching an equation starts ---------------------------
// ProseMirror expresses the document position immediately before an inline
// atom as a point *inside the text node before it* — `(text "A ", 2)`, the end
// of that node. That is a correct description of the place, and WebKit paints
// it wrong: a selection starting there is painted from the *start* of that
// text node, so selecting the equation in `A $^{26}\mathrm{Al}$ B` washes "A "
// as well. Measured: the text node occupies 635.0–649.2 and the equation
// 649.2–677.7, and the paint ran 635.0–677.0.
//
// The same place has another spelling — `(paragraph, indexOfTheEquation)` —
// which WebKit paints correctly. So after ProseMirror has written the
// selection to the DOM, the start is rewritten to that form. Nothing about
// the selection changes, only how its beginning is addressed.
//
// KNOWN UNFIXED: this rewrite works for a selection made by clicking, and not
// for one made with ⇧← / ⇧→ landing exactly on an equation — that still paints
// the preceding word, though the model and the clipboard are both right. The
// two cases end with byte-identical DOM ranges (`anchor P@1, focus P@2`,
// logged from a real keypress), so WebKit is simply not repainting the region
// for the keyboard one. Tried and measured, none of it moved the paint:
// re-spelling the range, forcing repaints synchronously and across a frame,
// every `user-select` variant, taking KaTeX's hidden MathML out of layout, and
// dispatching the selection ahead of ProseMirror. Converting the range to a
// NodeSelection *does* paint correctly and breaks ⌘C entirely — don't.
function selectionStartAtAtom() {
  return new Plugin({
    key: new PluginKey('MW_atomSelectionStart'),
    view: (view) => ({
      update() {
        const { from, empty } = view.state.selection
        if (empty) return
        const node = view.state.doc.nodeAt(from)
        if (!node?.isAtom || !node.isInline || node.isText) return

        const dom = view.nodeDOM(from)
        const parent = dom?.parentNode
        if (!parent) return
        const index = Array.prototype.indexOf.call(parent.childNodes, dom)
        if (index < 0) return

        const sel = window.getSelection()
        if (!sel?.rangeCount) return
        const current = sel.getRangeAt(0)
        if (current.startContainer === parent && current.startOffset === index) return

        try {
          const range = document.createRange()
          range.setStart(parent, index)
          range.setEnd(current.endContainer, current.endOffset)
          sel.removeAllRanges()
          sel.addRange(range)
        } catch (e) { /* leave the selection alone rather than break it */ }
      },
    }),
  })
}

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

    // Anything pressed outside the popup dismisses it. The field's own `blur`
    // is not enough on its own: a press only moves focus when it lands on
    // something focusable, and plenty of the editor isn't — the padding beside
    // a blockquote's bar, the margins around the text column. Pressing there
    // used to leave the popup open and holding focus, so the next thing typed
    // went into the LaTeX field instead of the document, and the equation
    // looked like it had captured the whole block. Capture phase, because
    // Crepe's own handlers stop plenty of events on the way up.
    this.onPointerDown = (e) => {
      if (this.pos == null || this.dom.contains(e.target)) return
      this.commit()
    }
    document.addEventListener('pointerdown', this.onPointerDown, true)
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
    document.removeEventListener('pointerdown', this.onPointerDown, true)
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
          // A click *selects* the equation, whole, the way clicking a word
          // selects a word. That is the thing a drag cannot do: the pointer
          // has to clear a `contenteditable="false"` element before the
          // browser will move the selection past it, so dragging always takes
          // a space along with the equation and there is no gesture that gets
          // just the equation.
          //
          // Editing is a double click, as it is for an image here. A single
          // click opening the field meant clicking anywhere near an equation
          // handed the keyboard to that little text box, and the arrow keys
          // then quietly stopped moving the caret.
          handleClickOn: (view, _pos, node, nodePos) => {
            if (node.type.name !== MATH_INLINE) return false
            view.dispatch(
              view.state.tr.setSelection(
                TextSelection.create(view.state.doc, nodePos, nodePos + node.nodeSize)
              )
            )
            return true
          },
          handleDoubleClickOn: (view, _pos, node, nodePos) => {
            if (node.type.name !== MATH_INLINE || !editor) return false
            editor.open(nodePos, node)
            return true
          },
        },
      })
  )

  const escapes = $prose(
    () =>
      new Plugin({
        key: new PluginKey('MW_mathEscapes'),
        // Not while a document is loading: `\$` that came out of the parser is
        // the two characters the author wrote as `\\$`, and opening a file
        // should never rewrite it.
        appendTransaction: (trs, oldState, newState) => {
          if (isLoading() || !trs.some((tr) => tr.docChanged)) return null
          return stripDollarEscapes(oldState, newState)
        },
      })
  )

  return [remarkLiteralDollars, $prose(clipboardPlugin), $prose(selectionStartAtAtom),
          escapes, merge, edit]
}
