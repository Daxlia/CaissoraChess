//! Indice di ricerca dei puzzle: statistiche per partizione (NON duplica FEN/Moves, NON è un
//! manifest dei dataset). Serve a sapere quali partizioni contengono puzzle per un filtro e
//! quanti, e a dichiarare la copertura. La ricerca per PuzzleId usa `id_filter` (le partizioni
//! non sono ordinate per ID, quindi non esiste una ricerca per intervallo).
//!
//! Formato file: JSON compresso con zstd (`puzzle-index.json.zst`), campo `version` per
//! migrazioni future.

use crate::error::{Error, Result};
use crate::puzzle::{Puzzle, PARTITIONS};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const INDEX_VERSION: u32 = 1;
/// Ampiezza dei bucket dell'istogramma di rating.
pub const RATING_BUCKET: u32 = 50;

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct PartitionStat {
    pub n: u32,
    pub rows: u32,
    /// bucket (rating / RATING_BUCKET) -> conteggio
    pub rating_hist: BTreeMap<u32, u32>,
    pub themes: BTreeMap<String, u32>,
    pub opening_tags: BTreeMap<String, u32>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PuzzleIndex {
    pub version: u32,
    pub rating_bucket: u32,
    pub partitions: Vec<PartitionStat>,
}

/// Costruisce le statistiche di una partizione.
pub fn stat_partition(n: u32, puzzles: impl Iterator<Item = Result<Puzzle>>) -> Result<PartitionStat> {
    let mut s = PartitionStat { n, ..Default::default() };
    for p in puzzles {
        let p = p?;
        s.rows += 1;
        *s.rating_hist.entry(p.rating / RATING_BUCKET).or_default() += 1;
        for t in &p.themes { *s.themes.entry(t.clone()).or_default() += 1; }
        for t in &p.opening_tags { *s.opening_tags.entry(t.clone()).or_default() += 1; }
    }
    if s.rows == 0 {
        return Err(Error::Data(format!("partition {n} is empty")));
    }
    Ok(s)
}

#[derive(Clone, Debug, Default)]
pub struct Filter {
    pub rating_min: Option<u32>,
    pub rating_max: Option<u32>,
    pub themes: Vec<String>,
    pub opening_tag: Option<String>,
}

impl PuzzleIndex {
    pub fn new(mut partitions: Vec<PartitionStat>) -> Result<Self> {
        partitions.sort_by_key(|p| p.n);
        if partitions.windows(2).any(|w| w[0].n == w[1].n) {
            return Err(Error::Data("duplicate partition number".into()));
        }
        Ok(PuzzleIndex { version: INDEX_VERSION, rating_bucket: RATING_BUCKET, partitions })
    }

    pub fn is_complete(&self) -> bool {
        self.partitions.len() as u32 == PARTITIONS
    }

    pub fn total_rows(&self) -> u64 {
        self.partitions.iter().map(|p| p.rows as u64).sum()
    }

    /// Per ogni partizione, il limite superiore dei puzzle che soddisfano il filtro.
    /// Per un solo criterio è il conteggio esatto (rating a granularità di bucket: stima per eccesso);
    /// con più criteri è il minimo tra i conteggi, quindi un maggiorante, non un valore esatto.
    pub fn candidates(&self, f: &Filter) -> Vec<(u32, u32)> {
        let mut out: Vec<(u32, u32)> = self
            .partitions
            .iter()
            .filter_map(|p| {
                let mut bound = p.rows;
                if f.rating_min.is_some() || f.rating_max.is_some() {
                    let lo = f.rating_min.unwrap_or(0) / self.rating_bucket;
                    let hi = f.rating_max.unwrap_or(u32::MAX) / self.rating_bucket;
                    bound = bound.min(p.rating_hist.range(lo..=hi).map(|(_, c)| *c).sum());
                }
                for t in &f.themes {
                    bound = bound.min(*p.themes.get(t).unwrap_or(&0));
                }
                if let Some(t) = &f.opening_tag {
                    bound = bound.min(*p.opening_tags.get(t).unwrap_or(&0));
                }
                (bound > 0).then_some((p.n, bound))
            })
            .collect();
        out.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        out
    }

    pub fn to_bytes(&self) -> Result<Vec<u8>> {
        let json = serde_json::to_vec(self).map_err(|e| Error::Data(e.to_string()))?;
        Ok(zstd::encode_all(&json[..], 19)?)
    }

    pub fn from_bytes(b: &[u8]) -> Result<Self> {
        let json = zstd::decode_all(b)?;
        let idx: PuzzleIndex = serde_json::from_slice(&json).map_err(|e| Error::Data(e.to_string()))?;
        if idx.version != INDEX_VERSION {
            return Err(Error::Data(format!("unsupported index version {}", idx.version)));
        }
        Ok(idx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(id: &str, rating: u32, themes: &str, tags: &str) -> Result<Puzzle> {
        Ok(Puzzle {
            id: id.into(), fen: String::new(), moves: vec![], rating, popularity: 0, nb_plays: 0,
            themes: themes.split_whitespace().map(String::from).collect(),
            opening_tags: tags.split_whitespace().map(String::from).collect(),
        })
    }

    fn idx() -> PuzzleIndex {
        let a = stat_partition(0, vec![p("007mr", 628, "mate endgame", ""), p("00B3B", 1500, "mate", "Sicilian")].into_iter()).unwrap();
        let b = stat_partition(1, vec![p("7p2eQ", 970, "middlegame", "Sicilian"), p("9Bwqj", 2900, "mate", "")].into_iter()).unwrap();
        PuzzleIndex::new(vec![b, a]).unwrap()
    }

    #[test]
    fn filters_give_bounds_and_order() {
        let i = idx();
        let f = Filter { themes: vec!["mate".into()], ..Default::default() };
        assert_eq!(i.candidates(&f), vec![(0, 2), (1, 1)]);
        let f = Filter { opening_tag: Some("Sicilian".into()), rating_min: Some(900), rating_max: Some(1600), ..Default::default() };
        assert_eq!(i.candidates(&f), vec![(0, 1), (1, 1)]);
        let f = Filter { themes: vec!["nonexistent".into()], ..Default::default() };
        assert!(i.candidates(&f).is_empty());
    }

    #[test]
    fn rejects_empty_and_duplicate_partitions() {
        assert!(stat_partition(0, std::iter::empty()).is_err());
        let a = stat_partition(0, vec![p("a", 1, "", "")].into_iter()).unwrap();
        assert!(PuzzleIndex::new(vec![a.clone(), a]).is_err());
    }

    #[test]
    fn serialization_roundtrip() {
        let i = idx();
        assert_eq!(PuzzleIndex::from_bytes(&i.to_bytes().unwrap()).unwrap(), i);
        assert!(PuzzleIndex::from_bytes(b"garbage").is_err());
    }
}
