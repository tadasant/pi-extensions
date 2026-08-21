import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  type AirConfig,
  type Artifact,
  type Catalog,
  type HookEntry,
  INDEX_FILENAMES,
  type McpEntry,
  type PluginEntry,
  type SkillEntry,
} from "./types.ts";

export class AirError extends Error {}

function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (error) {
    throw new AirError(`${path}: ${(error as Error).message}`);
  }
}

/** Where `air.json` is looked for, nearest first. */
export function discoverAirConfig(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const override = env.PI_PLUGINS_CONFIG;
  if (override) {
    const path = isAbsolute(override) ? override : resolve(cwd, override);
    if (!existsSync(path))
      throw new AirError(`PI_PLUGINS_CONFIG points at a missing file: ${path}`);
    return path;
  }
  for (const candidate of [join(cwd, "air.json"), join(cwd, ".air", "air.json")]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function loadAirConfig(path: string): AirConfig {
  const config = readJson<AirConfig>(path);
  if (!config || typeof config !== "object") throw new AirError(`${path}: expected a JSON object`);
  if (typeof config.name !== "string" || config.name.length === 0) {
    throw new AirError(`${path}: "name" is required`);
  }
  return config;
}

/**
 * AIR qualifies every artifact as `@scope/id`. Catalog providers supply the scope
 * (the GitHub provider returns `owner/repo`); local catalogs use `local`.
 */
export function qualify(scope: string, shortId: string): string {
  return `@${scope}/${shortId}`;
}

/** AIR walks a catalog up to 3 directory levels deep looking for index files. */
const MAX_CATALOG_DEPTH = 3;

function findIndexFiles(root: string, depth = 0): string[] {
  if (depth > MAX_CATALOG_DEPTH) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of entries) {
    // `.pi` holds Pi's own state — including the mcp.json this package writes, whose
    // top-level keys would otherwise be ingested as bogus artifacts.
    if (name === "node_modules" || name === ".pi" || name.startsWith(".git")) continue;
    const full = join(root, name);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      found.push(...findIndexFiles(full, depth + 1));
    } else if (Object.values(INDEX_FILENAMES).includes(name)) {
      found.push(full);
    }
  }
  return found;
}

function typeOfIndex(path: string): keyof typeof INDEX_FILENAMES | undefined {
  for (const [type, filename] of Object.entries(INDEX_FILENAMES)) {
    if (path.endsWith(`/${filename}`)) return type as keyof typeof INDEX_FILENAMES;
  }
  return undefined;
}

function ingest<T>(
  target: Map<string, Artifact<T>>,
  indexPath: string,
  scope: string,
  warnings: string[],
): void {
  const index = readJson<Record<string, T>>(indexPath);
  for (const [shortId, entry] of Object.entries(index)) {
    if (shortId === "$schema") continue;
    if (!entry || typeof entry !== "object") {
      warnings.push(`${indexPath}: entry "${shortId}" is not an object; skipped`);
      continue;
    }
    const id = qualify(scope, shortId);
    if (target.has(id)) {
      // AIR: composition is union-only, and duplicate qualified IDs are an error.
      throw new AirError(
        `duplicate artifact ${id} (in ${indexPath} and ${target.get(id)?.source})`,
      );
    }
    target.set(id, { id, shortId, scope, entry, source: indexPath });
  }
}

/**
 * Load one local catalog directory into qualified artifact maps.
 *
 * Only local (filesystem) catalogs are supported. AIR's remote providers
 * (`github://…`) are a separate extension surface; a catalog entry that looks like
 * a URI is reported as a warning rather than silently ignored.
 */
export function loadCatalog(
  root: string,
  scope = "local",
): { catalog: Catalog; warnings: string[] } {
  const warnings: string[] = [];
  const catalog: Catalog = {
    scope,
    root,
    skills: new Map(),
    hooks: new Map(),
    mcp: new Map(),
    plugins: new Map(),
  };
  for (const indexPath of findIndexFiles(root)) {
    const type = typeOfIndex(indexPath);
    if (type === "skills") ingest<SkillEntry>(catalog.skills, indexPath, scope, warnings);
    else if (type === "hooks") ingest<HookEntry>(catalog.hooks, indexPath, scope, warnings);
    else if (type === "mcp") ingest<McpEntry>(catalog.mcp, indexPath, scope, warnings);
    else if (type === "plugins") ingest<PluginEntry>(catalog.plugins, indexPath, scope, warnings);
  }
  return { catalog, warnings };
}

/** Merge every catalog an `air.json` names, plus its per-type index arrays. */
export function loadCatalogs(
  configPath: string,
  config: AirConfig,
): { catalog: Catalog; warnings: string[] } {
  const base = dirname(configPath);
  const warnings: string[] = [];
  const merged: Catalog = {
    scope: "local",
    root: base,
    skills: new Map(),
    hooks: new Map(),
    mcp: new Map(),
    plugins: new Map(),
  };

  const absorb = (other: Catalog) => {
    for (const key of ["skills", "hooks", "mcp", "plugins"] as const) {
      for (const [id, artifact] of other[key]) {
        const existing = merged[key].get(id) as Artifact<unknown> | undefined;
        if (existing) {
          throw new AirError(
            `duplicate artifact ${id} (in ${artifact.source} and ${existing.source})`,
          );
        }
        (merged[key] as Map<string, any>).set(id, artifact);
      }
    }
  };

  for (const entry of config.catalogs ?? []) {
    if (/^[a-z0-9+.-]+:\/\//i.test(entry)) {
      warnings.push(
        `catalog "${entry}" uses a remote provider URI, which this adapter does not resolve; ` +
          "clone it locally and point the catalog at the checkout",
      );
      continue;
    }
    const root = isAbsolute(entry) ? entry : resolve(base, entry);
    if (!existsSync(root)) {
      warnings.push(`catalog "${entry}" does not exist at ${root}`);
      continue;
    }
    const loaded = loadCatalog(root);
    warnings.push(...loaded.warnings);
    absorb(loaded.catalog);
  }

  // Per-type arrays on air.json point straight at index files.
  const perType: [keyof typeof INDEX_FILENAMES, keyof Catalog][] = [
    ["skills", "skills"],
    ["hooks", "hooks"],
    ["mcp", "mcp"],
    ["plugins", "plugins"],
  ];
  for (const [configKey, catalogKey] of perType) {
    for (const entry of (config[configKey] as string[] | undefined) ?? []) {
      const indexPath = isAbsolute(entry) ? entry : resolve(base, entry);
      if (!existsSync(indexPath)) {
        warnings.push(`${configKey} index "${entry}" does not exist at ${indexPath}`);
        continue;
      }
      ingest<any>(merged[catalogKey] as Map<string, Artifact<any>>, indexPath, "local", warnings);
    }
  }

  applyExcludes(merged, config, warnings);
  return { catalog: merged, warnings };
}

/** `exclude` is AIR's only composition control: drop qualified IDs or wildcards. */
function applyExcludes(catalog: Catalog, config: AirConfig, warnings: string[]): void {
  const map: Partial<Record<string, keyof Catalog>> = {
    skills: "skills",
    hooks: "hooks",
    mcp: "mcp",
    plugins: "plugins",
  };
  for (const [type, patterns] of Object.entries(config.exclude ?? {})) {
    const key = map[type];
    if (!key) continue;
    for (const pattern of patterns ?? []) {
      // Each `*` matches one or more non-slash characters within a segment.
      const regex = new RegExp(
        `^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]+")}$`,
      );
      const target = catalog[key] as Map<string, unknown>;
      let hit = false;
      for (const id of [...target.keys()]) {
        if (regex.test(id)) {
          target.delete(id);
          hit = true;
        }
      }
      if (!hit) warnings.push(`exclude pattern "${pattern}" (${type}) matched no artifact`);
    }
  }
}
