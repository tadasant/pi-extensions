/**
 * Resolution semantics for AIR plugins.
 *
 * Every rule asserted here comes from https://github.com/pulsemcp/air — the
 * plugins schema, the plugin-manifest schema, and docs/plugins.md. Where AIR is
 * explicit ("inline wins", "parent overrides children", "circular references are
 * rejected at resolution time"), the test names say so.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { AirError, discoverAirConfig, loadCatalog, qualify } from "../src/catalog.ts";
import { materializeEntry, resolvePlugin, selectPlugins } from "../src/resolve.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-plugins-"));
});

function write(relative: string, body: unknown): string {
  const path = join(dir, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body, null, 2));
  return path;
}

describe("qualified IDs", () => {
  it("addresses artifacts as @scope/id, with local as the filesystem scope", () => {
    expect(qualify("local", "code-quality")).toBe("@local/code-quality");
    expect(qualify("pulsemcp/ai-artifacts", "lint-fix")).toBe("@pulsemcp/ai-artifacts/lint-fix");
  });
});

describe("catalog discovery", () => {
  it("finds index files by conventional filename, walking subdirectories", () => {
    write("catalog/skills.json", { "a-skill": { description: "d", path: "skills/a" } });
    write("catalog/nested/hooks.json", { "a-hook": { description: "d", path: "hooks/a" } });
    const { catalog } = loadCatalog(join(dir, "catalog"));
    expect([...catalog.skills.keys()]).toEqual(["@local/a-skill"]);
    expect([...catalog.hooks.keys()]).toEqual(["@local/a-hook"]);
  });

  it("rejects duplicate qualified IDs — AIR composition is union-only", () => {
    write("catalog/skills.json", { dup: { description: "d", path: "skills/a" } });
    write("catalog/nested/skills.json", { dup: { description: "d", path: "skills/b" } });
    expect(() => loadCatalog(join(dir, "catalog"))).toThrow(/duplicate artifact @local\/dup/);
  });

  it("prefers PI_PLUGINS_CONFIG and falls back to air.json then .air/air.json", () => {
    write("air.json", { name: "x" });
    expect(discoverAirConfig(dir, {})).toBe(join(dir, "air.json"));
    const explicit = write("custom/air.json", { name: "x" });
    expect(discoverAirConfig(dir, { PI_PLUGINS_CONFIG: "custom/air.json" })).toBe(explicit);
    expect(() => discoverAirConfig(dir, { PI_PLUGINS_CONFIG: "nope.json" })).toThrow(
      /missing file/,
    );
  });

  it("returns undefined when there is no AIR config at all", () => {
    expect(discoverAirConfig(dir, {})).toBeUndefined();
  });
});

describe("externalized manifest (.plugin/plugin.json)", () => {
  function withManifest(manifest: unknown, entry: Record<string, unknown> = {}) {
    write("catalog/plugins/cq/.plugin/plugin.json", manifest);
    write("catalog/plugins.json", {
      cq: { description: "from the index", path: "./plugins/cq", ...entry },
    });
    return loadCatalog(join(dir, "catalog")).catalog;
  }

  it("reads the body from the manifest the entry points at", () => {
    const catalog = withManifest({
      title: "Code Quality",
      version: "1.2.0",
      skills: ["lint-fix"],
      hooks: ["lint-pre-commit"],
      mcp_servers: ["eslint-server"],
    });
    const entry = materializeEntry(catalog.plugins.get("@local/cq")!);
    expect(entry.title).toBe("Code Quality");
    expect(entry.version).toBe("1.2.0");
    expect(entry.skills).toEqual(["lint-fix"]);
  });

  it("lets an inline field win over the manifest — AIR's 'inline wins' rule", () => {
    const catalog = withManifest(
      { title: "From Manifest", skills: ["a"] },
      { title: "From Index" },
    );
    const entry = materializeEntry(catalog.plugins.get("@local/cq")!);
    expect(entry.title).toBe("From Index");
    // A field the entry does not declare still comes from the manifest.
    expect(entry.skills).toEqual(["a"]);
  });

  it("keeps the index entry's description, which the registry needs to list the plugin", () => {
    const catalog = withManifest({ description: "from the manifest" });
    expect(materializeEntry(catalog.plugins.get("@local/cq")!).description).toBe("from the index");
  });

  it("ignores the manifest's informational `name` — identity is the entry key", () => {
    const catalog = withManifest({ name: "something-else", skills: [] });
    const artifact = catalog.plugins.get("@local/cq")!;
    expect(artifact.shortId).toBe("cq");
    expect(materializeEntry(artifact)).not.toHaveProperty("name");
  });

  it("fails loudly on a missing manifest, naming the plugin", () => {
    write("catalog/plugins.json", { cq: { description: "d", path: "./plugins/absent" } });
    const catalog = loadCatalog(join(dir, "catalog")).catalog;
    expect(() => materializeEntry(catalog.plugins.get("@local/cq")!)).toThrow(
      /plugin @local\/cq: missing manifest/,
    );
  });

  it("fails loudly when a reference field is not an array of strings", () => {
    const catalog = withManifest({ skills: "lint-fix" });
    expect(() => materializeEntry(catalog.plugins.get("@local/cq")!)).toThrow(
      /"skills" must be an array of strings/,
    );
  });

  it("refuses a remote provider URI rather than pretending to resolve it", () => {
    write("catalog/plugins.json", {
      cq: { description: "d", path: "github://owner/repo/plugins/cq" },
    });
    const catalog = loadCatalog(join(dir, "catalog")).catalog;
    expect(() => materializeEntry(catalog.plugins.get("@local/cq")!)).toThrow(
      /remote provider URI/,
    );
  });

  it("still supports a fully inline body (deprecated in AIR, but resolvable)", () => {
    write("catalog/plugins.json", {
      cq: { description: "d", skills: ["lint-fix"], hooks: ["h"] },
    });
    const catalog = loadCatalog(join(dir, "catalog")).catalog;
    expect(materializeEntry(catalog.plugins.get("@local/cq")!).skills).toEqual(["lint-fix"]);
  });
});

describe("composition", () => {
  function composed(plugins: Record<string, unknown>) {
    write("catalog/plugins.json", plugins);
    return loadCatalog(join(dir, "catalog")).catalog;
  }

  it("expands child plugins depth-first and flattens to primitive IDs", () => {
    const catalog = composed({
      "code-quality": { description: "d", skills: ["lint-fix", "format-check"], hooks: ["lint"] },
      "database-tools": { description: "d", skills: ["db-migrate"], mcp_servers: ["postgres"] },
      "full-stack": {
        description: "d",
        plugins: ["code-quality", "database-tools"],
        skills: ["deploy"],
        mcp_servers: ["deploy-server"],
      },
    });
    const resolved = resolvePlugin(catalog, "@local/full-stack");
    expect(resolved.skills).toEqual([
      "@local/lint-fix",
      "@local/format-check",
      "@local/db-migrate",
      "@local/deploy",
    ]);
    expect(resolved.mcpServers).toEqual(["@local/postgres", "@local/deploy-server"]);
    expect(resolved.hooks).toEqual(["@local/lint"]);
    expect(resolved.composedFrom).toEqual(["@local/code-quality", "@local/database-tools"]);
  });

  it("deduplicates a primitive reached through two paths", () => {
    const catalog = composed({
      a: { description: "d", skills: ["shared"] },
      b: { description: "d", skills: ["shared"] },
      top: { description: "d", plugins: ["a", "b"] },
    });
    expect(resolvePlugin(catalog, "@local/top").skills).toEqual(["@local/shared"]);
  });

  it("expands nested composition transitively", () => {
    const catalog = composed({
      c: { description: "d", skills: ["from-c"] },
      b: { description: "d", plugins: ["c"], skills: ["from-b"] },
      a: { description: "d", plugins: ["b"], skills: ["from-a"] },
    });
    expect(resolvePlugin(catalog, "@local/a").skills).toEqual([
      "@local/from-c",
      "@local/from-b",
      "@local/from-a",
    ]);
  });

  it("rejects a circular reference at resolution time", () => {
    const catalog = composed({
      a: { description: "d", plugins: ["b"] },
      b: { description: "d", plugins: ["a"] },
    });
    expect(() => resolvePlugin(catalog, "@local/a")).toThrow(/circular plugin reference/);
  });

  it("names an unknown plugin rather than resolving to nothing", () => {
    const catalog = composed({ a: { description: "d", plugins: ["ghost"] } });
    expect(() => resolvePlugin(catalog, "@local/a")).toThrow(/unknown plugin @local\/ghost/);
    expect(() => resolvePlugin(catalog, "@local/nope")).toThrow(/unknown plugin @local\/nope/);
  });

  it("accepts an already-qualified reference across scopes", () => {
    const catalog = composed({
      a: { description: "d", skills: ["@pulsemcp/ai-artifacts/lint-fix", "local-one"] },
    });
    expect(resolvePlugin(catalog, "@local/a").skills).toEqual([
      "@pulsemcp/ai-artifacts/lint-fix",
      "@local/local-one",
    ]);
  });
});

describe("selection", () => {
  function withRoots(roots: Record<string, string[] | undefined>) {
    write(
      "catalog/plugins.json",
      Object.fromEntries(
        Object.entries(roots).map(([id, value]) => [
          id,
          { description: "d", ...(value ? { default_in_roots: value } : {}) },
        ]),
      ),
    );
    return loadCatalog(join(dir, "catalog")).catalog;
  }

  it("activates plugins whose default_in_roots is '*'", () => {
    const catalog = withRoots({ everywhere: ["*"], scoped: ["web-app"], none: undefined });
    expect(selectPlugins(catalog, {})).toEqual(["@local/everywhere"]);
  });

  it("activates plugins that name the configured root", () => {
    const catalog = withRoots({ everywhere: ["*"], scoped: ["web-app"] });
    expect(selectPlugins(catalog, { root: "web-app" }).sort()).toEqual([
      "@local/everywhere",
      "@local/scoped",
    ]);
  });

  it("lets an explicit selection override default_in_roots entirely", () => {
    const catalog = withRoots({ everywhere: ["*"], scoped: ["web-app"] });
    expect(selectPlugins(catalog, { explicit: ["scoped"] })).toEqual(["@local/scoped"]);
    expect(selectPlugins(catalog, { explicit: ["@local/scoped"] })).toEqual(["@local/scoped"]);
  });
});

describe("exclude", () => {
  it("drops qualified IDs and wildcard patterns, and warns on a pattern that matches nothing", async () => {
    const { loadAirConfig, loadCatalogs } = await import("../src/catalog.ts");
    write("catalog/skills.json", {
      "lint-fix": { description: "d", path: "skills/a" },
      "lint-check": { description: "d", path: "skills/b" },
      keep: { description: "d", path: "skills/c" },
    });
    const configPath = write("air.json", {
      name: "x",
      catalogs: ["./catalog"],
      exclude: { skills: ["@local/lint-*", "@local/ghost"] },
    });
    const { catalog, warnings } = loadCatalogs(configPath, loadAirConfig(configPath));
    expect([...catalog.skills.keys()]).toEqual(["@local/keep"]);
    expect(warnings.join("\n")).toContain('exclude pattern "@local/ghost"');
  });
});

describe("AirError", () => {
  it("is what resolution failures throw, so callers can distinguish them", () => {
    expect(new AirError("x")).toBeInstanceOf(Error);
  });
});
