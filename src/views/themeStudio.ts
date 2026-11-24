// Theme Studio: editor volutamente semplice di temi di scacchiera. Costruisce un manifest dichiarativo dai controlli,
// mostra l'anteprima dal vivo, installa il tema o lo scarica come .cctheme. Non crea temi 3D né pezzi (vedi guida).
import { Board } from "../board/Board";
import { api, errText } from "../api";
import { h, toast } from "../dom";
import { t } from "../i18n";
import { setSetting } from "../settings";
import { activeIds, forgetTheme, loadTheme, refreshThemes, type LoadedTheme } from "../themes/registry";
import type { Ambient, Manifest } from "../themes/types";
import { zipStore } from "../themes/zip";
import type { View } from "./types";

const PREVIEW = "r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P4/2PBPN2/PP1N1PPP/R1BQ1RK1 w - - 0 9";
const MAX_IMAGE = 6 * 1024 * 1024;

interface Form {
  name: string; id: string; author: string; license: string; description: string;
  light: string; dark: string; gloss: number; bevel: number; grid: boolean; gridColor: string;
  frameW: number; frameColor: string; frameBevel: number; glow: boolean; glowColor: string;
  bg1: string; bg2: string; tilt: number; hlStyle: "fill" | "ring" | "glow"; hlLast: string; hlSel: string;
  particles: "none" | "snow" | "embers" | "sparkles"; sweep: boolean; vignette: number;
}
type TexKey = "light" | "dark" | "frame";

const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
const idOk = (id: string) => /^[a-z0-9](?:[a-z0-9]|-(?!-)){1,38}[a-z0-9]$/.test(id);
const extOf = (f: File) => (f.type === "image/png" ? "png" : f.type === "image/webp" ? "webp" : f.type === "image/jpeg" ? "jpg" : "");

const DEFAULTS: Form = {
  name: "", id: "", author: "", license: "CC-BY-4.0", description: "",
  light: "#ecd9b0", dark: "#a87c50", gloss: 0.2, bevel: 0.15, grid: false, gridColor: "#19e6ff",
  frameW: 0.3, frameColor: "#3a2c20", frameBevel: 0.6, glow: false, glowColor: "#ffcf70",
  bg1: "#2d241b", bg2: "#100c09", tilt: 0, hlStyle: "fill", hlLast: "#f6e25a", hlSel: "#50a0ff",
  particles: "none", sweep: false, vignette: 0.3,
};

export async function themeStudio(): Promise<View> {
  const f: Form = { ...DEFAULTS };
  const tex: Partial<Record<TexKey, File>> = {};
  let ver = 0;

  const host = h("div", { class: "board-host studio-board" });
  const board = new Board(host, { legalMoves: async () => [] });
  board.setInteractive(false); board.setPosition(PREVIEW, "w");
  void loadTheme(activeIds().pieces).then((p) => board.setPieceTheme(p)).catch(() => undefined);

  function manifest(): Manifest {
    const tx = (k: TexKey) => (tex[k] ? `${k}.${extOf(tex[k]!)}` : undefined);
    const ambient: Ambient[] = [];
    if (f.sweep) ambient.push({ type: "sweep", color: "#ffffff", periodSeconds: 8, opacity: 0.3, width: 0.2 });
    if (f.particles === "snow") ambient.push({ type: "particles", color: "#ffffff", count: 60, size: 0.006, speed: 0.03, direction: "drift", glow: 0.3 });
    if (f.particles === "embers") ambient.push({ type: "particles", color: "#ff9a3c", count: 36, size: 0.007, speed: 0.04, direction: "up", glow: 0.9 });
    if (f.particles === "sparkles") ambient.push({ type: "particles", color: "#ffe9a8", count: 40, size: 0.006, speed: 0.015, direction: "up", glow: 0.8 });
    if (f.vignette > 0) ambient.push({ type: "vignette", color: "#000000", strength: f.vignette });
    const hex = (c: string, a: number) => `${c}${Math.round(a * 255).toString(16).padStart(2, "0")}`;
    return {
      format: 1, id: f.id || "my-theme", name: f.name || "My theme", version: "1.0.0", author: f.author || "Anonymous", license: f.license, description: f.description,
      board: {
        view: { tilt: f.tilt, camera: 2.5 },
        scene: { gradient: { kind: "radial", stops: [{ at: 0, color: f.bg1 }, { at: 1, color: f.bg2 }] } },
        frame: f.frameW > 0.01 ? { width: f.frameW, paint: { color: f.frameColor, texture: tx("frame") }, bevel: f.frameBevel, glow: f.glow ? { color: f.glowColor, radius: 0.5, pulseSeconds: 3.5 } : undefined } : undefined,
        squares: { light: { color: f.light, texture: tx("light") }, dark: { color: f.dark, texture: tx("dark") }, gloss: f.gloss, bevel: f.bevel, grid: f.grid ? { color: f.gridColor, width: 0.012, glow: 0.7 } : undefined },
        highlights: { style: f.hlStyle, lastMove: hex(f.hlLast, 0.55), selected: hex(f.hlSel, 0.6), legal: hex(f.hlSel, 0.85), check: "#eb3c3cb3" },
        coordinates: { placement: f.frameW >= 0.2 ? "frame" : "inside", color: "rgba(255,255,255,0.8)" },
        ambient,
      },
    };
  }

  const imgCache = new Map<string, HTMLImageElement>();
  async function preview(): Promise<void> {
    const my = ++ver; const m = manifest();
    const images = new Map<string, HTMLImageElement>();
    for (const k of Object.keys(tex) as TexKey[]) {
      const file = tex[k]!; const key = `${k}.${extOf(file)}`;
      let img = imgCache.get(`${key}:${file.size}:${file.lastModified}`);
      if (!img) { img = await decodeFile(file); imgCache.set(`${key}:${file.size}:${file.lastModified}`, img); }
      images.set(key, img);
    }
    if (my !== ver) return;
    const lt: LoadedTheme = { manifest: m, images };
    board.setBoardTheme(lt);
  }
  let timer = 0; const schedule = () => { clearTimeout(timer); timer = window.setTimeout(() => void preview(), 120); };

  const row = (label: string, ctl: Node) => h("label", { class: "field" }, h("span", {}, label), ctl);
  const text = (k: "name" | "author" | "description", max: number) => { const i = h("input", { type: "text", value: f[k], maxlength: String(max) }) as HTMLInputElement; i.addEventListener("input", () => { f[k] = i.value; if (k === "name" && !idTouched) { f.id = slug(f.name); idInput.value = f.id; } schedule(); validate(); }); return i; };
  let idTouched = false;
  const idInput = h("input", { type: "text", value: f.id, maxlength: "40", spellcheck: "false" }) as HTMLInputElement;
  idInput.addEventListener("input", () => { idTouched = true; f.id = idInput.value; validate(); });
  const color = (k: "light" | "dark" | "gridColor" | "frameColor" | "glowColor" | "bg1" | "bg2" | "hlLast" | "hlSel") => { const i = h("input", { type: "color", value: f[k] }) as HTMLInputElement; i.addEventListener("input", () => { f[k] = i.value; schedule(); }); return i; };
  const range = (k: "gloss" | "bevel" | "frameW" | "frameBevel" | "tilt" | "vignette", min: number, max: number, step: number) => { const i = h("input", { type: "range", min: String(min), max: String(max), step: String(step), value: String(f[k]) }) as HTMLInputElement; i.addEventListener("input", () => { f[k] = Number(i.value); schedule(); }); return i; };
  const check = (k: "grid" | "glow" | "sweep") => { const i = h("input", { type: "checkbox" }) as HTMLInputElement; i.checked = f[k]; i.addEventListener("change", () => { f[k] = i.checked; schedule(); }); return i; };
  const select = <K extends "hlStyle" | "particles" | "license">(k: K, opts: [string, string][]) => { const s = h("select", {}, ...opts.map(([v, l]) => h("option", { value: v }, l))) as HTMLSelectElement; s.value = String(f[k]); s.addEventListener("change", () => { (f as unknown as Record<string, string>)[k] = s.value; schedule(); }); return s; };
  const texture = (k: TexKey, label: string) => {
    const name = h("span", { class: "dim small" }, "");
    const input = h("input", { type: "file", accept: "image/png,image/webp,image/jpeg", hidden: true }) as HTMLInputElement;
    const clearBtn = h("button", { class: "btn small", type: "button", hidden: true, onClick: () => { delete tex[k]; name.textContent = ""; clearBtn.hidden = true; schedule(); } }, t("themes.studio.clearImage"));
    input.addEventListener("change", () => { const file = input.files?.[0]; input.value = ""; if (!file) return; if (!extOf(file)) return toast("png, webp, jpg", "error"); if (file.size > MAX_IMAGE) return toast(t("themes.studio.bigImage"), "error"); tex[k] = file; name.textContent = file.name; clearBtn.hidden = false; schedule(); });
    return row(label, h("div", { class: "row" }, h("button", { class: "btn small", type: "button", onClick: () => input.click() }, t("themes.studio.chooseImage")), clearBtn, name, input));
  };
  const group = (title: string, ...rows: Node[]) => h("fieldset", { class: "studio-group" }, h("legend", {}, title), ...rows);

  const status = h("p", { class: "dim small" }, "");
  const installBtn = h("button", { class: "btn primary", type: "button" }, t("themes.studio.install")) as HTMLButtonElement;
  const dlBtn = h("button", { class: "btn", type: "button" }, t("themes.studio.download")) as HTMLButtonElement;
  const validate = () => { const ok = f.name.trim().length > 0 && idOk(f.id); installBtn.disabled = dlBtn.disabled = !ok; status.textContent = ok ? "" : t("themes.studio.needName"); };

  async function pack(): Promise<Uint8Array> {
    const enc = new TextEncoder();
    const files = [{ name: "theme.json", data: enc.encode(JSON.stringify(manifest(), null, 2)) }];
    for (const k of Object.keys(tex) as TexKey[]) files.push({ name: `${k}.${extOf(tex[k]!)}`, data: new Uint8Array(await tex[k]!.arrayBuffer()) });
    return zipStore(files);
  }
  installBtn.addEventListener("click", async () => {
    try {
      const inst = await api.themesImport(await pack());
      forgetTheme(inst.id); await refreshThemes();
      await setSetting("board_theme", inst.id);
      window.dispatchEvent(new CustomEvent("themes-changed")); toast(t("themes.studio.installedOk"));
    } catch (e) { toast(errText(e).replace(/^invalid data: theme: /, ""), "error"); }
  });
  dlBtn.addEventListener("click", async () => {
    const blob = new Blob([await pack() as BlobPart], { type: "application/zip" });
    const a = h("a", { href: URL.createObjectURL(blob), download: `${f.id}.cctheme` }); document.body.append(a); a.click(); a.remove();
  });

  const form = h("div", { class: "studio-form" },
    group(t("themes.studio.identity"), row(t("themes.studio.name"), text("name", 60)), row(t("themes.studio.id"), idInput), row(t("themes.studio.author"), text("author", 80)),
      row(t("themes.studio.license"), select("license", [["CC0-1.0", "CC0-1.0"], ["CC-BY-4.0", "CC-BY-4.0"], ["CC-BY-SA-4.0", "CC-BY-SA-4.0"], ["MIT", "MIT"]])), row(t("themes.studio.description"), text("description", 600))),
    group(t("themes.studio.squares"), row(t("themes.studio.light"), color("light")), row(t("themes.studio.dark"), color("dark")), texture("light", t("themes.studio.lightTex")), texture("dark", t("themes.studio.darkTex")),
      row(t("themes.studio.gloss"), range("gloss", 0, 1, 0.05)), row(t("themes.studio.bevel"), range("bevel", 0, 1, 0.05)), row(t("themes.studio.grid"), check("grid")), row(t("themes.studio.gridColor"), color("gridColor"))),
    group(t("themes.studio.frame"), row(t("themes.studio.frameWidth"), range("frameW", 0, 0.6, 0.02)), row(t("themes.studio.frameColor"), color("frameColor")), texture("frame", t("themes.studio.frameTex")),
      row(t("themes.studio.bevel"), range("frameBevel", 0, 1, 0.05)), row(t("themes.studio.glow"), check("glow")), row(t("themes.studio.glowColor"), color("glowColor"))),
    group(t("themes.studio.scene"), row(t("themes.studio.bg1"), color("bg1")), row(t("themes.studio.bg2"), color("bg2")), row(t("themes.studio.tilt"), range("tilt", 0, 60, 1))),
    group(t("themes.studio.highlights"), row(t("themes.studio.hlStyle"), select("hlStyle", [["fill", t("themes.studio.hlFill")], ["ring", t("themes.studio.hlRing")], ["glow", t("themes.studio.hlGlow")]])), row(t("themes.studio.hlLast"), color("hlLast")), row(t("themes.studio.hlSel"), color("hlSel"))),
    group(t("themes.studio.effects"), row(t("themes.studio.particles"), select("particles", [["none", t("themes.studio.pNone")], ["snow", t("themes.studio.pSnow")], ["embers", t("themes.studio.pEmbers")], ["sparkles", t("themes.studio.pSparkles")]])), row(t("themes.studio.sweep"), check("sweep")), row(t("themes.studio.vignette"), range("vignette", 0, 1, 0.05))));

  const paras = (s: string) => s.split("\n").map((p) => h("p", { class: "guide-p" }, p));
  const guide = h("section", { class: "card col guide" },
    h("h2", {}, t("themes.studio.guideTitle")), h("p", {}, t("themes.studio.guideFormat")),
    h("details", {}, h("summary", {}, t("themes.studio.guideFieldsTitle")), ...paras(t("themes.studio.guideFields"))),
    h("details", { open: true }, h("summary", {}, t("themes.studio.guide3dTitle")), ...paras(t("themes.studio.guide3d"))));

  const el = h("div", { class: "col" },
    h("section", { class: "card studio-warn" }, h("h2", {}, t("themes.studio.warnTitle")), h("p", {}, t("themes.studio.warnBody"))),
    h("div", { class: "studio" }, form, h("div", { class: "studio-side" }, host, h("p", { class: "dim small" }, t("themes.studio.previewNote")), h("div", { class: "row" }, installBtn, dlBtn), status)),
    guide);
  validate(); void preview();
  return { el, destroy: () => { clearTimeout(timer); board.destroy(); } };
}

function decodeFile(file: File): Promise<HTMLImageElement> {
  return new Promise((res, rej) => { const url = URL.createObjectURL(file); const img = new Image(); img.onload = () => { URL.revokeObjectURL(url); res(img); }; img.onerror = () => { URL.revokeObjectURL(url); rej(new Error("image")); }; img.src = url; });
}
