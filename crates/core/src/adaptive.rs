//! Difficoltà adattiva tra una partita e l'altra: stima il livello dell'utente dalle ultime partite
//! contro il motore e propone un Elo leggermente sopra di lui, dentro l'intervallo che il motore dichiara.

use crate::games::Game;

/// Punteggio dell'utente (1, 0.5, 0) in una partita contro il motore; `None` se non conclusa o senza Elo.
pub fn user_score(g: &Game) -> Option<(i64, f64)> {
    let elo = g.engine_elo?;
    let s = match (g.result.as_str(), g.user_is_white) {
        ("1-0", true) | ("0-1", false) => 1.0,
        ("0-1", true) | ("1-0", false) => 0.0,
        ("1/2-1/2", _) => 0.5,
        _ => return None,
    };
    Some((elo, s))
}

/// `recent`: partite dalla più recente alla più vecchia. Restituisce l'Elo consigliato, multiplo di 25.
/// Ogni partita dà una "prestazione" (Elo del motore ± 400 per vittoria/sconfitta), pesata di più se recente.
/// Con meno di 2 partite valide si cambia al più di 100 punti; in ogni caso mai più di 200.
pub fn suggest_elo(recent: &[Game], current: i64, min: i64, max: i64, challenge: i64) -> i64 {
    let perf: Vec<f64> = recent.iter().filter_map(user_score).take(10).map(|(e, s)| e as f64 + 800.0 * (s - 0.5)).collect();
    if perf.is_empty() { return current.clamp(min, max); }
    let (mut num, mut den, mut w) = (0.0, 0.0, 1.0);
    for p in &perf { num += p * w; den += w; w *= 0.8; }
    let est = num / den + challenge as f64;
    let step = if perf.len() < 2 { 100.0 } else { 200.0 };
    let target = est.clamp(current as f64 - step, current as f64 + step);
    (((target / 25.0).round() as i64) * 25).clamp(min, max)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn g(elo: i64, white: bool, res: &str) -> Game {
        Game { id: 0, played_at: String::new(), opponent: "e".into(), engine_elo: Some(elo), time_control: "x".into(), user_is_white: white, result: res.into(), moves_uci: String::new() }
    }
    #[test]
    fn wins_raise_and_losses_lower_within_limits() {
        let wins: Vec<Game> = (0..5).map(|_| g(1500, true, "1-0")).collect();
        let up = suggest_elo(&wins, 1500, 1320, 3190, 25);
        assert!(up > 1500 && up <= 1700, "{up}");
        let losses: Vec<Game> = (0..5).map(|_| g(1500, false, "1-0")).collect();
        let down = suggest_elo(&losses, 1500, 1320, 3190, 25);
        assert!(down < 1500 && down >= 1300_i64.max(1320), "{down}");
        assert_eq!(up % 25, 0);
    }
    #[test]
    fn balanced_results_stay_close_and_bounds_hold() {
        let mix = vec![g(1500, true, "1-0"), g(1500, true, "0-1"), g(1500, false, "1/2-1/2"), g(1500, false, "1-0")];
        let n = suggest_elo(&mix, 1500, 1320, 3190, 0);
        assert!((1450..=1550).contains(&n), "{n}");
        assert_eq!(suggest_elo(&[], 9999, 1320, 3190, 25), 3190);
        let unfinished = vec![g(1500, true, "*")];
        assert_eq!(suggest_elo(&unfinished, 1600, 1320, 3190, 25), 1600);
    }
}
