//! Gestore UCI asincrono. Il protocollo è indipendente dal trasporto: `EngineIo` è una coppia
//! di canali (comandi in uscita, righe in ingresso). Su desktop il trasporto è un processo
//! figlio (`spawn_process`); su Android sarà un ponte JNI che riempie gli stessi canali.

pub mod parse;

use crate::error::{Error, Result};
use parse::{parse_bestmove, parse_info, parse_option, Info, OptionKind, UciOption};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, Mutex};
use tokio::time::{timeout, Instant};

pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const SYNC_TIMEOUT: Duration = Duration::from_secs(10);
const STOP_GRACE: Duration = Duration::from_secs(3);

/// Trasporto astratto: righe di comando da inviare e righe di output ricevute.
pub struct EngineIo {
    pub tx: mpsc::UnboundedSender<String>,
    pub rx: mpsc::UnboundedReceiver<String>,
    /// Ultime righe di stderr (diagnostica per gli errori).
    pub stderr_tail: Arc<StdMutex<VecDeque<String>>>,
    child: Option<Child>,
}

/// Avvia un processo UCI. `kill_on_drop`: l'engine non sopravvive all'app.
pub fn spawn_process(program: &str, args: &[&str]) -> Result<EngineIo> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| Error::Engine(format!("cannot start `{program}`: {e}")))?;
    let (mut stdin, stdout, stderr) = (
        child.stdin.take().unwrap(),
        child.stdout.take().unwrap(),
        child.stderr.take().unwrap(),
    );
    let (cmd_tx, mut cmd_rx) = mpsc::unbounded_channel::<String>();
    let (line_tx, line_rx) = mpsc::unbounded_channel::<String>();
    tokio::spawn(async move {
        while let Some(cmd) = cmd_rx.recv().await {
            if stdin.write_all(cmd.as_bytes()).await.is_err()
                || stdin.write_all(b"\n").await.is_err()
                || stdin.flush().await.is_err()
            {
                break;
            }
        }
    });
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            if line_tx.send(l).is_err() {
                break;
            }
        }
        // EOF: il sender viene rilasciato e la recv() restituisce None → EngineExited
    });
    let tail = Arc::new(StdMutex::new(VecDeque::new()));
    let t2 = tail.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(l)) = lines.next_line().await {
            let mut q = t2.lock().unwrap();
            if q.len() >= 20 { q.pop_front(); }
            q.push_back(l);
        }
    });
    Ok(EngineIo { tx: cmd_tx, rx: line_rx, stderr_tail: tail, child: Some(child) })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Position {
    Startpos,
    Fen(String),
}

#[derive(Clone, Debug, Default)]
pub struct GoParams {
    pub movetime_ms: Option<u64>,
    pub depth: Option<u32>,
    pub nodes: Option<u64>,
    pub wtime_ms: Option<u64>,
    pub btime_ms: Option<u64>,
    pub winc_ms: Option<u64>,
    pub binc_ms: Option<u64>,
    pub infinite: bool,
    /// Sovrascrive il timeout di sicurezza calcolato.
    pub timeout: Option<Duration>,
}

impl GoParams {
    pub fn movetime(ms: u64) -> Self { GoParams { movetime_ms: Some(ms), ..Default::default() } }
    pub fn depth(d: u32) -> Self { GoParams { depth: Some(d), ..Default::default() } }
    pub fn infinite() -> Self { GoParams { infinite: true, ..Default::default() } }

    fn command(&self) -> String {
        let mut s = String::from("go");
        let mut put = |k: &str, v: Option<u64>| if let Some(v) = v { s.push_str(&format!(" {k} {v}")) };
        put("movetime", self.movetime_ms);
        put("depth", self.depth.map(u64::from));
        put("nodes", self.nodes);
        put("wtime", self.wtime_ms);
        put("btime", self.btime_ms);
        put("winc", self.winc_ms);
        put("binc", self.binc_ms);
        if self.infinite { s.push_str(" infinite"); }
        s
    }

    fn safety_timeout(&self) -> Option<Duration> {
        if let Some(t) = self.timeout { return Some(t); }
        if self.infinite { return None; }
        let margin = Duration::from_secs(5);
        if let Some(ms) = self.movetime_ms { return Some(Duration::from_millis(ms) + margin); }
        match (self.wtime_ms, self.btime_ms) {
            (None, None) => Some(Duration::from_secs(120)), // depth / nodes
            (w, b) => Some(Duration::from_millis(w.unwrap_or(0).max(b.unwrap_or(0))) + margin),
        }
    }
}

#[derive(Clone, Debug)]
pub struct SearchResult {
    pub best: Option<String>,
    pub ponder: Option<String>,
    /// Ultima `info` per ciascun MultiPV, ordinata per `multipv` crescente.
    pub lines: Vec<Info>,
}

pub struct Engine {
    tx: mpsc::UnboundedSender<String>,
    rx: Mutex<mpsc::UnboundedReceiver<String>>,
    stderr_tail: Arc<StdMutex<VecDeque<String>>>,
    child: Mutex<Option<Child>>,
    pub name: String,
    pub author: String,
    pub options: HashMap<String, UciOption>,
}

fn no_newlines(s: &str) -> Result<()> {
    if s.contains('\n') || s.contains('\r') {
        return Err(Error::Engine("command contains line breaks".into()));
    }
    Ok(())
}

impl Engine {
    /// Esegue l'handshake `uci`/`uciok` + `isready`/`readyok` e legge le opzioni dichiarate.
    pub async fn connect(io: EngineIo) -> Result<Engine> {
        let mut e = Engine {
            tx: io.tx,
            rx: Mutex::new(io.rx),
            stderr_tail: io.stderr_tail,
            child: Mutex::new(io.child),
            name: String::new(),
            author: String::new(),
            options: HashMap::new(),
        };
        e.send("uci")?;
        let deadline = Instant::now() + HANDSHAKE_TIMEOUT;
        let (mut name, mut author, mut opts) = (String::new(), String::new(), HashMap::new());
        loop {
            let line = e.recv_until(deadline, "waiting for uciok").await?;
            if let Some(n) = line.strip_prefix("id name ") { name = n.trim().into(); }
            else if let Some(a) = line.strip_prefix("id author ") { author = a.trim().into(); }
            else if let Some(o) = parse_option(&line) { opts.insert(o.name.clone(), o); }
            else if line.trim() == "uciok" { break; }
        }
        e.name = name;
        e.author = author;
        e.options = opts;
        e.is_ready().await?;
        Ok(e)
    }

    fn send(&self, cmd: &str) -> Result<()> {
        no_newlines(cmd)?;
        self.tx.send(cmd.to_string()).map_err(|_| self.exited())
    }

    fn exited(&self) -> Error {
        let tail: Vec<String> = self.stderr_tail.lock().unwrap().iter().cloned().collect();
        Error::Engine(if tail.is_empty() { "engine process exited".into() } else { format!("engine process exited (stderr: {})", tail.join(" | ")) })
    }

    async fn recv_until(&self, deadline: Instant, what: &str) -> Result<String> {
        let mut rx = self.rx.lock().await;
        self.recv_locked(&mut rx, deadline, what).await
    }

    async fn recv_locked(&self, rx: &mut mpsc::UnboundedReceiver<String>, deadline: Instant, what: &str) -> Result<String> {
        match tokio::time::timeout_at(deadline, rx.recv()).await {
            Err(_) => Err(Error::EngineTimeout(what.into())),
            Ok(None) => Err(self.exited()),
            Ok(Some(l)) => Ok(l),
        }
    }

    pub async fn is_ready(&self) -> Result<()> {
        self.send("isready")?;
        let deadline = Instant::now() + SYNC_TIMEOUT;
        loop {
            if self.recv_until(deadline, "waiting for readyok").await?.trim() == "readyok" {
                return Ok(());
            }
        }
    }

    pub async fn new_game(&self) -> Result<()> {
        self.send("ucinewgame")?;
        self.is_ready().await
    }

    /// Imposta un'opzione dopo averla verificata contro quelle dichiarate dall'engine.
    pub async fn set_option(&self, name: &str, value: Option<&str>) -> Result<()> {
        let opt = self.options.get(name).ok_or_else(|| Error::Engine(format!("unsupported option `{name}`")))?;
        no_newlines(name)?;
        match (&opt.kind, value) {
            (OptionKind::Button, None) => self.send(&format!("setoption name {name}"))?,
            (OptionKind::Button, Some(_)) => return Err(Error::Engine(format!("`{name}` takes no value"))),
            (_, None) => return Err(Error::Engine(format!("`{name}` requires a value"))),
            (kind, Some(v)) => {
                no_newlines(v)?;
                match kind {
                    OptionKind::Check { .. } if v != "true" && v != "false" => {
                        return Err(Error::Engine(format!("`{name}` must be true or false")))
                    }
                    OptionKind::Spin { min, max, .. } => {
                        let n: i64 = v.parse().map_err(|_| Error::Engine(format!("`{name}` must be an integer")))?;
                        if n < *min || n > *max {
                            return Err(Error::Engine(format!("`{name}` must be between {min} and {max}, got {n}")));
                        }
                    }
                    OptionKind::Combo { vars, .. } if !vars.iter().any(|x| x == v) => {
                        return Err(Error::Engine(format!("`{name}`: `{v}` is not one of {vars:?}")))
                    }
                    _ => {}
                }
                self.send(&format!("setoption name {name} value {v}"))?;
            }
        }
        self.is_ready().await
    }

    /// Limiti Elo dichiariti dall'engine (`UCI_Elo`), se presenti.
    pub fn elo_range(&self) -> Option<(i64, i64)> {
        match &self.options.get("UCI_Elo")?.kind {
            OptionKind::Spin { min, max, .. } => Some((*min, *max)),
            _ => None,
        }
    }

    pub async fn set_strength_elo(&self, elo: i64) -> Result<()> {
        if !self.options.contains_key("UCI_LimitStrength") || self.elo_range().is_none() {
            return Err(Error::Engine("this engine does not support UCI_LimitStrength/UCI_Elo".into()));
        }
        self.set_option("UCI_Elo", Some(&elo.to_string())).await?; // valida i limiti
        self.set_option("UCI_LimitStrength", Some("true")).await
    }

    pub async fn set_full_strength(&self) -> Result<()> {
        if self.options.contains_key("UCI_LimitStrength") {
            self.set_option("UCI_LimitStrength", Some("false")).await?;
        }
        Ok(())
    }

    pub async fn set_multipv(&self, n: u32) -> Result<()> {
        self.set_option("MultiPV", Some(&n.to_string())).await
    }

    /// Ricerca. Per interromperla, un altro task chiama `stop()`: `bestmove` arriva comunque.
    pub async fn go(&self, pos: &Position, moves: &[String], params: &GoParams) -> Result<SearchResult> {
        for m in moves {
            if m.len() < 4 || m.len() > 5 || !m.bytes().all(|b| b.is_ascii_alphanumeric()) {
                return Err(Error::Engine(format!("invalid move `{m}`")));
            }
        }
        let mut rx = self.rx.lock().await; // una sola ricerca per volta
        let mut cmd = match pos {
            Position::Startpos => "position startpos".to_string(),
            Position::Fen(f) => { no_newlines(f)?; format!("position fen {f}") }
        };
        if !moves.is_empty() { cmd.push_str(" moves "); cmd.push_str(&moves.join(" ")); }
        self.send(&cmd)?;
        self.send(&params.command())?;

        let mut deadline = params.safety_timeout().map(|d| Instant::now() + d);
        let mut stop_sent = false;
        let mut lines: HashMap<u32, Info> = HashMap::new();
        loop {
            let line = match deadline {
                Some(d) => match tokio::time::timeout_at(d, rx.recv()).await {
                    Ok(Some(l)) => l,
                    Ok(None) => return Err(self.exited()),
                    Err(_) if !stop_sent => {
                        // scaduto il tempo di sicurezza: stop e breve attesa del bestmove
                        self.send("stop")?;
                        stop_sent = true;
                        deadline = Some(Instant::now() + STOP_GRACE);
                        continue;
                    }
                    Err(_) => return Err(Error::EngineTimeout("search did not answer to stop".into())),
                },
                None => rx.recv().await.ok_or_else(|| self.exited())?,
            };
            if let Some(info) = parse_info(&line) {
                if info.score.is_some() { lines.insert(info.multipv, info); }
            } else if let Some((best, ponder)) = parse_bestmove(&line) {
                let mut v: Vec<Info> = lines.into_values().collect();
                v.sort_by_key(|i| i.multipv);
                return Ok(SearchResult { best, ponder, lines: v });
            }
        }
    }

    /// Chiede all'engine di terminare la ricerca in corso. Non attende nulla.
    pub fn stop(&self) -> Result<()> {
        self.send("stop")
    }

    /// `quit` ordinato; se il processo non termina entro 2 s viene ucciso.
    pub async fn quit(&self) -> Result<()> {
        let _ = self.send("quit");
        if let Some(mut c) = self.child.lock().await.take() {
            if timeout(Duration::from_secs(2), c.wait()).await.is_err() {
                let _ = c.kill().await;
            }
        }
        Ok(())
    }
}
