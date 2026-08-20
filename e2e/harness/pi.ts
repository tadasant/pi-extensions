/**
 * Drives the real, pinned Pi CLI as a subprocess.
 *
 * Every run gets a throwaway `PI_CODING_AGENT_DIR` (so no developer's real Pi config
 * leaks in), a throwaway working directory, and a `models.json` pointing Pi's model
 * provider at the simulated LLM on localhost. Nothing about Pi is stubbed: this is
 * the published tarball's `dist/cli.js`, loading extensions through Pi's own jiti
 * loader and dispatching through Pi's own event bus.
 */
import { execSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PI_CLI_ENTRY, PI_VERSION } from "../../scripts/install-pinned-pi.mjs";
import { type FakeLlm, type ScriptedTurn, startFakeLlm } from "../fake-llm/server.ts";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const HOOKS_PACKAGE_DIR = join(REPO_ROOT, "packages", "pi-hooks");
export const HOOKS_EXTENSION = join(HOOKS_PACKAGE_DIR, "extensions", "hooks.ts");
export const STARTER_PACKAGE_DIR = join(REPO_ROOT, "packages", "pi-starter");
export { PI_CLI_ENTRY, PI_VERSION };

/** One `--mode json` line from Pi's event stream. */
export interface PiEvent {
  type: string;
  [key: string]: unknown;
}

export interface PiRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  events: PiEvent[];
  /** The scratch working directory the run happened in. */
  cwd: string;
  /** The throwaway `PI_CODING_AGENT_DIR` for this run. */
  agentDir: string;
  llm: FakeLlm;
  eventsOfType(type: string): PiEvent[];
  /** Assistant text, tool results, and blocked-call messages, concatenated. */
  transcriptText(): string;
}

export interface RunPiOptions {
  /** Scripted assistant turns the simulated LLM replays, in order. */
  script: ScriptedTurn[];
  /** The user prompt handed to Pi. */
  prompt: string;
  /** `hooks.json` contents written into the run's project directory. */
  hooksConfig?: unknown;
  /**
   * Extension specs passed with `-e`. Defaults to the pi-hooks extension file.
   * A package directory works too, which is how the package-layout test runs.
   */
  extensions?: string[];
  /** Extra files seeded into the working directory before Pi starts. */
  files?: Record<string, string>;
  /** Extra environment for the Pi process. */
  env?: Record<string, string>;
  /** Extra CLI arguments. */
  args?: string[];
  /**
   * Shell commands run in the scratch directory before Pi starts — for tests that
   * need a real git repository rather than a bare directory.
   */
  setupCommands?: string[];
  timeoutMs?: number;
}

function writeModelsJson(agentDir: string, baseUrl: string): void {
  // Pi's documented custom-provider seam (docs/models.md). No vendor endpoint is
  // reachable from a run configured this way.
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify(
      {
        providers: {
          "pi-e2e": {
            baseUrl,
            api: "openai-completions",
            apiKey: "not-a-real-key",
            compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
            models: [
              {
                id: "pi-e2e-model",
                name: "Pi E2E Simulated Model",
                reasoning: false,
                input: ["text"],
                contextWindow: 128000,
                maxTokens: 4096,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
      null,
      2,
    ),
  );
}

export async function runPi(options: RunPiOptions): Promise<PiRunResult> {
  const llm = await startFakeLlm(options.script);
  const scratch = mkdtempSync(join(tmpdir(), "pi-e2e-"));
  const agentDir = join(scratch, "agent");
  const cwd = join(scratch, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeModelsJson(agentDir, llm.url);

  // Non-interactive Pi never prompts for trust, so make the decision explicit.
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ defaultProjectTrust: "always" }, null, 2),
  );

  if (options.hooksConfig !== undefined) {
    writeFileSync(
      join(cwd, ".pi", "hooks.json"),
      typeof options.hooksConfig === "string"
        ? options.hooksConfig
        : JSON.stringify(options.hooksConfig, null, 2),
    );
  }
  for (const [name, contents] of Object.entries(options.files ?? {})) {
    const target = join(cwd, name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);
  }

  for (const command of options.setupCommands ?? []) {
    execSync(command, {
      cwd,
      stdio: "ignore",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    });
  }

  const extensions = options.extensions ?? [HOOKS_EXTENSION];
  const args = [
    PI_CLI_ENTRY,
    "--provider",
    "pi-e2e",
    "--model",
    "pi-e2e-model",
    "--no-session",
    "--no-context-files",
    "--no-extensions",
    "--approve",
    ...extensions.flatMap((spec) => ["-e", spec]),
    "--mode",
    "json",
    ...(options.args ?? []),
    options.prompt,
  ];

  const child = spawn(process.execPath, args, {
    cwd,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      // Keep the run hermetic: no update checks, no telemetry, no package fetches.
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      PI_TELEMETRY: "0",
      NO_COLOR: "1",
      ...options.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (part) => {
    stdout += String(part);
  });
  child.stderr.on("data", (part) => {
    stderr += String(part);
  });

  const exitCode = await new Promise<number | null>((resolvePromise) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise(code);
    });
  });

  await llm.close();

  const events: PiEvent[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      events.push(JSON.parse(trimmed) as PiEvent);
    } catch {
      // Non-JSON chatter on stdout is not an event; ignore it.
    }
  }

  return {
    exitCode,
    stdout,
    stderr,
    events,
    cwd,
    agentDir,
    llm,
    eventsOfType: (type) => events.filter((event) => event.type === type),
    transcriptText: () =>
      events
        .filter((event) => event.type === "message_end")
        .map((event) => {
          const message = event.message as { content?: { type: string; text?: string }[] };
          return (message?.content ?? [])
            .filter((part) => part.type === "text")
            .map((part) => part.text ?? "")
            .join("\n");
        })
        .join("\n"),
  };
}

/** Tool results Pi produced, flattened to `{ toolName, text, isError }`. */
export function toolResults(result: PiRunResult): {
  toolName: string;
  text: string;
  isError: boolean;
}[] {
  return result.eventsOfType("tool_execution_end").map((event) => {
    const payload = event.result as { content?: { type: string; text?: string }[] };
    return {
      toolName: String(event.toolName),
      text: (payload?.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join(""),
      isError: Boolean(event.isError),
    };
  });
}
