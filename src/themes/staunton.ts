// Pezzi 3D procedurali in stile Staunton: solidi di rotazione (tornio) con profili spline, merli, croce, corona e cavallo estruso.
// Le geometrie sono condivise tra tutti i pezzi dello stesso tipo; l'altezza segue le proporzioni reali (re ≈ 1,75 caselle).
import * as THREE from "three";

export type PType = "p" | "n" | "b" | "r" | "q" | "k";
type Pt = [number, number];

function lathe(points: Pt[], divisions = 6, seg = 64): THREE.BufferGeometry {
  const curve = new THREE.SplineCurve(points.map(([r, y]) => new THREE.Vector2(r, y)));
  const pts = curve.getPoints(points.length * divisions).map((p) => new THREE.Vector2(Math.max(0, p.x), p.y));
  const g = new THREE.LatheGeometry(pts, seg);
  g.computeVertexNormals();
  return g;
}
const sphere = (r: number, y: number, sy = 1, x = 0): THREE.BufferGeometry => { const g = new THREE.SphereGeometry(r, 40, 28); g.scale(1, sy, 1); g.translate(x, y, 0); return g; };
const box = (w: number, h: number, d: number, x: number, y: number, z: number, ry = 0): THREE.BufferGeometry => { const g = new THREE.BoxGeometry(w, h, d); if (ry) g.rotateY(ry); g.translate(x, y, z); return g; };

/** Base comune a tutti i pezzi: zoccolo con modanatura. */
const BASE: Pt[] = [[0, 0], [0.36, 0], [0.385, 0.025], [0.38, 0.07], [0.31, 0.11], [0.25, 0.14], [0.22, 0.17]];


const cache = new Map<PType, THREE.BufferGeometry[]>();

function knightHead(): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(-0.27, 0.14);
  s.splineThru([
    new THREE.Vector2(-0.25, 0.4), new THREE.Vector2(-0.21, 0.68), new THREE.Vector2(-0.13, 0.96), new THREE.Vector2(-0.03, 1.17),
    new THREE.Vector2(0.04, 1.27), new THREE.Vector2(0.1, 1.2), new THREE.Vector2(0.2, 1.12), new THREE.Vector2(0.36, 0.92),
    new THREE.Vector2(0.47, 0.73), new THREE.Vector2(0.45, 0.62), new THREE.Vector2(0.35, 0.6), new THREE.Vector2(0.22, 0.68),
    new THREE.Vector2(0.14, 0.62), new THREE.Vector2(0.18, 0.46), new THREE.Vector2(0.27, 0.3), new THREE.Vector2(0.3, 0.14),
  ]);
  s.lineTo(-0.27, 0.14);
  const depth = 0.34;
  const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelSize: 0.05, bevelThickness: 0.06, bevelSegments: 5, curveSegments: 28 });
  g.translate(0, 0, -depth / 2);
  g.computeVertexNormals();
  return g;
}

/** Geometrie (una per parte) del pezzo. Tutte condividono il materiale del pezzo; `eye` è il materiale scuro degli occhi/feritoia. */
export function pieceParts(type: PType): THREE.BufferGeometry[] {
  const hit = cache.get(type); if (hit) return hit;
  let parts: THREE.BufferGeometry[];
  switch (type) {
    case "p":
      parts = [lathe(BASE), lathe([[0.22, 0.12], [0.17, 0.26], [0.125, 0.45], [0.115, 0.55]]), lathe([[0.11, 0.5], [0.2, 0.55], [0.215, 0.6], [0.17, 0.64], [0.1, 0.66]]), sphere(0.175, 0.76)];
      break;
    case "r":
      parts = [lathe(BASE), lathe([[0.22, 0.12], [0.2, 0.24], [0.175, 0.5], [0.17, 0.68]]),
        lathe([[0.17, 0.64], [0.26, 0.72], [0.285, 0.8], [0.285, 0.9], [0.0, 0.9]], 5),
        ...Array.from({ length: 6 }, (_, i) => { const a = (i / 6) * Math.PI * 2; return box(0.15, 0.17, 0.13, Math.sin(a) * 0.235, 0.985, Math.cos(a) * 0.235, a); })];
      break;
    case "b":
      parts = [lathe(BASE), lathe([[0.22, 0.12], [0.18, 0.3], [0.125, 0.62], [0.105, 0.78]]), lathe([[0.1, 0.72], [0.2, 0.78], [0.215, 0.83], [0.13, 0.88], [0.1, 0.9]]),
        sphere(0.165, 1.04, 1.45), sphere(0.06, 1.37)];
      break;
    case "q":
      parts = [lathe(BASE), lathe([[0.22, 0.12], [0.2, 0.32], [0.14, 0.82], [0.115, 0.98]]), lathe([[0.11, 0.92], [0.25, 0.99], [0.265, 1.05], [0.13, 1.12]]),
        lathe([[0.12, 1.08], [0.24, 1.22], [0.285, 1.34], [0.25, 1.38], [0.0, 1.38]], 5),
        ...Array.from({ length: 9 }, (_, i) => { const a = (i / 9) * Math.PI * 2; return sphere(0.052, 1.4, 1, 0).translate(Math.sin(a) * 0.255, 0, Math.cos(a) * 0.255); }), sphere(0.075, 1.5)];
      break;
    case "k":
      parts = [lathe(BASE), lathe([[0.22, 0.12], [0.2, 0.34], [0.145, 0.9], [0.12, 1.06]]), lathe([[0.115, 1.0], [0.26, 1.07], [0.275, 1.13], [0.135, 1.2]]),
        lathe([[0.125, 1.16], [0.25, 1.3], [0.265, 1.44], [0.12, 1.5], [0.0, 1.5]], 5),
        box(0.095, 0.34, 0.095, 0, 1.68, 0), box(0.26, 0.095, 0.095, 0, 1.72, 0)];
      break;
    case "n":
    default:
      parts = [lathe(BASE), lathe([[0.22, 0.12], [0.19, 0.2], [0.19, 0.24]], 4), knightHead()];
  }
  cache.set(type, parts);
  return parts;
}

/** Occhi e feritoie: piccole parti scure applicate sopra alcuni pezzi. */
export function detailParts(type: PType): THREE.BufferGeometry[] {
  if (type === "n") return [sphere(0.036, 0.97, 1, 0.16).translate(0, 0, 0.19), sphere(0.036, 0.97, 1, 0.16).translate(0, 0, -0.19)];
  if (type === "b") { const g = new THREE.BoxGeometry(0.035, 0.2, 0.42); g.rotateZ(-0.7); g.translate(0.02, 1.07, 0); return [g]; }
  return [];
}

export const PIECE_HEIGHT: Record<PType, number> = { p: 0.95, n: 1.35, b: 1.45, r: 1.07, q: 1.58, k: 1.82 };
