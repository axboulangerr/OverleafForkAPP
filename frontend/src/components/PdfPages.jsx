import { useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

const GAP = 12
const PADDING = 16

/** Affiche uniquement les pages du PDF (canvas), sans la barre d'outils du lecteur du navigateur.
 *  À chaque nouvelle compilation, les pages sont rendues hors écran puis échangées,
 *  en conservant la position de défilement : pas de clignotement.
 *  L'activité est signalée par le parent (refresh-bar), jamais en atténuant les pages. */
export default function PdfPages({ url }) {
  const scrollRef = useRef(null)
  const pagesRef = useRef(null)
  const [width, setWidth] = useState(0)
  const [error, setError] = useState(null)

  // largeur disponible (re-rendu quand le panneau change de taille)
  useEffect(() => {
    const el = scrollRef.current
    let t
    const ro = new ResizeObserver(([entry]) => {
      clearTimeout(t)
      t = setTimeout(() => setWidth(Math.floor(entry.contentRect.width)), 150)
    })
    ro.observe(el)
    return () => { ro.disconnect(); clearTimeout(t) }
  }, [])

  useEffect(() => {
    if (!url || !width) return
    let cancelled = false
    let doc
    ;(async () => {
      try {
        doc = await pdfjs.getDocument(url).promise
        const dpr = window.devicePixelRatio || 1
        const target = width - PADDING * 2
        const frag = document.createDocumentFragment()
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n)
          const vp = page.getViewport({ scale: target / page.getViewport({ scale: 1 }).width })
          const canvas = document.createElement('canvas')
          canvas.width = Math.floor(vp.width * dpr)
          canvas.height = Math.floor(vp.height * dpr)
          canvas.style.width = `${Math.floor(vp.width)}px`
          canvas.style.height = `${Math.floor(vp.height)}px`
          canvas.className = "rounded-xs border border-border bg-card shadow-sm"
          await page.render({
            canvasContext: canvas.getContext('2d'),
            viewport: vp,
            transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
          }).promise
          if (cancelled) return
          frag.appendChild(canvas)
        }
        if (cancelled) return
        const scroller = scrollRef.current
        const ratio = scroller.scrollHeight ? scroller.scrollTop / scroller.scrollHeight : 0
        pagesRef.current.replaceChildren(frag)
        scroller.scrollTop = ratio * scroller.scrollHeight
        setError(null)
      } catch (e) {
        if (!cancelled) setError(e.message)
      }
    })()
    return () => {
      cancelled = true
      doc?.destroy()
    }
  }, [url, width])

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-background">
      {error && (
        <p className="m-4 rounded-lg border border-destructive/25 bg-destructive-surface px-4 py-3 text-destructive-ink">
          Impossible d'afficher le PDF : {error}
        </p>
      )}
      <div
        ref={pagesRef}
        className="flex flex-col items-center"
        style={{ gap: GAP, padding: PADDING }}
      />
    </div>
  )
}
