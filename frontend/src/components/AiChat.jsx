import { useEffect, useRef, useState } from "react"
import { Bot, FilePen, Loader2, RotateCcw, SendHorizontal, X } from "lucide-react"
import { Button, cn } from "./ui"
import { loadPref, savePref } from "../lib/api"

const engineKey = (e) => (e.provider === "ollama" ? `ollama:${e.model}` : "claude")

/**
 * Petit chat avec une IA pour modifier les fichiers du projet : Claude (abonnement Claude Code,
 * côté backend) ou un modèle local Ollama. Bouton flottant en bas à droite, z-index 99999.
 *
 * Le backend répond en NDJSON : {type:"text"|"tool"|"done"|"error", ...}.
 */
export default function AiChat({ pid, currentFile, beforeSend, onEdited }) {
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState("")
  const [messages, setMessages] = useState([]) // {role, text, tools: [{name, path}], error}
  const [streaming, setStreaming] = useState(false)
  const [providers, setProviders] = useState(null) // { claude, ollama } renvoyé par le backend
  const [engine, setEngine] = useState(() => loadPref("aiEngine", { provider: "claude" }))
  const sessions = useRef({}) // session par projet et par IA
  const listRef = useRef(null)
  const inputRef = useRef(null)
  const abortRef = useRef(null)

  // Nouveau projet → nouvelle conversation
  useEffect(() => {
    setMessages([])
  }, [pid])

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight })
  }, [messages])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  // IA disponibles (rechargées à chaque ouverture : Ollama a pu être lancé entre-temps)
  useEffect(() => {
    if (!open) return
    fetch("/api/ai/providers")
      .then((r) => r.json())
      .then((p) => {
        setProviders(p)
        // choix mémorisé devenu indisponible : on bascule sur ce qui marche
        setEngine((e) => {
          const ok =
            e.provider === "claude" ? p.claude.available : p.ollama.models.some((m) => m.name === e.model)
          if (ok) return e
          if (p.claude.available) return { provider: "claude" }
          if (p.ollama.models[0]) return { provider: "ollama", model: p.ollama.models[0].name }
          return e
        })
      })
      .catch(() => setProviders({ claude: { available: false }, ollama: { available: false, models: [] } }))
  }, [open])

  useEffect(() => savePref("aiEngine", engine), [engine])

  const sessionKey = `${pid}|${engineKey(engine)}`
  const chooseEngine = (value) => {
    if (value === engineKey(engine)) return
    abortRef.current?.abort()
    setEngine(value === "claude" ? { provider: "claude" } : { provider: "ollama", model: value.slice(7) })
    setMessages([]) // chaque IA a sa propre conversation
  }

  const patchLast = (fn) =>
    setMessages((m) => {
      const copy = [...m]
      copy[copy.length - 1] = fn({ ...copy[copy.length - 1] })
      return copy
    })

  const send = async (e) => {
    e?.preventDefault()
    const text = input.trim()
    if (!text || !pid || streaming) return
    setInput("")
    setMessages((m) => [...m, { role: "user", text }, { role: "assistant", parts: [] }])
    setStreaming(true)
    const edited = new Set()
    const controller = new AbortController()
    abortRef.current = controller

    try {
      await beforeSend?.() // enregistre la frappe en cours avant que Claude ne lise le fichier
      const res = await fetch(`/api/projects/${pid}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          session_id: sessions.current[sessionKey],
          current_file: currentFile,
          provider: engine.provider,
          model: engine.model,
        }),
        signal: controller.signal,
      })
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.detail || res.statusText)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop()
        for (const line of lines) {
          if (!line.trim()) continue
          const ev = JSON.parse(line)
          if (ev.type === "text") patchLast((m) => ({ ...m, parts: appendText(m.parts, ev.text) }))
          else if (ev.type === "status") patchLast((m) => ({ ...m, status: ev.text }))
          else if (ev.type === "tool_start") {
            patchLast((m) => ({ ...m, parts: [...m.parts, { kind: "tool", name: ev.name, path: ev.path, pending: true }] }))
          } else if (ev.type === "tool") {
            if (ev.edits && ev.path) edited.add(ev.path)
            patchLast((m) => ({ ...m, parts: settleTool(m.parts, ev) }))
          } else if (ev.type === "done") {
            sessions.current[sessionKey] = ev.session_id
            ;(ev.edited || []).forEach((p) => edited.add(p))
          } else if (ev.type === "error") {
            patchLast((m) => ({ ...m, error: ev.message }))
          }
        }
      }
    } catch (err) {
      if (err.name !== "AbortError") patchLast((m) => ({ ...m, error: err.message }))
    } finally {
      patchLast((m) => (m.role === "assistant" ? { ...m, parts: m.parts.map((p) => ({ ...p, pending: false })) } : m))
      setStreaming(false)
      abortRef.current = null
      if (edited.size) onEdited?.([...edited])
    }
  }

  const reset = () => {
    abortRef.current?.abort()
    delete sessions.current[sessionKey]
    setMessages([])
  }

  const onKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  return (
    <>
      {open && (
        <section
          role="dialog"
          aria-label="Assistant IA"
          className="fixed right-4 bottom-20 z-[99999] flex h-[min(560px,calc(100dvh-7rem))] w-[min(400px,calc(100vw-2rem))] animate-dialog-in flex-col overflow-hidden rounded-lg border bg-card shadow-lg"
        >
          <header className="flex h-14 shrink-0 items-center gap-3 border-b px-4">
            <div className="flex min-w-0 flex-1 flex-col leading-tight">
              <span className="font-display text-base font-semibold tracking-[-0.01em]">Assistant</span>
              <span className="truncate text-xs text-muted-foreground">
                Modifie {currentFile ? <span className="font-mono">{currentFile}</span> : "le projet"}
              </span>
            </div>
            <select
              value={engineKey(engine)}
              onChange={(e) => chooseEngine(e.target.value)}
              disabled={streaming || !providers}
              aria-label="Choix de l'IA"
              className="h-8 max-w-40 min-w-0 rounded-md border border-input bg-transparent px-2 text-xs shadow-xs transition-[border-color,box-shadow] duration-150 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50"
            >
              <option value="claude" disabled={providers && !providers.claude.available}>
                Claude · abonnement{providers && !providers.claude.available ? " (indisponible)" : ""}
              </option>
              <optgroup label={providers?.ollama.available ? "Ollama · local" : "Ollama · injoignable"}>
                {providers?.ollama.models.map((m) => (
                  <option key={m.name} value={`ollama:${m.name}`}>
                    {m.name.replace(/:latest$/, "")}
                    {m.params ? ` · ${m.params}` : ""}
                  </option>
                ))}
              </optgroup>
            </select>
            <Button variant="ghost" size="icon-sm" onClick={reset} disabled={!messages.length} title="Nouvelle conversation" aria-label="Nouvelle conversation">
              <RotateCcw />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={() => setOpen(false)} aria-label="Fermer l'assistant">
              <X />
            </Button>
          </header>

          {engine.provider === "ollama" && (
            <p className="shrink-0 border-b bg-warning-surface px-4 py-1.5 text-xs text-warning" role="status">
              Modèle local : moins fiable que Claude pour modifier un document. Relis ses modifications.
            </p>
          )}

          <div ref={listRef} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-background p-4" aria-live="polite">
            {!pid && <p className="m-auto max-w-[30ch] text-center text-muted-foreground">Ouvre un projet pour discuter avec l'IA.</p>}
            {pid && messages.length === 0 && (
              <div className="m-auto flex max-w-[34ch] flex-col items-center gap-2 text-center">
                <Bot className="size-8 text-muted-foreground" strokeWidth={1.5} />
                <p className="text-sm font-medium">Demande une modification</p>
                <p className="text-muted-foreground">
                  « Ajoute une section Conclusion », « corrige les fautes de l'introduction », « passe le tableau 2 en booktabs »…
                </p>
              </div>
            )}
            {messages.map((m, i) =>
              m.role === "user" ? (
                <div key={i} className="max-w-[85%] self-end rounded-lg border bg-card px-3 py-2 whitespace-pre-wrap shadow-xs">
                  {m.text}
                </div>
              ) : (
                <div key={i} className="flex max-w-[95%] flex-col gap-2 self-start">
                  {m.parts.map((part, j) =>
                    part.kind === "text" ? (
                      <RevealText key={j} text={part.text} live={streaming && i === messages.length - 1} />
                    ) : (
                      <ToolStep key={j} step={part} />
                    ),
                  )}
                  {streaming && i === messages.length - 1 && !m.error && !m.parts.some((p) => p.pending) && (
                    <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="pulse-dot size-2 rounded-full bg-foreground" />
                      {m.parts.length ? "L'IA continue…" : (m.status ?? "L'IA réfléchit…")}
                    </span>
                  )}
                  {m.error && (
                    <p role="alert" className="rounded-lg border border-destructive/25 bg-destructive-surface px-3 py-2 text-destructive-ink">
                      {m.error}
                    </p>
                  )}
                </div>
              ),
            )}
          </div>

          <form onSubmit={send} className="flex shrink-0 items-end gap-2 border-t bg-card p-3">
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              disabled={!pid}
              placeholder={pid ? "Que faut-il modifier ?" : "Aucun projet ouvert"}
              className="max-h-40 min-h-9 flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-xs [field-sizing:content] transition-[border-color,box-shadow] duration-150 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
            />
            <Button type="submit" size="icon" disabled={!input.trim() || !pid || streaming} aria-label="Envoyer">
              {streaming ? <Loader2 className="animate-spin" /> : <SendHorizontal />}
            </Button>
          </form>
        </section>
      )}

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={open ? "Fermer l'assistant" : "Ouvrir l'assistant IA"}
        className="fixed right-4 bottom-4 z-[99999] inline-flex h-11 items-center gap-2 rounded-full bg-foreground px-4 text-sm font-medium text-card shadow-lg transition-colors duration-150 hover:bg-foreground/90"
      >
        {streaming ? <span className="pulse-dot size-2 rounded-full bg-card" /> : <Bot className="size-4" />}
        IA
      </button>
    </>
  )
}

/** Ajoute un morceau de texte : prolonge le dernier bloc de texte, ou en ouvre un après une étape. */
function appendText(parts, text) {
  const last = parts[parts.length - 1]
  if (last?.kind === "text") return [...parts.slice(0, -1), { ...last, text: last.text + text }]
  return [...parts, { kind: "text", text }]
}

/** Termine la dernière étape en cours du même outil (ou ajoute l'étape si elle n'avait pas été annoncée). */
function settleTool(parts, ev) {
  const done = { kind: "tool", name: ev.name, path: ev.path, edits: ev.edits, failed: ev.failed, pending: false }
  for (let k = parts.length - 1; k >= 0; k--) {
    if (parts[k].kind === "tool" && parts[k].pending && parts[k].name === ev.name) {
      return [...parts.slice(0, k), done, ...parts.slice(k + 1)]
    }
  }
  return [...parts, done]
}

/**
 * Texte révélé progressivement : même quand un gros morceau arrive d'un coup, il s'écrit à l'écran
 * en quelques images (rattrapage proportionnel au retard), jamais d'un bloc.
 */
function RevealText({ text, live }) {
  const [shown, setShown] = useState(live ? 0 : text.length)
  const frame = useRef(null)

  useEffect(() => {
    if (shown >= text.length) return
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setShown(text.length)
      return
    }
    frame.current = requestAnimationFrame(() => {
      setShown((n) => Math.min(text.length, n + Math.max(2, Math.ceil((text.length - n) / 12))))
    })
    return () => cancelAnimationFrame(frame.current)
  }, [shown, text])

  const writing = shown < text.length
  return (
    <div className="whitespace-pre-wrap">
      {text.slice(0, shown)}
      {(writing || live) && <span className="ml-0.5 inline-block h-3.5 w-px translate-y-0.5 animate-pulse bg-foreground" aria-hidden="true" />}
    </div>
  )
}

const TOOL_VERBS = {
  Read: ["Lecture", "Lu"],
  Edit: ["Modification", "Modifié"],
  MultiEdit: ["Modification", "Modifié"],
  Write: ["Écriture", "Écrit"],
  Glob: ["Parcours des fichiers", "Fichiers parcourus"],
  Grep: ["Recherche", "Recherché"],
}

function ToolStep({ step }) {
  const file = step.path ? step.path.split("/").pop() : ""
  const [doing, done] = TOOL_VERBS[step.name] ?? [step.name, step.name]
  const label = step.failed
    ? `Échec ${step.name === "Edit" ? "de modification" : "de l'outil"}${file ? ` · ${file}` : ""}`
    : step.pending
      ? `${doing}${file ? ` de ${file}` : ""}…`
      : `${done}${file ? ` ${file}` : ""}`
  return (
    <span
      data-slot="badge"
      className={cn(
        "inline-flex w-fit items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs",
        step.pending
          ? "border-border bg-accent text-foreground"
          : step.edits
            ? "border-success/20 bg-success-surface text-success"
            : step.failed
              ? "border-warning-edge/50 bg-warning-surface text-warning"
              : "border-border bg-card text-muted-foreground",
      )}
    >
      {step.pending ? (
        <span className="pulse-dot size-1.5 rounded-full bg-foreground" />
      ) : (
        step.edits && <FilePen className="size-3" />
      )}
      {label}
    </span>
  )
}
