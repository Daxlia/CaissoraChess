// Scacchiera su Canvas 2D. Principi:
//  * sempre quadrata, si adatta al contenitore (ResizeObserver) e alla densità di pixel;
//  * ridisegno SOLO su richiesta (requestAnimationFrame durante le animazioni, altrimenti nulla);
//  * sprite dei pezzi in cache; nessun allocazione per frame oltre al calcolo delle posizioni;
//  * nessuna regola scacchistica: le mosse legali arrivano dal backend.
import { parsePlacement, sqIndex, sqName, splitUci, type Squares } from "./fen";
import { DEFAULT_PIECE_STYLE, sprite, type PieceStyle } from "./pieces";
import { themeById, type BoardTheme } from "./boardThemes";

export interface BoardOptions {
  onMove?: (uci: string) => void; // chiamata con la mossa scelta dall'utente (promozione già risolta)
  /** Restituisce le mosse legali UCI dalla posizione attuale. */
  legalMoves: () => Promise<string[]>;
  askPromotion?: (color: "w" | "b") => Promise<"q" | "r" | "b" | "n" | null>;
}

interface Anim { from: number; to: number; piece: NonNullable<Squares[number]>; captured: NonNullable<Squares[number]> | null; start: number; dur: number }

export class Board {
  readonly canvas = document.createElement("canvas");
  private g = this.canvas.getContext("2d")!;
  private squares: Squares = new Array(64).fill(null);
  private flipped = false;
  private theme: BoardTheme = themeById("classic");
  private pieceStyle: PieceStyle = DEFAULT_PIECE_STYLE;
  private size = 0; // lato in px CSS
  private dpr = 1;
  private selected: number | null = null;
  private legal: string[] = [];
  private lastMove: [number, number] | null = null;
  private checkSq: number | null = null;
  private hint: [number, number] | null = null;
  private anim: Anim | null = null;
  private drag: { from: number; x: number; y: number } | null = null;
  private raf = 0;
  private dirty = true;
  private interactive = true;
  private turn: "w" | "b" = "w";
  private ro: ResizeObserver;
  private reduceMotion = false;
  private dprCap = 2;
  private busy = false;

  constructor(private host: HTMLElement, private opts: BoardOptions) {
    this.canvas.className = "board-canvas";
    this.canvas.setAttribute("role", "img");
    host.appendChild(this.canvas);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.canvas.addEventListener("pointerdown", (e) => void this.onDown(e));
    this.canvas.addEventListener("pointermove", (e) => this.onMove(e));
    this.canvas.addEventListener("pointerup", (e) => void this.onUp(e));
    this.canvas.addEventListener("pointercancel", () => { this.drag = null; this.invalidate(); });
    document.addEventListener("visibilitychange", this.onVisibility);
    this.resize();
  }

  destroy(): void {
    this.ro.disconnect();
    cancelAnimationFrame(this.raf);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.canvas.remove();
  }

  // ---------------------------------------------------------------- stato

  setPosition(fen: string, turn: "w" | "b"): void {
    this.squares = parsePlacement(fen);
    this.turn = turn;
    this.selected = null; this.legal = []; this.anim = null; this.drag = null;
    this.canvas.setAttribute("aria-label", `Chessboard, ${turn === "w" ? "white" : "black"} to move`);
    this.invalidate();
  }
  setTheme(t: BoardTheme): void { this.theme = t; this.invalidate(); }
  setPieceStyle(s: PieceStyle): void { this.pieceStyle = s; this.invalidate(); }
  setFlipped(f: boolean): void { this.flipped = f; this.invalidate(); }
  setInteractive(v: boolean): void { this.interactive = v; if (!v) { this.selected = null; this.legal = []; } this.invalidate(); }
  setLastMove(uci: string | null): void { if (!uci) { this.lastMove = null; } else { const m = splitUci(uci); this.lastMove = [sqIndex(m.from), sqIndex(m.to)]; } this.invalidate(); }
  setCheck(kingSq: string | null): void { this.checkSq = kingSq ? sqIndex(kingSq) : null; this.invalidate(); }
  setHint(h: [string, string] | null): void { this.hint = h ? [sqIndex(h[0]), sqIndex(h[1])] : null; this.invalidate(); }
  setReduceMotion(v: boolean): void { this.reduceMotion = v; }
  /** Qualità grafica: limita la densità di pixel del canvas (memoria e GPU). */
  setQuality(q: "low" | "auto" | "high"): void { this.dprCap = q === "low" ? 1 : q === "high" ? 3 : 2; this.resize(); }
  get isFlipped(): boolean { return this.flipped; }

  /** Anima una mossa (già valida) e poi imposta la nuova posizione. */
  animateMove(uci: string, newFen: string, newTurn: "w" | "b"): Promise<void> {
    const { from, to } = splitUci(uci);
    const f = sqIndex(from), t = sqIndex(to);
    const piece = this.squares[f];
    if (!piece || this.reduceMotion) { this.setPosition(newFen, newTurn); return Promise.resolve(); }
    return new Promise((resolve) => {
      this.anim = { from: f, to: t, piece, captured: this.squares[t] ?? null, start: performance.now(), dur: 180 };
      this.squares = this.squares.slice(); this.squares[f] = null;
      this.selected = null; this.legal = [];
      const done = () => { this.setPosition(newFen, newTurn); resolve(); };
      const step = () => { if (!this.anim) return done(); if (performance.now() - this.anim.start >= this.anim.dur) return done(); this.invalidate(); requestAnimationFrame(step); };
      requestAnimationFrame(step);
    });
  }

  // ---------------------------------------------------------------- disegno

  private resize(): void {
    const w = Math.floor(Math.min(this.host.clientWidth, this.host.clientHeight || this.host.clientWidth));
    const size = Math.max(0, w);
    const dpr = Math.min(window.devicePixelRatio || 1, this.dprCap);
    if (size === this.size && dpr === this.dpr) return;
    this.size = size; this.dpr = dpr;
    this.canvas.style.width = this.canvas.style.height = `${size}px`;
    this.canvas.width = this.canvas.height = Math.round(size * dpr);
    this.invalidate();
  }

  private onVisibility = (): void => { if (!document.hidden) this.invalidate(); };

  private invalidate(): void {
    this.dirty = true;
    if (this.raf || document.hidden) return; // in background non si disegna
    this.raf = requestAnimationFrame(() => { this.raf = 0; if (this.dirty) { this.dirty = false; this.draw(); } });
  }

  private cell(i: number): { x: number; y: number } {
    const c = i % 8, r = Math.floor(i / 8);
    const s = this.size / 8;
    return this.flipped ? { x: (7 - c) * s, y: (7 - r) * s } : { x: c * s, y: r * s };
  }

  private draw(): void {
    const { g, size, dpr, theme } = this;
    if (!size) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const s = size / 8;
    for (let i = 0; i < 64; i++) {
      const { x, y } = this.cell(i);
      g.fillStyle = ((i % 8) + Math.floor(i / 8)) % 2 === 0 ? theme.light : theme.dark;
      g.fillRect(x, y, s, s);
    }
    const mark = (i: number, color: string) => { const { x, y } = this.cell(i); g.fillStyle = color; g.fillRect(x, y, s, s); };
    if (this.lastMove) { mark(this.lastMove[0], theme.lastMove); mark(this.lastMove[1], theme.lastMove); }
    if (this.checkSq !== null) mark(this.checkSq, theme.check);
    if (this.selected !== null) mark(this.selected, theme.selected);

    // coordinate
    g.font = `600 ${Math.max(9, s * 0.17)}px system-ui, sans-serif`;
    g.fillStyle = theme.coord;
    for (let k = 0; k < 8; k++) {
      const file = this.flipped ? 7 - k : k;
      const rank = this.flipped ? k : 7 - k;
      g.textAlign = "right"; g.textBaseline = "alphabetic";
      g.fillText(String.fromCharCode(97 + file), (k + 1) * s - s * 0.06, size - s * 0.06);
      g.textAlign = "left"; g.textBaseline = "top";
      g.fillText(String(rank + 1), s * 0.06, k * s + s * 0.06);
    }

    // mosse legali
    if (this.selected !== null) {
      const from = sqName(this.selected);
      g.fillStyle = theme.legal;
      for (const m of this.legal) {
        if (!m.startsWith(from)) continue;
        const to = sqIndex(m.slice(2, 4));
        const { x, y } = this.cell(to);
        g.beginPath();
        if (this.squares[to]) { g.lineWidth = s * 0.09; g.strokeStyle = theme.legal; g.arc(x + s / 2, y + s / 2, s * 0.44, 0, Math.PI * 2); g.stroke(); }
        else { g.arc(x + s / 2, y + s / 2, s * 0.16, 0, Math.PI * 2); g.fill(); }
      }
    }

    const px = Math.max(8, Math.round(s * dpr));
    const place = (p: NonNullable<Squares[number]>, x: number, y: number, alpha = 1) => {
      g.globalAlpha = alpha;
      g.drawImage(sprite(p, px, this.pieceStyle), x, y, s, s);
      g.globalAlpha = 1;
    };
    const skip = this.drag ? this.drag.from : -1;
    for (let i = 0; i < 64; i++) {
      const p = this.squares[i];
      if (!p || i === skip) continue;
      const { x, y } = this.cell(i);
      place(p, x, y);
    }
    if (this.anim) {
      const a = this.anim;
      const k = Math.min(1, (performance.now() - a.start) / a.dur);
      const e = 1 - (1 - k) ** 3;
      const A = this.cell(a.from), B = this.cell(a.to);
      if (a.captured) place(a.captured, B.x, B.y, 1 - e);
      place(a.piece, A.x + (B.x - A.x) * e, A.y + (B.y - A.y) * e);
    }
    if (this.drag) {
      const p = this.squares[this.drag.from];
      if (p) place(p, this.drag.x - s / 2, this.drag.y - s / 2);
    }
    if (this.hint) this.drawArrow(this.hint[0], this.hint[1]);
  }

  private drawArrow(from: number, to: number): void {
    const { g } = this; const s = this.size / 8;
    const A = this.cell(from), B = this.cell(to);
    const [x1, y1, x2, y2] = [A.x + s / 2, A.y + s / 2, B.x + s / 2, B.y + s / 2];
    const ang = Math.atan2(y2 - y1, x2 - x1), head = s * 0.3, w = s * 0.11;
    const ex = x2 - Math.cos(ang) * head * 0.6, ey = y2 - Math.sin(ang) * head * 0.6;
    g.save();
    g.globalAlpha = 0.85; g.strokeStyle = g.fillStyle = "#2fbf71"; g.lineWidth = w; g.lineCap = "round";
    g.beginPath(); g.moveTo(x1, y1); g.lineTo(ex, ey); g.stroke();
    g.beginPath(); g.moveTo(x2, y2); g.lineTo(x2 - Math.cos(ang - 0.45) * head, y2 - Math.sin(ang - 0.45) * head); g.lineTo(x2 - Math.cos(ang + 0.45) * head, y2 - Math.sin(ang + 0.45) * head); g.closePath(); g.fill();
    g.restore();
  }

  // ---------------------------------------------------------------- input

  private squareAt(e: PointerEvent): number | null {
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (x < 0 || y < 0 || x >= r.width || y >= r.height) return null;
    const c = Math.floor((x / r.width) * 8), rw = Math.floor((y / r.height) * 8);
    return this.flipped ? (7 - rw) * 8 + (7 - c) : rw * 8 + c;
  }

  private async refreshLegal(): Promise<void> { this.legal = await this.opts.legalMoves(); }

  private async onDown(e: PointerEvent): Promise<void> {
    if (!this.interactive || this.busy) return;
    const sq = this.squareAt(e);
    if (sq === null) return;
    if (this.selected !== null && this.selected !== sq) {
      const handled = await this.tryMove(this.selected, sq);
      if (handled) return;
    }
    const p = this.squares[sq];
    if (p && p.color === this.turn) {
      this.canvas.setPointerCapture(e.pointerId);
      if (!this.legal.length) await this.refreshLegal();
      this.selected = sq;
      const r = this.canvas.getBoundingClientRect();
      this.drag = { from: sq, x: e.clientX - r.left, y: e.clientY - r.top };
    } else { this.selected = null; }
    this.invalidate();
  }

  private onMove(e: PointerEvent): void {
    if (!this.drag) return;
    const r = this.canvas.getBoundingClientRect();
    this.drag.x = e.clientX - r.left; this.drag.y = e.clientY - r.top;
    this.invalidate();
  }

  private async onUp(e: PointerEvent): Promise<void> {
    if (!this.drag) return;
    const from = this.drag.from;
    this.drag = null;
    const to = this.squareAt(e);
    if (to !== null && to !== from) { if (await this.tryMove(from, to)) return; }
    this.invalidate(); // altrimenti resta selezionata (modalità clic-clic)
  }

  /** Prova la mossa from→to. Restituisce true se è stata inviata. */
  private async tryMove(from: number, to: number): Promise<boolean> {
    const f = sqName(from), t = sqName(to);
    const cands = this.legal.filter((m) => m.startsWith(f + t));
    if (!cands.length) return false;
    let uci = cands[0]!;
    if (cands.length > 1) { // promozione
      const color = this.squares[from]!.color;
      this.busy = true;
      const choice = (await this.opts.askPromotion?.(color)) ?? "q";
      this.busy = false;
      if (!choice) { this.selected = null; this.legal = []; this.invalidate(); return true; }
      uci = f + t + choice;
    }
    this.selected = null; this.legal = [];
    this.opts.onMove?.(uci);
    return true;
  }

  /** Da chiamare dopo ogni cambio di posizione per ricaricare le mosse legali. */
  async reloadLegal(): Promise<void> { this.legal = []; await this.refreshLegal(); this.invalidate(); }
  clearSelection(): void { this.selected = null; this.legal = []; this.invalidate(); }
}
