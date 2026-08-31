# pi-extensions

**Hooks and [AIR](https://github.com/pulsemcp/air) plugin support for the Pi coding
agent**, published to npm as **pi packages** so any Pi installation — and any
orchestrator driving Pi, Zimmer being the one this exists for — can pick them up with
`pi install npm:<package>`.

This repository publishes **exactly two packages**: the hooks extension and the
plugins extension. Nothing else.

**Get the premise right before you build anything.** Two distinct facts, and
conflating them has already cost this repo one wrong package:

1. **Pi already has an extension API *and* a package format.** It does **not** have
   declarative hooks. Package 1 fills that gap; the package format is how both
   packages get *distributed*, not something to reinvent.
2. **"Plugins" here means AIR plugins, not Pi packages.** An AIR plugin is an
   artifact type from [`pulsemcp/air`](https://github.com/pulsemcp/air) — a manifest
   bundling skills, MCP servers, and hooks *by ID*. Pi cannot read it at all. Package
   2 is the Pi adapter for it. Read the schemas in that repo's `/schemas` directory
   directly rather than inferring the shape.

Read [Domain Context](#domain-context) before writing code.

**Read this whole file before writing code.** Most of what is non-obvious here is
about *testing against real Pi* and *what this repo deliberately does not do*.

## Folder Hierarchy

```
pi-extensions/
├── README.md                    # Public-facing: what this is, what it publishes, NPM_TOKEN caveat
├── AGENTS.md                    # This file — the agent's operating manual
├── CLAUDE.md                    # Symlink -> AGENTS.md (do not turn this into a real file)
├── LICENSE                      # MIT, matching tadasant/zimmer
├── package.json                 # npm workspaces root; scripts are the entry point for everything
├── biome.json                   # Lint + format (one tool, no eslint/prettier pair)
├── tsconfig.json                # Typecheck only; nothing here is compiled
├── vitest.config.ts             # Unit tests
├── vitest.e2e.config.ts         # E2E tests (separate: they need the pinned Pi download)
├── packages/
│   ├── pi-hooks/                # @tadasant/pi-hooks — the declarative hook runner
│   │   ├── extensions/hooks.ts  #   Pi entry point: binds the runner to Pi's event bus
│   │   ├── src/                 #   Pi-free core: config, matching, templating, actions, runner
│   │   ├── air/                 #   A shipped AIR hooks catalog (hooks.json + HOOK.json dirs)
│   │   ├── schema/              #   JSON Schema for hooks.json
│   │   └── test/                #   Unit tests (excluded from the published tarball)
│   └── pi-plugins/              # @tadasant/pi-plugins — the AIR plugin adapter
│       ├── extensions/plugins.ts#   Pi entry point: resolves plugins, contributes skills, binds hooks
│       ├── src/                 #   Pi-free core: catalog, resolve, hooks-bridge, activate
│       └── test/                #   Unit tests
├── e2e/
│   ├── pi-version.json          # THE PIN. Exact Pi version; bumping it is a visible diff.
│   ├── fake-llm/server.ts       # The simulated localhost LLM API
│   ├── fixtures/air/            # A real AIR catalog the plugins e2e suite plants and resolves
│   ├── harness/                 # Pinned-Pi download check + runPi() subprocess driver
│   └── tests/                   # air-hooks / hooks / plugins e2e suites
├── scripts/                     # Pin guard, Pi installer, bundle prep, publish dry run
└── .github/workflows/           # ci.yml (lint, unit, e2e, dry run) + release.yml (NPM_TOKEN)
```

**Notes on the layout that are not obvious:**

- **Nothing is compiled.** Pi loads extensions through jiti, so the packages ship raw `.ts`
  and CI runs `tsc --noEmit`. There is no `dist/`, and adding one would be a regression.
- **`src/` is deliberately Pi-free.** `runner.ts` takes a normalized event and returns a
  normalized outcome; `extensions/hooks.ts` does the translation to and from Pi's API. That
  split is what makes the matching and action semantics unit-testable without booting an agent.
- **`packages/pi-plugins/node_modules/@tadasant/pi-hooks` is generated, not committed.** Pi
  requires one pi package that ships another to *bundle* it, and npm only bundles what is
  physically in the package's own `node_modules` at pack time — which workspace hoisting
  defeats. `scripts/prepare-bundled-deps.mjs` materializes it; it is wired as pi-plugins'
  `prepack` and run by the e2e global setup. Without it the published tarball would point
  at an extension path that does not exist.
- **The AIR hooks format is implemented once, in `packages/pi-hooks/src/air.ts`.**
  pi-plugins imports `translateAirHook` from there for the hooks a plugin bundles; it
  has no bridge of its own. A second implementation would be a regression — that is
  exactly the mistake an earlier revision made.
- **pi-plugins resolves in its extension *factory*, not on `session_start`.**
  `pi-mcp-adapter` calls `loadMcpConfig()` when its own factory runs, so `.pi/mcp.json`
  has to be written before that. Moving this work to `session_start` would silently
  break MCP support.
- **`pi-hooks` is bundled; `pi-mcp-adapter` is a required peer.** The split is
  deliberate: the hooks engine is 17 KB and its extension is referenced by path (which
  Pi requires bundling for), while the MCP adapter drags per-platform native keychain
  binaries that would make the published tarball ~36 MB.

## Domain Context

**Pi** ([`earendil-works/pi`](https://github.com/earendil-works/pi), CLI package
`@earendil-works/pi-coding-agent`, binary `pi`) is a coding agent with a TypeScript
[extension API](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md).
An extension is a module that default-exports a function receiving an `ExtensionAPI` handle;
from there it can subscribe to lifecycle events (`session_start`, `tool_call`, `tool_result`,
and friends), register tools with `pi.registerTool()`, register commands with
`pi.registerCommand()`, drive the TUI, and persist state. A `tool_call` handler can return
`{ block: true, reason }` to veto a tool call. Extensions are auto-discovered from
`~/.pi/agent/extensions/` and `.pi/extensions/`, or loaded ad hoc with `pi -e <spec>` — where
the spec may be a local file (`./path.ts`), a package directory (`./packages/hooks`), or a
registry spec (`npm:@foo/bar`, `git:github.com/user/repo`). That last form is the natural seam
for exercising a package in tests without installing it.

Pi also ships **[pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)**,
and this is the fact most likely to be missed. A pi package bundles extensions, skills, prompt
templates, and themes and distributes them over npm or git — declared under a `pi` key in
`package.json`, or auto-discovered from conventional `extensions/`, `skills/`, `prompts/`, and
`themes/` directories. `pi install` resolves and version-pins them; `-l` writes to project
settings (`.pi/settings.json`) that a team commits and shares, and Pi auto-installs anything
missing on startup once the project is trusted.

**So bundling and distribution of *Pi extensions* are already solved. Use that format; do
not invent a second one.** What Pi genuinely lacks is two things, and this repo publishes
exactly one package for each.

- **Hooks** — specifically **AIR hooks**: a `hooks.json` index of `HOOK.json` directories,
  binding a lifecycle event to a command, where a non-zero exit blocks the event. Pi has no
  `hooks` concept at all, and AIR already specifies this artifact vendor-neutrally, so
  `@tadasant/pi-hooks` is its Pi *runtime* rather than a new format. It also exposes a
  Pi-native superset config for the two things AIR's schema cannot express — a written block
  reason without a script, and rewriting a tool's input — but AIR hooks are the format.
  → `@tadasant/pi-hooks`.

- **AIR plugins** — see below. → `@tadasant/pi-plugins`.

### AIR, and what "plugin" means here

[**AIR**](https://github.com/pulsemcp/air) is a vendor-neutral framework for AI artifacts.
It defines six artifact types — **skills, references, MCP servers, plugins, roots, hooks** —
each declared in a per-type index file (`skills.json`, `hooks.json`, `plugins.json`, …) inside
a *catalog*, with a root `air.json` naming the catalogs. Every artifact is canonically
addressed as `@scope/id`; local filesystem catalogs use scope `local`.

**An AIR plugin is the compositional artifact type**: a manifest that bundles *other
artifacts by ID* rather than a directory of content. The body lives at
`<plugin-dir>/.plugin/plugin.json` with `skills[]`, `mcp_servers[]`, `hooks[]`, and
`plugins[]` (plugins can compose plugins), while the `plugins.json` entry stays a thin
registry of `description` + `path` + `default_in_roots`. Inline fields on the entry win over
the manifest.

**This is not Pi's package format and has nothing to do with it.** Pi packages distribute Pi
extensions; AIR plugins are artifacts from a different ecosystem that Pi cannot read at all.
`@tadasant/pi-plugins` is the *adapter* — the same role `@pulsemcp/air-adapter-opencode` plays
for OpenCode.

**Read the schemas, do not infer them.** They are at
[`pulsemcp/air/schemas`](https://github.com/pulsemcp/air/tree/main/schemas) —
`plugin-manifest.schema.json`, `plugins.schema.json`, `hooks.schema.json`,
`skills.schema.json`, `air.schema.json` — with prose in that repo's `docs/plugins.md` and
`docs/hooks.md`. [`pulsemcp/ai-artifacts`](https://github.com/pulsemcp/ai-artifacts) is a
populated catalog worth reading for real-world examples.

### What is deliberately out of scope

- **MCP.** Pi's MCP gap is already solved by
  [`nicobailon/pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter) (Tadas's fork:
  [`tadasant/pi-mcp-adapter`](https://github.com/tadasant/pi-mcp-adapter)). Never re-implement
  MCP here. Do read that repo: it is the best available reference for how a non-trivial Pi
  extension is structured, packaged, and shipped to npm.
- **A *Pi* package format.** Pi packages already are one. Use the documented `pi` manifest
  key or the convention directories; do not invent a parallel format or a second loader.
  (This does **not** apply to AIR plugins, which are a different artifact type from a
  different ecosystem — consuming them is the whole point of `@tadasant/pi-plugins`.)
- **A starter bundle.** An earlier revision of this repo shipped one. It was explicitly
  rejected. Two packages, no more.
- **Implementing MCP inside the plugins adapter.** An AIR plugin can bundle MCP servers,
  and `@tadasant/pi-plugins` *does* make them work — by translating them into the
  `.pi/mcp.json` that `pi-mcp-adapter` reads, and declaring that adapter a required
  peer. Composing with it is the job; speaking MCP is not.
- **Zimmer integration.** Wiring Pi into Zimmer as a runtime is separate work in a separate
  repo. This repo publishes packages; it does not know about Zimmer.
- **Forking or patching Pi.** Everything here is built *on top of* the public extension API.
  If the API genuinely cannot express something, say so and file an issue upstream rather
  than working around it with a patch.

### Prior art to draw on

[`pulsemcp/ai-artifacts`](https://github.com/pulsemcp/ai-artifacts) is a populated AIR
catalog: the reference for *what a real plugin, skill, or hook looks like* — the shape, the
granularity, the sort of job worth automating. Read it alongside the schemas in
[`pulsemcp/air`](https://github.com/pulsemcp/air), which are normative.

## Testing: e2e against real, pinned Pi

This is the part of the repo the human explicitly asked for, and the part most likely to be
watered down by accident. The requirement:

1. **Download a pinned version of the Pi CLI.** An exact version, recorded in the repo and
   bumped deliberately. Never `@latest` — an agent that floats the version has broken the
   test's meaning.
2. **Run that real binary.** Do not stub Pi, do not import its internals and call them
   directly, do not assert against a hand-built fake `ExtensionAPI` and call it end-to-end.
   The question an e2e test answers is "does this hook actually fire inside a real Pi run?"
3. **Point the model provider at a simulated LLM API on localhost.** A small local server
   speaking the provider wire protocol Pi expects, returning **well-formed placeholder
   responses** — including tool calls where a test needs one, so hook/plugin paths that only
   trigger on tool use are reachable. Pi supports custom providers and base-URL overrides;
   use that seam.
4. **No vendor credentials, no model-provider network egress.** A test that needs a real API
   key is not acceptable here. CI must pass on a fresh checkout with no secrets.

Unit tests are welcome for the pure logic (config parsing, matching, plugin resolution), but
they do not substitute for the e2e suite.

## Publishing

Packages are published to npm from CI. This requires an `NPM_TOKEN` repository secret, which is
not configured on this repository. Build and test CI must not depend on it; only the release
path may. If you are blocked because publishing needs that token, say
so plainly and stop — do not attempt to create, obtain, or work around the credential.

## Core Principles

### Build on the public extension API, and stay upstreamable in spirit

Everything here should be something a Pi user could have written themselves against the
documented API. No monkey-patching Pi's internals, no reliance on undocumented shapes that
will break on the next Pi release. When Pi's API is the constraint, name it.

### Pin the world the tests run in

The Pi version, and anything else the e2e suite downloads, is pinned to an exact version. A
green test against a moving target proves nothing. Bumping a pin is a normal, visible change
with its own diff.

### Real over simulated, except for the model

The one thing that gets simulated is the LLM API, because a real model makes tests slow,
expensive, credentialed, and non-deterministic. Everything else in the loop — the Pi binary,
the extension loading, the config discovery, the process boundaries — is real.

### Small, published surface

Each package's public API is the thing other people depend on and the thing that is expensive
to change. Prefer fewer exported entry points and clear semantics over a broad surface. If
something is an implementation detail, do not export it.

### Human-approved PRs, feature branches only

Open a PR; never commit to `main` and never merge your own work. (The one exception was this
repo's bootstrap, pushed straight to `main` because there was nothing to open a PR against
until `main` existed. That exception is spent — it does not extend to your work.)

## What NOT to Do

- **Do not implement MCP support here.** That is `pi-mcp-adapter`'s job.
- **Do not build a plugin or package format.** Pi packages exist and are documented; ship into
  that format.
- **Do not use a floating Pi version** (`latest`, a range, "whatever npm gives us") anywhere
  in the test setup.
- **Do not mock the Pi binary** to make an e2e test pass. If the real binary is hard to drive,
  fix the harness, don't fake the subject.
- **Do not call a real model provider** from tests, and do not add a test that requires an API
  key to pass.
- **Do not convert `CLAUDE.md` into a real file.** It is a symlink to `AGENTS.md`; two real
  files drift.
- **Do not attempt to create or fetch an npm token**, or any other credential.
- **Do not push to `main` directly.**

## FAQ / Learnings

- **Q: `badlogic/pi-mono` is referenced in older docs and links — is that a different project?**
  A: No. It redirects to `earendil-works/pi`. Prefer the current name in anything you write.

- **Q: The extension API already lets me subscribe to `tool_call`. Isn't that a hook — why
  does this repo exist?**
  A: That is the *primitive*. The value here is the layer above it: a user configuring behavior
  declaratively, in config, without writing TypeScript. If a design collapses back into "write
  your own extension", it has missed the point.

- **Q: The original framing of this repo was "hooks and plugins support, because Pi has
  neither." Is that right?**
  A: Yes, but "plugins" means **AIR plugins**, not Pi packages. A previous revision read it
  as Pi's package format, concluded plugins were already solved, and shipped a starter
  bundle instead — which was wrong and was removed. Pi packages solve *distribution of Pi
  extensions*; AIR plugins are a different artifact type Pi cannot consume. Both gaps are
  real, and this repo fills both.

- **Q: Can I add CI workflows / packages / tests?**
  A: Yes. The scaffold has been built out — the AIR hooks runtime, a shipped AIR hooks
  catalog, the AIR plugin adapter, the pinned-Pi e2e harness, and CI all exist and are
  green. Extend them.

- **Q: Why does `npm publish --dry-run` need a nested `npm pack` that scrubs the environment?**
  A: `npm publish --dry-run` exports `npm_config_dry_run=true`, which any nested npm command
  inherits. pi-plugins' `prepack` packs `pi-hooks` to materialize the bundle, and that
  nested pack silently wrote no tarball until the variable was scrubbed. If you touch
  `scripts/prepare-bundled-deps.mjs`, keep that scrub.

- **Q: I am adding an action that writes into the tool input. Anything to know?**
  A: Route it through `setPath`, which refuses `__proto__`/`constructor`/`prototype`
  segments. Dot paths reach that function from a `patch-input` action's keys *and*
  from whatever JSON a `command` hook printed on stdout, and the second of those is
  not something the user authored.

- **Q: A `command` hook prints JSON and exits non-zero. Is that a control object?**
  A: Only if the JSON carries a key this layer understands. Plenty of tools emit JSON
  diagnostics and a non-zero exit (`eslint -f json`, `semgrep --json`); treating those
  as control objects would cancel the exit-code semantics and make the hook silently
  do nothing.

- **Q: Can a hook block on any event?**
  A: No — only `tool_call`, `user_bash`, and `user_prompt`, the ones Pi lets an
  extension veto (`BLOCKABLE_EVENTS`). Setting `blocked` on any other event would be
  dropped by `extensions/hooks.ts` and the failure would vanish, so the runner logs
  instead.

- **Q: A bundled AIR hook looks right but a bypass slipped through. How do I check?**
  A: Add a row to `packages/pi-hooks/test/builtin-air-hooks.test.ts`, which spawns the
  guard exactly as the runner does (event on stdin, exit code = verdict). Booting Pi
  per case is far too slow for the combinatorics that matter — flag orderings (`-rf`
  vs `-fr` vs `-r -f`), quoting, `git -C <dir>` before the subcommand, and multi-line
  commands.

- **Q: An e2e test needs to assert "no hook fired". What is the right signal?**
  A: `expect(result.stderr).not.toContain("[pi-hooks] blocked")`. Asserting the tool result
  is not an error tests the environment instead — plenty of legitimate commands (anything
  touching a git remote) fail on their own inside a bare scratch directory.

- **Q: I am adding an action that writes into the tool input. Anything to know?**
  A: Route it through `setPath`, which refuses `__proto__`/`constructor`/`prototype`
  segments. Dot paths reach that function from a `patch-input` action's keys *and*
  from whatever JSON a `command` hook printed on stdout, and the second of those is
  not something the user authored.

- **Q: A `command` hook prints JSON and exits non-zero. Is that a control object?**
  A: Only if the JSON carries a key this layer understands. Plenty of tools emit JSON
  diagnostics and a non-zero exit (`eslint -f json`, `semgrep --json`); treating those
  as control objects would cancel the exit-code semantics and make the hook silently
  do nothing.

- **Q: Can a hook block on any event?**
  A: No — only `tool_call`, `user_bash`, and `user_prompt`, the ones Pi lets an
  extension veto (`BLOCKABLE_EVENTS`). Setting `blocked` on any other event would be
  dropped by `extensions/hooks.ts` and the failure would vanish, so the runner logs
  instead.


