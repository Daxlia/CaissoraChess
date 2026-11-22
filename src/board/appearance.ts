// Applica a una scacchiera le preferenze salvate (tema, pezzi, animazioni, qualità).
import type { Board } from "./Board";
import { themeById } from "./boardThemes";
import { pieceStyleById } from "./pieces";
import { getSetting } from "../settings";

export function applyAppearance(board: Board): void {
  board.setTheme(themeById(getSetting("board_theme", "classic")));
  board.setPieceStyle(pieceStyleById(getSetting("piece_set", "ivory")));
  board.setReduceMotion(getSetting("reduce_motion", "0") === "1" || matchMedia("(prefers-reduced-motion: reduce)").matches);
  const q = getSetting("quality", "auto");
  board.setQuality(q === "low" || q === "high" ? q : "auto");
}

/** Mantiene la scacchiera aggiornata quando cambiano le impostazioni. Restituisce la funzione di rimozione. */
export function bindAppearance(board: Board): () => void {
  applyAppearance(board);
  const on = () => applyAppearance(board);
  window.addEventListener("settings-changed", on);
  return () => window.removeEventListener("settings-changed", on);
}

export const turnOf = (fen: string): "w" | "b" => (fen.split(" ")[1] === "b" ? "b" : "w");
