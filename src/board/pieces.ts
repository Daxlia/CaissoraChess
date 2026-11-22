// Set di pezzi predefinito, originale: sagome vettoriali su una griglia 100×100.
// Ogni pezzo viene rasterizzato una sola volta per dimensione e riusato (cache di sprite).
import type { Piece } from "./fen";

const circle = (cx: number, cy: number, r: number) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
const rect = (x: number, y: number, w: number, h: number) => `M${x} ${y}h${w}v${h}h${-w}Z`;
const poly = (pts: number[][]) => `M${pts.map((p) => p.join(" ")).join("L")}Z`;

const SHAPES: Record<Piece["type"], string[]> = {
  p: [circle(50, 32, 14), poly([[39, 76], [45, 48], [55, 48], [61, 76]]), rect(30, 76, 40, 9)],
  r: [rect(28, 22, 10, 14), rect(45, 22, 10, 14), rect(62, 22, 10, 14), rect(28, 34, 44, 9), rect(34, 43, 32, 33), rect(26, 76, 48, 10)],
  n: [poly([[28, 85], [31, 62], [45, 46], [37, 38], [49, 16], [56, 25], [75, 38], [75, 52], [64, 54], [60, 46], [55, 58], [73, 85]])],
  b: [circle(50, 16, 6), `M50 24c-14 8-18 22-10 34h20c8-12 4-26-10-34Z`, poly([[40, 58], [60, 58], [66, 78], [34, 78]]), rect(28, 78, 44, 8)],
  q: [circle(24, 30, 6), circle(37, 22, 6), circle(50, 18, 6), circle(63, 22, 6), circle(76, 30, 6), poly([[26, 36], [36, 62], [42, 32], [50, 60], [58, 32], [64, 62], [74, 36], [70, 78], [30, 78]]), rect(26, 78, 48, 9)],
  k: [rect(46, 8, 8, 26), rect(38, 17, 24, 8), `M50 34c-18 0-26 10-24 24l4 20h40l4-20c2-14-6-24-24-24Z`, rect(26, 78, 48, 9)],
};

export interface PieceStyle { fillW: string; strokeW: string; fillB: string; strokeB: string }
export const PIECE_STYLES: (PieceStyle & { id: string })[] = [
  { id: "ivory", fillW: "#f7f3e8", strokeW: "#2b2622", fillB: "#2d2a2e", strokeB: "#e9e4d6" },
  { id: "gold", fillW: "#f3d98b", strokeW: "#4a3510", fillB: "#3b2a16", strokeB: "#e9c46a" },
  { id: "ice", fillW: "#e8f3ff", strokeW: "#1b3a5c", fillB: "#1f3b5a", strokeB: "#bfe0ff" },
  { id: "neon", fillW: "#9dffd8", strokeW: "#05261b", fillB: "#ff7ad9", strokeB: "#2b0820" },
];
export const DEFAULT_PIECE_STYLE: PieceStyle = PIECE_STYLES[0]!;
export const pieceStyleById = (id: string | undefined): PieceStyle => PIECE_STYLES.find((s) => s.id === id) ?? DEFAULT_PIECE_STYLE;

const cache = new Map<string, HTMLCanvasElement>();
let cacheBytes = 0;
const MAX_CACHE_BYTES = 24 * 1024 * 1024; // tetto di memoria per gli sprite

export function sprite(p: Piece, size: number, style: PieceStyle): HTMLCanvasElement {
  const key = `${p.color}${p.type}${size}${style.fillW}${style.fillB}${style.strokeW}${style.strokeB}`;
  const hit = cache.get(key);
  if (hit) return hit;
  if (cacheBytes > MAX_CACHE_BYTES) { cache.clear(); cacheBytes = 0; } // niente crescita illimitata
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  g.scale(size / 100, size / 100);
  g.lineJoin = "round";
  g.lineWidth = 3.2;
  g.fillStyle = p.color === "w" ? style.fillW : style.fillB;
  g.strokeStyle = p.color === "w" ? style.strokeW : style.strokeB;
  for (const d of SHAPES[p.type]) { const path = new Path2D(d); g.fill(path); g.stroke(path); }
  if (p.type === "n") { g.fillStyle = g.strokeStyle; g.beginPath(); g.arc(57, 33, 3, 0, Math.PI * 2); g.fill(); }
  cache.set(key, c);
  cacheBytes += size * size * 4;
  return c;
}
