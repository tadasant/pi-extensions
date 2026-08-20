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
  if (xConfig) hookEnv.AIR_HOOK_CONFIG = JSON.stringify(xConfig);
  hookEnv.AIR_HOOK_ID = artifact.id;

  // AIR's `matcher` is a regex filtered against event data. Pi's tool events carry
  // the tool name and its arguments, so match the command for bash-shaped calls and
  // the tool name otherwise — expressed with pi-hooks' `any` combinator.
  const match =
    definition.matcher === undefined
      ? undefined
      : {
          any: [
            { tool: `/${definition.matcher}/` },
            { input: { command: `/${definition.matcher}/` } },
            { input: { path: `/${definition.matcher}/` } },
            { prompt: `/${definition.matcher}/` },
          ],
        };

  return {
    airId: artifact.id,
    airEvent: definition.event,
    definition: {
      name: artifact.id,
      on: piEvent,
      ...(match ? { match } : {}),
      action: {
        type: "command",
        // argv form: no shell, so an AIR hook's args are passed through verbatim.
        argv: [definition.command, ...(definition.args ?? [])],
        cwd: dir,
        env: hookEnv,
        ...(definition.timeout_seconds
          ? { timeoutMs: Math.round(definition.timeout_seconds * 1000) }
          : {}),
      },
    },
  };
}
