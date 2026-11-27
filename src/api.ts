// Wrapper tipizzati dei comandi Tauri. Gli argomenti Rust snake_case diventano camelCase in JS.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface BoardAfter { fen: string; san: string; status: "ongoing" | "checkmate" | "stalemate" | "insufficient_material"; winner: "white" | "black" | null; check: boolean; check_square: string | null }
export interface EngineInfo { name: string; elo_min: number | null; elo_max: number | null }
export interface BestMove { best: string | null; cp: number | null; mate: number | null }
export interface Opening { id: number; eco: string; name: string; pgn: string; uci: string }
export interface PracticeStart { fen: string; opponent_moves: string[]; hint: [string, string] | null; finished: boolean }
export interface PracticeStep { verdict: "on_line" | "deviation" | "illegal"; expected: string | null; opponent_reply: string | null; finished: boolean; fen: string; hint: [string, string] | null }
export interface PuzzleQuery { rating_min?: number | null; rating_max?: number | null; themes?: string[]; opening_tag?: string | null; partition?: number | null; saved_only?: boolean; unsolved_only?: boolean }
export interface PuzzleSummary { id: string; partition: number; rating: number; themes: string[]; opening_tags: string[]; saved: boolean; solved: boolean }
export interface PuzzleStats { attempts: number; solved: number; clean: number; streak: number; avg_ms: number; recent_solved_rating: number | null; by_theme: { theme: string; attempts: number; solved: number }[]; saved: number }
export interface PuzzleOverview { partitions: { n: number; installed: boolean; rows: number | null; index_rows: number | null }[]; total: number; themes: [string, number][]; index_loaded: boolean; stats: PuzzleStats }
export interface PuzzleStart { id: string; rating: number; themes: string[]; opening_tags: string[]; fen_before: string; opponent_move: string; fen: string; user_is_white: boolean; saved: boolean; plays: number }
export interface PuzzleMoveResult { status: "correct" | "wrong" | "illegal"; reply: string | null; solved: boolean; fen: string }
export interface GameRow { id: number; played_at: string; opponent: string; engine_elo: number | null; time_control: string; user_is_white: boolean; result: string; moves_uci: string }

export interface InstalledTheme { id: string; installed_at: string; manifest: unknown }

export const api = {
  legalMoves: (fen: string) => invoke<string[]>("board_legal_moves", { fen }),
  play: (fen: string, uci: string) => invoke<BoardAfter>("board_play", { fen, uci }),
  drawStatus: (moves: string[]) => invoke<"threefold_repetition" | "fifty_move_rule" | null>("game_draw_status", { moves }),
  engineStart: () => invoke<EngineInfo>("engine_start"),
  engineSetStrength: (elo: number | null) => invoke<void>("engine_set_strength", { elo }),
  engineNewGame: () => invoke<void>("engine_new_game"),
  engineGo: (fen: string | null, moves: string[], movetimeMs: number, style?: string, seed?: number) => invoke<BestMove>("engine_go", { fen, moves, movetimeMs, style: style ?? null, seed: seed ?? null }),
  puzzlesOverview: () => invoke<PuzzleOverview>("puzzles_overview"),
  puzzlesFetchIndex: () => invoke<boolean>("puzzles_fetch_index"),
  puzzlesDownload: (n: number) => invoke<number>("puzzles_download", { n }),
  puzzlesRemove: (n: number) => invoke<void>("puzzles_remove", { n }),
  puzzlesFind: (query: PuzzleQuery, limit = 50, offset = 0) => invoke<{ total: number; items: PuzzleSummary[] }>("puzzles_find", { query, limit, offset }),
  puzzlesStart: (id: string | null, query: PuzzleQuery | null, seed: number) => invoke<PuzzleStart | null>("puzzles_start", { id, query, seed }),
  puzzlesMove: (uci: string) => invoke<PuzzleMoveResult>("puzzles_move", { uci }),
  puzzlesHint: () => invoke<string | null>("puzzles_hint"),
  puzzlesGiveUp: () => invoke<string[]>("puzzles_give_up"),
  puzzlesSave: (id: string, saved: boolean) => invoke<void>("puzzles_save", { id, saved }),
  adaptiveSuggest: (current: number, min: number, max: number) => invoke<number>("adaptive_suggest", { current, min, max }),
  engineStop: () => invoke<void>("engine_stop"),
  openingsEnsure: () => invoke<number>("openings_ensure"),
  openingsSearch: (query: string, limit?: number) => invoke<Opening[]>("openings_search", { query, limit }),
  openingsSaved: () => invoke<Opening[]>("openings_saved"),
  openingsSave: (openingId: number, saved: boolean) => invoke<void>("openings_set_saved", { openingId, saved }),
  practiceStart: (openingId: number, userWhite: boolean, mode: "guided" | "recall") => invoke<PracticeStart>("practice_start", { openingId, userWhite, mode }),
  practiceMove: (uci: string) => invoke<PracticeStep>("practice_move", { uci }),
  practiceHint: () => invoke<[string, string] | null>("practice_hint"),
  gamesSave: (g: { opponent: string; engineElo: number | null; timeControl: string; userIsWhite: boolean; result: string; movesUci: string }) => invoke<number>("games_save", g),
  gamesList: () => invoke<GameRow[]>("games_list"),
  settingsAll: () => invoke<Record<string, string>>("settings_get_all"),
  settingsSet: (key: string, value: string) => invoke<void>("settings_set", { key, value }),
  themesImport: (bytes: Uint8Array) => invoke<InstalledTheme>("themes_import", bytes),
  themesList: () => invoke<InstalledTheme[]>("themes_list"),
  themesRemove: (id: string) => invoke<void>("themes_remove", { id }),
  themeAsset: async (id: string, path: string): Promise<ArrayBuffer> => invoke<ArrayBuffer>("theme_asset", { id, path }),
  onDownloadProgress: (cb: (p: { name: string; done: number; total: number | null }) => void): Promise<UnlistenFn> =>
    listen("download-progress", (e) => cb(e.payload as { name: string; done: number; total: number | null })),
};

export const errText = (e: unknown): string => (typeof e === "string" ? e : e instanceof Error ? e.message : String(e));
