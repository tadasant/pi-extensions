/**
 * Turn an `air.json` plus a plugin selection into everything Pi needs.
 *
 * Deliberately Pi-free, exactly like `@tadasant/pi-hooks/src`: this takes paths and
 * returns a plain description of what should be activated, so the resolution rules
 * are unit-testable without booting an agent.
 */
import { existsSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { AirError, discoverAirConfig, loadAirConfig, loadCatalogs } from "./catalog.ts";
import { translateHook } from "./hooks-bridge.ts";
import { findMcpAdapter, materializeMcpConfig, missingAdapterMessage } from "./mcp-bridge.ts";
import { resolvePlugin, selectPlugins } from "./resolve.ts";
import type {
  ActivationResult,
  Artifact,
  Catalog,
  McpEntry,
  ResolvedPlugin,
  SkillEntry,
  TranslatedHook,
} from "./types.ts";

export interface ActivateOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /**
   * Write the resolved MCP servers into `.pi/mcp.json` so the bundled
   * `pi-mcp-adapter` picks them up. Off in unit tests, which assert on the
   * resolution result rather than on a side effect.
   */
  materializeMcp?: boolean;
}

function skillDirectory(artifact: Artifact<SkillEntry>): string {
  const entry = artifact.entry;
  if (/^[a-z0-9+.-]+:\/\//i.test(entry.path)) {
    throw new AirError(
      `skill ${artifact.id}: path "${entry.path}" is a remote provider URI, which this adapter ` +
        "does not resolve; clone it locally and point the catalog at the checkout",
    );
  }
  const base = dirname(artifact.source);
  return isAbsolute(entry.path) ? entry.path : resolvePath(base, entry.path);
}

function emptyResult(): ActivationResult {
  return { plugins: [], skillPaths: [], hooks: [], mcpServers: [], warnings: [] };
}

/** Resolve and materialize every plugin selected for this session. */
export function activate(options: ActivateOptions): ActivationResult {
  const env = options.env ?? process.env;
  const configPath = discoverAirConfig(options.cwd, env);
  if (!configPath) return emptyResult();

  const config = loadAirConfig(configPath);
  const { catalog, warnings } = loadCatalogs(configPath, config);
  const result: ActivationResult = { ...emptyResult(), warnings };

  const explicit = (env.PI_PLUGINS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const selection = selectPlugins(catalog, {
    ...(env.PI_PLUGINS_ROOT ? { root: env.PI_PLUGINS_ROOT } : {}),
    explicit,
  });

  for (const pluginId of selection) {
    let resolved: ResolvedPlugin;
    try {
      resolved = resolvePlugin(catalog, pluginId);
    } catch (error) {
      // One broken plugin must not take out the others.
      result.warnings.push(`plugin ${pluginId} could not be resolved: ${(error as Error).message}`);
      continue;
    }
    result.plugins.push(resolved);
    collectSkills(catalog, resolved, result);
    collectHooks(catalog, resolved, result, env);
    collectMcpServers(catalog, resolved, result);
  }

  result.skillPaths = [...new Set(result.skillPaths)];

  if (options.materializeMcp) {
    const materialized = materializeMcpConfig(options.cwd, result.mcpServers, env);
    result.mcp = materialized;
    for (const { id, key } of materialized.renamed) {
      result.warnings.push(
        `MCP server ${id} was written as "${key}" because a hand-written entry in ` +
          `${materialized.path} already uses its natural name`,
      );
    }
    // Only complain when a plugin actually bundles MCP servers; a hooks-and-skills
    // plugin has no reason to care whether the adapter is installed.
    if (result.mcpServers.length > 0) {
      const adapter = findMcpAdapter({ cwd: options.cwd, env });
      result.mcpAdapter = adapter;
      if (!adapter) {
        result.warnings.push(missingAdapterMessage(result.mcpServers.map((s) => s.id)));
      }
    }
  }
  return result;
}

function collectSkills(catalog: Catalog, plugin: ResolvedPlugin, out: ActivationResult): void {
  for (const skillId of plugin.skills) {
    const artifact = catalog.skills.get(skillId);
    if (!artifact) {
      out.warnings.push(`plugin ${plugin.id}: bundled skill ${skillId} is not in any skills index`);
      continue;
    }
    let dir: string;
    try {
      dir = skillDirectory(artifact);
    } catch (error) {
      out.warnings.push((error as Error).message);
      continue;
    }
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      out.warnings.push(
        `plugin ${plugin.id}: skill ${skillId} points at a missing directory ${dir}`,
      );
      continue;
    }
    out.skillPaths.push(dir);
  }
}

function collectHooks(
  catalog: Catalog,
  plugin: ResolvedPlugin,
  out: ActivationResult,
  env: NodeJS.ProcessEnv,
): void {
  for (const hookId of plugin.hooks) {
    const artifact = catalog.hooks.get(hookId);
    if (!artifact) {
      out.warnings.push(`plugin ${plugin.id}: bundled hook ${hookId} is not in any hooks index`);
      continue;
    }
    let translated: TranslatedHook | undefined;
    try {
      translated = translateHook(artifact, out.warnings, { env });
    } catch (error) {
      out.warnings.push((error as Error).message);
      continue;
    }
    if (translated) out.hooks.push(translated);
  }
}

/**
 * MCP servers are reported, never started.
 *
 * Pi's MCP support comes from `nicobailon/pi-mcp-adapter`, and re-implementing MCP
 * here is explicitly out of scope. Surfacing the resolved entries is the seam: an
 * MCP-capable extension can read them and do the actual wiring.
 */
function collectMcpServers(catalog: Catalog, plugin: ResolvedPlugin, out: ActivationResult): void {
  for (const serverId of plugin.mcpServers) {
    const artifact = catalog.mcp.get(serverId) as Artifact<McpEntry> | undefined;
    if (!artifact) {
      out.warnings.push(
        `plugin ${plugin.id}: bundled MCP server ${serverId} is not in any mcp index`,
      );
      continue;
    }
    out.mcpServers.push({ id: serverId, entry: artifact.entry });
  }
}
