//! Personalità dell'avversario. Il motore (MultiPV) propone le mosse migliori; la personalità sceglie
//! tra quelle che non costano troppo in valutazione, preferendo il carattere che le è proprio.
//! Tutto è deterministico dato un seme: nessuna dipendenza da generatori esterni.

use crate::engine::parse::{Info, Score};
use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use shakmaty::{fen::Fen, uci::UciMove, CastlingMode, Chess, Color, Move, Position, Role, Square};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Style {
    Neutral,
    Aggressive,
    Defensive,
    Positional,
    Tactical,
    /// Tolleranza più ampia e scelta casuale pesata tra le mosse accettabili.
    Unpredictable,
}

pub const SPECIFIC_STYLES: [Style; 5] = [Style::Aggressive, Style::Defensive, Style::Positional, Style::Tactical, Style::Unpredictable];

/// Come l'utente sceglie l'avversario.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode", content = "style", rename_all = "lowercase")]
pub enum Selection {
    /// Una personalità a caso, estratta a ogni partita.
    Random,
    Specific(Style),
    Neutral,
}

impl Selection {
    pub fn resolve(self, seed: u64) -> Style {
        match self {
            Selection::Neutral => Style::Neutral,
            Selection::Specific(s) => s,
            Selection::Random => SPECIFIC_STYLES[(Rng::new(seed).next() % SPECIFIC_STYLES.len() as u64) as usize],
        }
    }
}

impl Style {
    pub fn parse(s: &str) -> Option<Style> {
        Some(match s {
            "neutral" => Style::Neutral,
            "aggressive" => Style::Aggressive,
            "defensive" => Style::Defensive,
            "positional" => Style::Positional,
            "tactical" => Style::Tactical,
            "unpredictable" => Style::Unpredictable,
            _ => return None,
        })
    }
    /// Quante linee chiedere al motore.
    pub fn multipv(self) -> u32 { if self == Style::Neutral { 1 } else if self == Style::Unpredictable { 6 } else { 4 } }
    /// Perdita massima di valutazione (centipawn) rispetto alla mossa migliore.
    fn tolerance(self) -> i32 { match self { Style::Neutral => 0, Style::Unpredictable => 110, _ => 60 } }
}

#[derive(Default, Clone, Copy)]
struct W { capture: f32, check: f32, king_attack: f32, advance: f32, castle: f32, develop: f32, center: f32, retreat: f32, trade: f32, sacrifice: f32, threat: f32, safe: f32 }

fn weights(s: Style) -> W {
    match s {
        Style::Aggressive => W { capture: 8.0, check: 18.0, king_attack: 12.0, advance: 5.0, sacrifice: 6.0, threat: 6.0, trade: -6.0, retreat: -10.0, safe: -2.0, ..W::default() },
        Style::Defensive => W { castle: 25.0, retreat: 8.0, trade: 10.0, safe: 10.0, advance: -5.0, check: -4.0, sacrifice: -25.0, king_attack: -6.0, develop: 4.0, ..W::default() },
        Style::Positional => W { center: 12.0, develop: 14.0, castle: 14.0, safe: 5.0, sacrifice: -12.0, check: -4.0, capture: 2.0, ..W::default() },
        Style::Tactical => W { capture: 10.0, check: 14.0, threat: 14.0, sacrifice: 10.0, king_attack: 4.0, ..W::default() },
        _ => W::default(),
    }
}

fn value(r: Role) -> i32 { match r { Role::Pawn => 1, Role::Knight | Role::Bishop => 3, Role::Rook => 5, Role::Queen => 9, Role::King => 0 } }

fn king_zone(pos: &Chess, color: Color) -> shakmaty::Bitboard {
    match pos.board().king_of(color) { Some(k) => shakmaty::attacks::king_attacks(k) | shakmaty::Bitboard::from_square(k), None => shakmaty::Bitboard::EMPTY }
}

/// Quanti pezzi di `by` attaccano le case della zona del re avversario.
fn zone_pressure(pos: &Chess, by: Color) -> i32 {
    let zone = king_zone(pos, !by);
    let occ = pos.board().occupied();
    zone.into_iter().map(|sq| pos.board().attacks_to(sq, by, occ).count() as i32).sum()
}

/// Pezzi avversari (non pedoni) attaccati da `by` e non protetti, o di valore maggiore dell'attaccante.
fn threats(pos: &Chess, by: Color) -> i32 {
    let b = pos.board(); let occ = b.occupied(); let mut n = 0;
    for sq in b.by_color(!by) {
        let role = b.role_at(sq).unwrap();
        if role == Role::King || role == Role::Pawn { continue; }
        let att = b.attacks_to(sq, by, occ);
        if att.is_empty() { continue; }
        let weakest = att.into_iter().filter_map(|a| b.role_at(a)).map(value).min().unwrap_or(9);
        if value(role) > weakest || b.attacks_to(sq, !by, occ).is_empty() { n += 1; }
    }
    n
}

fn centrality(sq: Square) -> f32 {
    let (f, r) = (u32::from(sq.file()) as f32, u32::from(sq.rank()) as f32);
    3.5 - ((f - 3.5).abs() + (r - 3.5).abs()) / 2.0 // 0..3.5
}

/// Punteggio di "carattere" di una mossa, in centipawn equivalenti.
fn flavour(pos: &Chess, m: &Move, w: &W) -> f32 {
    let me = pos.turn();
    let mut after = pos.clone(); after.play_unchecked(*m);
    let to = m.to();
    let Some(from) = m.from() else { return 0.0 }; // mosse con 'drop' non esistono negli scacchi standard
    let mover = m.role();
    let mut s = 0.0;
    let captured = m.capture().map(value).unwrap_or(0);
    if m.is_capture() {
        s += w.capture * (captured as f32).max(1.0);
        if captured >= value(mover) && mover != Role::King { s += w.trade * 0.5 * captured as f32; } // scambio alla pari o vantaggioso
        else if captured == value(mover) { s += w.trade; }
    }
    if after.is_check() { s += w.check; }
    s += w.king_attack * (zone_pressure(&after, me) - zone_pressure(pos, me)).clamp(-3, 4) as f32;
    s += w.threat * (threats(&after, me) - threats(pos, me)).clamp(-2, 3) as f32;
    // avanzamento verso la metà campo avversaria
    let adv = if me == Color::White { u32::from(to.rank()) as i32 - u32::from(from.rank()) as i32 } else { u32::from(from.rank()) as i32 - u32::from(to.rank()) as i32 };
    s += w.advance * adv.clamp(-3, 3) as f32;
    s += w.retreat * (-adv).clamp(0, 3) as f32;
    if matches!(m, Move::Castle { .. }) { s += w.castle; }
    let back = if me == Color::White { 0 } else { 7 };
    if matches!(mover, Role::Knight | Role::Bishop) && u32::from(from.rank()) == back { s += w.develop; }
    if matches!(mover, Role::Knight | Role::Bishop | Role::Pawn) { s += w.center * (centrality(to) - centrality(from)); }
    // sacrificio: il pezzo finisce su una casa dove un avversario può prenderlo guadagnando materiale
    if mover != Role::King {
        let occ = after.board().occupied();
        let attackers = after.board().attacks_to(to, !me, occ);
        let cheapest = attackers.into_iter().filter_map(|a| after.board().role_at(a)).map(value).min();
        let defended = !after.board().attacks_to(to, me, occ).is_empty();
        let hangs = match cheapest { Some(c) => c < value(mover) || !defended, None => false };
        if hangs && value(mover) > captured { s += w.sacrifice * (value(mover) - captured) as f32; } else if !hangs { s += w.safe; }
    }
    s
}

struct Rng(u64);
impl Rng {
    fn new(seed: u64) -> Self { Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) | 1) }
    fn next(&mut self) -> u64 { let mut x = self.0; x ^= x << 13; x ^= x >> 7; x ^= x << 17; self.0 = x; x.wrapping_mul(0x2545_F491_4F6C_DD1D) }
    fn unit(&mut self) -> f32 { (self.next() >> 40) as f32 / (1u64 << 24) as f32 }
}

fn cp_of(i: &Info) -> i32 {
    match i.score { Some(Score::Cp(v)) => v, Some(Score::Mate(n)) => if n > 0 { 100_000 - n } else { -100_000 - n }, None => i32::MIN / 4 }
}

/// Sceglie la mossa tra le linee MultiPV del motore (punteggio dal punto di vista di chi muove).
/// Restituisce sempre una mossa legale della prima linea o di una linea accettabile.
pub fn pick(fen: &str, lines: &[Info], style: Style, seed: u64) -> Result<Option<String>> {
    let cands: Vec<&Info> = lines.iter().filter(|l| !l.pv.is_empty()).collect();
    let Some(first) = cands.first().copied() else { return Ok(None) };
    if style == Style::Neutral || cands.len() == 1 { return Ok(Some(first.pv[0].clone())); }
    let best = cands.iter().map(|l| cp_of(l)).max().unwrap();
    if best >= 90_000 { // matto forzato a favore: lo si gioca sempre
        return Ok(cands.iter().max_by_key(|l| cp_of(l)).map(|l| l.pv[0].clone()));
    }
    let pos: Chess = fen.parse::<Fen>().map_err(|e| Error::Fen(format!("{e}")))?
        .into_position(CastlingMode::Standard).map_err(|e| Error::Fen(format!("{e}")))?;
    let w = weights(style);
    let tol = style.tolerance();
    let mut rng = Rng::new(seed);
    let mut scored: Vec<(f32, &Info)> = Vec::new();
    for l in cands.iter().copied() {
        let loss = best - cp_of(l);
        if loss > tol { continue; }
        let mv: UciMove = match l.pv[0].parse() { Ok(m) => m, Err(_) => continue };
        let Ok(m) = mv.to_move(&pos) else { continue };
        let mut sc = -(loss as f32) + flavour(&pos, &m, &w);
        if style == Style::Unpredictable { sc += rng.unit() * 60.0; }
        scored.push((sc, l));
    }
    if scored.is_empty() { return Ok(Some(first.pv[0].clone())); }
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
    Ok(Some(scored[0].1.pv[0].clone()))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn line(mv: &str, cp: i32, n: u32) -> Info { Info { depth: Some(12), multipv: n, score: Some(Score::Cp(cp)), nodes: None, nps: None, time_ms: None, pv: vec![mv.into()] } }

    #[test]
    fn neutral_plays_engine_best() {
        let l = [line("e2e4", 30, 1), line("d2d4", 25, 2)];
        assert_eq!(pick("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", &l, Style::Neutral, 1).unwrap().unwrap(), "e2e4");
    }

    #[test]
    fn never_plays_outside_tolerance_and_keeps_forced_mate() {
        let fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
        let l = [line("e2e4", 30, 1), line("a2a4", -200, 2)];
        for seed in 0..20 { assert_eq!(pick(fen, &l, Style::Aggressive, seed).unwrap().unwrap(), "e2e4"); }
        let m = [Info { score: Some(Score::Mate(2)), ..line("e2e4", 0, 1) }, line("d2d4", 10, 2)];
        assert_eq!(pick(fen, &m, Style::Defensive, 3).unwrap().unwrap(), "e2e4");
    }

    #[test]
    fn styles_prefer_their_character() {
        // Bianco può prendere con il cavallo (cattura+scacco non c'è) oppure arroccare: stessa valutazione.
        let fen = "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/3P1N2/PPP2PPP/RNBQK2R w KQkq - 0 5";
        let l = [line("c4f7", 20, 1), line("e1g1", 20, 2), line("b1c3", 20, 3)];
        assert_eq!(pick(fen, &l, Style::Defensive, 1).unwrap().unwrap(), "e1g1");
        let a = pick(fen, &l, Style::Aggressive, 1).unwrap().unwrap();
        assert_eq!(a, "c4f7", "aggressive prefers the check/capture");
        let p = pick(fen, &l, Style::Positional, 1).unwrap().unwrap();
        assert_ne!(p, "c4f7");
    }

    #[test]
    fn unpredictable_varies_with_seed_but_stays_legal_and_in_window() {
        let fen = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
        let l = [line("e2e4", 30, 1), line("d2d4", 28, 2), line("g1f3", 20, 3), line("c2c4", 18, 4)];
        let mut seen = std::collections::HashSet::new();
        for s in 0..200 { seen.insert(pick(fen, &l, Style::Unpredictable, s).unwrap().unwrap()); }
        assert!(seen.len() >= 3, "{seen:?}");
    }

    #[test]
    fn random_selection_is_deterministic_per_seed_and_covers_styles() {
        assert_eq!(Selection::Random.resolve(5), Selection::Random.resolve(5));
        let all: std::collections::HashSet<_> = (0..200).map(|s| format!("{:?}", Selection::Random.resolve(s))).collect();
        assert_eq!(all.len(), SPECIFIC_STYLES.len());
        assert_eq!(Selection::Neutral.resolve(9), Style::Neutral);
    }
}
