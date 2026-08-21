import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { AirError, qualify } from "./catalog.ts";
import type { Artifact, Catalog, PluginEntry, PluginManifest, ResolvedPlugin } from "./types.ts";

/**
 * Merge a plugin's index entry with its externalized `.plugin/plugin.json` body.
 *
 * AIR's rule is "inline wins": any field on the index entry takes precedence, and
 * the manifest only fills gaps. `description`, `path`, and `default_in_roots` always
 * belong to the index entry.
 */
export function materializeEntry(artifact: Artifact<PluginEntry>): PluginEntry {
  const entry = artifact.entry;
  if (!entry.path) return entry;

  const base = dirname(artifact.source);
  const dir = isAbsolute(entry.path) ? entry.path : resolvePath(base, entry.path);
  if (/^[a-z0-9+.-]+:\/\//i.test(entry.path)) {
    throw new AirError(
      `plugin ${artifact.id}: path "${entry.path}" is a remote provider URI, which this ` +
        "adapter does not resolve; clone it locally and point the catalog at the checkout",
    );
  }
  const manifestPath = join(dir, ".plugin", "plugin.json");
  if (!existsSync(manifestPath)) {
    throw new AirError(`plugin ${artifact.id}: missing manifest at ${manifestPath}`);
  }

  let manifest: PluginManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PluginManifest;
  } catch (error) {
    throw new AirError(`plugin ${artifact.id}: ${manifestPath}: ${(error as Error).message}`);
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new AirError(`plugin ${artifact.id}: ${manifestPath}: expected a JSON object`);
  }

  for (const field of ["skills", "mcp_servers", "hooks", "plugins"] as const) {
    const value = manifest[field];
    if (
      value !== undefined &&
      (!Array.isArray(value) || value.some((v) => typeof v !== "string"))
    ) {
      throw new AirError(
        `plugin ${artifact.id}: ${manifestPath}: "${field}" must be an array of strings`,
      );
    }
  }

  // `name` is informational only — identity is the plugins.json entry key.
  const { name: _name, description: manifestDescription, ...body } = manifest;
  const merged = { ...body, ...stripUndefined(entry) } as PluginEntry;
  // AIR: "inline wins" — the index entry's description takes precedence, and the
  // manifest only fills the gap.
  merged.description = entry.description ?? manifestDescription ?? "";
  return merged;
}

function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** Qualify a possibly-bare artifact reference against the plugin's own scope. */
function qualifyRef(ref: string, scope: string): string {
  return ref.startsWith("@") ? ref : qualify(scope, ref);
}

/**
 * Expand one plugin's composition graph into a flat set of artifact IDs.
 *
 * AIR's rules: child plugins expand depth-first, a parent's direct declarations win
 * over inherited ones, IDs are deduplicated, and circular references are rejected.
 */
export function resolvePlugin(catalog: Catalog, pluginId: string): ResolvedPlugin {
  const seen = new Set<string>();
  const composedFrom: string[] = [];

  const walk = (
    id: string,
    stack: string[],
  ): { skills: string[]; mcp: string[]; hooks: string[] } => {
    if (stack.includes(id)) {
      throw new AirError(`circular plugin reference: ${[...stack, id].join(" -> ")}`);
    }
    const artifact = catalog.plugins.get(id);
    if (!artifact) throw new AirError(`unknown plugin ${id}`);
    const entry = materializeEntry(artifact);

    // Depth-first: children first, then the parent's own declarations. Dedup keeps
    // the first occurrence, which is AIR's documented expansion order.
    const inherited: { skills: string[]; mcp: string[]; hooks: string[] } = {
      skills: [],
      mcp: [],
      hooks: [],
    };
    for (const childRef of entry.plugins ?? []) {
      const childId = qualifyRef(childRef, artifact.scope);
      if (!seen.has(childId)) {
        seen.add(childId);
        composedFrom.push(childId);
      }
      const child = walk(childId, [...stack, id]);
      inherited.skills.push(...child.skills);
      inherited.mcp.push(...child.mcp);
      inherited.hooks.push(...child.hooks);
    }

    return {
      skills: [
        ...inherited.skills,
        ...(entry.skills ?? []).map((r) => qualifyRef(r, artifact.scope)),
      ],
      mcp: [
        ...inherited.mcp,
        ...(entry.mcp_servers ?? []).map((r) => qualifyRef(r, artifact.scope)),
      ],
      hooks: [...inherited.hooks, ...(entry.hooks ?? []).map((r) => qualifyRef(r, artifact.scope))],
    };
  };

  const artifact = catalog.plugins.get(pluginId);
  if (!artifact) throw new AirError(`unknown plugin ${pluginId}`);
  const entry = materializeEntry(artifact);
  const expanded = walk(pluginId, []);

  return {
    id: pluginId,
    title: entry.title ?? artifact.shortId,
    description: entry.description,
    ...(entry.version ? { version: entry.version } : {}),
    skills: dedupe(expanded.skills),
    mcpServers: dedupe(expanded.mcp),
    hooks: dedupe(expanded.hooks),
    composedFrom,
  };
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Which plugins activate for this session.
 *
 * AIR declares membership on the artifact: `default_in_roots` names the roots a
 * plugin is activated in, with `"*"` meaning every resolved root. An explicit
 * selection (Pi's `PI_PLUGINS`) overrides that entirely.
 */
export function selectPlugins(
  catalog: Catalog,
  options: { root?: string; explicit?: string[] },
): string[] {
  if (options.explicit && options.explicit.length > 0) {
    // A bare name is resolved against whatever scopes the catalog actually holds,
    // rather than assuming `local`.
    return options.explicit.map((ref) => {
      if (ref.startsWith("@")) return ref;
      const match = [...catalog.plugins.values()].find((entry) => entry.shortId === ref);
      return match?.id ?? qualify("local", ref);
    });
  }
  const selected: string[] = [];
  for (const [id, artifact] of catalog.plugins) {
    const roots = artifact.entry.default_in_roots ?? [];
    if (roots.includes("*") || (options.root !== undefined && roots.includes(options.root))) {
      selected.push(id);
    }
  }
  return selected;
}
