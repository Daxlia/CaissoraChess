// Localizzazione: l'inglese è incorporato (fallback sempre disponibile). Le altre lingue
// si aggiungeranno come file JSON con le stesse chiavi di locales/en.json.
import en from "../locales/en.json";

type Dict = { [k: string]: string | Dict };
let current: Dict = en as Dict;
const fallback: Dict = en as Dict;
export let language = "en";

function lookup(d: Dict, key: string): string | undefined {
  let cur: string | Dict | undefined = d;
  for (const part of key.split(".")) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = cur[part];
  }
  return typeof cur === "string" ? cur : undefined;
}

/** Traduce `key`; `{name}` viene sostituito dai parametri. Chiave mancante → fallback inglese → chiave. */
export function t(key: string, params: Record<string, string | number> = {}): string {
  const raw = lookup(current, key) ?? lookup(fallback, key) ?? key;
  return raw.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

export function setDictionary(code: string, dict: Dict | null): void {
  current = dict ?? fallback;
  language = dict ? code : "en";
  document.documentElement.lang = language;
}

/** Lingua preferita dal sistema, ridotta al codice a due lettere ("it-IT" → "it"). */
export function systemLanguage(): string {
  return (navigator.language || "en").slice(0, 2).toLowerCase();
}
