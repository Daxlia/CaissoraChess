//! Formato `.cctheme` (versione 1): un archivio ZIP con `theme.json` + risorse (immagini).
//!
//! Il tema è PURAMENTE DICHIARATIVO: nessun codice eseguibile, nessun JavaScript, nessuno shader.
//! Tutto ciò che arriva da un file importato viene validato qui prima di toccare il disco:
//! tipi e intervalli del manifest, colori, percorsi (niente `..`, niente percorsi assoluti), tipi di file
//! ammessi, firme reali dei file (PNG/JPEG/WebP), dimensioni delle immagini, limiti anti zip-bomb.

use crate::error::{Error, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{Cursor, Read, Write};
use std::path::{Path, PathBuf};

pub const FORMAT_VERSION: u32 = 1;
pub const MAX_ARCHIVE_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_FILES: usize = 400;
pub const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
pub const MAX_TOTAL_BYTES: u64 = 160 * 1024 * 1024;
pub const MAX_MANIFEST_BYTES: u64 = 256 * 1024;
pub const MAX_SIDE_PX: u32 = 8192;
pub const MAX_IMAGE_PIXELS: u64 = 36_000_000;
pub const MAX_TOTAL_PIXELS: u64 = 220_000_000;
const PIECES: [&str; 12] = ["wP", "wN", "wB", "wR", "wQ", "wK", "bP", "bN", "bB", "bR", "bQ", "bK"];

// ------------------------------------------------------------------ manifest

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Manifest {
    pub format: u32,
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: String,
    pub license: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub source_url: Option<String>,
    #[serde(default)]
    pub board: Option<BoardSpec>,
    #[serde(default)]
    pub pieces: Option<PieceSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct BoardSpec {
    #[serde(default)]
    pub view: View,
    #[serde(default)]
    pub scene: Paint,
    #[serde(default)]
    pub frame: Option<Frame>,
    pub squares: Squares,
    #[serde(default)]
    pub highlights: Highlights,
    #[serde(default)]
    pub coordinates: Coordinates,
    #[serde(default)]
    pub ambient: Vec<Ambient>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct View {
    /// Inclinazione della scacchiera in gradi (0 = vista dall'alto, fino a 65).
    #[serde(default)]
    pub tilt: f32,
    /// Distanza della camera in larghezze di scacchiera (più piccola = prospettiva più forte).
    #[serde(default = "d_camera")]
    pub camera: f32,
}
fn d_camera() -> f32 { 2.4 }
impl Default for View { fn default() -> Self { View { tilt: 0.0, camera: d_camera() } } }

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Paint {
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub gradient: Option<Gradient>,
    /// Percorso di un'immagine nell'archivio.
    #[serde(default)]
    pub texture: Option<String>,
    #[serde(default = "d_one")]
    pub texture_opacity: f32,
    #[serde(default)]
    pub texture_blend: Blend,
}
fn d_one() -> f32 { 1.0 }

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Blend { #[default] Normal, Multiply, Overlay, SoftLight }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Gradient {
    pub kind: GradientKind,
    #[serde(default)]
    pub angle: f32,
    pub stops: Vec<Stop>,
}
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum GradientKind { Linear, Radial }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Stop { pub at: f32, pub color: String }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Frame {
    /// Spessore in caselle (0..0.8).
    pub width: f32,
    #[serde(default)]
    pub paint: Paint,
    #[serde(default)]
    pub glow: Option<Glow>,
    /// Rilievo (smussatura) della cornice, 0..1.
    #[serde(default)]
    pub bevel: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Glow {
    pub color: String,
    /// Raggio dell'alone in caselle (0..1).
    pub radius: f32,
    /// Se presente, l'alone pulsa.
    #[serde(default)]
    pub pulse_seconds: Option<f32>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Squares {
    pub light: Paint,
    pub dark: Paint,
    /// Lucentezza (riflesso diagonale), 0..1.
    #[serde(default)]
    pub gloss: f32,
    /// Smussatura di ogni casella, 0..1.
    #[serde(default)]
    pub bevel: f32,
    #[serde(default)]
    pub grid: Option<Grid>,
    /// Ogni casella usa un ritaglio diverso della texture (niente ripetizioni visibili).
    #[serde(default = "d_true")]
    pub random_crop: bool,
}
fn d_true() -> bool { true }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Grid { pub color: String, pub width: f32, #[serde(default)] pub glow: f32 }

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Highlights {
    #[serde(default)]
    pub style: HighlightStyle,
    pub last_move: Option<String>,
    pub selected: Option<String>,
    pub legal: Option<String>,
    pub check: Option<String>,
    pub hint: Option<String>,
}
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum HighlightStyle { #[default] Fill, Ring, Glow }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Coordinates {
    #[serde(default = "d_true")]
    pub visible: bool,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub placement: CoordPlacement,
}
impl Default for Coordinates { fn default() -> Self { Coordinates { visible: true, color: None, placement: CoordPlacement::Inside } } }
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum CoordPlacement { #[default] Inside, Frame }

/// Effetti ambientali animati disegnati nella scena (attenuati o disattivati in qualità bassa / movimento ridotto).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Ambient {
    /// Fascio di luce che attraversa la scacchiera.
    Sweep { color: String, #[serde(default = "d_period")] period_seconds: f32, #[serde(default = "d_half")] opacity: f32, #[serde(default = "d_width")] width: f32 },
    /// Particelle fluttuanti (neve, braci, scintille, polvere).
    Particles { color: String, count: u32, #[serde(default = "d_size")] size: f32, #[serde(default = "d_speed")] speed: f32, #[serde(default)] direction: ParticleDirection, #[serde(default)] glow: f32 },
    /// Vignettatura sulla scena.
    Vignette { color: String, #[serde(default = "d_half")] strength: f32 },
}
fn d_period() -> f32 { 7.0 }
fn d_half() -> f32 { 0.5 }
fn d_width() -> f32 { 0.25 }
fn d_size() -> f32 { 0.02 }
fn d_speed() -> f32 { 0.05 }
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum ParticleDirection { Up, #[default] Down, Drift }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PieceSpec {
    /// Modello del percorso, con `{piece}` (wK, bQ…) ed eventualmente `{res}` (1x, 2x…).
    pub source: String,
    #[serde(default = "d_res")]
    pub resolutions: Vec<String>,
    /// Lato in pixel dello sprite alla risoluzione 1x.
    #[serde(default = "d_base")]
    pub base_size: u32,
    /// Larghezza dello sprite rispetto alla casella.
    #[serde(default = "d_one")]
    pub scale: f32,
    /// Punto dello sprite (frazione 0..1) che viene posto al centro della casella.
    #[serde(default = "d_anchor")]
    pub anchor: Anchor,
    /// Spostamento verticale in caselle (positivo = verso il basso).
    #[serde(default)]
    pub offset_y: f32,
    /// Solo per SVG: ricolora il corpo dei pezzi.
    #[serde(default)]
    pub recolor: Option<Recolor>,
    /// Lo sprite è una striscia orizzontale di fotogrammi animati.
    #[serde(default)]
    pub frames: Option<Frames>,
    #[serde(default)]
    pub shadow: Option<Shadow>,
    #[serde(default)]
    pub idle: Option<Idle>,
    #[serde(default)]
    pub motion: Option<Motion>,
    #[serde(default)]
    pub capture: Option<Capture>,
}
fn d_res() -> Vec<String> { vec!["1x".into()] }
fn d_base() -> u32 { 256 }
fn d_anchor() -> Anchor { Anchor { x: 0.5, y: 0.5 } }
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Anchor { pub x: f32, pub y: f32 }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Recolor { pub white: Option<String>, pub black: Option<String> }
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Frames { pub count: u32, pub fps: f32 }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Shadow { pub color: String, pub opacity: f32, #[serde(default = "d_half")] pub blur: f32, #[serde(default = "d_one")] pub scale: f32 }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Idle {
    pub style: IdleStyle,
    /// Ampiezza in caselle (0..0.2).
    #[serde(default = "d_amp")]
    pub amplitude: f32,
    #[serde(default = "d_idle_period")]
    pub period_seconds: f32,
    #[serde(default)]
    pub color: Option<String>,
}
fn d_amp() -> f32 { 0.03 }
fn d_idle_period() -> f32 { 3.0 }
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum IdleStyle { Float, Breathe, Glow, Frames }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Motion {
    pub style: MotionStyle,
    #[serde(default = "d_dur")]
    pub duration_ms: u32,
    #[serde(default)]
    pub easing: Easing,
    /// Altezza del salto in caselle (0..1.5).
    #[serde(default)]
    pub lift: f32,
    /// Schiacciamento all'atterraggio (0..0.4).
    #[serde(default)]
    pub squash: f32,
    #[serde(default)]
    pub trail: Option<Trail>,
    #[serde(default)]
    pub impact: Option<Impact>,
}
fn d_dur() -> u32 { 220 }
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum MotionStyle { Slide, Arc, Hop }
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum Easing { Linear, #[default] EaseOut, EaseInOut, Spring }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Trail { pub color: String, #[serde(default = "d_half")] pub length: f32, #[serde(default = "d_trail_w")] pub width: f32 }
fn d_trail_w() -> f32 { 0.18 }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Impact { pub color: String, #[serde(default = "d_half")] pub size: f32 }
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Capture {
    pub effect: CaptureEffect,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default = "d_particles")]
    pub particles: u32,
    #[serde(default = "d_cap_dur")]
    pub duration_ms: u32,
}
fn d_particles() -> u32 { 24 }
fn d_cap_dur() -> u32 { 450 }
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
pub enum CaptureEffect { Fade, Burst, Shatter, Dissolve }

// ------------------------------------------------------------------ validazione

fn bad<T>(msg: impl Into<String>) -> Result<T> { Err(Error::Data(format!("theme: {}", msg.into()))) }

pub fn valid_id(id: &str) -> bool {
    let b = id.as_bytes();
    (3..=40).contains(&b.len())
        && b[0].is_ascii_lowercase() | b[0].is_ascii_digit()
        && b.iter().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
        && !id.ends_with('-') && !id.contains("--")
}

fn valid_color(c: &str) -> bool {
    if c.len() > 64 { return false; }
    if let Some(h) = c.strip_prefix('#') {
        return matches!(h.len(), 3 | 4 | 6 | 8) && h.bytes().all(|b| b.is_ascii_hexdigit());
    }
    for p in ["rgb(", "rgba("] {
        if let Some(r) = c.strip_prefix(p) {
            return r.ends_with(')') && r[..r.len() - 1].bytes().all(|b| b.is_ascii_digit() || matches!(b, b',' | b'.' | b' ' | b'%' | b'/'));
        }
    }
    false
}

fn color(what: &str, c: &str) -> Result<()> { if valid_color(c) { Ok(()) } else { bad(format!("{what}: invalid color '{c}' (use #rgb, #rrggbb, #rrggbbaa, rgb() or rgba())")) } }
fn opt_color(what: &str, c: &Option<String>) -> Result<()> { match c { Some(c) => color(what, c), None => Ok(()) } }
fn range(what: &str, v: f32, lo: f32, hi: f32) -> Result<()> {
    if v.is_finite() && v >= lo && v <= hi { Ok(()) } else { bad(format!("{what} must be between {lo} and {hi} (got {v})")) }
}
fn text(what: &str, s: &str, max: usize, required: bool) -> Result<()> {
    if required && s.trim().is_empty() { return bad(format!("{what} is required")); }
    if s.chars().count() > max || s.chars().any(|c| c.is_control() && c != '\n') { return bad(format!("{what} is too long or contains control characters")); }
    Ok(())
}

/// Percorso relativo sicuro dentro l'archivio.
pub fn safe_path(p: &str) -> bool {
    !p.is_empty()
        && p.len() <= 160
        && !p.starts_with('/')
        && !p.contains("..")
        && !p.contains("//")
        && !p.ends_with('/')
        && p.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b'/' | b'@'))
        && p.split('/').all(|seg| !seg.is_empty() && !seg.starts_with('.'))
}

fn ext(p: &str) -> String { p.rsplit('.').next().unwrap_or("").to_ascii_lowercase() }
fn is_image_ext(e: &str) -> bool { matches!(e, "png" | "webp" | "jpg" | "jpeg" | "svg") }

fn paint(what: &str, p: &Paint, refs: &mut Vec<String>) -> Result<()> {
    opt_color(&format!("{what}.color"), &p.color)?;
    if let Some(g) = &p.gradient {
        if !(2..=8).contains(&g.stops.len()) { return bad(format!("{what}.gradient needs 2 to 8 stops")); }
        range(&format!("{what}.gradient.angle"), g.angle, -360.0, 360.0)?;
        let mut last = -1.0;
        for s in &g.stops {
            range(&format!("{what}.gradient.stops.at"), s.at, 0.0, 1.0)?;
            if s.at < last { return bad(format!("{what}.gradient stops must be in ascending order")); }
            last = s.at;
            color(&format!("{what}.gradient.stops.color"), &s.color)?;
        }
    }
    range(&format!("{what}.textureOpacity"), p.texture_opacity, 0.0, 1.0)?;
    if let Some(t) = &p.texture { asset_ref(&format!("{what}.texture"), t)?; refs.push(t.clone()); }
    Ok(())
}

fn asset_ref(what: &str, p: &str) -> Result<()> {
    if !safe_path(p) { return bad(format!("{what}: unsafe or malformed path '{p}'")); }
    if !is_image_ext(&ext(p)) { return bad(format!("{what}: '{p}' is not a png, webp, jpg or svg image")); }
    Ok(())
}

/// Validazione semantica del manifest. Restituisce l'elenco dei file immagine che il manifest richiede.
pub fn validate_manifest(m: &Manifest) -> Result<Vec<String>> {
    if m.format != FORMAT_VERSION { return bad(format!("unsupported format version {} (this app reads version {FORMAT_VERSION})", m.format)); }
    if !valid_id(&m.id) { return bad("id must be 3-40 characters: lowercase letters, digits and single dashes"); }
    text("name", &m.name, 60, true)?;
    text("author", &m.author, 80, true)?;
    text("license", &m.license, 64, true)?;
    text("description", &m.description, 600, false)?;
    let v: Vec<&str> = m.version.split('.').collect();
    if v.len() != 3 || v.iter().any(|p| p.is_empty() || p.len() > 6 || !p.bytes().all(|b| b.is_ascii_digit())) { return bad("version must look like 1.0.0"); }
    if let Some(u) = &m.source_url { if !(u.starts_with("https://") && u.len() <= 300 && !u.chars().any(|c| c.is_whitespace() || c.is_control())) { return bad("sourceUrl must be an https URL"); } }
    if m.board.is_none() && m.pieces.is_none() { return bad("a theme must provide 'board', 'pieces' or both"); }
    let mut refs = Vec::new();

    if let Some(b) = &m.board {
        range("board.view.tilt", b.view.tilt, 0.0, 65.0)?;
        range("board.view.camera", b.view.camera, 1.2, 8.0)?;
        paint("board.scene", &b.scene, &mut refs)?;
        if let Some(f) = &b.frame {
            range("board.frame.width", f.width, 0.0, 0.8)?;
            range("board.frame.bevel", f.bevel, 0.0, 1.0)?;
            paint("board.frame.paint", &f.paint, &mut refs)?;
            if let Some(g) = &f.glow {
                color("board.frame.glow.color", &g.color)?;
                range("board.frame.glow.radius", g.radius, 0.0, 1.0)?;
                if let Some(p) = g.pulse_seconds { range("board.frame.glow.pulseSeconds", p, 0.4, 20.0)?; }
            }
        }
        paint("board.squares.light", &b.squares.light, &mut refs)?;
        paint("board.squares.dark", &b.squares.dark, &mut refs)?;
        for (n, p) in [("light", &b.squares.light), ("dark", &b.squares.dark)] {
            if p.color.is_none() && p.gradient.is_none() && p.texture.is_none() { return bad(format!("board.squares.{n} needs a color, gradient or texture")); }
        }
        range("board.squares.gloss", b.squares.gloss, 0.0, 1.0)?;
        range("board.squares.bevel", b.squares.bevel, 0.0, 1.0)?;
        if let Some(g) = &b.squares.grid { color("board.squares.grid.color", &g.color)?; range("board.squares.grid.width", g.width, 0.0, 0.2)?; range("board.squares.grid.glow", g.glow, 0.0, 1.0)?; }
        let h = &b.highlights;
        for (n, c) in [("lastMove", &h.last_move), ("selected", &h.selected), ("legal", &h.legal), ("check", &h.check), ("hint", &h.hint)] { opt_color(&format!("board.highlights.{n}"), c)?; }
        opt_color("board.coordinates.color", &b.coordinates.color)?;
        if b.ambient.len() > 4 { return bad("board.ambient: at most 4 effects"); }
        for a in &b.ambient {
            match a {
                Ambient::Sweep { color: c, period_seconds, opacity, width } => { color("ambient.sweep.color", c)?; range("ambient.sweep.periodSeconds", *period_seconds, 1.0, 60.0)?; range("ambient.sweep.opacity", *opacity, 0.0, 1.0)?; range("ambient.sweep.width", *width, 0.05, 1.0)?; }
                Ambient::Particles { color: c, count, size, speed, glow, .. } => { color("ambient.particles.color", c)?; if !(1..=200).contains(count) { return bad("ambient.particles.count must be 1-200"); } range("ambient.particles.size", *size, 0.002, 0.1)?; range("ambient.particles.speed", *speed, 0.0, 0.5)?; range("ambient.particles.glow", *glow, 0.0, 1.0)?; }
                Ambient::Vignette { color: c, strength } => { color("ambient.vignette.color", c)?; range("ambient.vignette.strength", *strength, 0.0, 1.0)?; }
            }
        }
    }

    if let Some(p) = &m.pieces {
        let has_res = p.source.contains("{res}");
        if !p.source.contains("{piece}") { return bad("pieces.source must contain {piece}"); }
        if !(1..=4).contains(&p.resolutions.len()) { return bad("pieces.resolutions needs 1 to 4 entries"); }
        for r in &p.resolutions { if !(r.len() == 2 && r.as_bytes()[0].is_ascii_digit() && (b'1'..=b'8').contains(&r.as_bytes()[0]) && r.ends_with('x')) { return bad(format!("pieces.resolutions: '{r}' is not like 1x, 2x, 4x")); } }
        if !has_res && p.resolutions.len() != 1 { return bad("pieces.source has no {res}, so exactly one resolution is allowed"); }
        if !(16..=2048).contains(&p.base_size) { return bad("pieces.baseSize must be 16-2048"); }
        range("pieces.scale", p.scale, 0.3, 2.5)?;
        range("pieces.anchor.x", p.anchor.x, 0.0, 1.0)?;
        range("pieces.anchor.y", p.anchor.y, 0.0, 1.0)?;
        range("pieces.offsetY", p.offset_y, -1.0, 1.0)?;
        if let Some(r) = &p.recolor { opt_color("pieces.recolor.white", &r.white)?; opt_color("pieces.recolor.black", &r.black)?; }
        if let Some(f) = &p.frames { if !(2..=120).contains(&f.count) { return bad("pieces.frames.count must be 2-120"); } range("pieces.frames.fps", f.fps, 1.0, 60.0)?; }
        if let Some(s) = &p.shadow { color("pieces.shadow.color", &s.color)?; range("pieces.shadow.opacity", s.opacity, 0.0, 1.0)?; range("pieces.shadow.blur", s.blur, 0.0, 1.0)?; range("pieces.shadow.scale", s.scale, 0.2, 2.0)?; }
        if let Some(i) = &p.idle {
            range("pieces.idle.amplitude", i.amplitude, 0.0, 0.2)?; range("pieces.idle.periodSeconds", i.period_seconds, 0.5, 20.0)?; opt_color("pieces.idle.color", &i.color)?;
            if i.style == IdleStyle::Frames && p.frames.is_none() { return bad("pieces.idle.style 'frames' requires pieces.frames"); }
        }
        if let Some(mo) = &p.motion {
            if !(80..=1500).contains(&mo.duration_ms) { return bad("pieces.motion.durationMs must be 80-1500"); }
            range("pieces.motion.lift", mo.lift, 0.0, 1.5)?; range("pieces.motion.squash", mo.squash, 0.0, 0.4)?;
            if let Some(t) = &mo.trail { color("pieces.motion.trail.color", &t.color)?; range("pieces.motion.trail.length", t.length, 0.0, 1.0)?; range("pieces.motion.trail.width", t.width, 0.02, 0.6)?; }
            if let Some(i) = &mo.impact { color("pieces.motion.impact.color", &i.color)?; range("pieces.motion.impact.size", i.size, 0.1, 1.5)?; }
        }
        if let Some(c) = &p.capture {
            opt_color("pieces.capture.color", &c.color)?;
            if !(4..=120).contains(&c.particles) { return bad("pieces.capture.particles must be 4-120"); }
            if !(120..=1500).contains(&c.duration_ms) { return bad("pieces.capture.durationMs must be 120-1500"); }
        }
        for pc in PIECES {
            for r in &p.resolutions {
                let path = piece_path(p, pc, r);
                asset_ref("pieces.source", &path)?;
                if p.recolor.is_some() && ext(&path) != "svg" { return bad("pieces.recolor works only with svg sources"); }
                refs.push(path);
            }
        }
    }
    refs.sort(); refs.dedup();
    Ok(refs)
}

pub fn piece_path(p: &PieceSpec, piece: &str, res: &str) -> String { p.source.replace("{piece}", piece).replace("{res}", res) }

// ------------------------------------------------------------------ immagini

/// Dimensioni lette dall'intestazione, verificando la firma reale del file.
pub fn image_size(path: &str, data: &[u8]) -> Result<Option<(u32, u32)>> {
    match ext(path).as_str() {
        "png" => {
            if data.len() < 33 || &data[..8] != b"\x89PNG\r\n\x1a\n" || &data[12..16] != b"IHDR" { return bad(format!("{path}: not a valid PNG")); }
            Ok(Some((u32::from_be_bytes(data[16..20].try_into().unwrap()), u32::from_be_bytes(data[20..24].try_into().unwrap()))))
        }
        "webp" => {
            if data.len() < 30 || &data[..4] != b"RIFF" || &data[8..12] != b"WEBP" { return bad(format!("{path}: not a valid WebP")); }
            let le24 = |o: usize| data[o] as u32 | (data[o + 1] as u32) << 8 | (data[o + 2] as u32) << 16;
            match &data[12..16] {
                b"VP8X" => Ok(Some((le24(24) + 1, le24(27) + 1))),
                b"VP8 " => Ok(Some(((u16::from_le_bytes([data[26], data[27]]) & 0x3fff) as u32, (u16::from_le_bytes([data[28], data[29]]) & 0x3fff) as u32))),
                b"VP8L" => { let b = u32::from_le_bytes(data[21..25].try_into().unwrap()); Ok(Some(((b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1))) }
                _ => bad(format!("{path}: unsupported WebP variant")),
            }
        }
        "jpg" | "jpeg" => {
            if data.len() < 4 || data[0] != 0xff || data[1] != 0xd8 { return bad(format!("{path}: not a valid JPEG")); }
            let mut i = 2;
            while i + 9 < data.len() {
                if data[i] != 0xff { i += 1; continue; }
                let m = data[i + 1];
                if m == 0xff { i += 1; continue; }
                if (0xc0..=0xcf).contains(&m) && !matches!(m, 0xc4 | 0xc8 | 0xcc) {
                    return Ok(Some((u16::from_be_bytes([data[i + 7], data[i + 8]]) as u32, u16::from_be_bytes([data[i + 5], data[i + 6]]) as u32)));
                }
                if m == 0xd8 || (0xd0..=0xd7).contains(&m) || m == 0x01 { i += 2; continue; }
                i += 2 + u16::from_be_bytes([data[i + 2], data[i + 3]]) as usize;
            }
            bad(format!("{path}: JPEG has no frame header"))
        }
        "svg" => {
            let s = std::str::from_utf8(data).map_err(|_| Error::Data(format!("theme: {path}: SVG is not UTF-8")))?;
            let l = s.to_ascii_lowercase();
            if !l.contains("<svg") { return bad(format!("{path}: not an SVG")); }
            for banned in ["<script", "<foreignobject", "<!entity", "javascript:", "<iframe", "<embed", "<object"] {
                if l.contains(banned) { return bad(format!("{path}: SVG contains forbidden content ({banned})")); }
            }
            if l.contains(" on") && l.split(|c: char| c.is_whitespace() || c == '"' || c == '\'').any(|w| w.starts_with("on") && w.contains('=') && w[2..w.find('=').unwrap()].chars().all(|c| c.is_ascii_alphabetic())) { return bad(format!("{path}: SVG contains event handler attributes")); }
            if l.contains("href=\"http") || l.contains("href='http") || l.contains("url(http") || l.contains("url(\"http") { return bad(format!("{path}: SVG references external resources")); }
            Ok(None)
        }
        _ => bad(format!("{path}: unsupported image type")),
    }
}

// ------------------------------------------------------------------ pacchetto

#[derive(Debug)]
pub struct Package { pub manifest: Manifest, pub manifest_json: String, pub files: BTreeMap<String, Vec<u8>> }

/// Apre e valida un archivio `.cctheme` completo. Nulla viene scritto su disco.
pub fn read_package(bytes: &[u8]) -> Result<Package> {
    if bytes.len() > MAX_ARCHIVE_BYTES { return bad("archive is larger than 64 MB"); }
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| Error::Data(format!("theme: not a valid .cctheme archive ({e})")))?;
    if zip.len() > MAX_FILES { return bad(format!("archive has more than {MAX_FILES} files")); }
    let mut files = BTreeMap::new();
    let mut total = 0u64;
    for i in 0..zip.len() {
        let mut f = zip.by_index(i).map_err(|e| Error::Data(format!("theme: corrupt archive ({e})")))?;
        if f.is_dir() { continue; }
        let name = f.name().map_err(|e| Error::Data(format!("theme: bad file name in archive ({e})")))?.to_string();
        if !safe_path(&name) { return bad(format!("unsafe path in archive: '{name}'")); }
        if f.unix_mode().map(|m| m & 0o170000 == 0o120000).unwrap_or(false) { return bad(format!("'{name}' is a symbolic link")); }
        let allowed = name == "theme.json" || is_image_ext(&ext(&name)) || (ext(&name) == "txt" && !name.contains('/'));
        if !allowed { return bad(format!("file type not allowed in a theme: '{name}'")); }
        let limit = if name == "theme.json" { MAX_MANIFEST_BYTES } else { MAX_FILE_BYTES };
        if f.size() > limit { return bad(format!("'{name}' is too large")); }
        total += f.size();
        if total > MAX_TOTAL_BYTES { return bad("archive expands to more than 160 MB"); }
        // La dimensione dichiarata non basta (zip bomb): si legge con un tetto.
        let mut buf = Vec::new();
        f.by_ref().take(limit + 1).read_to_end(&mut buf)?;
        if buf.len() as u64 > limit { return bad(format!("'{name}' is larger than declared")); }
        if files.insert(name.clone(), buf).is_some() { return bad(format!("duplicate file '{name}'")); }
    }
    let raw = files.get("theme.json").ok_or_else(|| Error::Data("theme: theme.json is missing".into()))?;
    let manifest_json = std::str::from_utf8(raw).map_err(|_| Error::Data("theme: theme.json is not UTF-8".into()))?.to_string();
    let manifest: Manifest = serde_json::from_str(&manifest_json).map_err(|e| Error::Data(format!("theme: theme.json: {e}")))?;
    let refs = validate_manifest(&manifest)?;
    let mut pixels = 0u64;
    for r in &refs {
        let data = files.get(r).ok_or_else(|| Error::Data(format!("theme: file '{r}' is referenced but missing")))?;
        if let Some((w, h)) = image_size(r, data)? {
            if w == 0 || h == 0 || w > MAX_SIDE_PX || h > MAX_SIDE_PX || (w as u64 * h as u64) > MAX_IMAGE_PIXELS { return bad(format!("{r}: image is too large ({w}x{h})")); }
            pixels += w as u64 * h as u64;
        }
    }
    if pixels > MAX_TOTAL_PIXELS { return bad("images use too much memory in total"); }
    // Solo i file referenziati (più theme.json e una licenza) entrano nel pacchetto: il resto è scartato.
    files.retain(|k, _| k == "theme.json" || refs.contains(k) || k.ends_with(".txt"));
    Ok(Package { manifest, manifest_json, files })
}

/// Crea un archivio da una cartella (usato dai test e dagli strumenti di build).
pub fn pack_dir(dir: &Path) -> Result<Vec<u8>> {
    fn walk(base: &Path, cur: &Path, out: &mut Vec<(String, PathBuf)>) -> std::io::Result<()> {
        for e in std::fs::read_dir(cur)? {
            let p = e?.path();
            if p.is_dir() { walk(base, &p, out)?; } else { out.push((p.strip_prefix(base).unwrap().to_string_lossy().replace('\\', "/"), p)); }
        }
        Ok(())
    }
    let mut list = Vec::new();
    walk(dir, dir, &mut list)?;
    list.sort();
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (name, path) in list {
        zip.start_file(name, opts).map_err(|e| Error::Data(e.to_string()))?;
        zip.write_all(&std::fs::read(path)?)?;
    }
    Ok(zip.finish().map_err(|e| Error::Data(e.to_string()))?.into_inner())
}

// ------------------------------------------------------------------ installazione

#[derive(Debug, Clone, Serialize)]
pub struct Installed { pub id: String, pub installed_at: String, pub manifest: serde_json::Value }

pub fn themes_dir(data_dir: &Path) -> PathBuf { data_dir.join("themes") }

/// Valida e installa (o aggiorna) un tema. `reserved` = id dei temi incorporati, non sovrascrivibili.
pub fn install(conn: &Connection, data_dir: &Path, bytes: &[u8], reserved: &[&str]) -> Result<Installed> {
    let pkg = read_package(bytes)?;
    let m = &pkg.manifest;
    if reserved.contains(&m.id.as_str()) { return bad(format!("'{}' is the id of a built-in theme; choose another id", m.id)); }
    let root = themes_dir(data_dir);
    std::fs::create_dir_all(&root)?;
    let tmp = root.join(format!(".tmp-{}-{}", m.id, std::process::id()));
    if tmp.exists() { std::fs::remove_dir_all(&tmp)?; }
    for (name, data) in &pkg.files {
        let dest = tmp.join(name);
        if let Some(parent) = dest.parent() { std::fs::create_dir_all(parent)?; }
        std::fs::write(dest, data)?;
    }
    let final_dir = root.join(&m.id);
    if final_dir.exists() { std::fs::remove_dir_all(&final_dir)?; }
    std::fs::rename(&tmp, &final_dir)?;
    conn.execute(
        "INSERT INTO themes (id, name, version, author, license, provides_board, provides_pieces, manifest) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
         ON CONFLICT(id) DO UPDATE SET name=?2, version=?3, author=?4, license=?5, provides_board=?6, provides_pieces=?7, manifest=?8, installed_at=datetime('now')",
        params![m.id, m.name, m.version, m.author, m.license, m.board.is_some() as i32, m.pieces.is_some() as i32, pkg.manifest_json],
    )?;
    let at: String = conn.query_row("SELECT installed_at FROM themes WHERE id=?1", [&m.id], |r| r.get(0))?;
    Ok(Installed { id: m.id.clone(), installed_at: at, manifest: serde_json::from_str(&pkg.manifest_json).map_err(|e| Error::Data(e.to_string()))? })
}

pub fn list(conn: &Connection) -> Result<Vec<Installed>> {
    let mut st = conn.prepare("SELECT id, installed_at, manifest FROM themes ORDER BY installed_at DESC, id")?;
    let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?;
    let mut out = Vec::new();
    for r in rows {
        let (id, at, json) = r?;
        if let Ok(v) = serde_json::from_str(&json) { out.push(Installed { id, installed_at: at, manifest: v }); }
    }
    Ok(out)
}

pub fn remove(conn: &Connection, data_dir: &Path, id: &str) -> Result<()> {
    if !valid_id(id) { return bad("invalid id"); }
    conn.execute("DELETE FROM themes WHERE id=?1", [id])?;
    let dir = themes_dir(data_dir).join(id);
    if dir.exists() { std::fs::remove_dir_all(dir)?; }
    Ok(())
}

/// Legge una risorsa di un tema installato (percorso validato; resta dentro la cartella del tema).
pub fn read_asset(data_dir: &Path, id: &str, path: &str) -> Result<Vec<u8>> {
    if !valid_id(id) || !safe_path(path) || !is_image_ext(&ext(path)) { return bad("invalid asset request"); }
    let p = themes_dir(data_dir).join(id).join(path);
    let canon = p.canonicalize()?;
    if !canon.starts_with(themes_dir(data_dir).join(id).canonicalize()?) { return bad("asset outside theme folder"); }
    Ok(std::fs::read(canon)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db;

    // PNG 1x1 valido.
    const PNG: &[u8] = &[0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0,0,0,0x0d,0x49,0x48,0x44,0x52,0,0,0,1,0,0,0,1,8,6,0,0,0,0x1f,0x15,0xc4,0x89,0,0,0,0x0d,0x49,0x44,0x41,0x54,0x78,0x9c,0x63,0xf8,0xff,0xff,0x3f,0,5,0xfe,2,0xfe,0xa7,0x35,0x81,0x84,0,0,0,0,0x49,0x45,0x4e,0x44,0xae,0x42,0x60,0x82];
    const SVG: &[u8] = b"<svg xmlns='http://www.w3.org/2000/svg' width='4' height='4'><rect width='4' height='4'/></svg>";

    fn zip_of(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut z = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let o = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        for (n, d) in files { z.start_file(*n, o).unwrap(); z.write_all(d).unwrap(); }
        z.finish().unwrap().into_inner()
    }
    fn board_json(extra: &str) -> String {
        format!(r##"{{"format":1,"id":"test-theme","name":"T","version":"1.0.0","author":"a","license":"CC0-1.0",
          "board":{{"squares":{{"light":{{"color":"#eee"}},"dark":{{"color":"#444","texture":"dark.png"}}}}{extra}}}}}"##)
    }
    fn mk(json: &str) -> Vec<u8> { zip_of(&[("theme.json", json.as_bytes()), ("dark.png", PNG)]) }

    #[test]
    fn accepts_valid_board_theme() {
        let p = read_package(&mk(&board_json(""))).unwrap();
        assert_eq!(p.manifest.id, "test-theme");
        assert!(p.files.contains_key("dark.png"));
    }

    #[test]
    fn accepts_full_piece_theme_with_svg_and_animation() {
        let mut files: Vec<(String, Vec<u8>)> = PIECES.iter().map(|p| (format!("p/{p}.svg"), SVG.to_vec())).collect();
        let json = r##"{"format":1,"id":"svg-set","name":"S","version":"2.1.0","author":"a","license":"CC0-1.0",
          "pieces":{"source":"p/{piece}.svg","recolor":{"white":"#ffd","black":"#223"},"shadow":{"color":"#000","opacity":0.3},
          "idle":{"style":"float","amplitude":0.02},"motion":{"style":"arc","durationMs":300,"lift":0.4,"trail":{"color":"#0ff"}},"capture":{"effect":"burst"}}}"##;
        files.push(("theme.json".into(), json.as_bytes().to_vec()));
        let refs: Vec<(&str, &[u8])> = files.iter().map(|(n, d)| (n.as_str(), d.as_slice())).collect();
        read_package(&zip_of(&refs)).unwrap();
    }

    fn rejects(json: &str, needle: &str) {
        let e = read_package(&mk(json)).unwrap_err().to_string();
        assert!(e.contains(needle), "expected '{needle}' in '{e}'");
    }

    #[test]
    fn rejects_bad_manifest_values() {
        rejects(&board_json(",\"gloss\":3"), "gloss");
        rejects(&board_json("").replace("#eee", "red"), "invalid color");
        rejects(&board_json("").replace("test-theme", "Bad_ID"), "id must be");
        rejects(&board_json("").replace("\"format\":1", "\"format\":2"), "unsupported format");
        rejects(&board_json("").replace("1.0.0", "1.0"), "version");
        rejects(&board_json(",\"unknownField\":1"), "unknown field");
        rejects(&board_json("").replace("\"squares\"", "\"view\":{\"tilt\":89},\"squares\""), "tilt");
    }

    #[test]
    fn rejects_hostile_archives() {
        let ok = board_json("");
        assert!(read_package(b"not a zip").is_err());
        assert!(read_package(&zip_of(&[("theme.json", ok.as_bytes())])).unwrap_err().to_string().contains("missing"));
        for bad_name in ["../evil.png", "/abs.png", "a//b.png", ".hidden.png"] {
            let z = zip_of(&[("theme.json", ok.as_bytes()), ("dark.png", PNG), (bad_name, PNG)]);
            assert!(read_package(&z).is_err(), "{bad_name} must be rejected");
        }
        let z = zip_of(&[("theme.json", ok.as_bytes()), ("dark.png", PNG), ("run.js", b"alert(1)")]);
        assert!(read_package(&z).unwrap_err().to_string().contains("not allowed"));
        let z = zip_of(&[("theme.json", ok.as_bytes()), ("dark.png", b"GIF89a-not-a-png")]);
        assert!(read_package(&z).unwrap_err().to_string().contains("not a valid PNG"));
        let mut huge = PNG.to_vec(); huge[16..20].copy_from_slice(&9000u32.to_be_bytes());
        assert!(read_package(&zip_of(&[("theme.json", ok.as_bytes()), ("dark.png", &huge)])).unwrap_err().to_string().contains("too large"));
        let evil_svg = b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>";
        assert!(image_size("a.svg", evil_svg).is_err());
        assert!(image_size("a.svg", b"<svg onload='x()'></svg>").is_err());
        assert!(image_size("a.svg", b"<svg><image href=\"https://x/y.png\"/></svg>").is_err());
        assert!(image_size("a.svg", SVG).is_ok());
    }

    #[test]
    fn rejects_missing_referenced_asset() {
        let z = zip_of(&[("theme.json", board_json("").as_bytes())]);
        assert!(read_package(&z).unwrap_err().to_string().contains("missing"));
    }

    #[test]
    fn install_list_asset_remove_roundtrip() {
        let conn = db::open_in_memory().unwrap();
        let dir = std::env::temp_dir().join(format!("cc-theme-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let z = mk(&board_json(""));
        assert!(install(&conn, &dir, &z, &["test-theme"]).unwrap_err().to_string().contains("built-in"));
        let inst = install(&conn, &dir, &z, &[]).unwrap();
        assert_eq!(inst.id, "test-theme");
        assert_eq!(list(&conn).unwrap().len(), 1);
        install(&conn, &dir, &z, &[]).unwrap(); // aggiornamento: nessun duplicato
        assert_eq!(list(&conn).unwrap().len(), 1);
        assert_eq!(read_asset(&dir, "test-theme", "dark.png").unwrap(), PNG);
        assert!(read_asset(&dir, "test-theme", "../test-theme/theme.json").is_err());
        assert!(read_asset(&dir, "test-theme", "theme.json").is_err());
        remove(&conn, &dir, "test-theme").unwrap();
        assert!(list(&conn).unwrap().is_empty() && !dir.join("themes/test-theme").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn image_header_parsing() {
        assert_eq!(image_size("a.png", PNG).unwrap(), Some((1, 1)));
        assert!(valid_id("neon-night") && !valid_id("-x") && !valid_id("ab") && !valid_id("a--b") && !valid_id("UP"));
        assert!(safe_path("pieces/wK@2x.png") && !safe_path("../x") && !safe_path("a\\b"));
    }
}
