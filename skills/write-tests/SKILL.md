---
name: write-tests
version: 1.1.0
description: Use to add tests for existing logic or create regression coverage for new behavior.
---

# When to Use
- The user asks for tests.
- A bugfix needs regression protection.
- Core business logic lacks coverage.
- Refactoring needs behavior protection.
- New logic has meaningful edge cases.

# Steps
1. Inspect the project's existing test framework, directory structure, naming conventions, fixtures, mocks, and helper patterns.
2. Choose the appropriate test level for the behavior: unit, integration, end-to-end, or regression.
3. Identify the behavior under test.
4. List the main scenarios.
5. List critical boundaries and failures.
6. Write the smallest effective tests using the project's existing conventions.
7. Avoid asserting implementation details when behavior is enough.
8. Make failures easy to diagnose.
9. Run the targeted tests first, then the relevant wider test set when practical.

# Output
- Test coverage scope.
- Key assertions.
- Command used to run tests.
- Remaining uncovered risk.

## TDD Use
- Prefer test-first for core business logic, data handling, and complex edge cases.
- For bugfixes, add the smallest regression test after root cause is confirmed.
- UI visual changes and documentation can use targeted validation instead.

## Test Quality
- Tests should prove behavior, not mirror implementation.
- Keep fixtures narrow and readable.
- Avoid brittle snapshots unless the project already relies on them.
- Do not introduce a new test framework when the existing project framework can cover the behavior.

## Skill Boundary
- This skill adds or improves test coverage; it does not automatically change production behavior to make tests pass.
- Use another skill only when the user's request actually crosses that boundary.
- Do not automatically chain into bugfix, refactor, API, or UI work.

