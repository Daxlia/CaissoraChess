fn main() {
    // Triple di destinazione, usato in sviluppo per trovare binaries/stockfish-<triple>.
    println!("cargo:rustc-env=CAISSORA_TARGET={}", std::env::var("TARGET").unwrap());
    tauri_build::build()
}
