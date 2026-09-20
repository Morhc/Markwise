// Keeping your place across ⌘/ (rendered document ⇄ markdown source). Without
// this the textarea always opens at character 0 and the rendered view comes
// back at the top of the document, so toggling to check the raw markdown of
// the paragraph you are reading means scrolling to find it again — and then
// scrolling back.
//
// What "your place" means is *what is on screen*, not where the caret is: you
// scroll far more often than you move the caret, so anchoring on the caret
// alone strands you whenever you have scrolled away from it. So the top line of
// one view becomes the top line of the other, and the caret is carried across
// separately — it only moves when you actually moved it.
//
// There is no position map between the two: the markdown is produced by
// re-serializing the whole document, and remark hands back no source offsets.
// What both sides do agree on is the sequence of blocks, so that is the unit
// this syncs — land in the right paragraph, then refine within it by looking
// for the text around the position. Being a few characters off inside a block
// costs nothing; being in the wrong block is the whole complaint.
import { TextSelection } from '@milkdown/kit/prose/state'

/// A document node holding children [from, to) of `doc`, for serializing one
/// block, or everything before it, on its own.
function sliceDoc(doc, from, to) {
  const nodes = []
  for (let i = from; i < to; i++) nodes.push(doc.child(i))
  return doc.type.create(doc.attrs, nodes)
}

const firstLine = (text) => text.trim().split('\n', 1)[0]

/// Where block `index` starts in `markdown`.
///
/// Serializing everything before it gives the offset to within a character or
/// two — but only that. Blocks are joined by a blank line that the join
/// handlers can suppress (an empty paragraph writes nothing at all), so the
/// error is real and accumulates. Searching for the block's own first line
/// near the estimate snaps it onto the true position; the window keeps the
/// search from matching an identical line elsewhere in the document.
function blockStart(doc, serialize, markdown, index) {
  if (index <= 0) return 0
  let estimate = markdown.length
  try {
    estimate = Math.min(serialize(sliceDoc(doc, 0, index)).length, markdown.length)
  } catch (e) { /* fall back to the search below */ }

  const anchor = firstLine(blockMarkdown(doc, serialize, index))
  if (!anchor) return estimate
  const found = markdown.indexOf(anchor, Math.max(0, estimate - 200))
  return found < 0 ? estimate : found
}

function blockMarkdown(doc, serialize, index) {
  try {
    return serialize(sliceDoc(doc, index, index + 1))
  } catch (e) {
    return ''
  }
}

/// The offset in `markdown` matching a position in the editor.
export function sourceOffset(view, markdown, serialize, pos) {
  const { doc } = view.state
  if (!doc.childCount) return 0
  const at = pos == null ? view.state.selection.from : pos
  const $from = doc.resolve(Math.max(0, Math.min(at, doc.content.size)))

  const index = Math.min($from.index(0), doc.childCount - 1)
  const start = blockStart(doc, serialize, markdown, index)
  // A position *between* two blocks — which is what a hit test on the gap
  // above a paragraph returns, and so the common case for the top of a
  // scrolled view — resolves at the top level and has no text around it to
  // refine with. The block it sits in front of is the whole answer.
  if ($from.depth === 0) return start

  // Within the block, look for the run of text immediately before the
  // position. A block separator counts as the end of a run, so the tail never
  // reaches back across a line break or an atom (an equation, an image) whose
  // markdown spelling bears no relation to its text.
  const before = doc.textBetween($from.before(1) + 1, $from.pos, '\n', '\n')
  const tail = before.slice(before.lastIndexOf('\n') + 1).slice(-40)
  if (!tail) return start

  const limit = start + blockMarkdown(doc, serialize, index).length
  const found = markdown.indexOf(tail, start)
  return found >= 0 && found < limit ? found + tail.length : start
}

/// The child indexes leading to the block a document ends inside — which,
/// for a document parsed from the text up to the caret, is the block the caret
/// is in. Whatever it was, being cut short leaves it the last child at every
/// level, so no counting is needed: follow the tail down.
function pathToEnd(node, path = []) {
  const index = node.childCount - 1
  if (index < 0) return path
  path.push(index)
  const child = node.child(index)
  return child.isTextblock || child.isLeaf ? path : pathToEnd(child, path)
}

/// The same path walked in the real document, as a position. Indexes are
/// clamped rather than trusted: an unterminated code fence or list can parse
/// into a slightly different shape than the finished text does.
function positionForPath(doc, path) {
  let pos = 0
  let node = doc
  for (const index of path) {
    if (!node.childCount) break
    const i = Math.min(index, node.childCount - 1)
    for (let k = 0; k < i; k++) pos += node.child(k).nodeSize
    node = node.child(i)
    if (node.isLeaf && !node.isTextblock) break // an image or a rule: sit before it
    pos += 1
  }
  return Math.min(pos, doc.content.size)
}

/// The editor position matching `offset` in the markdown `text`.
///
/// The inverse of `blockStart`, and cheaper: parsing the text up to the caret
/// puts the caret's own block at the end of the result, so its position falls
/// out of the shape of that parse without serializing anything. Nesting comes
/// along for free, which matters for the documents that are one long list.
///
/// No refinement within the block — the markdown around the caret is syntax as
/// often as it is text, so there is nothing dependable to match against.
export function selectionForOffset(doc, parse, text, offset) {
  let path = []
  try {
    // One character past the offset, so that an offset sitting on a block's
    // first character lands in that block rather than at the end of the one
    // before it — which is every offset taken from the top of a scrolled view.
    const prefix = parse(text.slice(0, offset + 1))
    if (prefix) path = pathToEnd(prefix)
  } catch (e) { /* the top of the document */ }
  return TextSelection.near(doc.resolve(positionForPath(doc, path)), 1)
}

// --- Where a line of the source sits ----------------------------------------
// Scrolling the textarea to a given character — or asking which character it
// has scrolled to — has no API, and counting lines does not answer it either
// because they wrap. The measurement has to come from a layout, so this lays
// the same text out again in a hidden element of the same width and font, one
// span per line, and reads back where each landed.
//
// `offsetTop` is measured from the padding edge, which is also where a scroll
// container's `scrollTop` starts counting, so the number is the scrollTop that
// puts that line at the top of the view. One layout covers both directions.
const MIRRORED = [
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'lineHeight',
  'letterSpacing', 'wordSpacing', 'paddingLeft', 'paddingRight', 'paddingTop',
  'width', 'boxSizing', 'tabSize', 'textIndent', 'overflowWrap', 'textTransform',
]

/// `{ start, y }` for every line of a textarea's value, in order. Measured
/// while the textarea is on screen — a hidden one has no width to match.
export function lineTable(el) {
  const cs = getComputedStyle(el)
  const mirror = document.createElement('div')
  for (const prop of MIRRORED) mirror.style[prop] = cs[prop]
  mirror.style.whiteSpace = 'pre-wrap'
  mirror.style.position = 'absolute'
  mirror.style.visibility = 'hidden'
  mirror.style.left = '-99999px'
  mirror.style.top = '0'

  const spans = []
  let start = 0
  for (const line of el.value.split('\n')) {
    const span = document.createElement('span')
    // The newline is part of the line: without it an empty line collapses and
    // every line after it is measured too high.
    span.textContent = `${line}\n`
    mirror.appendChild(span)
    spans.push({ start, span })
    start += line.length + 1
  }

  document.body.appendChild(mirror)
  const table = spans.map((row) => ({ start: row.start, y: row.span.offsetTop }))
  mirror.remove()
  return table
}

/// The scroll offset that puts the line holding `offset` at the top.
export function scrollForOffset(table, offset) {
  let y = 0
  for (const row of table) {
    if (row.start > offset) break
    y = row.y
  }
  return y
}

/// The first character visible at scroll offset `y`.
export function offsetAtScroll(table, y) {
  let start = 0
  for (const row of table) {
    if (row.y > y + 1) break
    start = row.start
  }
  return start
}
