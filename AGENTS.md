# pi-extensions

A **declarative hook layer for the Pi coding agent**, plus a starter bundle of ready-made
extensions, published to npm as **pi packages** so any Pi installation — and any orchestrator
driving Pi, Zimmer being the one this exists for — can pick it up with
`pi install npm:<package>`.

**Get the premise right before you build anything.** Pi already has an extension API *and* a
package format; it does **not** have hooks. Read [Domain Context](#domain-context) before
writing code — the single most expensive mistake available here is reimplementing something
Pi already ships.

**Read this whole file before writing code.** Most of what is non-obvious here is about
*testing against real Pi* and *what this repo deliberately does not do*.

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
│   │   ├── presets/             #   Curated ready-made hook configs (`extends: ["preset:…"]`)
│   │   ├── schema/              #   JSON Schema for hooks.json
│   │   └── test/                #   Unit tests (excluded from the published tarball)
│   └── pi-starter/              # @tadasant/pi-starter — starter bundle, bundles pi-hooks
│       ├── hooks/               #   The recommended policy users copy to .pi/hooks.json
│       ├── skills/              #   Skills, via the conventional pi-package directory
│       └── prompts/             #   Prompt templates, likewise
├── e2e/
│   ├── pi-version.json          # THE PIN. Exact Pi version; bumping it is a visible diff.
│   ├── fake-llm/server.ts       # The simulated localhost LLM API
│   ├── harness/                 # Pinned-Pi download check + runPi() subprocess driver
│   └── tests/                   # hooks / presets / starter e2e suites
├── scripts/                     # Pin guard, Pi installer, bundle prep, publish dry run
└── .github/workflows/           # ci.yml (lint, unit, e2e, dry run) + release.yml (NPM_TOKEN)
```

**Notes on the layout that are not obvious:**

- **Nothing is compiled.** Pi loads extensions through jiti, so the packages ship raw `.ts`
  and CI runs `tsc --noEmit`. There is no `dist/`, and adding one would be a regression.
- **`src/` is deliberately Pi-free.** `runner.ts` takes a normalized event and returns a
  normalized outcome; `extensions/hooks.ts` does the translation to and from Pi's API. That
  split is what makes the matching and action semantics unit-testable without booting an agent.
- **`packages/pi-starter/node_modules/@tadasant/pi-hooks` is generated, not committed.** Pi
  requires one pi package that ships another to *bundle* it, and npm only bundles what is
  physically in the package's own `node_modules` at pack time — which workspace hoisting
  defeats. `scripts/prepare-starter-bundle.mjs` materializes it; it is wired as the starter's
  `prepack` and run by the e2e global setup. Without it the published starter tarball would
  point at an extension path that does not exist.

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

**So bundling and distribution are already solved. Do not build a plugin format.** What Pi
genuinely lacks is one thing:

- **Hooks** — a *declarative* mapping from lifecycle events to actions, configured rather than
  coded. The user writes config; a single extension reads it and dispatches. This is the Pi
  analogue of a Claude Code hook, and there is no `hooks` concept anywhere in Pi's docs.

Everything else this repo publishes is **content in that existing format**: a starter bundle of
extensions, skills, and prompts worth having, shipped as an ordinary pi package.

### What is deliberately out of scope

- **MCP.** Pi's MCP gap is already solved by
  [`nicobailon/pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter) (Tadas's fork:
  [`tadasant/pi-mcp-adapter`](https://github.com/tadasant/pi-mcp-adapter)). Never re-implement
  MCP here. Do read that repo: it is the best available reference for how a non-trivial Pi
  extension is structured, packaged, and shipped to npm.
- **A plugin/package format.** Pi packages already are one. Use the documented `pi` manifest
  key or the convention directories; do not invent a parallel format or a second loader.
- **Zimmer integration.** Wiring Pi into Zimmer as a runtime is separate work in a separate
  repo. This repo publishes packages; it does not know about Zimmer.
- **Forking or patching Pi.** Everything here is built *on top of* the public extension API.
  If the API genuinely cannot express something, say so and file an issue upstream rather
  than working around it with a patch.

### Prior art to draw on

[`pulsemcp/ai-artifacts`](https://github.com/pulsemcp/ai-artifacts) is the reference for
*what a good hook or bundled artifact looks like* — the shape, the granularity, the sort of job
worth automating. Use it for taste and for concrete starter content; it is not an API to copy.

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
  A: Half of it. Hooks are genuinely missing. **Plugins are not** — Pi packages already bundle
  and distribute extensions, skills, prompts, and themes over npm and git, with version
  pinning and shareable project settings. The framing predates a close reading of
  `docs/packages.md`. Build the hook layer; ship everything as ordinary pi packages.

- **Q: Can I add CI workflows / packages / tests?**
  A: Yes. The scaffold has been built out — hook layer, presets, starter bundle, pinned-Pi
  e2e harness, and CI all exist and are green. Extend them.

- **Q: Why does `npm publish --dry-run` need a nested `npm pack` that scrubs the environment?**
  A: `npm publish --dry-run` exports `npm_config_dry_run=true`, which any nested npm command
  inherits. The starter's `prepack` packs `pi-hooks` to materialize the bundle, and that
  nested pack silently wrote no tarball until the variable was scrubbed. If you touch
  `scripts/prepare-starter-bundle.mjs`, keep that scrub.

- **Q: An e2e test needs to assert "no hook fired". What is the right signal?**
  A: `expect(result.stderr).not.toContain("[pi-hooks] blocked")`. Asserting the tool result
  is not an error tests the environment instead — plenty of legitimate commands (anything
  touching a git remote) fail on their own inside a bare scratch directory.
