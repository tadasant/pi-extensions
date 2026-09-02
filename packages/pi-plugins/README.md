# @tadasant/pi-plugins

**AIR plugin support for the [Pi coding agent](https://github.com/earendil-works/pi).**
Resolve an [AIR](https://github.com/pulsemcp/air) plugin and activate the skills,
hooks, and MCP servers it bundles inside a real Pi session.

```bash
pi install npm:pi-mcp-adapter      # required peer
pi install npm:@tadasant/pi-plugins
```

## What an AIR plugin is, and why Pi needs this

[AIR](https://github.com/pulsemcp/air) is a vendor-neutral framework for AI artifacts.
It defines six artifact types — skills, references, MCP servers, plugins, roots, and
hooks — and a **plugin** is the compositional one: a manifest that bundles other
artifacts **by ID** rather than a directory of content.

```json
// plugins.json — a thin registry
{
  "code-quality": {
    "description": "Linting, formatting, and coding-standards skills",
    "path": "./code-quality",
    "default_in_roots": ["*"]
  }
}
```

```json
// code-quality/.plugin/plugin.json — the body
{
  "title": "Code Quality Suite",
  "version": "1.2.0",
  "skills": ["lint-fix", "format-check"],
  "mcp_servers": ["eslint-server"],
  "hooks": ["lint-pre-commit"]
}
```

Pi cannot consume any of that. Pi has its own package format for distributing *Pi*
extensions, which is how this package reaches you — but an AIR plugin is a different
artifact type from a different ecosystem, and nothing in Pi reads it. This package is
the **Pi adapter for AIR**, the same role `@pulsemcp/air-adapter-opencode` plays for
OpenCode.

## What it activates

| AIR artifact | How it reaches Pi |
|---|---|
| **skills** | Contributed through Pi's own `resources_discover` event as `skillPaths`. An AIR skill is a directory containing `SKILL.md`, which is exactly what Pi discovers, so they load like any other skill. |
| **hooks** | Each `HOOK.json` is translated into a [`@tadasant/pi-hooks`](https://www.npmjs.com/package/@tadasant/pi-hooks) definition and dispatched by that engine. This package bundles it, so there is no second install and no second hook path. |
| **MCP servers** | Translated into the `.pi/mcp.json` that [`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter) reads, so that adapter starts and supervises them. |

## Configuration

Point the adapter at an AIR config. Discovery, in order:

| Location | Notes |
|---|---|
| `$PI_PLUGINS_CONFIG` | Explicit path; replaces discovery entirely |
| `./air.json` | In Pi's working directory |
| `./.air/air.json` | |

Which plugins activate follows AIR's own rule — membership is declared on the
artifact via `default_in_roots`, where `"*"` means every root:

| Variable | Effect |
|---|---|
| `PI_PLUGINS` | Comma-separated plugin IDs. Overrides `default_in_roots` entirely. |
| `PI_PLUGINS_ROOT` | Activates plugins naming this root in `default_in_roots`. |

Run `/plugins` inside Pi to see what resolved, and `/plugins reload` after editing.

## Event mapping

AIR's lifecycle vocabulary is agent-agnostic and broader than Pi's surface:

| AIR event | Pi event |
|---|---|
| `session_start` | `session_start` |
| `session_end` | `session_shutdown` |
| `pre_tool_call` | `tool_call` (can block) |
| `post_tool_call` | `tool_result` |
| `user_prompt_submit` | `user_prompt` (can block) |
| `stop` | `agent_settled` |

Claude Code's PascalCase spellings (`SessionStart`, `PreToolUse`, …) are accepted as
identity mappings, matching AIR's own behaviour.

**`pre_commit`, `post_commit`, `subagent_stop`, `notification`, and `pre_compact` are
not activated.** Pi has no git-commit lifecycle, no subagent concept, and no
extension-visible notification event, and `pi-hooks` does not currently expose
compaction. A hook using one of those loads with a named warning rather than
silently never firing — visible on stderr and in `/plugins`.

An AIR `matcher` becomes a pi-hooks matcher **scoped to the event**: tool name or
`input.command` on the tool events, prompt text on `user_prompt_submit`. Matching is
case-insensitive and Claude Code's tool names (`Bash`, `Edit`, `Write`, …) are aliased
onto Pi's, since this bridge accepts Claude's event spellings and will therefore be
handed Claude-authored hooks.

`command` runs through a shell when the hook declares no `args` — AIR defines it as
"Shell command to execute", so `foo && bar` is valid — and as an argv pair when `args`
are present. Either way it runs from the hook's own directory, so a relative
`./notify.sh` resolves. `timeout_seconds` becomes `timeoutMs`. `env` values and the
merged `x-config` get `${VAR}` interpolation and reach the script as ordinary
environment variables (`AIR_HOOK_CONFIG`, plus `AIR_HOOK_ID`) — never disk.

A hook's non-zero exit blocks the event where Pi allows blocking, which is what makes
an AIR guardrail a guardrail.

## Required peers

Supporting AIR plugins means supporting what a plugin *bundles*. Skills, Pi already
does natively. The other two come from extensions this package composes with rather
than reimplements:

| Peer | How it is required | Why |
|---|---|---|
| [`@tadasant/pi-hooks`](https://www.npmjs.com/package/@tadasant/pi-hooks) | **Bundled** — shipped inside this package and listed in `pi.extensions`. | 17 KB, and Pi requires a pi package to bundle another whose extension it references by path. You never install it separately. |
| [`pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter) | **A declared peer you install**: `pi install npm:pi-mcp-adapter` | It carries native keychain binaries for every platform; vendoring it would put a ~36 MB tarball on npm for something most Pi users already have. |

So a complete install is two commands:

```bash
pi install npm:pi-mcp-adapter      # required peer: runs the MCP servers plugins bundle
pi install npm:@tadasant/pi-plugins
```

**If the adapter is missing, this package says so and keeps going.** The servers are
still written to `.pi/mcp.json` — they start the moment you install the adapter — and
startup logs plus `/plugins` state plainly that it is not installed. A plugin that is
silently half-activated is the failure this avoids.

### How the MCP handoff works

`pi-mcp-adapter` loads its config when *its extension factory runs*, not on
`session_start`. So this package resolves plugins and writes `.pi/mcp.json` in **its
own factory**, before the adapter's runs.

Writes are conservative. Servers this package owns are tagged with an
`x-pi-plugins` provenance key, so:

- hand-written entries are never modified — and names claimed by the *other* configs
  the adapter merges first (`~/.config/mcp/mcp.json`, the Pi global config, and
  `<cwd>/.mcp.json`) are reserved too, since its merge is a shallow later-wins spread
  that would otherwise blend our entry into someone else's;
- a plugin's server whose natural name is already taken is written under its
  qualified name instead, and the rename is reported — rather than dropped or
  overwritten;
- servers written for a plugin that is no longer active are removed on the next run;
- a malformed `.pi/mcp.json` is left completely alone.

`${VAR}` interpolation is applied to `command`, `args`, `env`, `url`, `headers`, and
the OAuth block, matching AIR's own secrets handling.

## Scope

Local (filesystem) catalogs only. AIR's remote catalog providers (`github://…`) are a
separate extension surface; a catalog, plugin, hook, or skill path that looks like a
provider URI produces a named warning telling you to clone it locally, rather than
being silently skipped.

## Composition

Plugins composing plugins works as AIR specifies: children expand depth-first, a
parent's direct declarations win over inherited ones, IDs are deduplicated, and
circular references are rejected by name at resolution time.

Degradation is deliberate throughout. A missing manifest, an unresolvable artifact ID,
a skill directory that does not exist, or one plugin that fails to resolve produces a
warning naming the offender and leaves everything else working.

## Security

An AIR plugin's hooks execute arbitrary commands with your permissions, and its skills
can instruct the model to do anything. Read a catalog before you point Pi at it, the
way you would read a shell script from someone else.

## License

[MIT](LICENSE)
