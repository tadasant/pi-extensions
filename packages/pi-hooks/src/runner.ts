import { runCommandAction } from "./actions.ts";
import { CLAUDE_EVENT_NAMES } from "./air.ts";
import { hooksForEvent } from "./config.ts";
import { type MatchSubject, matches, setPath } from "./match.ts";
import { renderDeep, renderTemplate } from "./template.ts";
import {
  BLOCKABLE_EVENTS,
  type CommandControl,
  type HookAction,
  type HookEvent,
  type LoadedConfig,
  type LoadedHook,
} from "./types.ts";

/** What a hook asked Pi to do, accumulated across every hook bound to one event. */
export interface HookOutcome {
  blocked: boolean;
  reason?: string;
  terminate?: boolean;
  /** Text to append to the conversation (`before_agent_start`). */
  context: string[];
  /** Whether the injected context should be shown in the transcript. */
  contextDisplay: boolean;
  /** Replacement text for a tool result (`tool_result`). */
  content?: string;
  /**
   * Text to add after a tool result, in order (`tool_result`).
   *
   * Distinct from `content`, which substitutes. Claude Code's `additionalContext`
   * and a `PostToolUse` block reason are both *additions* — the command's own
   * output is still what the model asked for — so they accumulate here and
   * `extensions/hooks.ts` joins them onto whatever the result ends up being.
   */
  appended: string[];
  /** Messages the extension should surface in the UI. */
  notifications: { message: string; level: "info" | "warning" | "error" }[];
  /** Hook names that ran, in order — the e2e suite asserts on this. */
  ran: string[];
}

function emptyOutcome(): HookOutcome {
  return {
    blocked: false,
    context: [],
    contextDisplay: false,
    appended: [],
    notifications: [],
    ran: [],
  };
}

/**
 * The text a `tool_result` should carry after its hooks have run, or `undefined`
 * when no hook touched it and Pi should keep its own result.
 *
 * `content` substitutes and `appended` adds, in that order: a hook that replaced
 * the result is replacing what a later hook then appends to. Shared by both
 * packages' extension entry points, so an AIR hook behaves the same whether it
 * reached the session directly or bundled inside a plugin.
 */
export function rewriteToolResult(outcome: HookOutcome, original: string): string | undefined {
  if (outcome.appended.length === 0) return outcome.content;
  const base = typeof outcome.content === "string" ? outcome.content : original;
  return [base, ...outcome.appended].filter((part) => part.length > 0).join("\n\n");
}

export interface RunnerDeps {
  /** Mutable: a session can switch directories via `/resume`. */
  cwd: string;
  /** Diagnostics sink. Defaults to stderr, which is where Pi surfaces extension logs. */
  log?: (message: string) => void;
  signal?: AbortSignal;
}

export interface DispatchEvent extends MatchSubject {
  event: HookEvent;
  /** Mutable tool input; `patch-input` and command `patchInput` write through it. */
  input?: Record<string, unknown>;
  content?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function hookLabel(hook: LoadedHook): string {
  return hook.definition.name ?? `${hook.source}#${hook.index}`;
}

/**
 * Dispatches configured hooks for one occurrence of one Pi lifecycle event.
 *
 * This is deliberately free of any Pi imports: it takes a normalized event, returns
 * a normalized outcome, and lets `extensions/hooks.ts` do the translation. That
 * keeps the matching and action semantics unit-testable without booting an agent.
 */
export class HookRunner {
  private readonly firedOnce = new Set<string>();

  constructor(
    private config: LoadedConfig,
    private readonly deps: RunnerDeps,
  ) {}

  /** Retarget the runner after a session switches to a different directory. */
  setCwd(cwd: string): void {
    this.deps.cwd = cwd;
  }

  setConfig(config: LoadedConfig): void {
    this.config = config;
    this.firedOnce.clear();
  }

  getConfig(): LoadedConfig {
    return this.config;
  }

  private log(message: string): void {
    (this.deps.log ?? ((line: string) => process.stderr.write(`${line}\n`)))(
      `[pi-hooks] ${message}`,
    );
  }

  async dispatch(event: DispatchEvent): Promise<HookOutcome> {
    const outcome = emptyOutcome();
    const candidates = hooksForEvent(this.config, event.event);

    for (const hook of candidates) {
      const label = hookLabel(hook);
      let applies: boolean;
      try {
        applies = matches(hook.definition.match, event);
      } catch (error) {
        // Config validation catches malformed matchers at load time; this is the
        // backstop. Degrade to "did not match" rather than letting the throw reach
        // Pi, which would hand a raw JS message to the model as the tool result.
        this.log(`hook "${label}" matcher failed: ${(error as Error).message}`);
        continue;
      }
      if (!applies) continue;
      if (hook.definition.once) {
        const key = `${hook.source}#${hook.index}`;
        if (this.firedOnce.has(key)) continue;
        this.firedOnce.add(key);
      }

      outcome.ran.push(label);
      try {
        await this.apply(hook.definition.action, event, outcome, label);
      } catch (error) {
        const message = `hook "${label}" failed: ${(error as Error).message}`;
        this.log(message);
        if (hook.definition.continueOnError === false) throw error;
      }

      // A block is final; later hooks would be reasoning about a call that is
      // no longer going to happen.
      if (outcome.blocked) break;
    }
    return outcome;
  }

  /**
   * The event as the hook process sees it: on stdin, in `PI_HOOK_PAYLOAD`, and as
   * the `{{...}}` template vocabulary.
   *
   * Two namings of the same event, because two contracts meet here. The Pi-native
   * names are what this package's README documents and what a Pi-native
   * `hooks.json` templates against. The snake_case ones are Claude Code's, which is
   * what a *portable AIR hook* reads: AIR specifies no stdin schema, and its
   * reference adapter registers hooks with Claude Code — so an AIR hook written
   * once for the ecosystem looks for `tool_input`, not `input`. Sending only the
   * Pi-native shape is what made such a hook load, match, spawn, and then find
   * every field it reads undefined: a silent no-op indistinguishable from a hook
   * that never fired.
   *
   * The two sets do not collide, so both ship in one object.
   */
  private templateContext(event: DispatchEvent, label: string): Record<string, unknown> {
    const claudeEvent = CLAUDE_EVENT_NAMES[event.event];
    return {
      event: event.event,
      hook: label,
      cwd: this.deps.cwd,
      toolName: event.toolName,
      input: event.input,
      prompt: event.prompt,
      reason: event.reason,
      isError: event.isError,
      content: event.content,

      ...(claudeEvent ? { hook_event_name: claudeEvent } : {}),
      ...(event.toolName !== undefined ? { tool_name: event.toolName } : {}),
      ...(event.input !== undefined ? { tool_input: event.input } : {}),
      // Claude Code hands PostToolUse the tool's response. Pi gives an extension the
      // result as text, so that is what goes here rather than a synthesized object
      // whose per-tool field names would be a guess.
      ...(event.event === "tool_result" ? { tool_response: event.content ?? "" } : {}),
      // SessionStart's reason field is spelled `source` in Claude Code.
      ...(event.event === "session_start" && event.reason !== undefined
        ? { source: event.reason }
        : {}),
    };
  }

  /**
   * Surface hook-authored text to the model, on whichever channel this event has.
   *
   * Claude Code lets a hook add text the model will read; Pi's channel for that
   * depends on the event, and on `tool_result` the only one is the tool result
   * itself. Where there is no channel, say so — a dropped message the hook believes
   * it delivered is the failure mode this whole change is about.
   */
  private addContext(
    text: string,
    event: DispatchEvent,
    outcome: HookOutcome,
    label: string,
  ): void {
    if (event.event === "tool_result") {
      outcome.appended.push(text);
      return;
    }
    if (event.event === "before_agent_start") {
      outcome.context.push(text);
      return;
    }
    this.log(`hook "${label}": additional context dropped — ${event.event} has no channel for it`);
  }

  private applyControl(
    control: CommandControl,
    event: DispatchEvent,
    outcome: HookOutcome,
    label: string,
  ): void {
    if (control.notify) outcome.notifications.push({ message: control.notify, level: "info" });
    if (control.systemMessage) {
      outcome.notifications.push({ message: control.systemMessage, level: "warning" });
    }
    if (control.context) outcome.context.push(control.context);
    if (typeof control.content === "string") outcome.content = control.content;
    if (control.patchInput && event.input) {
      for (const [path, value] of Object.entries(control.patchInput)) {
        setPath(event.input, path, value);
      }
    }

    const extra = control.hookSpecificOutput?.additionalContext;
    if (typeof extra === "string" && extra.length > 0) {
      this.addContext(extra, event, outcome, label);
    }

    const denied = control.hookSpecificOutput?.permissionDecision === "deny";
    // Claude Code's `continue: false` stops all processing, which on Pi means
    // refusing the call *and* asking for the agent loop to end — Pi offers no
    // bare "stop" an extension can pull, and a terminate with nothing blocked is
    // dropped by extensions/hooks.ts.
    const halt = control.continue === false;
    // `block` and `terminate` stay truthy tests, not `=== true`: narrowing them
    // would make a guardrail that printed `{"block":"yes"}` start failing OPEN,
    // which is the one direction a change here must never go. `continue` is the
    // opposite case and is strict — only an explicit `false` means halt.
    const wantsBlock = Boolean(control.block) || control.decision === "block" || denied || halt;
    const terminate = Boolean(control.terminate) || halt;
    if (!wantsBlock && !terminate) return;

    const reason =
      control.reason ??
      control.hookSpecificOutput?.permissionDecisionReason ??
      control.stopReason ??
      outcome.reason;

    // Recorded before the non-blockable early return below, which used to drop it:
    // `continue: false` sets both flags, so a hook asking to stop on `tool_result`
    // had its stop request computed and then thrown away.
    if (terminate) {
      outcome.terminate = true;
      // `terminate` rides along with a veto, and `tool_call` is the only handler
      // Pi gives one to. Anywhere else the flag is a faithful record of what the
      // hook asked for and nothing more, which is worth a line rather than silence.
      if (event.event !== "tool_call") {
        this.log(
          `hook "${label}": asked to end the agent loop, which Pi only allows from tool_call — ` +
            `recorded but not acted on for ${event.event}`,
        );
      }
    }

    if (wantsBlock && !BLOCKABLE_EVENTS.includes(event.event)) {
      // Claude Code's PostToolUse `block` does not undo the call either — it
      // "prompts Claude with reason". Pi cannot veto here at all, and setting
      // `blocked` would be dropped by extensions/hooks.ts without a word, so the
      // reason takes the one route to the model that does exist.
      if (reason) this.addContext(reason, event, outcome, label);
      else this.log(`hook "${label}": block on ${event.event} has no effect and gave no reason`);
      return;
    }

    if (wantsBlock) {
      outcome.blocked = true;
      outcome.reason = reason;
    }
  }

  private async apply(
    action: HookAction,
    event: DispatchEvent,
    outcome: HookOutcome,
    label: string,
  ): Promise<void> {
    const context = this.templateContext(event, label);

    switch (action.type) {
      case "block": {
        outcome.blocked = true;
        outcome.reason = renderTemplate(action.reason ?? `Blocked by hook "${label}"`, context);
        if (action.terminate) outcome.terminate = true;
        return;
      }
      case "notify": {
        outcome.notifications.push({
          message: renderTemplate(action.message, context),
          level: action.level ?? "info",
        });
        return;
      }
      case "context": {
        outcome.context.push(renderTemplate(action.text, context));
        // Any hook asking to be displayed wins for the combined message.
        if (action.display) outcome.contextDisplay = true;
        return;
      }
      case "patch-input": {
        if (!event.input) {
          this.log(`hook "${label}": patch-input has no tool input to patch`);
          return;
        }
        for (const [path, value] of Object.entries(action.set)) {
          setPath(event.input, path, renderDeep(value, context));
        }
        return;
      }
      case "command": {
        const result = await runCommandAction(action, context, {
          cwd: this.deps.cwd,
          signal: this.deps.signal,
        });
        if (result.control) this.applyControl(result.control, event, outcome, label);
        // A control object supersedes the exit code only when it actually DECIDED
        // the event — i.e. it blocked. One that merely annotated (`notify`,
        // `content`, `additionalContext`, `patchInput`) leaves the disposition open,
        // so the hook's own non-zero exit still governs it. Returning early for
        // every control object is what let a key on stdout turn a hook that ERRORED
        // into a hook that allowed, which is a guardrail failing open.
        if (result.exitCode === 0 || outcome.blocked) return;

        const detail = result.control
          ? // stdout holds the control object; echoing that back would hand the
            // model JSON where it needs an explanation.
            result.stderr.trim() || `exit code ${result.exitCode}`
          : result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
        const summary = result.timedOut
          ? `hook "${label}" timed out after ${action.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
          : `hook "${label}": ${detail}`;
        // Blocking only means something on an event where Pi lets us veto. On
        // `session_start` or `tool_result` a "block" would be silently dropped by
        // the extension, so log the failure instead of swallowing it.
        const canBlock = BLOCKABLE_EVENTS.includes(event.event);
        if (canBlock && (action.blockOnFailure ?? true)) {
          outcome.blocked = true;
          outcome.reason = summary;
        } else {
          this.log(summary);
        }
        return;
      }
      default: {
        this.log(`unknown action type: ${(action as { type: string }).type}`);
      }
    }
  }
}
