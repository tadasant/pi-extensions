/**
 * The activation layer: air.json in, "what Pi should load" out.
 *
 * The behaviour that matters most here is degradation. A catalog is authored by
 * hand and often assembled from several sources, so one broken artifact must not
 * take out the plugins around it.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { activate } from "../src/activate.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-plugins-activate-"));
});

function write(relative: string, body: unknown): string {
  const path = join(dir, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body, null, 2));
  return path;
}

/** A catalog with one plugin bundling one skill, one hook, and one MCP server. */
function fullCatalog(): void {
  write("air.json", { name: "test", catalogs: ["./catalog"] });
  write("catalog/skills.json", {
    "repo-conventions": { description: "d", path: "skills/repo-conventions" },
  });
  write("catalog/skills/repo-conventions/SKILL.md", "---\nname: repo-conventions\n---\nbody");
  write("catalog/hooks.json", { guard: { description: "d", path: "hooks/guard" } });
  write("catalog/hooks/guard/HOOK.json", { event: "pre_tool_call", command: "./guard.sh" });
  write("catalog/mcp.json", { eslint: { description: "d", command: "npx" } });
  write("catalog/plugins.json", {
    "code-quality": {
      description: "d",
      skills: ["repo-conventions"],
      hooks: ["guard"],
      mcp_servers: ["eslint"],
      default_in_roots: ["*"],
    },
  });
}

describe("activate", () => {
  it("returns nothing at all when there is no air.json", () => {
    const result = activate({ cwd: dir, env: {} });
    expect(result).toEqual({
      plugins: [],
      skillPaths: [],
      hooks: [],
      mcpServers: [],
      warnings: [],
    });
  });

  it("resolves a plugin into skill paths, translated hooks, and reported MCP servers", () => {
    fullCatalog();
    const result = activate({ cwd: dir, env: {} });
    expect(result.warnings).toEqual([]);
    expect(result.plugins.map((p) => p.id)).toEqual(["@local/code-quality"]);
    expect(result.skillPaths).toEqual([join(dir, "catalog", "skills", "repo-conventions")]);
    expect(result.hooks).toHaveLength(1);
    expect(result.hooks[0]?.airId).toBe("@local/guard");
    // MCP servers are resolved and reported, never started.
    expect(result.mcpServers).toEqual([
      { id: "@local/eslint", entry: { description: "d", command: "npx" } },
    ]);
  });

  it("activates nothing when no plugin claims a root", () => {
    fullCatalog();
    write("catalog/plugins.json", { "code-quality": { description: "d", skills: [] } });
    expect(activate({ cwd: dir, env: {} }).plugins).toEqual([]);
  });

  it("honours an explicit PI_PLUGINS selection", () => {
    fullCatalog();
    write("catalog/plugins.json", {
      opt_in: { description: "d", skills: ["repo-conventions"] },
      other: { description: "d", default_in_roots: ["*"] },
    });
    const result = activate({ cwd: dir, env: { PI_PLUGINS: "opt_in" } });
    expect(result.plugins.map((p) => p.id)).toEqual(["@local/opt_in"]);
  });

  it("honours PI_PLUGINS_ROOT for root-scoped membership", () => {
    fullCatalog();
    write("catalog/plugins.json", { scoped: { description: "d", default_in_roots: ["web-app"] } });
    expect(activate({ cwd: dir, env: {} }).plugins).toEqual([]);
    expect(
      activate({ cwd: dir, env: { PI_PLUGINS_ROOT: "web-app" } }).plugins.map((p) => p.id),
    ).toEqual(["@local/scoped"]);
  });

  it("deduplicates a skill path two plugins both bundle", () => {
    fullCatalog();
    write("catalog/plugins.json", {
      a: { description: "d", skills: ["repo-conventions"], default_in_roots: ["*"] },
      b: { description: "d", skills: ["repo-conventions"], default_in_roots: ["*"] },
    });
    expect(activate({ cwd: dir, env: {} }).skillPaths).toHaveLength(1);
  });
});

describe("degradation", () => {
  it("warns about a bundled artifact that is not in any index, and keeps the rest", () => {
    fullCatalog();
    write("catalog/plugins.json", {
      "code-quality": {
        description: "d",
        skills: ["repo-conventions", "ghost-skill"],
        hooks: ["ghost-hook"],
        mcp_servers: ["ghost-mcp"],
        default_in_roots: ["*"],
      },
    });
    const result = activate({ cwd: dir, env: {} });
    expect(result.skillPaths).toHaveLength(1);
    const warnings = result.warnings.join("\n");
    expect(warnings).toContain("bundled skill @local/ghost-skill is not in any skills index");
    expect(warnings).toContain("bundled hook @local/ghost-hook is not in any hooks index");
    expect(warnings).toContain("bundled MCP server @local/ghost-mcp is not in any mcp index");
  });

  it("warns about a skill whose directory does not exist", () => {
    fullCatalog();
    write("catalog/skills.json", { "repo-conventions": { description: "d", path: "skills/gone" } });
    const result = activate({ cwd: dir, env: {} });
    expect(result.skillPaths).toEqual([]);
    expect(result.warnings.join("\n")).toContain("points at a missing directory");
  });

  it("keeps other plugins when one cannot be resolved", () => {
    fullCatalog();
    write("catalog/plugins.json", {
      broken: { description: "d", path: "./plugins/absent", default_in_roots: ["*"] },
      working: { description: "d", skills: ["repo-conventions"], default_in_roots: ["*"] },
    });
    const result = activate({ cwd: dir, env: {} });
    expect(result.plugins.map((p) => p.id)).toEqual(["@local/working"]);
    expect(result.warnings.join("\n")).toContain("plugin @local/broken could not be resolved");
  });

  it("warns about a catalog path that does not exist", () => {
    write("air.json", { name: "test", catalogs: ["./missing"] });
    expect(activate({ cwd: dir, env: {} }).warnings.join("\n")).toContain("does not exist");
  });

  it("warns rather than silently ignoring a remote catalog URI", () => {
    write("air.json", { name: "test", catalogs: ["github://owner/repo"] });
    expect(activate({ cwd: dir, env: {} }).warnings.join("\n")).toContain(
      "uses a remote provider URI",
    );
  });
});
