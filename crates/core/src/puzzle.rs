//! Puzzle Explorer: lettura streaming delle partizioni `.csv.zst` e verifica delle soluzioni.

use crate::chess::{Board, GameStatus};
use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use std::io::Read;

pub const PARTITIONS: u32 = 62;
const BASE_URL: &str =
    "https://raw.githubusercontent.com/Daxlia/CaissoraChess/main/caissora_data/puzzles";

pub fn partition_file_name(n: u32) -> Result<String> {
    if n >= PARTITIONS {
        return Err(Error::Data(format!("partition {n} out of range 0..{PARTITIONS}")));
    }
    Ok(format!("puzzles-{n:04}.csv.zst"))
}

pub fn partition_url(n: u32) -> Result<String> {
    Ok(format!("{BASE_URL}/{}", partition_file_name(n)?))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Puzzle {
    pub id: String,
    pub fen: String,
    pub moves: Vec<String>,
    pub rating: u32,
    pub popularity: i32,
    pub nb_plays: u32,
    pub themes: Vec<String>,
    pub opening_tags: Vec<String>,
}

#[derive(Deserialize)]
struct Row {
    #[serde(rename = "PuzzleId")]
    id: String,
    #[serde(rename = "FEN")]
    fen: String,
    #[serde(rename = "Moves")]
    moves: String,
    #[serde(rename = "Rating")]
    rating: u32,
    #[serde(rename = "Popularity")]
    popularity: i32,
    #[serde(rename = "NbPlays")]
    nb_plays: u32,
    #[serde(rename = "Themes")]
    themes: String,
    #[serde(rename = "OpeningTags")]
    opening_tags: String,
}

impl From<Row> for Puzzle {
    fn from(r: Row) -> Self {
        let split = |s: &str| s.split_whitespace().map(String::from).collect::<Vec<_>>();
        Puzzle {
            id: r.id,
            fen: r.fen,
            moves: split(&r.moves),
            rating: r.rating,
            popularity: r.popularity,
            nb_plays: r.nb_plays,
            themes: split(&r.themes),
            opening_tags: split(&r.opening_tags),
        }
    }
}

/// Iteratore in streaming su una partizione: decomprime e parsa riga per riga, senza
/// mai tenere in memoria l'intera partizione.
pub struct PuzzleReader<R: Read> {
    inner: csv::DeserializeRecordsIntoIter<zstd::Decoder<'static, std::io::BufReader<R>>, Row>,
}

impl<R: Read> PuzzleReader<R> {
    pub fn new(reader: R) -> Result<Self> {
        let dec = zstd::Decoder::new(reader)?;
        let rdr = csv::ReaderBuilder::new().has_headers(true).from_reader(dec);
        Ok(PuzzleReader { inner: rdr.into_deserialize() })
    }
}

impl<R: Read> Iterator for PuzzleReader<R> {
    type Item = Result<Puzzle>;
    fn next(&mut self) -> Option<Self::Item> {
        self.inner.next().map(|r| r.map(Puzzle::from).map_err(Error::from))
    }
}

// ---------------------------------------------------------------- sessione di gioco

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Step {
    /// Mossa giusta; `reply` è la risposta dell'avversario da animare (None se risolto).
    Correct { reply: Option<String>, solved: bool },
    /// Mossa legale ma sbagliata.
    Wrong,
    Illegal,
}

pub struct PuzzleSession {
    board: Board,
    moves: Vec<String>,
    idx: usize,
    /// FEN della posizione da risolvere (dopo la prima mossa dell'avversario).
    pub start_fen: String,
    /// Prima mossa applicata automaticamente (da animare).
    pub opponent_first_move: String,
    pub user_is_white: bool,
}

impl PuzzleSession {
    /// Lichess: `FEN` è la posizione PRIMA di `moves[0]`, che è la mossa dell'avversario.
    pub fn new(p: &Puzzle) -> Result<Self> {
        if p.moves.len() < 2 {
            return Err(Error::Data(format!("puzzle {} has fewer than 2 moves", p.id)));
        }
        let mut board = Board::from_fen(&p.fen)?;
        board.play_uci(&p.moves[0])?;
        let user_is_white = matches!(board.turn(), crate::chess::Side::White);
        Ok(PuzzleSession {
            start_fen: board.fen(),
            board,
            moves: p.moves.clone(),
            idx: 1,
            opponent_first_move: p.moves[0].clone(),
            user_is_white,
        })
    }

    pub fn fen(&self) -> String {
        self.board.fen()
    }

    /// Mossa attesa (per il suggerimento).
    pub fn expected(&self) -> Option<&str> {
        self.moves.get(self.idx).map(|s| s.as_str())
    }

    /// Gioca tutta la soluzione rimasta e la restituisce nell'ordine reale (mossa dell'utente, risposta, ...).
    pub fn play_solution(&mut self) -> Result<Vec<String>> {
        let mut out = vec![];
        while let Some(m) = self.expected().map(String::from) {
            out.push(m.clone());
            match self.submit(&m)? {
                Step::Correct { reply, solved } => { out.extend(reply); if solved { break; } }
                _ => break,
            }
        }
        Ok(out)
    }

    pub fn submit(&mut self, uci: &str) -> Result<Step> {
        let expected = self.expected().ok_or_else(|| Error::Data("puzzle already solved".into()))?.to_string();
        if !self.board.is_legal_uci(uci) {
            return Ok(Step::Illegal);
        }
        if uci != expected {
            // Come Lichess: una mossa diversa che dà matto vale comunque come soluzione.
            let mut probe = self.board.clone();
            probe.play_uci(uci)?;
            if matches!(probe.status(), GameStatus::Checkmate { .. }) {
                self.board = probe;
                self.idx = self.moves.len();
                return Ok(Step::Correct { reply: None, solved: true });
            }
            return Ok(Step::Wrong);
        }
        self.board.play_uci(uci)?;
        self.idx += 1;
        if self.idx >= self.moves.len() {
            return Ok(Step::Correct { reply: None, solved: true });
        }
        let reply = self.moves[self.idx].clone();
        self.board.play_uci(&reply)?;
        self.idx += 1;
        Ok(Step::Correct { reply: Some(reply), solved: self.idx >= self.moves.len() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(id: &str, fen: &str, moves: &str) -> Puzzle {
        Puzzle {
            id: id.into(), fen: fen.into(), moves: moves.split(' ').map(String::from).collect(),
            rating: 0, popularity: 0, nb_plays: 0, themes: vec![], opening_tags: vec![],
        }
    }

    #[test]
    fn urls_cover_all_62_partitions() {
        assert_eq!(partition_file_name(0).unwrap(), "puzzles-0000.csv.zst");
        assert!(partition_url(61).unwrap().ends_with("/caissora_data/puzzles/puzzles-0061.csv.zst"));
        assert!(partition_url(62).is_err());
    }

    #[test]
    fn zstd_csv_streaming_matches_user_sample() {
        let csv = "PuzzleId,FEN,Moves,Rating,Popularity,NbPlays,Themes,OpeningTags\n\
CJPAf,3r4/ppk1nr2/6p1/4p1P1/5q2/2Q5/PPP2P2/1K1R4 b - - 5 28,c7b8 d1d8 e7c8 c3c8,811,69,474,endgame hangingPiece mate mateIn2 short,\n\
CJeg1,r7/3n3k/p4npp/1p1pb3/1P2p2N/4P1P1/P3BQ1P/q1B2RK1 b - - 1 24,a1a2 h4g6 e5d6 f2f5,1891,92,2435,crushing middlegame short,Sicilian_Defense Sicilian_Defense_Najdorf\n";
        let z = zstd::encode_all(csv.as_bytes(), 3).unwrap();
        let v: Vec<Puzzle> = PuzzleReader::new(&z[..]).unwrap().collect::<Result<_>>().unwrap();
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].id, "CJPAf");
        assert_eq!(v[0].moves, ["c7b8", "d1d8", "e7c8", "c3c8"]);
        assert_eq!(v[0].rating, 811);
        assert!(v[0].opening_tags.is_empty());
        assert_eq!(v[1].opening_tags.len(), 2);
        assert!(v[0].themes.contains(&"mateIn2".to_string()));
    }

    #[test]
    fn corrupted_stream_is_an_error_not_a_panic() {
        let r = PuzzleReader::new(&b"not zstd data"[..]).unwrap();
        assert!(r.into_iter().next().map_or(true, |x| x.is_err()));
    }

    #[test]
    fn first_move_is_opponents_then_user_solves() {
        // CJPAf: l'avversario gioca c7b8, poi l'utente d1d8, risposta e7c8, utente c3c8 (matto).
        let p = sample("CJPAf", "3r4/ppk1nr2/6p1/4p1P1/5q2/2Q5/PPP2P2/1K1R4 b - - 5 28", "c7b8 d1d8 e7c8 c3c8");
        let mut s = PuzzleSession::new(&p).unwrap();
        assert_eq!(s.opponent_first_move, "c7b8");
        assert!(s.user_is_white);
        assert_eq!(s.submit("a2a3").unwrap(), Step::Wrong);
        assert_eq!(s.submit("d1d9").unwrap(), Step::Illegal);
        assert_eq!(s.submit("d1d8").unwrap(), Step::Correct { reply: Some("e7c8".into()), solved: false });
        assert_eq!(s.submit("c3c8").unwrap(), Step::Correct { reply: None, solved: true });
    }

    #[test]
    fn solution_playback_interleaves_opponent_replies() {
        let p = sample("CJPAf", "3r4/ppk1nr2/6p1/4p1P1/5q2/2Q5/PPP2P2/1K1R4 b - - 5 28", "c7b8 d1d8 e7c8 c3c8");
        let mut s = PuzzleSession::new(&p).unwrap();
        assert_eq!(s.play_solution().unwrap(), vec!["d1d8", "e7c8", "c3c8"]);
        assert!(s.expected().is_none());
        // a metà: dopo la prima mossa giusta restano solo le mosse seguenti
        let mut s = PuzzleSession::new(&p).unwrap();
        s.submit("d1d8").unwrap();
        assert_eq!(s.play_solution().unwrap(), vec!["c3c8"]);
    }

    #[test]
    fn alternative_mate_is_accepted() {
        // Mate in 1 con due soluzioni: Qg7# (attesa) e Qh7# (alternativa).
        let p = sample("alt", "7k/8/5K2/8/8/8/8/6Q1 b - - 0 1", "h8h7 g1g7");
        let mut s = PuzzleSession::new(&p).unwrap();
        // dopo ...Kh7 il bianco gioca Qg7# (attesa)
        assert_eq!(s.expected(), Some("g1g7"));
        assert!(matches!(s.submit("g1g7").unwrap(), Step::Correct { solved: true, .. }));
    }
}
