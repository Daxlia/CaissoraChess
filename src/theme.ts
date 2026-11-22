// Tema dell'interfaccia: modalità chiaro/scuro/sistema e colore accent.
export type Mode = "system" | "light" | "dark";

const HEX = /^#[0-9a-fA-F]{6}$/;
export const isHexColor = (v: string): boolean => HEX.test(v);

/** Colore di testo (nero/bianco) con contrasto migliore sullo sfondo `hex`. */
export function readableOn(hex: string): "#000000" | "#ffffff" {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.4 ? "#000000" : "#ffffff";
}

export function applyMode(mode: Mode): void {
  const root = document.documentElement;
  if (mode === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", mode);
}

export function applyAccent(hex: string): void {
  if (!isHexColor(hex)) return;
  const root = document.documentElement.style;
  root.setProperty("--accent", hex);
  root.setProperty("--on-accent", readableOn(hex));
}

export function applyReducedMotion(on: boolean): void {
  document.documentElement.toggleAttribute("data-reduce-motion", on);
}
