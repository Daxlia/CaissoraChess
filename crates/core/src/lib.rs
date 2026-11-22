//! caissora-core: logica di CaissoraChess indipendente da Tauri (testabile senza WebView).
pub mod chess;
pub mod error;
pub mod id_filter;
pub mod openings;
pub mod puzzle;
pub mod puzzle_index;

pub use error::{Error, Result};
