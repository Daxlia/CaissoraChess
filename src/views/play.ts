import { api, errText, type EngineInfo } from "../api";
import { Board } from "../board/Board";
import { bindAppearance, turnOf } from "../board/appearance";
import { clear, h, modal, toast, type Modal } from "../dom";
import { ICONS } from "../icons";
import { t } from "../i18n";
import { getSetting, setSetting } from "../settings";
import { createReplay, type Replay } from "./replay";
import type { View } from "./types";

const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";

interface TimeControl { id: string; initial: number; inc: number } // secondi
const PRESETS: TimeControl[] = [
  { id: "bullet", initial: 60, inc: 0 }, { id: "blitz", initial: 300, inc: 0 },
  { id: "rapid", initial: 600, inc: 0 }, { id: "classical", initial: 1800, inc: 0 },
  { id: "unlimited", initial: 0, inc: 0 },
];
const tcString = (tc: TimeControl): string => (tc.initial === 0 ? "unlimited" : `${tc.initial / 60}+${tc.inc}`);
const parseTc = (s: string): TimeControl => {
  const p = PRESETS.find((x) => tcString(x) === s);
  if (p) return p;
  const m = /^(\d+(?:\.\d+)?)\+(\d+)$/.exec(s);
  return m ? { id: "custom", initial: Math.round(Number(m[1]) * 60), inc: Number(m[2]) } : PRESETS[1]!;
};
const fmt = (ms: number): string => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };

interface GameConfig { elo: number | null; color: "white" | "black"; tc: TimeControl }

export async function playView(): Promise<View> {
  const root = h("div", { class: "view" });
  const stop: (() => void)[] = [];
  const destroy = () => stop.forEach((f) => f());

  const tabs = h("div", { class: "tabs", role: "tablist" });
  const body = h("div");
  let replay: Replay | null = null;
  let live: { destroy: () => void } | null = null;
  const tabDefs = [{ id: "game", label: t("play.tab.game") }, { id: "archive", label: t("play.tab.archive") }];
  const select = async (id: string) => {
    for (const b of tabs.children) b.setAttribute("aria-selected", String((b as HTMLElement).dataset.id === id));
    replay?.destroy(); replay = null; live?.destroy(); live = null; clear(body);
    if (id === "game") { const g = await gameTab(); live = g; body.append(g.el); }
    else body.append(await archiveTab((r) => { replay?.destroy(); replay = r; }));
  };
  for (const d of tabDefs) tabs.append(h("button", { class: "tab", role: "tab", "data-id": d.id, onClick: () => void select(d.id) }, d.label));
  root.append(h("div", { class: "page-head" }, h("h1", {}, t("nav.play"))), tabs, body);
  stop.push(() => { replay?.destroy(); live?.destroy(); });
  await select("game");
  return { el: root, destroy };
}

// ===================================================================== partita

async function gameTab(): Promise<{ el: HTMLElement; destroy: () => void }> {
  const host = h("div", { class: "board-host" });
  const el = h("div", { class: "play" });
  const cleanup: (() => void)[] = [];

  // ---- stato
  let engineInfo: EngineInfo | null = null;
  let engineError: string | null = null;
  let cfg: GameConfig = { elo: null, color: "white", tc: parseTc(getSetting("default_time_control", "5+0")) };
  let token = 0; // invalida le risposte del motore di partite precedenti
  let moves: string[] = []; const fens: string[] = [START]; const sans: string[] = []; let checks: (string | null)[] = [null];
  let view = 0; let over = false; let busy = false; let started = false; let userWhite = true;
  let clocks = [0, 0]; let lastTick = 0; let ticker = 0;
  let result = "*"; let message = "";

  const board = new Board(host, {
    legalMoves: () => api.legalMoves(fens[fens.length - 1]!),
    askPromotion: (color) => askPromotion(color),
    onMove: (uci) => void userMove(uci),
  });
  cleanup.push(bindAppearance(board));
  board.setPosition(START, "w"); board.setInteractive(false);

  // ---- UI
  const topName = h("strong"); const botName = h("strong");
  const topClock = h("div", { class: "clock" }); const botClock = h("div", { class: "clock" });
  const movesEl = h("div", { class: "moves", "aria-label": t("play.moves") });
  const banner = h("div", { class: "result-banner", hidden: true, role: "status" });
  const btn = (key: string, fn: () => void, cls = "btn small") => h("button", { class: cls, type: "button", onClick: fn }, t(key));
  const newBtn = h("button", { class: "btn primary", type: "button", onClick: () => void openSetup() }, t("play.newGame"));
  const resignBtn = btn("play.resign", () => void finish(userWhite ? "0-1" : "1-0", t("play.result.resigned")));
  const drawBtn = btn("play.offerDraw", () => void offerDraw());
  const undoBtn = btn("play.undo", () => void undo());
  const flipBtn = h("button", { class: "btn icon small", type: "button", title: t("board.flip"), "aria-label": t("board.flip"), onClick: () => { board.setFlipped(!board.isFlipped); renderBars(); } });
  flipBtn.innerHTML = ICONS.flip;
  const navBtn = (icon: string, key: string, fn: () => void) => { const b = h("button", { class: "btn icon small", type: "button", title: t(key), "aria-label": t(key), onClick: fn }); b.innerHTML = icon; return b; };
  const nav = h("div", { class: "row", style: "justify-content:center" },
    navBtn(ICONS.first, "replay.first", () => goto(0)), navBtn(ICONS.prev, "replay.prev", () => goto(view - 1)),
    navBtn(ICONS.next, "replay.next", () => goto(view + 1)), navBtn(ICONS.last, "replay.last", () => goto(fens.length - 1)), flipBtn);
  const engineBox = h("div", { class: "col" });

  const panel = h("div", { class: "col card" },
    h("div", { class: "row spread" }, h("h2", {}, t("play.vsEngine")), newBtn),
    engineBox, banner, nav, movesEl,
    h("div", { class: "row" }, undoBtn, drawBtn, resignBtn));
  el.append(
    h("div", { class: "board-col" }, h("div", { class: "player-bar" }, topName, topClock), host, h("div", { class: "player-bar" }, botName, botClock)),
    panel);

  const bottomIsUser = () => (userWhite ? !board.isFlipped : board.isFlipped);
  function renderBars(): void {
    const oppName = engineInfo ? `${engineInfo.name}${cfg.elo ? ` · ${cfg.elo}` : ` · ${t("play.fullStrength")}`}` : t("play.engine");
    const me = t("play.you");
    const userBottom = bottomIsUser();
    topName.textContent = started ? (userBottom ? oppName : me) : oppName;
    botName.textContent = started ? (userBottom ? me : oppName) : me;
    const whiteMs = clocks[0]!, blackMs = clocks[1]!;
    const turnW = turnOf(fens[fens.length - 1]!) === "w";
    const mk = (c: HTMLElement, ms: number, active: boolean) => { c.textContent = !started ? "–:––" : cfg.tc.initial ? fmt(ms) : "∞"; c.classList.toggle("active", active && !over && started); c.classList.toggle("low", started && cfg.tc.initial > 0 && ms < 10000); };
    const bottomWhite = board.isFlipped ? false : true; // il bianco è in basso se non ruotata
    mk(botClock, bottomWhite ? whiteMs : blackMs, bottomWhite ? turnW : !turnW);
    mk(topClock, bottomWhite ? blackMs : whiteMs, bottomWhite ? !turnW : turnW);
    renderControls();
  }
  function renderControls(): void {
    const live = started && !over;
    const myTurn = live && !busy && turnOf(fens[fens.length - 1]!) === (userWhite ? "w" : "b");
    resignBtn.disabled = !live; drawBtn.disabled = !myTurn || moves.length < 2;
    undoBtn.disabled = !myTurn || moves.length < (userWhite ? 2 : 3) || getSetting("allow_undo", "1") !== "1";
    undoBtn.hidden = getSetting("allow_undo", "1") !== "1";
    banner.hidden = !over; banner.textContent = message;
    board.setInteractive(live && view === fens.length - 1 && myTurn);
  }
  function renderMoves(): void {
    clear(movesEl);
    for (let i = 0; i < sans.length; i += 2) {
      const mv = (idx: number) => h("button", { class: `mv${view === idx + 1 ? " cur" : ""}`, type: "button", onClick: () => goto(idx + 1) }, sans[idx] ?? "");
      movesEl.append(h("span", { class: "no" }, `${i / 2 + 1}.`), mv(i), sans[i + 1] ? mv(i + 1) : h("span"));
    }
    movesEl.querySelector(".cur")?.scrollIntoView({ block: "nearest" });
  }
  function renderEngineBox(): void {
    clear(engineBox);
    if (engineError) { engineBox.append(h("div", { class: "error-box" }, engineError), h("button", { class: "btn", type: "button", onClick: () => void initEngine() }, t("common.retry"))); }
    else if (!engineInfo) engineBox.append(h("div", { class: "row" }, h("div", { class: "spinner" }), h("span", { class: "dim" }, t("play.engineStarting"))));
    else engineBox.append(h("p", { class: "dim small" }, `${engineInfo.name} — ${started ? (cfg.elo ? t("play.strengthElo", { elo: cfg.elo }) : t("play.fullStrength")) : t("play.pressNew")}`));
  }
  function goto(n: number): void {
    view = Math.max(0, Math.min(fens.length - 1, n));
    const fen = fens[view]!;
    board.setPosition(fen, turnOf(fen)); board.setLastMove(view > 0 ? moves[view - 1]! : null); board.setCheck(checks[view] ?? null);
    renderMoves(); renderControls();
    if (view === fens.length - 1) void board.reloadLegal();
  }
  function setHistory(m: string[], f: string[], s: string[], c: (string | null)[]): void { moves = m; fens.length = 0; fens.push(...f); sans.length = 0; sans.push(...s); checks = c; }

  // ---- motore
  async function initEngine(): Promise<void> {
    engineError = null; engineInfo = null; renderEngineBox();
    try {
      engineInfo = await api.engineStart();
      const saved = getSetting("engine_elo", "1500");
      if (saved !== "full" && engineInfo.elo_min !== null) cfg.elo = Math.min(engineInfo.elo_max!, Math.max(engineInfo.elo_min, Number(saved) || 1500));
    } catch (e) { engineError = errText(e); }
    renderEngineBox(); renderBars();
  }

  async function openSetup(): Promise<void> {
    if (!engineInfo) { toast(engineError ?? t("play.engineStarting"), "error"); return; }
    let elo = cfg.elo; let full = cfg.elo === null; let color: "white" | "black" | "random" = cfg.color; let tc = cfg.tc;
    const lo = engineInfo.elo_min ?? 1320, hi = engineInfo.elo_max ?? 3190, canLimit = engineInfo.elo_min !== null;
    const eloOut = h("strong", {}, String(elo ?? hi));
    const slider = h("input", { type: "range", min: lo, max: hi, step: 10, value: elo ?? Math.min(hi, 1500), onInput: (e: Event) => { elo = Number((e.target as HTMLInputElement).value); eloOut.textContent = String(elo); } });
    const fullChk = h("input", { type: "checkbox", checked: full, onChange: (e: Event) => { full = (e.target as HTMLInputElement).checked; slider.disabled = full; } });
    slider.disabled = full || !canLimit; fullChk.disabled = !canLimit;
    if (!elo) elo = Math.min(hi, 1500);
    const seg = <T extends string>(opts: { v: T; label: string }[], cur: T, on: (v: T) => void) => {
      const wrap = h("div", { class: "seg", role: "group" });
      const draw = (c: T) => { clear(wrap); for (const o of opts) wrap.append(h("button", { type: "button", "aria-pressed": String(o.v === c), onClick: () => { on(o.v); draw(o.v); } }, o.label)); };
      draw(cur); return wrap;
    };
    const tcSel = h("select", { onChange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; tc = PRESETS.find((p) => p.id === v) ?? tc; customBox.hidden = v !== "custom"; if (v === "custom") tc = { id: "custom", initial: Number(min.value) * 60, inc: Number(inc.value) }; } },
      ...PRESETS.map((p) => h("option", { value: p.id, selected: p.id === tc.id || (tc.id === "custom" && false) }, `${t(`play.tc.${p.id}`)}${p.initial ? ` (${p.initial / 60}+${p.inc})` : ""}`)), h("option", { value: "custom", selected: tc.id === "custom" }, t("play.tc.custom")));
    const min = h("input", { type: "number", min: 1, max: 180, value: tc.id === "custom" ? tc.initial / 60 : 10, onInput: () => { tc = { id: "custom", initial: Math.max(1, Number(min.value)) * 60, inc: Math.max(0, Number(inc.value)) }; } });
    const inc = h("input", { type: "number", min: 0, max: 60, value: tc.id === "custom" ? tc.inc : 0, onInput: () => { tc = { id: "custom", initial: Math.max(1, Number(min.value)) * 60, inc: Math.max(0, Number(inc.value)) }; } });
    const customBox = h("div", { class: "row", hidden: tc.id !== "custom" }, h("label", { class: "field" }, h("span", {}, t("play.minutes")), min), h("label", { class: "field" }, h("span", {}, t("play.increment")), inc));
    const content = h("div", { class: "col" },
      h("div", { class: "col" }, h("div", { class: "row spread" }, h("span", {}, t("play.strength")), h("span", {}, canLimit ? eloOut : null)), slider,
        h("label", { class: "row" }, fullChk, h("span", {}, t("play.fullStrength"))), h("p", { class: "dim small" }, canLimit ? t("play.eloNote", { min: lo, max: hi }) : t("play.noEloSupport"))),
      h("div", { class: "col" }, h("span", {}, t("play.color")), seg([{ v: "white", label: t("play.white") }, { v: "black", label: t("play.black") }, { v: "random", label: t("play.random") }] as { v: "white" | "black" | "random"; label: string }[], color, (v) => (color = v))),
      h("label", { class: "field" }, h("span", {}, t("play.timeControl")), tcSel), customBox);
    let m: Modal | null = null;
    m = modal(t("play.newGame"), content, [
      { label: t("common.cancel"), onClick: () => m?.close() },
      { label: t("play.start"), primary: true, onClick: async () => {
        const c = color === "random" ? (crypto.getRandomValues(new Uint8Array(1))[0]! % 2 ? "white" : "black") : color;
        m?.close();
        await startGame({ elo: full || !canLimit ? null : elo, color: c, tc });
      } },
    ]);
  }

  async function startGame(c: GameConfig): Promise<void> {
    token++; const my = token; busy = true; cleanupTimer();
    try {
      await api.engineSetStrength(c.elo); await api.engineNewGame();
    } catch (e) { toast(errText(e), "error"); busy = false; return; }
    cfg = c; userWhite = c.color === "white"; started = true; over = false; message = ""; result = "*";
    setHistory([], [START], [], [null]); view = 0;
    clocks = [c.tc.initial * 1000, c.tc.initial * 1000];
    void setSetting("engine_elo", c.elo ? String(c.elo) : "full"); void setSetting("default_time_control", tcString(c.tc));
    board.setFlipped(!userWhite); board.setPosition(START, "w"); board.setLastMove(null); board.setCheck(null);
    busy = false; renderEngineBox(); renderMoves(); renderBars();
    if (c.tc.initial) startTimer();
    if (!userWhite) await engineMove(my); else await board.reloadLegal();
    renderControls();
  }

  function startTimer(): void {
    lastTick = performance.now();
    ticker = window.setInterval(() => {
      if (over || document.hidden && false) return;
      const now = performance.now(); const dt = now - lastTick; lastTick = now;
      const idx = turnOf(fens[fens.length - 1]!) === "w" ? 0 : 1;
      clocks[idx] = clocks[idx]! - dt;
      if (clocks[idx]! <= 0) { clocks[idx] = 0; const whiteLost = idx === 0; void finish(whiteLost ? "0-1" : "1-0", t("play.result.timeout")); }
      renderBars();
    }, 200);
  }
  function cleanupTimer(): void { if (ticker) { clearInterval(ticker); ticker = 0; } }
  cleanup.push(cleanupTimer);

  async function applyMove(uci: string, byUser: boolean): Promise<boolean> {
    const fen = fens[fens.length - 1]!;
    const r = await api.play(fen, uci);
    const mover = turnOf(fen);
    if (cfg.tc.initial && cfg.tc.inc) { const i = mover === "w" ? 0 : 1; clocks[i] = clocks[i]! + cfg.tc.inc * 1000; }
    moves = [...moves, uci]; fens.push(r.fen); sans.push(r.san); checks.push(r.check_square);
    view = fens.length - 1;
    await board.animateMove(uci, r.fen, turnOf(r.fen));
    board.setLastMove(uci); board.setCheck(r.check_square);
    renderMoves(); renderBars();
    if (r.status === "checkmate") { await finish(r.winner === "white" ? "1-0" : "0-1", t("play.result.checkmate")); return false; }
    if (r.status === "stalemate") { await finish("1/2-1/2", t("play.result.stalemate")); return false; }
    if (r.status === "insufficient_material") { await finish("1/2-1/2", t("play.result.insufficient")); return false; }
    const d = await api.drawStatus(moves);
    if (d) { await finish("1/2-1/2", t(d === "fifty_move_rule" ? "play.result.fifty" : "play.result.threefold")); return false; }
    void byUser; return true;
  }

  async function userMove(uci: string): Promise<void> {
    if (busy || over) return;
    busy = true; const my = token; renderControls();
    try {
      const cont = await applyMove(uci, true);
      if (cont && my === token) { busy = false; await engineMove(my); }
    } catch (e) { toast(errText(e), "error"); }
    busy = false; renderControls();
    if (!over && view === fens.length - 1) await board.reloadLegal();
  }

  async function engineMove(my: number): Promise<void> {
    busy = true; renderControls();
    try {
      const idx = turnOf(fens[fens.length - 1]!) === "w" ? 0 : 1;
      const think = cfg.tc.initial ? Math.round(Math.min(2500, Math.max(150, clocks[idx]! / 40 + cfg.tc.inc * 500))) : 1200;
      const r = await api.engineGo(null, moves, think);
      if (my !== token || over) return;
      if (!r.best) { await finish("1/2-1/2", t("play.result.stalemate")); return; }
      await applyMove(r.best, false);
    } catch (e) { if (my === token) toast(errText(e), "error"); }
    finally { if (my === token) { busy = false; renderControls(); if (!over && view === fens.length - 1) await board.reloadLegal(); } }
  }

  async function finish(res: string, why: string): Promise<void> {
    if (over) return;
    over = true; token++; busy = false; result = res; cleanupTimer();
    try { await api.engineStop(); } catch { /* il motore potrebbe essere già fermo */ }
    const user = userWhite ? "1-0" : "0-1";
    const verdict = res === "1/2-1/2" ? t("play.draw") : res === user ? t("play.youWon") : t("play.youLost");
    message = `${verdict} — ${why}`;
    renderBars(); renderControls();
    try {
      await api.gamesSave({ opponent: engineInfo?.name ?? "Engine", engineElo: cfg.elo, timeControl: tcString(cfg.tc), userIsWhite: userWhite, result, movesUci: moves.join(" ") });
    } catch (e) { toast(t("play.saveFailed", { error: errText(e) }), "error"); }
  }

  async function offerDraw(): Promise<void> {
    if (busy || over) return;
    busy = true; renderControls();
    try {
      const r = await api.engineGo(null, moves, 400); // posizione al tratto dell'utente: il punteggio è dal suo punto di vista
      const userBetter = r.mate !== null ? r.mate > 0 : (r.cp ?? 0) > 50;
      busy = false;
      if (!userBetter) await finish("1/2-1/2", t("play.result.agreed")); else toast(t("play.drawDeclined"));
    } catch (e) { toast(errText(e), "error"); }
    busy = false; renderControls();
  }

  async function undo(): Promise<void> {
    if (busy || over) return;
    const n = turnOf(fens[fens.length - 1]!) === (userWhite ? "w" : "b") ? 2 : 1;
    setHistory(moves.slice(0, -n), fens.slice(0, -n), sans.slice(0, -n), checks.slice(0, -n));
    goto(fens.length - 1); renderBars();
  }

  function askPromotion(color: "w" | "b"): Promise<"q" | "r" | "b" | "n" | null> {
    return new Promise((resolve) => {
      let m: Modal | null = null;
      const pick = (p: "q" | "r" | "b" | "n" | null) => { m?.close(); resolve(p); };
      const names = { q: t("piece.queen"), r: t("piece.rook"), b: t("piece.bishop"), n: t("piece.knight") } as const;
      const grid = h("div", { class: "row" }, ...(["q", "r", "b", "n"] as const).map((p) => h("button", { class: "btn", type: "button", onClick: () => pick(p) }, names[p])));
      void color;
      m = modal(t("play.promoteTitle"), grid, [{ label: t("common.cancel"), onClick: () => pick(null) }], false);
    });
  }

  void initEngine(); renderBars(); renderMoves();
  return { el, destroy: () => { token++; cleanup.forEach((f) => f()); board.destroy(); } };
}

// ===================================================================== archivio

/** SQLite memorizza datetime('now') in UTC senza fuso: lo mostriamo nell'ora locale. */
const localTime = (utc: string): string => new Date(`${utc.replace(" ", "T")}Z`).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

async function archiveTab(setReplay: (r: Replay) => void): Promise<HTMLElement> {
  const wrap = h("div", { class: "split" });
  const list = h("div", { class: "list" }); const detail = h("div", { class: "col" });
  wrap.append(h("div", { class: "card col" }, h("h2", {}, t("archive.mine")), list), detail);
  const resultLabel = (g: { result: string; user_is_white: boolean }) => g.result === "1/2-1/2" ? t("play.draw") : g.result === "*" ? t("archive.unfinished") : (g.result === "1-0") === g.user_is_white ? t("archive.win") : t("archive.loss");
  try {
    const games = await api.gamesList();
    if (!games.length) list.append(h("div", { class: "empty" }, t("archive.empty")));
    for (const g of games) {
      const item = h("button", { class: "list-item", type: "button", onClick: async () => {
        for (const c of list.children) c.setAttribute("aria-current", "false"); item.setAttribute("aria-current", "true");
        clear(detail);
        const r = await createReplay(g.moves_uci ? g.moves_uci.split(" ") : [], !g.user_is_white);
        setReplay(r);
        detail.append(h("div", { class: "card col" }, h("h3", {}, `${resultLabel(g)} · ${g.opponent}${g.engine_elo ? ` ${g.engine_elo}` : ""}`), h("p", { class: "dim small" }, `${localTime(g.played_at)} · ${g.time_control === "unlimited" ? t("play.tc.unlimited") : g.time_control} · ${g.result}`)), r.el);
      } }, h("span", {}, localTime(g.played_at)), h("span", { class: "badge" }, resultLabel(g)));
      list.append(item);
    }
  } catch (e) { list.append(h("div", { class: "error-box" }, errText(e))); }
  if (!detail.firstChild) detail.append(h("div", { class: "empty" }, t("archive.pick")));
  return wrap;
}
