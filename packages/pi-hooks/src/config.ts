import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOOK_EVENTS,
  type HookDefinition,
  type HookEvent,
  type HooksConfig,
  type LoadedConfig,
  type LoadedHook,
} from "./types.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PRESET_DIR = join(PACKAGE_ROOT, "presets");

export const CONFIG_FILENAMES = ["hooks.json", "hooks.jsonc"] as const;

/** Names of the presets bundled with this package, for `/hooks` and error messages. */
export function listPresets(): string[] {
  try {
    // Presets are just a flat directory of .json files shipped in the tarball.
    return readdirSync(PRESET_DIR)
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.replace(/\.json$/, ""))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Strip `//` and block comments so a `hooks.jsonc` can carry explanations.
 * String literals are respected, so a `//` inside a glob survives.
 */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;
    const next = text[i + 1];
    if (inLine) {
      if (char === "\n") {
        inLine = false;
        out += char;
      }
      continue;
    }
    if (inBlock) {
      // Keep newlines so JSON.parse error line numbers still point at the real line.
      if (char === "\n") out += char;
      if (char === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === "\\") {
        out += text[i + 1] ?? "";
        i++;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += char;
  }
  return out;
}

/**
 * Where hook configs are looked for, lowest precedence first.
 *
 * `PI_HOOKS_CONFIG` (colon-separated) replaces discovery entirely, which is what the
 * e2e suite and one-off runs use.
 */
export function discoverConfigPaths(options: {
  cwd: string;
  agentDir: string;
  env?: NodeJS.ProcessEnv;
}): string[] {
  const env = options.env ?? process.env;
  const override = env.PI_HOOKS_CONFIG;
  if (override) {
    return override
      .split(":")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => (isAbsolute(entry) ? entry : resolve(options.cwd, entry)));
  }
  // Scope is the outer loop: every user-level config must sort before every
  // project-level one, whichever filename each happens to use. Iterating filenames
  // first would let a project `hooks.json` load ahead of a user `hooks.jsonc` and
  // silently invert the documented precedence.
  const candidates: string[] = [];
  for (const dir of [options.agentDir, join(options.cwd, ".pi")]) {
    for (const filename of CONFIG_FILENAMES) {
      candidates.push(join(dir, filename));
    }
  }
  return candidates.filter((path) => existsSync(path));
}

function resolveExtends(spec: string, fromDir: string): string {
  if (spec.startsWith("preset:")) {
    const name = spec.slice("preset:".length);
    if (!/^[\w-]+$/.test(name)) throw new Error(`Invalid preset name: ${name}`);
    const path = join(PRESET_DIR, `${name}.json`);
    if (!existsSync(path)) {
      throw new Error(`Unknown preset "${name}". Available: ${listPresets().join(", ")}`);
    }
    return path;
  }
  if (isAbsolute(spec) || spec.startsWith(".")) return resolve(fromDir, spec);
  // Bare specifier: let Node resolution find it, first from the config's own
  // directory (a project's node_modules) and then from this package.
  const require = createRequire(join(fromDir, "noop.js"));
  try {
    return require.resolve(spec);
  } catch {
    return createRequire(import.meta.url).resolve(spec);
  }
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

const MATCHER_PATTERN_FIELDS = ["tool", "prompt", "reason"] as const;

function isPatternValue(value: unknown): boolean {
  return (
    typeof value === "string" || (Array.isArray(value) && value.every((v) => typeof v === "string"))
  );
}

/**
 * Check every pattern in a matcher is a string or string[].
 *
 * Matching runs on Pi's hot path for every event, and `matchPattern` assumes a
 * string. A `{"tool": 123}` that reaches it throws `pattern.startsWith is not a
 * function` — which Pi hands back to the model as the tool result, naming neither
 * the hook nor the field. Catching it here makes it a startup error instead.
 */
function validateMatcher(matcher: unknown, label: string, path = "match"): string[] {
  const errors: string[] = [];
  if (matcher === undefined) return errors;
  if (!matcher || typeof matcher !== "object" || Array.isArray(matcher)) {
    return [`${label}: "${path}" must be an object`];
  }
  const m = matcher as Record<string, unknown>;
  for (const field of MATCHER_PATTERN_FIELDS) {
    if (m[field] !== undefined && !isPatternValue(m[field])) {
      errors.push(`${label}: "${path}.${field}" must be a string or an array of strings`);
    }
  }
  if (m.isError !== undefined && typeof m.isError !== "boolean") {
    errors.push(`${label}: "${path}.isError" must be a boolean`);
  }
  if (m.input !== undefined) {
    if (!m.input || typeof m.input !== "object" || Array.isArray(m.input)) {
      errors.push(`${label}: "${path}.input" must be an object`);
    } else {
      for (const [key, value] of Object.entries(m.input as Record<string, unknown>)) {
        if (!isPatternValue(value)) {
          errors.push(`${label}: "${path}.input.${key}" must be a string or an array of strings`);
        }
      }
    }
  }
  for (const combinator of ["all", "any"] as const) {
    const nested = m[combinator];
    if (nested === undefined) continue;
    if (!Array.isArray(nested)) {
      errors.push(`${label}: "${path}.${combinator}" must be an array of matchers`);
      continue;
    }
    nested.forEach((entry, index) => {
      errors.push(...validateMatcher(entry, label, `${path}.${combinator}[${index}]`));
    });
  }
  if (m.not !== undefined) errors.push(...validateMatcher(m.not, label, `${path}.not`));
  return errors;
}

/** Reject anything that would blow up later, with a message naming the offender. */
export function validateHook(hook: HookDefinition, label: string): string[] {
  const errors: string[] = [];
  if (!hook || typeof hook !== "object" || Array.isArray(hook)) {
    return [`${label}: expected a hook object`];
  }
  errors.push(...validateMatcher(hook.match, label));
  const events = asArray(hook.on);
  if (events.length === 0) errors.push(`${label}: "on" is required`);
  for (const event of events) {
    if (!HOOK_EVENTS.includes(event as HookEvent)) {
      errors.push(`${label}: unknown event "${event}" (known: ${HOOK_EVENTS.join(", ")})`);
    }
  }
  const action = hook.action;
  if (!action || typeof action !== "object") {
    errors.push(`${label}: "action" is required`);
    return errors;
  }
  switch (action.type) {
    case "block":
    case "context":
    case "notify":
    case "patch-input":
      break;
    case "command":
      if (!action.command && !action.argv) {
        errors.push(`${label}: command action needs "command" or "argv"`);
      }
      if (action.command && action.argv) {
        errors.push(`${label}: command action cannot set both "command" and "argv"`);
      }
      break;
    default:
      errors.push(`${label}: unknown action type "${(action as { type: string }).type}"`);
  }
  if (action.type === "context" && !asArray(hook.on).includes("before_agent_start")) {
    errors.push(`${label}: "context" actions only apply to before_agent_start`);
  }
  return errors;
}

function loadOne(path: string, seen: Set<string>, out: LoadedConfig): void {
  const key = resolve(path);
  if (seen.has(key)) return;
  seen.add(key);

  let parsed: HooksConfig;
  try {
    parsed = JSON.parse(stripJsonComments(readFileSync(key, "utf8"))) as HooksConfig;
  } catch (error) {
    out.errors.push(`${key}: ${(error as Error).message}`);
    return;
  }
  if (!parsed || typeof parsed !== "object") {
    out.errors.push(`${key}: expected a JSON object`);
    return;
  }

  const extendsList = parsed.extends;
  if (extendsList !== undefined && !Array.isArray(extendsList)) {
    // A bare string here would otherwise be iterated character by character.
    out.errors.push(`${key}: "extends" must be an array of strings`);
  } else {
    for (const spec of extendsList ?? []) {
      if (typeof spec !== "string") {
        out.errors.push(`${key}: every "extends" entry must be a string`);
        continue;
      }
      try {
        loadOne(resolveExtends(spec, dirname(key)), seen, out);
      } catch (error) {
        out.errors.push(`${key}: cannot extend "${spec}": ${(error as Error).message}`);
      }
    }
  }

  const hooks = parsed.hooks ?? [];
  if (!Array.isArray(hooks)) {
    out.errors.push(`${key}: "hooks" must be an array`);
    return;
  }
  hooks.forEach((definition, index) => {
    const label = `${key} #${index}${definition?.name ? ` (${definition.name})` : ""}`;
    // A stray null or a non-object entry is a typo, not a reason to drop every
    // other hook in the file.
    const errors = validateHook(definition, label);
    if (errors.length > 0) {
      out.errors.push(...errors);
      return;
    }
    if (definition.enabled === false) return;
    out.hooks.push({ definition, source: key, index });
  });
  out.sources.push(key);
}

/** Load and merge every config file, following `extends`, in precedence order. */
export function loadConfig(paths: string[]): LoadedConfig {
  const out: LoadedConfig = { hooks: [], sources: [], errors: [] };
  const seen = new Set<string>();
  for (const path of paths) {
    if (!existsSync(path)) {
      out.errors.push(`${path}: no such file`);
      continue;
    }
    loadOne(path, seen, out);
  }
  return out;
}

export function hooksForEvent(config: LoadedConfig, event: HookEvent): LoadedHook[] {
  return config.hooks.filter((hook) => asArray(hook.definition.on).includes(event));
}
