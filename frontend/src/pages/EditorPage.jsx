import { useCallback, useEffect, useRef, useState } from "react"
import CodeMirror from "@uiw/react-codemirror"
import { EditorView } from "@codemirror/view"
import { StreamLanguage } from "@codemirror/language"
import { stex } from "@codemirror/legacy-modes/mode/stex"
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  Download,
  ExternalLink,
  FilePlus,
  FileText,
  FolderPlus,
  ImagePlus,
  Loader2,
  Play,
  ScrollText,
  Trash2,
  Upload,
  X,
} from "lucide-react"
import { parseLog } from "../logParser"
import { editorTheme } from "../editorTheme"
import PdfPages from "../components/PdfPages"
import AiChat from "../components/AiChat"
import FileTree from "../components/FileTree"
import { imageSupport, missingPackageChanges, snippetFor } from "../lib/latexSnippets"
import { Alert, Badge, Button, Dialog, EmptyState, Skeleton, TabRail, cn } from "../components/ui"
import { api, fmtTime, loadPref, savePref, sleep } from "../lib/api"

const latex = StreamLanguage.define(stex)
const inputCls =
  "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs transition-[border-color,box-shadow] duration-150 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
const AUTOSAVE_MS = 800

/** Page d'édition d'un projet : fichiers · source LaTeX · PDF, plein écran. */
export default function EditorPage({ pid, project, onBack }) {
  const [files, setFiles] = useState([])
  const [current, setCurrent] = useState(null)
  const [content, setContent] = useState("")
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")

  // compilation
  const [autoCompile, setAutoCompile] = useState(() => loadPref("autoCompile", true))
  const [compile, setCompile] = useState({ state: "idle" }) // idle | compiling | success | error
  const [log, setLog] = useState("")
  const [issues, setIssues] = useState({ errors: [], warnings: [] })
  const [pdfUrl, setPdfUrl] = useState(null)
  const [tab, setTab] = useState("pdf")

  // dialogues
  const [newFileOpen, setNewFileOpen] = useState(false)
  // gestion des fichiers
  const [targetFolder, setTargetFolder] = useState("") // dossier où vont les ajouts
  const [uploading, setUploading] = useState([]) // noms en cours d'envoi
  const [folderDialog, setFolderDialog] = useState(null) // { name }
  const [renameDialog, setRenameDialog] = useState(null) // { entry, name }
  const [deleteDialog, setDeleteDialog] = useState(null) // entry
  const [preview, setPreview] = useState(null) // entry image / vidéo
  const [dialogBusy, setDialogBusy] = useState(false)
  const uploadInput = useRef(null)
  const [newFileName, setNewFileName] = useState("")
  const [pullConfirm, setPullConfirm] = useState(false)

  // refs : valeurs à jour dans les callbacks asynchrones
  const pidRef = useRef(pid)
  const currentRef = useRef(null)
  const contentRef = useRef("")
  const dirtyRef = useRef(false)
  const autoRef = useRef(autoCompile)
  const compilingRef = useRef(false)
  const pendingRef = useRef(false)
  const saveTimer = useRef(null)
  const viewRef = useRef(null)
  const pendingJump = useRef(null)

  useEffect(() => {
    currentRef.current = current
  }, [current])
  useEffect(() => {
    autoRef.current = autoCompile
    savePref("autoCompile", autoCompile)
  }, [autoCompile])

  const run = async (label, fn) => {
    setBusy(label)
    setError("")
    try {
      await fn()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy("")
    }
  }

  const refreshFiles = useCallback(async () => {
    if (pidRef.current) setFiles(await api(`/projects/${pidRef.current}/files`))
  }, [])

  // --- sauvegarde ---
  const saveNow = useCallback(async () => {
    clearTimeout(saveTimer.current)
    const id = pidRef.current
    const path = currentRef.current
    if (!id || !path || !dirtyRef.current) return false
    const text = contentRef.current
    await api(`/projects/${id}/file`, { method: "PUT", body: JSON.stringify({ path, content: text }) })
    if (contentRef.current === text) {
      dirtyRef.current = false
      setDirty(false)
    }
    return true
  }, [])

  // --- compilation : jamais deux en parallèle, au plus une en attente ---
  const runCompile = useCallback(async () => {
    const id = pidRef.current
    if (!id) return
    if (compilingRef.current) {
      pendingRef.current = true
      return
    }
    compilingRef.current = true
    setCompile((c) => ({ ...c, state: "compiling" }))
    try {
      await saveNow()
      let r
      for (let attempt = 0; attempt < 5; attempt++) {
        r = await api(`/projects/${id}/compile`, { method: "POST" })
        if (!["too-recently-compiled", "compile-in-progress"].includes(r.status)) break
        await sleep(1500)
      }
      if (pidRef.current !== id) return
      setLog(r.log)
      const parsed = parseLog(r.log)
      setIssues(parsed)
      if (r.ok) setPdfUrl(`/api/projects/${id}/pdf?t=${Date.now()}`)
      setCompile({
        state: r.ok && parsed.errors.length === 0 ? "success" : "error",
        status: r.status,
        duration: r.duration,
        at: new Date(),
        noPdf: !r.ok,
      })
      if (!r.ok) setTab("log")
      refreshFiles()
    } catch (e) {
      setCompile({ state: "error", status: e.message, at: new Date(), noPdf: true })
    } finally {
      compilingRef.current = false
      if (pendingRef.current) {
        pendingRef.current = false
        runCompile()
      }
    }
  }, [saveNow, refreshFiles])

  const saveAndMaybeCompile = useCallback(
    async (force = false) => {
      try {
        const saved = await saveNow()
        if (force || (saved && autoRef.current)) runCompile()
        else if (saved) refreshFiles()
      } catch (e) {
        setError(e.message)
      }
    },
    [saveNow, runCompile, refreshFiles],
  )

  // Cmd/Ctrl+S : sauvegarde et compilation immédiates
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault()
        saveAndMaybeCompile(true)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [saveAndMaybeCompile])

  const onChange = (val) => {
    contentRef.current = val
    dirtyRef.current = true
    setContent(val)
    setDirty(true)
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => saveAndMaybeCompile(false), AUTOSAVE_MS)
  }

  // --- navigation ---
  const loadFile = async (id, path) => {
    const d = await api(`/projects/${id}/file?path=${encodeURIComponent(path)}`)
    contentRef.current = d.content
    dirtyRef.current = false
    currentRef.current = path
    setCurrent(path)
    setContent(d.content)
    setDirty(false)
  }

  const openProject = (id) =>
    run("Téléchargement du projet…", async () => {
      await saveNow()
      pidRef.current = id
      setCurrent(null)
      setFiles([])
      setLog("")
      setIssues({ errors: [], warnings: [] })
      setCompile({ state: "idle" })
      setTab("pdf")
      const f = await api(`/projects/${id}/files`)
      setFiles(f)
      const { exists } = await api(`/projects/${id}/has-pdf`)
      setPdfUrl(exists ? `/api/projects/${id}/pdf?t=${Date.now()}` : null)
      const main = f.find((x) => x.path === "main.tex") || f.find((x) => x.path.endsWith(".tex"))
      if (main) await loadFile(id, main.path)
      runCompile()
    })

  const openFile = (f) =>
    run("", async () => {
      await saveNow()
      if (!f.text) {
        if (f.kind === "image" || f.kind === "video") setPreview(f)
        else window.open(`/api/projects/${pid}/file?path=${encodeURIComponent(f.path)}`, "_blank")
        return
      }
      await loadFile(pid, f.path)
    })

  const jumpTo = (line) => {
    const view = viewRef.current
    if (!view || !line) return
    const l = view.state.doc.line(Math.min(Math.max(line, 1), view.state.doc.lines))
    view.dispatch({
      selection: { anchor: l.from, head: l.to },
      effects: EditorView.scrollIntoView(l.from, { y: "center" }),
    })
    view.focus()
  }

  const goToIssue = async (err) => {
    if (err.file && err.file !== current && files.some((f) => f.path === err.file)) {
      await saveNow()
      pendingJump.current = err.line
      await loadFile(pid, err.file)
    } else jumpTo(err.line)
  }

  useEffect(() => {
    if (pendingJump.current && viewRef.current) {
      const line = pendingJump.current
      pendingJump.current = null
      setTimeout(() => jumpTo(line), 50)
    }
  }, [current])

  // Claude a modifié des fichiers sur le disque : on recharge l'éditeur puis on recompile
  // (la compilation envoie d'abord les fichiers modifiés sur overleaf.com).
  const onAgentEdited = async (paths) => {
    try {
      await refreshFiles()
      const path = currentRef.current
      if (path && paths.includes(path)) await loadFile(pidRef.current, path)
      runCompile()
    } catch (e) {
      setError(e.message)
    }
  }

  const pendingCount = files.filter((f) => f.changed).length

  const doPull = () =>
    run("Récupération depuis Overleaf…", async () => {
      setPullConfirm(false)
      await api(`/projects/${pid}/download`, { method: "POST" })
      await refreshFiles()
      if (current) await loadFile(pid, current).catch(() => setCurrent(null))
      runCompile()
    })

  const pull = () => (pendingCount ? setPullConfirm(true) : doPull())

  const join = (folder, name) => (folder ? `${folder}/${name}` : name)
  const fileUrl = (path) => `/api/projects/${pid}/file?path=${encodeURIComponent(path)}`

  // Envoi d'images, vidéos… dans le dossier cible : disque local + overleaf.com en une fois
  const uploadFiles = async (list, folder = targetFolder) => {
    const picked = [...list]
    if (!picked.length) return
    setUploading(picked.map((f) => f.name))
    setError("")
    try {
      const form = new FormData()
      picked.forEach((f) => form.append("files", f))
      form.append("folder", folder)
      const res = await fetch(`/api/projects/${pid}/upload`, { method: "POST", body: form })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.detail || res.statusText)
      await refreshFiles()
      setTargetFolder(folder)
    } catch (e) {
      setError(e.message)
    } finally {
      setUploading([])
    }
  }

  const withDialog = async (fn) => {
    setDialogBusy(true)
    setError("")
    try {
      await fn()
    } catch (e) {
      setError(e.message)
    } finally {
      setDialogBusy(false)
    }
  }

  const createFolder = (e) => {
    e?.preventDefault()
    const name = folderDialog?.name.trim()
    if (!name) return
    withDialog(async () => {
      const { path } = await api(`/projects/${pid}/folder`, {
        method: "POST",
        body: JSON.stringify({ path: join(targetFolder, name) }),
      })
      await refreshFiles()
      setTargetFolder(path)
      setFolderDialog(null)
    })
  }

  const renameEntry = (e) => {
    e?.preventDefault()
    const { entry, name } = renameDialog
    if (!name.trim() || name.trim() === entry.name) return setRenameDialog(null)
    withDialog(async () => {
      await saveNow()
      const { path } = await api(`/projects/${pid}/rename`, {
        method: "POST",
        body: JSON.stringify({ path: entry.path, name: name.trim() }),
      })
      // le fichier ouvert (ou son dossier) a été renommé : on suit le nouveau chemin
      const cur = currentRef.current
      if (cur === entry.path || cur?.startsWith(entry.path + "/")) {
        const moved = path + cur.slice(entry.path.length)
        currentRef.current = moved
        setCurrent(moved)
      }
      if (targetFolder === entry.path) setTargetFolder(path)
      await refreshFiles()
      setRenameDialog(null)
    })
  }

  const deleteEntry = () =>
    withDialog(async () => {
      const entry = deleteDialog
      const cur = currentRef.current
      if (cur === entry.path || cur?.startsWith(entry.path + "/")) {
        await saveNow().catch(() => {})
        currentRef.current = null
        setCurrent(null)
      }
      await api(`/projects/${pid}/entity?path=${encodeURIComponent(entry.path)}`, { method: "DELETE" })
      if (targetFolder === entry.path || targetFolder.startsWith(entry.path + "/")) setTargetFolder("")
      if (preview?.path === entry.path) setPreview(null)
      await refreshFiles()
      setDeleteDialog(null)
    })

  // Insère \includegraphics (ou un lien vidéo) dans le fichier .tex ouvert, à l'endroit du curseur
  const insertMedia = async (entry) => {
    try {
      let target = currentRef.current
      if (!target?.endsWith(".tex")) {
        const main = files.find((f) => f.path === "main.tex") || files.find((f) => f.path.endsWith(".tex"))
        if (!main) throw new Error("Aucun fichier .tex où insérer l'image")
        await saveNow()
        await loadFile(pid, main.path)
        target = main.path
      }
      for (let i = 0; i < 20 && !viewRef.current; i++) await sleep(25) // l'éditeur peut être en train de monter
      const view = viewRef.current
      const text = view.state.doc.toString()
      const { code, packages } = snippetFor(entry)
      const begin = text.indexOf("\\begin{document}")
      const end = text.indexOf("\\end{document}")
      let pos = view.state.selection.main.head
      // curseur dans le préambule ou après \end{document} : on insère juste avant \end{document}
      if (begin >= 0 && (pos <= begin || (end >= 0 && pos > end))) pos = end >= 0 ? end : text.length
      const line = view.state.doc.lineAt(pos)
      const prefix = pos === line.from ? "" : "\n"
      const insert = `${prefix}${code}`
      view.dispatch({
        changes: [...missingPackageChanges(text, packages), { from: pos, insert }],
        selection: { anchor: pos + insert.length },
        scrollIntoView: true,
      })
      view.focus()
      setPreview(null)
    } catch (e) {
      setError(e.message)
    }
  }

  const createFile = (e) => {
    e?.preventDefault()
    const path = newFileName.trim()
    if (!path) return
    run("Création du fichier…", async () => {
      await saveNow()
      await api(`/projects/${pid}/file`, { method: "PUT", body: JSON.stringify({ path, content: "" }) })
      await refreshFiles()
      await loadFile(pid, path)
      setNewFileOpen(false)
      setNewFileName("")
    })
  }

  // Ouverture du projet à l'arrivée sur la page (et à chaque changement d'id)
  useEffect(() => {
    openProject(pid)
  }, [pid]) // eslint-disable-line react-hooks/exhaustive-deps

  const back = async () => {
    try {
      await saveNow()
    } finally {
      onBack()
    }
  }

  const shownWarnings = issues.warnings.filter((w) => !w.box).length

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      {/* ---------- Bandeau du projet ---------- */}
      <header className="relative flex h-15 shrink-0 items-center gap-3 border-b bg-card px-3">
        {busy && <div className="refresh-bar" />}
        <Button variant="ghost" onClick={back} className="px-3" title="Retour aux projets">
          <ArrowLeft />
          Projets
        </Button>
        <span className="h-6 w-px bg-border" aria-hidden="true" />
        <div className="flex min-w-0 flex-col leading-tight">
          <span className="label-caps text-[0.6875rem]">Projet</span>
          <h1 className="truncate font-display text-xl font-semibold tracking-[-0.01em]">
            {project?.name ?? "Chargement…"}
          </h1>
        </div>
          <div className="ml-auto flex items-center gap-4">
            {current && <SaveState dirty={dirty} />}
            {(
              <TabRail
                value={tab}
                onChange={setTab}
                items={[
                  { value: "pdf", label: "PDF" },
                  {
                    value: "log",
                    label: "Log",
                    extra: (
                      <>
                        {issues.errors.length > 0 && (
                          <Badge variant="alert" className="px-1.5 py-0">
                            {issues.errors.length}
                          </Badge>
                        )}
                        {shownWarnings > 0 && (
                          <Badge variant="warning" className="px-1.5 py-0">
                            {shownWarnings}
                          </Badge>
                        )}
                      </>
                    ),
                  },
                ]}
              />
            )}
            <CompileStatus compile={compile} issues={issues} />
            {(
              <Switch
                checked={autoCompile}
                onChange={setAutoCompile}
                label="Auto"
                hint="Recompile après chaque sauvegarde"
              />
            )}
            <Button onClick={() => saveAndMaybeCompile(true)} disabled={!pid} title="Cmd+S">
              {compile.state === "compiling" ? <Loader2 className="animate-spin" /> : <Play />}
              Recompiler
            </Button>
          </div>
      </header>

      {error && (
        <div className="border-b bg-card px-4 py-3">
          <Alert variant="destructive" icon={AlertCircle}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="font-medium">L'opération a échoué</p>
                <p className="break-words">{error}</p>
              </div>
              <Button variant="ghost" size="icon-sm" onClick={() => setError("")} aria-label="Fermer">
                <X />
              </Button>
            </div>
          </Alert>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* ---------- Fichiers du projet ---------- */}
        <aside className="flex w-72 shrink-0 flex-col border-r bg-sidebar">
          <div className="flex h-11 shrink-0 items-center justify-between pr-1.5 pl-4">
            <span className="label-caps">Fichiers</span>
            <div className="flex items-center">
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => {
                  setNewFileName(targetFolder ? `${targetFolder}/` : "")
                  setNewFileOpen(true)
                }}
                aria-label="Nouveau fichier"
                title="Nouveau fichier"
              >
                <FilePlus />
              </Button>
              <Button variant="ghost" size="icon-sm" onClick={() => setFolderDialog({ name: "" })} aria-label="Nouveau dossier" title="Nouveau dossier">
                <FolderPlus />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => uploadInput.current?.click()}
                disabled={uploading.length > 0}
                aria-label="Ajouter des images ou vidéos"
                title="Ajouter des images, vidéos ou autres fichiers"
              >
                <Upload />
              </Button>
              <input
                ref={uploadInput}
                type="file"
                multiple
                hidden
                accept="image/*,video/*,application/pdf,.eps,.bib,.tex,.sty,.cls,.csv"
                onChange={(e) => {
                  uploadFiles(e.target.files)
                  e.target.value = ""
                }}
              />
            </div>
          </div>
          <p className="truncate px-4 pb-1 text-xs text-muted-foreground" title="Cliquer sur un dossier pour y ajouter des fichiers">
            Ajouts dans <span className="font-mono">{targetFolder ? `${targetFolder}/` : "la racine"}</span>
          </p>
          <nav className="relative min-h-0 flex-1 overflow-y-auto px-2 pt-1">
            {files.length === 0 ? (
              <div className="flex flex-col gap-1.5 px-2 pt-1">
                {[70, 55, 80, 45].map((w) => (
                  <Skeleton key={w} className="h-6" style={{ width: `${w}%` }} />
                ))}
              </div>
            ) : (
              <FileTree
                entries={files}
                current={current}
                targetFolder={targetFolder}
                onTargetFolder={setTargetFolder}
                onOpen={openFile}
                onInsert={insertMedia}
                onRename={(entry) => setRenameDialog({ entry, name: entry.name })}
                onDelete={setDeleteDialog}
                onDropFiles={uploadFiles}
              />
            )}
          </nav>
          {uploading.length > 0 && (
            <div className="relative border-t px-4 py-2.5 text-xs text-muted-foreground" role="status">
              <div className="refresh-bar" />
              Envoi vers Overleaf : {uploading.length > 1 ? `${uploading.length} fichiers` : uploading[0]}
            </div>
          )}
          <div className="flex flex-col gap-0.5 border-t p-2">
            <Button variant="ghost" className="justify-start" onClick={pull} disabled={!!busy}>
              <Download className="text-muted-foreground" />
              Récupérer depuis Overleaf
            </Button>
            <a
              href={`https://www.overleaf.com/project/${pid}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-9 items-center gap-2 rounded-md px-4 text-sm font-medium transition-colors duration-150 hover:bg-accent [&_svg]:size-4"
            >
              <ExternalLink className="text-muted-foreground" />
              Ouvrir sur overleaf.com
            </a>
          </div>
        </aside>

        <main className="grid min-h-0 flex-1 grid-cols-2 grid-rows-1">
            {/* Le fichier LaTeX */}
            <div className="relative min-h-0 min-w-0 border-r bg-card">
              {current ? (
                <CodeMirror
                  value={content}
                  height="100%"
                  className="absolute inset-0"
                  theme={editorTheme}
                  extensions={[latex, EditorView.lineWrapping]}
                  onChange={onChange}
                  onCreateEditor={(view) => {
                    viewRef.current = view
                  }}
                />
              ) : (
                <div className="grid h-full place-items-center">
                  <EmptyState
                    icon={FileText}
                    title="Aucun fichier ouvert"
                    description="Sélectionne un fichier dans la barre latérale."
                  />
                </div>
              )}
            </div>

            {/* La visualisation */}
            <div className="relative flex min-h-0 min-w-0 flex-col bg-background">
              {compile.state === "compiling" && <div className="refresh-bar" />}
              {tab === "pdf" &&
                (pdfUrl ? (
                  <PdfPages url={pdfUrl} />
                ) : (
                  <div className="grid flex-1 place-items-center">
                    <EmptyState
                      icon={FileText}
                      title={compile.state === "compiling" ? "Première compilation en cours" : "Aucun PDF"}
                      description="Le PDF apparaît ici après la compilation sur les serveurs d'Overleaf."
                    />
                  </div>
                ))}
              {tab === "log" && (
                <LogView log={log} issues={issues} current={current} onIssue={goToIssue} onLine={jumpTo} />
              )}
            </div>
        </main>
      </div>

      <AiChat pid={pid} currentFile={current} beforeSend={saveNow} onEdited={onAgentEdited} />

      {/* ---------- Dialogues ---------- */}
      <Dialog
        open={newFileOpen}
        title="Nouveau fichier"
        description="Chemin relatif à la racine du projet. Les sous-dossiers sont créés au besoin."
        onClose={() => !busy && setNewFileOpen(false)}
        footer={
          <>
            <Button variant="outline" onClick={() => setNewFileOpen(false)} disabled={!!busy} data-close>
              Annuler
            </Button>
            <Button onClick={createFile} disabled={!newFileName.trim() || !!busy}>
              {busy && <Loader2 className="animate-spin" />}
              Créer
            </Button>
          </>
        }
      >
        <form onSubmit={createFile}>
          <input
            value={newFileName}
            onChange={(e) => setNewFileName(e.target.value)}
            placeholder="chapitres/introduction.tex"
            className="h-9 w-full rounded-md border border-input bg-transparent px-3 font-mono text-xs shadow-xs transition-[border-color,box-shadow] duration-150 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
          />
        </form>
      </Dialog>

      <Dialog
        open={pullConfirm}
        title="Remplacer par la version d'Overleaf ?"
        description={`${pendingCount} fichier${pendingCount > 1 ? "s" : ""} modifié${pendingCount > 1 ? "s" : ""} ici n'${pendingCount > 1 ? "ont" : "a"} pas encore été envoyé${pendingCount > 1 ? "s" : ""}. La version d'overleaf.com les remplacera.`}
        onClose={() => !busy && setPullConfirm(false)}
        footer={
          <>
            <Button variant="outline" onClick={() => setPullConfirm(false)} disabled={!!busy} data-close>
              Garder mes modifications
            </Button>
            <Button onClick={doPull} disabled={!!busy}>
              {busy && <Loader2 className="animate-spin" />}
              Remplacer
            </Button>
          </>
        }
      />

      <Dialog
        open={!!folderDialog}
        title="Nouveau dossier"
        description={`Créé dans ${targetFolder ? `${targetFolder}/` : "la racine du projet"}, ici et sur overleaf.com.`}
        onClose={() => !dialogBusy && setFolderDialog(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setFolderDialog(null)} disabled={dialogBusy} data-close>
              Annuler
            </Button>
            <Button onClick={createFolder} disabled={!folderDialog?.name.trim() || dialogBusy}>
              {dialogBusy && <Loader2 className="animate-spin" />}
              Créer le dossier
            </Button>
          </>
        }
      >
        <form onSubmit={createFolder}>
          <input
            value={folderDialog?.name ?? ""}
            onChange={(e) => setFolderDialog({ name: e.target.value })}
            placeholder="images"
            className={inputCls}
          />
        </form>
      </Dialog>

      <Dialog
        open={!!renameDialog}
        title={`Renommer ${renameDialog?.entry.type === "folder" ? "le dossier" : "le fichier"}`}
        description={
          renameDialog?.entry.kind === "image" || renameDialog?.entry.type === "folder"
            ? "Pense à mettre à jour les \\includegraphics qui utilisent l'ancien chemin."
            : undefined
        }
        onClose={() => !dialogBusy && setRenameDialog(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setRenameDialog(null)} disabled={dialogBusy} data-close>
              Annuler
            </Button>
            <Button onClick={renameEntry} disabled={!renameDialog?.name.trim() || dialogBusy}>
              {dialogBusy && <Loader2 className="animate-spin" />}
              Renommer
            </Button>
          </>
        }
      >
        <form onSubmit={renameEntry}>
          <input
            value={renameDialog?.name ?? ""}
            onChange={(e) => setRenameDialog((d) => ({ ...d, name: e.target.value }))}
            className={inputCls}
          />
        </form>
      </Dialog>

      <Dialog
        open={!!deleteDialog}
        title={`Supprimer ${deleteDialog?.type === "folder" ? "le dossier" : "le fichier"} ?`}
        description={
          deleteDialog &&
          (deleteDialog.type === "folder"
            ? `« ${deleteDialog.path} » et tout son contenu seront supprimés ici et sur overleaf.com.`
            : `« ${deleteDialog.path} » sera supprimé ici et sur overleaf.com.`) +
            " Il reste récupérable depuis l'historique du projet sur overleaf.com."
        }
        onClose={() => !dialogBusy && setDeleteDialog(null)}
        footer={
          <>
            <Button variant="outline" onClick={() => setDeleteDialog(null)} disabled={dialogBusy} data-close>
              Garder
            </Button>
            <Button onClick={deleteEntry} disabled={dialogBusy}>
              {dialogBusy ? <Loader2 className="animate-spin" /> : <Trash2 />}
              Supprimer
            </Button>
          </>
        }
      />

      <Dialog
        open={!!preview}
        title={preview?.path.split("/").pop()}
        className="max-w-2xl"
        onClose={() => setPreview(null)}
        footer={
          preview && (
            <>
              <Button variant="outline" onClick={() => setDeleteDialog(preview)} data-close>
                <Trash2 />
                Supprimer
              </Button>
              <Button
                onClick={() => insertMedia(preview)}
                disabled={preview.kind === "image" && !imageSupport(preview.path).ok}
              >
                <ImagePlus />
                Insérer dans {currentRef.current?.endsWith(".tex") ? currentRef.current.split("/").pop() : "main.tex"}
              </Button>
            </>
          )
        }
      >
        {preview && (
          <div className="flex flex-col gap-3">
            <div className="grid max-h-[55dvh] place-items-center overflow-hidden rounded-md border bg-background">
              {preview.kind === "video" ? (
                <video src={fileUrl(preview.path)} controls className="max-h-[55dvh] w-full" />
              ) : (
                <img src={fileUrl(preview.path)} alt={preview.path} className="max-h-[55dvh] object-contain" />
              )}
            </div>
            <p className="font-mono text-xs text-muted-foreground">
              {preview.path} · {(preview.size / 1024).toLocaleString("fr-FR", { maximumFractionDigits: 0 })} Ko
            </p>
            {preview.kind === "image" && !imageSupport(preview.path).ok && (
              <Alert variant="warning" icon={AlertCircle}>
                {imageSupport(preview.path).reason}
              </Alert>
            )}
            {preview.kind === "video" && (
              <Alert icon={AlertCircle}>
                Un PDF compilé avec pdfLaTeX ne lit pas les vidéos : l'insertion ajoute un lien vers le fichier.
              </Alert>
            )}
          </div>
        )}
      </Dialog>
    </div>
  )
}

/* ---------- Composants de l'écran ---------- */

function SaveState({ dirty }) {
  // Un brouillon n'est pas un incident : surface neutre, seule la pastille porte l'état.
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground" role="status">
      <span className={cn("size-1.5 rounded-full", dirty ? "pulse-dot bg-foreground" : "bg-success")} />
      {dirty ? "Modification…" : "Enregistré"}
    </span>
  )
}

function CompileStatus({ compile, issues }) {
  const time = compile.at && <time className="text-faint">{fmtTime(compile.at)}</time>
  let body
  if (compile.state === "compiling") {
    // L'activité se dit par le mouvement, jamais par le rouge.
    body = (
      <span className="inline-flex items-center gap-2 text-muted-foreground">
        <span className="pulse-dot size-2 rounded-full bg-foreground" />
        Compilation sur Overleaf…
      </span>
    )
  } else if (compile.state === "success") {
    body = (
      <span className="inline-flex items-center gap-2">
        <CheckCircle2 className="size-4 text-success" />
        <span className="tabular-nums">Compilé en {String(compile.duration).replace(".", ",")} s</span>
        {time}
      </span>
    )
  } else if (compile.state === "error") {
    const n = issues.errors.length
    body = (
      <span className="inline-flex items-center gap-2">
        <Badge variant="alert">
          {compile.noPdf ? "Échec de compilation" : `${n} erreur${n > 1 ? "s" : ""}`}
        </Badge>
        {time}
      </span>
    )
  } else {
    body = <span className="text-faint">Cmd+S pour compiler</span>
  }
  return (
    <div className="hidden text-sm lg:block" role="status" aria-live="polite">
      {body}
    </div>
  )
}

function Switch({ checked, onChange, label, hint }) {
  // Coché = encre : le rouge reste à l'action primaire (The Tampon Rule).
  return (
    <label className="inline-flex cursor-pointer select-none items-center gap-2 text-sm" title={hint}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative h-5 w-9 rounded-full border transition-colors duration-150",
          checked ? "border-foreground bg-foreground" : "border-input bg-accent",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 left-0.5 size-3.5 rounded-full bg-card shadow-xs transition-transform duration-150",
            checked && "translate-x-4",
          )}
        />
      </button>
      {label}
    </label>
  )
}

function LogView({ log, issues, current, onIssue, onLine }) {
  if (!log) {
    return (
      <div className="grid flex-1 place-items-center bg-background">
        <EmptyState icon={ScrollText} title="Pas encore de log" description="Il apparaît après la première compilation." />
      </div>
    )
  }
  const warnings = issues.warnings.filter((w) => !w.box)
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto bg-background p-4">
      {issues.errors.map((e, i) => (
        <button
          key={`e${i}`}
          type="button"
          onClick={() => onIssue(e)}
          className="flex flex-col gap-1 rounded-lg border border-destructive/25 bg-destructive-surface px-4 py-3 text-left text-destructive-ink transition-colors duration-150 hover:border-destructive/50"
        >
          <span className="font-mono text-xs">
            {e.file || current}
            {e.line ? `:${e.line}` : ""}
          </span>
          <span className="font-medium">{e.message}</span>
          {e.context && <pre className="whitespace-pre-wrap font-mono text-xs">{e.context}</pre>}
        </button>
      ))}
      {warnings.map((w, i) => (
        <button
          key={`w${i}`}
          type="button"
          onClick={() => w.line && onLine(w.line)}
          className="flex flex-col gap-0.5 rounded-lg border border-warning-edge/50 bg-warning-surface px-4 py-3 text-left text-warning transition-colors duration-150 hover:border-warning-edge"
        >
          {w.line && <span className="font-mono text-xs">ligne {w.line}</span>}
          <span className="flex items-start justify-between gap-3">
            {w.message}
            {w.count > 1 && (
              <Badge variant="warning" className="shrink-0">
                ×{w.count}
              </Badge>
            )}
          </span>
        </button>
      ))}
      {issues.errors.length === 0 && warnings.length === 0 && (
        <Alert variant="success" icon={CheckCircle2}>
          Aucune erreur ni avertissement.
        </Alert>
      )}
      <details className="mt-2 rounded-lg border bg-card">
        <summary className="cursor-pointer px-4 py-2 text-sm text-muted-foreground">Log brut</summary>
        <pre className="max-h-[50vh] overflow-auto border-t px-4 py-3 font-mono text-xs whitespace-pre-wrap">
          {log}
        </pre>
      </details>
    </div>
  )
}
