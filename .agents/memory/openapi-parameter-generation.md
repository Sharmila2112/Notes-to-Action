---
name: OpenAPI parameter generation
description: Generated API schema naming behavior for operations with path and query parameters.
---

When changing OpenAPI parameter layouts, check generated client and Zod exports together before keeping a path-plus-query endpoint.

**Why:** In this workspace's current generator setup, a path-parameter schema and query-parameter type can receive the same exported name and fail the shared library typecheck. A path-only cursor route avoided that collision for task pagination.

**How to apply:** After changing operation parameters, run the API code generator and workspace library typecheck. If an operation needs both path and query values, confirm generated names do not collide before wiring the server route.
