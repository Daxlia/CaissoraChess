use caissora_core::{db, engine::Engine, openings::Practice, Result};
use caissora_core::rusqlite::Connection;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

pub struct AppState {
    pub data_dir: PathBuf,
    pub db: Mutex<Connection>,
    pub engine: tokio::sync::Mutex<Option<Arc<Engine>>>,
    pub practice: Mutex<Option<Practice>>,
}

impl AppState {
    pub fn open(data_dir: PathBuf) -> Result<Self> {
        let conn = db::open(&data_dir.join("caissora.db"))?;
        Ok(AppState {
            data_dir,
            db: Mutex::new(conn),
            engine: tokio::sync::Mutex::new(None),
            practice: Mutex::new(None),
        })
    }
}
