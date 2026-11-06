/** Pictogramme monochrome : une feuille cornée, encre, sans fond (DESIGN.md › Marque). */
export default function BrandMark({ className = "size-9" }) {
  return (
    <svg viewBox="0 0 36 36" className={`${className} shrink-0 text-foreground`} fill="none" aria-hidden="true">
      <path d="M9 4h13l7 7v21H9z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M22 4v7h7" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M14 18h10M14 23h10M14 28h6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}
