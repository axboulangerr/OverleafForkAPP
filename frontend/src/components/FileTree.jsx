import { useMemo, useState } from "react"
import {
  ChevronRight,
  File,
  FileText,
  Film,
  Folder,
  FolderOpen,
  Image,
  ImagePlus,
  Pencil,
  Trash2,
} from "lucide-react"
import { cn } from "./ui"

const ICONS = { text: FileText, image: Image, video: Film, other: File }

/** Construit l'arbre {name, path, type, children} à partir des entrées plates du backend. */
function buildTree(entries) {
  const root = { path: "", children: new Map() }
  const nodeFor = (path) => {
    let node = root
    for (const part of path.split("/").filter(Boolean)) {
      const p = node.path ? `${node.path}/${part}` : part
      if (!node.children.has(part)) node.children.set(part, { name: part, path: p, type: "folder", children: new Map() })
      node = node.children.get(part)
    }
    return node
  }
  for (const e of entries) {
    if (e.type === "folder") nodeFor(e.path)
    else {
      const parent = e.path.includes("/") ? nodeFor(e.path.slice(0, e.path.lastIndexOf("/"))) : root
      const name = e.path.split("/").pop()
      parent.children.set(name, { ...e, name })
    }
  }
  const sort = (node) =>
    [...node.children.values()]
      .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, "fr") : a.type === "folder" ? -1 : 1))
      .map((n) => (n.type === "folder" ? { ...n, children: sort(n) } : n))
  return sort(root)
}

const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes("Files")

export default function FileTree({
  entries,
  current,
  targetFolder,
  onTargetFolder,
  onOpen,
  onInsert,
  onRename,
  onDelete,
  onDropFiles,
}) {
  const tree = useMemo(() => buildTree(entries), [entries])
  const [collapsed, setCollapsed] = useState(() => new Set())
  const [dropTarget, setDropTarget] = useState(null) // chemin du dossier survolé pendant un glisser

  const toggle = (path) =>
    setCollapsed((s) => {
      const n = new Set(s)
      n.has(path) ? n.delete(path) : n.add(path)
      return n
    })

  const dropProps = (folderPath) => ({
    onDragOver: (e) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.stopPropagation()
      setDropTarget(folderPath)
    },
    onDragLeave: (e) => {
      if (!e.currentTarget.contains(e.relatedTarget)) setDropTarget((t) => (t === folderPath ? null : t))
    },
    onDrop: (e) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.stopPropagation()
      setDropTarget(null)
      onDropFiles([...e.dataTransfer.files], folderPath)
    },
  })

  const renderNode = (node, depth) => {
    const pad = { paddingLeft: `${depth * 14 + 8}px` }
    if (node.type === "folder") {
      const open = !collapsed.has(node.path)
      const isTarget = targetFolder === node.path
      const Icon = open ? FolderOpen : Folder
      return (
        <li key={node.path} {...dropProps(node.path)}>
          <div
            className={cn(
              "group flex h-8 items-center gap-1.5 rounded-md pr-1 text-sm transition-colors duration-150",
              dropTarget === node.path ? "bg-accent ring-1 ring-foreground/30" : isTarget ? "bg-secondary" : "hover:bg-secondary",
            )}
            style={pad}
          >
            <button
              type="button"
              onClick={() => {
                toggle(node.path)
                onTargetFolder(node.path)
              }}
              aria-expanded={open}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              title={`${node.path} — les ajouts iront dans ce dossier`}
            >
              <ChevronRight className={cn("size-3.5 shrink-0 text-faint transition-transform duration-150", open && "rotate-90")} />
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <span className={cn("truncate", isTarget && "font-medium")}>{node.name}</span>
            </button>
            <RowActions node={node} onRename={onRename} onDelete={onDelete} />
          </div>
          {open && node.children.length > 0 && <ul>{node.children.map((c) => renderNode(c, depth + 1))}</ul>}
          {open && node.children.length === 0 && (
            <p className="py-1 text-xs text-faint" style={{ paddingLeft: `${(depth + 1) * 14 + 30}px` }}>
              Dossier vide
            </p>
          )}
        </li>
      )
    }

    const Icon = ICONS[node.kind] ?? File
    const active = node.path === current
    return (
      <li key={node.path}>
        <div
          className={cn(
            "group flex h-8 items-center gap-1.5 rounded-md pr-1 text-sm transition-colors duration-150",
            active ? "bg-secondary font-medium" : "hover:bg-secondary",
          )}
          style={pad}
        >
          <button
            type="button"
            onClick={() => onOpen(node)}
            aria-current={active ? "page" : undefined}
            className="flex min-w-0 flex-1 items-center gap-1.5 pl-5 text-left"
          >
            <Icon className="size-4 shrink-0 text-muted-foreground" />
            <span className={cn("truncate", !node.text && !active && "text-muted-foreground")}>{node.name}</span>
            {node.changed && (
              <span className="ml-auto size-1.5 shrink-0 rounded-full bg-foreground" title="Modifié localement, pas encore envoyé" />
            )}
          </button>
          <RowActions node={node} onInsert={onInsert} onRename={onRename} onDelete={onDelete} />
        </div>
      </li>
    )
  }

  return (
    <div
      className={cn("min-h-full rounded-md pb-2 transition-colors duration-150", dropTarget === "" && "bg-accent ring-1 ring-foreground/30")}
      {...dropProps("")}
      onClick={(e) => e.target === e.currentTarget && onTargetFolder("")}
    >
      <ul>{tree.map((n) => renderNode(n, 0))}</ul>
    </div>
  )
}

function RowActions({ node, onInsert, onRename, onDelete }) {
  const btn =
    "inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground [&_svg]:size-3.5"
  const insertable = node.type === "file" && (node.kind === "image" || node.kind === "video")
  return (
    <span className="flex shrink-0 items-center opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
      {insertable && onInsert && (
        <button type="button" className={btn} onClick={() => onInsert(node)} title="Insérer dans le LaTeX" aria-label={`Insérer ${node.name} dans le LaTeX`}>
          <ImagePlus />
        </button>
      )}
      <button type="button" className={btn} onClick={() => onRename(node)} title="Renommer" aria-label={`Renommer ${node.name}`}>
        <Pencil />
      </button>
      <button type="button" className={btn} onClick={() => onDelete(node)} title="Supprimer" aria-label={`Supprimer ${node.name}`}>
        <Trash2 />
      </button>
    </span>
  )
}
