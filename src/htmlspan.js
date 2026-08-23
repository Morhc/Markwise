// Inline HTML that styles text: `<span style="color:red">…</span>`, `<u>`, `<mark>`.
//
// Markdown has no syntax for a coloured or underlined run, so the portable
// spelling is literal HTML — the same bargain `<sup>`/`<sub>` make in
// src/supsub.js, and the same problem: CommonMark parses the tags into
// standalone inline `html` nodes, which Crepe renders as visible `<span
// style="color:red">` text with the words in between left the colour they
// always were.
//
// This closes the same loop supsub.js does. A remark transformer folds each
// open/close pair and everything between it into one mdast node, a
// ProseMirror mark carries it, and a remark-stringify handler writes the tags
// back out. The tag's attributes ride along as the raw source string, so
// whatever was written — `style`, `class`, `id`, several at once — round-trips
// as it was written, and the mark's toDOM turns that string back into real
// attributes, which is what finally makes the text red.
//
// Only these three tags are folded. They exist to style a run of text and
// nothing else, so there is never a question of what a document meant by one;
// `<div>`, `<a>` and friends carry structure or behaviour and are left as the
// literal HTML they are.
import { $markSchema, $remark } from '@milkdown/kit/utils'

const TAGS = ['span', 'u', 'mark']

// The mdast node a folded pair becomes. Namespaced so it can't collide with a
// real mdast type.
const nodeType = (tag) => `mwHtml_${tag}`

const OPEN = new RegExp(`^<\\s*(${TAGS.join('|')})(\\s[^>]*?)?\\s*>$`, 'i')
const CLOSE = new RegExp(`^<\\s*/\\s*(${TAGS.join('|')})\\s*>$`, 'i')

// --- markdown -> mdast ------------------------------------------------------

const openTag = (node) => {
  if (node?.type !== 'html') return null
  const m = OPEN.exec(node.value ?? '')
  return m ? { tag: m[1].toLowerCase(), attrs: (m[2] ?? '').trim() } : null
}

const closeTag = (node) => {
  if (node?.type !== 'html') return null
  const m = CLOSE.exec(node.value ?? '')
  return m ? m[1].toLowerCase() : null
}

/// Fold `html('<span …>') … html('</span>')` runs into a single node. An
/// unmatched tag is left exactly as it was, so stray HTML still round-trips
/// untouched.
function fold(children) {
  const out = []
  for (let i = 0; i < children.length; i++) {
    const node = children[i]
    if (Array.isArray(node.children)) node.children = fold(node.children)

    const open = openTag(node)
    if (!open) {
      out.push(node)
      continue
    }

    // Find the matching close tag, honouring nesting of the same tag.
    let depth = 1
    let j = i + 1
    for (; j < children.length; j++) {
      if (openTag(children[j])?.tag === open.tag) depth++
      else if (closeTag(children[j]) === open.tag && --depth === 0) break
    }
    if (j >= children.length) {
      out.push(node) // unmatched — leave the raw tag alone
      continue
    }

    out.push({
      type: nodeType(open.tag),
      attrs: open.attrs,
      children: fold(children.slice(i + 1, j)),
    })
    i = j
  }
  return out
}

export const remarkHtmlSpan = $remark('mwHtmlSpan', () => () => (tree) => {
  if (Array.isArray(tree.children)) tree.children = fold(tree.children)
  return tree
})

// --- mdast -> markdown ------------------------------------------------------

/// remark-stringify handler emitting `<span …>…</span>` around the phrasing
/// content, with the attributes exactly as they were written.
function handler(tag) {
  return (node, _parent, state, info) => {
    const attrs = node.attrs ? ` ${node.attrs}` : ''
    const exit = state.enter(tag)
    const tracker = state.createTracker(info)
    const before = tracker.move(`<${tag}${attrs}>`)
    const value = tracker.move(
      state.containerPhrasing(node, { before, after: '<', ...tracker.current() })
    )
    exit()
    return before + value + tracker.move(`</${tag}>`)
  }
}

export const htmlSpanStringifyHandlers = Object.fromEntries(
  TAGS.map((tag) => [nodeType(tag), handler(tag)])
)

// --- schema -----------------------------------------------------------------

/// The attributes of a DOM element, back as the source string they came from.
function rawAttrs(dom) {
  return [...(dom.attributes ?? [])]
    .map((a) => `${a.name}="${a.value.replace(/"/g, '&quot;')}"`)
    .join(' ')
}

/// The stored attribute string, back as something toDOM can apply. Parsing it
/// as HTML rather than splitting on `=` is what makes entities and quoting
/// work out the same way a browser would read them.
function domAttrs(tag, raw) {
  if (!raw) return {}
  const el = new DOMParser()
    .parseFromString(`<${tag} ${raw}></${tag}>`, 'text/html')
    .body.firstElementChild
  return Object.fromEntries([...(el?.attributes ?? [])].map((a) => [a.name, a.value]))
}

function markFor(tag) {
  return $markSchema(nodeType(tag), () => ({
    attrs: { attrs: { default: '' } },
    parseDOM: [
      {
        tag,
        getAttrs: (dom) => {
          const attrs = rawAttrs(dom)
          // A bare `<span>` says nothing; matching it would wrap pasted text
          // in tags that mean nothing when it is saved.
          if (tag === 'span' && !attrs) return false
          return { attrs }
        },
      },
    ],
    toDOM: (mark) => [tag, domAttrs(tag, mark.attrs.attrs), 0],
    parseMarkdown: {
      match: (node) => node.type === nodeType(tag),
      runner: (state, node, markType) => {
        state.openMark(markType, { attrs: node.attrs ?? '' })
        state.next(node.children)
        state.closeMark(markType)
      },
    },
    toMarkdown: {
      match: (mark) => mark.type.name === nodeType(tag),
      runner: (state, mark) => {
        state.withMark(mark, nodeType(tag), undefined, { attrs: mark.attrs.attrs })
      },
    },
  }))
}

export const htmlSpanPlugins = [remarkHtmlSpan, ...TAGS.map(markFor)].flat()
export const HTML_SPAN_TAGS = TAGS
