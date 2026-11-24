import "./styles.css";
import { api, errText } from "./api";
import { clear, h } from "./dom";
import { ICONS } from "./icons";
import { t } from "./i18n";
import { getSetting, loadSettings } from "./settings";
import { activeIds, loadTheme, refreshThemes } from "./themes/registry";
import { applyAccent, applyMode, applyReducedMotion, type Mode } from "./theme";
import type { View } from "./views/types";

type Section = "play" | "training" | "academy" | "themes" | "settings";
const SECTIONS: Section[] = ["play", "training", "academy", "themes", "settings"];

const loaders: Record<Section, () => Promise<View>> = {
  play: async () => (await import("./views/play")).playView(),
  training: async () => (await import("./views/training")).trainingView(),
  academy: async () => (await import("./views/academy")).academyView(),
  themes: async () => (await import("./views/themes")).themesView(),
  settings: async () => (await import("./views/settings")).settingsView(),
};

async function boot(): Promise<void> {
  const app = document.getElementById("app")!;
  try {
    await loadSettings();
    await refreshThemes();
    const ids = activeIds();
    await Promise.all([loadTheme(ids.board), loadTheme(ids.pieces)]); // la prima scacchiera si disegna subito, senza attese
  } catch (e) {
    app.append(h("div", { class: "main" }, h("div", { class: "error-box" }, t("app.startFailed", { error: errText(e) }))));
    return;
  }
  applyMode(getSetting("theme_mode", "system") as Mode);
  applyAccent(getSetting("accent", "#d9a441"));
  applyReducedMotion(getSetting("reduce_motion", "0") === "1");

  const main = h("main", { class: "main", id: "main" });
  const nav = h("nav", { class: "nav", "aria-label": t("nav.label") }, h("div", { class: "brand" }, h("span", { class: "brand-mark" }), "CaissoraChess"));
  const buttons = new Map<Section, HTMLButtonElement>();
  for (const s of SECTIONS) {
    const b = h("button", { class: "nav-item", type: "button", onClick: () => void go(s) });
    b.innerHTML = ICONS[s];
    b.append(h("span", {}, t(`nav.${s}`)));
    buttons.set(s, b); nav.append(b);
  }
  app.append(h("div", { class: "shell" }, nav, main));

  let current: View | null = null; let seq = 0;
  async function go(s: Section): Promise<void> {
    const my = ++seq;
    for (const [k, b] of buttons) { if (k === s) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); }
    current?.destroy?.(); current = null; clear(main);
    try {
      const v = await loaders[s]();
      if (my !== seq) { v.destroy?.(); return; } // l'utente ha già cambiato sezione
      current = v; main.append(v.el); main.scrollTop = 0;
    } catch (e) {
      if (my === seq) main.append(h("div", { class: "view" }, h("div", { class: "error-box" }, t("app.viewFailed", { error: errText(e) }))));
    }
  }
  await go("play");
  void api; // il modulo api è usato dalle viste
}

void boot();
