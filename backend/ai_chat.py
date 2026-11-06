"""Chat Claude pour modifier le projet LaTeX, via le Claude Agent SDK.

Authentification : aucune clé API. Le SDK pilote Claude Code, qui réutilise la connexion
de la CLI `claude` (ton abonnement). Usage personnel et local uniquement : ne pas exposer
ce backend à d'autres personnes avec ton compte.

Réponse en NDJSON, une ligne par événement :
  {"type": "text", "text": "..."}                      morceau de réponse (streaming)
  {"type": "tool", "name": "Edit", "path": "main.tex", "edits": true}
  {"type": "done", "session_id": "...", "edited": ["main.tex"]}
  {"type": "error", "message": "..."}
"""
import json
import os
from pathlib import Path

from claude_agent_sdk import (
    AssistantMessage,
    ClaudeAgentOptions,
    ClaudeSDKError,
    ResultMessage,
    StreamEvent,
    ToolUseBlock,
    query,
)

# Une clé API dans l'environnement passerait devant l'abonnement : on la retire pour ce process.
os.environ.pop("ANTHROPIC_API_KEY", None)

# Si le backend a été lancé depuis un terminal Claude Code, il hérite des variables de cette
# session (CLAUDECODE, CLAUDE_CODE_SESSION_ID, socket de messagerie…) : le Claude Code lancé par
# le SDK se croirait alors sous-session d'une autre et resterait bloqué. On repart d'un env propre.
for _var in [v for v in os.environ if v == "CLAUDECODE" or v.startswith(("CLAUDE_CODE_", "CLAUDE_AGENT_"))]:
    os.environ.pop(_var, None)
for _var in ("CLAUDE_PID", "CLAUDE_EFFORT"):
    os.environ.pop(_var, None)

EDIT_TOOLS = {"Edit", "MultiEdit", "Write"}
READ_TOOLS = {"Read", "Glob", "Grep"}

SYSTEM_APPEND = """\
Tu es l'assistant intégré à un éditeur LaTeX personnel synchronisé avec Overleaf.
Le répertoire de travail est la racine du projet LaTeX ; chaque message indique le fichier
ouvert dans l'éditeur (par défaut main.tex).

- Fais les modifications demandées directement dans les fichiers, avec Edit (ou Write pour un
  nouveau fichier). Lis le fichier avant de le modifier.
- Garde le document compilable avec pdfLaTeX : environnements fermés, accolades équilibrées,
  paquets ajoutés dans le préambule si tu en utilises de nouveaux.
- Ne modifie que ce qui est demandé ; ne touche pas aux images ni aux fichiers binaires.
- Réponds en français, brièvement : une ou deux phrases qui disent ce que tu as changé et où.
  Si la demande est une question sans modification, réponds simplement.
"""


def _options(cwd: Path, session_id: str | None) -> ClaudeAgentOptions:
    opts = dict(
        cwd=str(cwd),
        system_prompt={"type": "preset", "preset": "claude_code", "append": SYSTEM_APPEND},
        allowed_tools=sorted(EDIT_TOOLS | READ_TOOLS),
        disallowed_tools=["Bash", "WebFetch", "WebSearch", "Task", "NotebookEdit"],
        permission_mode="acceptEdits",
        include_partial_messages=True,
        max_turns=30,
    )
    if model := os.getenv("CLAUDE_MODEL"):
        opts["model"] = model
    if session_id:
        opts["resume"] = session_id
    return ClaudeAgentOptions(**opts)


def _rel(cwd: Path, file_path: str | None) -> str | None:
    if not file_path:
        return None
    p = Path(file_path)
    p = (p if p.is_absolute() else cwd / p).resolve()
    try:
        return p.relative_to(cwd.resolve()).as_posix()
    except ValueError:
        return None  # hors du projet


def _line(obj) -> str:
    return json.dumps(obj, ensure_ascii=False) + "\n"


async def chat_stream(cwd: Path, message: str, session_id: str | None, current_file: str | None):
    prompt = f"[Fichier ouvert dans l'éditeur : {current_file or 'main.tex'}]\n\n{message}"
    edited: set[str] = set()
    try:
        async for msg in query(prompt=prompt, options=_options(cwd, session_id)):
            if isinstance(msg, StreamEvent):
                ev = msg.event
                if ev.get("type") == "content_block_delta" and ev.get("delta", {}).get("type") == "text_delta":
                    yield _line({"type": "text", "text": ev["delta"]["text"]})
                elif ev.get("type") == "content_block_start" and ev.get("content_block", {}).get("type") == "tool_use":
                    # annonce immédiate ; le chemin n'est connu qu'une fois l'appel complet (événement "tool")
                    yield _line({"type": "tool_start", "name": ev["content_block"].get("name"), "path": None})
            elif isinstance(msg, AssistantMessage):
                # Le texte est déjà arrivé en streaming ; on ne relève ici que les appels d'outils.
                for block in msg.content:
                    if isinstance(block, ToolUseBlock):
                        path = _rel(cwd, (block.input or {}).get("file_path"))
                        is_edit = block.name in EDIT_TOOLS and path is not None
                        if is_edit:
                            edited.add(path)
                        yield _line({"type": "tool", "name": block.name, "path": path, "edits": is_edit})
            elif isinstance(msg, ResultMessage):
                if msg.is_error:
                    detail = msg.result or msg.subtype
                    yield _line({"type": "error", "message": f"Claude n'a pas pu terminer : {detail}"})
                yield _line({"type": "done", "session_id": msg.session_id, "edited": sorted(edited)})
    except ClaudeSDKError as e:
        yield _line({"type": "error", "message": f"Claude Code : {e}"})
        yield _line({"type": "done", "session_id": session_id, "edited": sorted(edited)})
