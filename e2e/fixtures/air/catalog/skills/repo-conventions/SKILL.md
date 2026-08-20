---
name: repo-conventions
description: Use before changing code in this repository. Carries the conventions a change is expected to follow.
---

# Repository conventions

AIR-PLUGIN-SKILL-MARKER — this text proves the skill reached the model.

- Feature branches only; never commit to `main`.
- Every behavioral change ships with a test that fails if the change is reverted.
- Prefer fewer exported entry points over a broad public surface.
