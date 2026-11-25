// Applica a una scacchiera le preferenze salvate (tema scacchiera, tema pezzi, animazioni, qualità).
import type { Board } from "./Board";
import { activeIds, loadTheme } from "../themes/registry";
import { getSetting } from "../settings";

const tokens = new WeakMap<Board, number>();

/** Carica (se serve) e applica due temi, in modo indipendente. Un'applicazione più recente annulla quella in corso. */
export async function applyThemes(board: Board, boardId: string, piecesId: string): Promise<void> {
  const my = (tokens.get(board) ?? 0) + 1; tokens.set(board, my);
  const [b, p] = await Promise.all([loadTheme(boardId), loadTheme(piecesId)]);
  if (tokens.get(board) !== my) return;
  board.setBoardTheme(b); board.setPieceTheme(p);
}

export function applyAppearance(board: Board): void {
  board.setReduceMotion(getSetting("reduce_motion", "0") === "1" || matchMedia("(prefers-reduced-motion: reduce)").matches);
  const q = getSetting("quality", "auto");
  board.setQuality(q === "low" || q === "high" ? q : "auto");
  const ids = activeIds();
  void applyThemes(board, ids.board, ids.pieces).catch(() => applyThemes(board, "classic", "classic"));
}

/** Mantiene la scacchiera aggiornata quando cambiano le impostazioni o l'elenco dei temi. Restituisce la funzione di rimozione. */
export function bindAppearance(board: Board): () => void {
  applyAppearance(board);
  const on = () => applyAppearance(board);
  window.addEventListener("settings-changed", on);
  window.addEventListener("themes-changed", on);
  return () => { window.removeEventListener("settings-changed", on); window.removeEventListener("themes-changed", on); };
}

export const turnOf = (fen: string): "w" | "b" => (fen.split(" ")[1] === "b" ? "b" : "w");
