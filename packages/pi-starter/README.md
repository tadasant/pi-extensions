# @tadasant/pi-starter

**A starter bundle for the [Pi coding agent](https://github.com/earendil-works/pi):**
the [`@tadasant/pi-hooks`](https://www.npmjs.com/package/@tadasant/pi-hooks) engine,
a recommended hook policy, and a few skills and prompt templates worth having.

```bash
pi install npm:@tadasant/pi-starter
```

One install gets you the hook engine plus everything below. If you only want the
engine, install `@tadasant/pi-hooks` instead.

## What is in the box

### The hooks engine

`@tadasant/pi-hooks` is bundled into this package, so installing the starter gives
you the declarative hook layer with no second install. See
[its README](https://github.com/tadasant/pi-extensions/tree/main/packages/pi-hooks)
for the config format.

### A recommended policy

`hooks/recommended.json` stacks the three blocking presets:

```json
{
  "extends": ["preset:secrets", "preset:git-guard", "preset:destructive-bash"],
  "hooks": []
}
```

Copy it to `.pi/hooks.json` in your project to adopt it:

```bash
cp "$(pi list --json | jq -r '…')/hooks/recommended.json" .pi/hooks.json
```

or just write the three lines yourself — that is the whole file.

Between them, these stop an agent from reading or writing secret material, from
force-pushing or pushing to `main`, and from `rm -rf`-ing something it should not.

### Skills

| Skill | Use when |
|---|---|
| `verify-before-claiming-done` | Before telling a user a change is finished. Turns "I made the change" into "I ran it, here is the output." |
| `scope-a-change` | A task is vague, larger than it looked, or touches unexpected code. Finds the real boundary before editing. |

### Prompt templates

| Template | Does |
|---|---|
| `/review` | Reviews the current diff for correctness, changed contracts, injection boundaries, and tests that would not fail if reverted. |
| `/explain` | Explains code by intent and traps rather than line-by-line narration. |

## Composing with your own config

The starter is a floor, not a cage. Extend it and add your own rules:

```json
{
  "extends": ["preset:secrets", "preset:git-guard", "preset:destructive-bash"],
  "hooks": [
    {
      "name": "format-on-write",
      "on": "tool_result",
      "match": { "tool": ["write", "edit"], "input": { "path": "**/*.ts" } },
      "action": { "type": "command", "command": "npx prettier --write {{input.path}}" }
    }
  ]
}
```

## Security

Everything here runs with your full permissions. The blocking presets are a guardrail
against an agent making a mistake, not a sandbox against an adversary. Read
`hooks/recommended.json` and the presets it pulls in before adopting them.

## License

[MIT](LICENSE)
