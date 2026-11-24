use crate::{engine_path, state::AppState};
use caissora_core::{
    chess::{Board, GameStatus, Side},
    db, download, games,
    engine::{parse::Score, spawn_process, Engine, GoParams, Position},
    theme,
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
#[tauri::command]
pub async fn engine_go(state: State<'_, AppState>, fen: Option<String>, moves: Vec<String>, movetime_ms: u64) -> Res<BestMove> {
    let e = engine(&state).await?;
    let pos = fen.map(Position::Fen).unwrap_or(Position::Startpos);
    let r = e.go(&pos, &moves, &GoParams::movetime(movetime_ms.clamp(10, 60_000))).await.map_err(s)?;
    let score = r.lines.first().and_then(|l| l.score);
    Ok(BestMove {
        best: r.best,
        cp: match score { Some(Score::Cp(v)) => Some(v), _ => None },
        mate: match score { Some(Score::Mate(v)) => Some(v), _ => None },
    })
}

#[tauri::command]
pub async fn engine_stop(state: State<'_, AppState>) -> Res<()> {
    engine(&state).await?.stop().map_err(s)
}

// ------------------------------------------------------------------ aperture

#[derive(Serialize, Clone)]
struct Progress { name: &'static str, done: u64, total: Option<u64> }

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
        let _ = app.emit("download-progress", Progress { name: "openings", done, total });
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
const SETTING_KEYS: &[&str] = &["theme_mode", "accent", "language", "reduce_motion", "engine_elo", "time_control", "board_theme", "piece_set", "academy_progress", "quality", "default_time_control", "allow_undo"];

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
