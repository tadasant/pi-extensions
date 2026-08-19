# pi-extensions

Hooks and plugins for the **Pi coding agent**, published to npm. Pi ships an extension API
but no hook or plugin layer on top of it; this repository builds that layer and releases it
as installable packages so any Pi installation — and any orchestrator driving Pi, Zimmer
being the one this exists for — can pick it up with `pi install npm:<package>`.

**Read this whole file before writing code.** Most of what is non-obvious here is about
*testing against real Pi* and *what this repo deliberately does not do*.

## Folder Hierarchy

The repo is currently a **scaffold** — the tree below is what exists plus, marked
`(planned)`, the shape the implementation should grow into. Do not treat the planned entries
as gospel; if a better layout emerges while building, use it and update this file.

```
pi-extensions/
├── README.md               # Public-facing: what this is, what it publishes, NPM_TOKEN caveat
├── AGENTS.md               # This file — the agent's operating manual
├── CLAUDE.md               # Symlink -> AGENTS.md (do not turn this into a real file)
├── LICENSE                 # MIT, matching tadasant/zimmer
├── .gitignore              # Node/TypeScript
├── packages/               # (planned) One published npm package per directory
│   ├── hooks/              # (planned) Declarative hook runner for Pi lifecycle events
│   └── plugins/            # (planned) Plugin format + loader (bundled hooks/commands/prompts)
├── e2e/                    # (planned) End-to-end tests that drive a real, pinned Pi CLI
│   ├── fake-llm/           # (planned) The simulated localhost LLM API
│   └── fixtures/           # (planned) Sample hooks/plugins exercised by the e2e suite
└── .github/workflows/      # (planned) CI: build, unit, e2e; and a release job gated on NPM_TOKEN
```

## Domain Context

**Pi** ([`earendil-works/pi`](https://github.com/earendil-works/pi), CLI package
`@earendil-works/pi-coding-agent`, binary `pi`) is a coding agent with a TypeScript
[extension API](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md).
An extension is a module that default-exports a function receiving an `ExtensionAPI` handle;
from there it can subscribe to lifecycle events (`session_start`, `tool_call`, `tool_result`,
and friends), register tools with `pi.registerTool()`, register commands with
`pi.registerCommand()`, drive the TUI, and persist state. A `tool_call` handler can return
`{ block: true, reason }` to veto a tool call. Extensions are auto-discovered from
`~/.pi/agent/extensions/` and `.pi/extensions/`, or loaded ad hoc with `pi -e ./path.ts`.

That primitive is powerful but low-level. Two things sit above it that Pi does not provide,
and that this repo supplies:

- **Hooks** — a *declarative* mapping from lifecycle events to actions, configured rather
  than coded. The user writes config; a single extension reads it and dispatches. This is the
  Pi analogue of a Claude Code hook.
- **Plugins** — a *distribution format*: hooks, commands, and prompts bundled as one
  versioned, installable unit instead of files pasted into a config directory.

### What is deliberately out of scope

- **MCP.** Pi's MCP gap is already solved by
  [`nicobailon/pi-mcp-adapter`](https://github.com/nicobailon/pi-mcp-adapter) (Tadas's fork:
  [`tadasant/pi-mcp-adapter`](https://github.com/tadasant/pi-mcp-adapter)). Never re-implement
  MCP here. Do read that repo: it is the best available reference for how a non-trivial Pi
  extension is structured, packaged, and shipped to npm.
- **Zimmer integration.** Wiring Pi into Zimmer as a runtime is separate work in a separate
  repo. This repo publishes packages; it does not know about Zimmer.
- **Forking or patching Pi.** Everything here is built *on top of* the public extension API.
  If the API genuinely cannot express something, say so and file an issue upstream rather
  than working around it with a patch.

### Prior art to draw on

[`pulsemcp/ai-artifacts`](https://github.com/pulsemcp/ai-artifacts) is the reference for
*what a good hook or plugin looks like* — the shape, the granularity, the sort of job worth
automating. Use it for taste and for concrete starter hooks/plugins; it is not an API to copy.

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

Packages are published to npm from CI. This requires an `NPM_TOKEN` repository secret that
**does not exist yet** — no `tadasant/*` repo has one today. Build and test CI must not depend
on it; only the release path may. If you are blocked because publishing needs that token, say
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
repo's initial bootstrap commit, made before `main` existed.)

## What NOT to Do

- **Do not implement MCP support here.** That is `pi-mcp-adapter`'s job.
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
  A: That is the *primitive*. The value here is the layer above it: a user configuring
  behavior declaratively without writing TypeScript, and a way to distribute a bundle of that
  behavior as a versioned package. If a design collapses back into "write your own extension",
  it has missed the point.

- **Q: Can I add CI workflows / packages / tests?**
  A: Yes — that is exactly the follow-on work this scaffold exists for. The scaffold is
  deliberately empty; the bootstrap session was scoped to making the repo exist.
