use caissora_core::{db, engine::Engine, openings::Practice, puzzle::{Puzzle, PuzzleSession}, Result};
use caissora_core::rusqlite::Connection;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub struct ActivePuzzle {
    pub puzzle: Puzzle,
    pub session: PuzzleSession,
    pub started: std::time::Instant,
    pub mistakes: u32,
    pub recorded: bool,
}

pub struct AppState {
    pub data_dir: PathBuf,
    pub db: Mutex<Connection>,
    pub engine: tokio::sync::Mutex<Option<Arc<Engine>>>,
    pub practice: Mutex<Option<Practice>>,
    pub puzzle: Mutex<Option<ActivePuzzle>>,
}

impl AppState {
    pub fn open(data_dir: PathBuf) -> Result<Self> {
        let conn = db::open(&data_dir.join("caissora.db"))?;
        Ok(AppState {
            data_dir,
            db: Mutex::new(conn),
            engine: tokio::sync::Mutex::new(None),
            practice: Mutex::new(None),
            puzzle: Mutex::new(None),
        })
    }
}
