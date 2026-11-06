# OverleafForkAPP

Éditeur LaTeX personnel (React + FastAPI) branché sur **overleaf.com** : on gère ses projets,
on édite, on compile sur les serveurs d'Overleaf et on se fait aider par une IA (Claude ou un
modèle local Ollama). Les modifications sont visibles immédiatement dans la webapp Overleaf.

> ⚠️ Utilise l'API web **non officielle** d'Overleaf (celle de son interface), authentifiée par
> ton cookie de session. Elle peut changer sans préavis. Projet personnel, à faire tourner en local.

## Fonctionnalités

- **Projets** (`/`) : liste issue du tableau de bord Overleaf (dates, propriétaire, dernier auteur),
  recherche, filtres (mes projets, partagés, archivés), création d'un projet vide ou d'exemple.
- **Éditeur** (`/projet/:id`) : source LaTeX et PDF côte à côte, sauvegarde automatique,
  recompilation à chaque sauvegarde (ou Cmd+S), erreurs et avertissements du log cliquables.
- **Fichiers** : arborescence avec dossiers, ajout d'images / vidéos (bouton ou glisser-déposer),
  renommage, suppression — tout est répercuté sur overleaf.com. Aperçu des médias et insertion
  d'un bloc `figure` / `\includegraphics` en un clic.
- **Assistant IA** : chat qui modifie les fichiers du projet, affiché au fil de l'eau.
  - **Claude** via le [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk), qui réutilise
    la connexion de la CLI `claude` (ton abonnement) — usage personnel et local uniquement.
  - **Ollama** (modèles locaux) avec une boucle d'outils : lecture, remplacement de lignes ou de
    passages, création de fichiers (jamais d'écrasement d'un fichier existant).

## Installation

Prérequis : Python 3.10+, Node 20+, et pour l'IA la CLI [`claude`](https://code.claude.com)
connectée et/ou [Ollama](https://ollama.com).

```bash
# Backend
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
# (le SDK Claude peut être installé depuis les sources pour réutiliser la CLI claude existante :
#  .venv/bin/pip install --no-binary claude-agent-sdk claude-agent-sdk==0.2.178)
cp .env.example .env

# Frontend
cd ../frontend
npm install
```

### Configuration (`backend/.env`)

1. Connecte-toi sur overleaf.com.
2. DevTools → Application (Chrome) / Stockage (Firefox) → Cookies → `https://www.overleaf.com`.
3. Copie la valeur du cookie **`overleaf_session2`** dans `OVERLEAF_SESSION=`.

Ce cookie donne un accès complet à ton compte : ne le commite jamais (`.env` est ignoré par git).

Variables facultatives : `OLLAMA_HOST` (défaut `http://localhost:11434`), `OLLAMA_NUM_CTX`
(contexte, défaut 16384), `OLLAMA_TIMEOUT` (secondes, défaut 180), `CLAUDE_MODEL`.

## Lancer

```bash
cd backend && .venv/bin/uvicorn main:app --reload --port 8010   # terminal 1
cd frontend && npm run dev                                       # terminal 2 → http://localhost:5180
```

Lance le backend depuis un terminal ordinaire : depuis une session Claude Code, il hérite de
variables d'environnement que le backend nettoie, mais mieux vaut l'éviter.

## Routes Overleaf utilisées

| Usage | Route |
|---|---|
| Liste des projets | `POST /api/project` (repli : `GET /user/projects`) |
| Création | `POST /project/new` |
| Téléchargement | `GET /Project/:id/download/zip` |
| Envoi / remplacement d'un fichier | `POST /Project/:id/upload` |
| Dossiers, renommage, suppression | `POST /project/:id/folder`, `POST /project/:id/:type/:id/rename`, `DELETE /project/:id/:type/:id` |
| Compilation | `POST /project/:id/compile`, puis fichiers de sortie |
| Arborescence (identifiants) | socket.io temps réel, `joinProjectResponse` |

## Limites

- pdfLaTeX n'inclut que les images PNG, JPG, PDF et EPS, et ne lit pas les vidéos (l'insertion
  ajoute un lien vers le fichier).
- Les modèles Ollama de petite taille sont peu fiables pour modifier un document : relis leurs
  modifications.
- Le cookie de session expire si tu te déconnectes d'overleaf.com.
