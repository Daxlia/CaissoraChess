// Scacchiera su Canvas 2D guidata dal tema (.cctheme). Principi:
//  * strato statico (scena + piano proiettato + vignettatura) ridisegnato solo quando cambia qualcosa di strutturale;
//  * strato dinamico (evidenziazioni, pezzi, effetti, ambiente) ridisegnato a richiesta, o in continuo solo se il tema
//    ha animazioni ambientali/idle e la scacchiera è visibile; il ritmo si adatta alle prestazioni misurate;
//  * vista inclinabile: il piano è proiettato per strisce, i pezzi sono "billboard" ordinati per profondità;
//  * nessuna regola scacchistica: le mosse legali arrivano dal backend.
import { parsePlacement, sqIndex, sqName, splitUci, type Piece, type Squares } from "./fen";
import { Projection } from "../themes/projection";
import { frameWidth, paintFlat, paintScene } from "../themes/paint";
import { PieceSet, pieceId } from "../themes/pieceSprites";
import { AmbientParticles, glowSprite, type Fx } from "../themes/fx";
import type { LoadedTheme } from "../themes/registry";
import type { Scene3D } from "../themes/renderer3d";
import type { Ambient, BoardSpec, Motion } from "../themes/types";

export interface BoardOptions {
  onMove?: (uci: string) => void;
  legalMoves: () => Promise<string[]>;
  askPromotion?: (color: "w" | "b") => Promise<"q" | "r" | "b" | "n" | null>;
}

interface Anim { from: number; to: number; piece: Piece; captured: Piece | null; start: number; dur: number; m: Motion; trail: [number, number][]; capDone: boolean }

const HL = { lastMove: "rgba(246,226,90,0.5)", selected: "rgba(80,160,255,0.5)", legal: "rgba(20,20,20,0.38)", check: "rgba(235,60,60,0.7)", hint: "#2fbf71" };
const EASE: Record<string, (k: number) => number> = {
  linear: (k) => k,
  "ease-out": (k) => 1 - (1 - k) ** 3,
  "ease-in-out": (k) => (k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2),
  spring: (k) => (k >= 1 ? 1 : 1 - Math.exp(-6 * k) * Math.cos(k * Math.PI * 3)),
};

export class Board {
  readonly canvas = document.createElement("canvas");
  private g = this.canvas.getContext("2d")!;
  private squares: Squares = new Array(64).fill(null);
  private flipped = false;
  private boardTh: LoadedTheme | null = null;
  private pieces: PieceSet | null = null;
  private size = 0; private dpr = 1; private dprCap = 2;
  private proj: Projection | null = null;
  private staticCv = document.createElement("canvas");
  private staticDirty = true;
  private selected: number | null = null;
  private legal: string[] = [];
  private lastMove: [number, number] | null = null;
  private checkSq: number | null = null;
  private hint: [number, number] | null = null;
  private anim: Anim | null = null;
  private fx: Fx[] = [];
  private drag: { from: number; x: number; y: number } | null = null;
  private raf = 0; private dirty = true;
  private interactive = true; private turn: "w" | "b" = "w";
  private ro: ResizeObserver; private io: IntersectionObserver;
  private onScreen = true;
  private reduceMotion = false;
  private quality: "low" | "auto" | "high" = "auto";
  private ambientOn = true;
  private busy = false;
  private s3: Scene3D | null = null;
  private mod3: typeof import("../themes/renderer3d") | null = null;
  private sync3Token = 0;
  private particles: AmbientParticles[] = [];
  private frameMs = 0; private degraded = 0; private lastFrame = 0; private startT = performance.now();

  constructor(private host: HTMLElement, private opts: BoardOptions) {
    this.canvas.className = "board-canvas";
    this.canvas.setAttribute("role", "img");
    host.appendChild(this.canvas);
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(host);
    this.io = new IntersectionObserver((e) => { this.onScreen = e.some((x) => x.isIntersecting); if (this.onScreen) this.invalidate(); });
    this.io.observe(this.canvas);
    this.canvas.addEventListener("pointerdown", (e) => void this.onDown(e));
    this.canvas.addEventListener("pointermove", (e) => this.onMove(e));
    this.canvas.addEventListener("pointerup", (e) => void this.onUp(e));
    this.canvas.addEventListener("pointercancel", () => { this.drag = null; this.invalidate(); });
    document.addEventListener("visibilitychange", this.onVisibility);
    this.resize();
  }

  destroy(): void {
    this.ro.disconnect(); this.io.disconnect(); cancelAnimationFrame(this.raf); this.raf = 0; this.s3?.dispose();
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.canvas.remove();
  }

  // ---------------------------------------------------------------- stato

  setPosition(fen: string, turn: "w" | "b"): void {
    this.squares = parsePlacement(fen); this.turn = turn;
    this.selected = null; this.legal = []; this.anim = null; this.drag = null;
    this.canvas.setAttribute("aria-label", `Chessboard, ${turn === "w" ? "white" : "black"} to move`);
    this.invalidate();
  }
  setBoardTheme(t: LoadedTheme): void {
    if (!t.manifest.board) return;
    this.boardTh = t; this.staticDirty = true; this.proj = null;
    const amb = t.manifest.board.ambient ?? [];
    this.particles = amb.filter((a): a is Extract<Ambient, { type: "particles" }> => a.type === "particles").map((a) => new AmbientParticles(a.count, a.direction ?? "down"));
    this.resize(true); void this.sync3D(); this.invalidate();
  }
  private pieceTh: LoadedTheme | null = null;
  setPieceTheme(t: LoadedTheme): void { if (!t.manifest.pieces) return; this.pieceTh = t; this.pieces = t.manifest.pieces.source ? new PieceSet(t) : null; void this.sync3D(); this.invalidate(); }

  /** Vista 3D vera quando i pezzi sono modelli 3D o la scacchiera è inclinata; altrimenti Canvas 2D. Senza WebGL si ricade sul 2D. */
  private async sync3D(): Promise<void> {
    const my = ++this.sync3Token, b = this.spec, ps = this.pieceTh?.manifest.pieces;
    if (!b || !this.boardTh) return;
    const need = !!ps?.model || (b.view?.tilt ?? 0) > 0;
    if (!need) { this.s3?.dispose(); this.s3 = null; this.invalidate(); return; }
    try {
      this.mod3 ??= await import("../themes/renderer3d");
      if (my !== this.sync3Token) return;
      if (!this.mod3.webglSupported()) throw new Error("no webgl");
      this.s3?.dispose();
      const s = new this.mod3.Scene3D(this.boardTh, Math.max(2, this.size), this.dpr, this.quality);
      s.setPieces(this.pieceTh, this.pieces); this.s3 = s;
    } catch {
      this.s3 = null;
      if (ps?.model) { // niente WebGL: i pezzi solo-3D non si possono disegnare, si usano i classici in 2D
        const { loadTheme } = await import("../themes/registry");
        const c = await loadTheme("classic"); if (my === this.sync3Token) { this.pieceTh = c; this.pieces = new PieceSet(c); }
      }
    }
    this.invalidate();
  }
  setFlipped(f: boolean): void { this.flipped = f; this.staticDirty = true; this.invalidate(); }
  setInteractive(v: boolean): void { this.interactive = v; if (!v) { this.selected = null; this.legal = []; } this.invalidate(); }
  setLastMove(uci: string | null): void { if (!uci) { this.lastMove = null; } else { const m = splitUci(uci); this.lastMove = [sqIndex(m.from), sqIndex(m.to)]; } this.invalidate(); }
  setCheck(kingSq: string | null): void { this.checkSq = kingSq ? sqIndex(kingSq) : null; this.invalidate(); }
  setHint(h: [string, string] | null): void { this.hint = h ? [sqIndex(h[0]), sqIndex(h[1])] : null; this.invalidate(); }
  setReduceMotion(v: boolean): void { this.reduceMotion = v; this.invalidate(); }
  /** Abilita/disabilita le animazioni ambientali (le anteprime animano solo al passaggio del mouse). */
  setAmbient(on: boolean): void { this.ambientOn = on; this.invalidate(); }
  /** Qualità grafica: limita la densità di pixel, disattiva ambiente e animazioni idle in "low". */
  setQuality(q: "low" | "auto" | "high"): void { this.quality = q; this.dprCap = q === "low" ? 1 : q === "high" ? 3 : 2; this.degraded = 0; this.resize(true); void this.sync3D(); }
  get isFlipped(): boolean { return this.flipped; }

  private get spec(): BoardSpec | null { return this.boardTh?.manifest.board ?? null; }
  private get motion(): Motion { return this.pieces?.spec.motion ?? { style: "slide", durationMs: 200, easing: "ease-out" }; }
  /** Ambiente/idle attivi? */
  private get live(): boolean { return !this.reduceMotion && this.quality !== "low" && this.degraded < 2 && this.ambientOn; }
  private get hasLoop(): boolean {
    if (!this.live) return false;
    const b = this.spec, p = this.pieces?.spec;
    return !!((b?.ambient ?? []).some((a) => a.type !== "vignette") || b?.frame?.glow?.pulseSeconds || p?.idle);
  }

  /** Anima una mossa (già valida) e poi imposta la nuova posizione. */
  animateMove(uci: string, newFen: string, newTurn: "w" | "b"): Promise<void> {
    const { from, to } = splitUci(uci);
    const f = sqIndex(from), t = sqIndex(to);
    const piece = this.squares[f];
    if (!piece || this.reduceMotion) { this.setPosition(newFen, newTurn); return Promise.resolve(); }
    const m = this.motion;
    return new Promise((resolve) => {
      this.anim = { from: f, to: t, piece, captured: this.squares[t] ?? null, start: performance.now(), dur: m.durationMs ?? 200, m, trail: [], capDone: false };
      this.squares = this.squares.slice(); this.squares[f] = null;
      this.selected = null; this.legal = [];
      const done = () => {
        const a = this.anim; this.setPosition(newFen, newTurn);
        if (a) this.spawnImpact(a);
        resolve();
      };
      const step = () => { if (!this.anim) return done(); if (performance.now() - this.anim.start >= this.anim.dur) return done(); this.invalidate(); requestAnimationFrame(step); };
      requestAnimationFrame(step);
    });
  }

  // ---------------------------------------------------------------- geometria

  private resize(force = false): void {
    const w = Math.floor(Math.min(this.host.clientWidth, this.host.clientHeight || this.host.clientWidth));
    const size = Math.max(0, w);
    const dpr = Math.min(window.devicePixelRatio || 1, this.dprCap);
    if (!force && size === this.size && dpr === this.dpr) return;
    this.size = size; this.dpr = dpr;
    this.canvas.style.width = this.canvas.style.height = `${size}px`;
    this.canvas.width = this.canvas.height = Math.round(size * dpr);
    this.proj = null; this.staticDirty = true;
    this.s3?.resize(size, dpr);
    this.invalidate();
  }

  private ensureProj(): Projection | null {
    if (!this.spec || !this.size) return null;
    if (!this.proj) this.proj = new Projection(this.size, 0, 2.4);
    return this.proj;
  }

  private get fw(): number { return this.spec ? frameWidth(this.spec) : 0; }
  private get total(): number { return 8 + 2 * this.fw; }

  /** Posizione visiva (colonna, riga) di un indice 0..63. */
  private vis(i: number): [number, number] { const c = i % 8, r = i >> 3; return this.flipped ? [7 - c, 7 - r] : [c, r]; }
  /** Punto sullo schermo di coordinate di casella float (0..8). Restituisce x, y e scala prospettica. */
  private pt(col: number, row: number): [number, number, number] {
    const p = this.proj!, T = this.total, fw = this.fw;
    return p.fwd(((fw + col) / T) * 2 - 1, ((fw + row) / T) * 2 - 1);
  }
  /** Larghezza e altezza apparenti di una casella centrata in (col,row). */
  private cellSize(col: number, row: number): [number, number] {
    const [x0, , s] = this.pt(col + 0.5, row + 0.5);
    const w = (this.proj!.k * s * 2) / this.total;
    const [, ya] = this.pt(col + 0.5, row), [, yb] = this.pt(col + 0.5, row + 1);
    void x0;
    return [w, Math.abs(yb - ya)];
  }

  // ---------------------------------------------------------------- strato statico

  private buildStatic(): void {
    const th = this.boardTh!, b = this.spec!, S = Math.round(this.size * this.dpr);
    const cv = this.staticCv; cv.width = cv.height = S;
    const g = cv.getContext("2d")!;
    paintScene(g, S, th, b);
    const pd = new Projection(S, 0, 2.4);
    const F = Math.min(2400, Math.max(256, Math.round(2 * pd.k * pd.scale(1))));
    const flat = document.createElement("canvas"); flat.width = flat.height = F;
    paintFlat(flat.getContext("2d")!, F, th, b, this.flipped);
    g.imageSmoothingQuality = "high";
    g.drawImage(flat, pd.cx - pd.k, pd.oy - pd.k, 2 * pd.k, 2 * pd.k);
    for (const a of b.ambient ?? []) if (a.type === "vignette") {
      const gr = g.createRadialGradient(S / 2, S * 0.55, S * 0.25, S / 2, S * 0.55, S * 0.78);
      gr.addColorStop(0, "rgba(0,0,0,0)"); gr.addColorStop(1, withAlpha(a.color, a.strength ?? 0.5));
      g.fillStyle = gr; g.fillRect(0, 0, S, S);
    }
    this.staticDirty = false;
  }

  // ---------------------------------------------------------------- ciclo di disegno

  private onVisibility = (): void => { if (!document.hidden) this.invalidate(); };

  private invalidate(): void {
    this.dirty = true;
    if (this.raf || document.hidden || !this.onScreen) return;
    this.raf = requestAnimationFrame((t) => this.tick(t));
  }

  private tick(now: number): void {
    this.raf = 0;
    if (document.hidden || !this.onScreen) return;
    const loop = this.hasLoop || this.anim !== null || this.fx.length > 0 || this.s3 !== null && this.s3.busy;
    const minGap = this.degraded >= 1 && this.quality !== "high" ? 33 : 15;
    if (loop && now - this.lastFrame < minGap && !this.dirty) { this.raf = requestAnimationFrame((t) => this.tick(t)); return; }
    if (this.dirty || loop) {
      this.dirty = false; this.lastFrame = now;
      const t0 = performance.now();
      this.draw();
      const dt = performance.now() - t0;
      this.frameMs = this.frameMs ? this.frameMs * 0.92 + dt * 0.08 : dt;
      if (this.quality === "auto" && this.hasLoop) { // adattamento: prima ritmo ridotto, poi niente ambiente
        if (this.frameMs > 24 && this.degraded < 2) { this.degraded = 2; } else if (this.frameMs > 13 && this.degraded < 1) { this.degraded = 1; }
      }
    }
    if (this.hasLoop || this.anim !== null || this.fx.length > 0) this.raf = requestAnimationFrame((t) => this.tick(t));
  }

  private draw(): void {
    const { g, size, dpr } = this;
    const proj = this.ensureProj(), b = this.spec;
    if (!size || !proj || !b || !this.boardTh) return;
    const now = performance.now(), sec = (now - this.startT) / 1000;
    if (this.s3) { this.draw3D(now); return; }
    if (this.staticDirty) this.buildStatic();
    g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, this.canvas.width, this.canvas.height);
    g.drawImage(this.staticCv, 0, 0);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const live = this.live;
    this.fx = this.fx.filter((f) => now - f.start < f.dur);

    if (live) this.drawPlaneEffects(b, now, sec);
    this.drawHighlights(b);
    this.drawPieces(now, sec, live);
    for (const f of this.fx) { g.save(); f.draw(g, (now - f.start) / f.dur); g.restore(); }
    if (live) this.drawParticles(b, now);
    if (this.hint) this.drawArrow(this.hint[0], this.hint[1], b.highlights?.hint ?? HL.hint);
  }

  private draw3D(now: number): void {
    const a = this.anim;
    let hideAt: number | null = null;
    if (a) {
      const k = Math.min(1, (now - a.start) / a.dur);
      if (a.captured && !a.capDone && k >= 0.82) {
        a.capDone = true;
        const cap = this.pieces?.spec.capture ?? this.pieceTh?.manifest.pieces?.capture;
        const node = this.s3!.detach(a.to);
        const effect = this.reduceMotion || this.quality === "low" ? "fade" : cap?.effect ?? "fade";
        this.s3!.captureFx(a.captured, a.to, effect, cap?.color ?? "#ffffff", cap?.particles ?? 16, cap?.durationMs ?? 300, node);
      }
      if (a.captured && a.capDone) hideAt = a.to;
    }
    this.s3!.render(this.g, {
      squares: this.squares, selected: this.selected, legal: this.legal, lastMove: this.lastMove, checkSq: this.checkSq, hint: this.hint,
      drag: this.drag, flipped: this.flipped, hideAt,
      anim: a ? { from: a.from, to: a.to, piece: a.piece, start: a.start, dur: a.dur, m: a.m } : null,
    }, now, this.live);
  }

  private corners(col: number, row: number, w = 1, h = 1, inset = 0): [number, number][] {
    return [this.pt(col + inset, row + inset), this.pt(col + w - inset, row + inset), this.pt(col + w - inset, row + h - inset), this.pt(col + inset, row + h - inset)].map(([x, y]) => [x, y] as [number, number]);
  }
  private poly(g: CanvasRenderingContext2D, pts: [number, number][]): void { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); }

  /** Riflesso che attraversa il piano e alone pulsante della cornice. */
  private drawPlaneEffects(b: BoardSpec, now: number, sec: number): void {
    const g = this.g, fw = this.fw, T = this.total;
    const outer = [this.pt(-fw, -fw), this.pt(8 + fw, -fw), this.pt(8 + fw, 8 + fw), this.pt(-fw, 8 + fw)].map(([x, y]) => [x, y] as [number, number]);
    const sw = (b.ambient ?? []).find((a): a is Extract<Ambient, { type: "sweep" }> => a.type === "sweep");
    if (sw) {
      const xs = outer.map((p) => p[0]), ys = outer.map((p) => p[1]);
      const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      const per = (sw.periodSeconds ?? 7) * 1000, w = sw.width ?? 0.25;
      const t = ((now % per) / per) * (1 + 2 * w) - w;
      const gr = g.createLinearGradient(x0, y0, x1, y1);
      const stop = (v: number, a: number) => gr.addColorStop(Math.min(1, Math.max(0, v)), withAlpha(sw.color, a));
      stop(0, 0); stop(t - w, 0); stop(t, sw.opacity ?? 0.5); stop(t + w, 0); stop(1, 0);
      g.save(); this.poly(g, outer); g.clip(); g.globalCompositeOperation = "screen"; g.fillStyle = gr; g.fillRect(x0, y0, x1 - x0, y1 - y0); g.restore();
    }
    const gl = b.frame?.glow;
    if (gl && fw > 0) {
      const pulse = gl.pulseSeconds ? 0.65 + 0.35 * Math.sin((sec * Math.PI * 2) / gl.pulseSeconds) : 1;
      const [, , s] = this.pt(4, 4); const unit = (this.proj!.k * s * 2) / T;
      g.save(); g.strokeStyle = gl.color; g.globalAlpha = 0.9 * pulse; g.shadowColor = gl.color; g.shadowBlur = gl.radius * unit * 1.3 * (0.7 + 0.3 * pulse);
      g.lineWidth = Math.max(1.5, unit * 0.035);
      this.poly(g, this.corners(0, 0, 8, 8)); g.stroke(); this.poly(g, outer); g.stroke(); g.restore();
    }
  }

  private drawHighlights(b: BoardSpec): void {
    const g = this.g, h = b.highlights ?? {}, style = h.style ?? "fill";
    const col = { lastMove: h.lastMove ?? HL.lastMove, selected: h.selected ?? HL.selected, legal: h.legal ?? HL.legal, check: h.check ?? HL.check };
    const mark = (i: number, color: string) => {
      const [c, r] = this.vis(i);
      g.save();
      if (style === "ring") {
        this.poly(g, this.corners(c, r)); g.globalAlpha = 0.22; g.fillStyle = color; g.fill(); g.globalAlpha = 1;
        const [w] = this.cellSize(c, r); g.lineWidth = Math.max(2, w * 0.07); g.strokeStyle = color; this.poly(g, this.corners(c, r, 1, 1, 0.07)); g.stroke();
      } else if (style === "glow") {
        const [w] = this.cellSize(c, r);
        this.poly(g, this.corners(c, r)); g.globalAlpha = 0.4; g.fillStyle = color; g.fill(); g.globalAlpha = 1;
        g.strokeStyle = color; g.lineWidth = Math.max(1.5, w * 0.045); g.shadowColor = color; g.shadowBlur = w * 0.35; this.poly(g, this.corners(c, r, 1, 1, 0.03)); g.stroke();
      } else { this.poly(g, this.corners(c, r)); g.fillStyle = color; g.fill(); }
      g.restore();
    };
    if (this.lastMove) { mark(this.lastMove[0], col.lastMove); mark(this.lastMove[1], col.lastMove); }
    if (this.checkSq !== null) mark(this.checkSq, col.check);
    if (this.selected !== null) mark(this.selected, col.selected);
    if (this.selected !== null) {
      const from = sqName(this.selected);
      g.fillStyle = col.legal; g.strokeStyle = col.legal;
      for (const m of this.legal) {
        if (!m.startsWith(from)) continue;
        const to = sqIndex(m.slice(2, 4)); const [c, r] = this.vis(to);
        const [x, y] = this.pt(c + 0.5, r + 0.5); const [w, hh] = this.cellSize(c, r);
        g.save(); g.shadowColor = style === "glow" ? col.legal : "transparent"; g.shadowBlur = style === "glow" ? w * 0.25 : 0;
        g.beginPath();
        if (this.squares[to]) { g.lineWidth = w * 0.08; g.ellipse(x, y, w * 0.44, hh * 0.44, 0, 0, Math.PI * 2); g.stroke(); }
        else { g.ellipse(x, y, w * 0.16, hh * 0.16, 0, 0, Math.PI * 2); g.fill(); }
        g.restore();
      }
    }
  }

  // ---------------------------------------------------------------- pezzi

  private drawPiece(p: Piece, col: number, row: number, o: { alpha?: number; lift?: number; squash?: number; mul?: number; idleIdx?: number; sec?: number; live?: boolean; noShadow?: boolean } = {}): void {
    const set = this.pieces; if (!set) return;
    const g = this.g, spec = set.spec;
    const [x, y] = this.pt(col + 0.5, row + 0.5); const [w, h] = this.cellSize(col, row);
    let lift = o.lift ?? 0, mul = o.mul ?? 1, frame = 0, glow: string | null = null;
    const idle = spec.idle;
    if (o.live && idle && o.idleIdx !== undefined && o.sec !== undefined) {
      const ph = (o.sec * Math.PI * 2) / (idle.periodSeconds ?? 3) + o.idleIdx * 0.9, amp = idle.amplitude ?? 0.03;
      if (idle.style === "float") lift += amp * (0.5 + 0.5 * Math.sin(ph));
      else if (idle.style === "breathe") mul *= 1 + amp * Math.sin(ph);
      else if (idle.style === "glow") glow = idle.color ?? "#ffffff";
      else if (idle.style === "frames" && spec.frames) frame = Math.floor(o.sec * spec.frames.fps + o.idleIdx) % spec.frames.count;
    }
    const alpha = o.alpha ?? 1;
    const sh = spec.shadow;
    if (sh && !o.noShadow) {
      const rx = w * 0.34 * (sh.scale ?? 1) * (1 - Math.min(0.3, lift * 0.4)), ry = rx * (0.55 + 0.45 * (this.proj!.cosT ** 2));
      g.save(); g.globalAlpha = alpha * sh.opacity * (1 - Math.min(0.5, lift * 0.6)); g.translate(x, y + h * 0.1); g.scale(1, ry / rx);
      const gr = g.createRadialGradient(0, 0, 0, 0, 0, rx); const inner = Math.max(0, 1 - (sh.blur ?? 0.5));
      gr.addColorStop(0, sh.color); gr.addColorStop(inner, withAlpha(sh.color, 0.7)); gr.addColorStop(1, withAlpha(sh.color, 0));
      g.fillStyle = gr; g.beginPath(); g.arc(0, 0, rx, 0, Math.PI * 2); g.fill(); g.restore();
    }
    if (glow) { const gs = glowSprite(glow); g.save(); g.globalAlpha = alpha * (0.35 + 0.2 * Math.sin((o.sec ?? 0) * 2 + (o.idleIdx ?? 0))); const r = w * 0.62; g.drawImage(gs, x - r, y - r * 1.1, r * 2, r * 2); g.restore(); }
    const dw = w * (spec.scale ?? 1) * mul;
    const px = Math.round(dw * this.dpr);
    const sp = set.sprite(pieceId(p), px);
    const dh = (dw * sp.frameH) / sp.frameW, anc = spec.anchor ?? { x: 0.5, y: 0.5 };
    const dy = y - anc.y * dh + (spec.offsetY ?? 0) * w - lift * w;
    g.save(); g.globalAlpha = alpha;
    if (o.squash) { g.translate(x, y); g.scale(1 + o.squash * 0.5, 1 - o.squash); g.translate(-x, -y); }
    g.drawImage(sp.canvas, frame * sp.frameW, 0, sp.frameW, sp.frameH, x - anc.x * dw, dy, dw, dh);
    g.restore();
  }

  private drawPieces(now: number, sec: number, live: boolean): void {
    const skip = this.drag ? this.drag.from : -1;
    const order: number[] = [];
    for (let i = 0; i < 64; i++) if (this.squares[i] && i !== skip) order.push(i);
    order.sort((a, b) => this.vis(a)[1] - this.vis(b)[1]); // dal fondo al davanti
    const a = this.anim;
    for (const i of order) {
      if (a && a.captured && a.capDone && i === a.to) continue;
      const [c, r] = this.vis(i);
      this.drawPiece(this.squares[i]!, c, r, { idleIdx: i, sec, live });
    }
    if (a) {
      const k = Math.min(1, (now - a.start) / a.dur);
      if (a.captured && !a.capDone && k >= 0.82) { a.capDone = true; this.spawnCapture(a); }
      const e = (EASE[a.m.easing ?? "ease-out"] ?? EASE["ease-out"]!)(k);
      const [c0, r0] = this.vis(a.from), [c1, r1] = this.vis(a.to);
      const col = c0 + (c1 - c0) * e, row = r0 + (r1 - r0) * e;
      const arc = a.m.style === "slide" ? 0 : 4 * k * (1 - k) * (a.m.lift ?? 0.4) * (a.m.style === "hop" ? 1.2 : 1);
      const land = k > 0.85 && (a.m.squash ?? 0) > 0 ? (a.m.squash ?? 0) * Math.sin(((k - 0.85) / 0.15) * Math.PI) : 0;
      if (a.m.trail) { const [x, y] = this.pt(col + 0.5, row + 0.5); a.trail.push([x, y]); if (a.trail.length > 18) a.trail.shift(); this.drawTrail(a); }
      this.drawPiece(a.piece, col, row, { lift: arc, squash: land, noShadow: false, idleIdx: undefined });
    }
    if (this.drag) {
      const p = this.squares[this.drag.from];
      if (p) {
        const d = this.drag, [w] = this.cellSize(3, 3);
        // il pezzo trascinato segue il puntatore: si ricava la casella fittizia sotto il dito
        const inv = this.proj!.inv(d.x, d.y); const T = this.total, fw = this.fw;
        const colF = ((inv[0] + 1) / 2) * T - fw - 0.5, rowF = ((inv[1] + 1) / 2) * T - fw - 0.5;
        void w; this.drawPiece(p, colF, rowF, { lift: 0.25, mul: 1.06 });
      }
    }
  }

  private drawTrail(a: Anim): void {
    const g = this.g, t = a.m.trail!, n = a.trail.length;
    const [w] = this.cellSize(3, 3), maxLen = Math.max(2, Math.round(18 * (t.length ?? 0.5)));
    g.save(); g.globalCompositeOperation = "lighter";
    const from = Math.max(0, n - maxLen);
    for (let i = from; i < n; i++) {
      const k = (i - from) / Math.max(1, n - from - 1 || 1);
      const gs = glowSprite(t.color), r = w * (t.width ?? 0.18) * (0.4 + 0.9 * k);
      g.globalAlpha = 0.65 * k; g.drawImage(gs, a.trail[i]![0] - r, a.trail[i]![1] - r, r * 2, r * 2);
    }
    g.restore();
  }

  // ---------------------------------------------------------------- effetti

  private spawnImpact(a: Anim): void {
    const im = a.m.impact; if (!im || this.reduceMotion || this.quality === "low") return;
    if (this.s3) { this.s3.impactFx(a.to, im.color, im.size ?? 0.5); this.invalidate(); return; }
    const [c, r] = this.vis(a.to);
    this.fx.push({ start: performance.now(), dur: 420, draw: (g, k) => {
      const [x, y] = this.pt(c + 0.5, r + 0.5), [w, h] = this.cellSize(c, r);
      const rr = w * (im.size ?? 0.5) * (0.25 + 0.9 * k);
      g.globalAlpha = (1 - k) * 0.9; g.strokeStyle = im.color; g.lineWidth = Math.max(1.5, w * 0.05 * (1 - k)); g.shadowColor = im.color; g.shadowBlur = w * 0.2;
      g.beginPath(); g.ellipse(x, y + h * 0.1, rr, rr * (h / w), 0, 0, Math.PI * 2); g.stroke();
    } });
  }

  private spawnCapture(a: Anim): void {
    const cap = this.pieces?.spec.capture, p = a.captured!;
    const [c, r] = this.vis(a.to);
    const dur = cap?.durationMs ?? 260, effect = this.reduceMotion || this.quality === "low" ? "fade" : cap?.effect ?? "fade";
    const n = Math.min(cap?.particles ?? 16, this.quality === "high" ? 120 : 60);
    const color = cap?.color ?? "#ffffff";
    const parts = Array.from({ length: n }, () => ({ a: Math.random() * Math.PI * 2, v: 0.4 + Math.random() * 1.1, s: 0.5 + Math.random(), rot: (Math.random() - 0.5) * 8 }));
    this.fx.push({ start: performance.now(), dur, draw: (g, k) => {
      const set = this.pieces; if (!set) return;
      const [x, y] = this.pt(c + 0.5, r + 0.5), [w] = this.cellSize(c, r);
      const spec = set.spec, dw = w * (spec.scale ?? 1), sp = set.sprite(pieceId(p), Math.round(dw * this.dpr));
      const dh = (dw * sp.frameH) / sp.frameW, anc = spec.anchor ?? { x: 0.5, y: 0.5 };
      const left = x - anc.x * dw, top = y - anc.y * dh + (spec.offsetY ?? 0) * w;
      if (effect === "fade" || effect === "dissolve") {
        g.globalAlpha = 1 - k; g.drawImage(sp.canvas, 0, 0, sp.frameW, sp.frameH, left, top - (effect === "dissolve" ? k * w * 0.3 : 0), dw, dh); g.globalAlpha = 1;
      }
      if (effect === "burst" || effect === "dissolve") {
        g.globalCompositeOperation = "lighter"; const gs = glowSprite(color);
        for (const q of parts) {
          const d = k * q.v * w * (effect === "burst" ? 1.1 : 0.5), px = x + Math.cos(q.a) * d, py = y - dh * 0.2 + Math.sin(q.a) * d * 0.8 + (effect === "dissolve" ? -k * w * 0.5 : k * k * w * 0.4);
          const rr = w * 0.07 * q.s * (1 - k * 0.6); g.globalAlpha = (1 - k) * 0.9; g.drawImage(gs, px - rr, py - rr, rr * 2, rr * 2);
        }
        g.globalCompositeOperation = "source-over";
        if (effect === "burst") { g.globalAlpha = Math.max(0, 1 - k * 3); g.drawImage(sp.canvas, 0, 0, sp.frameW, sp.frameH, left, top, dw, dh); }
      }
      if (effect === "shatter") {
        const N = 4, tw = sp.frameW / N, th = sp.frameH / N;
        for (let i = 0; i < N * N; i++) {
          const tx = i % N, ty = Math.floor(i / N), q = parts[i % parts.length]!;
          const cx = left + (tx + 0.5) * (dw / N), cy = top + (ty + 0.5) * (dh / N);
          const dx = Math.cos(q.a) * k * q.v * w * 0.9, dy = Math.sin(q.a) * k * q.v * w * 0.6 + k * k * w * 0.9;
          g.save(); g.globalAlpha = Math.max(0, 1 - k * k); g.translate(cx + dx, cy + dy); g.rotate(q.rot * k);
          g.drawImage(sp.canvas, tx * tw, ty * th, tw, th, -dw / N / 2, -dh / N / 2, dw / N, dh / N); g.restore();
        }
      }
    } });
  }

  private drawParticles(b: BoardSpec, now: number): void {
    const g = this.g, S = this.size;
    const defs = (b.ambient ?? []).filter((a): a is Extract<Ambient, { type: "particles" }> => a.type === "particles");
    defs.forEach((d, i) => {
      const sys = this.particles[i]; if (!sys) return;
      sys.step(now, d.speed ?? 0.05);
      const gs = glowSprite(d.color), glow = d.glow ?? 0, base = (d.size ?? 0.02) * S;
      const cnt = this.degraded >= 1 ? Math.ceil(d.count / 2) : d.count; let n = 0;
      g.save();
      sys.each((q) => {
        if (n++ >= cnt) return;
        const tw = 0.55 + 0.45 * Math.sin(q.ph * 2.3), r = base * q.s * (1.5 + glow * 3);
        g.globalAlpha = 0.25 + 0.65 * tw; g.drawImage(gs, q.x * S - r, q.y * S - r, r * 2, r * 2);
      });
      g.restore();
    });
  }

  private drawArrow(from: number, to: number, color: string): void {
    const g = this.g;
    const [c0, r0] = this.vis(from), [c1, r1] = this.vis(to);
    const [x1, y1] = this.pt(c0 + 0.5, r0 + 0.5), [x2, y2] = this.pt(c1 + 0.5, r1 + 0.5); const [s] = this.cellSize(c1, r1);
    const ang = Math.atan2(y2 - y1, x2 - x1), head = s * 0.3, w = s * 0.11;
    const ex = x2 - Math.cos(ang) * head * 0.6, ey = y2 - Math.sin(ang) * head * 0.6;
    g.save(); g.globalAlpha = 0.85; g.strokeStyle = g.fillStyle = color; g.lineWidth = w; g.lineCap = "round";
    g.beginPath(); g.moveTo(x1, y1); g.lineTo(ex, ey); g.stroke();
    g.beginPath(); g.moveTo(x2, y2); g.lineTo(x2 - Math.cos(ang - 0.45) * head, y2 - Math.sin(ang - 0.45) * head); g.lineTo(x2 - Math.cos(ang + 0.45) * head, y2 - Math.sin(ang + 0.45) * head); g.closePath(); g.fill();
    g.restore();
  }

  // ---------------------------------------------------------------- input

  private squareAt(e: PointerEvent): number | null {
    if (this.s3) { const [x, y] = this.localXY(e); return this.s3.pick(x, y); }
    const proj = this.ensureProj(); if (!proj) return null;
    const r = this.canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * this.size, y = ((e.clientY - r.top) / r.height) * this.size;
    const [X, Y] = proj.inv(x, y);
    if (Math.abs(X) > 1 || Math.abs(Y) > 1) return null;
    const T = this.total, fw = this.fw;
    const c = Math.floor(((X + 1) / 2) * T - fw), rw = Math.floor(((Y + 1) / 2) * T - fw);
    if (c < 0 || c > 7 || rw < 0 || rw > 7) return null;
    return this.flipped ? (7 - rw) * 8 + (7 - c) : rw * 8 + c;
  }
  private localXY(e: PointerEvent): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * this.size, ((e.clientY - r.top) / r.height) * this.size];
  }

  private async refreshLegal(): Promise<void> { this.legal = await this.opts.legalMoves(); }

  private async onDown(e: PointerEvent): Promise<void> {
    if (!this.interactive || this.busy) return;
    const sq = this.squareAt(e);
    if (sq === null) return;
    if (this.selected !== null && this.selected !== sq) { if (await this.tryMove(this.selected, sq)) return; }
    const p = this.squares[sq];
    if (p && p.color === this.turn) {
      this.canvas.setPointerCapture(e.pointerId);
      if (!this.legal.length) await this.refreshLegal();
      this.selected = sq;
      const [x, y] = this.localXY(e);
      this.drag = { from: sq, x, y };
    } else { this.selected = null; }
    this.invalidate();
  }

  private onMove(e: PointerEvent): void {
    if (!this.drag) return;
    [this.drag.x, this.drag.y] = this.localXY(e);
    this.invalidate();
  }

  private async onUp(e: PointerEvent): Promise<void> {
    if (!this.drag) return;
    const from = this.drag.from; this.drag = null;
    const to = this.squareAt(e);
    if (to !== null && to !== from) { if (await this.tryMove(from, to)) return; }
    this.invalidate();
  }

  private async tryMove(from: number, to: number): Promise<boolean> {
    const f = sqName(from), t = sqName(to);
    const cands = this.legal.filter((m) => m.startsWith(f + t));
    if (!cands.length) return false;
    let uci = cands[0]!;
    if (cands.length > 1) {
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

  async reloadLegal(): Promise<void> { this.legal = []; await this.refreshLegal(); this.invalidate(); }
  clearSelection(): void { this.selected = null; this.legal = []; this.invalidate(); }
}

/** "#rgb/#rrggbb/#rrggbbaa/rgb()/rgba()" → rgba() con alpha moltiplicato per `a`. */
export function withAlpha(c: string, a: number): string {
  let r = 0, g = 0, b = 0, al = 1;
  if (c.startsWith("#")) {
    let h = c.slice(1); if (h.length <= 4) h = [...h].map((x) => x + x).join("");
    r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16); if (h.length === 8) al = parseInt(h.slice(6, 8), 16) / 255;
  } else {
    const m = c.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0]; [r = 0, g = 0, b = 0] = m; if (m.length > 3) al = m[3]!;
  }
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, al * a))})`;
}
