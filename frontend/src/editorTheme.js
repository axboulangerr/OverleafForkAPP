import { EditorView } from "@codemirror/view"
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language"
import { tags as t } from "@lezer/highlight"

// La feuille : blanc, gouttière discrète, curseur rouge marque, sélection rose de marque.
const sheet = EditorView.theme({
  "&": { backgroundColor: "var(--card)", color: "var(--foreground)" },
  ".cm-content": { caretColor: "var(--primary)", padding: "12px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--primary)", borderLeftWidth: "2px" },
  ".cm-gutters": {
    backgroundColor: "var(--card)",
    color: "var(--faint)",
    border: "none",
    borderRight: "1px solid var(--border)",
  },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 12px 0 16px", fontVariantNumeric: "tabular-nums" },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklab, var(--accent) 55%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--foreground)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--selection) !important",
  },
  ".cm-line": { padding: "0 16px" },
  ".cm-foldGutter .cm-gutterElement": { color: "var(--faint)" },
})

// Encre et ardoise : le rouge n'est pas une couleur de syntaxe.
const ink = HighlightStyle.define([
  { tag: [t.keyword, t.tagName], color: "var(--foreground)", fontWeight: "600" },
  { tag: [t.comment, t.lineComment], color: "var(--faint)", fontStyle: "italic" },
  { tag: [t.bracket, t.paren, t.squareBracket, t.brace], color: "var(--muted-foreground)" },
  { tag: [t.atom, t.number], color: "var(--success)" },
  { tag: [t.string, t.special(t.string)], color: "var(--warning)" },
  { tag: [t.variableName, t.typeName], color: "var(--muted-foreground)" },
])

export const editorTheme = [sheet, syntaxHighlighting(ink)]
