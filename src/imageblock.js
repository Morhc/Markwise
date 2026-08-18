// Keep image alt text intact.
//
// Milkdown's `image-block` node stores the image's display aspect ratio in the
// markdown `alt` field: it parses `alt` as a number and writes the ratio back
// out as `alt` on save. So `![a diagram](x.png)` round-trips to `![1.00](x.png)`
// and the description is gone — silent data loss in the user's file, and the
// alt text is the accessible name of the image.
//
// This patches the schema (which lives in a ctx slice keyed by node id, so it
// can be amended rather than replaced) to give the node a real `alt` attribute
// and to stop the ratio being written to the file.
//
// Sizes survive anyway, through a `width` attribute (px; 0 = natural size)
// set by the corner-drag handle in src/imageresize.js. An image with a width
// serializes as literal HTML — `<img src="…" alt="…" width="400" />` — which
// GitHub, Typora and Pandoc all render; the remark transformer in
// imageresize.js parses that form back into this node. An image at natural
// size keeps the plain `![alt](src)` spelling.
import { imageBlockSchema } from '@milkdown/kit/component/image-block'

/// Attribute-position escaping for the serialized <img> tag.
function escapeAttr(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/// Alt text that is only a number is a ratio written by the old behaviour, not
/// a description — recognise it so documents already mangled don't display
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
        width: { default: 0, validate: 'number' },
      },
      parseDOM: [
        {
          tag: 'img[data-type="image-block"]',
          getAttrs: (dom) => ({
            src: dom.getAttribute('src') || '',
            alt: dom.getAttribute('alt') || '',
            caption: dom.getAttribute('caption') || '',
            ratio: Number(dom.getAttribute('ratio') ?? 1),
            width: Number(dom.getAttribute('width')) || 0,
          }),
        },
      ],
      // `width="0"` on an <img> collapses it, so the attribute only appears on
      // an actually-resized image. (toDOM feeds copy/paste, not the on-screen
      // rendering — that's Crepe's own view component.)
      toDOM: (node) => {
        const { width, ...attrs } = node.attrs
        return ['img', {
          'data-type': 'image-block',
          ...attrs,
          ...(width > 0 ? { width: Math.round(width) } : {}),
        }]
      },
      parseMarkdown: {
        match: base.parseMarkdown.match,
        runner: (state, node, type) => {
          const legacy = ratioFromLegacyAlt(node.alt)
          state.addNode(type, {
            src: node.url ?? '',
            alt: legacy == null ? (node.alt ?? '') : '',
            caption: node.title ?? '',
            ratio: legacy ?? 1,
            width: Number(node.width) > 0 ? Math.round(Number(node.width)) : 0,
          })
        },
      },
      toMarkdown: {
        match: base.toMarkdown.match,
        runner: (state, node) => {
          const { src, alt, caption, width } = node.attrs
          if (width > 0) {
            let tag = `<img src="${escapeAttr(src)}"`
            if (alt) tag += ` alt="${escapeAttr(alt)}"`
            if (caption) tag += ` title="${escapeAttr(caption)}"`
            tag += ` width="${Math.round(width)}" />`
            state.addNode('html', undefined, tag)
            return
          }
          state.openNode('paragraph')
          state.addNode('image', undefined, undefined, {
            title: caption,
            url: src,
            alt: alt ?? '',
          })
          state.closeNode()
        },
      },
    }
  })
}
