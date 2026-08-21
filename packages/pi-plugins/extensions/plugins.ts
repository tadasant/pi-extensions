/**
 * pi-plugins — AIR plugin support for the Pi coding agent.
 *
 * An AIR plugin (https://github.com/pulsemcp/air) is a compositional artifact: a
 * manifest that bundles skills, hooks, and MCP servers *by ID* rather than a
 * directory of content. Pi cannot consume that format at all. This extension is the
 * Pi adapter for it — it resolves the plugins selected for a session and activates
 * what they bundle:
 *
 * - **skills** are contributed through Pi's own `resources_discover` event, so Pi
 *   loads them exactly as it loads any other skill directory;
 * - **hooks** are translated into `@tadasant/pi-hooks` definitions and dispatched by
 *   that engine, rather than growing a second hook path here;
 * - **MCP servers** are translated into the `.pi/mcp.json` that `pi-mcp-adapter`
 *   reads. That adapter is a *required peer* — `pi install npm:pi-mcp-adapter` —
 *   rather than a bundled dependency, because it carries native keychain binaries
 *   for every platform. Nothing here speaks MCP; this package only writes the config
 *   the adapter consumes, and says so loudly when the adapter is missing.
 *
 * That composition is why this file does its work in the extension **factory**
 * rather than on `session_start`: `pi-mcp-adapter` calls `loadMcpConfig()` at factory
 * time, so the config has to exist before its factory runs.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HookOutcome } from "@tadasant/pi-hooks/src/runner.ts";
import { HookRunner } from "@tadasant/pi-hooks/src/runner.ts";
import type { LoadedConfig } from "@tadasant/pi-hooks/src/types.ts";
import { activate } from "../src/activate.ts";
import type { ActivationResult } from "../src/types.ts";

function log(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** Never let a handler throw into Pi; see the same helper in pi-hooks. */
async function guard<T>(what: string, fallback: T, body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    log(`[pi-plugins] ${what} handler failed: ${(error as Error).message}`);
    return fallback;
  }
}

function emptyActivation(): ActivationResult {
  return { plugins: [], skillPaths: [], hooks: [], mcpServers: [], warnings: [] };
}

/** Wrap the translated hooks in the shape pi-hooks' runner consumes. */
function toHooksConfig(result: ActivationResult): LoadedConfig {
  return {
    hooks: result.hooks.map((hook, index) => ({
      definition: hook.definition as any,
      source: `air:${hook.airId}`,
      index,
    })),
    sources: result.plugins.map((plugin) => plugin.id),
    errors: [],
  };
}

function flushNotifications(outcome: HookOutcome, ctx: ExtensionContext): void {
  for (const notification of outcome.notifications) {
    try {
      ctx.ui?.notify?.(notification.message, notification.level);
    } catch {
      // Non-interactive mode has no UI to notify.
    }
    log(`[pi-plugins] notify(${notification.level}): ${notification.message}`);
  }
}

export default function piPlugins(pi: ExtensionAPI): void {
  let activation: ActivationResult = emptyActivation();
  const runner = new HookRunner(toHooksConfig(activation), { cwd: process.cwd(), log });

  const reload = (cwd: string): void => {
    // Keep the runner's cwd in step, or hook templates report the startup directory
    // after a /resume into another project.
    runner.setCwd(cwd);
    try {
      activation = activate({ cwd, materializeMcp: true });
    } catch (error) {
      activation = emptyActivation();
      activation.warnings.push(`AIR config could not be loaded: ${(error as Error).message}`);
    }
    runner.setConfig(toHooksConfig(activation));

    for (const warning of activation.warnings) log(`[pi-plugins] warning: ${warning}`);
    if (activation.plugins.length === 0) {
      log("[pi-plugins] no AIR plugins activated");
      return;
    }
    log(
      `[pi-plugins] activated ${activation.plugins.length} plugin(s): ` +
        activation.plugins.map((plugin) => plugin.id).join(", "),
    );
    log(
      `[pi-plugins] ${activation.skillPaths.length} skill path(s), ` +
        `${activation.hooks.length} hook(s), ${activation.mcpServers.length} MCP server(s)`,
    );
    if (activation.mcp && activation.mcp.written.length > 0) {
      log(
        `[pi-plugins] wrote MCP server(s) ${activation.mcp.written.join(", ")} to ` +
          `${activation.mcp.path} for pi-mcp-adapter`,
      );
      log(
        activation.mcpAdapter
          ? `[pi-plugins] pi-mcp-adapter found at ${activation.mcpAdapter}`
          : "[pi-plugins] pi-mcp-adapter is NOT installed; those servers will not start",
      );
    }
  };

  // Resolve during the factory, not on session_start: pi-mcp-adapter reads
  // .pi/mcp.json when *its* factory runs, and it is declared after this extension.
  reload(process.cwd());

  pi.on("session_start", async (_event, ctx) =>
    guard("session_start", undefined, async () => {
      // The factory already resolved against process.cwd(); re-resolve only if the
      // session's cwd differs, so a `/resume` into another directory still works.
      if ((ctx.cwd ?? process.cwd()) !== process.cwd()) reload(ctx.cwd ?? process.cwd());
      const outcome = await runner.dispatch({ event: "session_start" });
      flushNotifications(outcome, ctx);
    }),
  );

  // Pi's documented seam for an extension to contribute skill directories. AIR
  // skills are directories containing SKILL.md, which is exactly what Pi discovers.
  pi.on("resources_discover", async (_event, _ctx) =>
    guard("resources_discover", undefined, async () => {
      if (activation.skillPaths.length === 0) return undefined;
      log(`[pi-plugins] contributing skill paths: ${activation.skillPaths.join(", ")}`);
      return { skillPaths: activation.skillPaths };
    }),
  );

  pi.on("session_shutdown", async (_event, ctx) =>
    guard("session_shutdown", undefined, async () => {
      const outcome = await runner.dispatch({ event: "session_shutdown" });
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
      if (!outcome.blocked) return { action: "continue" } as const;
      log(`[pi-plugins] blocked prompt: ${outcome.reason ?? "(no reason given)"}`);
      try {
        // Without this the prompt just vanishes: stderr is invisible in the TUI.
        ctx.ui?.notify?.(outcome.reason ?? "Prompt blocked by an AIR plugin hook", "error");
      } catch {
        // Non-interactive mode has no UI to notify.
      }
      return { action: "handled" } as const;
    }),
  );

  pi.on("tool_call", async (event, ctx) =>
    guard("tool_call", undefined, async () => {
      const outcome = await runner.dispatch({
        event: "tool_call",
        toolName: event?.toolName,
        input: event?.input,
      });
      flushNotifications(outcome, ctx);
      if (!outcome.blocked) return undefined;
      const reason = outcome.reason ?? "Blocked by an AIR plugin hook";
      log(`[pi-plugins] blocked ${event?.toolName}: ${reason}`);
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

  pi.registerCommand("plugins", {
    description: "List the AIR plugins active in this session and what they bundle",
    handler: async (args, ctx) => {
      if ((args ?? "").trim() === "reload") reload(ctx.cwd ?? process.cwd());
      const lines: string[] = [];
      if (activation.plugins.length === 0) {
        lines.push("No AIR plugins active.");
        lines.push("Looked for air.json in the working directory and .air/air.json.");
      }
      for (const plugin of activation.plugins) {
        lines.push(`- ${plugin.id}${plugin.version ? `@${plugin.version}` : ""}: ${plugin.title}`);
        lines.push(`    ${plugin.description}`);
        if (plugin.composedFrom.length > 0) {
          lines.push(`    composes: ${plugin.composedFrom.join(", ")}`);
        }
        if (plugin.skills.length > 0) lines.push(`    skills: ${plugin.skills.join(", ")}`);
        if (plugin.hooks.length > 0) lines.push(`    hooks: ${plugin.hooks.join(", ")}`);
        if (plugin.mcpServers.length > 0) {
          lines.push(`    mcp servers: ${plugin.mcpServers.join(", ")} (run by pi-mcp-adapter)`);
        }
      }
      if (activation.mcp) {
        lines.push(`  mcp config: ${activation.mcp.path}`);
        lines.push(
          `    pi-mcp-adapter: ${activation.mcpAdapter ?? "NOT INSTALLED (pi install npm:pi-mcp-adapter)"}`,
        );
        if (activation.mcp.written.length > 0) {
          lines.push(`    wrote: ${activation.mcp.written.join(", ")}`);
        }
        if (activation.mcp.removed.length > 0) {
          lines.push(`    removed: ${activation.mcp.removed.join(", ")}`);
        }
      }
      for (const hook of activation.hooks) {
        lines.push(`  hook ${hook.airId}: AIR "${hook.airEvent}" -> pi-hooks`);
      }
      for (const warning of activation.warnings) lines.push(`  ! ${warning}`);
      const report = lines.join("\n");
      log(`[pi-plugins] /plugins\n${report}`);
      try {
        ctx.ui?.notify?.(report, "info");
      } catch {
        // Non-interactive mode has no UI; stderr already carries the report.
      }
    },
  });
}
