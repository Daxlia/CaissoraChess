use crate::{engine_path, state::{ActivePuzzle, AppState}};
use caissora_core::{
    chess::{Board, GameStatus, Side},
    db, download, games,
    engine::{parse::Score, spawn_process, Engine, GoParams, Position},
    puzzle::{self, PuzzleSession, Step, PARTITIONS}, puzzle_index::PuzzleIndex, puzzle_store::{self, Query as PuzzleQuery}, theme, adaptive, personality::{self, Style},
    openings::{self, Opening, Practice, PracticeMode, Verdict, OPENINGS_URL},
};
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

type Res<T> = Result<T, String>;
fn s<E: std::fmt::Display>(e: E) -> String { e.to_string() }

// ------------------------------------------------------------------ regole

#[derive(Serialize)]
pub struct BoardAfter {
    fen: String,
    san: String,
    /// "ongoing" | "checkmate" | "stalemate" | "insufficient_material"
    status: &'static str,
    winner: Option<&'static str>,
    check: bool,
    check_square: Option<String>,
}

#[tauri::command]
pub fn board_legal_moves(fen: String) -> Res<Vec<String>> {
    Ok(Board::from_fen(&fen).map_err(s)?.legal_uci())
}

#[tauri::command]
pub fn board_play(fen: String, uci: String) -> Res<BoardAfter> {
    let mut b = Board::from_fen(&fen).map_err(s)?;
    let san = b.play_uci(&uci).map_err(s)?;
    let (status, winner) = match b.status() {
        GameStatus::Ongoing => ("ongoing", None),
        GameStatus::Checkmate { winner } => ("checkmate", Some(if winner == Side::White { "white" } else { "black" })),
        GameStatus::Stalemate => ("stalemate", None),
        GameStatus::InsufficientMaterial => ("insufficient_material", None),
    };
    Ok(BoardAfter { fen: b.fen(), san, status, winner, check: b.is_check(), check_square: b.checked_king_square() })
}

/// "threefold_repetition" | "fifty_move_rule" | null, per la partita giocata da `moves` (UCI).
#[tauri::command]
pub fn game_draw_status(moves: Vec<String>) -> Res<Option<&'static str>> {
    use caissora_core::chess::{history_draw, DrawKind};
    Ok(history_draw(&moves).map_err(s)?.map(|d| match d {
        DrawKind::ThreefoldRepetition => "threefold_repetition",
        DrawKind::FiftyMoveRule => "fifty_move_rule",
    }))
}

// ------------------------------------------------------------------ engine

#[derive(Serialize)]
pub struct EngineInfo { name: String, elo_min: Option<i64>, elo_max: Option<i64> }

async fn engine(state: &AppState) -> Res<Arc<Engine>> {
    state.engine.lock().await.clone().ok_or_else(|| "engine not started".to_string())
}

#[tauri::command]
pub async fn engine_start(state: State<'_, AppState>) -> Res<EngineInfo> {
    let mut slot = state.engine.lock().await;
    if slot.is_none() {
        let path = engine_path::resolve()?;
        let io = spawn_process(path.to_str().ok_or("invalid engine path")?, &[]).map_err(s)?;
        *slot = Some(Arc::new(Engine::connect(io).await.map_err(s)?));
    }
    let e = slot.as_ref().unwrap();
    let range = e.elo_range();
    Ok(EngineInfo { name: e.name.clone(), elo_min: range.map(|r| r.0), elo_max: range.map(|r| r.1) })
}

/// `elo = None` → piena forza.
#[tauri::command]
pub async fn engine_set_strength(state: State<'_, AppState>, elo: Option<i64>) -> Res<()> {
    let e = engine(&state).await?;
    match elo {
        Some(v) => e.set_strength_elo(v).await.map_err(s),
        None => e.set_full_strength().await.map_err(s),
    }
}

#[tauri::command]
pub async fn engine_new_game(state: State<'_, AppState>) -> Res<()> {
    engine(&state).await?.new_game().await.map_err(s)
}

#[derive(Serialize)]
pub struct BestMove { best: Option<String>, cp: Option<i32>, mate: Option<i32> }

/// `fen = None` → posizione iniziale. `moves` = mosse UCI giocate da lì.
/// `style` (neutral/aggressive/defensive/positional/tactical/unpredictable) sceglie tra le linee MultiPV del motore
/// secondo la personalità; `seed` rende la scelta riproducibile.
#[tauri::command]
pub async fn engine_go(state: State<'_, AppState>, fen: Option<String>, moves: Vec<String>, movetime_ms: u64, style: Option<String>, seed: Option<u64>) -> Res<BestMove> {
    let e = engine(&state).await?;
    let style = match style.as_deref() { None => Style::Neutral, Some(x) => Style::parse(x).ok_or("unknown style")? };
    let pos = fen.clone().map(Position::Fen).unwrap_or(Position::Startpos);
    let params = GoParams::movetime(movetime_ms.clamp(10, 60_000));
    if style != Style::Neutral {
        let mut b = match &fen { Some(f) => Board::from_fen(f).map_err(s)?, None => Board::default() };
        for m in &moves { b.play_uci(m).map_err(s)?; }
        e.set_multipv(style.multipv()).await.map_err(s)?;
        let r = e.go(&pos, &moves, &params).await;
        let _ = e.set_multipv(1).await;
        let r = r.map_err(s)?;
        let best = personality::pick(&b.fen(), &r.lines, style, seed.unwrap_or(0)).map_err(s)?.or(r.best.clone());
        let score = r.lines.iter().find(|l| l.pv.first() == best.as_ref()).or(r.lines.first()).and_then(|l| l.score);
        return Ok(BestMove { best, cp: match score { Some(Score::Cp(v)) => Some(v), _ => None }, mate: match score { Some(Score::Mate(v)) => Some(v), _ => None } });
    }
    let r = e.go(&pos, &moves, &params).await.map_err(s)?;
    let score = r.lines.first().and_then(|l| l.score);
    Ok(BestMove {
        best: r.best,
        cp: match score { Some(Score::Cp(v)) => Some(v), _ => None },
        mate: match score { Some(Score::Mate(v)) => Some(v), _ => None },
    })
}

/// Elo consigliato per la prossima partita in base alle ultime partite dell'utente contro il motore.
#[tauri::command]
pub fn adaptive_suggest(state: State<'_, AppState>, current: i64, min: i64, max: i64) -> Res<i64> {
    let recent = games::list(&state.db.lock().unwrap(), 12).map_err(s)?;
    Ok(adaptive::suggest_elo(&recent, current, min, max, 25))
}

#[tauri::command]
pub async fn engine_stop(state: State<'_, AppState>) -> Res<()> {
    engine(&state).await?.stop().map_err(s)
}

// ------------------------------------------------------------------ aperture

#[derive(Serialize, Clone)]
struct Progress { name: String, done: u64, total: Option<u64> }

/// Scarica (solo se manca) e importa il Parquet. Restituisce il numero di aperture.
#[tauri::command]
pub async fn openings_ensure(app: AppHandle, state: State<'_, AppState>) -> Res<i64> {
    let count = |st: &AppState| -> Res<i64> {
        st.db.lock().unwrap().query_row("SELECT count(*) FROM openings", [], |r| r.get(0)).map_err(s)
    };
    let have = count(&state)?;
    if have > 0 { return Ok(have); }

    let dest = state.data_dir.join("openings.parquet");
    let dl = download::download_to(OPENINGS_URL, &dest, None, 10 * 1024 * 1024, |done, total| {
        let _ = app.emit("download-progress", Progress { name: "openings".into(), done, total });
    }).await.map_err(s)?;

    let rows = openings::read_parquet(&dest).map_err(s)?;
    {
        let mut conn = state.db.lock().unwrap();
        openings::import(&mut conn, &rows).map_err(s)?;
        conn.execute(
            "INSERT INTO datasets(name, source_url, bytes, sha256) VALUES ('openings', ?1, ?2, ?3)
             ON CONFLICT(name) DO UPDATE SET source_url=excluded.source_url, bytes=excluded.bytes, sha256=excluded.sha256, fetched_at=datetime('now')",
            caissora_core::rusqlite::params![OPENINGS_URL, dl.bytes as i64, dl.sha256],
        ).map_err(s)?;
    }
    count(&state)
}

#[tauri::command]
pub fn openings_search(state: State<'_, AppState>, query: String, limit: Option<usize>) -> Res<Vec<Opening>> {
    let conn = state.db.lock().unwrap();
    openings::search(&conn, &query, limit.unwrap_or(50).min(200)).map_err(s)
}

#[derive(Serialize)]
pub struct PracticeStart { fen: String, opponent_moves: Vec<String>, hint: Option<(String, String)>, finished: bool }

#[tauri::command]
pub fn practice_start(state: State<'_, AppState>, opening_id: i64, user_white: bool, mode: String) -> Res<PracticeStart> {
    let uci: String = state.db.lock().unwrap()
        .query_row("SELECT uci FROM openings WHERE id = ?1", [opening_id], |r| r.get(0)).map_err(s)?;
    let mode = match mode.as_str() { "guided" => PracticeMode::Guided, "recall" => PracticeMode::Recall, m => return Err(format!("unknown mode `{m}`")) };
    let mut p = Practice::new(&uci, user_white, mode);
    let opp = p.advance_opponent().map_err(s)?;
    let out = PracticeStart {
        fen: p.fen(), opponent_moves: opp,
        hint: if mode == PracticeMode::Guided { p.hint() } else { None },
        finished: p.finished(),
    };
    *state.practice.lock().unwrap() = Some(p);
    Ok(out)
}

#[derive(Serialize)]
pub struct PracticeStep {
    /// "on_line" | "deviation" | "illegal"
    verdict: &'static str,
    expected: Option<String>,
    opponent_reply: Option<String>,
    finished: bool,
    fen: String,
    hint: Option<(String, String)>,
}

#[tauri::command]
pub fn practice_move(state: State<'_, AppState>, uci: String) -> Res<PracticeStep> {
    let mut g = state.practice.lock().unwrap();
    let p = g.as_mut().ok_or("no practice session")?;
    let guided = p.mode == PracticeMode::Guided;
    let v = p.submit(&uci).map_err(s)?;
    let hint = if guided { p.hint() } else { None };
    Ok(match v {
        Verdict::OnLine { opponent_reply, finished } => PracticeStep { verdict: "on_line", expected: None, opponent_reply, finished, fen: p.fen(), hint },
        Verdict::Deviation { expected } => PracticeStep { verdict: "deviation", expected: Some(expected), opponent_reply: None, finished: false, fen: p.fen(), hint },
        Verdict::Illegal => PracticeStep { verdict: "illegal", expected: None, opponent_reply: None, finished: false, fen: p.fen(), hint },
    })
}

#[tauri::command]
pub fn practice_hint(state: State<'_, AppState>) -> Res<Option<(String, String)>> {
    Ok(state.practice.lock().unwrap().as_ref().ok_or("no practice session")?.hint())
}

// ------------------------------------------------------------------ impostazioni

/// Solo queste chiavi sono scrivibili dal frontend.
const SETTING_KEYS: &[&str] = &["theme_mode", "accent", "language", "reduce_motion", "engine_elo", "time_control", "board_theme", "piece_set", "academy_progress", "quality", "default_time_control", "allow_undo", "view_mode", "personality", "adaptive_elo"];

#[tauri::command]
pub fn settings_get_all(state: State<'_, AppState>) -> Res<std::collections::HashMap<String, String>> {
    let conn = state.db.lock().unwrap();
    let mut st = conn.prepare("SELECT key, value FROM settings").map_err(s)?;
    let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))).map_err(s)?;
    rows.collect::<Result<_, _>>().map_err(s)
}

#[tauri::command]
pub fn settings_set(state: State<'_, AppState>, key: String, value: String) -> Res<()> {
    if !SETTING_KEYS.contains(&key.as_str()) { return Err(format!("unknown setting `{key}`")); }
    if value.len() > 256 { return Err("value too long".into()); }
    db::set_setting(&state.db.lock().unwrap(), &key, &value).map_err(s)
}

// ------------------------------------------------------------------ libreria e archivio

#[tauri::command]
pub fn openings_saved(state: State<'_, AppState>) -> Res<Vec<Opening>> {
    openings::list_saved(&state.db.lock().unwrap()).map_err(s)
}

#[tauri::command]
pub fn openings_set_saved(state: State<'_, AppState>, opening_id: i64, saved: bool) -> Res<()> {
    openings::set_saved(&state.db.lock().unwrap(), opening_id, saved).map_err(s)
}

#[tauri::command]
pub fn games_save(state: State<'_, AppState>, opponent: String, engine_elo: Option<i64>, time_control: String, user_is_white: bool, result: String, moves_uci: String) -> Res<i64> {
    let g = games::NewGame { opponent: &opponent, engine_elo, time_control: &time_control, user_is_white, result: &result, moves_uci: &moves_uci };
    games::save(&state.db.lock().unwrap(), &g).map_err(s)
}

#[tauri::command]
pub fn games_list(state: State<'_, AppState>) -> Res<Vec<games::Game>> {
    games::list(&state.db.lock().unwrap(), 200).map_err(s)
}

// ------------------------------------------------------------------ temi (.cctheme)

/// Id dei temi incorporati: non sovrascrivibili da un file importato.
const BUILTIN_THEMES: &[&str] = &["classic", "obsidian", "neon", "glacier", "ivory-ebony", "emerald"];

/// Il file arriva come corpo binario grezzo; viene validato per intero prima di scrivere su disco.
#[tauri::command]
pub fn themes_import(state: State<'_, AppState>, request: tauri::ipc::Request<'_>) -> Res<theme::Installed> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("expected the raw bytes of a .cctheme file".into()) };
    let conn = state.db.lock().unwrap();
    theme::install(&conn, &state.data_dir, bytes, BUILTIN_THEMES).map_err(s)
}

#[tauri::command]
pub fn themes_list(state: State<'_, AppState>) -> Res<Vec<theme::Installed>> {
    theme::list(&state.db.lock().unwrap()).map_err(s)
}

#[tauri::command]
pub fn themes_remove(state: State<'_, AppState>, id: String) -> Res<()> {
    theme::remove(&state.db.lock().unwrap(), &state.data_dir, &id).map_err(s)
}

#[tauri::command]
pub fn theme_asset(state: State<'_, AppState>, id: String, path: String) -> Res<tauri::ipc::Response> {
    theme::read_asset(&state.data_dir, &id, &path).map(tauri::ipc::Response::new).map_err(s)
}

// ------------------------------------------------------------------ puzzle

const INDEX_URL: &str = "https://raw.githubusercontent.com/Daxlia/CaissoraChess/main/caissora_data/index/puzzle-index.json.zst";

#[derive(Serialize)]
pub struct PartitionInfo { n: u32, installed: bool, rows: Option<u32>, /// righe dichiarate dall'indice (se scaricato)
    index_rows: Option<u32> }

#[derive(Serialize)]
pub struct PuzzleOverview { partitions: Vec<PartitionInfo>, total: u64, themes: Vec<(String, u64)>, index_loaded: bool, stats: puzzle_store::Stats }

fn puzzles_dir(st: &AppState) -> std::path::PathBuf { st.data_dir.join("puzzles") }

fn load_index(st: &AppState) -> Option<PuzzleIndex> {
    let b = std::fs::read(st.data_dir.join("puzzle-index.json.zst")).ok()?;
    PuzzleIndex::from_bytes(&b).ok()
}

#[tauri::command]
pub fn puzzles_overview(state: State<'_, AppState>) -> Res<PuzzleOverview> {
    let idx = load_index(&state);
    let conn = state.db.lock().unwrap();
    let inst: std::collections::HashMap<u32, u32> = puzzle_store::installed(&conn).map_err(s)?.into_iter().collect();
    let partitions = (0..PARTITIONS).map(|n| PartitionInfo {
        n, installed: inst.contains_key(&n), rows: inst.get(&n).copied(),
        index_rows: idx.as_ref().and_then(|i| i.partitions.iter().find(|p| p.n == n).map(|p| p.rows)),
    }).collect();
    Ok(PuzzleOverview {
        partitions, total: inst.values().map(|v| *v as u64).sum(), themes: puzzle_store::theme_counts(&conn).map_err(s)?,
        index_loaded: idx.is_some(), stats: puzzle_store::stats(&conn).map_err(s)?,
    })
}

/// Scarica (se serve) l'indice statistico facoltativo: mostra quanti puzzle ha ogni partizione prima di scaricarla.
#[tauri::command]
pub async fn puzzles_fetch_index(state: State<'_, AppState>) -> Res<bool> {
    let dest = state.data_dir.join("puzzle-index.json.zst");
    download::download_to(INDEX_URL, &dest, None, 4 * 1024 * 1024, |_, _| {}).await.map_err(s)?;
    if PuzzleIndex::from_bytes(&std::fs::read(&dest).map_err(s)?).is_err() { let _ = std::fs::remove_file(&dest); return Err("downloaded index is not valid".into()); }
    Ok(true)
}

/// Scarica la partizione `n` (file originale intatto in `puzzles/`) e la importa nel database.
#[tauri::command]
pub async fn puzzles_download(app: AppHandle, state: State<'_, AppState>, n: u32) -> Res<u32> {
    let url = puzzle::partition_url(n).map_err(s)?;
    let dest = puzzles_dir(&state).join(puzzle::partition_file_name(n).map_err(s)?);
    let name = format!("puzzle-{n}");
    let dl = download::download_to(&url, &dest, None, 64 * 1024 * 1024, |done, total| {
        let _ = app.emit("download-progress", Progress { name: name.clone(), done, total });
    }).await.map_err(s)?;
    let rows = {
        let mut conn = state.db.lock().unwrap();
        puzzle_store::import_partition(&mut conn, n, &dest, dl.bytes, &dl.sha256).map_err(s)
    };
    match rows { Ok(r) => Ok(r), Err(e) => { let _ = std::fs::remove_file(&dest); Err(e) } }
}

#[tauri::command]
pub fn puzzles_remove(state: State<'_, AppState>, n: u32) -> Res<()> {
    puzzle_store::remove_partition(&mut state.db.lock().unwrap(), n).map_err(s)?;
    let _ = std::fs::remove_file(puzzles_dir(&state).join(puzzle::partition_file_name(n).map_err(s)?));
    Ok(())
}

#[derive(Serialize)]
pub struct PuzzleList { total: u64, items: Vec<puzzle_store::Summary> }

#[tauri::command]
pub fn puzzles_find(state: State<'_, AppState>, query: PuzzleQuery, limit: Option<usize>, offset: Option<usize>) -> Res<PuzzleList> {
    let conn = state.db.lock().unwrap();
    Ok(PuzzleList { total: puzzle_store::count(&conn, &query).map_err(s)?, items: puzzle_store::list(&conn, &query, limit.unwrap_or(50), offset.unwrap_or(0)).map_err(s)? })
}

#[derive(Serialize)]
pub struct PuzzleStart { id: String, rating: u32, themes: Vec<String>, opening_tags: Vec<String>, fen_before: String, opponent_move: String, fen: String, user_is_white: bool, saved: bool, plays: u32 }

fn start_puzzle(state: &AppState, p: puzzle::Puzzle) -> Res<PuzzleStart> {
    let session = PuzzleSession::new(&p).map_err(s)?;
    let saved: bool = state.db.lock().unwrap().query_row("SELECT EXISTS(SELECT 1 FROM puzzle_saved WHERE id = ?1)", [&p.id], |r| r.get(0)).map_err(s)?;
    let out = PuzzleStart { id: p.id.clone(), rating: p.rating, themes: p.themes.clone(), opening_tags: p.opening_tags.clone(), fen_before: p.fen.clone(),
        opponent_move: session.opponent_first_move.clone(), fen: session.start_fen.clone(), user_is_white: session.user_is_white, saved, plays: p.nb_plays };
    *state.puzzle.lock().unwrap() = Some(ActivePuzzle { puzzle: p, session, started: std::time::Instant::now(), mistakes: 0, recorded: false });
    Ok(out)
}

/// `id` = puzzle preciso; altrimenti uno a caso tra quelli che rispettano il filtro.
#[tauri::command]
pub fn puzzles_start(state: State<'_, AppState>, id: Option<String>, query: Option<PuzzleQuery>, seed: u64) -> Res<Option<PuzzleStart>> {
    let p = {
        let conn = state.db.lock().unwrap();
        match id { Some(id) => puzzle_store::get(&conn, &id).map_err(s)?, None => puzzle_store::random(&conn, &query.unwrap_or_default(), seed).map_err(s)? }
    };
    p.map(|p| start_puzzle(&state, p)).transpose()
}

#[derive(Serialize)]
pub struct PuzzleMoveResult { /// correct | wrong | illegal
    status: &'static str, reply: Option<String>, solved: bool, fen: String }

fn record(state: &AppState, a: &mut ActivePuzzle, solved: bool) -> Res<()> {
    if a.recorded { return Ok(()); }
    a.recorded = true;
    puzzle_store::record_attempt(&state.db.lock().unwrap(), &a.puzzle, solved, a.mistakes, a.started.elapsed().as_millis() as u64).map_err(s)
}

#[tauri::command]
pub fn puzzles_move(state: State<'_, AppState>, uci: String) -> Res<PuzzleMoveResult> {
    let mut g = state.puzzle.lock().unwrap();
    let a = g.as_mut().ok_or("no puzzle in progress")?;
    let step = a.session.submit(&uci).map_err(s)?;
    let fen = a.session.fen();
    Ok(match step {
        Step::Illegal => PuzzleMoveResult { status: "illegal", reply: None, solved: false, fen },
        Step::Wrong => { a.mistakes += 1; PuzzleMoveResult { status: "wrong", reply: None, solved: false, fen } }
        Step::Correct { reply, solved } => {
            if solved { record(&state, a, true)?; }
            PuzzleMoveResult { status: "correct", reply, solved, fen }
        }
    })
}

/// Suggerimento: la mossa attesa. Conta come errore (il puzzle non risulta più "pulito").
#[tauri::command]
pub fn puzzles_hint(state: State<'_, AppState>) -> Res<Option<String>> {
    let mut g = state.puzzle.lock().unwrap();
    let a = g.as_mut().ok_or("no puzzle in progress")?;
    let m = a.session.expected().map(String::from);
    if m.is_some() { a.mistakes += 1; }
    Ok(m)
}

/// Rinuncia: registra il tentativo come fallito e restituisce la soluzione rimanente.
#[tauri::command]
pub fn puzzles_give_up(state: State<'_, AppState>) -> Res<Vec<String>> {
    let mut g = state.puzzle.lock().unwrap();
    let a = g.as_mut().ok_or("no puzzle in progress")?;
    record(&state, a, false)?;
    let rest = a.session.play_solution().map_err(s)?;
    Ok(rest)
}

#[tauri::command]
pub fn puzzles_save(state: State<'_, AppState>, id: String, saved: bool) -> Res<()> {
    puzzle_store::set_saved(&state.db.lock().unwrap(), &id, saved).map_err(s)
}
