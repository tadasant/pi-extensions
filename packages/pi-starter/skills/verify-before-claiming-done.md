---
name: verify-before-claiming-done
description: Use before telling the user a change is finished. Turns "I made the change" into "I ran it and here is the output" — build, tests, lint, and a real invocation of the changed path.
---

# Verify before claiming done

"Done" is a claim about the world, not about your diff. Before you say a change works,
produce evidence that it does.

## The order that catches the most, fastest

1. **Typecheck or compile.** The cheapest signal, and it catches the errors that make
   every later step meaningless.
2. **Run the tests that cover what you changed** — not the whole suite first. A targeted
   run gives a legible failure in seconds.
3. **Run the full suite.** Narrow runs hide the thing you broke two modules over.
4. **Lint and format.** Last, because a formatting fix on top of failing code is wasted work.
5. **Exercise the actual path.** If you changed a CLI, invoke it. If you changed a
   request handler, send a request. Tests can pass while the real entry point is broken.

## What to report

State what you ran and what it printed. Counts and versions beat adjectives:
"18/18 e2e tests pass against Pi 0.84.2" is checkable; "everything works" is not.

If something is still failing or unverified, say so plainly and name it. A known gap
reported honestly costs far less than a green claim that turns out to be false.

## What not to do

- Do not re-read a file you just edited to confirm the edit landed. The tool would
  have errored.
- Do not describe a test plan as though it were a test result. Unchecked boxes and
  "should work" are not verification.
- Do not delete or weaken a failing assertion to make a suite green. If a test is
  genuinely wrong, fix it deliberately and say why in the same breath.
