# Explain this code

Explain the selected code — or, if nothing is selected, the file under discussion.

Lead with what it is *for*: the job it does in this system, and who calls it. Then:

- **The shape.** The main flow in a few sentences, in the order it executes.
- **The non-obvious parts.** Anything a reader would misread on a first pass: an
  early return that matters, state mutated at a distance, a name that does not mean
  what it looks like, an ordering constraint.
- **The edges.** What happens on empty input, on failure, on concurrent calls.
- **What surprised you.** If something looks like a bug or a leftover, say so — and
  say whether you are confident or guessing.

Skip the line-by-line narration. Someone can read the lines; what they cannot read
is the intent and the traps.
