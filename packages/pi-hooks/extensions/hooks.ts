/**
 * pi-hooks — a declarative hook layer for the Pi coding agent.
 *
 * Pi's extension API already lets you subscribe to lifecycle events from
 * TypeScript. This extension is the layer above that: it reads a `hooks.json`
 * and dispatches the events for you, so the user configures behavior instead of
 * writing an extension.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverConfigPaths, listPresets, loadConfig } from "../src/config.ts";
import type { HookOutcome } from "../src/runner.ts";
import { HookRunner } from "../src/runner.ts";
import type { LoadedConfig } from "../src/types.ts";

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function reload(cwd: string): LoadedConfig {
  const paths = discoverConfigPaths({ cwd, agentDir: agentDir() });
  return loadConfig(paths);
}

/** Extension logs go to stderr; Pi keeps stdout clean for `--mode json`. */
function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

/**
 * Run a handler body, and never let it throw into Pi.
 *
 * Pi does catch a rejecting handler, but what surfaces is an unlabeled
 * `Extension error (…/hooks.ts)` line — or, on `tool_call`, a raw JS message
 * handed to the model as the tool result. Returning the pass-through value with a
 * `[pi-hooks]`-prefixed log keeps the promise the README makes: a broken hook is
 * reported by name and skipped, and the session carries on.
 */
async function guard<T>(what: string, fallback: T, body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    log(`[pi-hooks] ${what} handler failed: ${(error as Error).message}`);
    return fallback;
  }
}

function flushNotifications(outcome: HookOutcome, ctx: ExtensionContext): void {
  for (const notification of outcome.notifications) {
    // `notify` is unavailable in non-interactive modes; stderr is the fallback
    // and is also what the e2e suite asserts against.
    try {
      ctx.ui?.notify?.(notification.message, notification.level);
    } catch {
      // Ignore UI failures — a hook must never take the session down.
    }
    log(`[pi-hooks] notify(${notification.level}): ${notification.message}`);
  }
}

/**
 * Pi loads packages with separate module roots, so a user who installs both
 * `@tadasant/pi-hooks` and `@tadasant/pi-plugins` (which bundles it) gets this file
 * loaded twice — two runners over one hooks.json, every command spawned twice.
 * A process-global marker makes the second load a no-op instead.
 */
const ALREADY_LOADED = Symbol.for("@tadasant/pi-hooks.loaded");

export default function piHooks(pi: ExtensionAPI): void {
  const globals = globalThis as Record<symbol, unknown>;
  if (globals[ALREADY_LOADED]) {
    log(
      "[pi-hooks] already loaded in this process (installed both standalone and via " +
        "@tadasant/pi-plugins?); skipping the duplicate to avoid running every hook twice",
    );
    return;
  }
  globals[ALREADY_LOADED] = true;

  let config: LoadedConfig = { hooks: [], sources: [], errors: [] };
  const runner = new HookRunner(config, { cwd: process.cwd(), log });

  const applyConfig = (cwd: string): void => {
    try {
      config = reload(cwd);
    } catch (error) {
      // Fail loud, not silently open: without this the whole extension dies and
      // every guardrail the user configured disappears with no [pi-hooks] line.
      config = {
        hooks: [],
        sources: [],
        errors: [`config could not be loaded: ${(error as Error).message}`],
      };
    }
    runner.setConfig(config);
    for (const error of config.errors) log(`[pi-hooks] config error: ${error}`);
    log(
      `[pi-hooks] loaded ${config.hooks.length} hook(s) from ${
        config.sources.length > 0 ? config.sources.join(", ") : "no config file"
      }`,
    );
  };

  pi.on("session_start", async (event, ctx) =>
    guard("session_start", undefined, async () => {
      applyConfig(ctx.cwd ?? process.cwd());
      const outcome = await runner.dispatch({ event: "session_start", reason: event?.reason });
      flushNotifications(outcome, ctx);
    }),
  );

  pi.on("session_shutdown", async (event, ctx) =>
    guard("session_shutdown", undefined, async () => {
      const outcome = await runner.dispatch({ event: "session_shutdown", reason: event?.reason });
      flushNotifications(outcome, ctx);
    }),
  );

  pi.on("agent_settled", async (_event, ctx) =>
    guard("agent_settled", undefined, async () => {
      const outcome = await runner.dispatch({ event: "agent_settled" });
      flushNotifications(outcome, ctx);
    }),
  );

  pi.on("input", async (event, ctx) =>
    guard("input", { action: "continue" } as const, async () => {
      const outcome = await runner.dispatch({ event: "user_prompt", prompt: event?.text });
      flushNotifications(outcome, ctx);
      if (outcome.blocked) {
        log(`[pi-hooks] blocked prompt: ${outcome.reason ?? "(no reason given)"}`);
        try {
          ctx.ui?.notify?.(outcome.reason ?? "Prompt blocked by hook", "error");
        } catch {
          // Non-interactive mode has no UI to notify.
        }
        return { action: "handled" } as const;
      }
      return { action: "continue" } as const;
    }),
  );

  pi.on("before_agent_start", async (event, ctx) =>
    guard("before_agent_start", undefined, async () => {
      const outcome = await runner.dispatch({ event: "before_agent_start", prompt: event?.prompt });
      flushNotifications(outcome, ctx);
      if (outcome.context.length === 0) return undefined;
      return {
        message: {
          customType: "pi-hooks-context",
          content: outcome.context.join("\n\n"),
          display: outcome.contextDisplay,
        },
      };
    }),
  );

  pi.on("tool_call", async (event, ctx) =>
    guard("tool_call", undefined, async () => {
      const outcome = await runner.dispatch({
        event: "tool_call",
        toolName: event?.toolName,
        // Pi documents `event.input` as mutable: patch actions write through it.
        input: event?.input,
      });
      flushNotifications(outcome, ctx);
      if (!outcome.blocked) return undefined;
      const reason = outcome.reason ?? "Blocked by pi-hooks";
      log(`[pi-hooks] blocked ${event?.toolName}: ${reason}`);
      return outcome.terminate ? { block: true, reason, terminate: true } : { block: true, reason };
    }),
  );

  pi.on("tool_result", async (event, ctx) =>
    guard("tool_result", undefined, async () => {
      const text = (event?.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      const outcome = await runner.dispatch({
        event: "tool_result",
        toolName: event?.toolName,
        input: event?.input,
        isError: Boolean(event?.isError),
        content: text,
      });
      flushNotifications(outcome, ctx);
      if (typeof outcome.content === "string") {
        return { content: [{ type: "text", text: outcome.content }] };
      }
      return undefined;
    }),
  );

  pi.on("user_bash", async (event, ctx) =>
    guard("user_bash", undefined, async () => {
      const outcome = await runner.dispatch({
        event: "user_bash",
        toolName: "user_bash",
        input: { command: event?.command, cwd: event?.cwd },
      });
      flushNotifications(outcome, ctx);
      if (!outcome.blocked) return undefined;
      const reason = outcome.reason ?? "Blocked by pi-hooks";
      log(`[pi-hooks] blocked user bash: ${reason}`);
      return { result: { output: reason, exitCode: 1, cancelled: false, truncated: false } };
    }),
  );

  pi.registerCommand("hooks", {
    description: "List, reload, and inspect declarative pi-hooks",
    handler: async (args, ctx) => {
      const argument = (args ?? "").trim();
      if (argument === "reload") {
        applyConfig(ctx.cwd ?? process.cwd());
      }
      const lines: string[] = [];
      lines.push(
        config.sources.length > 0
          ? `Config: ${config.sources.join(", ")}`
          : "Config: none found (looked for .pi/hooks.json and $PI_CODING_AGENT_DIR/hooks.json)",
      );
      lines.push(`Bundled presets: ${listPresets().join(", ") || "(none)"}`);
      if (config.hooks.length === 0) {
        lines.push("No hooks loaded.");
      } else {
        for (const hook of config.hooks) {
          const events = Array.isArray(hook.definition.on)
            ? hook.definition.on.join("|")
            : hook.definition.on;
          lines.push(
            `- ${hook.definition.name ?? `#${hook.index}`} [${events}] -> ${hook.definition.action.type}`,
          );
        }
      }
      for (const error of config.errors) lines.push(`! ${error}`);
      const report = lines.join("\n");
      log(`[pi-hooks] /hooks\n${report}`);
      try {
        ctx.ui?.notify?.(report, "info");
      } catch {
        // Non-interactive mode has no UI; stderr already carries the report.
      }
    },
  });
}
