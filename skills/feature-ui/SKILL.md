---
name: feature-ui
version: 1.1.0
description: Use to design a production-grade feature-level or page-level UI from zero to one. Applies to new pages, lists, forms, detail pages, dashboards, initial project UI, and complete UI structure for an existing feature. This skill defines cross-framework product UI quality; it does not bind implementation to React, Vue, Taro, or any component library.
---

# Goal
Create complete, product-ready UI structure with clear hierarchy, state coverage, interaction design, platform fit, and design-system alignment.

# When to Use
Use for:
- new pages
- feature-level UI
- lists, forms, detail pages, dashboards
- empty/error/loading/success/disabled state design
- UI structure before framework implementation

Do not use for:
- small visual tweaks to existing pages; use `ui-refine`
- React-specific implementation details; use `feature-react`
- backend/API contract changes; use `api-change`

# Use With Other Skills
- Pair with `feature-react` when implementing in React.
- Pair with `ui-refine` when polishing existing UI.
- Pair with `api-change` when UI requires new or changed API contracts.
- Pair with `write-tests` when UI behavior needs regression protection.

Use another skill only when the user's task actually crosses that boundary. Do not automatically chain skills.

# Steps
1. Identify product type and primary user task.
2. Inspect existing pages, components, tokens, and layout conventions.
3. Define the first-screen goal and information priority.
4. Decide which content is primary, secondary, deferred, collapsed, or omitted.
5. Establish design-system baseline from project tokens or `../_shared/ui-design-system.md`.
6. Prefer existing components and patterns.
7. Create a complete UI structure with states and interactions.
8. Check viewport and platform fit using the target product's real constraints; use the shared design-system desktop baselines when applicable.
9. Run the quality checklist before handing off to implementation.

# Pre-Generation Checklist
- What is the product type and core goal?
- What should the user see first?
- What is the single primary task on the page?
- What information must appear above the fold?
- What can be deferred, collapsed, or removed?
- What reusable components already exist?
- What layout and spacing patterns exist in similar pages?
- What design tokens or component library rules apply?
- Which loading, empty, error, success, disabled, and submitting states are required?
- Which interaction feedback states are required?

# Quality Checklist
## Product Fit
- SaaS and operational tools should be quiet, dense, organized, and repeat-use friendly.
- E-commerce must show product, price, trust, and purchase path clearly.
- Dashboards must prioritize scanning, comparison, and repeated action.
- Content or community products must prioritize readability and social signals.
- Creative portfolios must show the work and create a distinct voice.
- Finance and security surfaces must prioritize trust, clarity, and risk visibility.

## Structure
- The page must have clear primary, secondary, operation, and feedback areas.
- Do not flatten every section to the same visual weight.
- Do not overfill the first screen.
- Do not add decorative cards, stats, pills, or helper panels unless they serve the task.

## State Coverage
- Cover loading, empty, error, success, disabled, and submitting states when relevant.
- Critical operations must have visible feedback.
- Do not deliver only the ideal success path.

## Interaction
- Primary actions must be clear.
- Hover, focus, pressed, selected, disabled, and submitting states should be accounted for.
- Touch and scroll behavior must fit the platform.

## Design System
- Use project tokens first.
- Otherwise use `../_shared/ui-design-system.md`.
- Follow the shared design system for type, spacing, sizing, color, accessibility, and viewport baselines instead of duplicating those rules here.

## Viewport Awareness
- Single-task pages should avoid meaningless scroll on the target platform and common target viewports.
- Brand or decorative areas must not overpower the main task.
- If content exceeds first-screen capacity, group, defer, collapse, or remove secondary content.

## Anti-Template Check
- Avoid generic "title + description + button" repetition.
- Avoid equal-weight columns.
- Avoid excessive badges, pills, gradients, icons, and decorative cards.
- Avoid placeholder copy such as "welcome back" or "description text" when domain-specific copy is needed.
- The result should feel like a specific product, not a generic AI template.

# Output
- UI structure and section hierarchy.
- Component boundaries.
- State coverage.
- Interaction and feedback paths.
- Platform and viewport notes.
- Design tokens / type scale / spacing baseline.
- Handoff notes for the implementation skill.

# Handoff to Implementation
When handing off to React or another implementation layer, include:
- page sections and hierarchy
- component boundaries
- state design
- interaction flow
- platform constraints
- implementation boundaries already decided here

## Skill Boundary
- This skill defines UI structure and interaction intent; it does not automatically implement framework code, change backend contracts, or add tests.
- Do not widen a UI design task into unrelated product or architecture changes.

