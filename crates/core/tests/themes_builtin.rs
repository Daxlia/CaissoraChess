//! I temi incorporati usano lo stesso formato dei temi importati: devono superare la stessa validazione.
use caissora_core::theme::{pack_dir, read_package};
use std::path::PathBuf;

fn builtin_dir() -> PathBuf { PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../src/themes/builtin") }

#[test]
fn every_builtin_theme_passes_import_validation() {
    let mut ids = Vec::new();
    for e in std::fs::read_dir(builtin_dir()).unwrap() {
        let p = e.unwrap().path();
        if !p.is_dir() { continue; }
        let pkg = read_package(&pack_dir(&p).unwrap()).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
        assert_eq!(pkg.manifest.id, p.file_name().unwrap().to_str().unwrap(), "folder name must equal theme id");
        ids.push(pkg.manifest.id);
    }
    ids.sort();
    assert_eq!(ids, ["classic", "emerald", "glacier", "ivory-ebony", "neon", "obsidian"]);
}
