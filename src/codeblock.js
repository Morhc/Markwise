// Custom code-block config for Crepe's CodeMirror feature:
//  1. A full-opacity, high-contrast syntax highlight style (GitHub-light palette)
//     applied at highest precedence so it overrides the washed-out default.
//  2. A language list with an explicit "bash" entry (the default only exposes
//     "Shell", so searching "bash" in the picker found nothing).
import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting, LanguageDescription, StreamLanguage } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { Prec } from '@codemirror/state'
import { languages } from '@codemirror/language-data'
import { shell } from '@codemirror/legacy-modes/mode/shell'

// All colors are solid (alpha = 1).
const highlightStyle = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment, t.meta, t.docComment], color: '#6a737d' },
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.self], color: '#d73a49' },
  { tag: [t.string, t.special(t.string), t.regexp, t.character], color: '#032f62' },
  { tag: [t.number, t.bool, t.atom, t.null, t.integer, t.float], color: '#005cc5' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: '#6f42c1' },
  { tag: [t.variableName, t.propertyName, t.labelName], color: '#24292e' },
  { tag: [t.typeName, t.className, t.namespace, t.tagName], color: '#22863a' },
  { tag: [t.attributeName, t.attributeValue], color: '#6f42c1' },
  { tag: [t.operator, t.punctuation, t.bracket, t.separator, t.derefOperator], color: '#24292e' },
  { tag: [t.constant(t.variableName), t.standard(t.variableName)], color: '#005cc5' },
  { tag: t.invalid, color: '#b31d28' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.link, textDecoration: 'underline', color: '#0b66c3' },
  { tag: t.heading, fontWeight: 'bold' },
])

// Force the base (untokenized) code text to full-strength black as well.
const baseTheme = EditorView.theme({
  '.cm-content': { color: '#24292e' },
})

export const codeMirrorTheme = [baseTheme, Prec.highest(syntaxHighlighting(highlightStyle))]

// Explicit Bash entry so the picker lists/searches "bash" (uses the shell mode).
const bash = LanguageDescription.of({
  name: 'bash',
  alias: ['sh', 'zsh', 'shell'],
  load: async () => StreamLanguage.define(shell),
})

export const codeLanguages = [bash, ...languages]
