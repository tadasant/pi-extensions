import { spawn } from "node:child_process";
import { renderDeep, renderTemplate } from "./template.ts";
import type { CommandAction, CommandControl } from "./types.ts";

export const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

/** Well under Linux's 128 KiB MAX_ARG_STRLEN, with room for the truncation notice. */
export const MAX_ENV_VALUE_BYTES = 32_768;

/** Cap on captured hook output, so `command: "yes"` cannot exhaust Pi's heap. */
export const MAX_CAPTURED_OUTPUT_BYTES = 1_048_576;

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
    const encoded = typeof value === "string" ? value : JSON.stringify(value);
    if (encoded === undefined) return;
    if (encoded.length > MAX_ENV_VALUE_BYTES) {
      // Linux caps one env string at MAX_ARG_STRLEN (128 KiB) and spawn throws
      // E2BIG past it — which would make a policy hook silently not run on exactly
      // the oversized write it exists to inspect. stdin carries the full event
      // uncapped, so truncate here and say so.
      env[key] =
        `${encoded.slice(0, MAX_ENV_VALUE_BYTES)}\n[pi-hooks: truncated at ${MAX_ENV_VALUE_BYTES} bytes; read stdin for the full event]`;
      return;
    }
    env[key] = encoded;
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
const CONTROL_KEYS = [
  "block",
  "reason",
  "terminate",
  "patchInput",
  "content",
  "context",
  "notify",
] as const;

export function parseControl(stdout: string): CommandControl | undefined {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    // Plenty of tools print JSON diagnostics and exit non-zero (`eslint -f json`,
    // `semgrep --json`). Treating that as a control object would cancel the
    // exit-code semantics and make the hook silently do nothing, so require at
    // least one key this layer actually understands.
    if (!CONTROL_KEYS.some((key) => key in parsed)) return undefined;
    return parsed as CommandControl;
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
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    let child: ReturnType<typeof spawn>;
    try {
      // `detached` puts the hook in its own process group so a timeout can kill the
      // grandchildren too — killing only `/bin/sh` leaves a pipeline running.
      child = spawn(file, args, { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      // spawn can throw synchronously (E2BIG, ENOENT on some platforms). Report it
      // as a failed run so blockOnFailure still applies rather than failing open.
      resolvePromise({
        exitCode: 127,
        stdout: "",
        stderr: `failed to start hook command: ${(error as Error).message}`,
        timedOut: false,
        control: undefined,
      });
      return;
    }

    /** Kill the hook's whole process group, falling back to the child alone. */
    const killTree = (signal: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise({ exitCode, stdout, stderr, timedOut, control: parseControl(stdout) });
    };

    const onAbort = () => killTree("SIGTERM");
    const timer = setTimeout(() => {
      timedOut = true;
      killTree("SIGKILL");
      // Resolve without waiting for `close`: even after a group kill, a stray
      // descendant can hold the pipe, and a hook must not stall the agent past its
      // own timeout.
      finish(124);
    }, timeoutMs);
    // Never keep the Pi process alive just because a hook timer is pending.
    timer.unref?.();
    options.signal?.addEventListener("abort", onAbort, { once: true });

    /** Append with a hard cap, so a runaway hook cannot exhaust Pi's heap. */
    const capture = (current: string, chunk: unknown): string => {
      if (current.length >= MAX_CAPTURED_OUTPUT_BYTES) return current;
      const next = current + String(chunk);
      return next.length <= MAX_CAPTURED_OUTPUT_BYTES
        ? next
        : `${next.slice(0, MAX_CAPTURED_OUTPUT_BYTES)}\n[pi-hooks: output truncated]`;
    };

    child.stdout?.on("data", (chunk) => {
      stdout = capture(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = capture(stderr, chunk);
    });
    child.on("error", (error) => {
      stderr += String((error as Error).message);
      finish(127);
    });
    child.on("close", (code) => finish(code ?? (timedOut ? 124 : 1)));

    // A hook that never reads stdin (or exits first) makes this write fail
    // asynchronously with EPIPE. That is expected, not an error worth surfacing —
    // and an unhandled one would take the whole Pi process down.
    child.stdin?.on("error", () => {});
    child.stdin?.end(`${JSON.stringify(context)}\n`);
  });
}
