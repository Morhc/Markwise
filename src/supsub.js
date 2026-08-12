// Superscript and subscript.
//
// Markdown has no syntax for either, so the portable spelling — the one GitHub,
// Pandoc and Typora all render — is literal HTML: `E<sub>0</sub>`, `x<sup>2</sup>`.
// CommonMark parses those tags into standalone inline `html` nodes, which Crepe
// renders as visible `<sup>` text, so plain HTML is unusable as-is in a WYSIWYG
// editor.
//
// This module closes the loop: a remark transformer folds the tag/text/tag
// triples coming out of the parser into real `sup`/`sub` mdast nodes, a pair of
// ProseMirror marks render them, and remark-stringify handlers write the tags
// back out. Round-trips to exactly the HTML it came from.
import { $markSchema, $remark } from '@milkdown/kit/utils'

const TAGS = ['sup', 'sub']

// --- markdown -> mdast ------------------------------------------------------

const openTag = (node) => {
  if (node?.type !== 'html') return null
  const m = /^<\s*(sup|sub)\s*>$/i.exec(node.value ?? '')
  return m ? m[1].toLowerCase() : null
}

const closeTag = (node) => {
  if (node?.type !== 'html') return null
  const m = /^<\s*\/\s*(sup|sub)\s*>$/i.exec(node.value ?? '')
  return m ? m[1].toLowerCase() : null
}

/// Fold `html('<sup>') … html('</sup>')` runs into a single `sup` node.
/// Unmatched tags are left exactly as they were, so stray HTML in a document
/// still round-trips untouched.
function fold(children) {
  const out = []
  for (let i = 0; i < children.length; i++) {
    const node = children[i]
    if (Array.isArray(node.children)) node.children = fold(node.children)

    const tag = openTag(node)
    if (!tag) {
      out.push(node)
      continue
    }

    // Find the matching close tag, honouring nesting of the same tag.
    let depth = 1
    let j = i + 1
    for (; j < children.length; j++) {
      if (openTag(children[j]) === tag) depth++
      else if (closeTag(children[j]) === tag && --depth === 0) break
    }
    if (j >= children.length) {
      out.push(node) // unmatched — leave the raw tag alone
      continue
    }

    out.push({ type: tag, children: fold(children.slice(i + 1, j)) })
    i = j
  }
  return out
}

export const remarkSupSub = $remark('mwSupSub', () => () => (tree) => {
  if (Array.isArray(tree.children)) tree.children = fold(tree.children)
  return tree
})

// --- mdast -> markdown ------------------------------------------------------

/// remark-stringify handler emitting `<sup>…</sup>` around the phrasing content.
function handler(tag) {
  const open = `<${tag}>`
  const close = `</${tag}>`
  return (node, _parent, state, info) => {
    const exit = state.enter(tag)
    const tracker = state.createTracker(info)
    const before = tracker.move(open)
    const value = tracker.move(
      state.containerPhrasing(node, { before, after: '<', ...tracker.current() })
    )
    exit()
    return before + value + tracker.move(close)
  }
}

export const supSubStringifyHandlers = {
  sup: handler('sup'),
  sub: handler('sub'),
}

// --- schema -----------------------------------------------------------------

function markFor(tag) {
  return $markSchema(tag, () => ({
    parseDOM: [{ tag }],
    toDOM: () => [tag, 0],
    parseMarkdown: {
      match: (node) => node.type === tag,
      runner: (state, node, markType) => {
        state.openMark(markType)
        state.next(node.children)
        state.closeMark(markType)
      },
    },
    toMarkdown: {
      match: (mark) => mark.type.name === tag,
      runner: (state, mark) => {
        state.withMark(mark, tag)
      },
    },
  }))
}

export const supSchema = markFor('sup')
export const subSchema = markFor('sub')

export const supSubPlugins = [remarkSupSub, supSchema, subSchema].flat()
export const SUPSUB_TAGS = TAGS
