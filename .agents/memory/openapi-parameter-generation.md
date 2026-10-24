---
name: OpenAPI parameter generation
description: Generated API schema naming behavior for operations with path and query parameters.
---

When changing OpenAPI parameter layouts, check generated client and Zod exports together before keeping a path-plus-query endpoint.

**Why:** In this workspace's current generator setup, a path-parameter schema and query-parameter type can receive the same exported name and fail the shared library typecheck. A path-only cursor route avoided that collision for task pagination.

**How to apply:** After changing operation parameters, run the API code generator and workspace library typecheck. If an operation needs both path and query values, confirm generated names do not collide before wiring the server route.

Focused artifact typechecks can consume stale declaration output from referenced workspace libraries even when their source schemas are current. If an error contradicts the source, run the root `pnpm run typecheck:libs` before rerunning the focused check.

**Why:** Project-reference consumers may resolve built declarations, so tests that load source directly can pass while a focused server typecheck still sees an older schema.

**How to apply:** After shared API/schema changes, build the workspace library references before diagnosing downstream type errors as route-code defects.
