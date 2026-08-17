// Keep image alt text intact.
//
// Milkdown's `image-block` node stores the image's display aspect ratio in the
// markdown `alt` field: it parses `alt` as a number and writes the ratio back
// out as `alt` on save. So `![a diagram](x.png)` round-trips to `![1.00](x.png)`
// and the description is gone - silent data loss in the user's file, and the
// alt text is the accessible name of the image.
//
// This patches the schema (which lives in a ctx slice keyed by node id, so it
// can be amended rather than replaced) to give the node a real `alt` attribute
// and to stop the ratio being written to the file. The cost is that a resized
// image no longer remembers its size across a save - a fair trade against
// destroying text the user wrote.
import { imageBlockSchema } from '@milkdown/kit/component/image-block'

/// Alt text that is only a number is a ratio written by the old behaviour, not
/// a description - recognise it so documents already mangled don't display
/// "1.00" as their alt text forever.
function ratioFromLegacyAlt(alt) {
  const s = String(alt ?? '').trim()
  if (!s || !/^\d*\.?\d+$/.test(s)) return null
  const n = Number(s)
  return Number.isFinite(n) && n > 0 ? n : null
}

export function patchImageBlock(ctx) {
  ctx.update(imageBlockSchema.key, (prev) => (innerCtx) => {
    const base = prev(innerCtx)
    return {
      ...base,
      attrs: {
        ...base.attrs,
        alt: { default: '', validate: 'string' },
      },
      parseDOM: [
        {
          tag: 'img[data-type="image-block"]',
          getAttrs: (dom) => ({
            src: dom.getAttribute('src') || '',
            alt: dom.getAttribute('alt') || '',
            caption: dom.getAttribute('caption') || '',
            ratio: Number(dom.getAttribute('ratio') ?? 1),
          }),
        },
      ],
      parseMarkdown: {
        match: base.parseMarkdown.match,
        runner: (state, node, type) => {
          const legacy = ratioFromLegacyAlt(node.alt)
          state.addNode(type, {
            src: node.url ?? '',
            alt: legacy == null ? (node.alt ?? '') : '',
            caption: node.title ?? '',
            ratio: legacy ?? 1,
          })
        },
      },
      toMarkdown: {
        match: base.toMarkdown.match,
        runner: (state, node) => {
          state.openNode('paragraph')
          state.addNode('image', undefined, undefined, {
            title: node.attrs.caption,
            url: node.attrs.src,
            alt: node.attrs.alt ?? '',
          })
          state.closeNode()
        },
      },
    }
  })
}
