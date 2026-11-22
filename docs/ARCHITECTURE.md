# CaissoraChess — architettura e stato

## Principio
Tutta la logica sta in `crates/core` (Rust puro, nessuna dipendenza da Tauri): è testabile
ovunque, anche senza WebView né Android SDK. `src-tauri` (da creare) sarà solo un guscio che
espone i comandi del core al frontend TypeScript. Il frontend non applica mai regole scacchistiche
né accede al filesystem.

## Decisioni verificate sui dati reali
| Fatto verificato | Conseguenza |
|---|---|
| `openings.parquet`: 3.704 righe, compressione ZSTD, colonne `eco,name,pgn` (stringhe) | crate `parquet` con feature `zstd`; tutte le 3.704 PGN sono legali (l'import le valida) |
| Partizioni puzzle: 100.000 righe (ultima 93.530), tot. 6.193.530 | coerente con ~6,19 M |
| **Le partizioni NON sono ordinate per ID**: ~6 sequenze crescenti per file, intervalli sovrapposti | niente ricerca per intervallo; ricerca per ID tramite filtri di Bloom |
| Ogni partizione ha stessa distribuzione di rating e temi | il numero del file non dice nulla del contenuto; servono statistiche per partizione |
| `OpeningTags` vuoto in ~80% dei puzzle | il filtro per apertura ha copertura ridotta per natura del dato |

## Indice dei puzzle (due file, nessun manifest)
Generati da `tools/puzzle-index` in sola lettura sulle partizioni:
* `puzzle-index.json.zst` — per partizione: righe, istogramma rating (bucket da 50), conteggi per
  tema e per tag di apertura. Dà, per un filtro, la lista delle partizioni utili con un
  **maggiorante** dei risultati (esatto con un solo criterio; con più criteri è il minimo).
* `puzzle-ids.ccbf` — un filtro di Bloom per partizione (10 bit/ID, 7 hash). "Sicuramente non
  qui" oppure "forse qui" → solo dopo un "forse" si scarica la partizione.

Misure **reali su tutte le 62 partizioni** (6.193.530 puzzle, nessun ID duplicato):
statistiche 137.396 byte (caricamento+parsing ≈14 ms), filtri di Bloom 7.742.478 byte
(≈9 ms), falsi negativi 0, falsi positivi 0,82 %.

Copertura onesta: un filtro è "globale" solo contando le partizioni nelle statistiche; i puzzle
effettivamente proponibili sono quelli delle partizioni già scaricate, e la UI deve mostrare
"N di 62 partizioni cercate".

## Stato dei moduli
Fatto e testato (22 test): regole (`chess`), Opening Explorer backend (lettura Parquet, import SQLite
transazionale, ricerca per nome/ECO, Guided/Recall con distinzione illegale/deviazione), Puzzle
(streaming zstd+CSV, sessione con prima mossa dell'avversario, matti alternativi accettati),
indice puzzle + filtri di Bloom + strumento di generazione.

**Non ancora realizzato**: guscio Tauri 2, frontend/design system, gestore UCI e integrazione Stockfish
(desktop e Android), personalità, difficoltà adattiva, tornei, archivi, Academy, renderer e formato
`.cctheme`, localizzazione, migrazioni DB complete, backup `.caissora`, download con cache.
