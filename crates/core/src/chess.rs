//! Wrapper sottile sulle regole (shakmaty). Tutta la verifica delle mosse passa da qui:
//! il frontend non implementa mai regole scacchistiche.

use crate::error::{Error, Result};
use shakmaty::{
    fen::Fen, san::San, uci::UciMove, CastlingMode, Chess, Color, EnPassantMode, Move, Position,
};
use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GameStatus {
    Ongoing,
    Checkmate { winner: Side },
    Stalemate,
    InsufficientMaterial,
}

/// Patta rivendicabile/automatica dovuta alla storia della partita.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DrawKind {
    ThreefoldRepetition,
    FiftyMoveRule,
}

/// Rigioca `moves` dalla posizione iniziale e dice se la posizione finale è una patta per
/// triplice ripetizione o per la regola delle 50 mosse (100 semimosse senza cattura né pedone).
pub fn history_draw(moves: &[String]) -> Result<Option<DrawKind>> {
    let mut b = Board::default();
    let mut seen: HashMap<String, u32> = HashMap::new();
    seen.insert(b.repetition_key(), 1);
    let mut last = 1;
    for m in moves {
        b.play_uci(m)?;
        let c = seen.entry(b.repetition_key()).or_insert(0);
        *c += 1;
        last = *c;
    }
    if last >= 3 {
        return Ok(Some(DrawKind::ThreefoldRepetition));
    }
    if b.halfmove_clock() >= 100 {
        return Ok(Some(DrawKind::FiftyMoveRule));
    }
    Ok(None)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Side {
    White,
    Black,
}

impl From<Color> for Side {
    fn from(c: Color) -> Self {
        if c.is_white() { Side::White } else { Side::Black }
    }
}

#[derive(Clone, Debug)]
pub struct Board {
    pos: Chess,
}

impl Default for Board {
    fn default() -> Self {
        Board { pos: Chess::default() }
    }
}

impl Board {
    pub fn from_fen(fen: &str) -> Result<Self> {
        let f: Fen = fen.parse().map_err(|e| Error::Fen(format!("{e}")))?;
        let pos = f
            .into_position(CastlingMode::Standard)
            .map_err(|e| Error::Fen(format!("{e}")))?;
        Ok(Board { pos })
    }

    pub fn fen(&self) -> String {
        Fen::from_position(&self.pos, EnPassantMode::Legal).to_string()
    }

    pub fn turn(&self) -> Side {
        self.pos.turn().into()
    }

    /// Tutte le mosse legali in notazione UCI (es. `e2e4`, `e7e8q`).
    pub fn legal_uci(&self) -> Vec<String> {
        self.pos
            .legal_moves()
            .iter()
            .map(|m| m.to_uci(CastlingMode::Standard).to_string())
            .collect()
    }

    fn parse_uci(&self, s: &str) -> Result<Move> {
        let u: UciMove = s.parse().map_err(|_| Error::MoveParse(s.into()))?;
        u.to_move(&self.pos).map_err(|_| Error::IllegalMove(s.into()))
    }

    fn parse_san(&self, s: &str) -> Result<Move> {
        let san: San = s.parse().map_err(|_| Error::MoveParse(s.into()))?;
        san.to_move(&self.pos).map_err(|_| Error::IllegalMove(s.into()))
    }

    pub fn is_legal_uci(&self, s: &str) -> bool {
        self.parse_uci(s).is_ok()
    }

    /// Gioca una mossa UCI e restituisce la sua SAN.
    pub fn play_uci(&mut self, s: &str) -> Result<String> {
        let m = self.parse_uci(s)?;
        let san = San::from_move(&self.pos, m).to_string();
        self.pos.play_unchecked(m);
        Ok(san)
    }

    /// Gioca una mossa SAN e restituisce la sua forma UCI.
    pub fn play_san(&mut self, s: &str) -> Result<String> {
        let m = self.parse_san(s)?;
        let uci = m.to_uci(CastlingMode::Standard).to_string();
        self.pos.play_unchecked(m);
        Ok(uci)
    }

    pub fn is_check(&self) -> bool {
        self.pos.is_check()
    }

    /// Casella del re del lato al tratto se è sotto scacco (per evidenziarla).
    pub fn checked_king_square(&self) -> Option<String> {
        if !self.pos.is_check() {
            return None;
        }
        self.pos.board().king_of(self.pos.turn()).map(|s| s.to_string())
    }

    /// Chiave di ripetizione: pezzi, turno, diritti di arrocco, en passant legale.
    fn repetition_key(&self) -> String {
        self.fen().split(' ').take(4).collect::<Vec<_>>().join(" ")
    }

    pub fn halfmove_clock(&self) -> u32 {
        self.pos.halfmoves()
    }

    pub fn status(&self) -> GameStatus {
        if self.pos.is_checkmate() {
            // Chi deve muovere è matto: vince l'altro.
            let winner = match self.pos.turn() {
                Color::White => Side::Black,
                Color::Black => Side::White,
            };
            GameStatus::Checkmate { winner }
        } else if self.pos.is_stalemate() {
            GameStatus::Stalemate
        } else if self.pos.is_insufficient_material() {
            GameStatus::InsufficientMaterial
        } else {
            GameStatus::Ongoing
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_position_has_20_moves() {
        assert_eq!(Board::default().legal_uci().len(), 20);
    }

    #[test]
    fn fen_roundtrip() {
        let f = "r2qkb1r/pp1b4/5p2/4p2p/5npP/1P3BQ1/PBPN1PP1/R4RK1 w kq - 0 17";
        assert_eq!(Board::from_fen(f).unwrap().fen(), f);
    }

    #[test]
    fn rejects_bad_fen() {
        assert!(Board::from_fen("not a fen").is_err());
    }

    #[test]
    fn illegal_vs_unparseable() {
        let mut b = Board::default();
        assert!(matches!(b.play_uci("e2e5"), Err(Error::IllegalMove(_))));
        assert!(matches!(b.play_uci("zz"), Err(Error::MoveParse(_))));
        assert_eq!(b.play_uci("e2e4").unwrap(), "e4");
    }

    #[test]
    fn castling_is_uci_king_two_squares() {
        let mut b = Board::from_fen("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1").unwrap();
        assert!(b.is_legal_uci("e1g1"));
        assert_eq!(b.play_uci("e1g1").unwrap(), "O-O");
        assert_eq!(b.play_san("O-O-O").unwrap(), "e8c8");
    }

    #[test]
    fn promotion() {
        let mut b = Board::from_fen("8/P6k/8/8/8/8/8/K7 w - - 0 1").unwrap();
        assert!(b.is_legal_uci("a7a8q"));
        assert!(!b.is_legal_uci("a7a8"));
        assert_eq!(b.play_uci("a7a8n").unwrap(), "a8=N");
    }

    #[test]
    fn fools_mate_is_checkmate() {
        let mut b = Board::default();
        for m in ["f2f3", "e7e5", "g2g4", "d8h4"] {
            b.play_uci(m).unwrap();
        }
        assert!(b.is_check());
        assert_eq!(b.status(), GameStatus::Checkmate { winner: Side::Black });
    }

    #[test]
    fn threefold_repetition_from_history() {
        let sh = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        // Cc3 Cc6 Cb1 Cb8 ripetuto: la posizione iniziale compare 3 volte dopo 8 semimosse
        let one = ["g1f3", "g8f6", "f3g1", "f6g8"];
        let mut v = sh(&one);
        assert_eq!(history_draw(&v).unwrap(), None); // 2 occorrenze
        v.extend(sh(&one));
        assert_eq!(history_draw(&v).unwrap(), Some(DrawKind::ThreefoldRepetition));
        assert_eq!(history_draw(&[]).unwrap(), None);
        assert!(history_draw(&sh(&["e2e5"])).is_err());
    }

    #[test]
    fn checked_king_square_and_clock() {
        let mut b = Board::default();
        assert_eq!(b.checked_king_square(), None);
        for m in ["f2f3", "e7e5", "g2g4", "d8h4"] { b.play_uci(m).unwrap(); }
        assert_eq!(b.checked_king_square().as_deref(), Some("e1"));
        let c = Board::from_fen("8/8/4k3/8/8/4K3/8/7R w - - 99 80").unwrap();
        assert_eq!(c.halfmove_clock(), 99);
    }

    #[test]
    fn stalemate_and_insufficient() {
        assert_eq!(
            Board::from_fen("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1").unwrap().status(),
            GameStatus::Stalemate
        );
        assert_eq!(
            Board::from_fen("8/8/8/4k3/8/8/3K4/8 w - - 0 1").unwrap().status(),
            GameStatus::InsufficientMaterial
        );
    }
}
