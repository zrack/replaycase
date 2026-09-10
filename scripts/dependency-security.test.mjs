import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const postcss = require("postcss");
const browserslist = require("browserslist");
const browserslistEnvironment = require("browserslist/node");
const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("build dependency security boundaries", () => {
  it("does not read an untrusted external source map without a source path", () => {
    const directory = mkdtempSync(join(tmpdir(), "narrowslink-map-"));
    directories.push(directory);
    const mapPath = join(directory, "private.map");
    writeFileSync(mapPath, JSON.stringify({ version: 3, sources: ["private.css"], names: [], mappings: "" }));
    for (const annotation of [mapPath, relative(process.cwd(), mapPath)]) {
      const root = postcss.parse(`a { color: red }\n/*# sourceMappingURL=${annotation} */`);
      expect(root.first.selector).toBe("a");
      expect(root.source.input.map?.text).toBeUndefined();
    }
  });

  it("preserves explicitly supplied source maps", () => {
    const previous = { version: 3, sources: ["input.css"], names: [], mappings: "" };
    const root = postcss.parse("a { color: red }", { map: { prev: previous } });
    expect(root.source.input.map.text).toBe(JSON.stringify(previous));
    expect(root.first.first.value).toBe("red");
  });

  it("treats inherited object names as data, not browser definitions or prototypes", () => {
    for (const key of ["__proto__", "toString", "valueOf", "constructor", "hasOwnProperty", "isPrototypeOf"]) {
      const stats = JSON.parse(`{"${key}":{"onekey":5},"chrome":{"100":50}}`);
      expect(browserslist("chrome 100", { stats })).toEqual(["chrome 100"]);
      const normalized = browserslistEnvironment.getStat({ stats }, browserslist.data);
      expect(Object.getPrototypeOf(normalized)).toBeNull();
      expect(Object.hasOwn(normalized, key)).toBe(true);
      expect(Object.prototype).not.toHaveProperty("onekey");
    }
  });

  it("survives poisoned auto-discovered stats for a query that does not use them", () => {
    const directory = mkdtempSync(join(tmpdir(), "narrowslink-stats-"));
    directories.push(directory);
    writeFileSync(join(directory, "browserslist-stats.json"), '{"toString":{"onekey":5},"chrome":{"100":50}}');
    expect(browserslist("chrome 100", { path: directory })).toEqual(["chrome 100"]);
  });

  it("continues to select browsers from ordinary custom statistics", () => {
    expect(browserslist("> 0% in my stats", { stats: { chrome: { 100: 5 } } })).toEqual(["chrome 100"]);
  });
});
