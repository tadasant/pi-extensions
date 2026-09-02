/**
 * Handing an AIR plugin's MCP servers to `pi-mcp-adapter`.
 *
 * This package does not speak MCP. What it owes the adapter is a correct
 * `.pi/mcp.json` — and it owes the *user* an honest answer when the adapter that
 * would consume it is not installed.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  findMcpAdapter,
  materializeMcpConfig,
  PROVENANCE_KEY,
  serverKey,
  translateServer,
} from "../src/mcp-bridge.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-plugins-mcp-"));
});

function readConfig(): Record<string, Record<string, unknown>> {
  return JSON.parse(readFileSync(join(dir, ".pi", "mcp.json"), "utf8")).mcpServers;
}

describe("translateServer", () => {
  it("maps an AIR stdio server onto the adapter's command form", () => {
    expect(
      translateServer(
        { description: "d", type: "stdio", command: "npx", args: ["-y", "srv"], env: { A: "1" } },
        {},
      ),
    ).toEqual({ command: "npx", args: ["-y", "srv"], env: { A: "1" } });
  });

  it("maps an AIR http server onto the adapter's url form", () => {
    expect(
      translateServer(
        { description: "d", type: "streamable-http", url: "https://x/mcp", headers: { H: "v" } },
        {},
      ),
    ).toEqual({ url: "https://x/mcp", headers: { H: "v" } });
  });

  it("drops AIR-only fields the adapter would not understand", () => {
    const out = translateServer(
      { description: "d", title: "T", type: "stdio", command: "x", default_in_roots: ["*"] },
      {},
    );
    expect(out).toEqual({ command: "x" });
  });

  it("expands ${VAR} only in the fields pi-mcp-adapter does not expand itself", () => {
    // command/args/url are ours to resolve; env and headers are the adapter's, and
    // resolving them here would write a plaintext secret into a project file.
    const out = translateServer(
      {
        description: "d",
        type: "stdio",
        command: "${BIN}",
        args: ["--flag=${TOKEN}"],
        env: { KEY: "${TOKEN}" },
        headers: { Authorization: "Bearer ${TOKEN}" },
        url: "https://${HOST}/mcp",
      },
      { BIN: "/usr/bin/srv", TOKEN: "s3cret", HOST: "example.test" },
    );
    expect(out.command).toBe("/usr/bin/srv");
    expect(out.args).toEqual(["--flag=s3cret"]);
    expect(out.url).toBe("https://example.test/mcp");
    expect(out.env).toEqual({ KEY: "${TOKEN}" });
    expect(out.headers).toEqual({ Authorization: "Bearer ${TOKEN}" });
  });

  it("never writes a resolved secret to disk", () => {
    materializeMcpConfig(
      dir,
      [
        {
          id: "@local/gh",
          entry: { description: "d", command: "npx", env: { GITHUB_TOKEN: "${GH_TOKEN}" } },
        },
      ],
      { GH_TOKEN: "ghp_supersecret" },
    );
    const raw = readFileSync(join(dir, ".pi", "mcp.json"), "utf8");
    expect(raw).not.toContain("ghp_supersecret");
    expect(raw).toContain("${GH_TOKEN}");
  });

  it("maps AIR oauth onto the adapter's oauth block and flags auth", () => {
    const out = translateServer(
      {
        description: "d",
        type: "streamable-http",
        url: "https://x/mcp",
        oauth: { clientId: "abc", scopes: ["read"], clientSecret: "${SECRET}" },
      },
      { SECRET: "shh" },
    );
    expect(out.auth).toBe("oauth");
    // The secret stays a reference, for the same reason as env and headers.
    expect(out.oauth).toEqual({ clientId: "abc", scopes: ["read"], clientSecret: "${SECRET}" });
  });
});

describe("serverKey", () => {
  it("prefers the short id, which is what MCP tool names are built from", () => {
    expect(serverKey("@local/eslint-server", new Set())).toBe("eslint-server");
  });

  it("falls back to a sanitized qualified id on collision", () => {
    expect(serverKey("@local/eslint", new Set(["eslint"]))).toBe("local_eslint");
  });

  it("never emits a character that would break a tool name", () => {
    expect(serverKey("@pulsemcp/ai-artifacts/lint", new Set(["lint"]))).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
});

describe("materializeMcpConfig", () => {
  const server = { id: "@local/eslint", entry: { description: "d", command: "npx" } };

  it("writes the servers a plugin bundles, tagged with their provenance", () => {
    const result = materializeMcpConfig(dir, [server], {});
    expect(result.changed).toBe(true);
    expect(result.written).toEqual(["eslint"]);
    const config = readConfig();
    expect(config.eslint?.command).toBe("npx");
    expect(config.eslint?.[PROVENANCE_KEY]).toBe("@local/eslint");
  });

  it("leaves a hand-written server untouched and renames the plugin's, loudly", () => {
    // Dropping the plugin's server would half-activate the plugin; overwriting would
    // destroy the user's config. Disambiguate, and report it.
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(
      join(dir, ".pi", "mcp.json"),
      JSON.stringify({ mcpServers: { eslint: { command: "mine" } } }),
    );
    const result = materializeMcpConfig(dir, [server], {});
    expect(result.renamed).toEqual([{ id: "@local/eslint", key: "local_eslint" }]);
    expect(readConfig().eslint?.command).toBe("mine");
    expect(readConfig().local_eslint?.command).toBe("npx");
  });

  it("preserves unrelated hand-written servers and other top-level keys", () => {
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(
      join(dir, ".pi", "mcp.json"),
      JSON.stringify({ mcpServers: { mine: { command: "x" } }, settings: { toolPrefix: "mcp" } }),
    );
    materializeMcpConfig(dir, [server], {});
    const parsed = JSON.parse(readFileSync(join(dir, ".pi", "mcp.json"), "utf8"));
    expect(parsed.mcpServers.mine.command).toBe("x");
    expect(parsed.settings).toEqual({ toolPrefix: "mcp" });
  });

  it("removes a server whose plugin is no longer active", () => {
    materializeMcpConfig(dir, [server], {});
    const result = materializeMcpConfig(dir, [], {});
    expect(result.removed).toEqual(["eslint"]);
    expect(readConfig()).toEqual({});
  });

  it("is idempotent — a second identical run writes nothing", () => {
    materializeMcpConfig(dir, [server], {});
    expect(materializeMcpConfig(dir, [server], {}).changed).toBe(false);
  });

  it("refuses to touch a malformed config file rather than clobbering it", () => {
    mkdirSync(join(dir, ".pi"), { recursive: true });
    writeFileSync(join(dir, ".pi", "mcp.json"), "{ not json");
    const result = materializeMcpConfig(dir, [server], {});
    expect(result.changed).toBe(false);
    expect(readFileSync(join(dir, ".pi", "mcp.json"), "utf8")).toBe("{ not json");
  });
});

describe("findMcpAdapter", () => {
  it("finds the adapter where Pi installs project packages", () => {
    const installed = join(dir, ".pi", "npm", "node_modules", "pi-mcp-adapter");
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, "package.json"), JSON.stringify({ name: "pi-mcp-adapter" }));
    expect(findMcpAdapter({ cwd: dir, env: {} })).toBe(installed);
  });

  it("finds the adapter in the agent directory", () => {
    const agentDir = join(dir, "agent");
    const installed = join(agentDir, "npm", "node_modules", "pi-mcp-adapter");
    mkdirSync(installed, { recursive: true });
    writeFileSync(join(installed, "package.json"), JSON.stringify({ name: "pi-mcp-adapter" }));
    expect(findMcpAdapter({ cwd: dir, env: { PI_CODING_AGENT_DIR: agentDir } })).toBe(installed);
  });

  it("returns undefined when it is not installed anywhere", () => {
    expect(
      findMcpAdapter({ cwd: dir, env: { PI_CODING_AGENT_DIR: join(dir, "nope") } }),
    ).toBeUndefined();
  });
});
