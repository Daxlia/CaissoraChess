//! SQLite: apertura sicura (WAL, foreign keys) e migrazioni versionate con `PRAGMA user_version`.
//! Ogni migrazione gira in una transazione: o si applica per intero o per niente.

use crate::error::{Error, Result};
use rusqlite::Connection;
use std::path::Path;

/// Migrazioni in ordine. NON modificare quelle già pubblicate: aggiungerne di nuove in coda.
const MIGRATIONS: &[&str] = &[
    // v1
    "
    CREATE TABLE settings (
        key   TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
    ) WITHOUT ROWID;

    CREATE TABLE openings (
        id   INTEGER PRIMARY KEY,
        eco  TEXT NOT NULL,
        name TEXT NOT NULL,
        pgn  TEXT NOT NULL,
        uci  TEXT NOT NULL
    );
    CREATE INDEX idx_openings_eco  ON openings(eco);
    CREATE INDEX idx_openings_name ON openings(name COLLATE NOCASE);

    CREATE TABLE saved_openings (
        opening_id INTEGER PRIMARY KEY REFERENCES openings(id) ON DELETE CASCADE,
        saved_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE datasets (
        name       TEXT PRIMARY KEY NOT NULL,
        source_url TEXT NOT NULL,
        bytes      INTEGER NOT NULL,
        sha256     TEXT NOT NULL,
        fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
    ) WITHOUT ROWID;

    CREATE TABLE games (
        id            INTEGER PRIMARY KEY,
        played_at     TEXT NOT NULL DEFAULT (datetime('now')),
        opponent      TEXT NOT NULL,
        engine_elo    INTEGER,
        personality   TEXT,
        time_control  TEXT NOT NULL,
        user_is_white INTEGER NOT NULL CHECK (user_is_white IN (0,1)),
        result        TEXT NOT NULL CHECK (result IN ('1-0','0-1','1/2-1/2','*')),
        moves_uci     TEXT NOT NULL,
        pgn           TEXT,
        analysis_json TEXT
    );
    CREATE INDEX idx_games_played_at ON games(played_at);
    ",
    // v2: temi importati (.cctheme)
    "
    CREATE TABLE themes (
        id               TEXT PRIMARY KEY NOT NULL,
        name             TEXT NOT NULL,
        version          TEXT NOT NULL,
        author           TEXT NOT NULL,
        license          TEXT NOT NULL,
        provides_board   INTEGER NOT NULL CHECK (provides_board IN (0,1)),
        provides_pieces  INTEGER NOT NULL CHECK (provides_pieces IN (0,1)),
        installed_at     TEXT NOT NULL DEFAULT (datetime('now')),
        manifest         TEXT NOT NULL
    ) WITHOUT ROWID;
    ",
    // v3: puzzle importati dalle partizioni scaricate, puzzle salvati, tentativi (statistiche)
    "
    CREATE TABLE puzzles (
        pid          INTEGER PRIMARY KEY,
        id           TEXT NOT NULL UNIQUE,
        partition    INTEGER NOT NULL,
        fen          TEXT NOT NULL,
        moves        TEXT NOT NULL,
        rating       INTEGER NOT NULL,
        popularity   INTEGER NOT NULL,
        nb_plays     INTEGER NOT NULL,
        opening_tags TEXT NOT NULL
    );
    CREATE INDEX idx_puzzles_rating    ON puzzles(rating);
    CREATE INDEX idx_puzzles_partition ON puzzles(partition);
    CREATE TABLE puzzle_theme (
        pid   INTEGER NOT NULL REFERENCES puzzles(pid) ON DELETE CASCADE,
        theme TEXT NOT NULL,
        PRIMARY KEY (theme, pid)
    ) WITHOUT ROWID;
    CREATE TABLE puzzle_partitions (
        n           INTEGER PRIMARY KEY,
        rows        INTEGER NOT NULL,
        bytes       INTEGER NOT NULL,
        sha256      TEXT NOT NULL,
        imported_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE puzzle_saved (
        id       TEXT PRIMARY KEY NOT NULL,
        saved_at TEXT NOT NULL DEFAULT (datetime('now'))
    ) WITHOUT ROWID;
    CREATE TABLE puzzle_attempts (
        id           INTEGER PRIMARY KEY,
        puzzle_id    TEXT NOT NULL,
        attempted_at TEXT NOT NULL DEFAULT (datetime('now')),
        solved       INTEGER NOT NULL CHECK (solved IN (0,1)),
        mistakes     INTEGER NOT NULL,
        ms           INTEGER NOT NULL,
        rating       INTEGER NOT NULL,
        themes       TEXT NOT NULL
    );
    CREATE INDEX idx_attempts_puzzle ON puzzle_attempts(puzzle_id);
    CREATE INDEX idx_attempts_time   ON puzzle_attempts(attempted_at);
    ",
];

pub fn latest_version() -> u32 {
    MIGRATIONS.len() as u32
}

pub fn open(path: &Path) -> Result<Connection> {
    let mut conn = Connection::open(path)?;
    configure(&conn)?;
    migrate(&mut conn)?;
    Ok(conn)
}

pub fn open_in_memory() -> Result<Connection> {
    let mut conn = Connection::open_in_memory()?;
    configure(&conn)?;
    migrate(&mut conn)?;
    Ok(conn)
}

fn configure(conn: &Connection) -> Result<()> {
    conn.pragma_update(None, "foreign_keys", true)?;
    conn.pragma_update(None, "journal_mode", "WAL")?; // sicuro contro chiusure improvvise
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(())
}

pub fn migrate(conn: &mut Connection) -> Result<()> {
    let current: u32 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if current > latest_version() {
        return Err(Error::Data(format!(
            "database version {current} is newer than this app supports ({})",
            latest_version()
        )));
    }
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(current as usize) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", (i + 1) as u32)?;
        tx.commit()?;
    }
    Ok(())
}

pub fn get_setting(conn: &Connection, key: &str) -> Result<Option<String>> {
    match conn.query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| r.get(0)) {
        Ok(v) => Ok(Some(v)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn set_setting(conn: &Connection, key: &str, value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO settings(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_fresh_db_and_is_idempotent() {
        let mut c = open_in_memory().unwrap();
        let v: u32 = c.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, latest_version());
        migrate(&mut c).unwrap(); // seconda volta: nessun effetto, nessun errore
        for t in ["settings", "openings", "saved_openings", "datasets", "games"] {
            c.query_row(&format!("SELECT count(*) FROM {t}"), [], |r| r.get::<_, i64>(0)).unwrap();
        }
    }

    #[test]
    fn refuses_database_from_the_future() {
        let mut c = Connection::open_in_memory().unwrap();
        c.pragma_update(None, "user_version", latest_version() + 1).unwrap();
        assert!(matches!(migrate(&mut c), Err(Error::Data(m)) if m.contains("newer")));
    }

    #[test]
    fn settings_roundtrip_and_upsert() {
        let c = open_in_memory().unwrap();
        assert_eq!(get_setting(&c, "accent").unwrap(), None);
        set_setting(&c, "accent", "#ff8800").unwrap();
        set_setting(&c, "accent", "#00aa55").unwrap();
        assert_eq!(get_setting(&c, "accent").unwrap().as_deref(), Some("#00aa55"));
    }

    #[test]
    fn constraints_are_enforced() {
        let c = open_in_memory().unwrap();
        // risultato non valido
        assert!(c.execute("INSERT INTO games(opponent,time_control,user_is_white,result,moves_uci) VALUES('sf','10+0',1,'win','')", []).is_err());
        // chiave esterna: apertura inesistente
        assert!(c.execute("INSERT INTO saved_openings(opening_id) VALUES (999)", []).is_err());
    }

    #[test]
    fn persists_across_reopen_on_disk() {
        let dir = std::env::temp_dir().join(format!("caissora-db-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("t.db");
        { let c = open(&p).unwrap(); set_setting(&c, "lang", "it").unwrap(); }
        let c = open(&p).unwrap();
        assert_eq!(get_setting(&c, "lang").unwrap().as_deref(), Some("it"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
