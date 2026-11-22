#!/usr/bin/env node
// Downloads the official Stockfish release assets and places them where the Tauri build expects them.
// Source of the asset names: official-stockfish/Stockfish .github/ci/*.json and upload_binaries.yml.
//
//   node scripts/fetch-stockfish.mjs                 # all platforms
//   node scripts/fetch-stockfish.mjs linux-x64       # one target
//   node scripts/fetch-stockfish.mjs --print-hashes  # download and print SHA-256 (to pin them)
//
// Needs `tar` (bsdtar on Windows 10+ also extracts .zip). Every download is verified against the
// pinned SHA-256 below; a mismatch aborts the build.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, copyFileSync, chmodSync, rmSync, readFileSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TAG = "sf_19";
const BASE = `https://github.com/official-stockfish/Stockfish/releases/download/${TAG}`;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "src-tauri", "binaries"); // desktop sidecars: stockfish-<target-triple>[.exe]
const ANDROID = join(ROOT, "src-tauri", "android-libs"); // <abi>/libstockfish.so, packaged by the Android plugin

/** inner = file name of the executable inside the archive. */
const TARGETS = {
  "windows-x64": { asset: "stockfish-windows-x86-64-universal.zip", inner: "stockfish-windows-x86-64-universal.exe", out: join(BIN, "stockfish-x86_64-pc-windows-msvc.exe") },
  "windows-arm64": { asset: "stockfish-windows-arm64-universal.zip", inner: "stockfish-windows-arm64-universal.exe", out: join(BIN, "stockfish-aarch64-pc-windows-msvc.exe") },
  "linux-x64": { asset: "stockfish-linux-x86-64-universal.tar.gz", inner: "stockfish-linux-x86-64-universal", out: join(BIN, "stockfish-x86_64-unknown-linux-gnu") },
  "linux-arm64": { asset: "stockfish-linux-arm64-universal.tar.gz", inner: "stockfish-linux-arm64-universal", out: join(BIN, "stockfish-aarch64-unknown-linux-gnu") },
  "android-arm64": { asset: "stockfish-android-arm64-universal.tar.gz", inner: "stockfish-android-arm64-universal", out: join(ANDROID, "arm64-v8a", "libstockfish.so") },
  "android-armv7": { asset: "stockfish-android-armv7-neon.tar.gz", inner: "stockfish-android-armv7-neon", out: join(ANDROID, "armeabi-v7a", "libstockfish.so") },
};

/** SHA-256 of the release archives (filled in with --print-hashes). */
const SHA256 = {
  "windows-x64": "3c8bf1f9ea66a09350a40df4f632288285ac206d99f33ab5842c408fc30b48a7",
  "windows-arm64": "8372ad3f0d7276deb2c70f801f541ec7db463219fc6d9c7592864e542aa4f401",
  "linux-x64": "9defc0d4e55d49c65a6d042f3e571a39fcea499ade6dbe741b53b8c65e03611f",
  "linux-arm64": "fe26cfd1d9db4c8af3d21e24d9ff34cacb31c1f940085a7583da11796f2bac01",
  "android-arm64": "ebb24051aa4a222b4daaf049b882ecf1163d370c128fe02316602643f4d5e426",
  "android-armv7": "47c34963f1cdf4a6af34c1b5294f7a4e2679b3eb52698c324855af2c6486024b",
};

const args = process.argv.slice(2);
const printHashes = args.includes("--print-hashes");
const wanted = args.filter((a) => !a.startsWith("--"));
const names = wanted.length ? wanted : Object.keys(TARGETS);

/** .zip: `unzip` if present (Linux/macOS CI), else `tar` (bsdtar on Windows 10+ reads zips). Others: `tar`. */
function extract(archive, dir) {
  if (archive.endsWith(".zip")) {
    try { execFileSync("unzip", ["-q", "-o", archive, "-d", dir]); return; } catch (e) { if (e.code !== "ENOENT") throw e; }
  }
  execFileSync("tar", ["-xf", archive, "-C", dir]);
}

function findFile(dir, name) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { const r = findFile(p, name); if (r) return r; }
    else if (e.name === name) return p;
  }
  return null;
}

for (const name of names) {
  const t = TARGETS[name];
  if (!t) { console.error(`unknown target "${name}". Valid: ${Object.keys(TARGETS).join(", ")}`); process.exit(2); }
  const tmp = mkdtempSync(join(tmpdir(), "caissora-sf-"));
  try {
    const archive = join(tmp, t.asset);
    process.stdout.write(`${name}: downloading ${t.asset} ... `);
    const res = await fetch(`${BASE}/${t.asset}`, { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${BASE}/${t.asset}`);
    await pipeline(res.body, createWriteStream(archive));
    const sha = createHash("sha256").update(readFileSync(archive)).digest("hex");
    if (printHashes) { console.log(`\n  "${name}": "${sha}",`); }
    else if (!SHA256[name]) throw new Error(`no pinned SHA-256 for ${name} (run with --print-hashes and pin it)`);
    else if (SHA256[name] !== sha) throw new Error(`SHA-256 mismatch for ${t.asset}: got ${sha}`);
    extract(archive, tmp);
    const exe = findFile(tmp, t.inner);
    if (!exe) throw new Error(`${t.inner} not found inside ${t.asset}`);
    mkdirSync(dirname(t.out), { recursive: true });
    copyFileSync(exe, t.out);
    if (!t.out.endsWith(".exe")) chmodSync(t.out, 0o755);
    console.log(printHashes ? "ok" : `ok -> ${t.out.replace(ROOT, ".")}`);
  } catch (e) {
    console.error(`\n${name}: FAILED: ${e.message}`);
    process.exitCode = 1;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
