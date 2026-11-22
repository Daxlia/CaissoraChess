//! Filtri di Bloom per partizione, per la ricerca per PuzzleId.
//!
//! Le partizioni NON sono ordinate per ID (ogni file è formato da ~6 sequenze crescenti
//! e gli intervalli si sovrappongono), quindi un ID non si localizza per intervallo.
//! Il filtro dà "sicuramente assente" o "forse presente": nessun falso negativo.
//! Dopo un "forse" la partizione va scaricata/letta per confermare.

use crate::error::{Error, Result};

const MAGIC: &[u8; 4] = b"CCBF";
const VERSION: u8 = 1;
pub const BITS_PER_ID: usize = 10;
pub const HASHES: u32 = 7;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct IdFilter {
    pub partition: u16,
    bits: Vec<u8>,
}

fn fnv(seed: u64, s: &str) -> u64 {
    let mut h = 0xcbf29ce484222325u64 ^ seed;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    // avalanche finale (splitmix64)
    h ^= h >> 30; h = h.wrapping_mul(0xbf58476d1ce4e5b9);
    h ^= h >> 27; h = h.wrapping_mul(0x94d049bb133111eb);
    h ^ (h >> 31)
}

impl IdFilter {
    pub fn with_capacity(partition: u16, ids: usize) -> Self {
        let nbits = (ids.max(1) * BITS_PER_ID).next_multiple_of(8);
        IdFilter { partition, bits: vec![0; nbits / 8] }
    }

    fn nbits(&self) -> u64 { self.bits.len() as u64 * 8 }

    fn positions(&self, id: &str) -> impl Iterator<Item = u64> {
        let (h1, h2) = (fnv(0, id), fnv(0x9e3779b97f4a7c15, id) | 1);
        let n = self.nbits();
        (0..HASHES as u64).map(move |i| h1.wrapping_add(i.wrapping_mul(h2)) % n)
    }

    pub fn insert(&mut self, id: &str) {
        let pos: Vec<u64> = self.positions(id).collect();
        for p in pos { self.bits[(p / 8) as usize] |= 1 << (p % 8); }
    }

    pub fn may_contain(&self, id: &str) -> bool {
        self.positions(id).all(|p| self.bits[(p / 8) as usize] & (1 << (p % 8)) != 0)
    }

    pub fn byte_len(&self) -> usize { self.bits.len() }
}

/// Serializza tutti i filtri in un unico file: `CCBF`, versione, N, poi per ciascuno
/// (partizione u16, lunghezza u32, byte). Compresso con zstd (i filtri pieni sono quasi
/// incomprimibili, ma la compressione è innocua e protegge da file troncati).
pub fn to_bytes(filters: &[IdFilter]) -> Result<Vec<u8>> {
    let mut v = Vec::new();
    v.extend_from_slice(MAGIC);
    v.push(VERSION);
    v.extend_from_slice(&(filters.len() as u16).to_le_bytes());
    for f in filters {
        v.extend_from_slice(&f.partition.to_le_bytes());
        v.extend_from_slice(&(f.bits.len() as u32).to_le_bytes());
        v.extend_from_slice(&f.bits);
    }
    Ok(zstd::encode_all(&v[..], 3)?)
}

pub fn from_bytes(b: &[u8]) -> Result<Vec<IdFilter>> {
    let raw = zstd::decode_all(b)?;
    let bad = || Error::Data("corrupt id filter file".into());
    if raw.len() < 7 || &raw[..4] != MAGIC { return Err(bad()); }
    if raw[4] != VERSION { return Err(Error::Data(format!("unsupported id filter version {}", raw[4]))); }
    let n = u16::from_le_bytes([raw[5], raw[6]]) as usize;
    let (mut off, mut out) = (7usize, Vec::with_capacity(n));
    for _ in 0..n {
        let head = raw.get(off..off + 6).ok_or_else(bad)?;
        let partition = u16::from_le_bytes([head[0], head[1]]);
        let len = u32::from_le_bytes([head[2], head[3], head[4], head[5]]) as usize;
        off += 6;
        let bits = raw.get(off..off.checked_add(len).ok_or_else(bad)?).ok_or_else(bad)?.to_vec();
        off += len;
        out.push(IdFilter { partition, bits });
    }
    if off != raw.len() { return Err(bad()); }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_false_negatives_and_low_false_positives() {
        let ids: Vec<String> = (0..20_000).map(|i| format!("id{i:06}")).collect();
        let mut f = IdFilter::with_capacity(3, ids.len());
        ids.iter().for_each(|i| f.insert(i));
        assert!(ids.iter().all(|i| f.may_contain(i)));
        let fp = (0..20_000).filter(|i| f.may_contain(&format!("zz{i:06}"))).count();
        assert!(fp < 400, "false positives {fp}/20000 > 2%"); // atteso ~0.8%
    }

    #[test]
    fn roundtrip_and_corruption() {
        let mut f = IdFilter::with_capacity(7, 100);
        f.insert("abcde");
        let b = to_bytes(&[f.clone()]).unwrap();
        let back = from_bytes(&b).unwrap();
        assert_eq!(back, vec![f]);
        assert!(back[0].may_contain("abcde"));
        assert!(from_bytes(b"junk").is_err());
        let raw = zstd::decode_all(&b[..]).unwrap();
        let cut = zstd::encode_all(&raw[..raw.len() - 3], 3).unwrap();
        assert!(from_bytes(&cut).is_err());
    }
}
