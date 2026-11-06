"""Backend FastAPI : pilote overleaf.com via son API web, authentifié par cookie de session."""
import hashlib
import io
import json
import os
import shutil
import time
import zipfile
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

from overleaf_client import OverleafClient, OverleafError

load_dotenv(override=True)

ROOT = Path(__file__).parent / "workspace"
TEXT_EXT = {".tex", ".bib", ".cls", ".sty", ".txt", ".md", ".bst", ".cfg", ".csv",
            ".json", ".yaml", ".yml", ".bbx", ".cbx", ".lua", ".py"}

app = FastAPI(title="Mon Overleaf")
app.add_middleware(CORSMiddleware, allow_origins=["http://localhost:5180"],
                   allow_methods=["*"], allow_headers=["*"])

_client: OverleafClient | None = None


def client() -> OverleafClient:
    """Relit le .env à chaque appel : coller un nouveau cookie ne demande pas de redémarrage."""
    global _client
    load_dotenv(override=True)
    cookie = os.getenv("OVERLEAF_SESSION", "").strip()
    if _client is None or _client.cookie != cookie:
        try:
            _client = OverleafClient(cookie, os.getenv("OVERLEAF_URL", "https://www.overleaf.com"))
        except OverleafError as e:
            raise HTTPException(500, str(e))
    return _client


def call(fn, *a, **kw):
    try:
        return fn(*a, **kw)
    except OverleafError as e:
        raise HTTPException(502, str(e))


# ---------- espace de travail local ----------
def pdir(pid: str) -> Path:
    if not pid.isalnum():
        raise HTTPException(400, "ID de projet invalide")
    return ROOT / pid


def src(pid: str) -> Path:
    return pdir(pid) / "src"


def safe_path(pid: str, rel: str) -> Path:
    base = src(pid).resolve()
    p = (base / rel).resolve()
    if base not in p.parents:
        raise HTTPException(400, "Chemin invalide")
    return p


def digest(p: Path) -> str:
    return hashlib.sha1(p.read_bytes()).hexdigest()


def snapshot(pid: str) -> dict:
    return {f.relative_to(src(pid)).as_posix(): digest(f) for f in src(pid).rglob("*") if f.is_file()}


def manifest_path(pid: str) -> Path:
    return pdir(pid) / "manifest.json"


def changed_files(pid: str) -> list[str]:
    old = json.loads(manifest_path(pid).read_text()) if manifest_path(pid).exists() else {}
    return [p for p, h in snapshot(pid).items() if old.get(p) != h]


def load_manifest(pid: str) -> dict:
    return json.loads(manifest_path(pid).read_text()) if manifest_path(pid).exists() else {}


def save_manifest(pid: str, m: dict):
    manifest_path(pid).write_text(json.dumps(m))


IMAGE_EXT = {".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".pdf", ".eps", ".bmp", ".tif", ".tiff"}
VIDEO_EXT = {".mp4", ".mov", ".webm", ".m4v", ".avi", ".mkv"}
MAX_UPLOAD = 50 * 1024 * 1024  # limite d'Overleaf par fichier


def kind(path: str) -> str:
    ext = Path(path).suffix.lower()
    if ext in TEXT_EXT:
        return "text"
    if ext in IMAGE_EXT:
        return "image"
    if ext in VIDEO_EXT:
        return "video"
    return "other"


def clean_rel(path: str) -> str:
    """Normalise un chemin relatif saisi par l'utilisateur (sans / initial ni final, sans . ni ..)."""
    parts = [p for p in path.replace("\\", "/").split("/") if p not in ("", ".")]
    if not parts or ".." in parts:
        raise HTTPException(400, "Chemin invalide")
    return "/".join(parts)


def ensure_local(pid: str):
    if not src(pid).exists():
        download(pid)


# ---------- routes ----------
def _person(u) -> str | None:
    if not isinstance(u, dict):
        return None
    name = " ".join(x for x in (u.get("firstName"), u.get("lastName")) if x)
    return name or u.get("email")


@app.get("/api/projects")
def projects():
    try:
        items = client().list_projects_detailed()
    except OverleafError:
        # repli sur la liste minimale si le tableau de bord refuse la requête
        items = [{"id": p["_id"], "name": p["name"], "accessLevel": p.get("accessLevel")}
                 for p in call(client().list_projects)]
    return [
        {
            "id": p["id"],
            "name": p["name"],
            "access": p.get("accessLevel"),
            "owner": _person(p.get("owner")),
            "lastUpdated": p.get("lastUpdated"),
            "lastUpdatedBy": _person(p.get("lastUpdatedBy")),
            "archived": bool(p.get("archived")),
            "local": src(p["id"]).exists(),
            "hasPdf": (pdir(p["id"]) / "output.pdf").exists(),
        }
        for p in items
        if not p.get("trashed")
    ]


class NewProjectBody(BaseModel):
    name: str
    template: str = "none"  # "none" (vide) ou "example" (exemple Overleaf)


@app.post("/api/projects")
def create_project(body: NewProjectBody):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "Le nom du projet est obligatoire")
    if body.template not in ("none", "example"):
        raise HTTPException(400, "Modèle inconnu")
    return {"id": call(client().create_project, name, body.template)}


@app.post("/api/projects/{pid}/download")
def download(pid: str):
    """Récupère la dernière version du projet depuis overleaf.com (écrase les modifs locales non envoyées)."""
    data = call(client().download_zip, pid)
    if src(pid).exists():
        shutil.rmtree(src(pid))
    src(pid).mkdir(parents=True)
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        for m in z.infolist():
            target = (src(pid) / m.filename).resolve()
            if src(pid).resolve() not in target.parents:
                continue  # protection zip-slip
            if m.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(z.read(m))
    manifest_path(pid).write_text(json.dumps(snapshot(pid)))
    return {"ok": True}


@app.get("/api/projects/{pid}/files")
def list_files(pid: str):
    """Entrées de l'arborescence locale : dossiers (même vides) puis fichiers."""
    ensure_local(pid)
    changed = set(changed_files(pid))
    base = src(pid)
    folders = sorted(d.relative_to(base).as_posix() for d in base.rglob("*") if d.is_dir())
    files = sorted(snapshot(pid))
    return [{"path": d, "type": "folder"} for d in folders] + [
        {"path": p, "type": "file", "kind": kind(p), "text": kind(p) == "text",
         "changed": p in changed, "size": (base / p).stat().st_size}
        for p in files
    ]


@app.get("/api/projects/{pid}/file")
def read_file(pid: str, path: str):
    p = safe_path(pid, path)
    if not p.is_file():
        raise HTTPException(404, "Fichier introuvable")
    if p.suffix.lower() not in TEXT_EXT:
        return FileResponse(p)
    return {"path": path, "content": p.read_text(encoding="utf-8", errors="replace")}


class SaveBody(BaseModel):
    path: str
    content: str


@app.put("/api/projects/{pid}/file")
def save_file(pid: str, body: SaveBody):
    p = safe_path(pid, body.path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(body.content, encoding="utf-8")
    return {"ok": True}


@app.post("/api/projects/{pid}/upload")
async def upload_files(pid: str, files: list[UploadFile] = File(...), folder: str = Form("")):
    """Ajoute des fichiers (images, vidéos, .bib…) dans un dossier, en local et sur overleaf.com."""
    ensure_local(pid)
    folder = clean_rel(folder) if folder.strip("/ ") else ""
    manifest = load_manifest(pid)
    added = []
    for f in files:
        name = Path(f.filename or "").name
        if not name:
            continue
        data = await f.read()
        if len(data) > MAX_UPLOAD:
            raise HTTPException(413, f"« {name} » dépasse 50 Mo, la limite d'Overleaf")
        rel = f"{folder}/{name}" if folder else name
        call(client().upload, pid, rel, data)  # d'abord Overleaf : si ça échoue, rien n'est écrit en local
        target = safe_path(pid, rel)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        manifest[rel] = digest(target)
        added.append(rel)
    save_manifest(pid, manifest)
    return {"added": added}


class FolderBody(BaseModel):
    path: str


@app.post("/api/projects/{pid}/folder")
def create_folder(pid: str, body: FolderBody):
    ensure_local(pid)
    rel = clean_rel(body.path)
    if safe_path(pid, rel).is_file():
        raise HTTPException(409, f"Un fichier « {rel} » existe déjà")
    call(client().mkdirp, pid, rel)
    safe_path(pid, rel).mkdir(parents=True, exist_ok=True)
    return {"path": rel}


@app.delete("/api/projects/{pid}/entity")
def delete_entity(pid: str, path: str):
    """Supprime un fichier ou un dossier (et son contenu), sur overleaf.com puis en local."""
    ensure_local(pid)
    rel = clean_rel(path)
    entry = call(client().tree, pid).get(rel)
    if entry:  # absent d'Overleaf = jamais envoyé : suppression locale seulement
        call(client().delete_entity, pid, entry["type"], entry["id"])
    target = safe_path(pid, rel)
    if target.is_dir():
        shutil.rmtree(target)
    elif target.exists():
        target.unlink()
    manifest = {k: v for k, v in load_manifest(pid).items() if k != rel and not k.startswith(rel + "/")}
    save_manifest(pid, manifest)
    return {"deleted": rel}


class RenameBody(BaseModel):
    path: str
    name: str


@app.post("/api/projects/{pid}/rename")
def rename_entity(pid: str, body: RenameBody):
    ensure_local(pid)
    rel = clean_rel(body.path)
    name = body.name.strip()
    if not name or "/" in name or name in (".", ".."):
        raise HTTPException(400, "Nom invalide")
    new_rel = f"{rel.rsplit('/', 1)[0]}/{name}" if "/" in rel else name
    if safe_path(pid, new_rel).exists():
        raise HTTPException(409, f"« {new_rel} » existe déjà")
    entry = call(client().tree, pid).get(rel)
    if entry:
        call(client().rename_entity, pid, entry["type"], entry["id"], name)
    safe_path(pid, rel).rename(safe_path(pid, new_rel))
    manifest = {}
    for k, v in load_manifest(pid).items():
        if k == rel:
            k = new_rel
        elif k.startswith(rel + "/"):
            k = new_rel + k[len(rel):]
        manifest[k] = v
    save_manifest(pid, manifest)
    return {"path": new_rel}


@app.post("/api/projects/{pid}/push")
def push(pid: str):
    """Envoie sur overleaf.com les fichiers modifiés ou créés localement."""
    ensure_local(pid)
    files = changed_files(pid)
    for rel in files:
        call(client().upload, pid, rel, safe_path(pid, rel).read_bytes())
    manifest_path(pid).write_text(json.dumps(snapshot(pid)))
    return {"ok": True, "uploaded": files}


@app.post("/api/projects/{pid}/compile")
def compile_pdf(pid: str):
    """Envoie les modifs puis compile sur les serveurs d'Overleaf, et récupère PDF + log."""
    t0 = time.time()
    uploaded = push(pid)["uploaded"] if src(pid).exists() else []
    res = call(client().compile, pid)
    status = res.get("status")
    log = call(client().output_file, pid, res, "output.log")
    pdf = call(client().output_file, pid, res, "output.pdf")
    if pdf:
        (pdir(pid) / "output.pdf").write_bytes(pdf)
    return {"ok": bool(pdf), "status": status, "uploaded": uploaded,
            "duration": round(time.time() - t0, 1),
            "log": (log or b"").decode("utf-8", "replace")}


@app.get("/api/projects/{pid}/has-pdf")
def has_pdf(pid: str):
    return {"exists": (pdir(pid) / "output.pdf").exists()}


@app.get("/api/projects/{pid}/pdf")
def get_pdf(pid: str):
    pdf = pdir(pid) / "output.pdf"
    if not pdf.exists():
        raise HTTPException(404, "Pas encore compilé")
    return FileResponse(pdf, media_type="application/pdf", headers={"Cache-Control": "no-store"})


# ---------- assistant IA : Claude (abonnement) ou Ollama (local) ----------
@app.get("/api/ai/providers")
def ai_providers():
    """IA utilisables sur ce poste, pour le sélecteur du chat."""
    try:
        import claude_agent_sdk  # noqa: F401

        claude = {"available": bool(shutil.which("claude")),
                  "reason": None if shutil.which("claude") else "CLI claude introuvable dans le PATH"}
    except ModuleNotFoundError:
        claude = {"available": False, "reason": "Claude Agent SDK non installé"}

    import ai_ollama

    try:
        ollama = {"available": True, "models": ai_ollama.list_models(), "reason": None}
    except Exception:  # noqa: BLE001
        ollama = {"available": False, "models": [], "reason": f"Ollama injoignable sur {ai_ollama.OLLAMA_URL}"}
    return {"claude": claude, "ollama": ollama}


class ChatBody(BaseModel):
    message: str
    session_id: str | None = None
    current_file: str | None = None
    provider: str = "claude"  # "claude" | "ollama"
    model: str | None = None  # modèle Ollama


@app.post("/api/projects/{pid}/chat")
def chat(pid: str, body: ChatBody):
    """Conversation avec une IA qui modifie les fichiers du projet en local.
    Les modifications partent sur overleaf.com à la prochaine compilation ou au prochain envoi."""
    ensure_local(pid)
    if body.current_file:
        safe_path(pid, body.current_file)  # refuse un chemin hors du projet
    headers = {"Cache-Control": "no-store", "X-Accel-Buffering": "no"}

    if body.provider == "ollama":
        if not body.model:
            raise HTTPException(400, "Choisis un modèle Ollama")
        import ai_ollama

        stream = ai_ollama.chat_stream(src(pid), body.model, body.message, body.session_id, body.current_file)
        return StreamingResponse(stream, media_type="application/x-ndjson", headers=headers)

    try:
        from ai_chat import chat_stream  # import différé : le backend démarre même sans le SDK
    except ModuleNotFoundError:
        raise HTTPException(
            503, "Le Claude Agent SDK n'est pas installé : backend/.venv/bin/pip install claude-agent-sdk"
        )
    return StreamingResponse(
        chat_stream(src(pid), body.message, body.session_id, body.current_file),
        media_type="application/x-ndjson",
        headers=headers,
    )
