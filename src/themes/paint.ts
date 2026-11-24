// Disegno "piatto" della scacchiera (vista dall'alto) a partire dal manifest: scena, cornice, caselle, texture,
// lucentezza, smussature, griglia e coordinate. Il risultato è una bitmap che la proiezione poi inclina.
import type { Gradient, Paint, BoardSpec } from "./types";
import type { LoadedTheme } from "./registry";

type Ctx = CanvasRenderingContext2D;

function gradientFor(g: Ctx, gr: Gradient, x: number, y: number, w: number, h: number): CanvasGradient {
  let grad: CanvasGradient;
  if (gr.kind === "radial") grad = g.createRadialGradient(x + w / 2, y + h / 2, 0, x + w / 2, y + h / 2, Math.hypot(w, h) / 2);
  else {
    const a = ((gr.angle ?? 180) * Math.PI) / 180; // come in CSS: 0 = verso l'alto, 90 = verso destra
    const dx = Math.sin(a), dy = -Math.cos(a), len = Math.abs(w * dx) + Math.abs(h * dy);
    const cx = x + w / 2, cy = y + h / 2;
    grad = g.createLinearGradient(cx - (dx * len) / 2, cy - (dy * len) / 2, cx + (dx * len) / 2, cy + (dy * len) / 2);
  }
  for (const s of gr.stops) grad.addColorStop(Math.min(1, Math.max(0, s.at)), s.color);
  return grad;
}

const BLEND: Record<string, GlobalCompositeOperation> = { normal: "source-over", multiply: "multiply", overlay: "overlay", "soft-light": "soft-light" };

/** Riempie un rettangolo con colore → gradiente → texture. `crop` seleziona un ritaglio diverso della texture. */
export function fillPaint(g: Ctx, th: LoadedTheme, p: Paint | undefined, x: number, y: number, w: number, h: number, crop?: number): void {
  if (!p) return;
  g.save();
  g.beginPath(); g.rect(x, y, w, h); g.clip();
  if (p.color) { g.fillStyle = p.color; g.fillRect(x, y, w, h); }
  if (p.gradient) { g.fillStyle = gradientFor(g, p.gradient, x, y, w, h); g.fillRect(x, y, w, h); }
  const img = p.texture ? th.images.get(p.texture) : undefined;
  if (img) {
    g.globalAlpha = p.textureOpacity ?? 1;
    g.globalCompositeOperation = BLEND[p.textureBlend ?? "normal"] ?? "source-over";
    g.imageSmoothingQuality = "high";
    if (crop === undefined) g.drawImage(img, x, y, w, h);
    else {
      // Ritaglio quadrato pari a 1/3 del lato: 16 posizioni distinte, scelte in modo deterministico per casella.
      const cs = Math.min(img.width, img.height) / 3;
      const hsh = Math.imul(crop + 1, 2654435761) >>> 0;
      const ox = ((hsh % 1000) / 1000) * (img.width - cs), oy = (((hsh >>> 10) % 1000) / 1000) * (img.height - cs);
      g.drawImage(img, ox, oy, cs, cs, x, y, w, h);
    }
  }
  g.restore();
}

export interface FlatInfo { total: number; frame: number } // total = lato del piano in caselle; frame = spessore cornice in caselle

export const frameWidth = (b: BoardSpec): number => b.frame?.width ?? 0;

/** Disegna il piano su un canvas quadrato di lato `F` pixel. */
export function paintFlat(g: Ctx, F: number, th: LoadedTheme, b: BoardSpec, flipped: boolean): void {
  const fw = frameWidth(b), total = 8 + 2 * fw, sq = F / total, off = fw * sq;
  g.clearRect(0, 0, F, F);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";

  if (b.frame && fw > 0) {
    fillPaint(g, th, b.frame.paint, 0, 0, F, F);
    const bev = b.frame.bevel ?? 0;
    if (bev > 0) { // smussatura: luce in alto a sinistra, ombra in basso a destra, sia fuori che dentro
      const t = Math.max(2, sq * 0.05 * (1 + bev));
      const edge = (x0: number, y0: number, x1: number, y1: number, c: string) => { g.strokeStyle = c; g.lineWidth = t; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); };
      const hi = `rgba(255,255,255,${0.35 * bev})`, lo = `rgba(0,0,0,${0.45 * bev})`;
      edge(t / 2, t / 2, F - t / 2, t / 2, hi); edge(t / 2, t / 2, t / 2, F - t / 2, hi);
      edge(F - t / 2, t / 2, F - t / 2, F - t / 2, lo); edge(t / 2, F - t / 2, F - t / 2, F - t / 2, lo);
      const i0 = off - t / 2, i1 = F - off + t / 2;
      edge(i0, i0, i1, i0, lo); edge(i0, i0, i0, i1, lo);
      edge(i1, i0, i1, i1, hi); edge(i0, i1, i1, i1, hi);
    }
  }

  // caselle
  for (let i = 0; i < 64; i++) {
    const c = i % 8, r = i >> 3;
    const light = (c + r) % 2 === 0;
    const x = off + c * sq, y = off + r * sq;
    fillPaint(g, th, light ? b.squares.light : b.squares.dark, x, y, sq, sq, b.squares.randomCrop === false ? undefined : i * 7 + (light ? 0 : 3));
  }
  const bevel = b.squares.bevel ?? 0;
  if (bevel > 0) {
    const t = Math.max(1, sq * 0.035 * (1 + bevel * 2));
    g.lineWidth = t;
    for (let i = 0; i < 64; i++) {
      const x = off + (i % 8) * sq, y = off + (i >> 3) * sq;
      g.strokeStyle = `rgba(255,255,255,${0.28 * bevel * 2})`; g.beginPath(); g.moveTo(x, y + sq - t / 2); g.lineTo(x + t / 2, y + t / 2); g.lineTo(x + sq - t / 2, y + t / 2); g.stroke();
      g.strokeStyle = `rgba(0,0,0,${0.3 * bevel * 2})`; g.beginPath(); g.moveTo(x + sq - t / 2, y); g.lineTo(x + sq - t / 2, y + sq - t / 2); g.lineTo(x, y + sq - t / 2); g.stroke();
    }
  }
  // lucentezza: riflesso diagonale su tutto il piano di gioco
  const gloss = b.squares.gloss ?? 0;
  if (gloss > 0) {
    const gr = g.createLinearGradient(off, off, off + 8 * sq, off + 8 * sq);
    gr.addColorStop(0, `rgba(255,255,255,${gloss * 0.34})`); gr.addColorStop(0.28, `rgba(255,255,255,${gloss * 0.1})`);
    gr.addColorStop(0.42, `rgba(255,255,255,${gloss * 0.2})`); gr.addColorStop(0.55, "rgba(255,255,255,0)"); gr.addColorStop(1, `rgba(0,0,0,${gloss * 0.1})`);
    g.fillStyle = gr; g.fillRect(off, off, 8 * sq, 8 * sq);
  }
  // griglia (luminosa)
  if (b.squares.grid) {
    const gd = b.squares.grid; g.save();
    g.strokeStyle = gd.color; g.lineWidth = Math.max(1, gd.width * sq); g.shadowColor = gd.color; g.shadowBlur = (gd.glow ?? 0) * sq * 0.35;
    g.beginPath();
    for (let k = 0; k <= 8; k++) { g.moveTo(off + k * sq, off); g.lineTo(off + k * sq, off + 8 * sq); g.moveTo(off, off + k * sq); g.lineTo(off + 8 * sq, off + k * sq); }
    g.stroke(); g.restore();
  }
  // coordinate
  const co = b.coordinates;
  if (co?.visible !== false) {
    const inFrame = co?.placement === "frame" && fw >= 0.14;
    g.fillStyle = co?.color ?? "rgba(255,255,255,0.75)";
    g.font = `600 ${Math.max(9, sq * (inFrame ? Math.min(0.26, fw * 0.62) : 0.17))}px system-ui, sans-serif`;
    for (let k = 0; k < 8; k++) {
      const file = flipped ? 7 - k : k, rank = flipped ? k : 7 - k;
      if (inFrame) {
        g.textAlign = "center"; g.textBaseline = "middle";
        g.fillText(String.fromCharCode(97 + file), off + (k + 0.5) * sq, F - off / 2);
        g.fillText(String(rank + 1), off / 2, off + (k + 0.5) * sq);
      } else {
        g.textAlign = "right"; g.textBaseline = "alphabetic"; g.fillText(String.fromCharCode(97 + file), off + (k + 1) * sq - sq * 0.06, off + 8 * sq - sq * 0.06);
        g.textAlign = "left"; g.textBaseline = "top"; g.fillText(String(rank + 1), off + sq * 0.06, off + k * sq + sq * 0.06);
      }
    }
  }
}

/** Scena (sfondo) a tutto canvas. */
export function paintScene(g: Ctx, S: number, th: LoadedTheme, b: BoardSpec): void {
  g.clearRect(0, 0, S, S);
  if (b.scene && (b.scene.color || b.scene.gradient || b.scene.texture)) fillPaint(g, th, b.scene, 0, 0, S, S);
}
