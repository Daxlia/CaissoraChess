#!/usr/bin/env node
// Verifica la localizzazione: ogni chiave usata nel codice esiste in locales/en.json, nessuna
// chiave è inutilizzata, e locales/template.json è identico a en.json (template per i traduttori).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const en = JSON.parse(readFileSync(join(root, "locales/en.json"), "utf8"));
const template = readFileSync(join(root, "locales/template.json"), "utf8");

const flat = (o, p = "") => Object.entries(o).flatMap(([k, v]) => (typeof v === "object" ? flat(v, `${p}${k}.`) : [`${p}${k}`]));
const defined = new Set(flat(en));

const files = [];
(function walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p) : /\.ts$/.test(p) && !/\.test\.ts$/.test(p) && files.push(p); } })(join(root, "src"));

const used = new Set();
const usedLiteral = new Set();
const dynamicPrefixes = new Set();
for (const f of files) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/\bt\(\s*["'`]([\w.]+)["'`]/g)) used.add(m[1]);
  for (const m of src.matchAll(/\bt\(\s*`([\w.]+\.)\$\{/g)) dynamicPrefixes.add(m[1]); // t(`play.preset.${x}`)
  for (const m of src.matchAll(/data-i18n="([\w.]+)"/g)) used.add(m[1]);
  // una chiave passata come stringa a un helper (field("settings.x", ...)) conta come usata
  for (const k of defined) if (src.includes(`"${k}"`) || src.includes(`'${k}'`) || src.includes(`\`${k}\``)) usedLiteral.add(k);
}

let bad = 0;
for (const k of used) if (!defined.has(k)) { console.error(`missing in en.json: ${k}`); bad++; }
for (const k of defined) if (!used.has(k) && !usedLiteral.has(k) && ![...dynamicPrefixes].some((p) => k.startsWith(p))) { console.error(`unused key: ${k}`); bad++; }
if (template !== readFileSync(join(root, "locales/en.json"), "utf8")) { console.error("locales/template.json differs from en.json (run: cp locales/en.json locales/template.json)"); bad++; }
console.log(`${defined.size} keys, ${used.size} used statically, ${dynamicPrefixes.size} dynamic prefixes; ${bad} problem(s)`);
process.exit(bad ? 1 : 0);
