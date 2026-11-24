import { api, errText, type Opening } from "../api";
import { Board } from "../board/Board";
import { bindAppearance, turnOf } from "../board/appearance";
import { clear, h, toast } from "../dom";
import { t } from "../i18n";
import { createReplay, type Replay } from "./replay";
import type { View } from "./types";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export async function trainingView(): Promise<View> {
  const root = h("div", { class: "view" });
  const body = h("div");
  root.append(h("div", { class: "page-head" }, h("h1", {}, t("nav.training")), h("p", { class: "dim" }, t("training.subtitle"))),
    h("div", { class: "tabs", role: "tablist" }, h("button", { class: "tab", role: "tab", "aria-selected": "true" }, t("training.openings"))), body);
  const ex = new OpeningExplorer(body);
  void ex.init();
  return { el: root, destroy: () => ex.destroy() };
}

class OpeningExplorer {
  private cleanup: (() => void)[] = [];
  private replay: Replay | null = null;
  private practiceBoard: Board | null = null;
  private saved = new Set<number>();
  private showSaved = false;
  private query = "";
  private timer = 0;

  constructor(private root: HTMLElement) {}
  destroy(): void { this.replay?.destroy(); this.practiceBoard?.destroy(); this.cleanup.forEach((f) => f()); clearTimeout(this.timer); }

  async init(): Promise<void> {
    clear(this.root);
    const bar = h("div", { class: "progress" }, h("i", { style: "width:0%" }));
    const msg = h("p", { class: "dim" }, t("openings.preparing"));
    this.root.append(h("div", { class: "card col" }, h("div", { class: "row" }, h("div", { class: "spinner" }), msg), bar));
    const un = await api.onDownloadProgress((p) => {
      if (p.name !== "openings") return;
      const pct = p.total ? Math.min(100, (p.done / p.total) * 100) : 50;
      (bar.firstElementChild as HTMLElement).style.width = `${pct}%`;
      msg.textContent = t("openings.downloading", { kb: Math.round(p.done / 1024) });
    });
    try {
      await api.openingsEnsure();
      un(); await this.refreshSaved(); this.build();
    } catch (e) {
      un(); clear(this.root);
      this.root.append(h("div", { class: "card col" }, h("div", { class: "error-box" }, t("openings.failed", { error: errText(e) })), h("button", { class: "btn primary", type: "button", onClick: () => void this.init() }, t("common.retry"))));
    }
  }

  private async refreshSaved(): Promise<void> { this.saved = new Set((await api.openingsSaved()).map((o) => o.id)); }

  private build(): void {
    clear(this.root);
    const input = h("input", { type: "search", placeholder: t("openings.searchPlaceholder"), "aria-label": t("openings.searchPlaceholder"), onInput: (e: Event) => { this.query = (e.target as HTMLInputElement).value; clearTimeout(this.timer); this.timer = window.setTimeout(() => void this.runSearch(), 180); } });
    const savedToggle = h("button", { class: "btn small", type: "button", "aria-pressed": "false", onClick: () => { this.showSaved = !this.showSaved; savedToggle.setAttribute("aria-pressed", String(this.showSaved)); savedToggle.classList.toggle("primary", this.showSaved); void this.runSearch(); } }, t("openings.savedOnly"));
    this.list = h("div", { class: "list" }); this.detail = h("div", { class: "col" });
    this.root.append(h("div", { class: "split" }, h("div", { class: "card col" }, input, savedToggle, this.list), this.detail));
    this.detail.append(h("div", { class: "empty" }, t("openings.pick")));
    void this.runSearch();
  }
  private list!: HTMLElement; private detail!: HTMLElement;

  private async runSearch(): Promise<void> {
    try {
      let rows: Opening[] = this.showSaved ? await api.openingsSaved() : await api.openingsSearch(this.query, 80);
      if (this.showSaved && this.query.trim()) { const q = this.query.toLowerCase(); rows = rows.filter((o) => o.name.toLowerCase().includes(q) || o.eco.toLowerCase().startsWith(q)); }
      clear(this.list);
      if (!rows.length) { this.list.append(h("div", { class: "empty" }, this.showSaved ? t("openings.noSaved") : t("openings.noResults"))); return; }
      for (const o of rows) this.list.append(h("button", { class: "list-item", type: "button", onClick: (e: Event) => { for (const c of this.list.children) c.setAttribute("aria-current", "false"); (e.currentTarget as HTMLElement).setAttribute("aria-current", "true"); void this.show(o); } }, h("span", {}, o.name), h("span", { class: "badge" }, o.eco)));
    } catch (e) { clear(this.list); this.list.append(h("div", { class: "error-box" }, errText(e))); }
  }

  private async show(o: Opening): Promise<void> {
    this.replay?.destroy(); this.practiceBoard?.destroy(); this.practiceBoard = null; clear(this.detail);
    this.replay = await createReplay(o.uci.split(" "));
    if (matchMedia("(max-width: 899px)").matches) requestAnimationFrame(() => this.detail.scrollIntoView({ behavior: "smooth", block: "start" }));
    const saveBtn = h("button", { class: "btn small", type: "button" });
    const paint = () => { saveBtn.textContent = this.saved.has(o.id) ? t("openings.remove") : t("openings.save"); };
    paint();
    saveBtn.onclick = async () => { try { const on = !this.saved.has(o.id); await api.openingsSave(o.id, on); on ? this.saved.add(o.id) : this.saved.delete(o.id); paint(); if (this.showSaved) void this.runSearch(); } catch (e) { toast(errText(e), "error"); } };
    let color: "white" | "black" = "white";
    const seg = h("div", { class: "seg", role: "group" });
    const drawSeg = () => { clear(seg); for (const c of ["white", "black"] as const) seg.append(h("button", { type: "button", "aria-pressed": String(c === color), onClick: () => { color = c; drawSeg(); } }, t(`play.${c}`))); };
    drawSeg();
    const practice = h("div", { class: "col" });
    const pbtn = (mode: "guided" | "recall") => h("button", { class: "btn", type: "button", onClick: () => void this.practice(o, color === "white", mode, practice) }, t(`openings.practice.${mode}`));
    this.detail.append(
      h("div", { class: "card col" }, h("div", { class: "row spread" }, h("h2", {}, o.name), h("span", { class: "badge" }, o.eco)), h("p", { class: "dim", style: "font-variant-numeric:tabular-nums" }, o.pgn), h("div", { class: "row" }, saveBtn)),
      this.replay.el,
      h("div", { class: "card col" }, h("h3", {}, t("openings.practice.title")), h("div", { class: "row" }, h("span", { class: "dim" }, t("play.color")), seg), h("div", { class: "row" }, pbtn("guided"), pbtn("recall")), practice));
  }

  private async practice(o: Opening, userWhite: boolean, mode: "guided" | "recall", box: HTMLElement): Promise<void> {
    this.practiceBoard?.destroy(); clear(box);
    const host = h("div", { class: "board-host compact" }); const msg = h("p", { role: "status", "aria-live": "polite" }, t("openings.practice.go")); const hintBtn = h("button", { class: "btn small", type: "button" }, t("openings.practice.hint"));
    let fen = START; let done = false;
    const board = new Board(host, { legalMoves: () => api.legalMoves(fen), onMove: (uci) => void move(uci), askPromotion: async () => "q" });
    this.practiceBoard = board; this.cleanup.push(bindAppearance(board)); board.setFlipped(!userWhite);
    box.append(host, h("div", { class: "row" }, msg, hintBtn));
    const sync = async () => { board.setPosition(fen, turnOf(fen)); board.setInteractive(!done); await board.reloadLegal(); };
    const s = await api.practiceStart(o.id, userWhite, mode);
    fen = s.fen; done = s.finished;
    if (mode === "guided") board.setHint(s.hint);
    await sync(); if (done) msg.textContent = t("openings.practice.complete");
    hintBtn.onclick = async () => { board.setHint(await api.practiceHint()); };
    hintBtn.hidden = mode === "guided";
    const move = async (uci: string) => {
      board.setInteractive(false);
      try {
        const r = await api.practiceMove(uci);
        if (r.verdict === "illegal") { msg.textContent = t("openings.practice.illegal"); }
        else if (r.verdict === "deviation") { msg.textContent = t("openings.practice.deviation", { move: r.expected ?? "" }); }
        else {
          const mine = await api.play(fen, uci);
          board.setHint(null);
          await board.animateMove(uci, mine.fen, turnOf(mine.fen));
          if (r.opponent_reply) await board.animateMove(r.opponent_reply, r.fen, turnOf(r.fen));
          fen = r.fen; done = r.finished;
          msg.textContent = done ? t("openings.practice.complete") : t("openings.practice.correct");
          if (mode === "guided") board.setHint(r.hint);
        }
      } catch (e) { msg.textContent = errText(e); }
      await sync();
    };
  }
}
