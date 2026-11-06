// Extrait erreurs et avertissements d'un log LaTeX (formats "-file-line-error" et classique "! ... l.N").
export function parseLog(log) {
  const lines = (log || '').split('\n')
  const errors = []
  const warnings = []

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]

    // ./chapitres/intro.tex:42: Undefined control sequence.
    const fle = l.match(/^(?:\.\/)?([^:\s][^:]*\.(?:tex|sty|cls|bib|bbl)):(\d+): (.*)$/)
    if (fle) {
      errors.push({ file: fle[1], line: +fle[2], message: fle[3], context: lines.slice(i + 1, i + 3).join('\n') })
      continue
    }

    // ! Undefined control sequence.   ...   l.42 \foo
    if (l.startsWith('! ')) {
      let line = null
      for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
        const m = lines[j].match(/^l\.(\d+)/)
        if (m) { line = +m[1]; break }
      }
      // évite les doublons avec le format file-line-error
      if (!errors.some((e) => e.message === l.slice(2) && e.line === line)) {
        errors.push({ file: null, line, message: l.slice(2), context: lines.slice(i + 1, i + 3).join('\n') })
      }
      continue
    }

    const w = l.match(/^(?:LaTeX|Package \S+) Warning: (.*?)(?: on input line (\d+))?\.?$/)
    if (w) warnings.push({ message: w[1], line: w[2] ? +w[2] : null })
    else if (/^(Over|Under)full \\[hv]box/.test(l)) {
      const m = l.match(/lines? (\d+)/)
      warnings.push({ message: l, line: m ? +m[1] : null, box: true })
    }
  }
  return { errors: dedupe(errors, (e) => `${e.file}|${e.line}|${e.message}`), warnings: dedupe(warnings, (w) => `${w.line}|${w.message}`) }
}

// LaTeX répète les mêmes messages à chaque passe : on les regroupe avec un compteur.
function dedupe(items, key) {
  const seen = new Map()
  for (const it of items) {
    const k = key(it)
    if (seen.has(k)) seen.get(k).count++
    else seen.set(k, { ...it, count: 1 })
  }
  return [...seen.values()]
}
