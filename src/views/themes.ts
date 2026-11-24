// Sezione Temi: galleria in elenco (anteprime dal vivo), importazione, scelta indipendente di scacchiera e pezzi.
import { Board } from "../board/Board";
import { applyThemes, bindAppearance } from "../board/appearance";
import { api, errText } from "../api";
import { clear, h, modal, toast } from "../dom";
import { t } from "../i18n";
import { getSetting, setSetting } from "../settings";
import { activeIds, allThemes, forgetTheme, refreshThemes, type ThemeEntry } from "../themes/registry";
import type { View } from "./types";

const PREVIEW = "r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P4/2PBPN2/PP1N1PPP/R1BQ1RK1 w - - 0 9";
const DEMO = ["d4c5", "e7c5", "d3h7", "f6h7"];
type Filter = "all" | "complete" | "boards" | "pieces" | "imported";

function traits(m: ThemeEntry["manifest"]): string[] {
  const out: string[] = [];
  if (m.board) out.push(t("themes.badge.board"));
  if (m.pieces) out.push(t("themes.badge.pieces"));
  if ((m.board?.view?.tilt ?? 0) > 0) out.push(t("themes.badge.tilt"));
  const anim = (m.board?.ambient ?? []).some((a) => a.type !== "vignette") || !!m.board?.frame?.glow?.pulseSeconds || !!m.pieces?.idle || (m.pieces?.motion && m.pieces.motion.style !== "slide") || !!m.pieces?.capture && m.pieces.capture.effect !== "fade";
  if (anim) out.push(t("themes.badge.animated"));
  const hd = !!m.board?.squares.light.texture || (m.pieces?.resolutions ?? []).some((r) => parseInt(r) >= 2);
  if (hd) out.push(t("themes.badge.hd"));
  return out;
}

export async function themesView(): Promise<View> {
  await refreshThemes();
  const root = h("div", { class: "view themes-view" });
  const boards: Board[] = []; const cleanups: (() => void)[] = [];
  let studioCleanup: (() => void) | null = null;

  // ---------- hero: anteprima grande della combinazione in uso
  const heroHost = h("div", { class: "board-host hero-board" });
  const heroBoard = new Board(heroHost, { legalMoves: async () => [] });
  heroBoard.setInteractive(false); heroBoard.setPosition(PREVIEW, "w"); cleanups.push(bindAppearance(heroBoard)); boards.push(heroBoard);
  const nowBoard = h("strong", {}), nowPieces = h("strong", {});
  const demoBtn = h("button", { class: "btn primary", type: "button" }, t("themes.demo"));
  let demoRunning = false;
  demoBtn.addEventListener("click", async () => {
    if (demoRunning) return; demoRunning = true; demoBtn.disabled = true;
    try {
      let fen = PREVIEW; heroBoard.setPosition(fen, "w");
      for (const mv of DEMO) {
        const after = await api.play(fen, mv);
        await heroBoard.animateMove(mv, after.fen, after.fen.split(" ")[1] === "b" ? "b" : "w");
        heroBoard.setLastMove(mv); heroBoard.setCheck(after.check_square);
        fen = after.fen; await new Promise((r) => setTimeout(r, 650));
      }
      await new Promise((r) => setTimeout(r, 900));
      heroBoard.setLastMove(null); heroBoard.setCheck(null); heroBoard.setPosition(PREVIEW, "w");
    } catch (e) { toast(errText(e), "error"); } finally { demoRunning = false; demoBtn.disabled = false; }
  });
  const fileInput = h("input", { type: "file", accept: ".cctheme,.zip,application/zip", hidden: true }) as HTMLInputElement;
  const importBtn = h("button", { class: "btn", type: "button", onClick: () => fileInput.click() }, t("themes.import"));
  const hero = h("section", { class: "theme-hero card" },
    heroHost,
    h("div", { class: "col hero-info" },
      h("h2", {}, t("themes.nowUsing")),
      h("div", { class: "now-line" }, h("span", { class: "dim" }, t("themes.nowBoard")), nowBoard),
      h("div", { class: "now-line" }, h("span", { class: "dim" }, t("themes.nowPieces")), nowPieces),
      h("p", { class: "dim small" }, t("themes.demoHint")),
      h("div", { class: "row" }, demoBtn, importBtn, fileInput),
      h("p", { class: "dim small" }, t("themes.dropHint"))));
  const refreshNow = () => {
    const ids = activeIds();
    nowBoard.textContent = allThemes().find((e) => e.manifest.id === ids.board)?.manifest.name ?? ids.board;
    nowPieces.textContent = allThemes().find((e) => e.manifest.id === ids.pieces)?.manifest.name ?? ids.pieces;
  };

  // ---------- importazione
  async function importFile(file: File): Promise<void> {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const inst = await api.themesImport(bytes);
      const name = (inst.manifest as { name: string }).name;
      forgetTheme(inst.id); await refreshThemes();
      window.dispatchEvent(new CustomEvent("themes-changed"));
      toast(t("themes.installed", { name })); drawGrid();
    } catch (e) {
      const body = h("p", { class: "import-error" }, errText(e).replace(/^invalid data: theme: /, "").replace(/^invalid data: /, ""));
      modal(t("themes.importFailed"), body, [{ label: "OK", primary: true, onClick: () => dlg.close() }]);
    }
  }
  const dlg = { close: () => document.querySelector<HTMLDialogElement>("dialog.modal")?.close() };
  fileInput.addEventListener("change", () => { const f = fileInput.files?.[0]; fileInput.value = ""; if (f) void importFile(f); });
  const onDrag = (e: DragEvent) => { if (e.dataTransfer?.types.includes("Files")) { e.preventDefault(); root.classList.add("dropping"); } };
  const onLeave = (e: DragEvent) => { if (e.target === root || !root.contains(e.relatedTarget as Node)) root.classList.remove("dropping"); };
  const onDrop = (e: DragEvent) => { e.preventDefault(); root.classList.remove("dropping"); const f = e.dataTransfer?.files?.[0]; if (f) void importFile(f); };
  root.addEventListener("dragover", onDrag); root.addEventListener("dragleave", onLeave); root.addEventListener("drop", onDrop);

  // ---------- galleria
  let filter: Filter = "all";
  const grid = h("div", { class: "theme-grid" });
  const seg = h("div", { class: "seg", role: "group" });
  const filters: Filter[] = ["all", "complete", "boards", "pieces", "imported"];
  const filterLabel: Record<Filter, string> = { all: t("themes.filter.all"), complete: t("themes.filter.complete"), boards: t("themes.filter.boards"), pieces: t("themes.filter.pieces"), imported: t("themes.filter.imported") };
  const drawSeg = () => { clear(seg); for (const f of filters) seg.append(h("button", { type: "button", "aria-pressed": String(filter === f), onClick: () => { filter = f; drawSeg(); drawGrid(); } }, filterLabel[f])); };

  const cardRefresh: (() => void)[] = [];
  function drawGrid(): void {
    for (const b of boards.splice(1)) b.destroy(); // il primo è l'anteprima grande
    cardRefresh.length = 0; clear(grid);
    const list = allThemes().filter((e) => filter === "all" || (filter === "complete" && e.manifest.board && e.manifest.pieces) || (filter === "boards" && e.manifest.board) || (filter === "pieces" && e.manifest.pieces) || (filter === "imported" && !e.builtin));
    if (!list.length) grid.append(h("p", { class: "empty" }, t("themes.empty")));
    for (const e of list) grid.append(card(e));
    refreshNow();
  }

  function card(e: ThemeEntry): HTMLElement {
    const m = e.manifest, id = m.id;
    const host = h("div", { class: "board-host card-board" });
    const b = new Board(host, { legalMoves: async () => [] });
    b.setInteractive(false); b.setPosition(PREVIEW, "w"); b.setAmbient(false); boards.push(b);
    const a = activeIds();
    void applyThemes(b, m.board ? id : a.board, m.pieces ? id : a.pieces).catch(() => undefined);
    const body = h("div", { class: "theme-body" });
    const actions = h("div", { class: "theme-actions" });
    const el = h("article", { class: "theme-card", tabindex: "0" },
      host, body);
    const on = () => b.setAmbient(true), off = () => b.setAmbient(false);
    el.addEventListener("mouseenter", on); el.addEventListener("mouseleave", off); el.addEventListener("focusin", on); el.addEventListener("focusout", off);
    const set = async (key: string, v: string) => { try { await setSetting(key, v); } catch (err) { toast(errText(err), "error"); } };
    const draw = () => {
      const cur = activeIds(); clear(body); clear(actions);
      body.append(
        h("div", { class: "theme-title" }, h("h3", {}, m.name), e.builtin ? null : h("span", { class: "badge accent" }, t("themes.badge.imported"))),
        h("p", { class: "dim small" }, t("themes.by", { author: m.author }) + " · v" + m.version),
        m.description ? h("p", { class: "theme-desc" }, m.description) : "",
        h("div", { class: "badges" }, ...traits(m).map((x) => h("span", { class: "badge" }, x)), h("span", { class: "badge ghost", title: t("themes.license", { license: m.license }) }, m.license)),
        actions);
      const bothActive = cur.board === id && cur.pieces === id;
      if (m.board && m.pieces) actions.append(h("button", { class: "btn primary small", type: "button", disabled: bothActive, onClick: async () => { await set("board_theme", id); await set("piece_set", id); } }, bothActive ? t("themes.inUse") : t("themes.use")));
      if (m.board && (m.pieces ? !bothActive : true)) actions.append(h("button", { class: m.pieces ? "btn small" : "btn primary small", type: "button", disabled: cur.board === id, onClick: () => void set("board_theme", id) }, cur.board === id ? t("themes.boardInUse") : t("themes.useBoard")));
      if (m.pieces && (m.board ? !bothActive : true)) actions.append(h("button", { class: m.board ? "btn small" : "btn primary small", type: "button", disabled: cur.pieces === id, onClick: () => void set("piece_set", id) }, cur.pieces === id ? t("themes.piecesInUse") : t("themes.usePieces")));
      if (!e.builtin) actions.append(h("button", { class: "btn danger small", type: "button", onClick: () => confirmRemove(e) }, t("themes.remove")));
      el.classList.toggle("active", cur.board === id || cur.pieces === id);
    };
    draw(); cardRefresh.push(draw);
    return el;
  }

  function confirmRemove(e: ThemeEntry): void {
    const m = modal(t("themes.removeTitle"), h("p", {}, t("themes.removeBody", { name: e.manifest.name })), [
      { label: t("common.cancel"), onClick: () => m.close() },
      { label: t("themes.remove"), primary: true, onClick: async () => {
        try {
          await api.themesRemove(e.manifest.id); forgetTheme(e.manifest.id);
          if (getSetting("board_theme", "classic") === e.manifest.id) await setSetting("board_theme", "classic");
          if (getSetting("piece_set", "classic") === e.manifest.id) await setSetting("piece_set", "classic");
          await refreshThemes(); window.dispatchEvent(new CustomEvent("themes-changed")); m.close(); toast(t("themes.removed")); drawGrid();
        } catch (err) { toast(errText(err), "error"); }
      } },
    ]);
  }
  const onSettings = () => { cardRefresh.forEach((f) => f()); refreshNow(); };
  window.addEventListener("settings-changed", onSettings);
  cleanups.push(() => window.removeEventListener("settings-changed", onSettings));

  // ---------- schede Galleria / Crea
  const gallery = h("div", { class: "col" }, hero, h("div", { class: "spread" }, seg, h("p", { class: "dim small" }, t("themes.hoverHint"))), grid);
  const create = h("div", { class: "col" }); let createBuilt = false;
  const tabs = h("div", { class: "tabs", role: "tablist" });
  const showTab = async (which: "gallery" | "create") => {
    gallery.hidden = which !== "gallery"; create.hidden = which !== "create";
    clear(tabs);
    for (const k of ["gallery", "create"] as const) tabs.append(h("button", { class: "tab", role: "tab", type: "button", "aria-selected": String(which === k), onClick: () => void showTab(k) }, t(`themes.tab.${k}`)));
    if (which === "create" && !createBuilt) { createBuilt = true; const s = await (await import("./themeStudio")).themeStudio(); create.append(s.el); studioCleanup = s.destroy ?? null; }
  };
  root.append(h("div", { class: "page-head" }, h("h1", {}, t("nav.themes")), h("p", { class: "dim" }, t("themes.subtitle"))), tabs, gallery, create);
  drawSeg(); drawGrid(); await showTab("gallery");
  return { el: root, destroy: () => { root.removeEventListener("dragover", onDrag); root.removeEventListener("drop", onDrop); cleanups.forEach((f) => f()); boards.forEach((b) => b.destroy()); studioCleanup?.(); } };
}
