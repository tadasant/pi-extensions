import { spawn } from "node:child_process";
import { renderDeep, renderTemplate } from "./template.ts";
import type { CommandAction, CommandControl } from "./types.ts";

export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

export interface CommandOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  control: CommandControl | undefined;
}

/**
 * Flatten the event context into `PI_HOOK_*` variables so a hook script can read
 * the common fields without parsing anything.
 */
export function hookEnv(context: Record<string, unknown>): Record<string, string> {
  const env: Record<string, string> = { PI_HOOK: "1" };
  const put = (key: string, value: unknown) => {
    if (value === undefined || value === null) return;
    env[key] = typeof value === "string" ? value : JSON.stringify(value);
  };
  put("PI_HOOK_EVENT", context.event);
  put("PI_HOOK_NAME", context.hook);
  put("PI_HOOK_TOOL", context.toolName);
  put("PI_HOOK_CWD", context.cwd);
  put("PI_HOOK_PROMPT", context.prompt);
  put("PI_HOOK_REASON", context.reason);
  put("PI_HOOK_INPUT", context.input);
  put("PI_HOOK_PAYLOAD", context);
  return env;
}

/**
 * A `command` action's stdout may be a JSON control object. Anything that is not
 * parseable JSON is treated as ordinary output rather than an error, so
 * `echo hello` remains a perfectly good hook.
 */
export function parseControl(stdout: string): CommandControl | undefined {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? (parsed as CommandControl) : undefined;
  } catch {
    return undefined;
  }
}

export async function runCommandAction(
  action: CommandAction,
  context: Record<string, unknown>,
  options: { cwd: string; signal?: AbortSignal },
): Promise<CommandOutcome> {
  const timeoutMs = action.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const cwd = action.cwd ? renderTemplate(action.cwd, context) : options.cwd;
  const env = {
    ...process.env,
    ...hookEnv(context),
    ...((renderDeep(action.env ?? {}, context) as Record<string, string>) ?? {}),
  };

  const [file, args] = action.argv
    ? [
        renderTemplate(action.argv[0] ?? "", context),
        action.argv.slice(1).map((arg) => renderTemplate(arg, context)),
      ]
    : ["/bin/sh", ["-c", renderTemplate(action.command ?? "", context, { quote: true })]];

  return await new Promise<CommandOutcome>((resolvePromise) => {
    const child = spawn(file, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise({ exitCode, stdout, stderr, timedOut, control: parseControl(stdout) });
    };

    const onAbort = () => {
      child.kill("SIGTERM");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
      // Resolve without waiting for `close`: a killed `sh` can leave a grandchild
      // holding the stdout pipe open, and a hook must not stall the agent past its
      // own timeout.
      finish(124);
    }, timeoutMs);
    // Never keep the Pi process alive just because a hook timer is pending.
    timer.unref?.();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      stderr += String((error as Error).message);
      finish(127);
    });
    child.on("close", (code) => finish(code ?? (timedOut ? 124 : 1)));

    // A hook that never reads stdin (or exits first) makes this write fail
    // asynchronously with EPIPE. That is expected, not an error worth surfacing —
    // and an unhandled one would take the whole Pi process down.
    child.stdin.on("error", () => {});
    child.stdin.end(`${JSON.stringify(context)}\n`);
  });
}
