"""Client pour l'API web (non officielle) d'overleaf.com, authentifié par cookie de session.

Routes utilisées (vérifiées dans github.com/overleaf/overleaf, services/web/app/src/router.mjs) :
  GET  /user/projects                      -> liste des projets
  GET  /Project/:id/download/zip           -> archive du projet
  POST /Project/:id/upload?folder_id=...   -> crée / remplace un fichier (multipart "qqfile")
  POST /project/:id/compile                -> compilation sur les serveurs Overleaf
  GET  /project/:id/user/:uid/build/:b/output/:file -> fichiers de sortie (PDF, log)
  socket.io 0.9 (?projectId=...)           -> joinProjectResponse (arborescence + id du dossier racine)
"""
import json
import mimetypes
import re
import time

import requests
import truststore

# Utilise le trousseau macOS (indispensable derrière un proxy d'entreprise qui intercepte le TLS)
truststore.inject_into_ssl()


class OverleafError(Exception):
    pass


class OverleafClient:
    def __init__(self, session_cookie: str, base_url: str = "https://www.overleaf.com",
                 cookie_name: str = "overleaf_session2"):
        if not session_cookie:
            raise OverleafError("OVERLEAF_SESSION manquant dans backend/.env")
        self.cookie = session_cookie
        self.base = base_url.rstrip("/")
        self.s = requests.Session()
        self.s.headers["User-Agent"] = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) MonOverleaf/0.1"
        domain = re.sub(r"^https?://(www\.)?", "", self.base)
        self.s.cookies.set(cookie_name, session_cookie, domain="." + domain)
        self._csrf = None
        self._root_folder = {}

    # ---------- bas niveau ----------
    def _req(self, method, path, **kw):
        try:
            r = self.s.request(method, self.base + path, timeout=kw.pop("timeout", 60),
                               allow_redirects=False, **kw)
        except requests.RequestException as e:
            raise OverleafError(f"Erreur réseau vers Overleaf : {e}")
        if r.status_code in (301, 302) and "/login" in r.headers.get("Location", ""):
            raise OverleafError("Session expirée ou invalide : récupère un nouveau cookie overleaf_session2")
        if r.status_code == 403:
            raise OverleafError(f"403 sur {path} (accès refusé ou CSRF invalide)")
        if r.status_code >= 400:
            raise OverleafError(f"{r.status_code} sur {path} : {r.text[:300]}")
        return r

    @property
    def csrf(self) -> str:
        if not self._csrf:
            html = self._req("GET", "/project").text
            m = re.search(r'name="ol-csrfToken"\s+content="([^"]+)"', html)
            if not m:
                raise OverleafError("Jeton CSRF introuvable (es-tu bien connecté ?)")
            self._csrf = m.group(1)
        return self._csrf

    # ---------- API ----------
    def list_projects(self):
        data = self._req("GET", "/user/projects").json()
        return data.get("projects", data)

    def list_projects_detailed(self) -> list[dict]:
        """Liste du tableau de bord (POST /api/project) : dates, propriétaire, dernier auteur."""
        r = self._req(
            "POST", "/api/project",
            headers={"X-Csrf-Token": self.csrf},
            json={"filters": {}, "sort": {"by": "lastUpdated", "order": "desc"}, "page": {"size": 500}},
        )
        return r.json().get("projects", [])

    def create_project(self, name: str, template: str = "none") -> str:
        """Crée un projet vide ("none") ou l'exemple d'Overleaf ("example"). Renvoie son id."""
        r = self._req(
            "POST", "/project/new",
            headers={"X-Csrf-Token": self.csrf},
            json={"projectName": name, "template": template},
        )
        data = r.json()
        pid = data.get("project_id") or data.get("projectId") or data.get("_id")
        if not pid:
            raise OverleafError(f"Création refusée : {data}")
        return pid

    def download_zip(self, project_id: str) -> bytes:
        return self._req("GET", f"/Project/{project_id}/download/zip", timeout=120).content

    def join_project(self, project_id: str) -> dict:
        """Ouvre une connexion socket.io (transport xhr-polling) et lit joinProjectResponse."""
        t = lambda: int(time.time() * 1000)
        hs = self._req("GET", f"/socket.io/1/?projectId={project_id}&t={t()}").text
        sid = hs.split(":")[0]
        poll = f"/socket.io/1/xhr-polling/{sid}?projectId={project_id}"
        try:
            for _ in range(10):
                body = self._req("GET", f"{poll}&t={t()}", timeout=30).text
                for msg in self._decode_frames(body):
                    if msg.startswith("5:"):
                        payload = json.loads(msg.split(":", 3)[3])
                        if payload.get("name") == "joinProjectResponse":
                            return payload["args"][0]
                        if payload.get("name") == "connectionRejected":
                            raise OverleafError(f"Connexion temps réel refusée : {payload['args']}")
                    elif msg.startswith("7:"):
                        raise OverleafError("Connexion temps réel rejetée par Overleaf (session invalide ou pas d'accès au projet)")
                    elif msg.startswith("0"):
                        raise OverleafError("Connexion temps réel fermée par Overleaf")
        finally:
            try:
                self.s.get(f"{self.base}{poll}&disconnect=1", timeout=5)
            except requests.RequestException:
                pass
        raise OverleafError("Pas de joinProjectResponse reçu")

    @staticmethod
    def _decode_frames(body: str):
        # socket.io 0.9 : plusieurs messages => �<len>�<msg>...
        if not body.startswith("�"):
            return [body]
        parts = body.split("�")[1:]
        return [parts[i + 1] for i in range(0, len(parts) - 1, 2)]

    def root_folder_id(self, project_id: str) -> str:
        if project_id not in self._root_folder:
            project = self.join_project(project_id)["project"]
            self._root_folder[project_id] = project["rootFolder"][0]["_id"]
        return self._root_folder[project_id]

    # ---------- arborescence : chemin -> {type, id} ----------
    def tree(self, project_id: str) -> dict[str, dict]:
        """Index de l'arborescence Overleaf. Clé "" = dossier racine.
        Types Overleaf : "doc" (texte éditable), "file" (binaire), "folder"."""
        root = self.join_project(project_id)["project"]["rootFolder"][0]
        self._root_folder[project_id] = root["_id"]
        index = {"": {"type": "folder", "id": root["_id"]}}

        def walk(folder, prefix):
            for d in folder.get("docs", []):
                index[prefix + d["name"]] = {"type": "doc", "id": d["_id"]}
            for f in folder.get("fileRefs", []):
                index[prefix + f["name"]] = {"type": "file", "id": f["_id"]}
            for sub in folder.get("folders", []):
                index[prefix + sub["name"]] = {"type": "folder", "id": sub["_id"]}
                walk(sub, prefix + sub["name"] + "/")

        walk(root, "")
        return index

    def add_folder(self, project_id: str, name: str, parent_id: str) -> str:
        r = self._req(
            "POST", f"/project/{project_id}/folder",
            headers={"X-Csrf-Token": self.csrf},
            json={"name": name, "parent_folder_id": parent_id},
        )
        return r.json()["_id"]

    def mkdirp(self, project_id: str, path: str) -> str:
        """Crée les dossiers manquants d'un chemin (a/b/c) et renvoie l'id du dernier."""
        index = self.tree(project_id)
        current, parent_id = "", index[""]["id"]
        for part in [p for p in path.split("/") if p]:
            current = f"{current}/{part}" if current else part
            entry = index.get(current)
            if entry and entry["type"] != "folder":
                raise OverleafError(f"« {current} » existe déjà et n'est pas un dossier")
            parent_id = entry["id"] if entry else self.add_folder(project_id, part, parent_id)
        return parent_id

    def delete_entity(self, project_id: str, entity_type: str, entity_id: str):
        self._req("DELETE", f"/project/{project_id}/{entity_type}/{entity_id}",
                  headers={"X-Csrf-Token": self.csrf})

    def rename_entity(self, project_id: str, entity_type: str, entity_id: str, name: str):
        self._req("POST", f"/project/{project_id}/{entity_type}/{entity_id}/rename",
                  headers={"X-Csrf-Token": self.csrf}, json={"name": name})

    def upload(self, project_id: str, rel_path: str, content: bytes):
        """Crée ou remplace un fichier (les sous-dossiers sont créés au besoin)."""
        name = rel_path.rsplit("/", 1)[-1]
        mime = mimetypes.guess_type(name)[0] or "application/octet-stream"
        data = {"name": name}
        if "/" in rel_path:
            data["relativePath"] = rel_path
        r = self._req(
            "POST", f"/Project/{project_id}/upload",
            params={"folder_id": self.root_folder_id(project_id)},
            headers={"X-Csrf-Token": self.csrf},
            data=data, files={"qqfile": (name, content, mime)},
        )
        res = r.json()
        if not res.get("success"):
            raise OverleafError(f"Upload de {rel_path} refusé : {res}")
        return res

    def compile(self, project_id: str, draft: bool = False) -> dict:
        r = self._req(
            "POST", f"/project/{project_id}/compile",
            params={"auto_compile": "false"},
            headers={"X-Csrf-Token": self.csrf},
            json={"check": "silent", "draft": draft, "incrementalCompilesEnabled": True,
                  "stopOnFirstError": False},
            timeout=240,
        )
        return r.json()

    def output_file(self, project_id: str, compile_res: dict, filename: str) -> bytes | None:
        for f in compile_res.get("outputFiles", []):
            if f["path"] == filename:
                params = {}
                if compile_res.get("clsiServerId"):
                    params["clsiserverid"] = compile_res["clsiServerId"]
                return self._req("GET", f["url"], params=params, timeout=120).content
        return None
