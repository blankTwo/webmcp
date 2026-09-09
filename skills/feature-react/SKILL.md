---
name: feature-react
version: 1.1.0
description: Use as an implementation helper for confirmed React projects. It turns UI, API, state, and interaction requirements into code that follows the current React project patterns. Applies to React pages, components, hooks, stores, request flows, or implementation handoff from `feature-ui`.
---

# Goal
Implement React code that fits the current project instead of introducing a new local architecture.

# When to Use
Use for:
- React pages and components.
- Hooks, stores, and local state.
- API request integration from React UI.
- Form, loading, error, empty, success, disabled, and submission states.
- Handoff from `feature-ui` into concrete React code.

Do not use for:
- Generic UI planning without implementation.
- Backend contract design by itself.
- Non-React stacks.
- Broad architecture changes unrelated to React implementation.

# Use With Other Skills
- Pair with `feature-ui` for new UI structure.
- Pair with `api-change` when the API contract changes.
- Pair with `bugfix` when repairing broken React behavior.
- Pair with `write-tests` when behavior requires regression coverage.

Use another skill only when the user's task actually crosses that boundary. Do not automatically chain skills.

# Input from feature-ui
When implementing a UI plan, preserve:
- page sections and hierarchy
- component boundaries
- state coverage
- interaction and feedback paths
- platform and viewport constraints
- implementation boundaries already decided by the UI plan

# Steps
1. Inspect existing React structure, component conventions, routing, state patterns, request helpers, and styling approach.
2. Reuse existing components and hooks first.
3. Implement the narrow requested behavior.
4. Keep state transitions explicit and predictable.
5. Cover loading, empty, error, success, disabled, and submitting states when relevant.
6. Keep API calls behind existing request helpers.
7. Validate with build, tests, browser checks, or targeted manual interaction.

# Output
- React files changed.
- Existing patterns reused.
- State and request flow summary.
- Validation performed.
- Remaining risks.

## Boundaries
- Do not invent a new state management library.
- Do not introduce a new component system unless requested.
- Do not couple UI to fake APIs when a real contract is required.
- Do not hide missing backend behavior behind frontend-only placeholders.
- Do not refactor unrelated React code while implementing the feature.
- Do not change or assume an API contract from the client side without verifying the backend contract.

