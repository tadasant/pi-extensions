/**
 * Translate AIR hooks into `@tadasant/pi-hooks` definitions.
 *
 * A plugin's `hooks[]` are AIR hook IDs whose runtime definition lives in a
 * `HOOK.json`. Rather than growing a second hook path, this maps each one onto the
 * hook engine this repository already publishes: the AIR event becomes a Pi event,
 * `matcher` becomes a pi-hooks matcher, and `command`/`args`/`env`/`timeout_seconds`
 * become a pi-hooks `command` action.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { AirError } from "./catalog.ts";
import type { AirHookDefinition, Artifact, HookEntry, TranslatedHook } from "./types.ts";

/**
 * AIR lifecycle events mapped onto the events Pi actually emits.
 *
 * AIR's vocabulary is agent-agnostic and broader than Pi's surface. The unmapped
 * ones are listed below rather than silently dropped, because a hook that never
 * fires is worse than one that refuses to load.
 */
export const EVENT_MAP: Record<string, string> = {
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

/**
 * AIR events Pi has no equivalent for. Pi has no git-commit lifecycle, no subagent
 * concept, and no extension-visible notification event, and pi-hooks does not expose
 * compaction. Naming them makes the gap legible instead of mysterious.
 */
export const UNSUPPORTED_EVENTS: Record<string, string> = {
  pre_commit: "Pi has no git-commit lifecycle event",
  post_commit: "Pi has no git-commit lifecycle event",
  subagent_stop: "Pi has no subagent concept",
  notification: "Pi does not expose a notification event to extensions",
  pre_compact: "pi-hooks does not currently expose Pi's compaction events",
  PreCompact: "pi-hooks does not currently expose Pi's compaction events",
  SubagentStop: "Pi has no subagent concept",
  Notification: "Pi does not expose a notification event to extensions",
};

/** Resolve a hook entry's directory and read its `HOOK.json`. */
export function readHookDefinition(artifact: Artifact<HookEntry>): {
  definition: AirHookDefinition;
  dir: string;
} {
  const entry = artifact.entry;
  if (/^[a-z0-9+.-]+:\/\//i.test(entry.path)) {
    throw new AirError(
      `hook ${artifact.id}: path "${entry.path}" is a remote provider URI, which this adapter ` +
        "does not resolve; clone it locally and point the catalog at the checkout",
    );
  }
  const base = dirname(artifact.source);
  const dir = isAbsolute(entry.path) ? entry.path : resolvePath(base, entry.path);
  const hookJson = join(dir, "HOOK.json");
  if (!existsSync(hookJson)) throw new AirError(`hook ${artifact.id}: missing ${hookJson}`);

  let definition: AirHookDefinition;
  try {
    definition = JSON.parse(readFileSync(hookJson, "utf8")) as AirHookDefinition;
  } catch (error) {
    throw new AirError(`hook ${artifact.id}: ${hookJson}: ${(error as Error).message}`);
  }
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    throw new AirError(`hook ${artifact.id}: ${hookJson}: expected a JSON object`);
  }
  if (typeof definition.event !== "string" || definition.event.length === 0) {
    throw new AirError(`hook ${artifact.id}: ${hookJson}: "event" is required`);
  }
  if (typeof definition.command !== "string" || definition.command.length === 0) {
    throw new AirError(`hook ${artifact.id}: ${hookJson}: "command" is required`);
  }
  return { definition, dir };
}

/**
 * Deep-merge a consumer's `x-config` overlay from the index entry into the
 * materialized `HOOK.json`'s own `x-config`. Objects merge recursively with the
 * consumer winning; arrays and scalars replace.
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
    const existing = out[key];
    if (
      existing &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      out[key] = mergeXConfig(
        existing as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      out[key] = value;
    }
  }
  return out;
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

/** `${VAR}` interpolation against the environment, as AIR's secrets transforms do. */
export function interpolate(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => {
    const resolved = env[name];
    return resolved === undefined ? whole : resolved;
  });
}

export interface TranslateOptions {
  env?: NodeJS.ProcessEnv;
}

/**
 * Claude Code tool names mapped onto Pi's.
 *
 * This bridge accepts Claude's PascalCase *events*, so it will be handed
 * Claude-authored hooks whose `matcher` is a Claude tool name. Without this table
 * `"Bash"` would never match Pi's `bash` and the hook would silently never fire —
 * the failure `UNSUPPORTED_EVENTS` exists to prevent.
 */
const TOOL_ALIASES: Record<string, string> = {
  Bash: "bash",
  Read: "read",
  Write: "write",
  Edit: "edit",
  Glob: "find",
  Grep: "grep",
  LS: "ls",
};

/**
 * Translate an AIR `matcher` into a pi-hooks matcher scoped to the event.
 *
 * AIR filters "against event data", which differs per event. Matching every field on
 * every event means a guardrail written for bash can veto an unrelated file write
 * whose path merely contains the word.
 */
export function buildMatch(matcher: string | undefined, piEvent: string): unknown {
  if (matcher === undefined) return undefined;
  const pattern = `/${matcher}/i`;
  if (piEvent === "user_prompt") return { prompt: pattern };
  if (piEvent === "tool_call" || piEvent === "tool_result") {
    const aliased = TOOL_ALIASES[matcher];
    return {
      any: [
        { tool: pattern },
        ...(aliased ? [{ tool: aliased }] : []),
        { input: { command: pattern } },
      ],
    };
  }
  // session_start / session_shutdown / agent_settled carry no matchable payload.
  return undefined;
}

/**
 * Translate one AIR hook into a pi-hooks definition.
 *
 * Returns `undefined` (with a reason pushed onto `warnings`) when the AIR event has
 * no Pi equivalent, so one untranslatable hook never sinks a whole plugin.
 */
export function translateHook(
  artifact: Artifact<HookEntry>,
  warnings: string[],
  options: TranslateOptions = {},
): TranslatedHook | undefined {
  const env = options.env ?? process.env;
  const { definition, dir } = readHookDefinition(artifact);

  const piEvent = EVENT_MAP[definition.event];
  if (!piEvent) {
    const reason = UNSUPPORTED_EVENTS[definition.event] ?? "unknown AIR event";
    warnings.push(
      `hook ${artifact.id}: AIR event "${definition.event}" is not activated — ${reason}`,
    );
    return undefined;
  }

  const xConfig = mergeXConfig(definition["x-config"], artifact.entry["x-config"]);
  const hookEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(definition.env ?? {})) {
    hookEnv[key] = interpolate(String(value), env);
  }
  // hooks.schema.json: x-config values support ${VAR} interpolation. This lands in an
  // environment variable handed to the hook process, not on disk.
  if (xConfig) hookEnv.AIR_HOOK_CONFIG = JSON.stringify(interpolateDeep(xConfig, env));
  hookEnv.AIR_HOOK_ID = artifact.id;

  const match = buildMatch(definition.matcher, piEvent);

  return {
    airId: artifact.id,
    airEvent: definition.event,
    definition: {
      name: artifact.id,
      on: piEvent,
      ...(match ? { match } : {}),
      action: {
        type: "command",
        // AIR documents `command` as "Shell command to execute". With no `args` it may
        // therefore contain shell syntax (`foo && bar`), so it runs through a shell.
        // When `args` are present the pair is argv-shaped and passes through verbatim,
        // which also keeps arguments free of quoting hazards.
        ...(definition.args && definition.args.length > 0
          ? { argv: [definition.command, ...definition.args] }
          : { command: definition.command }),
        cwd: dir,
        env: hookEnv,
        ...(typeof definition.timeout_seconds === "number" && definition.timeout_seconds > 0
          ? { timeoutMs: Math.round(definition.timeout_seconds * 1000) }
          : {}),
      },
    },
  };
}
