import { api, errText, type PuzzleOverview, type PuzzleQuery, type PuzzleStart, type PuzzleSummary } from "../api";
import { Board } from "../board/Board";
import { bindAppearance, turnOf } from "../board/appearance";
import { clear, h, toast } from "../dom";
import { t } from "../i18n";

const themeLabel = (id: string): string => { const v = t(`puzzles.theme.${id}`); return v === `puzzles.theme.${id}` ? id : v; };
const seed = (): number => crypto.getRandomValues(new Uint32Array(1))[0]!;

/** Puzzle Explorer: risolvi, sfoglia, scarica le partizioni, statistiche. */
export class PuzzleExplorer {
  private cleanup: (() => void)[] = [];
  private board: Board | null = null;
  private overview: PuzzleOverview | null = null;
  private query: PuzzleQuery = { themes: [] };
  private tab: "solve" | "browse" | "library" | "stats" = "solve";
  private body = h("div");
  private current: PuzzleStart | null = null;
  private fen = ""; private locked = true; private token = 0;

  constructor(private root: HTMLElement) {}
  destroy(): void { this.board?.destroy(); this.cleanup.forEach((f) => f()); }

  async init(): Promise<void> {
    clear(this.root);
    const tabs = h("div", { class: "tabs sub", role: "tablist" });
    for (const id of ["solve", "browse", "library", "stats"] as const)
      tabs.append(h("button", { class: "tab", role: "tab", "data-id": id, "aria-selected": String(id === this.tab), onClick: () => { this.tab = id; for (const b of tabs.children) b.setAttribute("aria-selected", String((b as HTMLElement).dataset.id === id)); void this.show(); } }, t(`puzzles.tab.${id}`)));
    this.root.append(tabs, this.body);
    await this.show();
  }

  private async refresh(): Promise<PuzzleOverview> { return (this.overview = await api.puzzlesOverview()); }

  private async show(): Promise<void> {
    this.board?.destroy(); this.board = null; this.token++;
    clear(this.body);
    try {
      const o = await this.refresh();
      if (this.tab === "library") return this.library(o);
      if (this.tab === "stats") return this.stats(o);
      if (o.total === 0) {
        this.body.append(h("div", { class: "card col" }, h("h2", {}, t("puzzles.noneTitle")), h("p", { class: "dim" }, t("puzzles.noneText")),
          h("button", { class: "btn primary", type: "button", onClick: () => { this.tab = "library"; this.root.querySelectorAll(".tabs.sub .tab").forEach((b) => b.setAttribute("aria-selected", String((b as HTMLElement).dataset.id === "library"))); void this.show(); } }, t("puzzles.openLibrary"))));
        return;
      }
      if (this.tab === "browse") return await this.browse(o);
      await this.solve(o);
    } catch (e) { this.body.append(h("div", { class: "error-box" }, errText(e))); }
  }

  // ------------------------------------------------------------ filtri
  private filters(o: PuzzleOverview, onChange: () => void): HTMLElement {
    const q = this.query;
    const num = (key: "rating_min" | "rating_max", ph: string) => h("input", { type: "number", min: 0, max: 4000, step: 50, placeholder: ph, "aria-label": ph, value: q[key] ?? "", onChange: (e: Event) => { const v = (e.target as HTMLInputElement).value; q[key] = v === "" ? null : Math.max(0, Math.min(4000, Number(v))); onChange(); } });
    const chips = h("div", { class: "badges" });
    const drawChips = () => { clear(chips); for (const th of q.themes ?? []) chips.append(h("button", { class: "badge accent", type: "button", title: t("puzzles.removeFilter"), onClick: () => { q.themes = (q.themes ?? []).filter((x) => x !== th); drawChips(); onChange(); } }, `${themeLabel(th)} ✕`)); };
    drawChips();
    const sel = h("select", { "aria-label": t("puzzles.addTheme"), onChange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; if (v && !(q.themes ?? []).includes(v)) { q.themes = [...(q.themes ?? []), v]; drawChips(); onChange(); } (e.target as HTMLSelectElement).value = ""; } },
      h("option", { value: "" }, t("puzzles.addTheme")), ...o.themes.map(([id, n]) => h("option", { value: id }, `${themeLabel(id)} (${n})`)));
    const tag = h("input", { type: "text", placeholder: t("puzzles.openingTag"), "aria-label": t("puzzles.openingTag"), value: q.opening_tag ?? "", onChange: (e: Event) => { const v = (e.target as HTMLInputElement).value.trim().replace(/\s+/g, "_"); q.opening_tag = v || null; onChange(); } });
    const chk = (label: string, key: "saved_only" | "unsolved_only") => h("label", { class: "row" }, h("input", { type: "checkbox", checked: !!q[key], onChange: (e: Event) => { q[key] = (e.target as HTMLInputElement).checked; onChange(); } }), h("span", {}, label));
    return h("div", { class: "card col" }, h("div", { class: "row" }, num("rating_min", t("puzzles.ratingMin")), num("rating_max", t("puzzles.ratingMax"))), sel, chips, tag,
      h("div", { class: "row" }, chk(t("puzzles.savedOnly"), "saved_only"), chk(t("puzzles.unsolvedOnly"), "unsolved_only")));
  }

  // ------------------------------------------------------------ risolvi
  private async solve(o: PuzzleOverview, id: string | null = null): Promise<void> {
    const status = h("p", { role: "status", "aria-live": "polite", class: "puzzle-status" }, t("puzzles.pick"));
    const info = h("div", { class: "badges" });
    const host = h("div", { class: "board-host" });
    const hintBtn = h("button", { class: "btn", type: "button" }, t("puzzles.hint"));
    const giveBtn = h("button", { class: "btn", type: "button" }, t("puzzles.giveUp"));
    const saveBtn = h("button", { class: "btn", type: "button" });
    const nextBtn = h("button", { class: "btn primary", type: "button" }, t("puzzles.next"));
    const count = h("p", { class: "dim small" });
    const refreshCount = async () => { try { const r = await api.puzzlesFind(this.query, 1, 0); count.textContent = t("puzzles.matches", { n: r.total }); } catch (e) { count.textContent = errText(e); } };
    const filters = this.filters(o, () => void refreshCount());
    const board = new Board(host, { legalMoves: () => api.legalMoves(this.fen), onMove: (uci) => void move(uci), askPromotion: async () => "q" });
    this.board = board; this.cleanup.push(bindAppearance(board)); board.setInteractive(false);

    const paintSave = () => { saveBtn.textContent = this.current?.saved ? t("puzzles.unsave") : t("puzzles.save"); saveBtn.disabled = !this.current; };
    const setButtons = (active: boolean) => { hintBtn.disabled = !active; giveBtn.disabled = !active; };
    setButtons(false); paintSave();

    const load = async (pid: string | null) => {
      const my = ++this.token; this.locked = true; board.setInteractive(false); board.setHint(null); board.setLastMove(null);
      let p: PuzzleStart | null;
      try { p = await api.puzzlesStart(pid, pid ? null : this.query, seed()); } catch (e) { status.textContent = errText(e); return; }
      if (my !== this.token) return;
      if (!p) { status.textContent = t("puzzles.noMatch"); this.current = null; setButtons(false); paintSave(); return; }
      this.current = p; this.fen = p.fen_before; clear(info);
      info.append(h("span", { class: "badge accent" }, t("puzzles.rating", { n: p.rating })), ...p.themes.slice(0, 4).map((x) => h("span", { class: "badge ghost" }, themeLabel(x))));
      board.setFlipped(!p.user_is_white); board.setPosition(p.fen_before, turnOf(p.fen_before)); board.setLastMove(null); board.setCheck(null);
      status.textContent = t("puzzles.opponentMoves"); setButtons(false); paintSave();
      await new Promise((r) => setTimeout(r, 450));
      if (my !== this.token) return;
      const after = await api.play(p.fen_before, p.opponent_move);
      await board.animateMove(p.opponent_move, after.fen, turnOf(after.fen));
      if (my !== this.token) return;
      this.fen = p.fen; board.setPosition(p.fen, turnOf(p.fen)); board.setLastMove(p.opponent_move);
      status.textContent = t(p.user_is_white ? "puzzles.yourMoveWhite" : "puzzles.yourMoveBlack");
      this.locked = false; board.setInteractive(true); setButtons(true); await board.reloadLegal();
    };

    const move = async (uci: string) => {
      if (this.locked || !this.current) return;
      this.locked = true; board.setInteractive(false); board.setHint(null);
      const my = this.token;
      try {
        const mine = await api.play(this.fen, uci);
        const r = await api.puzzlesMove(uci);
        if (my !== this.token) return;
        if (r.status === "correct") {
          await board.animateMove(uci, mine.fen, turnOf(mine.fen)); board.setLastMove(uci);
          if (r.reply) { await board.animateMove(r.reply, r.fen, turnOf(r.fen)); board.setLastMove(r.reply); }
          this.fen = r.fen; board.setPosition(r.fen, turnOf(r.fen)); board.setCheck(null);
          if (r.solved) { status.textContent = t("puzzles.solved"); setButtons(false); return; }
          status.textContent = t("puzzles.correct");
        } else { status.textContent = t(r.status === "wrong" ? "puzzles.wrong" : "puzzles.illegal"); board.setPosition(this.fen, turnOf(this.fen)); }
      } catch (e) { status.textContent = errText(e); }
      this.locked = false; board.setInteractive(true); await board.reloadLegal();
    };

    hintBtn.onclick = async () => { try { const m = await api.puzzlesHint(); if (m) board.setHint([m.slice(0, 2), m.slice(2, 4)]); } catch (e) { toast(errText(e), "error"); } };
    giveBtn.onclick = async () => {
      if (this.locked || !this.current) return;
      this.locked = true; board.setInteractive(false); const my = this.token;
      try {
        let fen = this.fen;
        const rest = await api.puzzlesGiveUp();
        status.textContent = t("puzzles.gaveUp");
        for (const m of rest) { const a = await api.play(fen, m); await board.animateMove(m, a.fen, turnOf(a.fen)); if (my !== this.token) return; fen = a.fen; await new Promise((r) => setTimeout(r, 250)); }
        this.fen = fen; setButtons(false);
      } catch (e) { toast(errText(e), "error"); }
    };
    saveBtn.onclick = async () => { if (!this.current) return; try { const on = !this.current.saved; await api.puzzlesSave(this.current.id, on); this.current.saved = on; paintSave(); } catch (e) { toast(errText(e), "error"); } };
    nextBtn.onclick = () => void load(null);

    this.body.append(h("div", { class: "split puzzle-split" },
      h("div", { class: "col" }, filters, count),
      h("div", { class: "col" }, info, host, status, h("div", { class: "row" }, nextBtn, hintBtn, giveBtn, saveBtn))));
    void refreshCount();
    await load(id);
  }

  // ------------------------------------------------------------ sfoglia
  private async browse(o: PuzzleOverview): Promise<void> {
    const list = h("div", { class: "list" }); const more = h("button", { class: "btn", type: "button" }, t("puzzles.loadMore")); const head = h("p", { class: "dim small" });
    let offset = 0; let total = 0;
    const page = async (reset: boolean) => {
      try {
        if (reset) { offset = 0; clear(list); }
        const r = await api.puzzlesFind(this.query, 50, offset); total = r.total; offset += r.items.length;
        head.textContent = t("puzzles.matches", { n: total });
        if (!r.items.length && reset) list.append(h("div", { class: "empty" }, t("puzzles.noMatch")));
        for (const p of r.items) list.append(this.row(p));
        more.hidden = offset >= total;
      } catch (e) { list.append(h("div", { class: "error-box" }, errText(e))); }
    };
    more.onclick = () => void page(false);
    this.body.append(h("div", { class: "split puzzle-split" }, h("div", { class: "col" }, this.filters(o, () => void page(true))), h("div", { class: "card col" }, head, list, more)));
    await page(true);
  }

  private row(p: PuzzleSummary): HTMLElement {
    return h("button", { class: "list-item", type: "button", onClick: () => { this.tab = "solve"; this.root.querySelectorAll(".tabs.sub .tab").forEach((b) => b.setAttribute("aria-selected", String((b as HTMLElement).dataset.id === "solve"))); this.board?.destroy(); this.board = null; clear(this.body); void this.solve(this.overview!, p.id); } },
      h("span", { class: "col tight" }, h("strong", {}, `#${p.id}`), h("span", { class: "dim small" }, p.themes.slice(0, 4).map(themeLabel).join(" · "))),
      h("span", { class: "badges" }, p.saved ? h("span", { class: "badge ghost" }, "★") : null, p.solved ? h("span", { class: "badge ghost" }, "✓") : null, h("span", { class: "badge" }, String(p.rating))));
  }

  // ------------------------------------------------------------ libreria
  private library(o: PuzzleOverview): void {
    const grid = h("div", { class: "partition-grid" });
    const intro = h("p", { class: "dim" });
    const busy = new Set<number>();
    const draw = (ov: PuzzleOverview) => {
      clear(grid); intro.textContent = t("puzzles.libraryText", { total: ov.total.toLocaleString() });
      for (const p of ov.partitions) {
        const bar = h("div", { class: "progress", hidden: !busy.has(p.n) }, h("i", { style: "width:0%" }));
        const btn = h("button", { class: p.installed ? "btn small" : "btn small primary", type: "button", disabled: busy.has(p.n) }, p.installed ? t("puzzles.remove") : t("puzzles.download"));
        btn.onclick = async () => {
          busy.add(p.n); draw(ov);
          try {
            if (p.installed) await api.puzzlesRemove(p.n);
            else {
              const un = await api.onDownloadProgress((d) => { if (d.name !== `puzzle-${p.n}`) return; const el = grid.querySelector<HTMLElement>(`[data-n="${p.n}"] .progress i`); if (el) el.style.width = `${d.total ? Math.min(100, (d.done / d.total) * 100) : 50}%`; });
              try { const rows = await api.puzzlesDownload(p.n); toast(t("puzzles.imported", { n: p.n, rows }), "info"); } finally { un(); }
            }
          } catch (e) { toast(errText(e), "error"); }
          busy.delete(p.n); draw(await this.refresh());
        };
        const rows = p.rows ?? p.index_rows;
        grid.append(h("div", { class: `card partition ${p.installed ? "on" : ""}`, "data-n": String(p.n) }, h("strong", {}, t("puzzles.partition", { n: p.n })),
          h("span", { class: "dim small" }, p.installed ? t("puzzles.installedRows", { rows: (p.rows ?? 0).toLocaleString() }) : rows ? t("puzzles.rows", { rows: rows.toLocaleString() }) : t("puzzles.notInstalled")), bar, btn));
      }
    };
    const idxBtn = h("button", { class: "btn small", type: "button", disabled: o.index_loaded, onClick: async () => { try { await api.puzzlesFetchIndex(); draw(await this.refresh()); idxBtn.disabled = true; } catch (e) { toast(t("puzzles.indexUnavailable", { error: errText(e) }), "error"); } } }, o.index_loaded ? t("puzzles.indexLoaded") : t("puzzles.loadIndex"));
    this.body.append(h("div", { class: "card col" }, h("h2", {}, t("puzzles.libraryTitle")), intro, h("div", { class: "row" }, idxBtn)), grid);
    draw(o);
  }

  // ------------------------------------------------------------ statistiche
  private stats(o: PuzzleOverview): void {
    const s = o.stats; const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "–");
    const tile = (label: string, value: string) => h("div", { class: "card stat-tile" }, h("strong", {}, value), h("span", { class: "dim small" }, label));
    this.body.append(h("div", { class: "stat-grid" },
      tile(t("puzzles.stat.attempts"), String(s.attempts)), tile(t("puzzles.stat.solved"), pct(s.solved, s.attempts)), tile(t("puzzles.stat.clean"), pct(s.clean, s.attempts)),
      tile(t("puzzles.stat.streak"), String(s.streak)), tile(t("puzzles.stat.avgTime"), s.attempts ? `${Math.round(s.avg_ms / 1000)} s` : "–"),
      tile(t("puzzles.stat.recentRating"), s.recent_solved_rating ? String(s.recent_solved_rating) : "–"), tile(t("puzzles.stat.saved"), String(s.saved))));
    const rows = s.by_theme.slice(0, 20).map((x) => h("div", { class: "row spread" }, h("span", {}, themeLabel(x.theme)), h("span", { class: "dim", style: "font-variant-numeric:tabular-nums" }, `${x.solved}/${x.attempts} · ${pct(x.solved, x.attempts)}`)));
    this.body.append(h("div", { class: "card col" }, h("h2", {}, t("puzzles.stat.byTheme")), rows.length ? h("div", { class: "col" }, ...rows) : h("p", { class: "dim" }, t("puzzles.stat.empty"))));
  }
}
