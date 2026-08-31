/**
 * The declarative hook configuration format.
 *
 * A hook binds a Pi lifecycle event to an action, with an optional matcher that
 * decides whether this particular occurrence of the event is interesting. Nothing
 * here is TypeScript the user has to write: the whole surface is JSON.
 */

/** Pi lifecycle events this layer can dispatch on. */
export const HOOK_EVENTS = [
  "session_start",
  "session_shutdown",
  "before_agent_start",
  "agent_settled",
  "user_prompt",
  "tool_call",
  "tool_result",
  "user_bash",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/** Events at which an action is allowed to veto what Pi was about to do. */
export const BLOCKABLE_EVENTS: readonly HookEvent[] = ["tool_call", "user_bash", "user_prompt"];

/**
 * A pattern is matched against a string.
 *
 * - `"/re/flags"` is a regular expression.
 * - Anything else is a glob (`*` matches within a path segment, `**` across segments).
 * - A leading `!` negates the whole pattern.
 */
export type Pattern = string;

export interface HookMatcher {
  /** Tool name pattern(s). Only meaningful for `tool_call` / `tool_result`. */
  tool?: Pattern | Pattern[];
  /**
   * Patterns matched against values dug out of the event's tool input by dot path,
   * e.g. `{ "path": "**\/.env*", "command": "/rm\\s+-rf/" }`.
   */
  input?: Record<string, Pattern | Pattern[]>;
  /** Pattern(s) matched against the user's prompt text. */
  prompt?: Pattern | Pattern[];
  /** For `tool_result`: match only failures (`true`) or only successes (`false`). */
  isError?: boolean;
  /** Session start/shutdown reason, e.g. `"startup"`, `"resume"`, `"quit"`. */
  reason?: Pattern | Pattern[];
  /** Every nested matcher must also match. */
  all?: HookMatcher[];
  /** At least one nested matcher must match. */
  any?: HookMatcher[];
  /** The nested matcher must not match. */
  not?: HookMatcher;
}

/** Refuse whatever Pi was about to do. */
export interface BlockAction {
  type: "block";
  /** Message handed back to the model in place of the tool result. */
  reason?: string;
  /** Ask Pi to stop the agent loop early rather than letting the model retry. */
  terminate?: boolean;
}

/** Show a message in the Pi UI. */
export interface NotifyAction {
  type: "notify";
  message: string;
  level?: "info" | "warning" | "error";
}

/** Rewrite the tool input in place before the tool runs. */
export interface PatchInputAction {
  type: "patch-input";
  /** Dot path -> new value. String values are templated. */
  set: Record<string, unknown>;
}

/** Inject an extra message into the conversation (only on `before_agent_start`). */
export interface ContextAction {
  type: "context";
  text: string;
  /** Whether the injected message is shown in the transcript. Defaults to `false`. */
  display?: boolean;
}

/**
 * Run a shell command.
 *
 * The full event is delivered as JSON on stdin and as `PI_HOOK_*` environment
 * variables, so a hook script never has to depend on templating. A non-zero exit
 * blocks the event where blocking is possible; stdout may carry a JSON control
 * object (see `CommandControl`) for finer-grained responses.
 */
export interface CommandAction {
  type: "command";
  /** A string is run through `sh -c` with templated values shell-quoted. */
  command?: string;
  /** An argv array is executed directly with no shell. Values are templated raw. */
  argv?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  /** Treat a non-zero exit as a block. Defaults to `true` for blockable events. */
  blockOnFailure?: boolean;
}

export type HookAction =
  | BlockAction
  | NotifyAction
  | PatchInputAction
  | ContextAction
  | CommandAction;

/** The JSON a `command` action may print on stdout to steer Pi. */
export interface CommandControl {
  block?: boolean;
  reason?: string;
  terminate?: boolean;
  /** Dot path -> value patch applied to the tool input (`tool_call` only). */
  patchInput?: Record<string, unknown>;
  /** Replacement text content for a tool result (`tool_result` only). */
  content?: string;
  /** Extra context appended to the prompt (`before_agent_start` only). */
  context?: string;
  /** Message surfaced in the Pi UI. */
  notify?: string;
}

export interface HookDefinition {
  /** Human-readable identifier, surfaced by `/hooks` and in error messages. */
  name?: string;
  on: HookEvent | HookEvent[];
  match?: HookMatcher;
  action: HookAction;
  /** Set to `false` to keep a hook in the file but skip it. Defaults to `true`. */
  enabled?: boolean;
  /** Run at most once per session. */
  once?: boolean;
  /** If the action throws, log and carry on instead of failing the event. Defaults to `true`. */
  continueOnError?: boolean;
}

export interface HooksConfig {
  $schema?: string;
  /**
   * Configs to merge in before this one's own hooks: a path relative to this file, or
   * a Node-resolvable specifier such as `@scope/pkg/hooks.json`. To pull in AIR hooks
   * instead, name their catalog in an `air.json`.
   */
  extends?: string[];
  hooks?: HookDefinition[];
}

/** A hook plus where it came from, which is what `/hooks` reports. */
export interface LoadedHook {
  definition: HookDefinition;
  source: string;
  index: number;
}

export interface LoadedConfig {
  hooks: LoadedHook[];
  sources: string[];
  errors: string[];
}
