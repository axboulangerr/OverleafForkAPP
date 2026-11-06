// Code LaTeX à insérer pour une image ou une vidéo du projet (compilation pdfLaTeX, comme Overleaf par défaut).

/** Formats d'image que pdfLaTeX sait inclure directement. */
export const PDFLATEX_IMAGE_EXT = ["png", "jpg", "jpeg", "pdf", "eps"]

const ext = (path) => path.split(".").pop().toLowerCase()
const base = (path) => path.split("/").pop().replace(/\.[^.]+$/, "")

export function imageSupport(path) {
  const e = ext(path)
  if (PDFLATEX_IMAGE_EXT.includes(e)) return { ok: true }
  if (e === "svg") return { ok: false, reason: "pdfLaTeX n'inclut pas le SVG : exporte-le en PDF ou en PNG." }
  return { ok: false, reason: `pdfLaTeX n'inclut pas le format .${e} : convertis l'image en PNG ou en JPG.` }
}

const caption = (path) =>
  base(path)
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/([#$%&_{}~^\\])/g, "\\$1")

const label = (path) =>
  base(path)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")

/** Renvoie { code, packages } pour un fichier image ou vidéo (chemin relatif à la racine du projet). */
export function snippetFor(entry) {
  const path = entry.path
  if (entry.kind === "video") {
    return {
      packages: ["hyperref"],
      code: [
        `% Vidéo : un PDF compilé avec pdfLaTeX ne lit pas les vidéos.`,
        `% Ce lien ouvre le fichier dans les lecteurs PDF qui l'autorisent (pas dans un navigateur).`,
        `\\href{run:${path}}{\\texttt{${caption(path)}} (vidéo)}`,
        ``,
      ].join("\n"),
    }
  }
  return {
    packages: ["graphicx"],
    code: [
      `\\begin{figure}[htbp]`,
      `  \\centering`,
      `  \\includegraphics[width=0.8\\textwidth]{${path}}`,
      `  \\caption{${caption(path)}}`,
      `  \\label{fig:${label(path)}}`,
      `\\end{figure}`,
      ``,
    ].join("\n"),
  }
}

/**
 * Ajoute les \usepackage manquants juste avant \begin{document}.
 * Renvoie la liste des changements CodeMirror à appliquer (vide si rien à faire).
 */
export function missingPackageChanges(docText, packages) {
  const begin = docText.indexOf("\\begin{document}")
  if (begin < 0) return []
  const preamble = docText.slice(0, begin)
  const missing = packages.filter(
    (p) => !new RegExp(`\\\\usepackage(\\[[^\\]]*\\])?\\{[^}]*\\b${p}\\b[^}]*\\}`).test(preamble),
  )
  if (!missing.length) return []
  return [{ from: begin, insert: missing.map((p) => `\\usepackage{${p}}\n`).join("") + "\n" }]
}
