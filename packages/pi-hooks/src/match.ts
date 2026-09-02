import type { HookMatcher, Pattern } from "./types.ts";

/**
 * Segments that must never appear in a dot path.
 *
 * Paths reach here from two places a user does not fully control: a `patch-input`
 * action's `set` keys, and the `patchInput` keys of whatever JSON a `command` hook
 * printed on stdout. Walking `__proto__` would let either one mutate
 * `Object.prototype` for the rest of the Pi process.
 */
const UNSAFE_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);

function assertSafePath(path: string): string[] {
  const segments = path.split(".");
  const unsafe = segments.find((segment) => UNSAFE_SEGMENTS.has(segment));
  if (unsafe) throw new Error(`refusing to walk unsafe path segment "${unsafe}" in "${path}"`);
  return segments;
}

/** Read a dot-path (`"a.b.0.c"`) out of an arbitrary value, or `undefined`. */
export function getPath(source: unknown, path: string): unknown {
  let current = source;
  for (const segment of path.split(".")) {
    if (UNSAFE_SEGMENTS.has(segment)) return undefined;
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/**
 * Set a dot-path on an object, creating intermediate plain objects as needed.
 *
 * Throws on a prototype-polluting path. The runner catches it and logs the hook by
 * name, so a bad patch is loud rather than a mutation nobody sees.
 */
export function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const segments = assertSafePath(path);
  const last = segments.pop();
  if (!last) return;
  let current: Record<string, unknown> = target;
  for (const segment of segments) {
    const next = current[segment];
    if (next === null || typeof next !== "object") {
      const created: Record<string, unknown> = {};
      current[segment] = created;
      current = created;
    } else {
      current = next as Record<string, unknown>;
    }
  }
  current[last] = value;
}

const REGEX_PATTERN = /^\/(.*)\/([gimsuy]*)$/s;

/**
 * Translate a glob into a regular expression.
 *
 * `**` crosses path separators, `*` does not, `?` matches a single non-separator
 * character, and `{a,b}` is an alternation. Everything else is literal.
 */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i] as string;
    if (char === "*") {
      if (glob[i + 1] === "*") {
        i++;
        // `**/` should also match zero directories, so `**/x` matches a bare `x`.
        if (glob[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else if (char === "{") {
      const close = glob.indexOf("}", i);
      if (close === -1) {
        out += "\\{";
      } else {
        const alternatives = glob
          .slice(i + 1, close)
          .split(",")
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
        out += `(?:${alternatives.join("|")})`;
        i = close;
      }
    } else {
      out += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`, "s");
}

/** Match a single value against a single pattern (regex, glob, or negation). */
export function matchPattern(value: unknown, pattern: Pattern): boolean {
  if (pattern.startsWith("!")) return !matchPattern(value, pattern.slice(1));
  if (value === null || value === undefined) return false;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return false;
  const asRegex = REGEX_PATTERN.exec(pattern);
  if (asRegex) {
    try {
      // Note: regex patterns are unanchored, unlike globs.
      return new RegExp(asRegex[1] as string, asRegex[2]).test(text);
    } catch {
      // `/etc/sys` looks like a regex (trailing segment is all [gimsuy]) but is a
      // path with duplicate "flags", so the constructor throws. Falling through to
      // glob matching is what the user meant; returning false would mean such a
      // pattern silently never fires.
    }
  }
  return globToRegExp(pattern).test(text);
}

/**
 * Match a value against one pattern or a list of them.
 *
 * A list is an OR of its positive patterns, but negative (`!`) patterns are
 * conjunctive: `["*.ts", "!**\/*.test.ts"]` reads as "any .ts file, except tests".
 */
export function matchPatterns(value: unknown, patterns: Pattern | Pattern[]): boolean {
  const list = Array.isArray(patterns) ? patterns : [patterns];
  if (list.length === 0) return true;
  const positives = list.filter((pattern) => !pattern.startsWith("!"));
  const negatives = list.filter((pattern) => pattern.startsWith("!"));
  if (negatives.some((pattern) => !matchPattern(value, pattern))) return false;
  if (positives.length === 0) return true;
  return positives.some((pattern) => matchPattern(value, pattern));
}

/** The event fields a matcher can look at, normalized across Pi's event shapes. */
export interface MatchSubject {
  toolName?: string;
  input?: unknown;
  prompt?: string;
  isError?: boolean;
  reason?: string;
}

export function matches(matcher: HookMatcher | undefined, subject: MatchSubject): boolean {
  if (!matcher) return true;

  if (matcher.tool !== undefined && !matchPatterns(subject.toolName, matcher.tool)) return false;
  if (matcher.prompt !== undefined && !matchPatterns(subject.prompt, matcher.prompt)) return false;
  if (matcher.reason !== undefined && !matchPatterns(subject.reason, matcher.reason)) return false;
  if (matcher.isError !== undefined && matcher.isError !== Boolean(subject.isError)) return false;

  if (matcher.input) {
    for (const [path, patterns] of Object.entries(matcher.input)) {
      if (!matchPatterns(getPath(subject.input, path), patterns)) return false;
    }
  }

  if (matcher.all && !matcher.all.every((nested) => matches(nested, subject))) return false;
  if (matcher.any && !matcher.any.some((nested) => matches(nested, subject))) return false;
  if (matcher.not && matches(matcher.not, subject)) return false;

  return true;
}
