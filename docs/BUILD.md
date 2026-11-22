# Build e test

## Core e strumenti (funziona ovunque ci sia Rust ≥ 1.85)
```bash
cargo test --workspace                 # 22 test; usa caissora_data/openings/openings.parquet del repo
cargo build --release -p puzzle-index
```

## Generare l'indice dei puzzle (una volta, sulla tua macchina)
```bash
./target/release/puzzle-index caissora_data/puzzles caissora_data/index
# senza --allow-partial fallisce se manca una delle 62 partizioni
```
Crea `caissora_data/index/puzzle-index.json.zst` e `puzzle-ids.ccbf` (file nuovi; gli archivi
originali non vengono toccati). Stampa dimensioni, tempi di caricamento, falsi negativi (devono
essere 0) e falsi positivi. Poi committa i due file.

## Guscio Tauri (prossima fase — non ancora presente)
Prerequisiti Tauri 2: https://v2.tauri.app/start/prerequisites/ (Windows: WebView2 + MSVC; Linux: webkit2gtk-4.1;
Android: Android Studio, SDK, NDK, `rustup target add aarch64-linux-android armv7-linux-androideabi`).
