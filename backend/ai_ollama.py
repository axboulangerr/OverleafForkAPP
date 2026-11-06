"""Chat avec un modèle local Ollama, avec appel d'outils pour modifier le projet LaTeX.

Même format de sortie NDJSON que ai_chat.py (Claude) :
  {"type": "text"|"tool"|"done"|"error", ...}

Ollama ne fournit pas d'agent : la boucle est ici. Le modèle reçoit le fichier ouvert dans le
contexte et quatre outils. `create_file` refuse d'écraser un fichier existant : les modifications
passent par `edit_file`, un remplacement exact, pour qu'un petit modèle ne puisse pas effacer
un document entier en le « réécrivant ».
"""
import difflib
import json
import os
import re
import uuid
from pathlib import Path

import requests

OLLAMA_URL = os.getenv("OLLAMA_HOST", "http://localhost:11434").rstrip("/")
NUM_CTX = int(os.getenv("OLLAMA_NUM_CTX", "16384"))
# Délai max sans recevoir un seul octet d'Ollama (chargement du modèle compris) avant d'abandonner
READ_TIMEOUT = int(os.getenv("OLLAMA_TIMEOUT", "180"))
MAX_STEPS = 10
MAX_FILE_IN_PROMPT = 60_000  # caractères

TEXT_EXT = {".tex", ".bib", ".cls", ".sty", ".txt", ".md", ".bst", ".cfg", ".csv"}

# Historique des conversations, en mémoire (perdu au redémarrage du backend).
_sessions: dict[str, list[dict]] = {}

SYSTEM = """\
Tu es l'assistant intégré à un éditeur LaTeX synchronisé avec Overleaf. Tu travailles sur les
fichiers du projet uniquement à l'aide des outils fournis.

Règles :
- Pour modifier un fichier existant, utilise de préférence replace_lines avec les numéros de ligne
  affichés (« 12| … ») : donne start_line, end_line et le nouveau texte LaTeX de ces lignes.
  Pour insérer sans rien supprimer, remplace une ligne par elle-même suivie du nouveau texte.
- edit_file convient aussi pour un petit passage, recopié EXACTEMENT et présent une seule fois.
- create_file sert uniquement à créer un nouveau fichier.
- Si tu as besoin d'un fichier qui n'est pas dans le contexte, lis-le avec read_file.
- Garde le document compilable avec pdfLaTeX : environnements fermés, accolades équilibrées,
  \\usepackage ajoutés dans le préambule si nécessaire.
- Ne modifie que ce qui est demandé.
- Réponds en français, en une ou deux phrases : ce que tu as changé et où.
"""

TOOLS = [
    {"type": "function", "function": {
        "name": "list_files",
        "description": "Liste les fichiers du projet LaTeX.",
        "parameters": {"type": "object", "properties": {}},
    }},
    {"type": "function", "function": {
        "name": "read_file",
        "description": "Lit le contenu d'un fichier texte du projet.",
        "parameters": {"type": "object", "required": ["path"], "properties": {
            "path": {"type": "string", "description": "Chemin relatif, ex. main.tex ou chapitres/intro.tex"},
        }},
    }},
    {"type": "function", "function": {
        "name": "edit_file",
        "description": "Remplace un passage exact d'un fichier existant par un nouveau texte.",
        "parameters": {"type": "object", "required": ["path", "old_text", "new_text"], "properties": {
            "path": {"type": "string"},
            "old_text": {"type": "string", "description": "Passage à remplacer, copié exactement, présent une seule fois"},
            "new_text": {"type": "string", "description": "Texte de remplacement"},
        }},
    }},
    {"type": "function", "function": {
        "name": "replace_lines",
        "description": "Remplace les lignes start_line à end_line (incluses, numérotées à partir de 1) "
                       "d'un fichier existant par new_text (qui peut contenir plusieurs lignes).",
        "parameters": {"type": "object", "required": ["path", "start_line", "end_line", "new_text"], "properties": {
            "path": {"type": "string"},
            "start_line": {"type": "integer"},
            "end_line": {"type": "integer"},
            "new_text": {"type": "string", "description": "Nouvelles lignes, texte LaTeX final"},
        }},
    }},
    {"type": "function", "function": {
        "name": "create_file",
        "description": "Crée un NOUVEAU fichier texte (échoue si le fichier existe déjà).",
        "parameters": {"type": "object", "required": ["path", "content"], "properties": {
            "path": {"type": "string"},
            "content": {"type": "string"},
        }},
    }},
]

EDIT_TOOLS = {"edit_file", "replace_lines", "create_file"}
TOOL_LABELS = {"list_files": "Glob", "read_file": "Read", "edit_file": "Edit", "replace_lines": "Edit", "create_file": "Write"}


class ToolError(Exception):
    pass


def _line(obj) -> str:
    return json.dumps(obj, ensure_ascii=False) + "\n"


def list_models() -> list[dict]:
    r = requests.get(f"{OLLAMA_URL}/api/tags", timeout=3)
    r.raise_for_status()
    return [
        {"name": m["name"], "size": m.get("size"), "params": m.get("details", {}).get("parameter_size")}
        for m in r.json().get("models", [])
    ]


def _resolve(cwd: Path, rel: str) -> Path:
    base = cwd.resolve()
    p = (base / (rel or "").strip().lstrip("/")).resolve()
    if base not in p.parents:
        raise ToolError(f"chemin hors du projet : {rel}")
    return p


def _run_tool(cwd: Path, name: str, args: dict) -> str:
    if name == "list_files":
        return "\n".join(sorted(f.relative_to(cwd).as_posix() for f in cwd.rglob("*") if f.is_file()))
    path = _resolve(cwd, args.get("path", ""))
    if name == "read_file":
        if not path.is_file():
            raise ToolError(f"fichier introuvable : {args.get('path')}")
        if path.suffix.lower() not in TEXT_EXT:
            raise ToolError("fichier binaire (image, PDF…) : impossible de le lire comme du texte")
        return _numbered(path.read_text(encoding="utf-8", errors="replace"))
    if name == "edit_file":
        if not path.is_file():
            raise ToolError(f"fichier introuvable : {args.get('path')}")
        text = path.read_text(encoding="utf-8")
        new_text = _apply_edit(text, args.get("old_text", ""), args.get("new_text", ""))
        path.write_text(new_text, encoding="utf-8")
        return "Modification appliquée."
    if name == "replace_lines":
        if not path.is_file():
            raise ToolError(f"fichier introuvable : {args.get('path')}")
        try:
            start, end = int(args.get("start_line")), int(args.get("end_line"))
        except (TypeError, ValueError):
            raise ToolError("start_line et end_line doivent être des nombres")
        text = path.read_text(encoding="utf-8")
        path.write_text(_replace_lines(text, start, end, args.get("new_text", "")), encoding="utf-8")
        return f"Lignes {start} à {end} remplacées."
    if name == "create_file":
        if path.exists():
            raise ToolError("ce fichier existe déjà : utilise edit_file pour le modifier")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(args.get("content", ""), encoding="utf-8")
        return "Fichier créé."
    raise ToolError(f"outil inconnu : {name}")


def _undouble(s: str) -> str:
    """Les petits modèles doublent souvent les antislashs du LaTeX (\\\\title au lieu de \\title)."""
    return re.sub(r"\\{2,}", lambda m: "\\" * max(1, len(m.group()) // 2), s)


def _ws_pattern(old: str) -> str:
    """Mêmes caractères, mais n'importe quel blanc entre les mots (jamais au début ni à la fin)."""
    return r"\s+".join(re.escape(t) for t in old.split())


def _closest_lines(text: str, old: str) -> str:
    lines = text.splitlines()
    first = old.strip().splitlines()[0] if old.strip() else ""
    best = difflib.get_close_matches(first, lines, n=1, cutoff=0.4)
    if not best:
        return ""
    i = lines.index(best[0])
    excerpt = "\n".join(f"{n + 1}| {lines[n]}" for n in range(max(0, i - 1), min(len(lines), i + 4)))
    return f"\nPassage le plus proche dans le fichier :\n{excerpt}\n(Tu peux aussi utiliser replace_lines.)"


def _apply_edit(text: str, old: str, new: str) -> str:
    """Remplacement unique et sûr. Tolérances : antislashs doublés de façon cohérente par le modèle,
    blancs différents entre les mots. Rien d'autre n'est deviné."""
    if not old.strip():
        raise ToolError("old_text est vide")
    variants = [(old, new)]
    if "\\\\" in old:
        variants.append((_undouble(old), _undouble(new)))
    for o, n in variants:  # correspondance exacte
        count = text.count(o)
        if count == 1:
            return text.replace(o, n, 1)
        if count > 1:
            raise ToolError(f"old_text apparaît {count} fois : ajoute du contexte pour qu'il soit unique")
    for o, n in variants:  # mêmes mots, blancs différents
        matches = list(re.finditer(_ws_pattern(o), text))
        if len(matches) == 1:
            m = matches[0]
            return text[: m.start()] + n + text[m.end():]
        if len(matches) > 1:
            raise ToolError(f"old_text apparaît {len(matches)} fois : ajoute du contexte pour qu'il soit unique")
    raise ToolError("old_text introuvable : recopie le passage exactement." + _closest_lines(text, old))


def _replace_lines(text: str, start: int, end: int, new: str) -> str:
    lines = text.split("\n")
    if not (1 <= start <= end <= len(lines)):
        raise ToolError(f"lignes {start}-{end} invalides : le fichier a {len(lines)} lignes")
    return "\n".join(lines[: start - 1] + new.split("\n") + lines[end:])


def _numbered(text: str) -> str:
    return "\n".join(f"{i}| {line}" for i, line in enumerate(text.split("\n"), 1))


def _context(cwd: Path, current_file: str | None) -> str:
    rel = current_file or "main.tex"
    try:
        p = _resolve(cwd, rel)
    except ToolError:
        return ""
    if not p.is_file() or p.suffix.lower() not in TEXT_EXT:
        return f"Fichier ouvert dans l'éditeur : {rel}"
    text = p.read_text(encoding="utf-8", errors="replace")
    if len(text) > MAX_FILE_IN_PROMPT:
        return f"Fichier ouvert dans l'éditeur : {rel} (trop long pour le contexte : lis-le avec read_file)"
    return (f"Fichier ouvert dans l'éditeur : {rel}\nContenu actuel de {rel}, avec les numéros de ligne "
            f"(le préfixe « N| » ne fait pas partie du fichier) :\n<<<\n{_numbered(text)}\n>>>")


TOOL_MARKERS = ("[TOOL_CALLS]", "[{", '{"name"', "```json")


def _parse_text_tool_calls(content: str) -> list[dict]:
    """Repli pour les modèles (Mistral notamment) dont Ollama ne reconnaît pas l'appel d'outil :
    l'appel arrive en texte, ex. `[TOOL_CALLS][{"name": "edit_file", "arguments": {...}}]`."""
    text = content.strip()
    for prefix in ("[TOOL_CALLS]", "```json", "```"):
        if text.startswith(prefix):
            text = text[len(prefix):].strip()
    text = text.removesuffix("```").strip()
    start = min((i for i in (text.find("["), text.find("{")) if i >= 0), default=-1)
    if start < 0:
        return []
    candidate = text[start:]
    try:
        data, _ = json.JSONDecoder().raw_decode(candidate)
    except ValueError:
        # échappements invalides typiques du LaTeX (\author, \\\a…) : on double l'antislash fautif
        repaired = re.sub(
            r"\\(.)",
            lambda m: m.group(0) if m.group(1) in '"\\/bfnrtu' else "\\\\" + m.group(1),
            candidate,
            flags=re.S,
        )
        try:
            data, _ = json.JSONDecoder().raw_decode(repaired)
        except ValueError:
            return []
    items = data if isinstance(data, list) else [data]
    return [
        {"function": {"name": it["name"], "arguments": it.get("arguments") or it.get("parameters") or {}}}
        for it in items
        if isinstance(it, dict) and it.get("name") in {t["function"]["name"] for t in TOOLS}
    ]


def _looks_like_tool_text(buffer: str) -> bool | None:
    """True : c'est un appel d'outil en texte ; False : texte normal ; None : trop tôt pour le dire."""
    head = buffer.lstrip()
    if not head:
        return None
    if any(head.startswith(m) for m in TOOL_MARKERS):
        return True
    if any(m.startswith(head) for m in TOOL_MARKERS):
        return None
    return False


def chat_stream(cwd: Path, model: str, message: str, session_id: str | None, current_file: str | None):
    session_id = session_id if session_id in _sessions else str(uuid.uuid4())
    history = _sessions.setdefault(session_id, [{"role": "system", "content": SYSTEM}])
    # Le contenu du fichier est redonné à chaque tour : il a pu changer depuis (éditeur, compilation…)
    history.append({"role": "user", "content": f"{_context(cwd, current_file)}\n\nDemande : {message}"})
    edited: set[str] = set()
    # premier événement immédiat : le chat sait que la requête est partie (le chargement peut être long)
    yield _line({"type": "status", "text": f"Chargement de {model.removesuffix(':latest')}…"})

    try:
        for _ in range(MAX_STEPS):
            r = requests.post(
                f"{OLLAMA_URL}/api/chat",
                json={"model": model, "messages": history, "tools": TOOLS, "stream": True,
                      "options": {"num_ctx": NUM_CTX}},
                stream=True, timeout=(5, READ_TIMEOUT),
            )
            if r.status_code >= 400:
                detail = r.text[:300]
                try:
                    detail = r.json().get("error", detail)
                except ValueError:
                    pass
                yield _line({"type": "error", "message": f"Ollama : {detail}"})
                break

            content, calls = "", []
            mode = None  # None : on attend de savoir ; False : texte diffusé ; True : appel d'outil en texte
            # chunk_size=None : chaque ligne est traitée dès réception (512 octets par défaut sinon,
            # ce qui faisait arriver la réponse par paquets, voire d'un seul coup)
            for raw in r.iter_lines(chunk_size=None):
                if not raw:
                    continue
                chunk = json.loads(raw)
                if chunk.get("error"):
                    raise RuntimeError(chunk["error"])
                msg = chunk.get("message", {})
                calls.extend(msg.get("tool_calls") or [])
                if not msg.get("content"):
                    continue
                content += msg["content"]
                if mode is None:
                    mode = _looks_like_tool_text(content)
                    if mode is False:
                        yield _line({"type": "text", "text": content})  # on libère le début retenu
                elif mode is False:
                    yield _line({"type": "text", "text": msg["content"]})

            if not calls and mode is not False:
                calls = _parse_text_tool_calls(content)
                if calls:
                    content = ""
                elif content.strip():  # retenu à tort : c'était du texte
                    yield _line({"type": "text", "text": content})

            history.append({"role": "assistant", "content": content, **({"tool_calls": calls} if calls else {})})
            if not calls:
                break

            for call in calls:
                fn = call.get("function", {})
                name, args = fn.get("name", ""), fn.get("arguments") or {}
                if isinstance(args, str):
                    try:
                        args = json.loads(args)
                    except ValueError:
                        args = {}
                rel = args.get("path")
                yield _line({"type": "tool_start", "name": TOOL_LABELS.get(name, name), "path": rel})
                try:
                    result = _run_tool(cwd, name, args)
                    ok = True
                except ToolError as e:
                    result, ok = f"ERREUR : {e}", False
                is_edit = ok and name in EDIT_TOOLS and bool(rel)
                if is_edit:
                    edited.add(_resolve(cwd, rel).relative_to(cwd.resolve()).as_posix())
                yield _line({"type": "tool", "name": TOOL_LABELS.get(name, name), "path": rel,
                             "edits": is_edit, **({} if ok else {"failed": True})})
                history.append({"role": "tool", "tool_name": name, "content": result})
        else:
            yield _line({"type": "error", "message": f"Arrêt après {MAX_STEPS} étapes sans réponse finale."})
    except requests.Timeout:
        yield _line({"type": "error", "message": f"Ollama ne répond plus depuis {READ_TIMEOUT} s. "
                     "Le modèle est peut-être trop gros pour la mémoire, ou Ollama est bloqué : "
                     "quitte et relance l'application Ollama, ou choisis un modèle plus petit."})
    except requests.ConnectionError:
        yield _line({"type": "error", "message": f"Ollama injoignable sur {OLLAMA_URL} : lance l'application Ollama."})
    except Exception as e:  # noqa: BLE001 — l'erreur est renvoyée dans le chat plutôt qu'un flux coupé
        yield _line({"type": "error", "message": f"Ollama : {e}"})

    yield _line({"type": "done", "session_id": session_id, "edited": sorted(edited)})
