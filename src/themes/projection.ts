// Proiezione prospettica del piano della scacchiera (cornice inclusa) su un canvas quadrato.
// Coordinate del piano: X,Y in [-1,1]; Y=+1 è il bordo vicino all'osservatore. Con tilt=0 la proiezione è identità (vista dall'alto).
export class Projection {
  readonly sinT: number; readonly cosT: number; readonly D: number; readonly k: number; readonly cx: number; readonly oy: number;
  constructor(readonly S: number, readonly tiltDeg: number, camera: number) {
    const t = (tiltDeg * Math.PI) / 180;
    this.sinT = Math.sin(t); this.cosT = Math.cos(t); this.D = camera * 2;
    this.k = (S * 0.5 * 0.96) / this.scale(1);
    this.cx = S / 2;
    // piano centrato in verticale, un po' più in alto: sopra resta lo spazio per i pezzi che escono dal piano
    const planeH = this.k * this.cosT * (this.scale(-1) + this.scale(1));
    this.oy = Math.max(0, S - planeH) * 0.42 + this.k * this.cosT * this.scale(-1);
  }
  get flat(): boolean { return this.tiltDeg < 0.01; }
  scale(Y: number): number { return this.D / (this.D - Y * this.sinT); }
  fwd(X: number, Y: number): [number, number, number] { const s = this.scale(Y); return [this.cx + this.k * X * s, this.oy + this.k * Y * this.cosT * s, s]; }
  inv(x: number, y: number): [number, number] {
    const ys = (y - this.oy) / this.k;
    const Y = (ys * this.D) / (this.D * this.cosT + ys * this.sinT);
    return [(x - this.cx) / (this.k * this.scale(Y)), Y];
  }
}
