import { useEffect, useRef } from "react"

export const cn = (...c) => c.filter(Boolean).join(" ")

/* --- Boutons : coins 4 px, transition 150 ms sur couleur/fond/bordure, jamais sur la géométrie --- */
const BUTTON_VARIANTS = {
  default: "bg-primary text-primary-foreground hover:bg-primary/90",
  outline:
    "border border-border bg-background shadow-xs hover:bg-accent hover:border-foreground/20",
  secondary: "border border-transparent bg-secondary text-secondary-foreground hover:bg-accent",
  ghost: "hover:bg-accent",
}
const BUTTON_SIZES = {
  default: "h-9 px-4",
  sm: "h-8 px-3",
  lg: "h-10 px-6",
  icon: "size-9",
  "icon-sm": "size-8",
}

export function Button({ variant = "default", size = "default", className, ...props }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium",
        "transition-[color,background-color,border-color,box-shadow] duration-150",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        "[&_svg]:size-4 [&_svg]:shrink-0",
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
      {...props}
    />
  )
}

/* --- Badges : pilule, bordure incluse dans toutes les variantes --- */
const BADGE_VARIANTS = {
  secondary: "bg-secondary text-secondary-foreground border-transparent",
  alert: "bg-destructive-surface text-destructive-ink border-destructive/25",
  success: "bg-success-surface text-success border-success/20",
  warning: "bg-warning-surface text-warning border-warning-edge/50",
  outline: "bg-card text-muted-foreground border-border",
}

export function Badge({ variant = "secondary", className, ...props }) {
  return (
    <span
      data-slot="badge"
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium tracking-wide",
        BADGE_VARIANTS[variant],
        className,
      )}
      {...props}
    />
  )
}

/* --- Rail d'onglets en pilule --- */
export function TabRail({ value, onChange, items }) {
  return (
    <div role="tablist" className="inline-flex h-10 items-center rounded-full bg-accent p-1">
      {items.map((it) => (
        <button
          key={it.value}
          role="tab"
          type="button"
          aria-selected={value === it.value}
          onClick={() => onChange(it.value)}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-sm font-medium transition-colors duration-150",
            value === it.value
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {it.label}
          {it.extra}
        </button>
      ))}
    </div>
  )
}

/* --- Alerte : coins 8 px, matière de surface, jamais de liseré latéral coloré --- */
const ALERT_VARIANTS = {
  default: "bg-card text-foreground [&>svg]:text-muted-foreground",
  destructive: "bg-destructive-surface text-destructive-ink border-destructive/25",
  warning: "bg-warning-surface text-warning border-warning-edge/50",
  success: "bg-success-surface text-success border-success/20",
}

export function Alert({ variant = "default", icon: Icon, className, children, ...props }) {
  return (
    <div
      role={variant === "destructive" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-3 rounded-lg border px-4 py-3 text-sm",
        ALERT_VARIANTS[variant],
        className,
      )}
      {...props}
    >
      {Icon && <Icon className="mt-0.5 size-4 shrink-0" />}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

/* --- État vide : bloc centré, icône 32 px ardoise --- */
export function EmptyState({ icon: Icon, title, description, action, className }) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 px-6 py-12 text-center",
        className,
      )}
    >
      {Icon && <Icon className="size-8 text-muted-foreground" strokeWidth={1.5} />}
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="max-w-[40ch] text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export function Skeleton({ className, ...props }) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-skeleton rounded-md bg-accent", className)}
      {...props}
    />
  )
}

/* --- Dialogue : se pose de 8 px, voile encre, reste ouvert pendant l'appel réseau --- */
export function Dialog({ open, title, description, children, footer, onClose, className }) {
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const onKey = (e) => e.key === "Escape" && onClose?.()
    window.addEventListener("keydown", onKey)
    ref.current?.querySelector("input, button:not([data-close])")?.focus()
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <div
        data-slot="dialog-overlay"
        className="absolute inset-0 animate-scrim-in bg-foreground/40"
        onClick={onClose}
      />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        data-slot="dialog-content"
        className={cn("relative flex max-h-[calc(100dvh-2rem)] w-full max-w-md animate-dialog-in flex-col gap-4 overflow-y-auto rounded-lg border bg-card p-6 shadow-lg", className)}
      >
        <div className="flex flex-col gap-1.5">
          <h2 id="dialog-title" className="font-display text-base font-semibold tracking-[-0.01em]">
            {title}
          </h2>
          {description && <p className="text-muted-foreground">{description}</p>}
        </div>
        {children}
        {footer && <div className="flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  )
}
