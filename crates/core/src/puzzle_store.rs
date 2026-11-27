//! Archivio locale dei puzzle: importa in SQLite le partizioni scaricate (i file originali non vengono
//! mai modificati), filtra per rating/tema/apertura, tiene i puzzle salvati e le statistiche dei tentativi.

use crate::error::{Error, Result};
use crate::puzzle::{Puzzle, PuzzleReader, PARTITIONS};
use rusqlite::{params, params_from_iter, types::Value, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Query {
    pub rating_min: Option<u32>,
    pub rating_max: Option<u32>,
    /// Il puzzle deve avere TUTTI questi temi.
    #[serde(default)]
    pub themes: Vec<String>,
    pub opening_tag: Option<String>,
    pub partition: Option<u32>,
    #[serde(default)]
    pub saved_only: bool,
    /// Esclude i puzzle già risolti almeno una volta.
    #[serde(default)]
    pub unsolved_only: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub struct Summary {
    pub id: String,
    pub partition: u32,
    pub rating: u32,
    pub themes: Vec<String>,
    pub opening_tags: Vec<String>,
    pub saved: bool,
    pub solved: bool,
}

/// Un tema o tag valido contiene solo lettere, cifre e `_` `-`: il valore entra in `LIKE`/confronti ma sempre come parametro.
fn clean(s: &str) -> Result<&str> {
    if s.is_empty() || s.len() > 60 || !s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
        return Err(Error::Data(format!("invalid filter value `{s}`")));
    }
    Ok(s)
}

/// Importa (sostituendo) una partizione. Restituisce il numero di puzzle. Una partizione corrotta non lascia dati a metà.
pub fn import_partition(conn: &mut Connection, n: u32, path: &Path, bytes: u64, sha256: &str) -> Result<u32> {
    if n >= PARTITIONS { return Err(Error::Data(format!("partition {n} out of range"))); }
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM puzzles WHERE partition = ?1", [n])?;
    let mut rows = 0u32;
    {
        let mut ins = tx.prepare("INSERT OR IGNORE INTO puzzles(id, partition, fen, moves, rating, popularity, nb_plays, opening_tags) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)")?;
        let mut th = tx.prepare("INSERT OR IGNORE INTO puzzle_theme(pid, theme) VALUES (?1, ?2)")?;
        for p in PuzzleReader::new(std::fs::File::open(path)?)? {
            let p = p?;
            if p.moves.len() < 2 || p.id.len() > 16 { return Err(Error::Data(format!("malformed puzzle `{}` in partition {n}", p.id))); }
            let added = ins.execute(params![p.id, n, p.fen, p.moves.join(" "), p.rating, p.popularity, p.nb_plays, p.opening_tags.join(" ")])?;
            if added == 1 {
                let pid = tx.last_insert_rowid();
                for t in &p.themes { th.execute(params![pid, t])?; }
                rows += 1;
            }
        }
    }
    if rows == 0 { return Err(Error::Data(format!("partition {n} is empty"))); }
    tx.execute("INSERT INTO puzzle_partitions(n, rows, bytes, sha256) VALUES (?1,?2,?3,?4)
                ON CONFLICT(n) DO UPDATE SET rows=excluded.rows, bytes=excluded.bytes, sha256=excluded.sha256, imported_at=datetime('now')",
               params![n, rows, bytes as i64, sha256])?;
    tx.commit()?;
    Ok(rows)
}

pub fn remove_partition(conn: &mut Connection, n: u32) -> Result<()> {
    let tx = conn.transaction()?;
    tx.execute("DELETE FROM puzzles WHERE partition = ?1", [n])?;
    tx.execute("DELETE FROM puzzle_partitions WHERE n = ?1", [n])?;
    tx.commit()?;
    Ok(())
}

pub fn installed(conn: &Connection) -> Result<Vec<(u32, u32)>> {
    let mut st = conn.prepare("SELECT n, rows FROM puzzle_partitions ORDER BY n")?;
    let v = st.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(v)
}

fn where_clause(q: &Query) -> Result<(String, Vec<Value>)> {
    let mut sql = String::from(" WHERE 1=1");
    let mut args: Vec<Value> = vec![];
    if let Some(v) = q.rating_min { sql.push_str(" AND p.rating >= ?"); args.push(Value::Integer(v as i64)); }
    if let Some(v) = q.rating_max { sql.push_str(" AND p.rating <= ?"); args.push(Value::Integer(v as i64)); }
    if let Some(v) = q.partition { sql.push_str(" AND p.partition = ?"); args.push(Value::Integer(v as i64)); }
    for t in &q.themes {
        sql.push_str(" AND EXISTS (SELECT 1 FROM puzzle_theme t WHERE t.pid = p.pid AND t.theme = ?)");
        args.push(Value::Text(clean(t)?.to_string()));
    }
    if let Some(t) = &q.opening_tag {
        sql.push_str(" AND (' ' || p.opening_tags || ' ') LIKE ?");
        args.push(Value::Text(format!("% {} %", clean(t)?)));
    }
    if q.saved_only { sql.push_str(" AND p.id IN (SELECT id FROM puzzle_saved)"); }
    if q.unsolved_only { sql.push_str(" AND p.id NOT IN (SELECT puzzle_id FROM puzzle_attempts WHERE solved = 1)"); }
    Ok((sql, args))
}

pub fn count(conn: &Connection, q: &Query) -> Result<u64> {
    let (w, a) = where_clause(q)?;
    Ok(conn.query_row(&format!("SELECT count(*) FROM puzzles p{w}"), params_from_iter(a), |r| r.get::<_, i64>(0))? as u64)
}

fn summaries(conn: &Connection, sql: &str, args: Vec<Value>) -> Result<Vec<Summary>> {
    let mut st = conn.prepare(sql)?;
    let rows = st.query_map(params_from_iter(args), |r| {
        let split = |s: String| s.split_whitespace().map(String::from).collect::<Vec<_>>();
        Ok((r.get::<_, i64>(0)?, Summary {
            id: r.get(1)?, partition: r.get(2)?, rating: r.get(3)?, themes: vec![], opening_tags: split(r.get(4)?),
            saved: r.get::<_, i64>(5)? == 1, solved: r.get::<_, i64>(6)? == 1,
        }))
    })?.collect::<std::result::Result<Vec<_>, _>>()?;
    let mut th = conn.prepare("SELECT theme FROM puzzle_theme WHERE pid = ?1 ORDER BY theme")?;
    let mut out = vec![];
    for (pid, mut s) in rows {
        s.themes = th.query_map([pid], |r| r.get(0))?.collect::<std::result::Result<_, _>>()?;
        out.push(s);
    }
    Ok(out)
}

const COLS: &str = "SELECT p.pid, p.id, p.partition, p.rating, p.opening_tags,
    EXISTS(SELECT 1 FROM puzzle_saved s WHERE s.id = p.id),
    EXISTS(SELECT 1 FROM puzzle_attempts a WHERE a.puzzle_id = p.id AND a.solved = 1)
    FROM puzzles p";

pub fn list(conn: &Connection, q: &Query, limit: usize, offset: usize) -> Result<Vec<Summary>> {
    let (w, mut a) = where_clause(q)?;
    a.push(Value::Integer(limit.min(200) as i64)); a.push(Value::Integer(offset as i64));
    summaries(conn, &format!("{COLS}{w} ORDER BY p.rating, p.id LIMIT ? OFFSET ?"), a)
}

/// Un puzzle a caso tra quelli che rispettano il filtro. `seed` rende la scelta riproducibile nei test.
pub fn random(conn: &Connection, q: &Query, seed: u64) -> Result<Option<Puzzle>> {
    let n = count(conn, q)?;
    if n == 0 { return Ok(None); }
    let off = (seed.wrapping_mul(0x9E37_79B9_7F4A_7C15) >> 11) % n;
    let (w, mut a) = where_clause(q)?;
    a.push(Value::Integer(off as i64));
    let pid: i64 = conn.query_row(&format!("SELECT p.pid FROM puzzles p{w} ORDER BY p.pid LIMIT 1 OFFSET ?"), params_from_iter(a), |r| r.get(0))?;
    get_by_pid(conn, pid)
}

fn get_by_pid(conn: &Connection, pid: i64) -> Result<Option<Puzzle>> {
    load(conn, "p.pid = ?1", rusqlite::types::Value::Integer(pid))
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<Puzzle>> {
    load(conn, "p.id = ?1", rusqlite::types::Value::Text(id.to_string()))
}

fn load(conn: &Connection, cond: &str, arg: Value) -> Result<Option<Puzzle>> {
    let row = conn.query_row(
        &format!("SELECT p.pid, p.id, p.fen, p.moves, p.rating, p.popularity, p.nb_plays, p.opening_tags FROM puzzles p WHERE {cond}"),
        [arg], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, u32>(4)?, r.get::<_, i32>(5)?, r.get::<_, u32>(6)?, r.get::<_, String>(7)?)));
    let (pid, id, fen, moves, rating, popularity, nb_plays, tags) = match row {
        Ok(v) => v, Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None), Err(e) => return Err(e.into()),
    };
    let themes = conn.prepare("SELECT theme FROM puzzle_theme WHERE pid = ?1 ORDER BY theme")?.query_map([pid], |r| r.get(0))?.collect::<std::result::Result<Vec<String>, _>>()?;
    let split = |s: &str| s.split_whitespace().map(String::from).collect::<Vec<_>>();
    Ok(Some(Puzzle { id, fen, moves: split(&moves), rating, popularity, nb_plays, themes, opening_tags: split(&tags) }))
}

/// Temi presenti nelle partizioni installate, con conteggio.
pub fn theme_counts(conn: &Connection) -> Result<Vec<(String, u64)>> {
    let mut st = conn.prepare("SELECT theme, count(*) FROM puzzle_theme GROUP BY theme ORDER BY theme")?;
    let v = st.query_map([], |r| Ok((r.get(0)?, r.get::<_, i64>(1)? as u64)))?.collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(v)
}

pub fn set_saved(conn: &Connection, id: &str, saved: bool) -> Result<()> {
    if get(conn, id)?.is_none() { return Err(Error::Data(format!("unknown puzzle `{id}`"))); }
    if saved { conn.execute("INSERT OR IGNORE INTO puzzle_saved(id) VALUES (?1)", [id])?; }
    else { conn.execute("DELETE FROM puzzle_saved WHERE id = ?1", [id])?; }
    Ok(())
}

pub fn record_attempt(conn: &Connection, p: &Puzzle, solved: bool, mistakes: u32, ms: u64) -> Result<()> {
    conn.execute("INSERT INTO puzzle_attempts(puzzle_id, solved, mistakes, ms, rating, themes) VALUES (?1,?2,?3,?4,?5,?6)",
        params![p.id, solved, mistakes, ms.min(86_400_000) as i64, p.rating, p.themes.join(" ")])?;
    Ok(())
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct ThemeStat { pub theme: String, pub attempts: u32, pub solved: u32 }
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Stats {
    pub attempts: u32,
    pub solved: u32,
    /// Risolti al primo tentativo, senza errori.
    pub clean: u32,
    pub streak: u32,
    pub avg_ms: u32,
    /// Rating medio dei puzzle risolti negli ultimi 20 tentativi.
    pub recent_solved_rating: Option<u32>,
    pub by_theme: Vec<ThemeStat>,
    pub saved: u32,
}

pub fn stats(conn: &Connection) -> Result<Stats> {
    let (attempts, solved, clean, avg): (u32, u32, u32, f64) = conn.query_row(
        "SELECT count(*), coalesce(sum(solved),0), coalesce(sum(solved=1 AND mistakes=0),0), coalesce(avg(ms),0) FROM puzzle_attempts",
        [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
    let mut streak = 0u32;
    let mut st = conn.prepare("SELECT solved FROM puzzle_attempts ORDER BY id DESC")?;
    for s in st.query_map([], |r| r.get::<_, i64>(0))? { if s? == 1 { streak += 1 } else { break } }
    let recent: Option<f64> = conn.query_row("SELECT avg(rating) FROM (SELECT rating FROM puzzle_attempts WHERE solved=1 ORDER BY id DESC LIMIT 20)", [], |r| r.get(0))?;
    let mut by: std::collections::BTreeMap<String, (u32, u32)> = Default::default();
    let mut st = conn.prepare("SELECT themes, solved FROM puzzle_attempts")?;
    for r in st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
        let (themes, s) = r?;
        for t in themes.split_whitespace() { let e = by.entry(t.to_string()).or_default(); e.0 += 1; e.1 += s as u32; }
    }
    let mut by_theme: Vec<ThemeStat> = by.into_iter().map(|(theme, (attempts, solved))| ThemeStat { theme, attempts, solved }).collect();
    by_theme.sort_by(|a, b| b.attempts.cmp(&a.attempts).then(a.theme.cmp(&b.theme)));
    let saved = conn.query_row("SELECT count(*) FROM puzzle_saved", [], |r| r.get(0))?;
    Ok(Stats { attempts, solved, clean, streak, avg_ms: avg as u32, recent_solved_rating: recent.map(|v| v.round() as u32), by_theme, saved })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;
    use std::io::Write;

    fn partition_file(dir: &Path, name: &str, rows: &[(&str, &str, u32, &str, &str)]) -> std::path::PathBuf {
        let mut csv = String::from("PuzzleId,FEN,Moves,Rating,RatingDeviation,Popularity,NbPlays,Themes,GameUrl,OpeningTags\n");
        for (id, mv, rating, themes, tags) in rows {
            csv.push_str(&format!("{id},rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1,{mv},{rating},75,90,100,{themes},https://lichess.org/x,{tags}\n"));
        }
        let p = dir.join(name);
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(&zstd::encode_all(csv.as_bytes(), 3).unwrap()).unwrap();
        p
    }

    fn setup() -> (tempfile::TempDir, Connection) {
        let dir = tempfile::tempdir().unwrap();
        let mut c = db::open(&dir.path().join("t.db")).unwrap();
        let a = partition_file(dir.path(), "a.zst", &[
            ("aaaaa", "e2e4 e7e5", 800, "mate mateIn1 short", "Sicilian_Defense"),
            ("bbbbb", "d2d4 d7d5", 1500, "fork middlegame", "Italian_Game"),
        ]);
        let b = partition_file(dir.path(), "b.zst", &[("ccccc", "g1f3 g8f6", 2200, "mate endgame", "")]);
        import_partition(&mut c, 0, &a, 1, "x").unwrap();
        import_partition(&mut c, 1, &b, 1, "y").unwrap();
        (dir, c)
    }

    #[test]
    fn imports_and_filters_by_every_criterion() {
        let (_d, c) = setup();
        assert_eq!(installed(&c).unwrap(), vec![(0, 2), (1, 1)]);
        assert_eq!(count(&c, &Query::default()).unwrap(), 3);
        assert_eq!(count(&c, &Query { themes: vec!["mate".into()], ..Default::default() }).unwrap(), 2);
        assert_eq!(count(&c, &Query { themes: vec!["mate".into(), "endgame".into()], ..Default::default() }).unwrap(), 1);
        assert_eq!(count(&c, &Query { rating_min: Some(1000), rating_max: Some(1600), ..Default::default() }).unwrap(), 1);
        assert_eq!(count(&c, &Query { opening_tag: Some("Sicilian_Defense".into()), ..Default::default() }).unwrap(), 1);
        assert_eq!(count(&c, &Query { opening_tag: Some("Sicilian".into()), ..Default::default() }).unwrap(), 0, "tag must match whole word");
        assert_eq!(count(&c, &Query { partition: Some(1), ..Default::default() }).unwrap(), 1);
        let l = list(&c, &Query::default(), 10, 0).unwrap();
        assert_eq!(l.iter().map(|s| s.rating).collect::<Vec<_>>(), vec![800, 1500, 2200]);
        assert_eq!(l[0].themes, vec!["mate", "mateIn1", "short"]);
    }

    #[test]
    fn rejects_hostile_filter_values() {
        let (_d, c) = setup();
        for bad in ["a' OR '1'='1", "", "x y", "%"] {
            assert!(count(&c, &Query { themes: vec![bad.into()], ..Default::default() }).is_err(), "{bad}");
            assert!(count(&c, &Query { opening_tag: Some(bad.into()), ..Default::default() }).is_err(), "{bad}");
        }
    }

    #[test]
    fn reimport_replaces_and_remove_cascades() {
        let (d, mut c) = setup();
        let a2 = partition_file(d.path(), "a2.zst", &[("aaaaa", "e2e4 e7e5", 810, "mate", "")]);
        assert_eq!(import_partition(&mut c, 0, &a2, 1, "z").unwrap(), 1);
        assert_eq!(count(&c, &Query::default()).unwrap(), 2);
        assert_eq!(theme_counts(&c).unwrap().iter().find(|t| t.0 == "fork"), None, "old themes are gone");
        remove_partition(&mut c, 1).unwrap();
        assert_eq!(installed(&c).unwrap(), vec![(0, 1)]);
        let orphans: i64 = c.query_row("SELECT count(*) FROM puzzle_theme", [], |r| r.get(0)).unwrap();
        assert_eq!(orphans, 1);
    }

    #[test]
    fn corrupt_partition_leaves_previous_data_untouched() {
        let (d, mut c) = setup();
        let bad = d.path().join("bad.zst");
        std::fs::write(&bad, b"not zstd").unwrap();
        assert!(import_partition(&mut c, 0, &bad, 1, "z").is_err());
        assert_eq!(count(&c, &Query { partition: Some(0), ..Default::default() }).unwrap(), 2);
    }

    #[test]
    fn random_saved_attempts_and_stats() {
        let (_d, c) = setup();
        let q = Query { themes: vec!["mate".into()], ..Default::default() };
        let mut seen = std::collections::HashSet::new();
        for s in 0..50 { seen.insert(random(&c, &q, s).unwrap().unwrap().id); }
        assert_eq!(seen.len(), 2);
        assert!(random(&c, &Query { rating_min: Some(3000), ..Default::default() }, 1).unwrap().is_none());

        set_saved(&c, "bbbbb", true).unwrap();
        assert!(set_saved(&c, "nope", true).is_err());
        assert_eq!(count(&c, &Query { saved_only: true, ..Default::default() }).unwrap(), 1);
        let p = get(&c, "aaaaa").unwrap().unwrap();
        record_attempt(&c, &p, false, 2, 5000).unwrap();
        record_attempt(&c, &p, true, 0, 3000).unwrap();
        let q2 = get(&c, "ccccc").unwrap().unwrap();
        record_attempt(&c, &q2, true, 1, 7000).unwrap();
        assert_eq!(count(&c, &Query { unsolved_only: true, ..Default::default() }).unwrap(), 1);
        let st = stats(&c).unwrap();
        assert_eq!((st.attempts, st.solved, st.clean, st.streak, st.saved), (3, 2, 1, 2, 1));
        assert_eq!(st.avg_ms, 5000);
        assert_eq!(st.recent_solved_rating, Some(1500));
        let mate = st.by_theme.iter().find(|t| t.theme == "mate").unwrap();
        assert_eq!((mate.attempts, mate.solved), (3, 2));
        set_saved(&c, "bbbbb", false).unwrap();
        assert_eq!(stats(&c).unwrap().saved, 0);
    }
}

#[cfg(test)]
mod real_data {
    use super::*;
    use crate::{db, puzzle::PuzzleSession};

    /// Partizione reale del repository (`caissora_data/`, mai modificata): import, filtro e risoluzione di un puzzle vero.
    #[test]
    fn real_partition_imports_and_plays() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../caissora_data/puzzles/puzzles-0000.csv.zst");
        assert!(path.exists(), "dataset partition missing: {path:?}");
        let dir = tempfile::tempdir().unwrap();
        let mut c = db::open(&dir.path().join("t.db")).unwrap();
        let t0 = std::time::Instant::now();
        let rows = import_partition(&mut c, 0, &path, 0, "t").unwrap();
        eprintln!("imported {rows} puzzles in {:?}", t0.elapsed());
        assert_eq!(rows, 100_000);
        let q = Query { themes: vec!["mateIn1".into()], rating_min: Some(800), rating_max: Some(1200), ..Default::default() };
        let n = count(&c, &q).unwrap();
        assert!(n > 100, "{n}");
        let t1 = std::time::Instant::now();
        let p = random(&c, &q, 7).unwrap().unwrap();
        eprintln!("random among {n} in {:?}", t1.elapsed());
        assert!(p.themes.contains(&"mateIn1".to_string()) && (800..=1200).contains(&p.rating));
        let mut s = PuzzleSession::new(&p).unwrap();
        let sol = p.moves[1].clone();
        assert!(matches!(s.submit(&sol).unwrap(), crate::puzzle::Step::Correct { solved: true, .. }));
    }
}
