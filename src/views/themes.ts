import { Board } from "../board/Board";
import { bindAppearance } from "../board/appearance";
import { BOARD_THEMES } from "../board/boardThemes";
import { PIECE_STYLES } from "../board/pieces";
import { clear, h, toast } from "../dom";
import { errText } from "../api";
import { t } from "../i18n";
import { getSetting, setSetting } from "../settings";
import type { View } from "./types";

const PREVIEW = "r1bq1rk1/pp2bppp/2n1pn2/2pp4/3P4/2PBPN2/PP1N1PPP/R1BQ1RK1 w - - 0 9";

export async function themesView(): Promise<View> {
  const root = h("div", { class: "view" });
  const boards: Board[] = []; const unbind: (() => void)[] = [];
  const section = (titleKey: string, descKey: string, items: { id: string; label: string; apply: (b: Board) => void }[], setting: string, fallback: string) => {
    const grid = h("div", { class: "grid-cards" });
    const draw = () => {
      clear(grid);
      const cur = getSetting(setting, fallback);
      for (const it of items) {
        const host = h("div", { class: "board-host small" });
        const b = new Board(host, { legalMoves: async () => [] });
        b.setInteractive(false); b.setPosition(PREVIEW, "w");
        unbind.push(bindAppearance(b)); it.apply(b); boards.push(b);
        grid.append(h("button", { class: "choice", type: "button", "aria-pressed": String(cur === it.id), onClick: async () => { try { await setSetting(setting, it.id); draw(); } catch (e) { toast(errText(e), "error"); } } }, host, h("strong", {}, it.label)));
      }
    };
    draw();
    window.addEventListener("settings-changed", (e) => { const k = (e as CustomEvent).detail?.key; if (k === "board_theme" || k === "piece_set") { for (const b of boards.splice(0)) b.destroy(); draw(); } }, { once: false });
    return h("section", { class: "card col" }, h("h2", {}, t(titleKey)), h("p", { class: "dim" }, t(descKey)), grid);
  };
  root.append(h("div", { class: "page-head" }, h("h1", {}, t("nav.themes")), h("p", { class: "dim" }, t("themes.subtitle"))),
    h("div", { class: "col" },
      section("themes.boardTitle", "themes.boardDesc", BOARD_THEMES.map((th) => ({ id: th.id, label: t(`themes.board.${th.id}`), apply: (b: Board) => b.setTheme(th) })), "board_theme", "classic"),
      section("themes.piecesTitle", "themes.piecesDesc", PIECE_STYLES.map((ps) => ({ id: ps.id, label: t(`themes.pieces.${ps.id}`), apply: (b: Board) => b.setPieceStyle(ps) })), "piece_set", "ivory"),
      h("p", { class: "dim small" }, t("themes.external"))));
  return { el: root, destroy: () => { unbind.forEach((f) => f()); boards.forEach((b) => b.destroy()); } };
}
