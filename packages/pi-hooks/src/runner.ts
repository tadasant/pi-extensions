import { runCommandAction } from "./actions.ts";
import { hooksForEvent } from "./config.ts";
import { type MatchSubject, matches, setPath } from "./match.ts";
import { renderDeep, renderTemplate } from "./template.ts";
import type { CommandControl, HookAction, HookEvent, LoadedConfig, LoadedHook } from "./types.ts";

/** What a hook asked Pi to do, accumulated across every hook bound to one event. */
export interface HookOutcome {
  blocked: boolean;
  reason?: string;
  terminate?: boolean;
  /** Text to append to the conversation (`before_agent_start`). */
  context: string[];
  /** Replacement text for a tool result (`tool_result`). */
  content?: string;
  /** Messages the extension should surface in the UI. */
  notifications: { message: string; level: "info" | "warning" | "error" }[];
  /** Hook names that ran, in order — the e2e suite asserts on this. */
  ran: string[];
}

function emptyOutcome(): HookOutcome {
  return { blocked: false, context: [], notifications: [], ran: [] };
}

export interface RunnerDeps {
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

export function hookLabel(hook: LoadedHook): string {
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
      if (!matches(hook.definition.match, event)) continue;
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

  private templateContext(event: DispatchEvent, label: string): Record<string, unknown> {
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
    };
  }

  private applyControl(control: CommandControl, event: DispatchEvent, outcome: HookOutcome): void {
    if (control.notify) outcome.notifications.push({ message: control.notify, level: "info" });
    if (control.context) outcome.context.push(control.context);
    if (typeof control.content === "string") outcome.content = control.content;
    if (control.patchInput && event.input) {
      for (const [path, value] of Object.entries(control.patchInput)) {
        setPath(event.input, path, value);
      }
    }
    if (control.block) {
      outcome.blocked = true;
      outcome.reason = control.reason ?? outcome.reason;
      if (control.terminate) outcome.terminate = true;
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
        if (result.control) {
          this.applyControl(result.control, event, outcome);
          return;
        }
        if (result.exitCode === 0) return;

        const blockOnFailure = action.blockOnFailure ?? true;
        const detail =
          result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
        const summary = result.timedOut
          ? `hook "${label}" timed out after ${action.timeoutMs ?? 30_000}ms`
          : `hook "${label}": ${detail}`;
        if (blockOnFailure) {
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
