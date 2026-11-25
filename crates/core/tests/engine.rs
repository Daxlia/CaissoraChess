//! Test d'integrazione contro un motore UCI reale. Il percorso si prende da CAISSORA_STOCKFISH
//! oppure /usr/games/stockfish. Se assente i test falliscono (non vengono saltati in silenzio):
//! impostare CAISSORA_SKIP_ENGINE_TESTS=1 per escluderli esplicitamente.
//! NB: la versione del motore usata per i test è stampata; Stockfish 19 ufficiale va verificato a parte.

use caissora_core::chess::Board;
use caissora_core::engine::parse::Score;
use caissora_core::engine::{spawn_process, Engine, GoParams, Position};
use caissora_core::Error;
use std::sync::Arc;
use std::time::{Duration, Instant};

fn path() -> Option<String> {
    if std::env::var("CAISSORA_SKIP_ENGINE_TESTS").is_ok() { return None; }
    let p = std::env::var("CAISSORA_STOCKFISH").unwrap_or_else(|_| "/usr/games/stockfish".into());
    assert!(std::path::Path::new(&p).exists(), "engine binary not found at {p}; set CAISSORA_STOCKFISH");
    Some(p)
}

async fn engine() -> Option<Engine> {
    let p = path()?;
    let e = Engine::connect(spawn_process(&p, &[]).unwrap()).await.unwrap();
    eprintln!("engine under test: {}", e.name);
    Some(e)
}

#[tokio::test]
async fn handshake_reads_name_and_options() {
    let Some(e) = engine().await else { return };
    assert!(e.name.contains("Stockfish"), "{}", e.name);
    assert!(e.options.contains_key("Hash") && e.options.contains_key("MultiPV"));
    let (lo, hi) = e.elo_range().expect("UCI_Elo declared");
    assert!(lo < hi);
    e.quit().await.unwrap();
}

#[tokio::test]
async fn bestmove_is_legal() {
    let Some(e) = engine().await else { return };
    e.new_game().await.unwrap();
    let r = e.go(&Position::Startpos, &["e2e4".into(), "e7e5".into()], &GoParams::movetime(150)).await.unwrap();
    let mut b = Board::default();
    b.play_uci("e2e4").unwrap();
    b.play_uci("e7e5").unwrap();
    assert!(b.is_legal_uci(r.best.as_deref().unwrap()));
    assert!(!r.lines.is_empty());
    e.quit().await.unwrap();
}

#[tokio::test]
async fn finds_mate_in_one_and_reports_mate_score() {
    let Some(e) = engine().await else { return };
    let fen = "6k1/5ppp/8/8/8/8/5PPP/R5K1 w - - 0 1"; // Ra8#
    let r = e.go(&Position::Fen(fen.into()), &[], &GoParams::depth(6)).await.unwrap();
    assert_eq!(r.best.as_deref(), Some("a1a8"));
    assert_eq!(r.lines[0].score, Some(Score::Mate(1)));
    e.quit().await.unwrap();
}

#[tokio::test]
async fn terminal_position_yields_no_bestmove() {
    let Some(e) = engine().await else { return };
    let r = e.go(&Position::Fen("7k/5Q2/6K1/8/8/8/8/8 b - - 0 1".into()), &[], &GoParams::depth(3)).await.unwrap();
    assert_eq!(r.best, None); // stallo → (none)
    e.quit().await.unwrap();
}

#[tokio::test]
async fn elo_limits_come_from_the_engine() {
    let Some(e) = engine().await else { return };
    let (lo, hi) = e.elo_range().unwrap();
    assert!(matches!(e.set_strength_elo(lo - 1).await, Err(Error::Engine(m)) if m.contains("between")));
    assert!(matches!(e.set_strength_elo(hi + 1).await, Err(Error::Engine(_))));
    e.set_strength_elo((lo + hi) / 2).await.unwrap();
    let r = e.go(&Position::Startpos, &[], &GoParams::movetime(100)).await.unwrap();
    assert!(Board::default().is_legal_uci(r.best.as_deref().unwrap()));
    e.set_full_strength().await.unwrap();
    e.quit().await.unwrap();
}

#[tokio::test]
async fn rejects_unknown_options_and_injection() {
    let Some(e) = engine().await else { return };
    assert!(e.set_option("NoSuchOption", Some("1")).await.is_err());
    assert!(e.set_option("MultiPV", Some("abc")).await.is_err());
    assert!(e.set_option("Debug Log File", Some("x\nquit")).await.is_err());
    assert!(e.go(&Position::Fen("8/8/8/8/8/8/8/8 w - - 0 1\nquit".into()), &[], &GoParams::depth(1)).await.is_err());
    assert!(e.go(&Position::Startpos, &["e2e4;quit".into()], &GoParams::depth(1)).await.is_err());
    e.is_ready().await.unwrap(); // l'engine è ancora vivo e sincronizzato
    e.quit().await.unwrap();
}

#[tokio::test]
async fn multipv_returns_distinct_lines() {
    let Some(e) = engine().await else { return };
    e.set_multipv(3).await.unwrap();
    let r = e.go(&Position::Startpos, &[], &GoParams::depth(8)).await.unwrap();
    assert_eq!(r.lines.iter().map(|l| l.multipv).collect::<Vec<_>>(), [1, 2, 3]);
    let firsts: std::collections::HashSet<_> = r.lines.iter().map(|l| l.pv[0].clone()).collect();
    assert_eq!(firsts.len(), 3);
    e.quit().await.unwrap();
}

#[tokio::test]
async fn stop_interrupts_infinite_search_without_blocking() {
    let Some(e) = engine().await else { return };
    let e = Arc::new(e);
    let e2 = e.clone();
    let t0 = Instant::now();
    let h = tokio::spawn(async move { e2.go(&Position::Startpos, &[], &GoParams::infinite()).await });
    tokio::time::sleep(Duration::from_millis(300)).await;
    e.stop().unwrap();
    let r = tokio::time::timeout(Duration::from_secs(3), h).await.expect("go() did not return after stop").unwrap().unwrap();
    assert!(Board::default().is_legal_uci(r.best.as_deref().unwrap()));
    assert!(t0.elapsed() < Duration::from_secs(3));
    e.quit().await.unwrap();
}

#[tokio::test]
async fn can_search_again_after_stop() {
    let Some(e) = engine().await else { return };
    let e = Arc::new(e);
    let e2 = e.clone();
    let h = tokio::spawn(async move { e2.go(&Position::Startpos, &[], &GoParams::infinite()).await });
    tokio::time::sleep(Duration::from_millis(100)).await;
    e.stop().unwrap();
    h.await.unwrap().unwrap();
    assert!(e.go(&Position::Startpos, &[], &GoParams::depth(4)).await.unwrap().best.is_some());
    e.quit().await.unwrap();
}

// ---- motori finti: errori e timeout non devono bloccare né andare in panic

#[tokio::test]
async fn silent_engine_times_out_at_handshake() {
    let io = spawn_process("sh", &["-c", "sleep 30"]).unwrap();
    let t0 = Instant::now();
    let r = Engine::connect(io).await;
    assert!(matches!(r, Err(Error::EngineTimeout(_))), "{:?}", r.err());
    assert!(t0.elapsed() < Duration::from_secs(12));
}

#[tokio::test]
async fn engine_that_dies_reports_exit_with_stderr() {
    let io = spawn_process("sh", &["-c", "echo boom >&2; exit 3"]).unwrap();
    match Engine::connect(io).await {
        Err(Error::Engine(m)) => assert!(m.contains("exited"), "{m}"),
        other => panic!("expected Engine error, got {:?}", other.err()),
    }
}

#[tokio::test]
async fn missing_binary_is_a_clean_error() {
    assert!(matches!(spawn_process("/nonexistent/engine", &[]), Err(Error::Engine(_))));
}

#[tokio::test]
async fn restart_after_crash_works() {
    let Some(p) = path() else { return };
    let e = Engine::connect(spawn_process(&p, &[]).unwrap()).await.unwrap();
    e.quit().await.unwrap();
    assert!(e.is_ready().await.is_err()); // processo terminato → errore, non hang
    let e2 = Engine::connect(spawn_process(&p, &[]).unwrap()).await.unwrap(); // riavvio
    e2.is_ready().await.unwrap();
    e2.quit().await.unwrap();
}

#[tokio::test]
async fn every_personality_plays_legal_moves_from_real_multipv_lines() {
    use caissora_core::personality::{pick, Style, SPECIFIC_STYLES};
    let Some(e) = engine().await else { return };
    e.set_strength_elo(e.elo_range().unwrap().0).await.unwrap();
    for style in SPECIFIC_STYLES {
        let mut b = Board::default();
        let mut played: Vec<String> = vec![];
        e.new_game().await.unwrap();
        for ply in 0..16 {
            e.set_multipv(style.multipv()).await.unwrap();
            let r = e.go(&Position::Startpos, &played, &GoParams::movetime(60)).await.unwrap();
            let mv = pick(&b.fen(), &r.lines, style, ply).unwrap().or(r.best).expect("a move");
            assert!(b.is_legal_uci(&mv), "{style:?} played illegal {mv} at {}", b.fen());
            b.play_uci(&mv).unwrap(); played.push(mv);
        }
    }
    let _ = Style::Neutral;
    e.quit().await.unwrap();
}
