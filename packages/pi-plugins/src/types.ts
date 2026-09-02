/**
 * Types for the subset of the AIR framework this adapter consumes.
 *
 * AIR (https://github.com/pulsemcp/air) defines six artifact types. A *plugin* is
 * the compositional one: a manifest that bundles other artifacts **by ID** rather
 * than a directory of content. Everything here mirrors the published schemas in
 * that repository's `/schemas` directory; field names are AIR's, not ours.
 */

/** `air.json` — the root config that points at catalogs and per-type indexes. */
export interface AirConfig {
  $schema?: string;
  name: string;
  description?: string;
  catalogs?: string[];
  skills?: string[];
  mcp?: string[];
  hooks?: string[];
  plugins?: string[];
  roots?: string[];
  references?: string[];
  exclude?: Partial<Record<ArtifactType, string[]>>;
}

export const ARTIFACT_TYPES = ["skills", "mcp", "hooks", "plugins", "roots", "references"] as const;
export type ArtifactType = (typeof ARTIFACT_TYPES)[number];

/** Index files AIR discovers inside a catalog, by conventional filename. */
export const INDEX_FILENAMES: Record<ArtifactType, string> = {
  skills: "skills.json",
  mcp: "mcp.json",
  hooks: "hooks.json",
  plugins: "plugins.json",
  roots: "roots.json",
  references: "references.json",
};

export interface SkillEntry {
  title?: string;
  description: string;
  path: string;
  references?: string[];
  default_in_roots?: string[];
}

export interface HookEntry {
  title?: string;
  description: string;
  path: string;
  references?: string[];
  "x-config"?: Record<string, unknown>;
  default_in_roots?: string[];
}

export interface McpEntry {
  title?: string;
  description: string;
  default_in_roots?: string[];
  [key: string]: unknown;
}

/** A `plugins.json` entry. Body fields may live here (deprecated) or in the manifest. */
export interface PluginEntry {
  title?: string;
  description: string;
  version?: string;
  path?: string;
  skills?: string[];
  mcp_servers?: string[];
  hooks?: string[];
  plugins?: string[];
  author?: { name?: string; email?: string; url?: string };
  homepage?: string;
  repository?: string;
  license?: string;
  logo?: string;
  keywords?: string[];
  default_in_roots?: string[];
}

/** `<plugin-dir>/.plugin/plugin.json` — the externalized plugin body. */
export interface PluginManifest {
  $schema?: string;
  name?: string;
  title?: string;
  description?: string;
  version?: string;
  skills?: string[];
  mcp_servers?: string[];
  hooks?: string[];
  plugins?: string[];
  author?: { name?: string; email?: string; url?: string };
  homepage?: string;
  repository?: string;
  license?: string;
  logo?: string;
  keywords?: string[];
}

/**
 * Note: the AIR hook runtime definition lives in `@tadasant/pi-hooks/src/air.ts`.
 * This package imports `translateAirHook` from there rather than restating the shape.
 */

/** An artifact after qualification: AIR addresses everything as `@scope/id`. */
export interface Artifact<T> {
  /** Qualified ID, e.g. `@local/lint-fix`. */
  id: string;
  /** Unqualified key from the index file. */
  shortId: string;
  scope: string;
  entry: T;
  /** Absolute path of the index file this came from, for diagnostics. */
  source: string;
}

export interface Catalog {
  scope: string;
  root: string;
  skills: Map<string, Artifact<SkillEntry>>;
  hooks: Map<string, Artifact<HookEntry>>;
  mcp: Map<string, Artifact<McpEntry>>;
  plugins: Map<string, Artifact<PluginEntry>>;
}

/** The flattened result of expanding one plugin's composition graph. */
export interface ResolvedPlugin {
  id: string;
  title: string;
  description: string;
  version?: string;
  /** Qualified skill IDs, in expansion order, deduplicated. */
  skills: string[];
  mcpServers: string[];
  hooks: string[];
  /** Plugin IDs composed into this one, in expansion order. */
  composedFrom: string[];
}

/** What the adapter hands to Pi once a plugin's artifacts are materialized. */
export interface ActivationResult {
  plugins: ResolvedPlugin[];
  /** Absolute directories containing SKILL.md, for Pi's `resources_discover`. */
  skillPaths: string[];
  /** AIR hooks translated into pi-hooks definitions. */
  hooks: TranslatedHook[];
  /**
   * MCP servers a plugin bundles, resolved from the catalog's `mcp.json`. These are
   * handed to the bundled `pi-mcp-adapter` by writing `.pi/mcp.json`; nothing in this
   * package speaks MCP itself.
   */
  mcpServers: { id: string; entry: McpEntry }[];
  /** Where `pi-mcp-adapter` was found, when a plugin bundles MCP servers. */
  mcpAdapter?: string;
  /** What was written to `.pi/mcp.json`, when materialization ran. */
  mcp?: {
    path: string;
    written: string[];
    removed: string[];
    renamed: { id: string; key: string }[];
    changed: boolean;
  };
  /** Non-fatal problems, surfaced by `/plugins` and on stderr. */
  warnings: string[];
}

export interface TranslatedHook {
  /** Qualified AIR hook ID this came from. */
  airId: string;
  /** The `HOOK.json` event, before mapping. */
  airEvent: string;
  /** A `@tadasant/pi-hooks` hook definition. */
  definition: unknown;
}
