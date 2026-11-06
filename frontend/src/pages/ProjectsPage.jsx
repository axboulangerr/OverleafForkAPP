import { useMemo, useState } from "react"
import {
  AlertCircle,
  ExternalLink,
  FileText,
  FolderOpen,
  HardDrive,
  Loader2,
  Plus,
  RefreshCw,
  Search,
} from "lucide-react"
import BrandMark from "../components/BrandMark"
import { Alert, Badge, Button, Dialog, EmptyState, Skeleton, TabRail, cn } from "../components/ui"
import { ACCESS_LABELS, api, fmtDate, fmtRelative } from "../lib/api"

const FILTERS = [
  { value: "all", label: "Tous", test: (p) => !p.archived },
  { value: "mine", label: "Mes projets", test: (p) => !p.archived && p.access === "owner" },
  { value: "shared", label: "Partagés avec moi", test: (p) => !p.archived && p.access !== "owner" },
  { value: "archived", label: "Archivés", test: (p) => p.archived },
]

export default function ProjectsPage({ projects, error, onReload, onOpen }) {
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState("all")
  const [createOpen, setCreateOpen] = useState(false)

  const me = projects?.find((p) => p.access === "owner")?.owner
  const loading = projects === null

  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map((f) => [f.value, (projects ?? []).filter(f.test).length])),
    [projects],
  )

  const shown = useMemo(() => {
    const test = FILTERS.find((f) => f.value === filter).test
    const q = query.trim().toLowerCase()
    return (projects ?? []).filter((p) => test(p) && (!q || p.name.toLowerCase().includes(q)))
  }, [projects, filter, query])

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* ---------- Rampe de commande : marque → création → destinations → utilitaires ---------- */}
      <aside className="flex w-72 shrink-0 flex-col border-r bg-sidebar">
        <div className="flex h-15 shrink-0 items-center gap-3 border-b px-4">
          <BrandMark />
          <span className="font-display text-xl font-semibold tracking-[-0.01em]">Mon Overleaf</span>
        </div>

        <div className="p-4">
          <Button className="h-11 w-full" onClick={() => setCreateOpen(true)} disabled={loading || !!error}>
            <Plus />
            Nouveau projet
          </Button>
        </div>

        <nav className="flex flex-col gap-0.5 px-2">
          <a
            href="/"
            aria-current="page"
            className="flex h-9 items-center gap-2 rounded-md bg-secondary px-3 text-sm font-medium"
          >
            <FolderOpen className="size-4 text-muted-foreground" />
            Projets
          </a>
        </nav>

        <div className="mt-auto border-t p-4">
          <div className="group relative flex items-center gap-2 text-sm" tabIndex={0}>
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                error ? "bg-destructive" : loading ? "bg-faint/50" : "bg-success",
              )}
            />
            <span className="truncate text-muted-foreground">
              {error ? "Overleaf injoignable" : loading ? "Connexion…" : me ? me : "Connecté à Overleaf"}
            </span>
            <span className="pointer-events-none absolute bottom-full left-0 mb-2 hidden rounded-md border bg-popover px-2 py-1 font-mono text-xs whitespace-nowrap shadow-lg group-hover:block group-focus:block">
              www.overleaf.com · cookie de session
            </span>
          </div>
        </div>
      </aside>

      {/* ---------- Surface de travail ---------- */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="relative flex h-15 shrink-0 items-center gap-4 border-b bg-card px-4">
          {loading && <div className="refresh-bar" />}
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="label-caps text-[0.6875rem]">Espace de travail</span>
            <h1 className="truncate font-display text-xl font-semibold tracking-[-0.01em]">Projets</h1>
          </div>
          <Button variant="outline" className="ml-auto" onClick={onReload} disabled={loading}>
            <RefreshCw className={cn(loading && "animate-spin")} />
            Actualiser
          </Button>
        </header>

        <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4 lg:px-8">
          {error && (
            <Alert variant="destructive" icon={AlertCircle}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="font-medium">Impossible de joindre ton compte Overleaf</p>
                  <p className="break-words">{error}</p>
                </div>
                <Button variant="outline" size="sm" onClick={onReload}>
                  Réessayer
                </Button>
              </div>
            </Alert>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <div className="relative w-full max-w-sm">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Rechercher un projet"
                aria-label="Rechercher un projet"
                className="h-9 w-full rounded-md border border-input bg-card pr-3 pl-9 text-sm shadow-xs transition-[border-color,box-shadow] duration-150 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none [&::-webkit-search-cancel-button]:hidden"
              />
            </div>
            <TabRail
              value={filter}
              onChange={setFilter}
              items={FILTERS.map((f) => ({
                value: f.value,
                label: f.label,
                extra: !loading && (
                  <Badge variant="secondary" className="px-1.5 py-0">
                    {counts[f.value]}
                  </Badge>
                ),
              }))}
            />
          </div>

          <div className="overflow-hidden rounded-lg border bg-card shadow-sm">
            <table className="w-full table-fixed text-left text-sm tabular-nums">
              <thead className="bg-muted/30">
                <tr className="border-b">
                  <th className="label-caps px-4 py-2.5 font-medium">Nom</th>
                  <th className="label-caps hidden w-48 px-4 py-2.5 font-medium md:table-cell">Propriétaire</th>
                  <th className="label-caps hidden w-40 px-4 py-2.5 font-medium sm:table-cell">Modifié</th>
                  <th className="label-caps hidden w-40 px-4 py-2.5 font-medium lg:table-cell">Sur ce poste</th>
                  <th className="w-12 px-2 py-2.5">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {loading &&
                  [60, 45, 70, 35].map((w) => (
                    <tr key={w} className="border-b last:border-0">
                      <td className="px-4 py-3">
                        <Skeleton className="h-4" style={{ width: `${w}%` }} />
                        <Skeleton className="mt-1.5 h-3 w-24" />
                      </td>
                      <td className="hidden px-4 py-3 md:table-cell">
                        <Skeleton className="h-4 w-28" />
                      </td>
                      <td className="hidden px-4 py-3 sm:table-cell">
                        <Skeleton className="h-4 w-20" />
                      </td>
                      <td className="hidden px-4 py-3 lg:table-cell">
                        <Skeleton className="h-5 w-24 rounded-full" />
                      </td>
                      <td />
                    </tr>
                  ))}

                {shown.map((p) => (
                  <tr
                    key={p.id}
                    role="link"
                    tabIndex={0}
                    onClick={() => onOpen(p.id)}
                    onKeyDown={(e) => {
                      if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
                        e.preventDefault()
                        onOpen(p.id)
                      }
                    }}
                    className="group cursor-pointer border-b transition-colors duration-150 last:border-0 hover:bg-accent/50 focus-visible:bg-accent/50"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <FileText className="size-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0">
                          <p className="truncate font-medium">{p.name}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {ACCESS_LABELS[p.access] ?? p.access}
                            {p.lastUpdatedBy && ` · modifié par ${p.lastUpdatedBy}`}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="hidden truncate px-4 py-3 text-muted-foreground md:table-cell">{p.owner ?? "—"}</td>
                    <td className="hidden px-4 py-3 whitespace-nowrap text-muted-foreground sm:table-cell">
                      <time dateTime={p.lastUpdated} title={fmtDate(p.lastUpdated)}>
                        {fmtRelative(p.lastUpdated)}
                      </time>
                    </td>
                    <td className="hidden px-4 py-3 lg:table-cell">
                      {p.hasPdf ? (
                        <Badge variant="success">PDF compilé</Badge>
                      ) : p.local ? (
                        <Badge variant="outline">
                          <HardDrive className="size-3" />
                          Téléchargé
                        </Badge>
                      ) : (
                        <span className="text-faint">—</span>
                      )}
                    </td>
                    <td className="px-2 py-3 text-right">
                      <a
                        href={`https://www.overleaf.com/project/${p.id}`}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        title="Ouvrir sur overleaf.com"
                        aria-label={`Ouvrir ${p.name} sur overleaf.com`}
                        className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-[opacity,background-color] duration-150 group-hover:opacity-100 group-focus-visible:opacity-100 hover:bg-accent focus-visible:opacity-100"
                      >
                        <ExternalLink className="size-4" />
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {!loading && shown.length === 0 && (
              <EmptyState
                icon={FolderOpen}
                className="py-12"
                title={query ? "Aucun projet ne correspond" : "Aucun projet ici"}
                description={
                  query
                    ? `Rien ne contient « ${query} » dans cette catégorie.`
                    : filter === "archived"
                      ? "Les projets archivés sur overleaf.com apparaissent ici."
                      : "Crée un projet pour commencer."
                }
                action={
                  query ? (
                    <Button variant="outline" size="sm" onClick={() => setQuery("")}>
                      Effacer la recherche
                    </Button>
                  ) : null
                }
              />
            )}
          </div>
        </main>
      </div>

      <NewProjectDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(id) => {
          setCreateOpen(false)
          onReload()
          onOpen(id)
        }}
      />
    </div>
  )
}

function NewProjectDialog({ open, onClose, onCreated }) {
  const [name, setName] = useState("")
  const [template, setTemplate] = useState("none")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  const submit = async (e) => {
    e?.preventDefault()
    if (!name.trim() || busy) return
    setBusy(true)
    setError("")
    try {
      const { id } = await api("/projects", { method: "POST", body: JSON.stringify({ name, template }) })
      setName("")
      onCreated(id)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      title="Nouveau projet"
      description="Le projet est créé sur overleaf.com, puis ouvert dans l'éditeur."
      onClose={() => !busy && onClose()}
      footer={
        <>
          <Button variant="outline" onClick={onClose} disabled={busy} data-close>
            Annuler
          </Button>
          <Button onClick={submit} disabled={!name.trim() || busy}>
            {busy && <Loader2 className="animate-spin" />}
            Créer le projet
          </Button>
        </>
      }
    >
      <form onSubmit={submit} className="flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Nom</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Rapport de stage"
            aria-invalid={!!error || undefined}
            className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs transition-[border-color,box-shadow] duration-150 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none aria-invalid:border-destructive aria-invalid:ring-destructive/20"
          />
        </label>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-sm font-medium">Modèle</legend>
          <div className="grid grid-cols-2 gap-2">
            {[
              { value: "none", title: "Vide", desc: "Un main.tex minimal" },
              { value: "example", title: "Exemple", desc: "Le projet d'exemple d'Overleaf" },
            ].map((t) => (
              <label
                key={t.value}
                className={cn(
                  "flex cursor-pointer flex-col gap-0.5 rounded-md border px-3 py-2 transition-colors duration-150",
                  template === t.value ? "border-foreground bg-accent" : "hover:border-foreground/20",
                )}
              >
                <input
                  type="radio"
                  name="template"
                  value={t.value}
                  checked={template === t.value}
                  onChange={() => setTemplate(t.value)}
                  className="sr-only"
                />
                <span className="text-sm font-medium">{t.title}</span>
                <span className="text-xs text-muted-foreground">{t.desc}</span>
              </label>
            ))}
          </div>
        </fieldset>
        {error && <p className="text-sm text-destructive-ink">{error}</p>}
      </form>
    </Dialog>
  )
}
