// Solo lettura della disposizione dei pezzi dal FEN, per DISEGNARE. Le regole stanno nel backend.
export type Piece = { color: "w" | "b"; type: "p" | "n" | "b" | "r" | "q" | "k" };
export type Squares = (Piece | null)[]; // indice 0 = a8 ... 63 = h1 (riga per riga dall'alto)

export function parsePlacement(fen: string): Squares {
  const field = fen.split(" ")[0] ?? "";
  const rows = field.split("/");
  if (rows.length !== 8) throw new Error(`invalid FEN: ${fen}`);
  const out: Squares = [];
  for (const row of rows) {
    let n = 0;
    for (const ch of row) {
      if (/[1-8]/.test(ch)) { for (let i = 0; i < Number(ch); i++) out.push(null); n += Number(ch); }
      else if (/[pnbrqkPNBRQK]/.test(ch)) { out.push({ color: ch === ch.toUpperCase() ? "w" : "b", type: ch.toLowerCase() as Piece["type"] }); n++; }
      else throw new Error(`invalid FEN: ${fen}`);
    }
    if (n !== 8) throw new Error(`invalid FEN: ${fen}`);
  }
  return out;
}

/** "e4" → indice 0..63 (a8 = 0). */
export const sqIndex = (sq: string): number => (8 - Number(sq[1])) * 8 + (sq.charCodeAt(0) - 97);
export const sqName = (i: number): string => String.fromCharCode(97 + (i % 8)) + String(8 - Math.floor(i / 8));
export const splitUci = (uci: string): { from: string; to: string; promo: string | null } => ({ from: uci.slice(0, 2), to: uci.slice(2, 4), promo: uci.length > 4 ? (uci[4] ?? null) : null });
