// Scena 3D vera (three.js): camera prospettica, luci con ombre, ambiente riflettente, scacchiera e pezzi Staunton con materiali fisici.
// Un solo WebGLRenderer condiviso da tutte le scacchiere (le anteprime della galleria sono molte e i contesti WebGL sono limitati):
// ogni scena viene disegnata in un'area del canvas condiviso e copiata nel canvas 2D della propria scacchiera.
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import type { Piece, Squares } from "../board/fen";
import { frameWidth, paintFlat, paintScene } from "./paint";
import { PieceSet, pieceId } from "./pieceSprites";
import { detailParts, pieceParts, type PType } from "./staunton";
import type { LoadedTheme } from "./registry";
import type { Ambient, BoardSpec, Motion, PieceMaterial, PieceSpec } from "./types";

export interface AnimView { from: number; to: number; piece: Piece; start: number; dur: number; m: Motion }
export interface Frame3D {
  squares: Squares; selected: number | null; legal: string[]; lastMove: [number, number] | null; checkSq: number | null; hint: [number, number] | null;
  drag: { from: number; x: number; y: number } | null; flipped: boolean; anim: AnimView | null; hideAt: number | null;
}
export type Quality = "low" | "auto" | "high";

const EASE: Record<string, (k: number) => number> = {
  linear: (k) => k, "ease-out": (k) => 1 - (1 - k) ** 3,
  "ease-in-out": (k) => (k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2),
  spring: (k) => (k >= 1 ? 1 : 1 - Math.exp(-6 * k) * Math.cos(k * Math.PI * 3)),
};
const HL = { lastMove: "rgba(246,226,90,0.5)", selected: "rgba(80,160,255,0.5)", legal: "rgba(20,20,20,0.45)", check: "rgba(235,60,60,0.7)", hint: "#2fbf71" };

// ---------------------------------------------------------------- renderer condiviso

let shared: THREE.WebGLRenderer | null = null;
let sharedEnv: THREE.Texture | null = null;
let unsupported = false;

export function webglSupported(): boolean {
  if (unsupported) return false;
  try { return !!getRenderer(); } catch { unsupported = true; return false; }
}
function getRenderer(): THREE.WebGLRenderer {
  if (shared) return shared;
  const canvas = document.createElement("canvas");
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  r.setPixelRatio(1); r.outputColorSpace = THREE.SRGBColorSpace; r.toneMapping = THREE.ACESFilmicToneMapping;
  r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFShadowMap; r.setScissorTest(true);
  const pm = new THREE.PMREMGenerator(r);
  sharedEnv = pm.fromScene(new RoomEnvironment(), 0.04).texture; pm.dispose();
  shared = r; return r;
}

function parseCss(c: string): { color: THREE.Color; alpha: number } {
  let r = 0, g = 0, b = 0, a = 1;
  if (c.startsWith("#")) {
    let h = c.slice(1); if (h.length <= 4) h = [...h].map((x) => x + x).join("");
    r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16); if (h.length === 8) a = parseInt(h.slice(6, 8), 16) / 255;
  } else { const m = c.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0]; [r = 0, g = 0, b = 0] = m; if (m.length > 3) a = m[3]!; }
  return { color: new THREE.Color().setRGB(r / 255, g / 255, b / 255, THREE.SRGBColorSpace), alpha: a };
}

function glowTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas"); c.width = c.height = 64; const g = c.getContext("2d")!;
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, "rgba(255,255,255,1)"); gr.addColorStop(0.3, "rgba(255,255,255,0.8)"); gr.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64); const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// ---------------------------------------------------------------- scena

interface Node { id: string; root: THREE.Group; inner: THREE.Group; sprite: boolean }
interface Fx { start: number; dur: number; update(k: number): void; dispose(): void }

export class Scene3D {
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(30, 1, 0.1, 80);
  private spec: BoardSpec;
  private pieceSpec: PieceSpec | null = null;
  private pieceMats: { w: THREE.MeshPhysicalMaterial; b: THREE.MeshPhysicalMaterial; dark: THREE.MeshStandardMaterial } | null = null;
  private sprites: PieceSet | null = null;
  private nodes = new Map<number, Node>();
  private animNode: { key: string; node: Node } | null = null;
  private fxList: Fx[] = [];
  private px = 0; private py = 0;
  private fw: number; private tiltDeg: number;
  private key: THREE.DirectionalLight; private sweepLight: THREE.DirectionalLight | null = null;
  private frameMats: THREE.MeshStandardMaterial[] = [];
  private boardTex!: THREE.CanvasTexture; private bgTex: THREE.CanvasTexture;
  private hl: THREE.Group = new THREE.Group();
  private hlPool: THREE.Mesh[] = []; private dotPool: THREE.Mesh[] = [];
  private arrow: THREE.Mesh | null = null; private arrowKey = "";
  private points: { pts: THREE.Points; vel: Float32Array; dir: string; speed: number }[] = [];
  private glow = glowTexture();
  private azimuth = 0; private azTarget = 0; private azStart = 0; private azT0 = 0;
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private ray = new THREE.Raycaster();
  private disposables: { dispose(): void }[] = [];

  constructor(private boardTh: LoadedTheme, private size: number, dpr: number, private quality: Quality) {
    this.spec = boardTh.manifest.board!;
    this.fw = frameWidth(this.spec);
    this.tiltDeg = (this.spec.view?.tilt ?? 0) > 0 ? this.spec.view!.tilt! : 36;
    const lt = this.spec.lighting ?? {};
    this.scene.environment = sharedEnv ?? null; this.scene.environmentIntensity = lt.environment ?? 0.7;
    // sfondo
    const bgc = document.createElement("canvas"); bgc.width = bgc.height = 512; paintScene(bgc.getContext("2d")!, 512, boardTh, this.spec);
    this.bgTex = new THREE.CanvasTexture(bgc); this.bgTex.colorSpace = THREE.SRGBColorSpace; this.scene.background = this.bgTex;
    // luci
    this.scene.add(new THREE.HemisphereLight(parseCss(lt.fill ?? "#dfe8ff").color, new THREE.Color(0x20160e), 0.55));
    this.key = new THREE.DirectionalLight(parseCss(lt.key ?? "#fff3e0").color, 2.4);
    this.key.position.set(-4.5, 9, 5.5);
    const hi = this.quality === "low" ? 0 : this.quality === "high" ? 2048 : 1024;
    this.key.castShadow = hi > 0;
    if (hi) { this.key.shadow.mapSize.set(hi, hi); const sc = this.key.shadow.camera; sc.left = -6.5; sc.right = 6.5; sc.top = 6.5; sc.bottom = -6.5; sc.near = 1; sc.far = 30; this.key.shadow.bias = -0.0004; this.key.shadow.normalBias = 0.03; this.key.shadow.radius = 3; }
    this.scene.add(this.key);
    if ((this.spec.ambient ?? []).some((a) => a.type === "sweep")) { this.sweepLight = new THREE.DirectionalLight(0xffffff, 0); this.scene.add(this.sweepLight); }
    this.buildBoard();
    this.buildAmbient();
    this.scene.add(this.hl);
    this.resize(size, dpr);
  }

  // ---------------------------------------------------------------- costruzione

  private buildBoard(): void {
    const b = this.spec, fw = this.fw, W = 8 + 2 * fw;
    const F = this.quality === "high" ? 4096 : this.quality === "low" ? 1024 : 2048;
    const flat = document.createElement("canvas"); flat.width = flat.height = F;
    paintFlat(flat.getContext("2d")!, F, this.boardTh, b, false);
    this.boardTex = new THREE.CanvasTexture(flat); this.boardTex.colorSpace = THREE.SRGBColorSpace;
    this.boardTex.anisotropy = getRenderer().capabilities.getMaxAnisotropy(); this.boardTex.generateMipmaps = true; this.boardTex.minFilter = THREE.LinearMipmapLinearFilter;
    const gloss = b.squares.gloss ?? 0;
    const top = new THREE.MeshPhysicalMaterial({ map: this.boardTex, roughness: 0.55 - 0.4 * gloss, metalness: 0, clearcoat: gloss, clearcoatRoughness: 0.25, envMapIntensity: 0.6 + gloss });
    const fp = b.frame?.paint;
    const sideMat = new THREE.MeshStandardMaterial({ color: parseCss(fp?.color ?? "#3a2c20").color, roughness: 0.5, metalness: 0.1 });
    const ftex = fp?.texture ? this.boardTh.images.get(fp.texture) : undefined;
    if (ftex) { const t = new THREE.Texture(ftex); t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; t.needsUpdate = true; sideMat.map = t; sideMat.color.set(0xffffff); this.disposables.push(t); }
    const gl = b.frame?.glow;
    if (gl) { sideMat.emissive = parseCss(gl.color).color; sideMat.emissiveIntensity = 0.5; }
    this.frameMats.push(sideMat);
    const H = 0.34;
    const slab = new THREE.Mesh(new THREE.BoxGeometry(W, H, W), [sideMat, sideMat, top, sideMat, sideMat, sideMat]);
    slab.position.y = -H / 2; slab.receiveShadow = true; slab.castShadow = true; this.scene.add(slab);
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(W + 0.35, 0.14, W + 0.35), sideMat); plinth.position.y = -H - 0.07; plinth.receiveShadow = true; plinth.castShadow = true; this.scene.add(plinth);
    // piano d'appoggio (riceve le ombre) col colore di bordo della scena
    const stops = b.scene?.gradient?.stops; const tc = b.scene?.color ?? stops?.[stops.length - 1]?.color ?? "#161616";
    const table = new THREE.Mesh(new THREE.CircleGeometry(16, 64), new THREE.MeshStandardMaterial({ color: parseCss(tc).color, roughness: 0.85, metalness: 0 }));
    table.rotation.x = -Math.PI / 2; table.position.y = -H - 0.15; table.receiveShadow = true; this.scene.add(table);
    this.disposables.push(top, sideMat, slab.geometry, plinth.geometry, table.geometry, table.material as THREE.Material, this.boardTex, this.bgTex);
  }

  private buildAmbient(): void {
    const amb = this.spec.ambient ?? [];
    for (const a of amb) if (a.type === "particles") {
      const n = this.quality === "low" ? 0 : a.count;
      const pos = new Float32Array(n * 3), vel = new Float32Array(n);
      for (let i = 0; i < n; i++) { pos[i * 3] = (Math.random() - 0.5) * 11; pos[i * 3 + 1] = Math.random() * 5; pos[i * 3 + 2] = (Math.random() - 0.5) * 11; vel[i] = 0.6 + Math.random() * 0.8; }
      const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      const m = new THREE.PointsMaterial({ color: parseCss(a.color).color, size: Math.max(0.06, (a.size ?? 0.02) * 14), map: this.glow, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.85 });
      const pts = new THREE.Points(geo, m); pts.frustumCulled = false; this.scene.add(pts);
      this.points.push({ pts, vel, dir: a.direction ?? "down", speed: a.speed ?? 0.05 });
      this.disposables.push(geo, m);
    }
  }

  // ---------------------------------------------------------------- pezzi

  setPieces(th: LoadedTheme | null, sprites: PieceSet | null): void {
    for (const n of this.nodes.values()) this.scene.remove(n.root);
    this.nodes.clear(); if (this.animNode) { this.scene.remove(this.animNode.node.root); this.animNode = null; }
    this.pieceSpec = th?.manifest.pieces ?? null; this.sprites = sprites;
    const model = this.pieceSpec?.model;
    if (model) {
      const mk = (m: PieceMaterial) => new THREE.MeshPhysicalMaterial({
        color: parseCss(m.color).color, metalness: m.metalness ?? 0, roughness: m.roughness ?? 0.4, clearcoat: m.clearcoat ?? 0, clearcoatRoughness: 0.15,
        transmission: this.quality === "low" ? 0 : m.transmission ?? 0, ior: m.ior ?? 1.5, thickness: 0.6, attenuationColor: parseCss(m.color).color, attenuationDistance: 1.2,
        emissive: m.emissive ? parseCss(m.emissive).color : new THREE.Color(0), emissiveIntensity: m.emissiveIntensity ?? 0,
        transparent: (m.opacity ?? 1) < 1, opacity: m.opacity ?? 1, envMapIntensity: 1.1,
      });
      this.pieceMats = { w: mk(model.white), b: mk(model.black), dark: new THREE.MeshStandardMaterial({ color: 0x0c0c0e, roughness: 0.4 }) };
    } else this.pieceMats = null;
  }
  get busy(): boolean { return this.fxList.length > 0; }
  get hasModel(): boolean { return !!this.pieceSpec?.model; }

  private makeNode(p: Piece): Node {
    const root = new THREE.Group(), inner = new THREE.Group(); root.add(inner);
    const id = pieceId(p), spec = this.pieceSpec;
    if (spec?.model && this.pieceMats) {
      const mat = p.color === "w" ? this.pieceMats.w : this.pieceMats.b, sc = spec.model.scale ?? 1;
      const type = p.type as PType;
      for (const g of pieceParts(type)) { const m = new THREE.Mesh(g, mat); m.castShadow = true; m.receiveShadow = true; inner.add(m); }
      for (const g of detailParts(type)) { const m = new THREE.Mesh(g, this.pieceMats.dark); m.castShadow = false; inner.add(m); }
      inner.scale.setScalar(sc);
      if (type === "n") inner.rotation.y = p.color === "w" ? Math.PI / 2 - 0.75 : -Math.PI / 2 - 0.75; // girati di tre quarti: si legge il profilo del cavallo
      return { id, root, inner, sprite: false };
    }
    if (spec && this.sprites) {
      const sp = this.sprites.sprite(id, 256);
      const tex = new THREE.CanvasTexture(sp.canvas); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true });
      const s = new THREE.Sprite(mat), w = spec.scale ?? 1, h = (w * sp.frameH) / sp.frameW, anc = spec.anchor ?? { x: 0.5, y: 0.5 };
      s.scale.set(w * 1.05, h * 1.05, 1); s.center.set(anc.x, 1 - anc.y); s.position.y = (1 - anc.y) * h * 1.05 + (spec.offsetY ?? 0) * -1;
      inner.add(s);
      const blob = new THREE.Mesh(new THREE.CircleGeometry(0.34, 24), new THREE.MeshBasicMaterial({ map: this.glow, color: 0x000000, transparent: true, opacity: 0.45, depthWrite: false }));
      blob.rotation.x = -Math.PI / 2; blob.position.y = 0.01; root.add(blob);
      return { id, root, inner, sprite: true };
    }
    return { id, root, inner, sprite: false };
  }

  private sqPos(i: number): [number, number] { return [(i % 8) - 3.5, (i >> 3) - 3.5]; }

  private syncPieces(f: Frame3D): void {
    for (let i = 0; i < 64; i++) {
      const p = f.squares[i], cur = this.nodes.get(i);
      const want = p && i !== f.hideAt ? pieceId(p) : null;
      if (cur && cur.id !== want) { this.scene.remove(cur.root); this.nodes.delete(i); }
      if (want && (!this.nodes.get(i))) {
        const n = this.makeNode(p!); const [x, z] = this.sqPos(i); n.root.position.set(x, 0, z); this.scene.add(n.root); this.nodes.set(i, n);
      }
    }
  }

  // ---------------------------------------------------------------- camera

  private fitCamera(): void {
    const fw = this.fw, W = 8 + 2 * fw, el = ((90 - this.tiltDeg) * Math.PI) / 180;
    const cam = this.camera; cam.aspect = 1; cam.clearViewOffset();
    const target = new THREE.Vector3(0, 0.2, 0);
    const dirOf = (az: number) => new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el));
    const corners: THREE.Vector3[] = [];
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) for (const y of [-0.45, 1.55]) corners.push(new THREE.Vector3((sx * (W + 0.3)) / 2, y, (sz * (W + 0.3)) / 2));
    let dist = 16; const fit = (az: number) => {
      for (let it = 0; it < 6; it++) {
        cam.position.copy(target).addScaledVector(dirOf(az), dist); cam.lookAt(target); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
        let m = 0; for (const c of corners) { const v = c.clone().project(cam); m = Math.max(m, Math.abs(v.x), Math.abs(v.y)); }
        dist *= m / 0.97;
      }
    };
    fit(0); this.dist = dist; this.target = target; this.dirOf = dirOf;
    // il bordo basso/alto non è simmetrico: si ricentra la vista senza cambiare la distanza
    cam.position.copy(target).addScaledVector(dirOf(0), dist); cam.lookAt(target); cam.updateMatrixWorld();
    let minY = 9, maxY = -9; for (const c of corners) { const v = c.clone().project(cam); minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y); }
    this.yShift = -(minY + maxY) / 2;
  }
  private dist = 14; private target = new THREE.Vector3(); private yShift = 0;
  private dirOf: (az: number) => THREE.Vector3 = () => new THREE.Vector3(0, 1, 1);

  private placeCamera(): void {
    const cam = this.camera; cam.position.copy(this.target).addScaledVector(this.dirOf(this.azimuth), this.dist); cam.lookAt(this.target);
    cam.updateMatrixWorld();
    // sposta l'immagine in verticale (ricentra) con un offset di vista invece di muovere la camera
    cam.setViewOffset(1000, 1000, 0, this.yShift * 500, 1000, 1000); cam.updateProjectionMatrix();
  }

  resize(size: number, dpr: number): void { this.size = size; this.px = Math.max(2, Math.round(size * dpr)); this.py = this.px; this.fitCamera(); }

  // ---------------------------------------------------------------- evidenziazioni

  private hlMesh(i: number): THREE.Mesh {
    let m = this.hlPool[i];
    if (!m) { m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 })); m.rotation.x = -Math.PI / 2; m.position.y = 0.006; this.hl.add(m); this.hlPool[i] = m; }
    return m;
  }
  private dotMesh(i: number): THREE.Mesh {
    let m = this.dotPool[i];
    if (!m) { m = new THREE.Mesh(new THREE.CircleGeometry(0.17, 28), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false })); m.rotation.x = -Math.PI / 2; m.position.y = 0.01; this.hl.add(m); this.dotPool[i] = m; }
    return m;
  }

  private updateHighlights(f: Frame3D): void {
    const h = this.spec.highlights ?? {}, style = h.style ?? "fill";
    const items: [number, string][] = [];
    if (f.lastMove) { items.push([f.lastMove[0], h.lastMove ?? HL.lastMove], [f.lastMove[1], h.lastMove ?? HL.lastMove]); }
    if (f.checkSq !== null) items.push([f.checkSq, h.check ?? HL.check]);
    if (f.selected !== null) items.push([f.selected, h.selected ?? HL.selected]);
    this.hlPool.forEach((m) => (m.visible = false)); this.dotPool.forEach((m) => (m.visible = false));
    items.forEach(([sq, css], k) => {
      const m = this.hlMesh(k), { color, alpha } = parseCss(css), [x, z] = this.sqPos(sq);
      const mat = m.material as THREE.MeshBasicMaterial; mat.color.copy(color); mat.opacity = style === "fill" ? alpha : Math.min(1, alpha * 0.8);
      mat.blending = style === "glow" ? THREE.AdditiveBlending : THREE.NormalBlending; m.position.x = x; m.position.z = z; m.scale.set(0.98, 0.98, 1); m.visible = true;
    });
    if (f.selected !== null) {
      const from = String.fromCharCode(97 + (f.selected % 8)) + (8 - (f.selected >> 3)); let k = 0;
      const { color, alpha } = parseCss(h.legal ?? HL.legal);
      for (const mv of f.legal) {
        if (!mv.startsWith(from)) continue;
        const to = (8 - Number(mv[3])) * 8 + (mv.charCodeAt(2) - 97), m = this.dotMesh(k++), [x, z] = this.sqPos(to), cap = !!f.squares[to];
        const mat = m.material as THREE.MeshBasicMaterial; mat.color.copy(color); mat.opacity = Math.min(1, alpha + 0.2);
        m.position.set(x, 0.01, z); m.scale.setScalar(cap ? 2.2 : 1); m.visible = true;
        if (cap) mat.opacity = Math.min(1, alpha * 0.55);
      }
    }
    // freccia suggerimento
    const key = f.hint ? `${f.hint[0]}-${f.hint[1]}` : "";
    if (key !== this.arrowKey) {
      this.arrowKey = key; if (this.arrow) { this.hl.remove(this.arrow); this.arrow.geometry.dispose(); this.arrow = null; }
      if (f.hint) {
        const [x1, z1] = this.sqPos(f.hint[0]), [x2, z2] = this.sqPos(f.hint[1]), len = Math.hypot(x2 - x1, z2 - z1) - 0.2, hw = 0.07, hl2 = 0.3;
        const s = new THREE.Shape(); s.moveTo(0, -hw); s.lineTo(len - hl2, -hw); s.lineTo(len - hl2, -0.2); s.lineTo(len, 0); s.lineTo(len - hl2, 0.2); s.lineTo(len - hl2, hw); s.lineTo(0, hw); s.closePath();
        const m = new THREE.Mesh(new THREE.ShapeGeometry(s), new THREE.MeshBasicMaterial({ color: parseCss(this.spec.highlights?.hint ?? HL.hint).color, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }));
        m.rotation.x = -Math.PI / 2; m.rotation.z = Math.atan2(z2 - z1, x2 - x1) * -1; m.position.set(x1, 0.02, z1); this.arrow = m; this.hl.add(m);
      }
    }
  }

  // ---------------------------------------------------------------- effetti

  impactFx(sq: number, color: string, size: number): void {
    const [x, z] = this.sqPos(sq);
    const m = new THREE.Mesh(new THREE.RingGeometry(0.85, 1, 48), new THREE.MeshBasicMaterial({ color: parseCss(color).color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide }));
    m.rotation.x = -Math.PI / 2; m.position.set(x, 0.02, z); this.scene.add(m);
    this.fxList.push({ start: performance.now(), dur: 450, update: (k) => { m.scale.setScalar(0.3 + size * 1.6 * k); (m.material as THREE.MeshBasicMaterial).opacity = 0.9 * (1 - k); }, dispose: () => { this.scene.remove(m); m.geometry.dispose(); (m.material as THREE.Material).dispose(); } });
  }

  captureFx(p: Piece, sq: number, effect: string, color: string, count: number, durMs: number, node?: Node): void {
    const [x, z] = this.sqPos(sq);
    const col = parseCss(color).color;
    const n = Math.min(count, this.quality === "high" ? 120 : 60);
    const parts: { m: THREE.Object3D; v: THREE.Vector3; r: THREE.Vector3 }[] = [];
    const holder = new THREE.Group(); holder.position.set(x, 0, z); this.scene.add(holder);
    const disposeList: { dispose(): void }[] = [];
    if (effect === "shatter" && this.pieceMats) {
      const mat = (p.color === "w" ? this.pieceMats.w : this.pieceMats.b).clone(); mat.transparent = true; disposeList.push(mat);
      const g = new THREE.BoxGeometry(0.13, 0.13, 0.13); disposeList.push(g);
      for (let i = 0; i < Math.min(28, n); i++) {
        const m = new THREE.Mesh(g, mat); m.position.set((Math.random() - 0.5) * 0.3, 0.1 + Math.random() * 0.9, (Math.random() - 0.5) * 0.3); m.castShadow = true; holder.add(m);
        parts.push({ m, v: new THREE.Vector3((Math.random() - 0.5) * 2.2, 1.5 + Math.random() * 2, (Math.random() - 0.5) * 2.2), r: new THREE.Vector3(Math.random() * 8, Math.random() * 8, Math.random() * 8) });
      }
    } else if (effect === "burst" || effect === "dissolve") {
      const mat = new THREE.SpriteMaterial({ map: this.glow, color: col, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }); disposeList.push(mat);
      for (let i = 0; i < n; i++) {
        const s = new THREE.Sprite(mat.clone()); disposeList.push(s.material); s.scale.setScalar(0.12 + Math.random() * 0.14); s.position.set(0, 0.6, 0); holder.add(s);
        const a = Math.random() * Math.PI * 2, up = effect === "burst" ? 1 + Math.random() * 2.5 : 1 + Math.random() * 1.5, sp = effect === "burst" ? 1 + Math.random() * 2.5 : 0.3 + Math.random() * 0.6;
        parts.push({ m: s, v: new THREE.Vector3(Math.cos(a) * sp, up, Math.sin(a) * sp), r: new THREE.Vector3() });
      }
    }
    const fade = node && effect !== "shatter" ? node : null; // il pezzo originale svanisce (fade/burst/dissolve)
    if (fade) { this.scene.add(fade.root); const [px, pz] = this.sqPos(sq); fade.root.position.set(px, 0, pz); }
    const mats: THREE.Material[] = []; fade?.root.traverse((o) => { const mm = (o as THREE.Mesh).material; if (mm) { const arr = Array.isArray(mm) ? mm : [mm]; for (const x of arr) { x.transparent = true; mats.push(x); } } });
    this.fxList.push({ start: performance.now(), dur: durMs, update: (k) => {
      const t = k * durMs / 1000;
      for (const q of parts) {
        q.m.position.x += q.v.x * 0.016; q.m.position.y += (q.v.y - 6 * t) * 0.016; q.m.position.z += q.v.z * 0.016;
        q.m.rotation.x += q.r.x * 0.016; q.m.rotation.y += q.r.y * 0.016;
        const mm = (q.m as THREE.Mesh | THREE.Sprite).material as THREE.Material; mm.opacity = Math.max(0, 1 - k * k);
      }
      if (fade) { for (const mm of mats) mm.opacity = Math.max(0, 1 - k * (effect === "fade" ? 1 : 3)); if (effect === "dissolve") fade.root.position.y = k * 0.6; }
    }, dispose: () => { this.scene.remove(holder); if (fade) this.scene.remove(fade.root); disposeList.forEach((d) => d.dispose()); } });
  }
  /** Rimuove dalla scena il nodo del pezzo in `sq` e lo restituisce (per farlo svanire). */
  detach(sq: number): Node | undefined { const n = this.nodes.get(sq); if (n) { this.scene.remove(n.root); this.nodes.delete(sq); } return n; }

  // ---------------------------------------------------------------- disegno

  render(target: CanvasRenderingContext2D, f: Frame3D, now: number, live: boolean): void {
    const r = getRenderer(), sec = now / 1000;
    this.syncPieces(f);
    // camera: rotazione animata quando si ribalta la scacchiera
    const want = f.flipped ? Math.PI : 0;
    if (want !== this.azTarget) { this.azTarget = want; this.azStart = this.azimuth; this.azT0 = now; }
    if (this.azimuth !== this.azTarget) { const k = Math.min(1, (now - this.azT0) / 600); this.azimuth = this.azStart + (this.azTarget - this.azStart) * (1 - (1 - k) ** 3); }
    this.placeCamera();

    const spec = this.pieceSpec, idle = spec?.idle, amp = idle?.amplitude ?? 0.03;
    // idle
    for (const [i, n] of this.nodes) {
      n.inner.position.y = 0; n.inner.scale.setScalar(n.sprite ? 1 : (spec?.model?.scale ?? 1));
      if (live && idle) {
        const ph = (sec * Math.PI * 2) / (idle.periodSeconds ?? 3) + i * 0.9;
        if (idle.style === "float") n.inner.position.y = amp * (0.5 + 0.5 * Math.sin(ph));
        else if (idle.style === "breathe") n.inner.scale.multiplyScalar(1 + amp * Math.sin(ph));
      }
    }
    if (live && idle?.style === "glow" && this.pieceMats) { const e = 0.5 + 0.5 * Math.sin(sec * 2); for (const m of [this.pieceMats.w, this.pieceMats.b]) m.emissiveIntensity = (spec?.model?.white.emissiveIntensity ?? 0.3) * (0.7 + 0.5 * e); }
    // pezzo in movimento
    const a = f.anim;
    if (a) {
      const key = `${a.start}`;
      if (!this.animNode || this.animNode.key !== key) { if (this.animNode) this.scene.remove(this.animNode.node.root); const node = this.makeNode(a.piece); this.scene.add(node.root); this.animNode = { key, node }; }
      const node = this.animNode.node, k = Math.min(1, (now - a.start) / a.dur), e = (EASE[a.m.easing ?? "ease-out"] ?? EASE["ease-out"]!)(k);
      const [x0, z0] = this.sqPos(a.from), [x1, z1] = this.sqPos(a.to);
      node.root.position.set(x0 + (x1 - x0) * e, 0, z0 + (z1 - z0) * e);
      const lift = a.m.style === "slide" ? 0 : 4 * k * (1 - k) * (a.m.lift ?? 0.4) * (a.m.style === "hop" ? 1.4 : 1.2);
      const land = k > 0.85 && (a.m.squash ?? 0) > 0 ? (a.m.squash ?? 0) * Math.sin(((k - 0.85) / 0.15) * Math.PI) : 0;
      node.inner.position.y = lift; const sc = node.sprite ? 1 : (spec?.model?.scale ?? 1); node.inner.scale.set(sc * (1 + land * 0.5), sc * (1 - land), sc * (1 + land * 0.5));
      if (a.m.trail && live) this.trailPuff(node.root.position.x, lift + 0.4, node.root.position.z, a.m.trail.color);
    } else if (this.animNode) { this.scene.remove(this.animNode.node.root); this.animNode = null; }
    // pezzo trascinato
    if (f.drag) {
      const n = this.nodes.get(f.drag.from);
      if (n) { const p = this.ground(f.drag.x, f.drag.y, 0); if (p) { n.root.position.set(THREE.MathUtils.clamp(p.x, -4.2, 4.2), 0.5, THREE.MathUtils.clamp(p.z, -4.2, 4.2)); } }
    } else for (const [i, n] of this.nodes) { const [x, z] = this.sqPos(i); n.root.position.set(x, 0, z); }
    this.updateHighlights(f);
    // ambiente
    if (live) this.animateAmbient(now, sec); else this.points.forEach((p) => (p.pts.visible = false));
    // effetti
    this.fxList = this.fxList.filter((x) => { const k = (now - x.start) / x.dur; if (k >= 1) { x.dispose(); return false; } x.update(k); return true; });

    // disegno nell'area condivisa e copia
    const lt = this.spec.lighting ?? {};
    r.toneMappingExposure = lt.exposure ?? 1;
    if (r.domElement.width < this.px || r.domElement.height < this.py) r.setSize(Math.max(this.px, r.domElement.width), Math.max(this.py, r.domElement.height), false);
    r.setViewport(0, 0, this.px, this.py); r.setScissor(0, 0, this.px, this.py);
    r.shadowMap.enabled = this.quality !== "low";
    r.render(this.scene, this.camera);
    target.setTransform(1, 0, 0, 1, 0, 0);
    target.clearRect(0, 0, target.canvas.width, target.canvas.height);
    target.drawImage(r.domElement, 0, r.domElement.height - this.py, this.px, this.py, 0, 0, target.canvas.width, target.canvas.height);
  }

  private lastTrail = 0;
  private trailPuff(x: number, y: number, z: number, color: string): void {
    const now = performance.now(); if (now - this.lastTrail < 24) return; this.lastTrail = now;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, color: parseCss(color).color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    s.position.set(x, y, z); s.scale.setScalar(0.55); this.scene.add(s);
    this.fxList.push({ start: now, dur: 420, update: (k) => { s.scale.setScalar(0.55 * (1 - 0.7 * k)); (s.material as THREE.SpriteMaterial).opacity = 0.8 * (1 - k); }, dispose: () => { this.scene.remove(s); s.material.dispose(); } });
  }

  private animateAmbient(now: number, sec: number): void {
    const amb = this.spec.ambient ?? [];
    this.points.forEach((p) => {
      p.pts.visible = true;
      const a = p.pts.geometry.getAttribute("position") as THREE.BufferAttribute, dt = 0.016;
      for (let i = 0; i < a.count; i++) {
        let y = a.getY(i), x = a.getX(i);
        const v = p.speed * (p.vel[i] ?? 1) * 18 * dt;
        if (p.dir === "up") y += v; else if (p.dir === "down") y -= v; else { x += v * 0.6; y -= v * 0.5; }
        if (y > 5) y = 0; if (y < 0) y = 5; if (x > 5.5) x = -5.5;
        a.setXYZ(i, x + Math.sin(sec + i) * 0.002, y, a.getZ(i));
      }
      a.needsUpdate = true;
    });
    const sw = amb.find((x): x is Extract<Ambient, { type: "sweep" }> => x.type === "sweep");
    if (sw && this.sweepLight) {
      const per = (sw.periodSeconds ?? 7) * 1000, t = (now % per) / per;
      this.sweepLight.color.copy(parseCss(sw.color).color); this.sweepLight.position.set(-9 + 18 * t, 6, 2); this.sweepLight.intensity = (sw.opacity ?? 0.5) * 3 * Math.sin(Math.PI * t);
    }
    const gl = this.spec.frame?.glow;
    if (gl) { const pulse = gl.pulseSeconds ? 0.6 + 0.4 * Math.sin((sec * Math.PI * 2) / gl.pulseSeconds) : 1; for (const m of this.frameMats) m.emissiveIntensity = 0.9 * pulse; }
  }

  // ---------------------------------------------------------------- picking

  private ground(x: number, y: number, h: number): THREE.Vector3 | null {
    const ndc = new THREE.Vector2((x / this.size) * 2 - 1, -((y / this.size) * 2 - 1));
    this.ray.setFromCamera(ndc, this.camera);
    this.plane.constant = -h;
    const out = new THREE.Vector3();
    return this.ray.ray.intersectPlane(this.plane, out) ? out : null;
  }
  pick(x: number, y: number): number | null {
    this.placeCamera();
    const p = this.ground(x, y, 0); if (!p) return null;
    const c = Math.floor(p.x + 4), r = Math.floor(p.z + 4);
    return c < 0 || c > 7 || r < 0 || r > 7 ? null : r * 8 + c;
  }

  dispose(): void {
    for (const n of this.nodes.values()) this.scene.remove(n.root);
    for (const f of this.fxList) f.dispose();
    this.fxList = []; this.disposables.forEach((d) => d.dispose()); this.glow.dispose();
  }
}
