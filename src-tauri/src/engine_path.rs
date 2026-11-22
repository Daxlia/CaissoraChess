//! Dove si trova il binario Stockfish. Desktop: accanto all'eseguibile (installato) o in
//! `src-tauri/binaries` (sviluppo). Android: da realizzare con un plugin Kotlin (vedi errore).

use std::path::PathBuf;

pub fn resolve() -> Result<PathBuf, String> {
    if let Ok(p) = std::env::var("CAISSORA_STOCKFISH") {
        return exists(PathBuf::from(p));
    }
    #[cfg(target_os = "android")]
    {
        return Err("The Android engine bridge is not implemented yet".into());
    }
    #[cfg(not(target_os = "android"))]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let dir = exe.parent().ok_or("no executable directory")?;
        let name = if cfg!(windows) { "stockfish.exe" } else { "stockfish" };
        let installed = dir.join(name);
        if installed.exists() {
            return Ok(installed);
        }
        let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries").join(format!(
            "stockfish-{}{}",
            env!("CAISSORA_TARGET"),
            if cfg!(windows) { ".exe" } else { "" }
        ));
        exists(dev)
    }
}

fn exists(p: PathBuf) -> Result<PathBuf, String> {
    if p.exists() { Ok(p) } else { Err(format!("Stockfish binary not found at {}. Run `node scripts/fetch-stockfish.mjs`.", p.display())) }
}
