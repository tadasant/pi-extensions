---
name: scope-a-change
description: Use when a task is vague, larger than it first looked, or touches code you did not expect. Finds the real boundary of the change before you start editing.
---

# Scope a change

Most bad diffs are not badly written. They are correctly written and the wrong size.

## Find the boundary first

- **Locate every call site** of what you are about to change, before changing it.
  A signature edit with three unfound callers is a broken build you have not met yet.
- **Read the nearest tests.** They encode the contract other people rely on, and they
  tell you what breaking looks like.
- **Ask what the smallest complete change is.** Complete means the codebase is
  consistent afterward — not that you stopped early and left callers dangling.

## Decide what is in and what is out

In scope: the change requested, plus whatever is required to keep the tree working.

Out of scope, and worth *recording rather than doing*: unrelated bugs you notice,
refactors that would be nice, style you disagree with, dead code. Note them where
your team tracks work. A drive-by fix inside an unrelated diff is how a reviewable
change becomes an unreviewable one.

One exception: a mechanical rename that follows from your change — updating references
to a symbol you moved — belongs in the same diff. It is not new behavior.

## When the task is genuinely ambiguous

Do everything that does not depend on the answer. Then state the assumption you are
proceeding under, in one sentence, and keep going. Stop and ask only when guessing
wrong would be unsafe or would waste the whole effort.
