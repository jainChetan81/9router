#!/usr/bin/env node
// Builds the icon font the app ships: Material Symbols Outlined, cut down to the icons the code uses.
// The full font is 3.9 MB and every page loaded it.
//
//   node scripts/subset-icons.mjs           rebuild src/app/fonts/ (needs python3 with fonttools + brotli,
//                                            or `uv`, which fetches them for the run)
//   node scripts/subset-icons.mjs --check   fail when the code uses an icon the committed subset lacks
//
// Icons are written as ligature text (<span class="material-symbols-outlined">home</span>), often through
// a variable or a prop, so "used" means: any quoted string or JSX text in the scanned folders that is
// exactly a Material Symbols icon name. That over-collects (a string "error" keeps the error icon), which
// only costs a few bytes, and never misses a name that is written out in the source.
// A name built at run time (`"arrow_" + dir`) is not seen: write the full names somewhere in the source.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SCAN_DIRS = ["src", "open-sse"];
export const SOURCE_FONT = join(ROOT, "node_modules/material-symbols/material-symbols-outlined.woff2");
export const NAMES_FILE = join(ROOT, "node_modules/material-symbols/index.d.ts");
export const SUBSET_FONT = join(ROOT, "src/app/fonts/material-symbols-outlined.subset.woff2");
export const MANIFEST = join(ROOT, "src/app/fonts/material-symbols-subset.json");
const EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".json", ".css", ".md", ".mdx"]);
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "fonts"]);
const QUOTED = /(["'`])([a-z0-9_]{2,40})\1/g;
const JSX_TEXT = />\s*([a-z0-9_]{2,40})\s*</g;

/** Every icon name the installed material-symbols package knows. */
export function knownIcons(file = NAMES_FILE) {
  return new Set([...readFileSync(file, "utf8").matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]));
}

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) yield* files(join(dir, entry.name)); }
    else if (EXTENSIONS.has(extname(entry.name))) yield join(dir, entry.name);
  }
}

/** Icon names found in one source text. */
export function iconsInText(text, known) {
  const out = new Set();
  for (const pattern of [QUOTED, JSX_TEXT]) {
    for (const m of text.matchAll(pattern)) { const name = m[2] ?? m[1]; if (known.has(name)) out.add(name); }
  }
  return out;
}

/** Icon names used in the scanned folders: Map name -> first file that uses it. */
export function usedIcons(known = knownIcons(), root = ROOT) {
  const used = new Map();
  for (const dir of SCAN_DIRS) {
    let exists = false;
    try { exists = statSync(join(root, dir)).isDirectory(); } catch {}
    if (!exists) continue;
    for (const file of files(join(root, dir))) {
      for (const name of iconsInText(readFileSync(file, "utf8"), known)) if (!used.has(name)) used.set(name, relative(root, file));
    }
  }
  return used;
}

export function readManifest(file = MANIFEST) { return JSON.parse(readFileSync(file, "utf8")); }
export const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** Names the code uses that the committed subset does not hold: [[name, file], ...]. */
export function missingIcons(used = usedIcons(), manifest = readManifest()) {
  const have = new Set(manifest.icons);
  return [...used].filter(([name]) => !have.has(name));
}

function python(args) {
  const tries = [["python3", args], ["uv", ["run", "--no-project", "--with", "fonttools", "--with", "brotli", "python", ...args]]];
  let last = "";
  for (const [command, argv] of tries) {
    const run = spawnSync(command, argv, { encoding: "utf8" });
    if (run.status === 0) return run.stdout;
    last = run.error ? String(run.error.message) : run.stderr;
  }
  throw new Error(`Could not run the subsetter. Install fonttools and brotli for python3, or install uv.\n${last}`);
}

function build() {
  const used = [...usedIcons().keys()].sort();
  const work = mkdtempSync(join(tmpdir(), "icon-subset-"));
  try {
    const list = join(work, "names.json");
    writeFileSync(list, JSON.stringify(used));
    const out = JSON.parse(python([join(ROOT, "scripts/subset-icons.py"), list, SOURCE_FONT, SUBSET_FONT]).trim().split("\n").at(-1));
    const version = JSON.parse(readFileSync(join(ROOT, "node_modules/material-symbols/package.json"), "utf8")).version;
    writeFileSync(MANIFEST, JSON.stringify({ source: `material-symbols@${version} (outlined)`, sha256: sha256(SUBSET_FONT), bytes: statSync(SUBSET_FONT).size, icons: out.kept }, null, 2) + "\n");
    console.log(`${out.kept.length} icons, ${(statSync(SUBSET_FONT).size / 1024).toFixed(0)} KB (full font: ${(statSync(SOURCE_FONT).size / 1024).toFixed(0)} KB)`);
    if (out.missing.length) console.log(`not in the font, skipped: ${out.missing.join(", ")}`);
  } finally { rmSync(work, { recursive: true, force: true }); }
}

function check() {
  const manifest = readManifest();
  const problems = missingIcons(usedIcons(), manifest).map(([name, file]) => `icon "${name}" (${file}) is not in the subset font`);
  if (sha256(SUBSET_FONT) !== manifest.sha256) problems.push("the subset font does not match its manifest");
  if (problems.length) { console.error(`${problems.join("\n")}\nRun: node scripts/subset-icons.mjs`); process.exit(1); }
  console.log(`icon subset ok: ${manifest.icons.length} icons`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.includes("--check")) check(); else build();
}
