// Sprite dei pezzi di un tema, già ridimensionati: scelgono la risoluzione migliore (1x/2x/4x…) e riducono a gradini
// per non perdere qualità. Una cache limitata evita crescita di memoria.
import type { Piece } from "../board/fen";
import type { LoadedTheme } from "./registry";
import type { PieceSpec } from "./types";

export const pieceId = (p: Piece): string => `${p.color}${p.type.toUpperCase()}`;

export interface Sprite { canvas: HTMLCanvasElement; frameW: number; frameH: number; frames: number }

export class PieceSet {
  readonly spec: PieceSpec;
  readonly frames: number;
  private cache = new Map<string, Sprite>();
  constructor(readonly theme: LoadedTheme) {
    this.spec = theme.manifest.pieces!;
    this.frames = this.spec.frames?.count ?? 1;
  }

  private source(id: string, wPx: number): HTMLImageElement {
    const spec = this.spec;
    const res = [...(spec.resolutions ?? ["1x"])].sort((a, b) => parseInt(a) - parseInt(b));
    const base = spec.baseSize ?? 256;
    let pick = res[res.length - 1]!;
    for (const r of res) if ((base * parseInt(r)) >= wPx) { pick = r; break; }
    const path = spec.source!.replace("{piece}", id).replace("{res}", pick);
    return this.theme.images.get(path)!;
  }

  sprite(id: string, wPx: number): Sprite {
    const w = Math.max(16, Math.ceil(wPx / 8) * 8);
    const key = `${id}@${w}`;
    const hit = this.cache.get(key); if (hit) return hit;
    if (this.cache.size > 160) this.cache.clear();
    const img = this.source(id, w);
    const fr = this.frames;
    const srcFw = img.naturalWidth / fr, srcFh = img.naturalHeight;
    const h = Math.round((w * srcFh) / srcFw);
    // riduzione a gradini (al massimo dimezzando): evita l'aliasing delle riduzioni forti
    let cur: CanvasImageSource = img, cw = img.naturalWidth, ch = img.naturalHeight;
    const tw = w * fr;
    while (cw / 2 > tw) {
      const c = document.createElement("canvas"); c.width = Math.ceil(cw / 2); c.height = Math.ceil(ch / 2);
      const g = c.getContext("2d")!; g.imageSmoothingQuality = "high"; g.drawImage(cur, 0, 0, c.width, c.height);
      cur = c; cw = c.width; ch = c.height;
    }
    const out = document.createElement("canvas"); out.width = tw; out.height = h;
    const g = out.getContext("2d")!; g.imageSmoothingQuality = "high"; g.drawImage(cur, 0, 0, tw, h);
    const s: Sprite = { canvas: out, frameW: w, frameH: h, frames: fr };
    this.cache.set(key, s);
    return s;
  }
}
