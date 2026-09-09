---
name: bugfix
version: 1.1.0
description: Use to diagnose errors, abnormal behavior, failed edge cases, inconsistent state, and regressions; fix only when mutation is explicitly authorized.
---

# When to Use
- Runtime errors or build errors.
- UI or API behavior differs from expectation.
- State inconsistency.
- Edge-case failures.
- Regressions after a change.
- User reports that something does not work.

# Mutation Authorization
Before editing files, classify the request:
- `read-only`: the user asks for investigation, diagnosis, inspection, review, analysis, comparison, explanation, recommendations, or a proposed solution without explicitly asking to change files.
- `fix-authorized`: the user clearly asks to apply, implement, fix, modify, remove, add, update, refactor, or otherwise change project files or behavior.
- `ambiguous`: intent to modify files is unclear; default to read-only.

Do not classify authorization from a single keyword alone. Interpret the user's full request and whether they clearly want project files changed.

# Steps
1. Classify mutation authorization.
2. Reproduce or locate the failure signal.
3. Collect evidence: error text, logs, affected files, tests, screenshots, or observed behavior.
4. Identify the root cause before changing code.
5. If the request is read-only diagnosis, stop before file edits and report the evidence, root cause or candidate causes, recommended fix, risk, and validation plan.
6. If fix is authorized, make the smallest complete fix that addresses the root cause.
7. Add or run regression validation when a fix is applied.
8. Record the lesson in project documentation only when it has durable diagnostic value.

# Output
- Confirmed symptom.
- Root cause.
- Fix summary, or recommended fix if no mutation was authorized.
- Validation result, or validation plan if no mutation was authorized.
- Remaining risk.

## Evidence Standard
- State what is proven and what is inferred.
- Do not patch from filename or keyword guesses.
- If the root cause is unclear, keep investigating before editing.
- Do not edit source, tests, docs, config, or other project files for diagnosis-only requests.

## Regression Protection
- Prefer a failing-before / passing-after test when practical.
- If tests are not available, provide a targeted manual validation path.

## Skill Boundary
- Use another skill only when the user's request actually crosses that boundary.
- Do not automatically chain into refactor, UI, API, or testing work.
- A bugfix may make the smallest supporting change required by the root cause, but must not become unrelated cleanup.

