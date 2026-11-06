import { useCallback, useEffect, useState } from "react"
import ProjectsPage from "./pages/ProjectsPage"
import EditorPage from "./pages/EditorPage"
import { api } from "./lib/api"

/*
 * Deux pages, deux adresses :
 *   /             gestion des projets
 *   /projet/:id   édition d'un projet
 * Routeur minimal sur l'History API ; la transition de vue du navigateur remplace la surface
 * de travail (DESIGN.md › Motion : « la coquille ne cligne jamais »).
 */
function parseRoute() {
  const legacy = new URLSearchParams(window.location.search).get("project")
  if (legacy) {
    window.history.replaceState(null, "", `/projet/${legacy}`)
    return { page: "editor", pid: legacy }
  }
  const m = window.location.pathname.match(/^\/projet\/([a-f0-9]{24})\/?$/i)
  return m ? { page: "editor", pid: m[1] } : { page: "projects" }
}

export default function App() {
  const [route, setRoute] = useState(parseRoute)
  const [projects, setProjects] = useState(null) // null = en chargement
  const [error, setError] = useState(null)

  const loadProjects = useCallback(async () => {
    setProjects(null)
    setError(null)
    try {
      setProjects(await api("/projects"))
    } catch (e) {
      setError(e.message)
      setProjects([])
    }
  }, [])

  useEffect(() => {
    loadProjects()
  }, [loadProjects])

  useEffect(() => {
    const onPop = () => setRoute(parseRoute())
    window.addEventListener("popstate", onPop)
    return () => window.removeEventListener("popstate", onPop)
  }, [])

  const navigate = useCallback((path, direction) => {
    const go = () => {
      window.history.pushState(null, "", path)
      setRoute(parseRoute())
    }
    document.documentElement.dataset.nav = direction
    if (document.startViewTransition) document.startViewTransition(go)
    else go()
  }, [])

  useEffect(() => {
    const p = projects?.find((x) => x.id === route.pid)
    document.title = route.page === "editor" ? `${p?.name ?? "Projet"} · Mon Overleaf` : "Projets · Mon Overleaf"
  }, [route, projects])

  if (route.page === "editor") {
    return (
      <EditorPage
        key={route.pid}
        pid={route.pid}
        project={projects?.find((p) => p.id === route.pid)}
        onBack={() => {
          navigate("/", "back")
          loadProjects() // dates de modification et état local à jour
        }}
      />
    )
  }
  return (
    <ProjectsPage
      projects={projects}
      error={error}
      onReload={loadProjects}
      onOpen={(id) => navigate(`/projet/${id}`, "deeper")}
    />
  )
}
