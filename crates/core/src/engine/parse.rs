//! Parsing puro (senza I/O) delle righe del protocollo UCI.

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OptionKind {
    Check { default: bool },
    Spin { default: i64, min: i64, max: i64 },
    Combo { default: String, vars: Vec<String> },
    Button,
    Text { default: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UciOption {
    pub name: String,
    pub kind: OptionKind,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Score {
    Cp(i32),
    Mate(i32),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Info {
    pub depth: Option<u32>,
    pub multipv: u32,
    pub score: Option<Score>,
    pub nodes: Option<u64>,
    pub nps: Option<u64>,
    pub time_ms: Option<u64>,
    pub pv: Vec<String>,
}

const OPTION_KEYS: [&str; 5] = ["name", "type", "default", "min", "max"];

/// `option name <id> type <t> [default <x>] [min <x>] [max <x>] [var <x>]*`
/// I nomi e i valori possono contenere spazi.
pub fn parse_option(line: &str) -> Option<UciOption> {
    let toks: Vec<&str> = line.split_whitespace().collect();
    if toks.first() != Some(&"option") {
        return None;
    }
    let is_key = |t: &str| OPTION_KEYS.contains(&t) || t == "var";
    let take = |start: usize| -> (String, usize) {
        let mut i = start;
        let mut v = Vec::new();
        while i < toks.len() && !is_key(toks[i]) {
            v.push(toks[i]);
            i += 1;
        }
        (v.join(" "), i)
    };
    let (mut name, mut ty, mut default, mut min, mut max) = (None, None, None, None, None);
    let mut vars = Vec::new();
    let mut i = 1;
    while i < toks.len() {
        let key = toks[i];
        let (val, next) = take(i + 1);
        match key {
            "name" => name = Some(val),
            "type" => ty = Some(val),
            "default" => default = Some(val),
            "min" => min = Some(val),
            "max" => max = Some(val),
            "var" => vars.push(val),
            _ => return None,
        }
        i = next;
    }
    let (name, ty) = (name?, ty?);
    let kind = match ty.as_str() {
        "check" => OptionKind::Check { default: default.as_deref() == Some("true") },
        "spin" => OptionKind::Spin {
            default: default?.parse().ok()?,
            min: min?.parse().ok()?,
            max: max?.parse().ok()?,
        },
        "combo" => OptionKind::Combo { default: default.unwrap_or_default(), vars },
        "button" => OptionKind::Button,
        "string" => OptionKind::Text { default: default.unwrap_or_default() },
        _ => return None,
    };
    Some(UciOption { name, kind })
}

/// Righe `info` con almeno un campo numerico; `info string ...` e simili → None.
pub fn parse_info(line: &str) -> Option<Info> {
    let toks: Vec<&str> = line.split_whitespace().collect();
    if toks.first() != Some(&"info") || toks.get(1) == Some(&"string") {
        return None;
    }
    let mut info = Info { depth: None, multipv: 1, score: None, nodes: None, nps: None, time_ms: None, pv: vec![] };
    let mut i = 1;
    while i < toks.len() {
        let num = |k: usize| toks.get(k).and_then(|t| t.parse::<i64>().ok());
        match toks[i] {
            "depth" => { info.depth = num(i + 1).map(|v| v as u32); i += 2 }
            "multipv" => { info.multipv = num(i + 1).unwrap_or(1) as u32; i += 2 }
            "nodes" => { info.nodes = num(i + 1).map(|v| v as u64); i += 2 }
            "nps" => { info.nps = num(i + 1).map(|v| v as u64); i += 2 }
            "time" => { info.time_ms = num(i + 1).map(|v| v as u64); i += 2 }
            "score" => {
                info.score = match (toks.get(i + 1), num(i + 2)) {
                    (Some(&"cp"), Some(v)) => Some(Score::Cp(v as i32)),
                    (Some(&"mate"), Some(v)) => Some(Score::Mate(v as i32)),
                    _ => None,
                };
                i += 3;
                if matches!(toks.get(i), Some(&"lowerbound") | Some(&"upperbound")) { i += 1 }
            }
            "pv" => { info.pv = toks[i + 1..].iter().map(|s| s.to_string()).collect(); break }
            _ => i += 1,
        }
    }
    Some(info)
}

/// `bestmove <m> [ponder <p>]`; `(none)` quando la posizione è terminale.
pub fn parse_bestmove(line: &str) -> Option<(Option<String>, Option<String>)> {
    let toks: Vec<&str> = line.split_whitespace().collect();
    if toks.first() != Some(&"bestmove") {
        return None;
    }
    let best = toks.get(1).filter(|m| **m != "(none)" && **m != "0000").map(|m| m.to_string());
    let ponder = toks.iter().position(|t| *t == "ponder").and_then(|p| toks.get(p + 1)).map(|m| m.to_string());
    Some((best, ponder))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options() {
        assert_eq!(
            parse_option("option name UCI_Elo type spin default 1320 min 1320 max 3190"),
            Some(UciOption { name: "UCI_Elo".into(), kind: OptionKind::Spin { default: 1320, min: 1320, max: 3190 } })
        );
        assert_eq!(
            parse_option("option name Debug Log File type string default <empty>").unwrap().name,
            "Debug Log File"
        );
        assert_eq!(
            parse_option("option name UCI_LimitStrength type check default false").unwrap().kind,
            OptionKind::Check { default: false }
        );
        assert_eq!(
            parse_option("option name Style type combo default Normal var Solid var Normal var Risky").unwrap().kind,
            OptionKind::Combo { default: "Normal".into(), vars: vec!["Solid".into(), "Normal".into(), "Risky".into()] }
        );
        assert_eq!(parse_option("option name Clear Hash type button").unwrap().kind, OptionKind::Button);
        assert_eq!(parse_option("option name X type spin default abc min 0 max 1"), None);
        assert_eq!(parse_option("id name Stockfish"), None);
    }

    #[test]
    fn info() {
        let i = parse_info("info depth 12 seldepth 18 multipv 2 score cp -35 nodes 12345 nps 900000 time 14 pv e7e5 g1f3").unwrap();
        assert_eq!((i.depth, i.multipv, i.score, i.nodes, i.time_ms), (Some(12), 2, Some(Score::Cp(-35)), Some(12345), Some(14)));
        assert_eq!(i.pv, ["e7e5", "g1f3"]);
        assert_eq!(parse_info("info depth 3 score mate 2 lowerbound nodes 9 pv a1a2").unwrap().score, Some(Score::Mate(2)));
        assert_eq!(parse_info("info string NNUE evaluation using nn.nnue"), None);
        assert_eq!(parse_info("bestmove e2e4"), None);
    }

    #[test]
    fn bestmove() {
        assert_eq!(parse_bestmove("bestmove e2e4 ponder e7e5"), Some((Some("e2e4".into()), Some("e7e5".into()))));
        assert_eq!(parse_bestmove("bestmove (none)"), Some((None, None)));
        assert_eq!(parse_bestmove("readyok"), None);
    }
}
