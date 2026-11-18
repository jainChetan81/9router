import { describe, it, expect } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ROOT, SUBSET_FONT, iconsInText, knownIcons, missingIcons, readManifest, sha256, usedIcons } from "../../scripts/subset-icons.mjs";

describe("icon font subset", () => {
  const known = knownIcons();
  const manifest = readManifest();

  it("holds every icon name the source uses", () => {
    const missing = missingIcons(usedIcons(known), manifest).map(([name, file]) => `${name} (${file})`);
    // A missing icon would show as its name in letters. Fix: node scripts/subset-icons.mjs
    expect(missing).toEqual([]);
  });

  it("the committed font is the one the manifest describes, and stays small", () => {
    expect(sha256(SUBSET_FONT)).toBe(manifest.sha256);
    expect(statSync(SUBSET_FONT).size).toBe(manifest.bytes);
    expect(manifest.bytes).toBeLessThan(300 * 1024);
    expect(manifest.icons.length).toBeGreaterThan(50);
    expect(manifest.icons.every((name) => known.has(name))).toBe(true);
  });

  it("the layout loads the subset, not the package's full font or a CDN", () => {
    const layout = readFileSync(join(ROOT, "src/app/layout.js"), "utf8");
    expect(layout).toContain('import "./material-symbols.css"');
    expect(layout).not.toMatch(/material-symbols\/(outlined|rounded|sharp|index)\.css/);
    const css = readFileSync(join(ROOT, "src/app/material-symbols.css"), "utf8");
    expect(css).toContain('url("./fonts/material-symbols-outlined.subset.woff2")');
    expect(css).toContain("font-display: block");
    expect(css).not.toMatch(/https?:\/\//);
  });

  it("finds names in quoted strings and in JSX text, and nothing else", () => {
    const found = iconsInText(`
      <span className="material-symbols-outlined">home</span>
      <span className="material-symbols-outlined">{ok ? "check_circle" : 'error'}</span>
      const item = { icon: \`settings\`, label: "Not An Icon", other: "zz_not_an_icon" };
      const rocket = 1; // a bare identifier is not a use
    `, known);
    expect([...found].sort()).toEqual(["check_circle", "error", "home", "settings"]);
  });

  it("reports a used icon that the subset lacks", () => {
    const used = new Map([["home", "a.js"], ["rocket_launch", "b.js"]]);
    expect(missingIcons(used, { icons: ["home"] })).toEqual([["rocket_launch", "b.js"]]);
  });

  it("counts an alias ligature the font supports as known", () => {
    // expand_more is used in the dashboard but missing from the package's index.d.ts.
    expect(known.has("expand_more")).toBe(true);
    expect(iconsInText(`<span class="material-symbols-outlined">expand_more</span>`, known).has("expand_more")).toBe(true);
  });
});
