/**
 * AIR hooks — the artifact type this package exists to run.
 *
 * [AIR](https://github.com/pulsemcp/air) defines a hook as a two-layer artifact: an
 * entry in a `hooks.json` index (`description` + `path`, plus an optional `x-config`
 * overlay) pointing at a directory whose `HOOK.json` carries the runtime definition
 * (`event`, `command`, `args`, `env`, `timeout_seconds`, `matcher`, `x-config`).
 *
 * This module is the single implementation of that format for Pi. `@tadasant/pi-plugins`
 * calls into it for the hooks an AIR plugin bundles, rather than translating the format
 * a second time.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { HookDefinition, HookMatcher } from "./types.ts";

/** `<hook-dir>/HOOK.json` — an AIR hook's runtime definition. */
export interface AirHookDefinition {
  event: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeout_seconds?: number;
  /** Regex filtered against event data; the hook only fires when it matches. */
  matcher?: string;
  "x-config"?: Record<string, unknown>;
}

/** An entry in an AIR `hooks.json` index. */
export interface AirHookEntry {
  title?: string;
  description: string;
  path: string;
  references?: string[];
  "x-config"?: Record<string, unknown>;
  default_in_roots?: string[];
}

export class AirHookError extends Error {}

/**
 * AIR lifecycle events mapped onto the events Pi actually emits.
 *
 * AIR's vocabulary is agent-agnostic and broader than Pi's surface. The unmapped ones
 * are named in `UNSUPPORTED_EVENTS` rather than silently dropped, because a hook that
 * never fires is worse than one that refuses to load.
 */
export const AIR_EVENT_MAP: Record<string, string> = {
  session_start: "session_start",
  session_end: "session_shutdown",
  pre_tool_call: "tool_call",
  post_tool_call: "tool_result",
  user_prompt_submit: "user_prompt",
  stop: "agent_settled",
  // Claude Code's PascalCase spellings, which AIR accepts as identity mappings.
  SessionStart: "session_start",
  SessionEnd: "session_shutdown",
  PreToolUse: "tool_call",
  PostToolUse: "tool_result",
  UserPromptSubmit: "user_prompt",
  Stop: "agent_settled",
};

/** AIR events Pi has no equivalent for, each with the reason. */
export const UNSUPPORTED_AIR_EVENTS: Record<string, string> = {
  pre_commit: "Pi has no git-commit lifecycle event",
  post_commit: "Pi has no git-commit lifecycle event",
  subagent_stop: "Pi has no subagent concept",
  notification: "Pi does not expose a notification event to extensions",
  pre_compact: "pi-hooks does not currently expose Pi's compaction events",
  PreCompact: "pi-hooks does not currently expose Pi's compaction events",
  SubagentStop: "Pi has no subagent concept",
  Notification: "Pi does not expose a notification event to extensions",
};

/** Pi's built-in tools, per its docs. Used to tell a tool-name matcher from a word. */
const PI_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** Claude Code tool names mapped onto Pi's, for matchers written against Claude. */
const TOOL_ALIASES: Record<string, string> = {
  Bash: "bash",
  Read: "read",
  Write: "write",
  Edit: "edit",
  Glob: "find",
  Grep: "grep",
  LS: "ls",
};

/** `${VAR}` interpolation against the environment, as AIR's secrets transforms do. */
export function interpolate(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => {
    const resolved = env[name];
    return resolved === undefined ? whole : resolved;
  });
}

/** Recursively interpolate `${VAR}` in every string leaf of a JSON-ish value. */
export function interpolateDeep(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === "string") return interpolate(value, env);
  if (Array.isArray(value)) return value.map((item) => interpolateDeep(item, env));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        interpolateDeep(nested, env),
      ]),
    );
  }
  return value;
}

/**
 * Deep-merge a consumer's `x-config` overlay from the index entry into the
 * `HOOK.json`'s own. Objects merge recursively with the consumer winning; arrays and
 * scalars replace.
 */
export function mergeXConfig(
  base: Record<string, unknown> | undefined,
  overlay: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!base && !overlay) return undefined;
  if (!base) return { ...overlay };
  if (!overlay) return { ...base };
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    // Consistent with setPath's guard: a JSON key like __proto__ is dropped rather
    // than assigned, where it would silently vanish from AIR_HOOK_CONFIG anyway.
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
    const existing = out[key];
    const mergeable = (candidate: unknown) =>
      candidate && typeof candidate === "object" && !Array.isArray(candidate);
    out[key] =
      mergeable(existing) && mergeable(value)
        ? mergeXConfig(existing as Record<string, unknown>, value as Record<string, unknown>)
        : value;
  }
  return out;
}

/**
 * Translate an AIR `matcher` into a matcher scoped to the event.
 *
 * AIR filters "against event data", which differs per event. Matching every field on
 * every event would let a guardrail written for bash veto an unrelated file write
 * whose path merely contains the word.
 */
export function buildAirMatch(
  matcher: string | undefined,
  piEvent: string,
  warnings: string[] = [],
  label = "hook",
): HookMatcher | undefined {
  if (matcher === undefined) return undefined;
  const pattern = `/${matcher}/i`;

  if (piEvent === "user_prompt") return { prompt: pattern };
  // session_start / session_shutdown carry a `reason`, the only event data there is.
  if (piEvent === "session_start" || piEvent === "session_shutdown") return { reason: pattern };
  if (piEvent === "agent_settled") {
    warnings.push(
      `${label}: matcher "${matcher}" is ignored on this event — it carries no data to match`,
    );
    return undefined;
  }

  const aliased = TOOL_ALIASES[matcher];
  // A matcher that *names a tool* is a tool filter, so keep it off the command: ORing
  // in `input.command` would make a hook scoped to `Write` also fire on
  // `git write-tree`, a false refusal of legitimate work from a blocking guard.
  // Anything else — `deploy`, `deploy.*prod` — is a pattern over the command, which
  // is what AIR's "matched against event data" means for a tool event.
  const namesATool = aliased !== undefined || PI_TOOL_NAMES.includes(matcher.toLowerCase());
  if (namesATool) {
    const names: HookMatcher[] = [{ tool: pattern }, ...(aliased ? [{ tool: aliased }] : [])];
    return names.length === 1 ? (names[0] as HookMatcher) : { any: names };
  }
  return { any: [{ tool: pattern }, { input: { command: pattern } }] };
}

/** Read and validate a `HOOK.json` from a hook directory. */
export function readHookJson(dir: string, label: string): AirHookDefinition {
  const path = join(dir, "HOOK.json");
  if (!existsSync(path)) throw new AirHookError(`hook ${label}: missing ${path}`);
  let definition: AirHookDefinition;
  try {
    definition = JSON.parse(readFileSync(path, "utf8")) as AirHookDefinition;
  } catch (error) {
    throw new AirHookError(`hook ${label}: ${path}: ${(error as Error).message}`);
  }
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    throw new AirHookError(`hook ${label}: ${path}: expected a JSON object`);
  }
  if (typeof definition.event !== "string" || definition.event.length === 0) {
    throw new AirHookError(`hook ${label}: ${path}: "event" is required`);
  }
  if (typeof definition.command !== "string" || definition.command.length === 0) {
    throw new AirHookError(`hook ${label}: ${path}: "command" is required`);
  }
  // The optional fields are checked too. A string `args` — a plausible typo, since
  // AIR's docs show command/args as a pair — would otherwise be spread character by
  // character into an argv that fails to spawn, blocking every tool call with an
  // incomprehensible reason and no config error naming the hook.
  const bad = (field: string, expected: string) =>
    new AirHookError(`hook ${label}: ${path}: "${field}" must be ${expected}`);
  if (definition.args !== undefined) {
    if (!Array.isArray(definition.args) || definition.args.some((a) => typeof a !== "string")) {
      throw bad("args", "an array of strings");
    }
  }
  for (const field of ["env", "x-config"] as const) {
    const value = definition[field];
    if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
      throw bad(field, "an object");
    }
  }
  if (definition.matcher !== undefined && typeof definition.matcher !== "string") {
    throw bad("matcher", "a string");
  }
  if (definition.timeout_seconds !== undefined && typeof definition.timeout_seconds !== "number") {
    throw bad("timeout_seconds", "a number");
  }
  return definition;
}

/** Resolve an AIR entry's `path` against the index file that declared it. */
export function resolveHookDir(entryPath: string, indexPath: string, label: string): string {
  if (/^[a-z0-9+.-]+:\/\//i.test(entryPath)) {
    throw new AirHookError(
      `hook ${label}: path "${entryPath}" is a remote provider URI, which this package does ` +
        "not resolve; clone it locally and point the index at the checkout",
    );
  }
  return isAbsolute(entryPath) ? entryPath : resolve(dirname(indexPath), entryPath);
}

export interface TranslateAirHookOptions {
  /** Qualified AIR id, used as the hook's name and exposed as `AIR_HOOK_ID`. */
  id: string;
  /** Directory holding `HOOK.json` and any scripts it invokes. */
  dir: string;
  definition: AirHookDefinition;
  /** The index entry's consumer overlay, merged over the hook's own `x-config`. */
  xConfigOverlay?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
}

/**
 * Translate one AIR hook into this package's internal hook definition.
 *
 * Returns `undefined`, pushing a reason onto `warnings`, when the AIR event has no Pi
 * equivalent — so one untranslatable hook never sinks the rest.
 */
export function translateAirHook(
  options: TranslateAirHookOptions,
  warnings: string[],
): HookDefinition | undefined {
  const env = options.env ?? process.env;
  const { definition, id, dir } = options;

  const piEvent = AIR_EVENT_MAP[definition.event];
  if (!piEvent) {
    const reason = UNSUPPORTED_AIR_EVENTS[definition.event] ?? "unknown AIR event";
    warnings.push(`hook ${id}: AIR event "${definition.event}" is not activated — ${reason}`);
    return undefined;
  }

  const xConfig = mergeXConfig(definition["x-config"], options.xConfigOverlay);
  const hookEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(definition.env ?? {})) {
    hookEnv[key] = interpolate(String(value), env);
  }
  // Set after the hook's own env, so both AIR-owned variables have the same
  // precedence and stay trustworthy for diagnostics.
  hookEnv.AIR_HOOK_ID = id;
  // hooks.schema.json: x-config values support ${VAR}. This lands in an environment
  // variable handed to the hook process, never on disk.
  if (xConfig) hookEnv.AIR_HOOK_CONFIG = JSON.stringify(interpolateDeep(xConfig, env));

  const match = buildAirMatch(definition.matcher, piEvent, warnings, id);

  return {
    name: id,
    on: piEvent as HookDefinition["on"],
    ...(match ? { match } : {}),
    action: {
      type: "command",
      // AIR documents `command` as "Shell command to execute", so with no `args` it may
      // contain shell syntax. With `args` the pair is argv-shaped and passes through
      // verbatim, which also keeps arguments free of quoting hazards.
      ...(definition.args && definition.args.length > 0
        ? { argv: [definition.command, ...definition.args] }
        : { command: definition.command }),
      cwd: dir,
      env: hookEnv,
      ...(typeof definition.timeout_seconds === "number" && definition.timeout_seconds > 0
        ? { timeoutMs: Math.round(definition.timeout_seconds * 1000) }
        : {}),
    },
  };
}

/**
 * Does this JSON look like an AIR hooks index rather than this package's own config?
 *
 * An AIR index is a map of hook id -> `{ description, path }`. The Pi-native superset
 * has a top-level `hooks` array. Telling them apart lets one filename serve both.
 */
export function isAirHooksIndex(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const record = parsed as Record<string, unknown>;
  // The Pi-native superset is identified positively by its own keys.
  if (Array.isArray(record.hooks) || Array.isArray(record.extends)) return false;
  const entries = Object.entries(record).filter(([key]) => key !== "$schema");
  if (entries.length === 0) return false;
  // *Any* well-formed AIR entry makes this an AIR index. Requiring every entry to be
  // well-formed would let a single typo (`pathh`) reclassify the file as the Pi-native
  // format, which has no `hooks` array — so it would load zero hooks with zero errors
  // and every guardrail in it would vanish without a word.
  return entries.some(
    (entry) =>
      entry[1] !== null &&
      typeof entry[1] === "object" &&
      !Array.isArray(entry[1]) &&
      typeof (entry[1] as AirHookEntry).path === "string",
  );
}

/** Load every hook declared by an AIR `hooks.json` index. */
export function loadAirHooksIndex(
  indexPath: string,
  warnings: string[],
  options: { scope?: string; env?: NodeJS.ProcessEnv } = {},
): HookDefinition[] {
  const scope = options.scope ?? "local";
  let index: Record<string, AirHookEntry>;
  try {
    index = JSON.parse(readFileSync(indexPath, "utf8")) as Record<string, AirHookEntry>;
  } catch (error) {
    warnings.push(`${indexPath}: ${(error as Error).message}`);
    return [];
  }

  const hooks: HookDefinition[] = [];
  for (const [shortId, entry] of Object.entries(index)) {
    if (shortId === "$schema") continue;
    const id = `@${scope}/${shortId}`;
    if (!entry || typeof entry !== "object" || typeof entry.path !== "string") {
      warnings.push(`${indexPath}: entry "${shortId}" is not a valid AIR hook entry`);
      continue;
    }
    try {
      const dir = resolveHookDir(entry.path, indexPath, id);
      const definition = readHookJson(dir, id);
      const translated = translateAirHook(
        {
          id,
          dir,
          definition,
          ...(entry["x-config"] ? { xConfigOverlay: entry["x-config"] } : {}),
          ...(options.env ? { env: options.env } : {}),
        },
        warnings,
      );
      if (translated) hooks.push(translated);
    } catch (error) {
      warnings.push((error as Error).message);
    }
  }
  return hooks;
}

/** Minimal `air.json` shape this package reads: just the hook sources. */
interface AirConfigHooks {
  hooks?: string[];
  catalogs?: string[];
}

const MAX_CATALOG_DEPTH = 3;

function findHookIndexes(root: string, depth = 0): string[] {
  if (depth > MAX_CATALOG_DEPTH) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of entries) {
    // `.github` is a plausible home for a shared catalog, so skip only `.git` itself.
    if (name === "node_modules" || name === ".pi" || name === ".git") continue;
    const full = join(root, name);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      found.push(...findHookIndexes(full, depth + 1));
    } else if (name === "hooks.json") {
      // A Pi-native hooks.json can sit inside a catalog tree; feeding it to the AIR
      // loader would emit one bogus warning per key.
      try {
        if (isAirHooksIndex(JSON.parse(readFileSync(full, "utf8")))) found.push(full);
      } catch {
        // Unparseable here is reported by whoever actually loads it.
      }
    }
  }
  return found;
}

/**
 * Discover AIR hook indexes reachable from an `air.json`.
 *
 * Only the hook-bearing parts of AIR's config are read here — `hooks` index paths and
 * `catalogs` walked for `hooks.json`. Resolving plugins, skills, and MCP servers is
 * `@tadasant/pi-plugins`' job, not this package's.
 */
export function discoverAirHookIndexes(airConfigPath: string, warnings: string[]): string[] {
  let config: AirConfigHooks;
  try {
    config = JSON.parse(readFileSync(airConfigPath, "utf8")) as AirConfigHooks;
  } catch (error) {
    warnings.push(`${airConfigPath}: ${(error as Error).message}`);
    return [];
  }
  const base = dirname(airConfigPath);
  const indexes: string[] = [];

  for (const entry of config.hooks ?? []) {
    const path = isAbsolute(entry) ? entry : resolve(base, entry);
    if (existsSync(path)) indexes.push(path);
    else warnings.push(`hooks index "${entry}" does not exist at ${path}`);
  }
  for (const entry of config.catalogs ?? []) {
    if (/^[a-z0-9+.-]+:\/\//i.test(entry)) {
      warnings.push(
        `catalog "${entry}" uses a remote provider URI, which this package does not resolve; ` +
          "clone it locally and point the catalog at the checkout",
      );
      continue;
    }
    const root = isAbsolute(entry) ? entry : resolve(base, entry);
    if (existsSync(root)) indexes.push(...findHookIndexes(root));
    else warnings.push(`catalog "${entry}" does not exist at ${root}`);
  }
  return [...new Set(indexes)];
}

/** Where an `air.json` is looked for, nearest first. */
export function discoverAirConfig(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  warnings: string[] = [],
): string | undefined {
  const override = env.PI_HOOKS_AIR;
  if (override) {
    const path = isAbsolute(override) ? override : resolve(cwd, override);
    if (existsSync(path)) return path;
    warnings.push(`PI_HOOKS_AIR points at a missing file: ${path}`);
    return undefined;
  }
  for (const candidate of [join(cwd, "air.json"), join(cwd, ".air", "air.json")]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}
