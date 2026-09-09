---
name: api-change
version: 1.1.0
description: Use for API Layer changes, including endpoints, request parameters, response structures, authentication, error handling, service logic, data writes, and frontend/backend contracts.
---

# When to Use
- Add a new endpoint.
- Modify request parameters or response shape.
- Change auth, permission, or error semantics.
- Change service logic behind an API.
- Adjust frontend/backend contract behavior.
- Touch API-related data writes or consistency logic.

# Steps
1. Identify the affected API contract: route, method, request, response, auth, errors, and side effects.
2. Capture the current contract before changing it, including the existing request and response behavior that callers rely on.
3. Inspect existing API patterns before adding new structure.
4. Check callers and consumers before changing the contract.
5. Define the intended contract after the change and classify compatibility as backward-compatible or breaking.
6. Prefer backward-compatible changes when reasonable.
7. Update validation or tests that prove the contract.
8. Update existing API documentation only when this change would otherwise make it inaccurate or incomplete.

# Output
- Before / after contract summary.
- Compatibility classification: backward-compatible or breaking.
- Impacted callers and files.
- Data or auth implications.
- Validation performed.
- Remaining compatibility risks.

## Contract Discipline
- Do not silently change a public response shape.
- Do not weaken auth or permission checks.
- Do not create a frontend-only API assumption without backend evidence.
- For cross-layer changes, verify both the client call and backend handler.

## Validation
- Prefer API tests, integration tests, or endpoint smoke checks.
- For auth or permission changes, include negative cases.
- For data writes, verify persistence and rollback or recovery assumptions.

## Skill Boundary
- Use another skill only when the user's request actually crosses that boundary.
- Do not automatically chain into UI, bugfix, refactor, or test work just because those skills exist.
- Do not widen the requested API change into unrelated cleanup.

