// Find and Replace. Finding stays with WebKit (the ⌘F bar drives
// `WKWebView.find`, which highlights, scrolls and selects the match); this is
// the half WebKit can't do — changing the text — done as edits to the
// document, so they undo like any other.
//
// Replace works the way it does in TextEdit and Xcode: it replaces the
// selection *if the selection is a match*, and the host then finds the next
// one. So the first press on a fresh search only finds, and every press after
// that replaces what you are looking at and moves on. Matching ignores case,
// the same as the find it follows.
//
// Code blocks are their own CodeMirror editors with their own selection,
// which ProseMirror never sees, so a match WebKit selected inside one is
// replaced through CodeMirror.
import { EditorView as CodeMirrorView } from '@codemirror/view'
import { TextSelection } from '@milkdown/kit/prose/state'

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/// A case-insensitive matcher for `query`. A regex rather than lowercasing
/// both sides: lowercasing can change a string's length ('İ' becomes two
/// characters), and every offset here has to line up with the document.
export function matcher(query) {
  return new RegExp(escape(query), 'giu')
}

const isMatch = (text, query) => new RegExp(`^${escape(query)}$`, 'iu').test(text)

/// Replace the current selection with `replacement` if it matches `query`.
/// Returns whether anything was replaced.
export function replaceSelection(view, query, replacement) {
  if (!query) return false

  const cm = focusedCodeMirror()
  if (cm) {
    const { from, to } = cm.state.selection.main
    if (from === to || !isMatch(cm.state.sliceDoc(from, to), query)) return false
    cm.dispatch({
      changes: { from, to, insert: replacement },
      selection: { anchor: from + replacement.length },
    })
    return true
  }

  const { from, to, empty } = view.state.selection
  if (empty || !isMatch(view.state.doc.textBetween(from, to, '\n', '￼'), query)) return false
  // insertText keeps the marks at the start of the range, so a match in bold
  // is replaced by bold text.
  const tr = view.state.tr.insertText(replacement, from, to)
  tr.setSelection(TextSelection.create(tr.doc, from + replacement.length))
  view.dispatch(tr.scrollIntoView())
  return true
}

/// The CodeMirror editor holding the DOM selection, if any.
function focusedCodeMirror() {
  const node = window.getSelection()?.anchorNode
  const el = node?.nodeType === 1 ? node : node?.parentElement
  const content = el?.closest?.('.cm-content')
  return content ? CodeMirrorView.findFromDOM(content) : null
}

/// Replace every match in the document, as one change (so one undo).
/// Returns how many were replaced.
///
/// Matches are found within each text block, so none spans two paragraphs
/// — nor does WebKit's find. An inline atom (an equation, an image) stands in
/// the text as one placeholder character, which is exactly its size in the
/// document, so offsets in the text are offsets in the document, and a match
/// never runs through one.
export function replaceAll(view, query, replacement) {
  if (!query) return 0
  const ranges = []
  view.state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    const text = node.textBetween(0, node.content.size, undefined, '￼')
    for (const m of text.matchAll(matcher(query))) {
      ranges.push({ from: pos + 1 + m.index, to: pos + 1 + m.index + m[0].length })
    }
    return false
  })
  if (!ranges.length) return 0

  const tr = view.state.tr
  // Back to front, so each replacement leaves the positions before it alone.
  for (let i = ranges.length - 1; i >= 0; i--) {
    tr.insertText(replacement, ranges[i].from, ranges[i].to)
  }
  view.dispatch(tr)
  return ranges.length
}

// --- The source view --------------------------------------------------------
// Edits go through `insertText` so the textarea's own undo covers them.

export function replaceSelectionInTextarea(el, query, replacement) {
  const { selectionStart: from, selectionEnd: to } = el
  if (!query || from === to || !isMatch(el.value.slice(from, to), query)) return false
  el.focus()
  el.setSelectionRange(from, to)
  document.execCommand('insertText', false, replacement)
  return true
}

export function replaceAllInTextarea(el, query, replacement) {
  if (!query) return 0
  const count = [...el.value.matchAll(matcher(query))].length
  if (!count) return 0
  const scroll = el.scrollTop
  const caret = el.selectionStart
  el.focus()
  el.select()
  document.execCommand('insertText', false, el.value.replace(matcher(query), () => replacement))
  el.setSelectionRange(Math.min(caret, el.value.length), Math.min(caret, el.value.length))
  el.scrollTop = scroll
  return count
}
