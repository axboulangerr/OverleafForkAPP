export async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.detail || res.statusText)
  return data
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function loadPref(key, def) {
  try {
    const v = localStorage.getItem(key)
    return v === null ? def : JSON.parse(v)
  } catch {
    return def
  }
}

export function savePref(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* préférence de confort uniquement */
  }
}

export const fmtTime = (d) => d?.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })

const rtf = new Intl.RelativeTimeFormat("fr", { numeric: "auto" })
const UNITS = [
  ["year", 31536000],
  ["month", 2592000],
  ["week", 604800],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
]

/** « il y a 2 heures », « hier »… */
export function fmtRelative(iso) {
  if (!iso) return "—"
  const diff = (new Date(iso).getTime() - Date.now()) / 1000
  for (const [unit, sec] of UNITS) {
    if (Math.abs(diff) >= sec) return rtf.format(Math.round(diff / sec), unit)
  }
  return "à l'instant"
}

export const fmtDate = (iso) =>
  iso
    ? new Date(iso).toLocaleString("fr-FR", { dateStyle: "long", timeStyle: "short" })
    : ""

export const ACCESS_LABELS = {
  owner: "Propriétaire",
  readAndWrite: "Édition",
  readAndWriteTokenAccess: "Édition (lien)",
  review: "Relecture",
  readOnly: "Lecture seule",
  readOnlyTokenAccess: "Lecture (lien)",
}
