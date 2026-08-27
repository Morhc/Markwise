// Editing and serialization behaviour Crepe and Milkdown leave to be fixed
// downstream: getting a caret back out of a block that ends a container,
// keeping empty paragraphs out of the saved markdown, and not dropping the
// escaping of a run of text that happens to end in a space.
import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey, TextSelection } from '@milkdown/kit/prose/state'
import { chainCommands, joinBackward } from '@milkdown/kit/prose/commands'
import { keymap } from '@milkdown/kit/prose/keymap'
import { undoInputRule } from '@milkdown/kit/prose/inputrules'
import { liftTarget } from '@milkdown/kit/prose/transform'
import { EditorView } from '@codemirror/view'

// --- Empty paragraphs are empty, not `<br />` -------------------------------
// Milkdown writes a literal `<br />` for any empty paragraph that isn't the
// document's last node, so that a blank line left in the editor isn't folded
// away when the markdown is read back. Markwise saves portable markdown —
// files that read the same in GitHub, Pandoc and Typora — and pressing Enter
// twice is not a request for an HTML tag. In a blockquote it is worse than
// untidy: the line becomes `> <br />`, which reads back as a quote containing
// a stray tag rather than the empty line that was meant.
//
// This is a stringify handler rather than a change to the paragraph schema:
// re-registering `paragraph` appends a second entry to Milkdown's node list,
// and the *first* block type in the schema is the one ProseMirror fills a new
// block with — so the original ordering is load-bearing, and shifting it makes
// every new paragraph a heading.
//
// A `<br />` written by hand is already read as an empty paragraph by
// Milkdown's own round-trip, so the tag was never yours to keep; what changes
// is that the empty line now folds away on save, as it does in every other
// markdown editor. A deliberate line break inside a paragraph is a hard break
// (⇧↵), which is untouched.
const EMPTY_LINE = /^<br\s*\/?>$/i

function isEmptyParagraph(node) {
  // The type check matters for `paragraphJoin`, which is offered every pair of
  // siblings: a code block has no `children` at all and would otherwise look
  // empty, and dropping the blank line beside one loses the `>` that keeps a
  // blockquote's parts apart.
  if (node?.type !== 'paragraph') return false
  const children = node.children ?? []
  if (children.length === 0) return true
  return (
    children.length === 1 &&
    children[0].type === 'html' &&
    EMPTY_LINE.test(String(children[0].value ?? '').trim())
  )
}

/// An empty paragraph writes nothing, but remark-stringify still separates it
/// from its neighbours, so the blank line it left behind turns into three.
/// Joining with no blank line either side collapses that back to one.
export const paragraphJoin = [
  (left, right) => (isEmptyParagraph(left) || isEmptyParagraph(right) ? 0 : undefined),
]

/// Milkdown's own `text` handler returns the value unescaped whenever it ends
/// in whitespace and carries no `*`, `_` or `\`, to stop remark encoding the
/// trailing spaces as `&#x20;`. The side effect is that nothing else in that
/// run is escaped either — so `Cost \$5 then ` followed by an equation writes
/// its dollar bare, and the file then reads as maths from the wrong `$`. Keep
/// the trailing space out of remark's hands, and let it escape the rest.
function textHandler(node, _parent, state, info) {
  const value = String(node.value ?? '')
  const trailing = /\s+$/.exec(value)?.[0] ?? ''
  const body = trailing ? value.slice(0, -trailing.length) : value
  return state.safe(body, { ...info, encode: [] }) + trailing
}

export const paragraphStringifyHandlers = {
  text: textHandler,
  paragraph: (node, _parent, state, info) => {
    if (isEmptyParagraph(node)) return ''
    // Otherwise character-for-character remark-stringify's own paragraph
    // handler. Entering `phrasing` is not decoration: escaping is driven by
    // patterns scoped to the constructs on the stack, so leaving it out stops
    // a literal `$` in the text from being written as `\$` and quietly undoes
    // the escape the author asked for.
    const exit = state.enter('paragraph')
    const subexit = state.enter('phrasing')
    const value = state.containerPhrasing(node, info)
    subexit()
    exit()
    return value
  },
}

// --- Backspace at the start of a blockquote ---------------------------------
// Milkdown binds ⌫ to `joinTextblockBackward`, which only ever *joins* two
// text blocks. ProseMirror's own `joinBackward` does that too, but falls back
// to lifting the block out of its parent when there is nothing before it to
// join to — and that fallback is the whole of "get rid of this quote". Without
// it, ⌫ at the start of the first line of a blockquote does nothing at all:
// the caret sits against the quote bar and no key removes the `>`.
//
// `joinBackward` declines unless the caret is at the start of a text block, so
// this changes nothing about ordinary backspacing. `undoInputRule` stays ahead
// of it, so ⌫ straight after typing `> ` still puts the characters back rather
// than unwrapping.
export const backspaceLift = $prose(() =>
  keymap({ Backspace: chainCommands(undoInputRule, joinBackward) })
)

// --- Getting into and out of a code block at the edge of a blockquote -------
// Both ends of a quoted code fence were dead ends.
//
// Pressing ↓ at the end runs Milkdown's "escape the code block" handler, which
// puts the caret at the nearest *text* position after the node. Inside a
// blockquote there isn't one, so the caret left the quote entirely and what you
// typed next landed underneath it. (⌘↵ has always done the right thing;
// nothing advertises it.)
//
// Pressing ⌫ at the start did nothing at all, so a quote opening with a code
// fence could not be unwrapped or deleted from the keyboard.
//
// The key never reaches ProseMirror — CodeMirror owns the code block's DOM and
// stops it — so this is a capture-phase listener, the same way the paste and
// popup handlers here reach events Crepe would otherwise swallow. It only acts
// where the default is wrong: the caret at the very end of the code, and the
// block the last thing in something other than the document itself.
/// The ProseMirror node and position for the code block a DOM node is inside.
function codeBlockAt(view, dom) {
  let found = null
  view.state.doc.descendants((node, pos) => {
    if (found) return false
    if (node.type.spec.code && view.nodeDOM(pos) === dom) found = { node, pos }
    return !found
  })
  return found
}

/// ↓ at the end: carry on inside the container rather than leaving it.
function escapeForward(view, { node, pos }) {
  const { state } = view
  const $after = state.doc.resolve(pos + node.nodeSize)
  const parent = $after.parent
  // At the top level the caret has somewhere to go already, and if anything
  // follows inside the container the ordinary behaviour is right too.
  if (parent.type.name === 'doc' || $after.index() < parent.childCount) return false

  const paragraph = state.schema.nodes.paragraph
  if (!paragraph || !parent.canReplaceWith($after.index(), $after.index(), paragraph)) return false

  const tr = state.tr.insert($after.pos, paragraph.createAndFill())
  tr.setSelection(TextSelection.near(tr.doc.resolve($after.pos), 1))
  view.dispatch(tr.scrollIntoView())
  view.focus()
  return true
}

/// ⌫ at the very start: take the block out of the blockquote it opens, which
/// is how you get rid of the quote.
///
/// Milkdown's own handler turns a code block into a paragraph on ⌫, but only
/// when it holds a single line — so a quote whose first block is a code fence
/// of two lines or more had nothing bound to ⌫ at all. The caret sits at the
/// start of the code, level with the quote bar, and every key does nothing:
/// the quote can't be unwrapped, and the block can't be joined to anything
/// because there is nothing before it.
function liftOutOfContainer(view, { node, pos }) {
  const { state } = view
  const $start = state.doc.resolve(pos)
  // Only where the block opens a container — anywhere else the ordinary
  // backspace (delete a character, join with what's above) is what's wanted.
  if ($start.depth === 0 || $start.index() !== 0) return false

  const range = $start.blockRange(state.doc.resolve(pos + node.nodeSize))
  const target = range && liftTarget(range)
  if (target == null) return false

  view.dispatch(state.tr.lift(range, target).scrollIntoView())
  view.focus()
  return true
}

function onCodeBlockKey(event) {
  if (event.metaKey || event.ctrlKey || event.altKey) return
  if (event.key !== 'ArrowDown' && event.key !== 'Backspace') return
  const content = event.target?.closest?.('.milkdown-code-block .cm-content')
  if (!content) return
  const cm = EditorView.findFromDOM(content)
  const main = cm?.state.selection.main
  if (!cm || !main?.empty) return

  const forward = event.key === 'ArrowDown'
  if (forward ? main.head !== cm.state.doc.length : main.head !== 0) return

  const view = getEditorView()
  const dom = content.closest('.milkdown-code-block')
  const found = view && dom && codeBlockAt(view, dom)
  if (!found) return

  const handled = forward ? escapeForward(view, found) : liftOutOfContainer(view, found)
  if (!handled) return
  event.preventDefault()
  event.stopPropagation()
}

/// The listener needs the live ProseMirror view, which only exists once the
/// editor is built, so the plugin hands it over as it starts.
let getEditorView = () => null

export const codeBlockEscapePlugin = $prose(
  () =>
    new Plugin({
      key: new PluginKey('MW_codeBlockEscape'),
      view: (view) => {
        getEditorView = () => view
        document.addEventListener('keydown', onCodeBlockKey, true)
        return {
          destroy() {
            document.removeEventListener('keydown', onCodeBlockKey, true)
            getEditorView = () => null
          },
        }
      },
    })
)

export const blockPlugins = [backspaceLift, codeBlockEscapePlugin].flat()
