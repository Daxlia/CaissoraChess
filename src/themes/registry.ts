// Registro dei temi: incorporati (cartella src/themes/builtin, stesso formato dei temi importati) + importati (backend).
// Un tema "caricato" ha tutte le immagini già decodificate: il disegno della scacchiera non attende mai I/O.
import { api, type InstalledTheme } from "../api";
import { getSetting } from "../settings";
import { PIECE_IDS, type Manifest } from "./types";

const MANIFESTS = import.meta.glob("./builtin/*/theme.json", { eager: true, import: "default" }) as Record<string, Manifest>;
const ASSETS = import.meta.glob("./builtin/**/*.{webp,png,jpg,svg}", { eager: true, query: "?url", import: "default" }) as Record<string, string>;

export interface ThemeEntry { manifest: Manifest; builtin: boolean; installedAt?: string }
export interface LoadedTheme {
  manifest: Manifest;
  images: Map<string, HTMLImageElement>; // percorso nell'archivio → immagine decodificata
}

let entries: ThemeEntry[] = [];
const loaded = new Map<string, Promise<LoadedTheme>>();

export const DEFAULT_THEME = "classic";

export async function refreshThemes(): Promise<ThemeEntry[]> {
  const builtin: ThemeEntry[] = Object.values(MANIFESTS).map((m) => ({ manifest: m, builtin: true }));
  const order = ["classic", "obsidian", "neon", "glacier", "ivory-ebony", "emerald"];
  builtin.sort((a, b) => order.indexOf(a.manifest.id) - order.indexOf(b.manifest.id));
  let installed: InstalledTheme[] = [];
  try { installed = await api.themesList(); } catch { installed = []; }
  const ext: ThemeEntry[] = installed.map((i) => ({ manifest: i.manifest as Manifest, builtin: false, installedAt: i.installed_at }));
  entries = [...builtin, ...ext];
  for (const id of [...loaded.keys()]) if (!entries.some((e) => e.manifest.id === id)) loaded.delete(id);
  return entries;
}
export const allThemes = (): ThemeEntry[] => entries;
export const themeEntry = (id: string): ThemeEntry | undefined => entries.find((e) => e.manifest.id === id);
export function forgetTheme(id: string): void { loaded.delete(id); }

function neededPaths(m: Manifest): string[] {
  const out = new Set<string>();
  const paint = (p?: { texture?: string }) => { if (p?.texture) out.add(p.texture); };
  if (m.board) { paint(m.board.scene); paint(m.board.frame?.paint); paint(m.board.squares.light); paint(m.board.squares.dark); }
  if (m.pieces?.source) for (const pc of PIECE_IDS) for (const r of m.pieces.resolutions ?? ["1x"]) out.add(m.pieces.source.replace("{piece}", pc).replace("{res}", r));
  return [...out];
}

function decode(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => { const img = new Image(); img.decoding = "async"; img.onload = () => res(img); img.onerror = () => rej(new Error("cannot decode theme image")); img.src = url; });
}

export function loadTheme(id: string): Promise<LoadedTheme> {
  const hit = loaded.get(id); if (hit) return hit;
  const p = (async () => {
    const e = themeEntry(id);
    if (!e) throw new Error(`unknown theme ${id}`);
    const images = new Map<string, HTMLImageElement>();
    const blobs: string[] = [];
    await Promise.all(neededPaths(e.manifest).map(async (path) => {
      let url: string;
      if (e.builtin) { url = ASSETS[`./builtin/${id}/${path}`] ?? ""; if (!url) throw new Error(`built-in theme ${id} lacks ${path}`); }
      else {
        const buf = await api.themeAsset(id, path);
        const type = path.endsWith(".svg") ? "image/svg+xml" : path.endsWith(".png") ? "image/png" : path.endsWith(".webp") ? "image/webp" : "image/jpeg";
        url = URL.createObjectURL(new Blob([buf], { type })); blobs.push(url);
      }
      images.set(path, await decode(url));
    }));
    blobs.forEach((u) => URL.revokeObjectURL(u)); // le immagini sono già decodificate
    return { manifest: e.manifest, images };
  })();
  loaded.set(id, p);
  p.catch(() => loaded.delete(id));
  return p;
}

/** Id attivi: se un tema è stato rimosso o non fornisce più la parte richiesta, si torna al predefinito. */
export function activeIds(): { board: string; pieces: string } {
  const pick = (key: string, need: "board" | "pieces"): string => {
    const id = getSetting(key, DEFAULT_THEME);
    const e = themeEntry(id);
    return e && e.manifest[need] ? id : DEFAULT_THEME;
  };
  return { board: pick("board_theme", "board"), pieces: pick("piece_set", "pieces") };
}
