# AGENTS.md — front plavalaguna

Directives pour les agents travaillant sur `app/`. Elles priment sur
[../AGENTS.md](../AGENTS.md) pour le code du front ; les invariants du monorepo
(version, contrat généré, contextes de build séparés) restent ceux de la racine.

## Ce qu'est le front

L'interface de pilotage de l'API de vocalisation : lancer un workflow depuis le
catalogue serveur, suivre ses étapes, relire et corriger le script avant
synthèse, écouter le résultat, diagnostiquer un run, tenir le lexique de
prononciation. Le public et ses usages sont décrits dans [PRODUCT.md](PRODUCT.md),
l'identité visuelle dans [DESIGN.md](DESIGN.md).

React 19 + TypeScript strict, Vite 7, Tailwind CSS v4 (plugin Vite), composants
shadcn/ui (variante « new-york »), React Router 7, Zod 4, pnpm.

## Commandes

```bash
pnpm install --frozen-lockfile
pnpm dev                # serveur de développement, http://localhost:5173
pnpm lint               # ESLint
pnpm format             # Prettier, réécrit les fichiers
pnpm format:check       # Prettier, vérifie sans réécrire (ce que la CI exécute)
pnpm typecheck          # vérification de types, tsc -b (ce que la CI exécute)
pnpm build              # tsc -b puis build Vite
pnpm types:api          # régénère les types du contrat depuis ../api/openapi.json
```

La CI exécute `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm build`,
puis vérifie que `src/services/vocalization/api-schema.d.ts` correspond à
`../api/openapi.json`.
Toutes ces étapes sont bloquantes : lancez `pnpm format` avant de committer.

Le style est celui de `.prettierrc.json` (guillemets doubles, sans
point-virgule, 100 colonnes) : ne le corrigez pas à la main. Prettier et ESLint
ignorent les dossiers de skills d'agents (`.agents/` pour Codex, `.claude/` pour
Claude Code) et `.impeccable/`, outillage vendorisé à ne pas retoucher. Prettier
ignore aussi `api-schema.d.ts` : il est généré, et le reformater ferait échouer
la comparaison de la CI.

Toujours `pnpm`, jamais `npm` ni `yarn`. `pnpm-workspace.yaml` ne déclare pas de
workspace : il n'autorise que les scripts de build d'`esbuild` et de
`@tailwindcss/oxide`. N'en ajoutez pas à la racine du monorepo (invariant nº 4).

## Structure

```
src/
├── main.tsx              routeur, découpage par route, préchargement au repos
├── layout.tsx            coquille des routes protégées : sidebar, fil d'Ariane, <Outlet/>
├── app/                  une page par route
│   ├── vocalizations/    liste ; detail/ (suivi, content/, runs/, runs/run/)
│   ├── workflows/        catalogue
│   ├── pronunciations/   lexique de prononciation
│   ├── settings/         version déployée
│   ├── login/ · not-found/
├── components/           composants applicatifs ; ui/ = shadcn/ui, content/ = éditeur de script
├── contexts/             authentification, fil d'Ariane
├── hooks/                récupération de données (une ressource par hook), polling, navigation
├── lib/                  config, client http, libellés, formatage, utilitaires
└── services/vocalization/ contrat (api-schema.d.ts généré, types.ts manuel), endpoints, client
```

Alias `@/` → `src/` (configuré dans `vite.config.ts`, `tsconfig.json` et
`components.json`).

Ajouter un composant shadcn/ui : `pnpm dlx shadcn@latest add <composant>`. Il est
copié dans `src/components/ui/` et peut être modifié librement.

## Règles à tenir

1. **Le contrat est généré.** `api-schema.d.ts` sort de `pnpm types:api` — ne
   jamais l'éditer à la main. `types.ts` est encore écrit à la main et fait foi
   pour le code existant ; la bascule vers les types générés est progressive
   (voir [../docs/BACKLOG.md](../docs/BACKLOG.md), nº 3). **Tout nouveau type de
   contrat part de `api-schema.d.ts`.** Après une évolution de l'API :
   `cd ../api && uv run python scripts/dump_openapi.py`, puis `pnpm types:api`.

2. **Le serveur est la source de vérité.** Pas de persistance locale des
   données métier, pas de react-query : des hooks simples dans `src/hooks/`.
   Le catalogue `GET /workflows/` est auto-descriptif — libellé, description,
   type de source — : aucune table locale de workflows à maintenir.

3. **Les chemins d'API passent par
   [endpoints.ts](src/services/vocalization/endpoints.ts), jamais en ligne.**
   Tous finissent par une barre oblique **sauf** `GET /artifacts/{id}/content` :
   une barre manquante déclenche une redirection 307 de FastAPI qui casse les
   écritures cross-origin précédées d'un preflight.

4. **`erasableSyntaxOnly` est actif** : une déclaration `enum` TypeScript ou une
   propriété de paramètre de constructeur est une erreur de compilation.
   Modéliser une énumération du contrat par un tableau `as const` et une union
   indexée (voir `types.ts`), affecter les champs de classe dans le corps du
   constructeur. `verbatimModuleSyntax` impose aussi `import type`.

5. **Navigation animée.** Tout ce qui change d'écran passe par `AppLink` /
   `AppNavLink` ([app-link.tsx](src/components/app-link.tsx)) ou
   `useAppNavigate` ([use-app-navigate.ts](src/hooks/use-app-navigate.ts)), qui
   activent la transition de vue du navigateur. Ce qui ne change que l'état d'une
   page (pagination, `?artifact=`) garde le `Link` de React Router. Vocabulaire de
   mouvement : [DESIGN.md](DESIGN.md), § Components → Motion.

6. **Découpage par route.** Reste dans le chunk d'entrée ce qui est sur le chemin
   d'atterrissage (connexion, liste des vocalisations, coquille, 404) ; le reste
   est chargé en différé puis préchargé au repos. Une nouvelle page suit ce
   patron dans `main.tsx`, avec son squelette dans `components/skeletons.tsx`.

## Design system

[DESIGN.md](DESIGN.md) fait autorité : « Le Carnet de rédaction », encre sur
papier, rouge Télégramme `#d61019` comme accent unique. Tout est encodé en jetons
dans [src/global.css](src/global.css) — `@theme` porte polices, rayons et ombres,
`:root` les couleurs sémantiques.

- Les composants utilisent les classes sémantiques (`bg-card`,
  `text-muted-foreground`, `bg-destructive-surface`), **jamais** les couleurs
  brutes de la palette Tailwind.
- Trois familles, trois rôles : `font-display` (Oswald) pour le nom de
  l'application et les titres de page, de carte et de dialogue ; `font-sans`
  (Inter) pour tout le reste ; l'utilitaire `headline` (Source Serif 4) pour le
  seul titre d'article. Polices auto-hébergées via `@fontsource-variable/*`,
  importées dans `main.tsx` — aucun CDN tiers.
- **Thème clair uniquement.** Aucun `ThemeProvider`, aucune classe `.dark`. La
  variante `dark` reste déclarée dans `global.css` pour qu'un `dark:` égaré ne
  s'active jamais sur `prefers-color-scheme`. N'ajoutez pas de variantes `dark:`.

## Ce qui n'est pas ce qu'il paraît

- **L'écran de connexion n'est pas une sécurité.** Mot de passe partagé, comparé
  côté client à une empreinte livrée dans le bundle, session dans
  `localStorage` (`src/lib/auth.ts`). L'API n'est pas authentifiée. Ne
  construisez rien qui suppose une identité d'utilisateur — voir
  [../docs/BACKLOG.md](../docs/BACKLOG.md), nº 1.
- **La clé `tyia-auth-status`** de `localStorage` vient de l'outil dont le front
  est issu. La renommer déconnecterait tout le monde, sans autre effet.
- `src/lib/storage.ts` (IndexedDB `tyia-toolbox`) n'est importé nulle part : code
  mort hérité, à ne pas prendre pour un mécanisme de réglages.
- `src/lib/legacy-cleanup.ts` supprime une fois, au démarrage, la base IndexedDB
  `plavalaguna-db` d'une version antérieure. Sa docstring prévoit de le retirer
  « dans une release ou deux ».
- La route `/dashboard` n'est qu'un alias vers `/vocalizations`, gardé pour les
  signets.

## Configuration

L'URL de l'API est lue à l'exécution dans `public/env.js`
(`window.VITE_VOCALIZATION_API_URL`), puis à défaut dans la variable de build du
même nom, puis la valeur QA. Elle **inclut** le préfixe `/vocalization`.
`window.VITE_LANGFUSE_BASE_URL`, facultative, rend cliquables les identifiants de
trace. `nginx.conf` ne sert que la SPA : il ne relaie pas l'API, qui doit donc
répondre aux requêtes cross-origin.
