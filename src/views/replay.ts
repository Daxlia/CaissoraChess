// Riproduzione mossa per mossa di una linea UCI (partite salvate, aperture). Le posizioni
// vengono calcolate dal backend (regole), non dal frontend.
import { api, errText } from "../api";
import { Board } from "../board/Board";
import { bindAppearance, turnOf } from "../board/appearance";
import { h } from "../dom";
import { ICONS } from "../icons";
import { t } from "../i18n";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

export interface Replay { el: HTMLElement; destroy: () => void; sans: string[] }

export async function createReplay(moves: string[], flipped = false): Promise<Replay> {
  const host = h("div", { class: "board-host compact" });
  const status = h("p", { class: "dim small", "aria-live": "polite" });
  const board = new Board(host, { legalMoves: async () => [] });
  board.setInteractive(false);
  board.setFlipped(flipped);
  const unbind = bindAppearance(board);

  const fens = [START];
  const sans: string[] = [];
  const checks: (string | null)[] = [null];
  try {
    for (const m of moves) {
      const r = await api.play(fens[fens.length - 1]!, m);
      fens.push(r.fen); sans.push(r.san); checks.push(r.check_square);
    }
  } catch (e) {
    status.textContent = errText(e);
  }
  let i = 0;
  const show = (n: number, animate: boolean) => {
    const prev = i;
    i = Math.max(0, Math.min(fens.length - 1, n));
    const fen = fens[i]!;
    const apply = () => { board.setLastMove(i > 0 ? moves[i - 1]! : null); board.setCheck(checks[i] ?? null); };
    if (animate && i === prev + 1) void board.animateMove(moves[i - 1]!, fen, turnOf(fen)).then(apply);
    else { board.setPosition(fen, turnOf(fen)); apply(); }
    label.textContent = i === 0 ? t("replay.start") : `${Math.ceil(i / 2)}${i % 2 ? "." : "…"} ${sans[i - 1] ?? ""}`;
    for (const [b, dis] of [[first, i === 0], [prevB, i === 0], [nextB, i === fens.length - 1], [lastB, i === fens.length - 1]] as const) b.disabled = dis;
  };
  const btn = (icon: string, labelKey: string, fn: () => void) => { const b = h("button", { class: "btn icon", type: "button", "aria-label": t(labelKey), title: t(labelKey), onClick: fn }); b.innerHTML = icon; return b; };
  const label = h("span", { class: "dim", style: "min-width:110px;text-align:center" });
  const first = btn(ICONS.first, "replay.first", () => show(0, false));
  const prevB = btn(ICONS.prev, "replay.prev", () => show(i - 1, false));
  const nextB = btn(ICONS.next, "replay.next", () => show(i + 1, true));
  const lastB = btn(ICONS.last, "replay.last", () => show(fens.length - 1, false));
  const flip = btn(ICONS.flip, "board.flip", () => board.setFlipped(!board.isFlipped));
  const keys = (e: KeyboardEvent) => { if (e.key === "ArrowLeft") show(i - 1, false); else if (e.key === "ArrowRight") show(i + 1, true); };
  const el = h("div", { class: "col", tabindex: 0, onKeydown: keys }, host, h("div", { class: "row", style: "justify-content:center" }, first, prevB, label, nextB, lastB, flip), status);
  show(0, false);
  return { el, sans, destroy: () => { unbind(); board.destroy(); } };
}
