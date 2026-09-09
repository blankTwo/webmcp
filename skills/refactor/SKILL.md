---
name: refactor
version: 1.1.0
description: Use to improve structure, readability, reuse, responsibility boundaries, and maintainability without changing external behavior.
---

# When to Use
- Duplicated logic.
- Files or functions are too large.
- Responsibilities are unclear.
- Structure is hard to maintain.
- The user explicitly asks to optimize or refactor.
- Behavior should remain the same.

# Steps
1. Define the refactor goal.
2. Mark the impact scope.
3. Identify callers, consumers, and externally observable behavior in the affected area.
4. Establish a pre-refactor behavior baseline using existing tests, targeted checks, or explicit observable behavior.
5. Confirm the behavior boundary that must not change.
6. Make small verifiable changes.
7. Validate the preserved behavior after each meaningful step when practical.
8. Run a final regression check against the pre-refactor baseline.
9. Update tests or validation notes when needed.

# Output
- Refactor goal.
- Impact scope.
- Pre-refactor behavior baseline.
- Behavior compatibility statement.
- Maintenance benefit.
- Validation performed.

## Boundaries
- Do not mix unrelated feature work into a refactor.
- Do not change public contracts unless the user requested it.
- Do not rename or move broadly without validation.
- If preserving behavior cannot be demonstrated, stop and report the validation gap instead of assuming the refactor is safe.

## Skill Boundary
- Use another skill only when the user's request actually crosses that boundary.
- Do not automatically chain into bugfix, API, UI, or test work.

