//! Genera dalle partizioni `puzzles-NNNN.csv.zst` già presenti (in sola lettura) due file:
//!   * `puzzle-index.json.zst` — statistiche per partizione (filtri rating/tema/apertura)
//!   * `puzzle-ids.ccbf`       — filtri di Bloom per partizione (ricerca per PuzzleId)
//!
//! Uso: puzzle-index <cartella-partizioni> <cartella-output> [--allow-partial]

use caissora_core::id_filter::{self, IdFilter};
use caissora_core::puzzle::{partition_file_name, PuzzleReader, PARTITIONS};
use caissora_core::puzzle_index::{stat_partition, PuzzleIndex};
use std::collections::HashMap;
use std::{fs::File, path::{Path, PathBuf}, process::ExitCode, time::Instant};

fn h64(s: &str) -> u64 { // hash solo per il controllo dei duplicati, non per il filtro
    s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3))
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn run() -> Result<(), String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let partial = args.iter().any(|a| a == "--allow-partial");
    let pos: Vec<&String> = args.iter().filter(|a| !a.starts_with("--")).collect();
    let [dir, out_dir] = pos[..] else {
        return Err("usage: puzzle-index <partitions-dir> <output-dir> [--allow-partial]".into());
    };
    let (dir, out_dir) = (PathBuf::from(dir), PathBuf::from(out_dir));
    let t0 = Instant::now();
    let (mut stats, mut filters) = (Vec::new(), Vec::new());
    let mut seen: HashMap<u64, u32> = HashMap::new();
    let mut duplicates = 0u64;
    let mut ids_by_partition: Vec<(u32, Vec<String>)> = Vec::new();

    for n in 0..PARTITIONS {
        let path = dir.join(partition_file_name(n).map_err(|e| e.to_string())?);
        if !path.exists() {
            if partial { continue; }
            return Err(format!("missing {} (use --allow-partial to index only the files present)", path.display()));
        }
        let f = File::open(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let reader = PuzzleReader::new(f).map_err(|e| e.to_string())?;
        let mut ids = Vec::new();
        let tracked = reader.map(|r| r.map(|p| { ids.push(p.id.clone()); p }));
        let s = stat_partition(n, tracked).map_err(|e| format!("{}: {e}", path.display()))?;
        let mut bf = IdFilter::with_capacity(n as u16, ids.len());
        for id in &ids {
            bf.insert(id);
            if seen.insert(h64(id), n).is_some() { duplicates += 1; }
        }
        eprintln!("partition {n:02}: {} rows", s.rows);
        stats.push(s);
        filters.push(bf);
        ids_by_partition.push((n, ids));
    }
    if stats.is_empty() { return Err("no partitions found".into()); }

    let index = PuzzleIndex::new(stats).map_err(|e| e.to_string())?;
    let idx_bytes = index.to_bytes().map_err(|e| e.to_string())?;
    let bf_bytes = id_filter::to_bytes(&filters).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let (idx_path, bf_path) = (out_dir.join("puzzle-index.json.zst"), out_dir.join("puzzle-ids.ccbf"));
    write_atomic(&idx_path, &idx_bytes)?;
    write_atomic(&bf_path, &bf_bytes)?;

    // ---- verifica sui file scritti (riletti da disco)
    let t1 = Instant::now();
    let back = PuzzleIndex::from_bytes(&std::fs::read(&idx_path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let idx_load = t1.elapsed();
    if back != index { return Err("index re-read mismatch".into()); }
    let t2 = Instant::now();
    let bfs = id_filter::from_bytes(&std::fs::read(&bf_path).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let bf_load = t2.elapsed();

    let (mut false_neg, mut fp, mut probes) = (0u64, 0u64, 0u64);
    for (n, ids) in &ids_by_partition {
        let f = bfs.iter().find(|f| f.partition as u32 == *n).ok_or("filter missing")?;
        false_neg += ids.iter().filter(|id| !f.may_contain(id)).count() as u64;
        for (m, other) in &ids_by_partition {
            if m == n { continue; }
            for id in other.iter().step_by(10) { // campione 10% degli ID delle altre partizioni
                probes += 1;
                if f.may_contain(id) { fp += 1; }
            }
        }
    }
    eprintln!("---- risultati");
    eprintln!("partizioni indicizzate: {} / {} (complete={})", back.partitions.len(), PARTITIONS, back.is_complete());
    eprintln!("puzzle totali: {}", back.total_rows());
    eprintln!("ID duplicati tra partizioni: {duplicates}");
    eprintln!("{}: {} byte, load+parse {:?}", idx_path.display(), idx_bytes.len(), idx_load);
    eprintln!("{}: {} byte, load+parse {:?}", bf_path.display(), bf_bytes.len(), bf_load);
    eprintln!("falsi negativi: {false_neg} (deve essere 0)");
    if probes > 0 {
        eprintln!("falsi positivi: {fp}/{probes} = {:.3}% (su ID di altre partizioni; include eventuali duplicati reali)", 100.0 * fp as f64 / probes as f64);
    }
    eprintln!("tempo totale {:.1}s", t0.elapsed().as_secs_f32());
    if false_neg != 0 { return Err("false negatives found: filter is broken".into()); }
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => { eprintln!("error: {e}"); ExitCode::FAILURE }
    }
}
