//! caissora-core: logica di CaissoraChess indipendente da Tauri (testabile senza WebView).
pub mod chess;
pub mod db;
pub mod download;
pub mod engine;
pub mod error;
pub mod id_filter;
pub mod openings;
pub mod puzzle;
pub mod puzzle_index;

pub use error::{Error, Result};
pub use rusqlite; // riesportato: stessa versione ovunque
