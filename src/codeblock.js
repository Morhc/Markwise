// Custom code-block config for Crepe's CodeMirror feature:
//  1. A full-opacity, high-contrast syntax highlight style (GitHub-light palette)
//     applied at highest precedence so it overrides the washed-out default.
//  2. A language list with an explicit "bash" entry (the default only exposes
//     "Shell", so searching "bash" in the picker found nothing).
import katex from 'katex'
import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting, LanguageDescription, StreamLanguage } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { Prec } from '@codemirror/state'
import { languages } from '@codemirror/language-data'
import { shell } from '@codemirror/legacy-modes/mode/shell'

// Colors come from CSS custom properties (defined in app/web/index.html) rather
// than literals, so the same highlight style follows light and dark mode without
// the editor having to be rebuilt when the appearance changes.
const highlightStyle = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment, t.meta, t.docComment], color: 'var(--mw-code-comment)' },
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.self], color: 'var(--mw-code-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: 'var(--mw-code-string)' },
  { tag: [t.number, t.bool, t.atom, t.null, t.integer, t.float], color: 'var(--mw-code-number)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: 'var(--mw-code-function)' },
  { tag: [t.variableName, t.propertyName, t.labelName], color: 'var(--mw-code-text)' },
  { tag: [t.typeName, t.className, t.namespace, t.tagName], color: 'var(--mw-code-type)' },
  { tag: [t.attributeName, t.attributeValue], color: 'var(--mw-code-function)' },
  { tag: [t.operator, t.punctuation, t.bracket, t.separator, t.derefOperator], color: 'var(--mw-code-text)' },
  { tag: [t.constant(t.variableName), t.standard(t.variableName)], color: 'var(--mw-code-number)' },
  { tag: t.invalid, color: 'var(--mw-code-invalid)' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.link, textDecoration: 'underline', color: 'var(--mw-link)' },
  { tag: t.heading, fontWeight: 'bold' },
])

// Force the base (untokenized) code text to full-strength colour as well, and
// draw a caret you can actually see. CodeMirror hides the native caret
// (`caret-color: transparent`) and draws its own as a 1.2px left border, whose
// colour its built-in theme picks from its own idea of light or dark — which
// here resolves to `#ddd`, a near-white hairline on the near-white code
// background. Take it from the same variable as the code text, so it follows
// the appearance the rest of the editor is using, and give it the width a
// caret needs to be findable.
const baseTheme = EditorView.theme({
  '.cm-content': { color: 'var(--mw-code-text)', caretColor: 'var(--mw-code-text)' },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--mw-code-text)',
    borderLeftWidth: '2px',
  },
})

export const codeMirrorTheme = [baseTheme, Prec.highest(syntaxHighlighting(highlightStyle))]

// Explicit Bash entry so the picker lists/searches "bash" (uses the shell mode).
const bash = LanguageDescription.of({
  name: 'bash',
  alias: ['sh', 'zsh', 'shell'],
  load: async () => StreamLanguage.define(shell),
})

export const codeLanguages = [bash, ...languages]


// A `$$ … $$` equation is a LaTeX *code block* in Crepe's model, so without a
// preview it shows up as a code editor: a language picker, a copy button, and a
// box of monospace source taking a couple of hundred pixels for one line of
// maths. Rendering it puts the equation itself on the page, and
// `previewOnlyByDefault` means that is what you see until you click into it —
// the source is one click away rather than always on show. Only LaTeX gets a
// preview, so every other language keeps the code block it should have.
export function renderCodePreview(language, content) {
  if (String(language).toLowerCase() !== 'latex') return null
  // An empty block has nothing to show, and an empty preview would still count
  // as one — enough to hide the editor behind a blank box.
  if (!String(content ?? '').trim()) return null
  try {
    return katex.renderToString(content, {
      displayMode: true,
      throwOnError: false,
      output: 'html',
    })
  } catch (e) {
    return null
  }
}
