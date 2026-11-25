//! caissora-core: logica di CaissoraChess indipendente da Tauri (testabile senza WebView).
pub mod adaptive;
pub mod chess;
pub mod db;
pub mod download;
pub mod engine;
pub mod error;
pub mod games;
pub mod id_filter;
pub mod openings;
pub mod personality;
pub mod puzzle;
pub mod puzzle_index;
pub mod theme;

pub use error::{Error, Result};
pub use rusqlite; // riesportato: stessa versione ovunque
