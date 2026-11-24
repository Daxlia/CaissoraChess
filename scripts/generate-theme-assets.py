#!/usr/bin/env python3
"""Generates the textures and rendered piece sprites of the built-in themes (src/themes/builtin).

Everything is procedural (noise, veins, lighting from the piece silhouettes), so the output is original work.
The cburnett SVGs are only used as the silhouette/detail source for the shaded sets (GPL-2.0-or-later, see its LICENSE.txt).
Usage: python3 scripts/generate-theme-assets.py   (needs numpy, scipy, Pillow, playwright+chromium)
"""
import json, io, os, sys
import numpy as np
from scipy import ndimage as ndi
from PIL import Image

ROOT = os.path.join(os.path.dirname(__file__), "..", "src", "themes", "builtin")
SVG_DIR = os.path.join(ROOT, "classic", "pieces")
rng = np.random.default_rng(1905)
N = 1024

def save(arr, path, q=84):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    Image.fromarray(np.clip(arr * 255, 0, 255).astype(np.uint8)).save(path, "WEBP", quality=q, method=6)

def fbm(h, w, base=4, octaves=6, aniso=(1, 1), gain=0.5):
    out = np.zeros((h, w)); amp = 1; tot = 0
    for o in range(octaves):
        gy, gx = max(2, int(base * aniso[0] * 2 ** o)), max(2, int(base * aniso[1] * 2 ** o))
        g = rng.random((gy, gx))
        out += amp * ndi.zoom(g, (h / gy, w / gx), order=3, mode="reflect")[:h, :w]
        tot += amp; amp *= gain
    out /= tot
    return (out - out.min()) / (out.max() - out.min() + 1e-9)

def ramp(t, stops):
    t = np.clip(t, 0, 1)[..., None]
    xs = [s[0] for s in stops]; cols = np.array([s[1] for s in stops], float) / 255
    out = np.zeros(t.shape[:2] + (3,))
    for c in range(3): out[..., c] = np.interp(t[..., 0], xs, cols[:, c])
    return out

def wood(light):
    y = np.linspace(0, 1, N)[:, None]; x = np.linspace(0, 1, N)[None, :]
    warp = fbm(N, N, 3, 5, (2.0, 0.5))
    rings = np.sin((y * (22 if light else 16) + warp * 6.5) * np.pi * 2)
    rings = 0.5 + 0.5 * rings
    grain = fbm(N, N, 3, 6, (24, 1.2), 0.62)
    pores = fbm(N, N, 90, 2, (1, 0.04))
    t = 0.45 * rings + 0.40 * grain + 0.15 * pores
    t = (t - t.min()) / (t.max() - t.min())
    stops = [(0, (233, 207, 158)), (.5, (214, 178, 120)), (1, (176, 134, 80))] if light else [(0, (128, 84, 50)), (.5, (96, 58, 32)), (1, (62, 36, 20))]
    return ramp(t, stops)

def marble(light):
    warp = fbm(N, N, 2, 6)
    yy = np.linspace(0, 1, N)[:, None]; xx = np.linspace(0, 1, N)[None, :]
    v = np.abs(np.sin((xx * 3.2 + yy * 1.4 + warp * 3.4) * np.pi))
    v2 = np.abs(np.sin((xx * 1.1 - yy * 2.3 + fbm(N, N, 3, 6) * 4.1) * np.pi))
    veins = np.clip(1 - v ** 0.12 * 0 - v * 6, 0, 1) ** 2.2 * 0.9 + np.clip(1 - v2 * 12, 0, 1) ** 2 * 0.45
    cloud = fbm(N, N, 3, 7)
    if light:
        base = ramp(cloud, [(0, (246, 244, 240)), (1, (222, 222, 224))])
        return base * (1 - 0.55 * veins[..., None]) + np.array([.45, .47, .52]) * 0.0
    base = ramp(cloud, [(0, (14, 15, 19)), (1, (36, 38, 46))])
    gold = np.array([0.84, 0.66, 0.30])
    return np.clip(base + veins[..., None] * (gold * 0.85) * 0.85, 0, 1)

def glacier(light):
    cloud = fbm(N, N, 3, 7)
    ridged = 1 - np.abs(fbm(N, N, 4, 6) * 2 - 1)
    cracks = np.clip((ridged - 0.93) * 14, 0, 1)
    frost = fbm(N, N, 140, 2)
    if light:
        base = ramp(cloud * 0.8 + frost * 0.2, [(0, (236, 247, 253)), (1, (196, 224, 242))])
        return np.clip(base - cracks[..., None] * np.array([0.35, 0.22, 0.12]), 0, 1)
    base = ramp(cloud * 0.75 + frost * 0.25, [(0, (74, 128, 168)), (1, (38, 84, 124))])
    return np.clip(base + cracks[..., None] * np.array([0.35, 0.4, 0.45]), 0, 1)

def brushed(stops, h=512, w=1024):
    s = fbm(h, w, 2, 6, (60, 1.0), 0.65)
    s2 = fbm(h, w, 18, 3, (30, 0.5))
    return ramp(0.7 * s + 0.3 * s2, stops)

# ---------------------------------------------------------------- pieces
def rasterize_svgs():
    from playwright.sync_api import sync_playwright
    out = {}
    with sync_playwright() as p:
        b = p.chromium.launch(); pg = b.new_page(viewport={"width": 1024, "height": 1024})
        for c in "wb":
            for t in "PNBRQK":
                svg = open(os.path.join(SVG_DIR, f"{c}{t}.svg")).read()
                pg.set_content(f"<body style='margin:0;background:transparent'><div style='width:1024px;height:1024px'>{svg.replace('<svg ', '<svg width=\"1024\" height=\"1024\" ', 1)}</div></body>")
                png = pg.screenshot(omit_background=True, clip={"x": 0, "y": 0, "width": 1024, "height": 1024})
                out[c + t] = np.asarray(Image.open(io.BytesIO(png)).convert("RGBA"), float) / 255
        b.close()
    return out

L = np.array([-0.45, -0.65, 0.62]); L /= np.linalg.norm(L)

def shade(rgba, color, mat, base_rgb, accent=None):
    A = rgba[..., 3]; lum = rgba[..., :3].mean(axis=2)
    mask = ndi.gaussian_filter((A > 0.5).astype(float), 1.2)
    dist = ndi.distance_transform_edt(A > 0.5)
    H = ndi.gaussian_filter(np.minimum(dist, 70) ** 0.8, 6)
    H = H / (H.max() + 1e-9) * 90
    gy, gx = np.gradient(H)
    n = np.dstack([-gx, -gy, np.ones_like(H)]); n /= np.linalg.norm(n, axis=2, keepdims=True)
    diff = np.clip((n * L).sum(2), 0, 1)
    hv = L + np.array([0, 0, 1.0]); hv /= np.linalg.norm(hv)
    ndh = np.clip((n * hv).sum(2), 0, 1)
    rim = (1 - n[..., 2]) ** 1.6
    base = np.array(base_rgb, float) / 255
    detail = (1 - lum) if color == "w" else lum   # dark linework on white sets, light linework on black sets
    detail = np.clip(ndi.gaussian_filter(detail * (A > 0.4), 0.8), 0, 1)
    if mat == "metal":
        env = np.clip(0.5 + 0.5 * n[..., 1] * 1.6 + 0.35 * n[..., 0], 0, 1)
        band = ramp(env, [(0, (30, 22, 14)), (.35, (120, 96, 50)), (.55, (255, 236, 170)), (.7, (140, 108, 52)), (1, (40, 30, 18))]) if color == "w" else \
               ramp(env, [(0, (6, 6, 8)), (.4, (34, 34, 42)), (.58, (150, 152, 170)), (.72, (40, 40, 52)), (1, (10, 10, 14))])
        rgb = band * (0.55 + 0.6 * diff[..., None]) + (ndh ** 40)[..., None] * 0.9
        rgb = np.where(color == "w", rgb, rgb)
        rgb *= (1 - 0.55 * detail[..., None]) if color == "w" else 1
        if color == "b": rgb = rgb + detail[..., None] * 0.45 * np.array([0.9, 0.78, 0.45])
        alpha = A
    elif mat == "glass":
        inner = 0.30 + 0.35 * diff
        rgb = base * inner[..., None] + (accent if accent is not None else base)[None, None, :] * (rim ** 0.8)[..., None] * 0.9 + (ndh ** 60)[..., None]
        rgb = rgb + detail[..., None] * (0.25 if color == "w" else 0.5)
        alpha = A * np.clip(0.50 + 0.9 * rim + 0.6 * detail + 0.3 * ndh ** 10, 0, 1)
    else:  # matte gloss (ivory / ebony)
        rgb = base * (0.45 + 0.65 * diff[..., None]) + (ndh ** 28)[..., None] * (0.55 if color == "w" else 0.35) + rim[..., None] * 0.04
        rgb = rgb * (1 - 0.6 * detail[..., None]) if color == "w" else rgb + detail[..., None] * 0.38
        alpha = A
    rgb = np.clip(rgb, 0, 1)
    return np.dstack([rgb, np.clip(alpha, 0, 1)])

def save_rgba(arr, path, size, q=88):
    img = Image.fromarray((arr * 255).astype(np.uint8), "RGBA").resize((size, size), Image.LANCZOS)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, "WEBP", quality=q, method=6, exact=True)

SETS = {
    "obsidian": dict(mat="metal", w=(240, 205, 120), b=(30, 30, 38)),
    "neon": dict(mat="glass", w=(40, 200, 235), b=(150, 40, 200), acc_w=(120, 250, 255), acc_b=(255, 70, 240)),
    "glacier": dict(mat="glass", w=(210, 236, 250), b=(34, 74, 120), acc_w=(255, 255, 255), acc_b=(110, 190, 255)),
    "ivory-ebony": dict(mat="matte", w=(240, 232, 214), b=(40, 34, 32)),
}

def theme_json(id, name, desc, **parts):
    base = dict(format=1, id=id, name=name, version="1.0.0", author="CaissoraChess", license="CC0-1.0", description=desc)
    base.update(parts); return base

def write_json(id, data):
    p = os.path.join(ROOT, id, "theme.json"); os.makedirs(os.path.dirname(p), exist_ok=True)
    json.dump(data, open(p, "w"), indent=2); open(p, "a").write("\n")

def piece_block(**kw):
    d = dict(source="pieces/{res}/{piece}.webp", resolutions=["1x", "2x"], baseSize=256, scale=1.12, anchor=dict(x=0.5, y=0.52),
             shadow=dict(color="#000000", opacity=0.45, blur=0.6, scale=0.8))
    d.update(kw); return d

def main():
    print("textures…")
    for name, fn in [("wood", wood), ("marble", marble), ("glacier", glacier)]:
        tid = {"wood": "classic", "marble": "obsidian", "glacier": "glacier"}[name]
        for light in (True, False):
            save(fn(light), os.path.join(ROOT, tid, f"{'light' if light else 'dark'}.webp"), 84)
    save(brushed([(0, (92, 62, 36)), (.5, (124, 84, 48)), (1, (70, 46, 26))]), os.path.join(ROOT, "classic", "frame.webp"), 82)
    save(brushed([(0, (120, 88, 30)), (.35, (236, 204, 120)), (.6, (170, 128, 52)), (1, (96, 70, 24))]), os.path.join(ROOT, "obsidian", "frame.webp"), 82)
    save(brushed([(0, (150, 180, 204)), (.5, (222, 238, 248)), (1, (120, 156, 184))]), os.path.join(ROOT, "glacier", "frame.webp"), 82)
    print("pieces…")
    src = rasterize_svgs()
    for sid, cfg in SETS.items():
        for pc, img in src.items():
            col = pc[0]
            out = shade(img, col, cfg["mat"], cfg[col], None if cfg["mat"] != "glass" else np.array(cfg["acc_" + col]) / 255)
            for res, px in (("1x", 256), ("2x", 512)):
                save_rgba(out, os.path.join(ROOT, sid, "pieces", res, f"{pc}.webp"), px)
    hl = lambda **k: k
    write_json("classic", theme_json("classic", "Classic Wood", "Walnut and maple board with the familiar vector pieces. Light, fast and crisp at any size.",
        board=dict(scene=dict(gradient=dict(kind="radial", stops=[dict(at=0, color="#2d241b"), dict(at=1, color="#100c09")])),
            frame=dict(width=0.34, paint=dict(color="#3a2c20", texture="frame.webp"), bevel=0.7),
            squares=dict(light=dict(color="#ecd9b0", texture="light.webp"), dark=dict(color="#a87c50", texture="dark.webp"), gloss=0.14, bevel=0.18),
            highlights=dict(style="fill", lastMove="rgba(246,226,90,0.5)", selected="rgba(80,160,255,0.5)", legal="rgba(30,20,10,0.38)", check="rgba(235,60,60,0.7)", hint="#2fbf71"),
            coordinates=dict(placement="frame", color="rgba(240,226,200,0.85)"), ambient=[dict(type="vignette", color="#000000", strength=0.35)]),
        pieces=dict(source="pieces/{piece}.svg", scale=1.0, shadow=dict(color="#000000", opacity=0.35, blur=0.5, scale=0.75),
            motion=dict(style="slide", durationMs=200, easing="ease-out"), capture=dict(effect="fade", durationMs=220, particles=8))))
    write_json("obsidian", theme_json("obsidian", "Obsidian & Gold", "Black and white marble under a tilted camera, brushed-gold frame, drifting gold dust and gleaming metal pieces that hop across the board.",
        board=dict(view=dict(tilt=38, camera=2.7), scene=dict(gradient=dict(kind="radial", stops=[dict(at=0, color="#26252d"), dict(at=1, color="#040405")])),
            frame=dict(width=0.3, paint=dict(color="#9a7a34", texture="frame.webp"), bevel=0.9, glow=dict(color="#ffcf70", radius=0.35, pulseSeconds=5)),
            squares=dict(light=dict(color="#efeeea", texture="light.webp"), dark=dict(color="#1a1b20", texture="dark.webp"), gloss=0.6, bevel=0.1),
            highlights=dict(style="glow", lastMove="rgba(255,205,100,0.6)", selected="rgba(255,236,170,0.75)", legal="rgba(255,205,100,0.85)", check="rgba(255,70,60,0.85)", hint="#ffe38a"),
            coordinates=dict(placement="frame", color="rgba(60,40,10,0.9)"),
            ambient=[dict(type="sweep", color="#fff3d6", periodSeconds=9, opacity=0.35, width=0.22), dict(type="particles", color="#ffd98a", count=32, size=0.007, speed=0.025, direction="up", glow=0.8), dict(type="vignette", color="#000000", strength=0.55)]),
        pieces=piece_block(idle=dict(style="float", amplitude=0.012, periodSeconds=4.2),
            motion=dict(style="arc", durationMs=420, easing="ease-in-out", lift=0.5, squash=0.1, trail=dict(color="#ffcf70", length=0.5, width=0.16), impact=dict(color="#ffcf70", size=0.7)),
            capture=dict(effect="shatter", color="#ffcf70", particles=34, durationMs=600))))
    write_json("neon", theme_json("neon", "Neon Night", "A dark circuit-grid board with pulsing cyan edges, floating sparks and translucent crystal pieces. Hop moves leave a magenta trail.",
        board=dict(view=dict(tilt=30, camera=2.8), scene=dict(gradient=dict(kind="radial", stops=[dict(at=0, color="#1a1240"), dict(at=1, color="#02010a")])),
            frame=dict(width=0.2, paint=dict(gradient=dict(kind="linear", angle=90, stops=[dict(at=0, color="#1c1844"), dict(at=1, color="#0a0820")])), bevel=0.5, glow=dict(color="#19e6ff", radius=0.7, pulseSeconds=3.2)),
            squares=dict(light=dict(gradient=dict(kind="linear", angle=135, stops=[dict(at=0, color="#2a2660"), dict(at=1, color="#1b1845")])), dark=dict(gradient=dict(kind="linear", angle=135, stops=[dict(at=0, color="#100d2e"), dict(at=1, color="#0a0822")])), gloss=0.4, grid=dict(color="#19e6ff", width=0.012, glow=0.85)),
            highlights=dict(style="glow", lastMove="rgba(255,61,242,0.6)", selected="rgba(25,230,255,0.85)", legal="rgba(25,230,255,0.9)", check="rgba(255,60,90,0.9)", hint="#7dff9a"),
            coordinates=dict(color="rgba(125,249,255,0.85)"),
            ambient=[dict(type="sweep", color="#ff3df2", periodSeconds=6, opacity=0.22, width=0.18), dict(type="particles", color="#7df9ff", count=48, size=0.006, speed=0.04, direction="up", glow=1.0), dict(type="vignette", color="#000000", strength=0.6)]),
        pieces=piece_block(idle=dict(style="glow", amplitude=0.02, periodSeconds=2.8, color="#7df9ff"), shadow=dict(color="#19e6ff", opacity=0.3, blur=0.9, scale=0.9),
            motion=dict(style="hop", durationMs=360, easing="spring", lift=0.6, squash=0.12, trail=dict(color="#ff3df2", length=0.6, width=0.2), impact=dict(color="#19e6ff", size=0.8)),
            capture=dict(effect="burst", color="#ff3df2", particles=48, durationMs=620))))
    write_json("glacier", theme_json("glacier", "Glacier", "Frozen blue marble with a frosted-metal frame, falling snow, a slow light sweep and frosted-glass pieces that breathe.",
        board=dict(view=dict(tilt=42, camera=2.5), scene=dict(gradient=dict(kind="radial", stops=[dict(at=0, color="#eaf5fb"), dict(at=1, color="#7da3c2")])),
            frame=dict(width=0.28, paint=dict(color="#a9c6dc", texture="frame.webp"), bevel=0.85),
            squares=dict(light=dict(color="#e8f4fb", texture="light.webp"), dark=dict(color="#4d86b0", texture="dark.webp"), gloss=0.65, bevel=0.12),
            highlights=dict(style="ring", lastMove="rgba(255,255,255,0.75)", selected="rgba(255,255,255,0.95)", legal="rgba(255,255,255,0.9)", check="rgba(255,70,70,0.85)", hint="#1fae6a"),
            coordinates=dict(placement="frame", color="rgba(24,60,92,0.85)"),
            ambient=[dict(type="sweep", color="#ffffff", periodSeconds=10, opacity=0.4, width=0.2), dict(type="particles", color="#ffffff", count=70, size=0.006, speed=0.03, direction="drift", glow=0.4), dict(type="vignette", color="#0b2a44", strength=0.3)]),
        pieces=piece_block(idle=dict(style="breathe", amplitude=0.02, periodSeconds=3.6), shadow=dict(color="#12365a", opacity=0.35, blur=0.7, scale=0.85),
            motion=dict(style="arc", durationMs=360, easing="ease-out", lift=0.32, squash=0.06, impact=dict(color="#ffffff", size=0.6)),
            capture=dict(effect="dissolve", color="#ffffff", particles=40, durationMs=600))))
    write_json("ivory-ebony", theme_json("ivory-ebony", "Ivory & Ebony", "Glossy rendered pieces in ivory and ebony. Pieces only: combine them with any board.",
        pieces=piece_block(motion=dict(style="slide", durationMs=230, easing="ease-out", lift=0.0, squash=0.0), capture=dict(effect="fade", durationMs=260, particles=8))))
    write_json("emerald", theme_json("emerald", "Emerald Club", "A flat, light board made only of gradients (no images): cream and emerald with a deep green frame. Board only.",
        board=dict(scene=dict(gradient=dict(kind="linear", angle=160, stops=[dict(at=0, color="#16281f"), dict(at=1, color="#0a120e")])),
            frame=dict(width=0.3, paint=dict(color="#1e3b2c", gradient=dict(kind="linear", angle=45, stops=[dict(at=0, color="#2b5640"), dict(at=1, color="#16301f")])), bevel=0.6),
            squares=dict(light=dict(gradient=dict(kind="linear", angle=135, stops=[dict(at=0, color="#f6efd6"), dict(at=1, color="#e7dcb8")])), dark=dict(gradient=dict(kind="linear", angle=135, stops=[dict(at=0, color="#4a9068"), dict(at=1, color="#357452")])), gloss=0.2, bevel=0.1),
            highlights=dict(style="fill", lastMove="rgba(255,226,90,0.55)", selected="rgba(70,150,255,0.5)", legal="rgba(10,40,20,0.4)", check="rgba(235,60,60,0.7)", hint="#ffd23f"),
            coordinates=dict(placement="frame", color="rgba(230,244,230,0.85)"), ambient=[])))
    print("done")

if __name__ == "__main__":
    main()
