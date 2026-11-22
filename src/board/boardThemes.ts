// Temi di scacchiera incorporati. Il formato .cctheme (temi esterni) è una fase successiva.
export interface BoardTheme {
  id: string;
  light: string; dark: string;
  lastMove: string; selected: string; legal: string; check: string;
  coord: string; frame: string;
}

export const BOARD_THEMES: BoardTheme[] = [
  { id: "classic", light: "#ecd9b0", dark: "#a87c50", lastMove: "rgba(246,226,90,0.55)", selected: "rgba(80,160,255,0.5)", legal: "rgba(30,30,30,0.35)", check: "rgba(235,60,60,0.65)", coord: "rgba(40,30,20,0.75)", frame: "#3a2c20" },
  { id: "slate", light: "#cfd6de", dark: "#6c7f94", lastMove: "rgba(255,214,74,0.55)", selected: "rgba(40,120,255,0.5)", legal: "rgba(10,20,30,0.35)", check: "rgba(235,60,60,0.7)", coord: "rgba(20,30,45,0.8)", frame: "#232a33" },
  { id: "forest", light: "#e7ecd0", dark: "#6f9455", lastMove: "rgba(250,236,100,0.6)", selected: "rgba(40,110,230,0.5)", legal: "rgba(15,35,10,0.38)", check: "rgba(230,50,50,0.7)", coord: "rgba(25,45,20,0.8)", frame: "#26361f" },
  { id: "midnight", light: "#8b93b8", dark: "#3d4468", lastMove: "rgba(255,200,60,0.5)", selected: "rgba(90,200,255,0.55)", legal: "rgba(240,240,255,0.4)", check: "rgba(255,80,80,0.75)", coord: "rgba(235,238,255,0.8)", frame: "#14172b" },
];

export const themeById = (id: string | undefined): BoardTheme => BOARD_THEMES.find((t) => t.id === id) ?? BOARD_THEMES[0]!;
