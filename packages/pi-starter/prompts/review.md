# Review this diff

Review the current changes with the standards of someone who will be paged when it breaks.

Work through, in order:

1. **Correctness.** For each changed function, what input makes it do the wrong thing?
   Off-by-one, unhandled `null`/`undefined`, an `await` that is missing, an error path
   that silently swallows. Name a concrete failing input, not a category.
2. **Contracts.** Did a signature, return shape, or error behavior change? Find every
   caller and check each one. An unfound caller is the bug.
3. **Boundaries.** Untrusted input reaching a shell, a query, a path, or a template.
   Anything that spawns a process or interpolates into a command deserves a second look.
4. **Tests.** Does a test actually fail if the change is reverted? A test that passes
   either way documents nothing.
5. **Simplification.** Is there existing code that already does this? Is a layer of
   indirection earning its keep?

Report findings most-severe first. For each: the file and line, what breaks, and the
input or sequence that makes it break. If you found nothing real, say that plainly
rather than padding the list with style notes.
