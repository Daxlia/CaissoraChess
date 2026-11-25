// Tipi del manifest `.cctheme` v1. Rispecchiano crates/core/src/theme.rs, che valida i file importati;
// i temi incorporati sono verificati dagli stessi controlli (test Rust su src/themes/builtin).
export type Blend = "normal" | "multiply" | "overlay" | "soft-light";
export interface Stop { at: number; color: string }
export interface Gradient { kind: "linear" | "radial"; angle?: number; stops: Stop[] }
export interface Paint { color?: string; gradient?: Gradient; texture?: string; textureOpacity?: number; textureBlend?: Blend }
export interface Glow { color: string; radius: number; pulseSeconds?: number }
export interface Frame { width: number; paint?: Paint; glow?: Glow; bevel?: number }
export interface Squares { light: Paint; dark: Paint; gloss?: number; bevel?: number; grid?: { color: string; width: number; glow?: number }; randomCrop?: boolean }
export interface Highlights { style?: "fill" | "ring" | "glow"; lastMove?: string; selected?: string; legal?: string; check?: string; hint?: string }
export type Ambient =
  | { type: "sweep"; color: string; periodSeconds?: number; opacity?: number; width?: number }
  | { type: "particles"; color: string; count: number; size?: number; speed?: number; direction?: "up" | "down" | "drift"; glow?: number }
  | { type: "vignette"; color: string; strength?: number };
export interface BoardSpec {
  view?: { tilt?: number; camera?: number };
  lighting?: { exposure?: number; environment?: number; key?: string; fill?: string };
  scene?: Paint; frame?: Frame; squares: Squares; highlights?: Highlights;
  coordinates?: { visible?: boolean; color?: string; placement?: "inside" | "frame" };
  ambient?: Ambient[];
}
export interface Motion { style: "slide" | "arc" | "hop"; durationMs?: number; easing?: "linear" | "ease-out" | "ease-in-out" | "spring"; lift?: number; squash?: number; trail?: { color: string; length?: number; width?: number }; impact?: { color: string; size?: number } }
export interface PieceMaterial { color: string; metalness?: number; roughness?: number; clearcoat?: number; transmission?: number; ior?: number; emissive?: string; emissiveIntensity?: number; opacity?: number }
export interface PieceModel { style?: "staunton"; white: PieceMaterial; black: PieceMaterial; scale?: number }
export interface PieceSpec {
  source?: string; model?: PieceModel; resolutions?: string[]; baseSize?: number; scale?: number; anchor?: { x: number; y: number }; offsetY?: number;
  frames?: { count: number; fps: number };
  shadow?: { color: string; opacity: number; blur?: number; scale?: number };
  idle?: { style: "float" | "breathe" | "glow" | "frames"; amplitude?: number; periodSeconds?: number; color?: string };
  motion?: Motion; capture?: { effect: "fade" | "burst" | "shatter" | "dissolve"; color?: string; particles?: number; durationMs?: number };
}
export interface Manifest {
  format: 1; id: string; name: string; version: string; author: string; license: string; description?: string; sourceUrl?: string;
  board?: BoardSpec; pieces?: PieceSpec;
}
export const PIECE_IDS = ["wP", "wN", "wB", "wR", "wQ", "wK", "bP", "bN", "bB", "bR", "bQ", "bK"] as const;
