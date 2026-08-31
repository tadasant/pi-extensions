# @tadasant/pi-hooks

**[AIR](https://github.com/pulsemcp/air) hooks for the [Pi coding agent](https://github.com/earendil-works/pi).**
Run `hooks.json` / `HOOK.json` artifacts inside a real Pi session — plus a Pi-native
superset for the things AIR's schema has no vocabulary for.

```bash
pi install npm:@tadasant/pi-hooks
```

## Why this exists

Pi ships a first-class [extension API](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md):
subscribe to `tool_call`, return `{ block: true }`, done. That is the *primitive*.
What Pi has no concept of is **hooks** — a lifecycle event bound to a command by
configuration rather than by a TypeScript module you write and maintain. The word
appears nowhere in Pi's docs.

[AIR](https://github.com/pulsemcp/air) already defines that artifact, vendor-neutrally,
and this package is its Pi runtime.

## AIR hooks

An AIR hook is two layers: an entry in a `hooks.json` index, and a directory whose
`HOOK.json` carries the runtime definition.

```json
// hooks.json — the index
{
  "block-prod-deploy": {
    "title": "Block Production Deploys",
    "description": "Refuse any command that would deploy straight to production",
    "path": "hooks/block-prod-deploy"
  }
}
```

```json
// hooks/block-prod-deploy/HOOK.json — the runtime definition
{
  "event": "pre_tool_call",
  "matcher": "deploy.*production",
  "command": "./guard.sh",
  "timeout_seconds": 10,
  "env": { "WEBHOOK_URL": "${SLACK_WEBHOOK_URL}" },
  "x-config": { "severity": "error" }
}
```

The hook runs from its own directory, so a relative `./guard.sh` resolves. **A
non-zero exit blocks the event**, with stderr as the reason handed to the model —
which is what makes an AIR guardrail a guardrail.

Point Pi at a catalog with an `air.json`:

```json
{ "name": "my-config", "catalogs": ["./catalog"] }
```

or name the index directly with `{ "hooks": ["./catalog/hooks.json"] }`. Discovery
looks for `air.json`, then `.air/air.json`; `PI_HOOKS_AIR` overrides it.

### What a hook script receives

| Channel | Contents |
|---|---|
| **stdin** | The whole event as JSON — never truncated |
| `PI_HOOK_EVENT` | `tool_call`, `tool_result`, … |
| `PI_HOOK_TOOL` | Tool name |
| `PI_HOOK_INPUT` | Tool arguments, as JSON |
| `PI_HOOK_CWD` | The project directory (the hook itself runs from its own) |
| `AIR_HOOK_ID` | The hook's qualified AIR id |
| `AIR_HOOK_CONFIG` | The merged `x-config`, with `${VAR}` resolved |

Oversized values are truncated in the environment variables, so a hook inspecting a
large payload should read stdin.

### Event mapping

AIR's vocabulary is agent-agnostic and broader than Pi's surface:

| AIR event | Pi event |
|---|---|
| `session_start` | `session_start` |
| `session_end` | `session_shutdown` |
| `pre_tool_call` | `tool_call` (can block) |
| `post_tool_call` | `tool_result` |
| `user_prompt_submit` | `user_prompt` (can block) |
| `stop` | `agent_settled` |

Claude Code's PascalCase spellings (`SessionStart`, `PreToolUse`, …) are accepted as
identity mappings, as AIR specifies. **`pre_commit`, `post_commit`, `subagent_stop`,
`notification`, and `pre_compact` are not activated** — Pi has no git-commit
lifecycle, no subagent concept, and no extension-visible notification event, and this
package does not expose compaction. A hook using one of those loads with a named
warning rather than silently never firing.

An AIR `matcher` is scoped to the fields each event carries — tool name or
`input.command` on the tool events, prompt text on `user_prompt_submit` — matched
case-insensitively, with Claude's tool names (`Bash`, `Edit`, …) aliased onto Pi's.

## Bundled AIR hooks

The package ships a small AIR catalog of guardrails. Adopt it by naming it as a
catalog in your `air.json`:

```json
{
  "name": "my-config",
  "catalogs": ["./node_modules/@tadasant/pi-hooks/air"]
}
```

| Hook | What it stops |
|---|---|
| `block-secret-access` | Reading, writing, or printing `.env`, private keys, `.netrc`, `.npmrc`, service-account JSON. `.env.example`/`.env.sample` are exempt. |
| `block-force-push` | `git push --force` without `--force-with-lease`; pushes naming `main`, `master`, or `HEAD`. Sees through `git -C <dir>`. |
| `block-history-rewrite` | `git reset --hard`, `git clean -fd`, and friends that discard uncommitted work. |
| `block-destructive-bash` | `rm -rf` of `/`, `~`, or the working tree (any flag order); `curl … \| sh`; `sudo`; `DROP TABLE`/`TRUNCATE`. |
| `session-git-status` | Advisory — reports repository state at session start. Never blocks. |

These are ordinary AIR artifacts: read them, copy them, or fork them.

## The Pi-native superset

AIR's `HOOK.json` can run a command and block on its exit code. Pi can do more than
that, and this package exposes the extra in its own config file — a superset, not a
replacement. Reach for it when you need a block **reason** without writing a script,
or need to rewrite a tool's input:

```json
// .pi/hooks.json
{
  "$schema": "https://raw.githubusercontent.com/tadasant/pi-extensions/main/packages/pi-hooks/schema/hooks.schema.json",
  "hooks": [
    {
      "name": "no-migrations-without-review",
      "on": "tool_call",
      "match": { "tool": ["write", "edit"], "input": { "path": "db/migrate/**" } },
      "action": { "type": "block", "reason": "Migrations are written by a human." }
    },
    {
      "name": "fail-fast-bash",
      "on": "tool_call",
      "match": { "tool": "bash", "not": { "input": { "command": "/^set -/" } } },
      "action": { "type": "patch-input", "set": { "command": "set -o pipefail\n{{input.command}}" } }
    }
  ]
}
```

Both formats load together and are dispatched by the same runner, so a project can
use either or both. The two are told apart by shape: an AIR index is a map of
`id -> { description, path }`, the superset has a top-level `hooks` array.

**Actions:** `block` (with a written reason, optionally terminating the agent loop),
`patch-input` (rewrite the arguments Pi is about to execute), `command` (same
contract as an AIR hook, plus a JSON control object on stdout), `notify`, and
`context` (inject a message into the conversation on `before_agent_start`).

**Matching:** globs where `*` stays inside a path segment and `**` crosses them,
`/regex/flags`, `!` negation, and `all`/`any`/`not` combinators. Within a list,
positives are ORed and negatives ANDed, so `["**/.env*", "!**/.env.example"]` reads
the way it looks.

Run `/hooks` inside Pi to see everything that loaded, from both sources, and
`/hooks reload` after editing.

### Where the superset config is read from

Lowest precedence first; every file found is merged, and AIR hooks always load first:

| Location | Scope |
|---|---|
| `$PI_CODING_AGENT_DIR/hooks.json` (default `~/.pi/agent/hooks.json`) | All projects |
| `.pi/hooks.json` in the working directory | This project |

`hooks.jsonc` is accepted at both, and `//` and `/* */` comments are allowed in
either extension. `PI_HOOKS_CONFIG` (colon-separated, POSIX paths) replaces discovery.

## Hook ordering and errors

AIR hooks load first, then the Pi-native config; within a file, declaration order.
The first hook that blocks wins and the rest are skipped for that event. A hook that throws is
logged to stderr and the event continues, unless it sets `"continueOnError": false`.
A malformed hook is reported by name at startup and skipped; it never takes the
session down.

## Security

Hooks execute arbitrary commands with your permissions, exactly like the extensions
they are built on. Treat a `hooks.json` from someone else the way you would treat a
shell script from someone else — and note that a project-local `.pi/hooks.json` is
auto-discovered, so cloning a repository and starting Pi in it is enough to adopt
whatever that file says — and the same is true of an `air.json` naming a catalog.
`extends` can reach any readable path or resolvable package.

The bundled AIR hooks are a guardrail against an agent making a mistake, not a sandbox
against an adversary: they match command text, and anyone willing to obfuscate a
command can get past them. Patterns are also compiled and run on Pi's main thread, so
a catastrophically-backtracking regex in your own config will hang the agent.

## License

[MIT](LICENSE)
