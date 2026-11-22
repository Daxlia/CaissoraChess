use thiserror::Error;

/// Errore unico del core. Serializzabile come stringa verso il frontend.
#[derive(Debug, Error)]
pub enum Error {
    #[error("invalid FEN: {0}")]
    Fen(String),
    #[error("invalid move notation: {0}")]
    MoveParse(String),
    #[error("illegal move: {0}")]
    IllegalMove(String),
    #[error("invalid data: {0}")]
    Data(String),
    #[error("engine error: {0}")]
    Engine(String),
    #[error("engine timeout: {0}")]
    EngineTimeout(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("csv error: {0}")]
    Csv(#[from] csv::Error),
    #[error("parquet error: {0}")]
    Parquet(String),
    #[error("database error: {0}")]
    Db(#[from] rusqlite::Error),
}

pub type Result<T> = std::result::Result<T, Error>;
