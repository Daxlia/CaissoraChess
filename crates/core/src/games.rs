//! Archivio delle partite dell'utente. Le mosse vengono rigiocate con le regole prima del
//! salvataggio: nel database non entra mai una partita con mosse illegali.

use crate::chess::Board;
use crate::error::{Error, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Game {
    pub id: i64,
    pub played_at: String,
    pub opponent: String,
    pub engine_elo: Option<i64>,
    pub time_control: String,
    pub user_is_white: bool,
    pub result: String,
    /// Mosse UCI separate da spazi.
    pub moves_uci: String,
}

pub struct NewGame<'a> {
    pub opponent: &'a str,
    pub engine_elo: Option<i64>,
    pub time_control: &'a str,
    pub user_is_white: bool,
    pub result: &'a str,
    pub moves_uci: &'a str,
}

pub fn save(conn: &Connection, g: &NewGame) -> Result<i64> {
    if !matches!(g.result, "1-0" | "0-1" | "1/2-1/2" | "*") {
        return Err(Error::Data(format!("invalid result `{}`", g.result)));
    }
    if g.opponent.len() > 100 || g.time_control.len() > 50 || g.moves_uci.len() > 20_000 {
        return Err(Error::Data("game field too long".into()));
    }
    let mut b = Board::default();
    for m in g.moves_uci.split_whitespace() {
        b.play_uci(m)?; // errore se illegale
    }
    conn.execute(
        "INSERT INTO games(opponent, engine_elo, time_control, user_is_white, result, moves_uci)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![g.opponent, g.engine_elo, g.time_control, g.user_is_white, g.result, g.moves_uci],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list(conn: &Connection, limit: usize) -> Result<Vec<Game>> {
    let mut st = conn.prepare(
        "SELECT id, played_at, opponent, engine_elo, time_control, user_is_white, result, moves_uci
         FROM games ORDER BY id DESC LIMIT ?1",
    )?;
    let rows = st.query_map([limit as i64], |r| {
        Ok(Game {
            id: r.get(0)?, played_at: r.get(1)?, opponent: r.get(2)?, engine_elo: r.get(3)?,
            time_control: r.get(4)?, user_is_white: r.get(5)?, result: r.get(6)?, moves_uci: r.get(7)?,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    fn g<'a>(moves: &'a str, result: &'a str) -> NewGame<'a> {
        NewGame { opponent: "Stockfish", engine_elo: Some(1500), time_control: "10+0", user_is_white: true, result, moves_uci: moves }
    }

    #[test]
    fn saves_and_lists_newest_first() {
        let c = db::open_in_memory().unwrap();
        let a = save(&c, &g("e2e4 e7e5", "*")).unwrap();
        let b = save(&c, &g("d2d4", "1/2-1/2")).unwrap();
        let v = list(&c, 10).unwrap();
        assert_eq!(v.iter().map(|x| x.id).collect::<Vec<_>>(), [b, a]);
        assert_eq!(v[1].moves_uci, "e2e4 e7e5");
        assert!(v[0].user_is_white && v[0].engine_elo == Some(1500));
    }

    #[test]
    fn rejects_illegal_moves_bad_result_and_oversize() {
        let c = db::open_in_memory().unwrap();
        assert!(save(&c, &g("e2e5", "*")).is_err());
        assert!(save(&c, &g("e2e4", "win")).is_err());
        assert!(save(&c, &g(&"e2e4 ".repeat(5000), "*")).is_err());
        assert!(list(&c, 10).unwrap().is_empty());
    }
}
