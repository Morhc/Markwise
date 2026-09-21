// Folding a heading's section, the way Typora and Obsidian do it: a chevron in
// the gutter beside any heading that has something under it, and clicking it
// hides everything down to the next heading of the same or a higher level —
// so folding a `##` takes its `###` subsections with it.
//
// Folding is a way of looking at the document, not a change to it. Markdown
// has no spelling for "collapsed", so nothing here touches the document or
// the saved file: the folds are plugin state, and the hiding is done with
// node decorations. Folds last as long as the editor does — reopening a file
// shows it whole.
//
// A fold gets out of the way whenever you need what is under it:
// - a selection that lands in hidden content (arrow keys, undo, anything)
//   unfolds whatever was hiding it, so you never type into text you can't see;
// - find (⌘F) unfolds the sections that contain the query before searching —
//   WebKit's find skips text that isn't displayed, so it could never reach
//   folded text on its own;
// - the outline unfolds a section before jumping into it.
import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'

const key = new PluginKey('MW_fold')

const isHeading = (node) => node?.type.name === 'heading'

/// Every top-level heading, with the range of the blocks its section covers:
/// from the end of the heading to the next heading of the same or a higher
/// level. Only top-level headings fold — a heading inside a quote or a list
/// has no section to speak of.
function sections(doc) {
  const blocks = []
  doc.forEach((node, offset) => blocks.push({ node, offset }))
  const out = []
  blocks.forEach(({ node, offset }, i) => {
    if (!isHeading(node)) return
    let to = offset + node.nodeSize
    for (let j = i + 1; j < blocks.length; j++) {
      const next = blocks[j].node
      if (isHeading(next) && next.attrs.level <= node.attrs.level) break
      to = blocks[j].offset + next.nodeSize
    }
    out.push({ pos: offset, bodyFrom: offset + node.nodeSize, to, level: node.attrs.level })
  })
  return out
}

/// The folds whose hidden range contains `pos` — more than one when a folded
/// section sits inside another.
function hiding(folds, all, pos) {
  return all.filter((s) => folds.includes(s.pos) && pos >= s.bodyFrom && pos < s.to)
}

function decorate(doc, folds, all) {
  const decos = []
  const hidden = new Set()
  for (const s of all) {
    if (s.to === s.bodyFrom) continue // nothing under it: nothing to fold
    const folded = folds.includes(s.pos)
    decos.push(Decoration.node(s.pos, s.bodyFrom, {
      class: folded ? 'mw-fold-heading mw-fold-closed' : 'mw-fold-heading',
    }))
    if (!folded) continue
    doc.nodesBetween(s.bodyFrom, s.to, (node, pos) => {
      if (!hidden.has(pos)) {
        hidden.add(pos)
        decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'mw-folded' }))
      }
      return false // top-level blocks only; hiding one hides what is in it
    })
  }
  return DecorationSet.create(doc, decos)
}

function build(doc, folds) {
  const all = sections(doc)
  // A fold whose heading has gone (deleted, turned into a paragraph) or has
  // nothing left under it is dropped rather than left to fold something else.
  const live = folds.filter((pos) => all.some((s) => s.pos === pos && s.to > s.bodyFrom))
  return { folds: live, all, decorations: decorate(doc, live, all) }
}

/// Where a heading starting at `pos` starts after `tr`. Mapped to follow the
/// heading when a block is inserted in front of it — but Milkdown rewrites a
/// heading's markup (its `id`) on every edit to its text, and a markup rewrite
/// replaces the heading's opening token, which reads as the position being
/// deleted from that side. The other side is intact, so that is where the
/// heading is. Anything that isn't a heading afterwards is dropped by `build`.
function mapHeading(tr, pos) {
  const after = tr.mapping.mapResult(pos, 1)
  return after.deleted ? tr.mapping.map(pos, -1) : after.pos
}

export const foldPlugin = $prose(() => new Plugin({
  key,
  state: {
    init: (_config, state) => build(state.doc, []),
    apply(tr, value, _old, state) {
      const meta = tr.getMeta(key)
      if (!meta && !tr.docChanged && !tr.selectionSet) return value

      let folds = value.folds
      if (tr.docChanged) folds = folds.map((pos) => mapHeading(tr, pos))
      if (meta?.fold != null && !folds.includes(meta.fold)) folds = [...folds, meta.fold]
      if (meta?.unfold) folds = folds.filter((pos) => !meta.unfold.includes(pos))
      if (meta?.unfoldAll) folds = []

      let next = tr.docChanged || meta ? build(state.doc, folds) : value
      // Never leave the caret somewhere you can't see it.
      const cover = hiding(next.folds, next.all, state.selection.head)
      if (cover.length) {
        next = build(state.doc, next.folds.filter((pos) => !cover.some((s) => s.pos === pos)))
      }
      return next
    },
  },
  props: {
    decorations: (state) => key.getState(state)?.decorations,
    handleDOMEvents: {
      // The chevron is the heading's ::after, drawn in the gutter to its
      // left, so a press on it arrives as a press on the heading — just to the
      // left of where the heading's box begins.
      mousedown(view, event) {
        const heading = event.target?.closest?.('.mw-fold-heading')
        if (!heading || event.button !== 0) return false
        if (event.clientX >= heading.getBoundingClientRect().left) return false
        const pos = view.posAtDOM(heading, 0) - 1
        event.preventDefault()
        toggleFold(view, pos)
        return true
      },
    },
  },
}))

/// Fold the section headed at `pos`, or unfold it if it is folded.
export function toggleFold(view, pos) {
  const value = key.getState(view.state)
  if (!value) return false
  if (value.folds.includes(pos)) return setFold(view, pos, false)
  return setFold(view, pos, true)
}

function setFold(view, pos, fold) {
  const value = key.getState(view.state)
  const section = value?.all.find((s) => s.pos === pos)
  if (!section || section.to === section.bodyFrom) return false
  const tr = view.state.tr
  if (fold) {
    tr.setMeta(key, { fold: pos })
    // Folding the section the caret is in would hide the caret, which is the
    // one thing that unfolds it again. Park it at the end of the heading.
    const { head } = view.state.selection
    if (head >= section.bodyFrom && head < section.to) {
      tr.setSelection(TextSelection.create(tr.doc, section.bodyFrom - 1))
    }
  } else {
    tr.setMeta(key, { unfold: [pos] })
  }
  view.dispatch(tr)
  return true
}

/// The innermost section around the caret: the nearest heading at or before
/// it. Its section always reaches the caret, since a section only ends at a
/// heading and the nearest one is the last there is before the caret.
function sectionAtCaret(state) {
  const value = key.getState(state)
  const head = state.selection.head
  let found = null
  for (const s of value?.all ?? []) {
    if (s.pos <= head && head < s.to) found = s
  }
  return found
}

/// ⌥⌘[ — fold the section the caret is in. Pressed again on a heading that is
/// already folded, it folds the section around that one, so repeated presses
/// climb the outline the way they do in a code editor.
export function foldAtCaret(view) {
  const value = key.getState(view.state)
  let s = sectionAtCaret(view.state)
  while (s && (value.folds.includes(s.pos) || s.to === s.bodyFrom)) {
    const inner = s
    s = value.all.filter((o) => o.level < inner.level && o.pos < inner.pos && inner.pos < o.to).pop()
  }
  return s ? setFold(view, s.pos, true) : false
}

/// ⌥⌘] — unfold the heading the caret is on.
export function unfoldAtCaret(view) {
  const value = key.getState(view.state)
  const s = sectionAtCaret(view.state)
  return s && value.folds.includes(s.pos) ? setFold(view, s.pos, false) : false
}

export function unfoldAll(view) {
  if (!key.getState(view.state)?.folds.length) return false
  view.dispatch(view.state.tr.setMeta(key, { unfoldAll: true }))
  return true
}

/// Unfold whatever hides `pos` (the outline, jumping to a heading).
export function revealPos(view, pos) {
  const value = key.getState(view.state)
  const cover = value ? hiding(value.folds, value.all, pos) : []
  if (!cover.length) return false
  view.dispatch(view.state.tr.setMeta(key, { unfold: cover.map((s) => s.pos) }))
  return true
}

/// Unfold every fold whose hidden text contains `query`, ignoring case — the
/// same matching WebKit's find is about to do.
export function revealText(view, query) {
  const value = key.getState(view.state)
  const needle = String(query ?? '').toLowerCase()
  if (!value?.folds.length || !needle) return false
  const { doc } = view.state
  const unfold = value.all
    .filter((s) => value.folds.includes(s.pos))
    .filter((s) => doc.textBetween(s.bodyFrom, s.to, '\n', ' ').toLowerCase().includes(needle))
    .map((s) => s.pos)
  if (!unfold.length) return false
  view.dispatch(view.state.tr.setMeta(key, { unfold }))
  return true
}
