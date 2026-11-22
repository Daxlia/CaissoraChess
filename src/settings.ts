// Impostazioni persistite in SQLite (tramite backend). Cache locale + evento di cambio.
import { api } from "./api";

const cache: Record<string, string> = {};

export async function loadSettings(): Promise<void> {
  Object.assign(cache, await api.settingsAll());
}
export const getSetting = (key: string, fallback: string): string => cache[key] ?? fallback;

export async function setSetting(key: string, value: string): Promise<void> {
  await api.settingsSet(key, value); // se il backend rifiuta, la cache non cambia
  cache[key] = value;
  window.dispatchEvent(new CustomEvent("settings-changed", { detail: { key } }));
}
