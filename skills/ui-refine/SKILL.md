---
name: ui-refine
version: 1.1.0
description: "Use for UI Layer refinement of existing pages: align visual style, reduce native assembly feel, replace inconsistent Tailwind usage, reuse component libraries and existing components, and improve UI consistency."
---

# Trigger Keywords
- UI polish
- align style
- make it look better
- replace raw tags
- improve layout
- unify spacing
- refine Tailwind
- make the page feel more product-ready

# When to Use
- Existing UI needs visual consistency.
- A page feels too raw or assembled from native elements.
- Tailwind values are inconsistent.
- Existing components should be reused.
- Layout, spacing, hierarchy, or visual rhythm needs improvement.

# Steps
1. Inspect similar existing pages and components.
2. Read `../_shared/ui-design-system.md` and `../_shared/ui-consistency.md`.
3. Identify inconsistent typography, spacing, color, radius, shadow, and component usage.
4. Prefer existing components and tokens.
5. Replace ad hoc Tailwind values with project patterns.
6. Verify responsive behavior and common viewport fit.
7. Keep changes scoped to the requested UI surface.

# Output
- UI inconsistencies found.
- Refinement strategy.
- Files changed.
- Viewports or interaction states checked.
- Remaining visual risks.

## Boundaries
- Visual refinement must preserve existing business behavior unless the user explicitly requests behavioral changes.
- Do not change API contracts, business rules, routing semantics, or state flow merely to improve appearance.
- Do not refactor unrelated code while polishing a UI surface.

## Skill Boundary
- Use another skill only when the user's request actually crosses that boundary.
- Do not automatically chain into feature implementation, API changes, bugfixes, or tests.

