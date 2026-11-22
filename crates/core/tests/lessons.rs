//! Valida i dati dell'Academy (src/academy/lessons.json) con le regole vere e il file di localizzazione.

use caissora_core::chess::{Board, GameStatus};
use serde_json::Value;
use std::path::PathBuf;

fn root() -> PathBuf { PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..") }
fn json(rel: &str) -> Value { serde_json::from_str(&std::fs::read_to_string(root().join(rel)).unwrap()).unwrap() }

fn has_key(en: &Value, key: &str) -> bool {
    let mut cur = en;
    for p in key.split('.') {
        match cur.get(p) { Some(v) => cur = v, None => return false }
    }
    cur.is_string()
}

#[test]
fn every_lesson_is_valid() {
    let lessons = json("src/academy/lessons.json");
    let en = json("locales/en.json");
    let list = lessons["lessons"].as_array().expect("lessons array");
    assert!(!list.is_empty());
    let mut ids = std::collections::HashSet::new();
    for l in list {
        let id = l["id"].as_str().unwrap();
        assert!(ids.insert(id), "duplicate lesson id {id}");
        for k in ["title", "summary"] {
            assert!(has_key(&en, &format!("academy.lessons.{id}.{k}")), "missing {id}.{k}");
        }
        let steps = l["steps"].as_array().unwrap();
        assert!(!steps.is_empty(), "{id} has no steps");
        for (n, s) in steps.iter().enumerate() {
            let key = s["key"].as_str().unwrap();
            assert!(has_key(&en, key), "{id} step {n}: missing text `{key}`");
            match s["type"].as_str().unwrap() {
                "text" => {}
                "position" => { Board::from_fen(s["fen"].as_str().unwrap()).unwrap_or_else(|e| panic!("{id} step {n}: {e}")); }
                "exercise" => {
                    let fen = s["fen"].as_str().unwrap();
                    let b = Board::from_fen(fen).unwrap_or_else(|e| panic!("{id} step {n}: {e}"));
                    let sols = s["solutions"].as_array().unwrap();
                    assert!(!sols.is_empty());
                    for sol in sols {
                        let sol = sol.as_str().unwrap();
                        assert!(b.is_legal_uci(sol), "{id} step {n}: solution {sol} is not legal");
                        if s["goal"] == "mate" {
                            let mut after = b.clone();
                            after.play_uci(sol).unwrap();
                            assert!(matches!(after.status(), GameStatus::Checkmate { .. }), "{id} step {n}: {sol} is not mate");
                        }
                    }
                }
                other => panic!("{id} step {n}: unknown type {other}"),
            }
        }
    }
}

#[test]
fn locale_template_is_identical_to_english() {
    let a = std::fs::read_to_string(root().join("locales/en.json")).unwrap();
    let b = std::fs::read_to_string(root().join("locales/template.json")).unwrap();
    assert_eq!(a, b);
}
