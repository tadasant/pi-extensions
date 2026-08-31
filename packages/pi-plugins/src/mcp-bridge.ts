/**
 * Translate an AIR plugin's MCP servers into the config `pi-mcp-adapter` reads.
 *
 * Supporting AIR plugins means supporting what a plugin *bundles*, and MCP servers
 * are one of the three artifact types it can bundle. Pi's MCP support comes from
 * `pi-mcp-adapter`, so this package composes with it the way Pi documents one pi
 * package shipping another: the adapter is a bundled dependency listed in
 * `pi.extensions`, and this module materializes the servers into the project-scoped
 * `.pi/mcp.json` that the adapter loads.
 *
 * Nothing here speaks MCP. The protocol, process supervision, OAuth, and tool
 * registration are all the adapter's job.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { interpolate } from "@tadasant/pi-hooks/src/air.ts";
import type { McpEntry } from "./types.ts";

/** The file `pi-mcp-adapter` reads as its project-scoped, pi-owned config. */
export const PROJECT_MCP_CONFIG = join(".pi", "mcp.json");

/**
 * The other files `pi-mcp-adapter` merges before `.pi/mcp.json`.
 *
 * Its merge is a shallow per-key spread with later winning, so a name we write here
 * would silently override — and partially blend with — a server declared in one of
 * these. Reserving their names is what keeps "hand-written entries are never
 * modified" true beyond our own file.
 */
export function precedingConfigPaths(cwd: string, env: NodeJS.ProcessEnv): string[] {
  const home = env.HOME ?? "";
  const agentDir = env.PI_CODING_AGENT_DIR ?? (home ? join(home, ".pi", "agent") : "");
  return [
    home ? join(home, ".config", "mcp", "mcp.json") : "",
    agentDir ? join(agentDir, "mcp.json") : "",
    join(cwd, ".mcp.json"),
  ].filter(Boolean);
}

/** Server names already claimed by a config the adapter reads before ours. */
export function reservedServerNames(cwd: string, env: NodeJS.ProcessEnv): Set<string> {
  const reserved = new Set<string>();
  for (const path of precedingConfigPaths(cwd, env)) {
    if (!existsSync(path)) continue;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as McpConfigFile;
      for (const name of Object.keys(parsed?.mcpServers ?? {})) reserved.add(name);
    } catch {
      // Not our file to validate; a name we cannot read is a name we cannot reserve.
    }
  }
  return reserved;
}

/**
 * Marks the servers this adapter owns inside `.pi/mcp.json`.
 *
 * Without it, a server contributed by a plugin the user later removed would linger
 * forever, and we would have no safe way to tell our entries from hand-written ones.
 */
export const PROVENANCE_KEY = "x-pi-plugins";

/** The subset of `pi-mcp-adapter`'s ServerEntry this bridge produces. */
export interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  auth?: "oauth" | "bearer" | false;
  oauth?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface McpConfigFile {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

/**
 * A stable, tool-name-safe key for a qualified AIR ID.
 *
 * MCP tool names are derived from the server key, so `@local/eslint-server` cannot
 * be used verbatim. The short ID is preferred; a collision falls back to the full
 * qualified ID with the unsafe characters replaced.
 */
export function sanitizeKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function serverKey(qualifiedId: string, taken: Set<string>): string {
  const shortId = qualifiedId.slice(qualifiedId.lastIndexOf("/") + 1);
  const sanitize = sanitizeKey;
  const preferred = sanitize(shortId);
  if (preferred.length > 0 && !taken.has(preferred)) return preferred;
  let candidate = sanitize(qualifiedId.replace(/^@/, ""));
  let suffix = 2;
  while (taken.has(candidate)) candidate = `${sanitize(qualifiedId.replace(/^@/, ""))}_${suffix++}`;
  return candidate;
}

/**
 * Translate one AIR server configuration into a `pi-mcp-adapter` entry.
 *
 * AIR's `type` distinguishes stdio from the HTTP transports; the adapter infers the
 * same thing from whether `command` or `url` is present, so `type` is dropped rather
 * than passed through as a field it would not understand.
 *
 * **`${VAR}` in `env`, `headers`, and the OAuth block is deliberately left
 * unexpanded.** `pi-mcp-adapter` interpolates those itself at connect time with the
 * same syntax, and this config is written to a project file that nobody gitignores —
 * resolving a token here would put it in plaintext on disk for no benefit. Only
 * `command`, `args`, and `url`, which the adapter does *not* interpolate, are
 * expanded.
 */
export function translateServer(entry: McpEntry, env: NodeJS.ProcessEnv): McpServerEntry {
  const expand = (value: unknown) =>
    typeof value === "string" ? interpolate(value, env) : (value as string);
  const passthroughRecord = (value: unknown): Record<string, string> | undefined => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, raw]) => [key, String(raw)]),
    );
  };

  const out: McpServerEntry = {};
  if (typeof entry.command === "string") out.command = expand(entry.command);
  if (Array.isArray(entry.args)) out.args = entry.args.map((arg) => expand(arg));
  if (typeof entry.url === "string") out.url = expand(entry.url);
  // Verbatim: the adapter expands these, and a resolved secret must not hit disk.
  const envVars = passthroughRecord(entry.env);
  if (envVars) out.env = envVars;
  const headers = passthroughRecord(entry.headers);
  if (headers) out.headers = headers;

  if (entry.oauth && typeof entry.oauth === "object") {
    const oauth = entry.oauth as Record<string, unknown>;
    const mapped: Record<string, unknown> = {};
    if (typeof oauth.clientId === "string") mapped.clientId = oauth.clientId;
    if (typeof oauth.clientSecret === "string") mapped.clientSecret = oauth.clientSecret;
    if (Array.isArray(oauth.scopes)) mapped.scopes = oauth.scopes;
    if (typeof oauth.redirectUri === "string") mapped.redirectUri = oauth.redirectUri;
    if (typeof oauth.authServerMetadataUrl === "string") {
      mapped.authServerMetadataUrl = oauth.authServerMetadataUrl;
    }
    out.oauth = mapped;
    out.auth = "oauth";
  }
  return out;
}

export interface MaterializeResult {
  path: string;
  /** Server keys written, in config order. */
  written: string[];
  /** Server keys removed because no active plugin bundles them any more. */
  removed: string[];
  /**
   * Servers written under a fallback key because a hand-written entry already owned
   * the natural one. The plugin's server still runs; the user's is untouched.
   */
  renamed: { id: string; key: string }[];
  changed: boolean;
  /** Set when the existing file could not be parsed, so nothing was written. */
  unparseable?: string;
}

/**
 * Merge the resolved servers into `<cwd>/.pi/mcp.json`.
 *
 * Hand-written entries are never touched. When a plugin's server wants a key the
 * user already owns, it is written under its qualified name instead and the rename
 * is reported — dropping it would silently half-activate the plugin, and overwriting
 * would destroy the user's config. Entries this package previously wrote are replaced
 * wholesale, so removing a plugin removes its servers on the next run.
 */
export function materializeMcpConfig(
  cwd: string,
  servers: { id: string; entry: McpEntry }[],
  env: NodeJS.ProcessEnv = process.env,
): MaterializeResult {
  const path = join(cwd, PROJECT_MCP_CONFIG);

  let config: McpConfigFile = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = parsed as McpConfigFile;
      }
    } catch (error) {
      // A malformed file is the user's, not ours. Leave it — but say so, or the
      // plugin is half-activated exactly as the docs promise it will not be.
      return {
        path,
        written: [],
        removed: [],
        renamed: [],
        changed: false,
        unparseable: (error as Error).message,
      };
    }
  }
  const before = JSON.stringify(config);
  const existing = { ...(config.mcpServers ?? {}) };

  // Drop everything we wrote last time, so removed plugins do not linger.
  const removed: string[] = [];
  for (const [key, value] of Object.entries(existing)) {
    if (value && typeof value === "object" && PROVENANCE_KEY in value) {
      delete existing[key];
      removed.push(key);
    }
  }

  const written: string[] = [];
  const renamed: { id: string; key: string }[] = [];
  const taken = new Set([...Object.keys(existing), ...reservedServerNames(cwd, env)]);
  for (const server of servers) {
    const key = serverKey(server.id, taken);
    // Compare against the *sanitized* short id, or a dot in the id alone would look
    // like a collision that never happened.
    const natural = sanitizeKey(server.id.slice(server.id.lastIndexOf("/") + 1));
    if (key !== natural) renamed.push({ id: server.id, key });
    taken.add(key);
    existing[key] = { ...translateServer(server.entry, env), [PROVENANCE_KEY]: server.id };
    written.push(key);
  }

  const stillRemoved = removed.filter((key) => !written.includes(key));
  if (Object.keys(existing).length > 0 || config.mcpServers !== undefined) {
    config.mcpServers = existing;
  }
  const after = JSON.stringify(config);
  const changed = before !== after;
  if (changed) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  }
  return { path, written, removed: stillRemoved, renamed, changed };
}

/**
 * Locate the `pi-mcp-adapter` installation that will consume the config we write.
 *
 * The adapter is a declared peer requirement, not a bundled dependency: it pulls in
 * native keychain binaries for every platform, and vendoring that would put a ~36 MB
 * tarball on npm for something a Pi user installs once. So it has to be *found*, and
 * its absence has to be loud — a plugin that bundles MCP servers is otherwise
 * silently half-activated.
 */
export function findMcpAdapter(options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  from?: string;
}): string | undefined {
  const env = options.env ?? process.env;
  const agentDir = env.PI_CODING_AGENT_DIR ?? join(env.HOME ?? "", ".pi", "agent");
  const roots = [
    options.from,
    join(options.cwd, ".pi", "npm"),
    join(agentDir, "npm"),
    options.cwd,
    agentDir,
  ].filter((entry): entry is string => typeof entry === "string" && entry.length > 0);

  for (const root of roots) {
    const candidate = join(root, "node_modules", "pi-mcp-adapter", "package.json");
    if (existsSync(candidate)) return dirname(candidate);
  }
  return undefined;
}

/** The message shown when a plugin bundles MCP servers but the adapter is absent. */
export function missingAdapterMessage(serverIds: string[], written = true): string {
  return (
    `${serverIds.length} MCP server(s) bundled by an active AIR plugin ` +
    `(${serverIds.join(", ")}) cannot be started: pi-mcp-adapter is not installed. ` +
    "It is a required peer of @tadasant/pi-plugins — install it with " +
    "`pi install npm:pi-mcp-adapter`." +
    (written
      ? " The servers have still been written to the MCP config, so they will start " +
        "as soon as the adapter is present."
      : " They could not be written either — see the config error above.")
  );
}
